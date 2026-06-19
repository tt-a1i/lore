/**
 * 消息索引固化 —— scan 时把所有 session 的 user-message 抽到 .lore/messages.json，
 * 让 `lore ask` 的 raw-conversation fallback 不必每次都重 parse 全部 transcript。
 *
 * 动机：之前每次 ask 都遍历 sessionSourceMap 重 parse 所有 jsonl 文件——一个
 * 100-session 的仓库一次 ask = 100 次磁盘 + 解析。MCP host 一会话连问 5 次 → 500 次 IO。
 * scan 时一次性物化，ask 直接读结构化 JSON 即可。
 *
 * 文件形态：
 *   {
 *     schemaVersion: 1,
 *     generatedAt: ISO8601,
 *     entries: [{ sessionId, seq, text }, ...]
 *   }
 *
 * 容错：
 *   - parse 失败的 transcript 跳过（计数已在 scan 的 skipped 里）。
 *   - 不属于本 repo 的 session（cwd 不在 repo 下、sourcePath 也不在 ~/.claude/projects/<encoded>）跳过。
 *   - 写失败仅警告，不阻塞 scan。
 *
 * 原子写：先写临时文件再 rename（同目录），避免读到半截 JSON。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as os from 'node:os';

import { encodeProjectPath } from '../parsers/claude-code.js';
import type { ParsedSession, TranscriptParser } from '../schema/events.js';

export const MESSAGES_INDEX_VERSION = 1;
export const MESSAGES_INDEX_FILE = 'messages.json';

/** 单条 user-message 索引项。与 ask/engine.ts 的 MessageIndexEntry 同构。 */
export interface MessageIndexEntry {
  sessionId: string;
  seq: number;
  text: string;
}

export interface MessagesIndex {
  schemaVersion: number;
  generatedAt: string;
  entries: MessageIndexEntry[];
}

/** 单条 user-message 内容截断长度（与 ask/engine.ts 的 MSG_TRUNCATE 保持一致）。 */
const MSG_TRUNCATE = 600;

function indexPath(repoPath: string): string {
  return path.join(repoPath, '.lore', MESSAGES_INDEX_FILE);
}

/**
 * 内容黑名单 —— lore 自身的 pipeline artifact（task-notification、distiller prompt、
 * tool-plumbing envelope）不应进入消息索引；它们污染 ask 结果且无业务价值。
 *
 * 与 ask/engine.ts 的 isLorePipelineArtifact 同义——抽到这里以便 scan 时过滤一次，
 * ask 不必重复判定（ask 仍保留兜底，应对实时 fallback 路径）。
 */
function isLorePipelineArtifact(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith('<task-notification>')) return true;
  const lower = text.toLowerCase();
  return (
    lower.includes('software-archaeology distiller') ||
    lower.includes('tool-use-id') ||
    lower.includes('output-file')
  );
}

/** 判定一个 transcript sourcePath 是否属于该 repo（与 ask/engine.ts 同口径）。 */
function sourcePathBelongsToRepo(sourcePath: string, repoPath: string): boolean {
  const norm = sourcePath.replace(/\\/g, '/');
  const encoded = encodeProjectPath(repoPath);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded).replace(/\\/g, '/');
  if (norm === projectDir || norm.startsWith(projectDir + '/')) return true;
  const repo = repoPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (norm === repo || norm.startsWith(repo + '/')) return true;
  return false;
}

function cwdBelongsToRepo(cwd: string | null, repoPath: string): boolean {
  if (!cwd) return false;
  const normCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const repo = repoPath.replace(/\\/g, '/').replace(/\/$/, '');
  return normCwd === repo || normCwd.startsWith(repo + '/');
}

function sessionBelongsToRepo(
  session: ParsedSession,
  sourcePath: string,
  repoPath: string,
): boolean {
  return sourcePathBelongsToRepo(sourcePath, repoPath) || cwdBelongsToRepo(session.meta.cwd, repoPath);
}

/**
 * 用注册的 parser 多路尝试解析 transcript，挑"最像 sourcePath 真实主人"的那个：
 *   sessionId 与 expected 相符 +4，含 user-message +2，含任何事件 +1。
 *
 * 同 sourcePath 在不同 parser 下偶尔都能 parse 成空 session，所以 first-success
 * 不安全；选 best-score 才能避开误归属。
 */
async function parseBestSession(
  sourcePath: string,
  expectedSessionId: string,
  parsers: TranscriptParser[],
): Promise<ParsedSession | null> {
  let best: ParsedSession | null = null;
  let bestScore = 0;

  for (const parser of parsers) {
    let session: ParsedSession;
    try {
      const parsed = await parser.parse(sourcePath);
      session = parsed.session;
    } catch {
      continue;
    }

    let score = 0;
    if (session.meta.sessionId === expectedSessionId) score += 4;
    const userMessageCount = session.events.filter((e) => e.kind === 'user-message').length;
    if (userMessageCount > 0) score += 2;
    if (session.events.length > 0) score += 1;

    if (score > bestScore) {
      best = session;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

/**
 * 从一个 session 抽出本 repo 的 user-message 条目。
 * 不属于本 repo / parse 失败 / 内容黑名单 → 返回空。
 */
async function extractUserMessages(
  sourcePath: string,
  sessionId: string,
  repoPath: string,
  parsers: TranscriptParser[],
): Promise<MessageIndexEntry[]> {
  const session = await parseBestSession(sourcePath, sessionId, parsers);
  if (!session) return [];
  return extractUserMessagesFromSession(session, sourcePath, repoPath);
}

/** 从已解析 session 抽 user-message（scan 已有 ParsedSession 时走这条，零额外 IO）。 */
function extractUserMessagesFromSession(
  session: ParsedSession,
  sourcePath: string,
  repoPath: string,
): MessageIndexEntry[] {
  if (!sessionBelongsToRepo(session, sourcePath, repoPath)) return [];
  const entries: MessageIndexEntry[] = [];

  for (const event of session.events) {
    if (event.kind !== 'user-message') continue;
    const text = event.text;
    if (!text.trim()) continue;
    if (isLorePipelineArtifact(text)) continue;

    entries.push({
      sessionId: event.sessionId,
      seq: event.seq,
      text: text.length > MSG_TRUNCATE ? text.slice(0, MSG_TRUNCATE) : text,
    });
  }

  return entries;
}

/**
 * 从已经 parse 好的 sessions 直接计算消息索引。scan 路径优先使用这个函数，
 * 因为 scan 前面已经完成 transcript parse；再从磁盘 re-parse 一遍纯属浪费。
 */
export function computeMessagesIndexFromSessions(
  repoPath: string,
  sessions: ParsedSession[],
): MessageIndexEntry[] {
  return sessions.flatMap((session) =>
    extractUserMessagesFromSession(session, session.meta.sourcePath, repoPath),
  );
}

/**
 * 计算所有 session 的 user-message 索引（并发 parse，结果扁平合并）。
 * sessionSourceMap 来自 .lore/report.json（scan 已经写好）。
 *
 * 整体容错：单个 session 失败不影响其它（Promise.all 内部已 catch 到空数组）。
 */
export async function computeMessagesIndex(
  repoPath: string,
  sessionSourceMap: Record<string, string>,
  parsers: TranscriptParser[],
): Promise<MessageIndexEntry[]> {
  const perSession = await Promise.all(
    Object.entries(sessionSourceMap).map(([sid, srcPath]) =>
      extractUserMessages(srcPath, sid, repoPath, parsers).catch(() => [] as MessageIndexEntry[]),
    ),
  );
  return perSession.flat();
}

/** 原子写 .lore/messages.json。失败抛出（调用方决定是否吞）。 */
export async function writeMessagesIndex(
  repoPath: string,
  entries: MessageIndexEntry[],
): Promise<void> {
  const loreDir = path.join(repoPath, '.lore');
  await fs.mkdir(loreDir, { recursive: true });

  const index: MessagesIndex = {
    schemaVersion: MESSAGES_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    entries,
  };

  const finalPath = indexPath(repoPath);
  const tmpPath =
    finalPath + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
  await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (e) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * 读 .lore/messages.json。缺失 / 损坏 / schema 不符 → 返回 null（让消费方走 fallback）。
 * 绝不抛——索引只是性能优化，不是正确性必需。
 */
export async function loadMessagesIndex(repoPath: string): Promise<MessagesIndex | null> {
  try {
    const raw = await fs.readFile(indexPath(repoPath), 'utf8');
    const parsed = JSON.parse(raw) as Partial<MessagesIndex>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== MESSAGES_INDEX_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      return null;
    }
    return {
      schemaVersion: parsed.schemaVersion,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      entries: parsed.entries.filter(
        (e): e is MessageIndexEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as MessageIndexEntry).sessionId === 'string' &&
          typeof (e as MessageIndexEntry).seq === 'number' &&
          typeof (e as MessageIndexEntry).text === 'string',
      ),
    };
  } catch {
    return null;
  }
}
