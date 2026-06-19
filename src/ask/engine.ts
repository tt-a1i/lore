/**
 * AskEngine 实现 —— `lore ask <question>` 的确定性混合检索。
 *
 * 管线：
 *   1. 分词：英文按非字母数字分隔 + 驼峰/下划线拆分 + 小写；中文按 2-gram。
 *      查询与文档使用同一套。
 *   2. 索引目标：
 *      a. .lore/notes.json 的 notes（title 权重 3、body 1.5、files 路径段 2）。
 *      b. report.json 里 sessionSourceMap 中所有 session 的 user-message（权重 1；
 *         单条截 600 字符，从 jsonl 直接 re-parse 提取）。
 *   3. 评分：词项 tf 加权和 × 字段权重，除以 sqrt(文档长度) 归一。确定性，无 embedding。
 *   4. 双时间过滤：默认 invalidAt===null 的 notes；includeSuperseded=true 时全量。
 *   5. notes.json 不存在时优雅降级（只搜消息）。topK 默认 8。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { encodeProjectPath } from '../parsers/claude-code.js';
import type { AskEngine, AskResult, AskHit } from './types.js';
import type { DistilledNote, NotesFile } from '../distill/types.js';
import type { ParsedSession, TranscriptParser } from '../schema/events.js';
import { loadMessagesIndex } from '../messages/index.js';

// ── Tokenisation ──────────────────────────────────────────────────────────────

/**
 * Split a camelCase or snake_case identifier into lowercase parts.
 * "helloWorld" -> ["hello", "world"]
 * "parse_result" -> ["parse", "result"]
 */
function splitIdentifier(token: string): string[] {
  // Handle snake_case and kebab-case
  const byUnderscore = token.split(/[_-]+/).filter((t) => t.length > 0);
  const result: string[] = [];
  for (const piece of byUnderscore) {
    // Insert boundary before an uppercase letter preceded by a lowercase letter
    // or before an uppercase sequence followed by a lowercase letter.
    const parts = piece
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ');
    for (const p of parts) {
      if (p.length > 0) result.push(p.toLowerCase());
    }
  }
  return result;
}

/** Return true when the character is a CJK ideograph. */
function isCJKChar(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs (common block)
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) // CJK Extension B
  );
}

/**
 * Tokenise text into lowercase terms.
 *
 * Strategy:
 * - Scan character-by-character to split text into CJK runs and non-CJK runs.
 * - CJK runs: 2-gram over consecutive CJK characters; also add single-character
 *   tokens so single-character queries can match.
 * - Non-CJK runs: split on non-alphanumeric boundaries, then expand each word
 *   via camelCase / snake_case splitting.
 *
 * Duplicates are intentional — they feed term-frequency counting.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // Build runs of consecutive CJK vs non-CJK characters.
  const runs: { cjk: boolean; chars: string }[] = [];
  let curCJK = false;
  let curChars = '';

  for (const ch of text) {
    const thisCJK = isCJKChar(ch);
    if (thisCJK !== curCJK && curChars.length > 0) {
      runs.push({ cjk: curCJK, chars: curChars });
      curChars = '';
    }
    curCJK = thisCJK;
    curChars += ch;
  }
  if (curChars.length > 0) runs.push({ cjk: curCJK, chars: curChars });

  for (const run of runs) {
    if (run.cjk) {
      // 2-gram
      for (let i = 0; i < run.chars.length - 1; i++) {
        tokens.push(run.chars[i]! + run.chars[i + 1]!);
      }
      // Unigrams (for single-character queries)
      for (let i = 0; i < run.chars.length; i++) {
        tokens.push(run.chars[i]!);
      }
    } else {
      // Split on non-alphanumeric boundaries.
      const rawWords = run.chars.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
      for (const word of rawWords) {
        const parts = splitIdentifier(word);
        if (parts.length > 1) {
          tokens.push(...parts);
          // Also keep the original lowercased form for exact-word queries.
          tokens.push(word.toLowerCase());
        } else {
          tokens.push(word.toLowerCase());
        }
      }
    }
  }

  return tokens;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/** Compute a term-frequency map from a token list. */
function termFreq(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokens) {
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return map;
}

/**
 * Score a document against a query term-frequency map.
 *
 * score = sum_over_terms( queryTf(term) * docTf(term) * fieldWeight )
 *         / sqrt( totalWeightedDocTokens )
 *
 * The sqrt normalisation penalises very long documents so short, precise notes
 * are not drowned out by verbose ones.
 */
function scoreDocument(
  queryTerms: Map<string, number>,
  fields: { tokens: string[]; weight: number }[],
): number {
  let rawScore = 0;
  let docLength = 0;

  for (const { tokens, weight } of fields) {
    const docTf = termFreq(tokens);
    for (const [term, qCount] of queryTerms) {
      const dCount = docTf.get(term) ?? 0;
      if (dCount > 0) {
        rawScore += qCount * dCount * weight;
      }
    }
    docLength += tokens.length * weight;
  }

  if (docLength === 0) return 0;
  return rawScore / Math.sqrt(docLength);
}

// ── File filter ─────────────────────────────────────────────────────────────

/**
 * Decide whether a note's `files[]` contains `target`, tolerating relative vs
 * absolute path differences via suffix matching.
 *
 * Both sides are normalised (backslashes → slashes, leading "./" stripped). A
 * note file matches when, segment-aligned, one path is a suffix of the other:
 *   target "src/cli.ts"            ~ note file "/abs/repo/src/cli.ts"  ✓
 *   target "/abs/repo/src/cli.ts"  ~ note file "src/cli.ts"           ✓
 *   target "cli.ts"               ~ note file "src/cli.ts"           ✓ (basename-ish suffix)
 *   target "src/cli.ts"           ~ note file "src/other.ts"         ✗
 *
 * Segment alignment (matching on "/"+suffix or full equality) prevents
 * "li.ts" from matching "cli.ts".
 */
function normalizeForMatch(p: string): string {
  let s = p.replace(/\\/g, '/').trim();
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

export function noteMatchesFile(noteFiles: string[], target: string): boolean {
  const t = normalizeForMatch(target);
  if (!t) return false;
  for (const raw of noteFiles) {
    const f = normalizeForMatch(raw);
    if (!f) continue;
    if (f === t) return true;
    // Segment-aligned suffix match in either direction.
    if (f.endsWith('/' + t) || t.endsWith('/' + f)) return true;
  }
  return false;
}

// ── Notes index ───────────────────────────────────────────────────────────────

const WEIGHT_TITLE = 3;
const WEIGHT_BODY = 1.5;
const WEIGHT_FILE = 2;

/** Tokenise a file path by splitting on separators and then tokenising each segment. */
function filePathTokens(filePath: string): string[] {
  const parts = filePath.replace(/\\/g, '/').split('/').filter((p) => p.length > 0);
  const tokens: string[] = [];
  for (const part of parts) {
    tokens.push(...tokenize(part));
  }
  return tokens;
}

/** Score a DistilledNote against query terms. */
function scoreNote(note: DistilledNote, queryTerms: Map<string, number>): number {
  const titleTokens = tokenize(note.title);
  const bodyTokens = tokenize(note.body);
  const fileTokensList = note.files.flatMap(filePathTokens);

  return scoreDocument(queryTerms, [
    { tokens: titleTokens, weight: WEIGHT_TITLE },
    { tokens: bodyTokens, weight: WEIGHT_BODY },
    { tokens: fileTokensList, weight: WEIGHT_FILE },
  ]);
}

// ── Message index ─────────────────────────────────────────────────────────────

const WEIGHT_MSG = 1;
const MSG_TRUNCATE = 600;

/**
 * Relevance floor: hits scoring below this are dropped as noise rather than
 * returned. Without it an unrelated query (e.g. random tokens that happen to
 * brush a single common token) surfaces near-zero-score garbage. Notes and
 * messages are both subject to it.
 */
export const MIN_SCORE = 0.3;

/**
 * Validity weight applied to a note's score when ranking. Currently-valid notes
 * (invalidAt === null) get a 1.5× boost so a superseded note can never out-rank
 * the note that replaced it on equal raw relevance (the "superseded reversal"
 * bug). Applied only to ranking — the raw `score` returned is unweighted.
 */
const VALID_NOTE_WEIGHT = 1.5;

export interface MessageIndexEntry {
  sessionId: string;
  seq: number;
  text: string;
}

/**
 * Content blacklist — messages that are lore's own pipeline artifacts, not real
 * project conversation. Indexing them pollutes `ask` results with meta-noise:
 *   - task-notification harness lines (start with "<task-notification>")
 *   - the distiller prompt itself ("software-archaeology distiller")
 *   - tool-plumbing envelopes ("tool-use-id" / "output-file")
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

/**
 * Decide whether a transcript sourcePath belongs to the target repo, so we only
 * index messages from THIS project's sessions (sessions for other repos share the
 * global ~/.claude/projects/ tree). Accepts a path when it is either:
 *   - under ~/.claude/projects/<encodeProjectPath(repoPath)>/ (the canonical home), or
 *   - inside the repo directory itself (in-repo / fixture transcripts).
 * encodeProjectPath is reused from parsers/claude-code.ts (single source of truth).
 */
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

function parsedSessionBelongsToRepo(
  session: ParsedSession,
  sourcePath: string,
  repoPath: string,
): boolean {
  return sourcePathBelongsToRepo(sourcePath, repoPath) || cwdBelongsToRepo(session.meta.cwd, repoPath);
}

/** Score a message entry against query terms. */
function scoreMessage(
  entry: MessageIndexEntry,
  queryTerms: Map<string, number>,
): number {
  const tokens = tokenize(entry.text);
  return scoreDocument(queryTerms, [{ tokens, weight: WEIGHT_MSG }]);
}

// ── Report.json reader ────────────────────────────────────────────────────────

/** Minimal shape we need from .lore/report.json. */
interface LoreReportShape {
  generatedAt?: string;
  sessionSourceMap?: Record<string, string>;
}

function indexFreshEnough(indexGeneratedAt: string, reportGeneratedAt: string | null): boolean {
  if (!reportGeneratedAt) return true;
  const indexMs = Date.parse(indexGeneratedAt);
  const reportMs = Date.parse(reportGeneratedAt);
  if (Number.isNaN(indexMs) || Number.isNaN(reportMs)) return false;
  return indexMs >= reportMs;
}

// ── User-message extraction from transcript ───────────────────────────────────

async function loadTranscriptParsers(): Promise<TranscriptParser[]> {
  try {
    const mod = await import('../parsers/registry.js');
    return Array.isArray(mod.allParsers) ? mod.allParsers : [];
  } catch {
    return [];
  }
}

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
 * Parse a transcript through the registered normalizing parsers and extract
 * user messages from the shared LoreEvent schema. This keeps ask's raw-message
 * fallback agent-neutral (Claude, Codex, OpenCode) while preserving graceful
 * degradation: unreadable or unsupported transcripts simply add no messages.
 */
async function extractUserMessages(
  sourcePath: string,
  sessionId: string,
  repoPath: string,
  parsers: TranscriptParser[],
): Promise<MessageIndexEntry[]> {
  const session = await parseBestSession(sourcePath, sessionId, parsers);
  if (!session || !parsedSessionBelongsToRepo(session, sourcePath, repoPath)) return [];
  const entries: MessageIndexEntry[] = [];

  for (const event of session.events) {
    if (event.kind !== 'user-message') continue;
    const text = event.text;
    if (!text.trim()) continue;

    // Content blacklist: skip lore's own pipeline artifacts (task-notifications,
    // the distiller prompt, tool-plumbing envelopes) so they never enter the index.
    if (isLorePipelineArtifact(text)) continue;

    entries.push({
      sessionId: event.sessionId,
      seq: event.seq,
      text: text.length > MSG_TRUNCATE ? text.slice(0, MSG_TRUNCATE) : text,
    });
  }

  return entries;
}

// ── AskEngine implementation ──────────────────────────────────────────────────

const TOP_K_DEFAULT = 8;

class DeterministicAskEngine implements AskEngine {
  async ask(
    repoPath: string,
    question: string,
    opts?: { topK?: number; includeSuperseded?: boolean; file?: string },
  ): Promise<AskResult> {
    const repo = path.resolve(repoPath);
    const topK = opts?.topK ?? TOP_K_DEFAULT;
    const includeSuperseded = opts?.includeSuperseded ?? false;
    const fileFilter = opts?.file && opts.file.trim() ? opts.file.trim() : null;

    // 1. Tokenise query.
    const queryTokens = tokenize(question);
    if (queryTokens.length === 0) {
      return { question, hits: [], messageHits: [] };
    }
    const queryTerms = termFreq(queryTokens);

    // 2. Load notes.json (optional — degrade gracefully if absent).
    const notesPath = path.join(repo, '.lore', 'notes.json');
    let notes: DistilledNote[] = [];
    try {
      const raw = await fs.readFile(notesPath, 'utf8');
      const notesFile = JSON.parse(raw) as NotesFile;
      if (Array.isArray(notesFile.notes)) {
        notes = notesFile.notes;
      }
    } catch {
      // notes.json absent or malformed — degrade to message search only.
    }

    // 3. Filter notes by bi-temporal validity, then (optionally) by file scope.
    //    fileFilter limits hits to notes whose files[] contains the target path
    //    (suffix-tolerant). Notes with no files never match a file-scoped query.
    let filteredNotes = includeSuperseded
      ? notes
      : notes.filter((n) => n.invalidAt === null);
    if (fileFilter) {
      filteredNotes = filteredNotes.filter((n) => noteMatchesFile(n.files, fileFilter));
    }

    // 4. Score notes. Drop sub-threshold (MIN_SCORE) noise. Rank by a
    //    validity-weighted score (valid notes get a 1.5× boost) so a superseded
    //    note can never out-rank the note that replaced it on equal relevance;
    //    the `score` we return stays the raw, unweighted value.
    const noteHits: { hit: AskHit; rankScore: number }[] = [];
    for (const note of filteredNotes) {
      const score = scoreNote(note, queryTerms);
      // file 过滤命中的笔记豁免 MIN_SCORE：文件归属本身就是相关性证据——
      // "改 X 前查它的约束"场景里，问题词常常不出现在笔记正文。
      if (score < MIN_SCORE && !fileFilter) continue;
      const rankScore = note.invalidAt === null ? score * VALID_NOTE_WEIGHT : score;
      noteHits.push({ hit: { score, note }, rankScore });
    }
    noteHits.sort((a, b) => b.rankScore - a.rankScore);
    const topNoteHits = noteHits.slice(0, topK).map((x) => x.hit);

    // File-scoped queries skip the raw-message index entirely: messages have no
    // reliable file attribution, so we cannot filter them by file without either
    // dropping real hits or leaking off-file noise. Return notes-only.
    if (fileFilter) {
      return { question, hits: topNoteHits, messageHits: [] };
    }

    // 5. Load report.json once for fallback and freshness validation.
    //    A valid but stale .lore/messages.json must NOT shadow newer transcripts.
    const reportPath = path.join(repo, '.lore', 'report.json');
    let sessionSourceMap: Record<string, string> = {};
    let reportGeneratedAt: string | null = null;
    try {
      const raw = await fs.readFile(reportPath, 'utf8');
      const report = JSON.parse(raw) as LoreReportShape;
      if (report.sessionSourceMap && typeof report.sessionSourceMap === 'object') {
        sessionSourceMap = report.sessionSourceMap;
      }
      if (typeof report.generatedAt === 'string') {
        reportGeneratedAt = report.generatedAt;
      }
    } catch {
      // report.json absent — no live fallback; persisted index may still be useful.
    }

    // 6. Build message index. 优先用 scan 时物化的 .lore/messages.json
    //    （单文件 read + 单次 JSON.parse），避免每次 ask 都重 parse 全部 transcript。
    //    缺失 / 旧版 schema → 降级为实时 re-parse（保正确性，慢但能跑）。
    let allMessages: MessageIndexEntry[];
    const persistedIndex = await loadMessagesIndex(repo);
    if (persistedIndex && indexFreshEnough(persistedIndex.generatedAt, reportGeneratedAt)) {
      allMessages = persistedIndex.entries;
    } else {
      // Fallback: 老的实时 re-parse 路径（scan 没生成索引，或是个老仓库）。
      const parsers = await loadTranscriptParsers();
      const perSession = await Promise.all(
        Object.entries(sessionSourceMap).map(([sid, srcPath]) =>
          extractUserMessages(srcPath, sid, repo, parsers),
        ),
      );
      allMessages = perSession.flat();
    }

    // 7. Score messages. Drop sub-threshold (MIN_SCORE) noise so an unrelated
    //    query returns nothing rather than near-zero-score garbage.
    const msgScored: { entry: MessageIndexEntry; score: number }[] = [];
    for (const entry of allMessages) {
      const score = scoreMessage(entry, queryTerms);
      if (score >= MIN_SCORE) {
        msgScored.push({ entry, score });
      }
    }
    msgScored.sort((a, b) => b.score - a.score);
    const topMessages = msgScored.slice(0, topK).map(({ entry, score }) => ({
      sessionId: entry.sessionId,
      seq: entry.seq,
      text: entry.text,
      score,
    }));

    return {
      question,
      hits: topNoteHits,
      messageHits: topMessages,
    };
  }
}

/**
 * Named export `engine` for cli.ts dynamic import pattern (`mod.engine`).
 * Shared singleton — stateless, safe to reuse.
 */
export const engine: AskEngine = new DeterministicAskEngine();

/** Factory for injection in tests. */
export function createAskEngine(): AskEngine {
  return new DeterministicAskEngine();
}
