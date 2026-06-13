/**
 * 共享对话摘录提取 —— viewer (`/api/payload`) 与 `lore scan` 快照固化共用同一份逻辑。
 *
 * 背景：.lore/report.json 的 matches 里，每个 (commit, file) 一条 MatchCandidate。
 * 我们为每个 commit 取 confidence 最高的那条 candidate（仅 strong，≥0.8），重 parse 它的
 * sourcePath transcript，按 editSeqs 找贡献编辑前后最近的 user/assistant 消息，取 ≤2 条
 * （user 优先），每条 ≤320 字符。同一 transcript/parser 组合只 parse 一次（内存缓存）。
 *
 * 容错铁律：任何一步失败该 commit 无摘录即可，绝不抛——无论被 server 还是 scan 调用，
 * 都不能让上层挂掉。
 *
 * 历史：本逻辑原住在 src/viewer/server.ts 的 computeExcerpts 内；为让 scan 也能据此
 * 固化快照（让 `lore why` 在 transcript 被 Claude Code 清理后仍出摘录），抽到此处共用。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ViewerExcerpt } from '../viewer/types.js';
import type { MatchCandidate } from '../match/types.js';
import type { LoreEvent, ParsedSession, TranscriptParser } from '../schema/events.js';

export const EXCERPT_MAX = 320;
export const EXCERPTS_PER_COMMIT = 2;
/** 只有 strong（≥0.8）配摘录——weak 归因引导用户读"可能错误的对话"比没有更糟。 */
export const EXCERPT_MIN_CONFIDENCE = 0.8;

/** .lore/report.json 的最小形态（仅取我们用到的字段）。 */
interface ReportFileShape {
  matches?: MatchCandidate[];
}

function truncateExcerpt(s: string): string {
  const t = s.trim();
  if (t.length <= EXCERPT_MAX) return t;
  return t.slice(0, EXCERPT_MAX - 1) + '…';
}

/** 在事件流中向某方向找第一条指定 kind 的消息，返回摘录或 null。 */
function findNearestMessage(
  events: LoreEvent[],
  fromIdx: number,
  direction: -1 | 1,
  kind: 'user-message' | 'assistant-message',
): ViewerExcerpt | null {
  for (let i = fromIdx + direction; i >= 0 && i < events.length; i += direction) {
    const e = events[i];
    if (!e || e.kind !== kind) continue;
    return {
      sessionId: e.sessionId,
      seq: e.seq,
      role: kind === 'user-message' ? 'user' : 'assistant',
      text: truncateExcerpt((e as { text: string }).text),
      ts: e.ts,
    };
  }
  return null;
}

/**
 * 按 editSeqs 定位 file-edit 事件，抽前后最近的 user/assistant 消息，
 * 按 (seq, role) 去重，user 优先、再按 seq 升序，取前 N 条。
 *
 * 纯函数——对单测尤其友好：给一个 ParsedSession + editSeqs，确定性产出。
 */
export function excerptsForCandidate(
  session: ParsedSession,
  editSeqs: number[],
): ViewerExcerpt[] {
  const events = session.events;
  const editSeqSet = new Set(editSeqs);
  const byAnchor = new Map<string, ViewerExcerpt>();

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e || e.kind !== 'file-edit' || !editSeqSet.has(e.seq)) continue;
    const candidates = [
      findNearestMessage(events, idx, -1, 'user-message'),
      findNearestMessage(events, idx, -1, 'assistant-message'),
      findNearestMessage(events, idx, 1, 'user-message'),
      findNearestMessage(events, idx, 1, 'assistant-message'),
    ];
    for (const c of candidates) {
      if (!c || !c.text) continue;
      const key = c.seq + ':' + c.role;
      if (!byAnchor.has(key)) byAnchor.set(key, c);
    }
  }

  const all = [...byAnchor.values()];
  // user 优先；同 role 内按 seq 升序（对话先后）。
  all.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1;
    return a.seq - b.seq;
  });
  return all.slice(0, EXCERPTS_PER_COMMIT);
}

/**
 * 从 matches 选出每个 commit 的 top-1 strong candidate。
 * 纯函数（便于单测）：confidence < EXCERPT_MIN_CONFIDENCE 的丢弃；同 commit 取最高分。
 */
export function topStrongCandidateByCommit(
  matches: MatchCandidate[],
): Map<string, MatchCandidate> {
  const topByCommit = new Map<string, MatchCandidate>();
  for (const m of matches) {
    if (!m || !m.commitHash) continue;
    if ((m.confidence ?? 0) < EXCERPT_MIN_CONFIDENCE) continue;
    const cur = topByCommit.get(m.commitHash);
    if (!cur || (m.confidence ?? 0) > (cur.confidence ?? 0)) {
      topByCommit.set(m.commitHash, m);
    }
  }
  return topByCommit;
}

/** 懒加载全部 parser；失败返回空数组（调用方据此放弃摘录、不抛）。 */
async function loadParsers(): Promise<TranscriptParser[]> {
  try {
    const mod = await import('../parsers/registry.js');
    return Array.isArray(mod.allParsers) ? mod.allParsers : [];
  } catch {
    return [];
  }
}

/**
 * 读 .lore/report.json，为每个 commit 取 top-1 confidence 的 strong candidate，
 * parse 其 sourcePath（同文件只 parse 一次），抽 ≤2 条摘录。
 * 任何失败都安静跳过——返回的 map 只含成功算出摘录的 commit。
 *
 * 由 viewer（实时重算）与 scan（固化快照）共用，行为完全一致。
 */
export async function computeExcerpts(
  repoPath: string,
  injectedParser?: TranscriptParser | TranscriptParser[],
): Promise<Record<string, ViewerExcerpt[]>> {
  const result: Record<string, ViewerExcerpt[]> = {};

  let report: ReportFileShape;
  try {
    const raw = await fs.readFile(path.join(repoPath, '.lore', 'report.json'), 'utf8');
    report = JSON.parse(raw) as ReportFileShape;
  } catch {
    return result; // 没有 report（未 scan）：无摘录。
  }
  const matches = report.matches;
  if (!Array.isArray(matches) || matches.length === 0) return result;

  const topByCommit = topStrongCandidateByCommit(matches);
  if (topByCommit.size === 0) return result;

  const parsers = injectedParser
    ? (Array.isArray(injectedParser) ? injectedParser : [injectedParser])
    : await loadParsers();
  if (parsers.length === 0) return result; // parser 不可用：全体无摘录（不抛）。

  // 同一 sourcePath/parser 只 parse 一次（内存缓存，含失败的 null）。
  const parseCache = new Map<string, ParsedSession | null>();
  async function parseWith(
    parser: TranscriptParser,
    sourcePath: string,
    parserIdx: number,
  ): Promise<ParsedSession | null> {
    const key = parserIdx + '\0' + sourcePath;
    if (parseCache.has(key)) return parseCache.get(key) ?? null;
    let session: ParsedSession | null = null;
    try {
      const parsed = await parser.parse(sourcePath);
      session = parsed.session;
    } catch {
      session = null;
    }
    parseCache.set(key, session);
    return session;
  }

  async function parseBestSession(cand: MatchCandidate): Promise<ParsedSession | null> {
    let best: ParsedSession | null = null;
    let bestScore = 0;
    const editSeqSet = new Set(cand.editSeqs ?? []);

    for (let i = 0; i < parsers.length; i++) {
      const parser = parsers[i]!;
      const session = await parseWith(parser, cand.sourcePath!, i);
      if (!session) continue;

      let score = 0;
      if (session.meta.sessionId === cand.sessionId) score += 4;
      if (
        editSeqSet.size > 0 &&
        session.events.some((e) => e.kind === 'file-edit' && editSeqSet.has(e.seq))
      ) {
        score += 4;
      }
      if (session.events.length > 0) score += 1;

      if (score > bestScore) {
        best = session;
        bestScore = score;
      }
    }

    return bestScore > 0 ? best : null;
  }

  for (const [commitHash, cand] of topByCommit) {
    try {
      if (!cand.sourcePath) continue;
      const session = await parseBestSession(cand);
      if (!session) continue;
      const excerpts = excerptsForCandidate(session, cand.editSeqs ?? []);
      if (excerpts.length) result[commitHash] = excerpts;
    } catch {
      // 单 commit 失败：跳过，不影响其余。
    }
  }

  return result;
}
