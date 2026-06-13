/**
 * WhyEngine 实现 —— `lore why <file>:<line>`，从一行代码回到产生它的对话。
 *
 * 管线（确定性、零 LLM）：
 *   1. git blame -L line,line --porcelain（execFile）→ commit hash + 行内容。
 *      hash 全 0 = 未提交（working tree / staged），报清晰错误。
 *   2. 读 <repo>/.lore/report.json，取该 (commitHash, filePath) 的 MatchCandidate
 *      列表（按 confidence 降序，取前 3）作为归因。
 *   3. 每个归因：parse 其 candidate.sourcePath（注册 parser 中选最佳匹配），按 editSeqs 定位
 *      file-edit 事件，向前找最近 user/assistant、向后找最近各一条，
 *      截 400 字符做 ConversationExcerpt（锚点 = sessionId + seq）。
 *   4. commit 元数据优先取 GraphStore.whoProducedCommit（图谱已吸收 squash/分支形态）；
 *      图谱里没有（窗口外 commit）则用 git show 兜底，仍优雅输出。
 *   5. 无归因（盲区）：用 GraphStore.sessionsEditingFile 填 editedBy。
 *
 * 设计取舍（偏离 why/types.ts 头注释，见 notes）：
 *   - 归因的 MatchCandidate 取自 report.json 而非 GraphStore.whoProducedCommit——
 *     candidate 才有 (commitHash, filePath) 级粒度与 editSeqs/sourcePath；PRODUCED 边
 *     是 (session,commit) 聚合后的，丢了 per-file 的 editSeqs。两者一致（同一份匹配）。
 *   - GraphStore 经构造函数注入（不 import 具体实现），引擎可单测且不耦合存储后端。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CommitNodeData } from '../graph/types.js';
import type { GraphStore } from '../graph/types.js';
import type {
  WhyEngine,
  WhyOptions,
  WhyResult,
  WhyAttribution,
  ConversationExcerpt,
} from './types.js';
import type { MatchCandidate, RepoMatchReport } from '../match/types.js';
import type { TranscriptParser, ParsedSession, LoreEvent } from '../schema/events.js';
import { loadSnapshot, excerptsForCommit, type ExcerptsSnapshot } from '../excerpts/snapshot.js';

const execFileAsync = promisify(execFile);

const EXCERPT_MAX = 400;
const TOP_ATTRIBUTIONS = 3;

/** .lore/report.json 的形态（与 cli.ts 的 LoreReportFile 同构，仅取我们用到的字段）。 */
interface LoreReportFile extends RepoMatchReport {
  sessionSourceMap?: Record<string, string>;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/** blame --porcelain 的首行：`<hash> <origLine> <finalLine> [<numLines>]`。 */
interface BlameResult {
  hash: string;
  lineContent: string;
}

/**
 * git blame -L line,line --porcelain <file>，拿该行的 commit hash 与原始行内容。
 * porcelain 输出：首行是 header，行内容在以 TAB 开头的那一行。
 */
async function blameLine(
  repoPath: string,
  file: string,
  line: number,
): Promise<BlameResult> {
  let stdout: string;
  try {
    const res = await execFileAsync(
      'git',
      ['-C', repoPath, 'blame', '-L', `${line},${line}`, '--porcelain', '--', file],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`git blame failed for ${file}:${line} — ${msg}`);
  }

  const lines = stdout.split('\n');
  if (lines.length === 0 || !lines[0]) {
    throw new Error(`git blame returned no output for ${file}:${line}`);
  }
  const header = lines[0]!.trim().split(/\s+/);
  const hash = header[0] ?? '';
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    throw new Error(`git blame produced an unexpected hash for ${file}:${line}: "${hash}"`);
  }
  // 全 0 hash = 未提交（working tree / staged）。
  if (/^0{40}$|^0{7,}$/.test(hash)) {
    throw new Error(
      `${file}:${line} is not committed yet (git blame reports all-zero hash). ` +
        `Commit the change before running "lore why".`,
    );
  }

  // 行内容：以 TAB 开头的那一行（去掉前导 TAB）。
  let lineContent = '';
  for (const l of lines) {
    if (l.startsWith('\t')) {
      lineContent = l.slice(1);
      break;
    }
  }

  return { hash, lineContent };
}

/** 从 git 直接取 commit 元数据（图谱里没有该 commit 时的兜底）。 */
async function commitFromGit(repoPath: string, hash: string): Promise<CommitNodeData> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'show', '-s', '--format=%H%n%s%n%aI%n%cI%n%P', hash],
      { encoding: 'utf8' },
    );
    const parts = stdout.split('\n');
    const full = parts[0]?.trim() || hash;
    const subject = parts[1] ?? '';
    const authorDate = parts[2]?.trim() ?? '';
    const committerDate = parts[3]?.trim() ?? '';
    const parents = (parts[4]?.trim() ?? '').split(/\s+/).filter(Boolean);
    return {
      hash: full,
      subject,
      authorDate,
      committerDate,
      isMerge: parents.length > 1,
    };
  } catch {
    // 连 git show 都失败（不应发生）：返回最小可用对象，仍优雅输出。
    return {
      hash,
      subject: '(commit metadata unavailable)',
      authorDate: '',
      committerDate: '',
      isMerge: false,
    };
  }
}

/** 在事件流中向某方向找第一条指定 kind 的消息，返回摘录或 null。 */
function findNearest(
  events: LoreEvent[],
  fromIdx: number,
  direction: -1 | 1,
  kind: 'user-message' | 'assistant-message',
): ConversationExcerpt | null {
  for (let i = fromIdx + direction; i >= 0 && i < events.length; i += direction) {
    const e = events[i];
    if (!e) continue;
    if (e.kind === kind) {
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        role: kind === 'user-message' ? 'user' : 'assistant',
        text: truncate((e as { text: string }).text, EXCERPT_MAX),
        ts: e.ts,
      };
    }
  }
  return null;
}

/**
 * 对一个归因：parse sourcePath → 按 editSeqs 定位编辑事件 → 抽前后最近的
 * user/assistant 消息做摘录。摘录按 (seq, role) 去重。
 */
function buildExcerpts(session: ParsedSession, editSeqs: number[]): ConversationExcerpt[] {
  const events = session.events;
  const editSeqSet = new Set(editSeqs);
  const byAnchor = new Map<string, ConversationExcerpt>();

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e || e.kind !== 'file-edit' || !editSeqSet.has(e.seq)) continue;

    const candidates = [
      findNearest(events, idx, -1, 'user-message'),
      findNearest(events, idx, -1, 'assistant-message'),
      findNearest(events, idx, 1, 'user-message'),
      findNearest(events, idx, 1, 'assistant-message'),
    ];
    for (const c of candidates) {
      if (!c) continue;
      const key = c.seq + ':' + c.role;
      if (!byAnchor.has(key)) byAnchor.set(key, c);
    }
  }

  return [...byAnchor.values()].sort((a, b) => a.seq - b.seq);
}

export class DeterministicWhyEngine implements WhyEngine {
  private readonly parsers: TranscriptParser[];

  constructor(
    private readonly store: GraphStore,
    parser: TranscriptParser | TranscriptParser[],
  ) {
    this.parsers = Array.isArray(parser) ? parser : [parser];
  }

  async why(repoPath: string, file: string, line: number, opts?: WhyOptions): Promise<WhyResult> {
    const repo = path.resolve(repoPath);

    // Resolve confidence floor: default 0.8 unless --include-weak explicitly set.
    const minConfidence = opts?.minConfidence ?? (opts?.includeWeak ? 0 : 0.8);

    // 1. blame
    const { hash, lineContent } = await blameLine(repo, file, line);

    // 2. commit 元数据：优先图谱（吸收了 squash/分支形态），兜底 git。
    const commit = await this.resolveCommit(repo, hash);

    // 3. report.json 取 (commitHash, filePath) 的 candidate，confidence 降序 top 3。
    const candidates = await this.loadCandidates(repo, commit.hash, file, hash, minConfidence);

    // 摘录快照（fallback 链末环）：transcript 被 Claude Code 清理后实时 parse 会落空，
    // 此时归因摘录改从 scan 固化的 .lore/excerpts.json 出，而不是静默空。
    // 一次 why 只读一次快照（why 是一次性命令）；读失败 / 缺失 → null，正常降级。
    const snapshot = await loadSnapshot(repo);

    // 4. 每个 candidate 构建归因（parse sourcePath，抽摘录；摘录空时回落快照）。
    const attributions: WhyAttribution[] = [];
    for (const cand of candidates) {
      const attribution = await this.buildAttribution(repo, commit, cand, snapshot);
      if (attribution) attributions.push(attribution);
    }

    // 5. 盲区：无归因时填 editedBy（编辑过该文件的 session，含未匹配到 commit 的）。
    let editedBy: WhyResult['editedBy'] = [];
    if (attributions.length === 0) {
      editedBy = await this.loadEditedBy(file);
    }

    return {
      file,
      line,
      lineContent,
      commit,
      attributions,
      editedBy,
    };
  }

  /** commit 元数据：图谱优先（whoProducedCommit 带 CommitNodeData），否则 git show。 */
  private async resolveCommit(repoPath: string, hash: string): Promise<CommitNodeData> {
    try {
      const produced = await this.store.whoProducedCommit(hash);
      if (produced.length > 0 && produced[0]) {
        // ProducedInfo 不直接带 commit 节点；用 fileHistory/exportAll 太重。
        // 这里仅确认图谱认得该 commit，元数据仍以 git 为准（确定性、避免图谱过期）。
      }
    } catch {
      // 图谱不可用（未 scan / 后端加载失败）——降级 git，仍优雅输出。
    }
    return commitFromGit(repoPath, hash);
  }

  /**
   * 从 .lore/report.json 取该 (commitHash, filePath) 的 MatchCandidate，
   * confidence 降序，取前 3。blame 的 commit 是全 hash，report 里也可能是短 hash——
   * 双向前缀匹配。filePath 用归一化后缀比较（report 存 repo 相对路径）。
   * minConfidence: 过滤低于此值的候选（默认 0.8，--include-weak 时为 0）。
   */
  private async loadCandidates(
    repoPath: string,
    fullHash: string,
    file: string,
    blameHash: string,
    minConfidence = 0.8,
  ): Promise<MatchCandidate[]> {
    const reportPath = path.join(repoPath, '.lore', 'report.json');
    let report: LoreReportFile;
    try {
      const raw = await fs.readFile(reportPath, 'utf8');
      report = JSON.parse(raw) as LoreReportFile;
    } catch {
      // 没有 report（未 scan）：当作盲区，返回空。
      return [];
    }
    if (!Array.isArray(report.matches)) return [];

    const relFile = normalizeRelFile(file);
    const matched = report.matches.filter((m) => {
      const hashOk = prefixMatch(m.commitHash, fullHash) || prefixMatch(m.commitHash, blameHash);
      const fileOk = filePathMatch(m.filePath, relFile);
      const confOk = m.confidence >= minConfidence;
      return hashOk && fileOk && confOk;
    });

    matched.sort((a, b) => b.confidence - a.confidence);
    return matched.slice(0, TOP_ATTRIBUTIONS);
  }

  /**
   * parse candidate.sourcePath，按 editSeqs 抽摘录，组装 WhyAttribution。
   * 摘录 fallback：实时 parse 出的摘录为空（transcript 已被清理 / parse 失败）时，
   * 回落到 scan 固化的快照（按 commit.hash 命中），保证记忆不依赖 transcript 留存窗口。
   */
  private async buildAttribution(
    repoPath: string,
    commit: CommitNodeData,
    cand: MatchCandidate,
    snapshot: ExcerptsSnapshot | null,
  ): Promise<WhyAttribution | null> {
    let session: ParsedSession | null = null;
    if (cand.sourcePath) {
      session = await this.parseBestSession(cand.sourcePath, cand.sessionId, cand.editSeqs);
    }

    let excerpts: ConversationExcerpt[] = session ? buildExcerpts(session, cand.editSeqs) : [];
    // transcript 还在但 parse 出的摘录为空，或 transcript 已不在 → 用快照兜底。
    // ViewerExcerpt 与 ConversationExcerpt 同构（sessionId/seq/role/text/ts），可直接采用。
    if (excerpts.length === 0 && snapshot) {
      const fromSnapshot = excerptsForCommit(snapshot, commit.hash);
      if (fromSnapshot && fromSnapshot.length > 0) {
        excerpts = fromSnapshot;
      }
    }

    // ProducedInfo 形态：ProducedEdgeData + session 节点。从 candidate + 图谱拼。
    const sessionNode = await this.sessionNodeFor(cand.sessionId, session, commit);

    const attribution: WhyAttribution = {
      produced: {
        sessionId: cand.sessionId,
        commitHash: commit.hash,
        confidence: cand.confidence,
        matchedVia: cand.matchedVia,
        sourcePath: cand.sourcePath,
        matchedLines: cand.matchedLines,
        fileCount: 1, // why 是单文件视角，per-file candidate
        session: sessionNode,
      },
      editSeqs: cand.editSeqs,
      excerpts,
    };
    return attribution;
  }

  /**
   * Try all available transcript parsers and keep the result that actually
   * matches the candidate. Some parsers can "parse" another agent's JSONL into
   * an empty session without throwing, so first-success is not safe here.
   */
  private async parseBestSession(
    sourcePath: string,
    expectedSessionId: string,
    editSeqs: number[],
  ): Promise<ParsedSession | null> {
    let best: ParsedSession | null = null;
    let bestScore = 0;
    const editSeqSet = new Set(editSeqs);

    for (const parser of this.parsers) {
      let session: ParsedSession;
      try {
        const result = await parser.parse(sourcePath);
        session = result.session;
      } catch {
        continue;
      }

      let score = 0;
      if (session.meta.sessionId === expectedSessionId) score += 4;
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

  /** session 节点：优先从图谱拿，否则从重新 parse 的 meta 合成（兜底）。 */
  private async sessionNodeFor(
    sessionId: string,
    parsed: ParsedSession | null,
    _commit: CommitNodeData,
  ): Promise<WhyAttribution['produced']['session']> {
    try {
      const produced = await this.store.whoProducedCommit(_commit.hash);
      const hit = produced.find((p) => p.sessionId === sessionId);
      if (hit) return hit.session;
    } catch {
      // 图谱不可用，走 parse 兜底。
    }
    if (parsed) {
      const m = parsed.meta;
      return {
        id: m.sessionId,
        agent: m.agent,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        cwd: m.cwd,
        gitBranch: m.gitBranch,
        sourcePaths: [m.sourcePath],
      };
    }
    return {
      id: sessionId,
      agent: 'unknown',
      startedAt: '',
      endedAt: null,
      cwd: null,
      gitBranch: null,
      sourcePaths: [],
    };
  }

  /** 盲区辅助：编辑过该文件的 session（含未匹配到 commit 的）。 */
  private async loadEditedBy(file: string): Promise<WhyResult['editedBy']> {
    const relFile = normalizeRelFile(file);
    try {
      const editors = await this.store.sessionsEditingFile(relFile);
      return editors.map((e) => ({
        sessionId: e.session.id,
        agent: e.session.agent,
        lastTs: e.edge.lastTs,
      }));
    } catch {
      return [];
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** 去掉前导 './'，统一成 repo 相对形态用于比较。 */
function normalizeRelFile(file: string): string {
  let f = file;
  if (f.startsWith('./')) f = f.slice(2);
  return f;
}

/** 双向前缀匹配（短 hash vs 全 hash）。 */
function prefixMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** 文件路径匹配：相等或一方是另一方的路径后缀（容忍 worktree 子目录差异）。 */
function filePathMatch(reportPath: string, queried: string): boolean {
  if (reportPath === queried) return true;
  if (reportPath.endsWith('/' + queried)) return true;
  if (queried.endsWith('/' + reportPath)) return true;
  return false;
}

/** 工厂：注入 GraphStore + parser。单测与显式装配走这条。 */
export function createWhyEngine(
  store: GraphStore,
  parser: TranscriptParser | TranscriptParser[],
): WhyEngine {
  return new DeterministicWhyEngine(store, parser);
}

/**
 * 自装配引擎：cli.ts 通过 `mod.engine` 直接拿到一个可用 WhyEngine，
 * 内部按 repoPath 懒加载 GraphStore（graph/factory）与 parser registry。
 * 这样 cli 无需关心依赖装配，引擎本体仍可注入式单测。
 *
 * 注意：每次 why() 都新建 store 并在结束后 close——why 是一次性查询命令，
 * 不复用连接更简单、也避免 kuzu 句柄泄漏。
 */
class SelfWiringWhyEngine implements WhyEngine {
  async why(repoPath: string, file: string, line: number, opts?: WhyOptions): Promise<WhyResult> {
    const repo = path.resolve(repoPath);
    // factory.js 由存储层另行落地；用计算 specifier 做运行时导入，避免
    // 在它就位前阻塞本模块的 typecheck。
    const factorySpec = '../graph/factory.js';
    const [factoryMod, parserRegistry] = await Promise.all([
      import(factorySpec) as Promise<{
        createGraphStore: (p: string) => Promise<GraphStore>;
      }>,
      import('../parsers/registry.js') as Promise<{ allParsers: TranscriptParser[] }>,
    ]);
    const store = await factoryMod.createGraphStore(repo);
    await store.init();
    try {
      const inner = new DeterministicWhyEngine(store, parserRegistry.allParsers);
      return await inner.why(repo, file, line, opts);
    } finally {
      await store.close();
    }
  }
}

/** Named export `engine` expected by cli.ts dynamic import (`mod.engine`). */
export const engine: WhyEngine = new SelfWiringWhyEngine();
