/**
 * 蒸馏编排 —— 把 scan 产出的 report.json + 重 parse 的 session 折叠成蒸馏输入，
 * 逐 session 调蒸馏器，应用双时间 supersede，写 .lore/notes.json。
 *
 * 流程（runDistill）：
 *   1. 读 .lore/report.json（含 sessionSourceMap）。
 *   2. 对每个"有 PRODUCED 归因"的 session：重 parse 其 sourcePath → buildSessionDigest。
 *   3. 读现存 notes.json：digestHash 未变的 session 跳过（已蒸馏且内容未变）。
 *   4. 串行调蒸馏器（避免并发打爆本地 CLI）。
 *   5. 分配 note id（sessionId#n）、validAt=digest.startedAt、回填 anchors.sessionId；
 *      应用 supersededIds（给被推翻的 note 打 invalidAt + supersededBy）。
 *   6. 写回 NotesFile 形态，返回统计。
 *
 * 设计取舍：
 *   - existingNotes（喂给蒸馏器判断 supersede）= notes.json 里当前有效（invalidAt===null）
 *     且与本 digest 的 editedFiles 有文件交集的 note。
 *   - digest 的路径归一与 graph/build / match 引擎同思路（前缀剥离 + 后缀兜底），
 *     但 orchestrate 没有 commits 清单，所以只做前缀剥离 + report 文件集兜底。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type {
  Distiller,
  DistilledNote,
  SessionDigest,
  NotesFile,
} from './types.js';
import type { RepoMatchReport, MatchCandidate } from '../match/types.js';
import type {
  ParsedSession,
  FileEditEvent,
  TranscriptParser,
} from '../schema/events.js';
import { truncate } from '../util/text.js';

const NOTES_SCHEMA_VERSION = 1;

/** user 消息单条截断长度。 */
const USER_MSG_MAX = 1000;
/** assistant 关键消息单条截断长度。 */
const ASSISTANT_MSG_MAX = 600;
/** digest 总消息条数上限。 */
const MAX_DIGEST_MESSAGES = 40;

/** .lore/report.json 形态（仅取我们用到的字段，与 cli.ts LoreReportFile 同构）。 */
interface LoreReportFile extends RepoMatchReport {
  sessionSourceMap?: Record<string, string>;
}

/** 决策动词启发式：assistant 消息含这些词更可能承载"决策/取舍"语义。 */
const DECISION_HINTS = [
  'decid',
  'chose',
  'choose',
  'choosing',
  'because',
  'instead',
  'rather than',
  'trade-off',
  'tradeoff',
  'approach',
  'reject',
  'avoid',
  'constraint',
  'must ',
  'should ',
  'design',
  'rationale',
  'why',
  'prefer',
  'so that',
  'in order to',
  'note that',
];

// truncate 已抽到 src/util/text.ts，本文件 import 使用以避免重复实现。

/** 朴素前缀剥离（与 graph/build 的 normalizePath 同思路，无 cwd≠repo 的二级处理）。 */
function normalizePath(rawPath: string, repoPath: string, cwd: string | null): string | null {
  const strip = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p);
  const repo = strip(repoPath);

  if (rawPath.startsWith(repo + '/')) return rawPath.slice(repo.length + 1);
  if (rawPath === repo) return '';

  if (cwd) {
    const c = strip(cwd);
    if (c !== repo && rawPath.startsWith(c + '/')) return rawPath.slice(c.length + 1);
  }

  if (!rawPath.startsWith('/')) {
    return rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  }
  return null;
}

/** 后缀兜底：前缀剥离失败的绝对路径，用后缀对一组已知文件唯一匹配。 */
function buildSuffixResolver(knownFiles: Set<string>): (absPath: string) => string | null {
  const byBasename = new Map<string, string[]>();
  for (const f of knownFiles) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const arr = byBasename.get(base);
    if (arr) {
      if (!arr.includes(f)) arr.push(f);
    } else byBasename.set(base, [f]);
  }
  return (absPath: string) => {
    const parts = absPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const base = parts[parts.length - 1]!;
    const candidates = byBasename.get(base);
    if (!candidates || candidates.length === 0) return null;
    for (let k = parts.length; k >= 2; k--) {
      const suffix = parts.slice(parts.length - k).join('/');
      const hits = candidates.filter((p) => p === suffix || p.endsWith('/' + suffix));
      if (hits.length === 1) return hits[0]!;
    }
    return null;
  };
}

function isKeyAssistantMessage(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length < 40) return false; // 太短的多是 "Done."/"Sure." 噪声
  for (const h of DECISION_HINTS) {
    if (lower.includes(h)) return true;
  }
  return false;
}

/**
 * 构建会话摘要包。
 *  - user-message 全收（单条截 USER_MSG_MAX）。
 *  - assistant-message 只收"关键"的（决策动词启发式 + 长度过滤）。
 *  - 总消息控制 ≤ MAX_DIGEST_MESSAGES：超出时优先保 user 与"最相关"的 assistant。
 *  - editedFiles：该 session 全部 file-edit 事件归一后的去重路径集。
 *  - commits：从 report.matches 反查该 sessionId 命中的 commit（去重）。
 */
export function buildSessionDigest(
  session: ParsedSession,
  report: RepoMatchReport,
  repoPath: string,
): SessionDigest {
  const meta = session.meta;
  const cwd = meta.cwd;

  // commits + report 涉及的文件集（用于后缀兜底归一）。
  const reportFiles = new Set<string>();
  const commitMap = new Map<string, string>(); // hash → subject
  for (const m of report.matches) {
    reportFiles.add(m.filePath);
    if (m.sessionId === meta.sessionId) {
      if (!commitMap.has(m.commitHash)) {
        commitMap.set(m.commitHash, subjectForCommit(report, m));
      }
    }
  }
  const suffixResolve = buildSuffixResolver(reportFiles);

  // editedFiles：归一 + 去重。
  const editedSet = new Set<string>();
  for (const ev of session.events) {
    if (ev.kind !== 'file-edit') continue;
    const edit = ev as FileEditEvent;
    if (edit.succeeded === false) continue;
    let rel = normalizePath(edit.filePath, repoPath, cwd);
    if (rel === null || rel === '' || !reportFiles.has(rel)) {
      const resolved = suffixResolve(edit.filePath);
      if (resolved) rel = resolved;
    }
    if (rel === null || rel === '') continue;
    editedSet.add(rel);
  }

  // 消息收集：user 全收，assistant 关键收。保留 seq 与原序。
  const userMsgs: { seq: number; role: 'user'; text: string }[] = [];
  const keyAssistant: { seq: number; role: 'assistant'; text: string }[] = [];
  for (const ev of session.events) {
    if (ev.kind === 'user-message') {
      const text = truncate(ev.text, USER_MSG_MAX);
      if (text) userMsgs.push({ seq: ev.seq, role: 'user', text });
    } else if (ev.kind === 'assistant-message') {
      if (isKeyAssistantMessage(ev.text)) {
        keyAssistant.push({ seq: ev.seq, role: 'assistant', text: truncate(ev.text, ASSISTANT_MSG_MAX) });
      }
    }
  }

  // 总量控制：user 优先全保；assistant 取剩余配额（按 seq 顺序，截早期为主上下文）。
  let messages: { seq: number; role: 'user' | 'assistant'; text: string }[];
  if (userMsgs.length >= MAX_DIGEST_MESSAGES) {
    messages = userMsgs.slice(0, MAX_DIGEST_MESSAGES);
  } else {
    const remaining = MAX_DIGEST_MESSAGES - userMsgs.length;
    const assistant = keyAssistant.slice(0, remaining);
    messages = [...userMsgs, ...assistant];
  }
  // 还原时间序（按 seq 升序），让 LLM 看到对话的自然顺序。
  messages.sort((a, b) => a.seq - b.seq);

  const commits = [...commitMap.entries()].map(([hash, subject]) => ({ hash, subject }));

  return {
    sessionId: meta.sessionId,
    agent: meta.agent,
    startedAt: meta.startedAt,
    messages,
    editedFiles: [...editedSet].sort(),
    commits,
  };
}

/** report 没有直接的 commit subject 字段；从 unmatchedCommits 或 candidate 反查，兜底空串。 */
function subjectForCommit(report: RepoMatchReport, _m: MatchCandidate): string {
  // RepoMatchReport.unmatchedCommits 带 {hash,subject}，但匹配上的 commit 不在其中。
  // MatchCandidate 不带 subject。subject 非关键（仅作 prompt 上下文），缺失给空串。
  const um = report.unmatchedCommits.find((u) => u.hash === _m.commitHash);
  return um?.subject ?? '';
}

/** 稳定内容 hash：对 digest 的"实质内容"做 sha256（剔除非确定字段）。 */
export function digestHash(digest: SessionDigest): string {
  // 只 hash 影响蒸馏结果的内容：messages（seq+role+text）、editedFiles、commits。
  // startedAt 也纳入（影响 validAt）。agent/sessionId 稳定不变，纳入无害但纳入更稳。
  const canonical = JSON.stringify({
    sessionId: digest.sessionId,
    agent: digest.agent,
    startedAt: digest.startedAt,
    messages: digest.messages.map((m) => [m.seq, m.role, m.text]),
    editedFiles: digest.editedFiles,
    commits: digest.commits.map((c) => [c.hash, c.subject]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface RunDistillOpts {
  /** 限制本次处理的 session 数（取 report 中有归因的前 N 个，按 startedAt 升序）。 */
  maxSessions?: number;
  /** 蒸馏后端（必填——由调用方装配，便于注入/测试）。 */
  distiller: Distiller;
  /** parser（默认 claudeCodeParser；测试可注入）。 */
  parser?: TranscriptParser;
}

export interface RunDistillStats {
  distilled: number;
  skipped: number;
  notesAdded: number;
  superseded: number;
  errors: { sessionId: string; error: string }[];
}

/** 读现存 notes.json，缺失/损坏时返回空壳。 */
async function readNotesFile(notesPath: string): Promise<NotesFile> {
  try {
    const raw = await fs.readFile(notesPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<NotesFile>;
    return {
      schemaVersion: parsed.schemaVersion ?? NOTES_SCHEMA_VERSION,
      distilledSessions: parsed.distilledSessions ?? {},
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    };
  } catch {
    return { schemaVersion: NOTES_SCHEMA_VERSION, distilledSessions: {}, notes: [] };
  }
}

/**
 * 编排批量蒸馏。串行处理每个有 PRODUCED 归因的 session。
 * parser 默认懒加载 claudeCodeParser；测试通过 opts.parser 注入。
 */
export async function runDistill(
  repoPath: string,
  opts: RunDistillOpts,
): Promise<RunDistillStats> {
  const repo = path.resolve(repoPath);
  const stats: RunDistillStats = {
    distilled: 0,
    skipped: 0,
    notesAdded: 0,
    superseded: 0,
    errors: [],
  };

  // 1. 读 report.json。
  const reportPath = path.join(repo, '.lore', 'report.json');
  let report: LoreReportFile;
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    report = JSON.parse(raw) as LoreReportFile;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stats.errors.push({ sessionId: '(report)', error: `cannot read report.json: ${msg}` });
    return stats;
  }
  if (!Array.isArray(report.matches)) {
    stats.errors.push({ sessionId: '(report)', error: 'report.json has no matches array' });
    return stats;
  }

  const sourceMap = report.sessionSourceMap ?? {};

  // 2. 找出有 PRODUCED 归因的 session（去重），按 startedAt 升序需先 parse 拿 meta。
  //    先聚 sessionId，再逐个 parse（注入或懒加载 parser）。
  const parser = opts.parser ?? (await loadParser());

  const attributedSessions = new Set<string>();
  for (const m of report.matches) attributedSessions.add(m.sessionId);

  // parse 每个有归因的 session（用 sourceMap 找 transcript 路径）。
  interface SessionEntry {
    sessionId: string;
    session: ParsedSession;
    digest: SessionDigest;
  }
  const entries: SessionEntry[] = [];
  for (const sessionId of attributedSessions) {
    const src = sourceMap[sessionId];
    if (!src) {
      stats.errors.push({ sessionId, error: 'no sourcePath in sessionSourceMap' });
      continue;
    }
    let session: ParsedSession;
    try {
      const res = await parser.parse(src);
      session = res.session;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stats.errors.push({ sessionId, error: `parse failed: ${msg}` });
      continue;
    }
    const digest = buildSessionDigest(session, report, repo);
    entries.push({ sessionId, session, digest });
  }

  // 按 startedAt 升序（双时间：先发生的先蒸馏，后者可 supersede 前者）。
  entries.sort((a, b) => {
    const ta = Date.parse(a.digest.startedAt) || 0;
    const tb = Date.parse(b.digest.startedAt) || 0;
    return ta - tb;
  });

  const limited =
    opts.maxSessions !== undefined ? entries.slice(0, opts.maxSessions) : entries;

  // 3. 读现存 notes.json。
  const notesPath = path.join(repo, '.lore', 'notes.json');
  const notesFile = await readNotesFile(notesPath);

  // 4. 逐 session 串行蒸馏。
  for (const entry of limited) {
    const { sessionId, digest } = entry;
    const hash = digestHash(digest);

    // hash 未变 → 跳过。
    if (notesFile.distilledSessions[sessionId] === hash) {
      stats.skipped += 1;
      continue;
    }

    // existingNotes：当前有效（invalidAt===null）且与本 digest 文件域有交集。
    const editedSet = new Set(digest.editedFiles);
    const existingNotes = notesFile.notes.filter(
      (n) =>
        n.invalidAt === null &&
        n.id.split('#')[0] !== sessionId && // 不把本 session 旧 note 当外部 existing
        n.files.some((f) => editedSet.has(f)),
    );

    let result: Awaited<ReturnType<Distiller['distill']>>;
    try {
      result = await opts.distiller.distill({ digest, existingNotes });
    } catch (e) {
      // 契约要求蒸馏器自身容错，但防御性兜底：绝不让一个 session 炸掉整批。
      const msg = e instanceof Error ? e.message : String(e);
      stats.errors.push({ sessionId, error: `distiller threw: ${msg}` });
      // 仍记录 hash，避免下次重复尝试同一坏输入（可选：这里选择不记录，留待修复后重试）。
      continue;
    }

    if (result.error) {
      stats.errors.push({ sessionId, error: result.error });
    }

    stats.distilled += 1;

    // 5. 分配 id / validAt / 回填 anchors.sessionId。
    // 同 session 的 note 序号从该 session 已有 note 数接着排（幂等重跑稳定）。
    let n = nextNoteIndex(notesFile.notes, sessionId);
    const newNotes: DistilledNote[] = [];
    for (const raw of result.notes) {
      const id = `${sessionId}#${n++}`;
      const anchors = raw.anchors.map((a) => ({ sessionId, seq: a.seq }));
      newNotes.push({
        id,
        kind: raw.kind,
        title: raw.title,
        body: raw.body,
        files: raw.files,
        anchors,
        sessionId,
        validAt: digest.startedAt,
        invalidAt: null,
        supersededBy: null,
      });
    }

    // 6. 应用 supersededIds：给被推翻的现存有效 note 打 invalidAt + supersededBy。
    //    supersededBy 指向"推翻它的 note"——取本批第一条新 note（若有）；无新 note 时
    //    仍标记失效但 supersededBy 取 null（罕见：模型只声明推翻不产出新 note）。
    const supersedingId = newNotes.length > 0 ? newNotes[0]!.id : null;
    const newValidAt = digest.startedAt;
    for (const supId of result.supersededIds) {
      const target = notesFile.notes.find((x) => x.id === supId && x.invalidAt === null);
      if (!target) continue;
      target.invalidAt = newValidAt;
      target.supersededBy = supersedingId;
      stats.superseded += 1;
    }

    // 追加新 note + 记录 hash。
    notesFile.notes.push(...newNotes);
    stats.notesAdded += newNotes.length;
    notesFile.distilledSessions[sessionId] = hash;
  }

  // 7. 写回 notes.json。
  notesFile.schemaVersion = NOTES_SCHEMA_VERSION;
  const loreDir = path.join(repo, '.lore');
  await fs.mkdir(loreDir, { recursive: true });
  await fs.writeFile(notesPath, JSON.stringify(notesFile, null, 2), 'utf8');

  return stats;
}

/** 该 session 已有 note 的最大序号 + 1（id 形如 sessionId#n）。 */
function nextNoteIndex(notes: DistilledNote[], sessionId: string): number {
  let max = -1;
  const prefix = sessionId + '#';
  for (const note of notes) {
    if (!note.id.startsWith(prefix)) continue;
    const tail = note.id.slice(prefix.length);
    const num = parseInt(tail, 10);
    if (!Number.isNaN(num) && num > max) max = num;
  }
  return max + 1;
}

/** 懒加载 claudeCodeParser（与 cli.ts 风格一致）。 */
async function loadParser(): Promise<TranscriptParser> {
  const mod = (await import('../parsers/claude-code.js')) as {
    claudeCodeParser: TranscriptParser;
  };
  return mod.claudeCodeParser;
}
