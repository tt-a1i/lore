/**
 * Graph builder —— 纯函数，把 (commits, sessions, report) 聚合成 GraphData。
 *
 * 零 IO、零 git、零 LLM：与匹配引擎一样是确定性的。输入是已经解析好的
 * session 事件流、git 历史（含 hunk）、以及匹配引擎产出的 RepoMatchReport。
 * 输出喂给 GraphStore.rebuild()。
 *
 * 四个聚合维度：
 *   Session 节点：按 sessionId 把所有解析单元（父 session + 各子 agent transcript）
 *     折叠成一个逻辑会话——sourcePaths 收全部解析单元路径，startedAt/endedAt 取
 *     最早/最晚，cwd/gitBranch/agent 取首个非空。
 *   PRODUCED 边：把 MatchCandidate 按 (sessionId, commitHash) 聚合——
 *     confidence 取最大；fileCount 数去重文件；matchedLines 求和；
 *     sourcePath/matchedVia 取贡献 matchedLines 最多的解析单元（证据指针）。
 *   TOUCHES 边：来自 commits 的 git 事实，addedLines/removedLines 从 hunks 汇总。
 *   EDITED 边：按 (sessionId, filePath) 聚合 file-edit 事件，路径归一逻辑与
 *     匹配引擎一致（normalizePath 前缀剥离 + 后缀解析兜底，commit 文件集做唯一性约束）。
 *
 * 设计取舍：路径归一逻辑（normalizePath / suffix resolver）在引擎里未导出，
 * 这里按契约要求复刻同一套思路；EDITED 与 PRODUCED 的文件口径因此保持一致。
 */

import type { CommitInfo, CommitFile } from '../git/types.js';
import type { ParsedSession, FileEditEvent } from '../schema/events.js';
import type { RepoMatchReport, MatchCandidate } from '../match/types.js';
import type {
  GraphData,
  SessionNodeData,
  CommitNodeData,
  FileNodeData,
  ProducedEdgeData,
  TouchesEdgeData,
  EditedEdgeData,
} from './types.js';

// ── path normalization (与 match/engine.ts 同构) ─────────────────────────────

/**
 * 朴素前缀剥离：absPath 在 repoPath（或 session.cwd）下时剥成相对路径。
 * 已是相对路径去掉前导 './'。返回 null = 不在 repo 内。
 */
function normalizePath(rawPath: string, repoPath: string, cwd: string | null): string | null {
  const stripTrailingSlash = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p);
  const repo = stripTrailingSlash(repoPath);

  if (rawPath.startsWith(repo + '/')) {
    return rawPath.slice(repo.length + 1);
  }
  if (rawPath === repo) return '';

  if (cwd) {
    const c = stripTrailingSlash(cwd);
    if (c !== repo && rawPath.startsWith(c + '/')) {
      return rawPath.slice(c.length + 1);
    }
  }

  if (!rawPath.startsWith('/')) {
    return rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  }

  return null;
}

/**
 * worktree/别名根兜底：前缀剥离失败的绝对路径用后缀对 commit 文件清单唯一匹配。
 * 从长到短取后 k 段（k≥2，避免 basename 误归），命中唯一即采用。
 */
function buildSuffixResolver(commits: CommitInfo[]): (absPath: string) => string | null {
  const byBasename = new Map<string, string[]>();
  for (const c of commits) {
    for (const cf of c.files) {
      const base = cf.path.slice(cf.path.lastIndexOf('/') + 1);
      const arr = byBasename.get(base);
      if (arr) {
        if (!arr.includes(cf.path)) arr.push(cf.path);
      } else byBasename.set(base, [cf.path]);
    }
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
      if (hits.length === 0) continue;
    }
    return null;
  };
}

function parseTs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** ISO 比较：取较早的（空串视为"无界"）。 */
function earlier(a: string | null, b: string): string {
  if (!a) return b;
  return parseTs(a) <= parseTs(b) ? a : b;
}

/** ISO 比较：取较晚的。 */
function later(a: string | null, b: string): string {
  if (!a) return b;
  return parseTs(a) >= parseTs(b) ? a : b;
}

function firstLine(message: string): string {
  const idx = message.indexOf('\n');
  return idx === -1 ? message : message.slice(0, idx);
}

// ── Session 节点聚合 ─────────────────────────────────────────────────────────

interface SessionAccum {
  id: string;
  agent: string;
  startedAt: string;
  endedAt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  sourcePaths: Set<string>;
}

function buildSessions(sessions: ParsedSession[]): SessionNodeData[] {
  const byId = new Map<string, SessionAccum>();

  for (const s of sessions) {
    const m = s.meta;
    let acc = byId.get(m.sessionId);
    if (!acc) {
      acc = {
        id: m.sessionId,
        agent: m.agent,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        cwd: m.cwd,
        gitBranch: m.gitBranch,
        sourcePaths: new Set<string>(),
      };
      byId.set(m.sessionId, acc);
    } else {
      // 跨解析单元折叠：最早 start / 最晚 end；元数据取首个非空。
      acc.startedAt = earlier(acc.startedAt, m.startedAt);
      acc.endedAt =
        m.endedAt === null ? acc.endedAt : acc.endedAt === null ? m.endedAt : later(acc.endedAt, m.endedAt);
      if (!acc.cwd && m.cwd) acc.cwd = m.cwd;
      if (!acc.gitBranch && m.gitBranch) acc.gitBranch = m.gitBranch;
    }
    if (m.sourcePath) acc.sourcePaths.add(m.sourcePath);
  }

  const out: SessionNodeData[] = [];
  for (const acc of byId.values()) {
    out.push({
      id: acc.id,
      agent: acc.agent,
      startedAt: acc.startedAt,
      endedAt: acc.endedAt,
      cwd: acc.cwd,
      gitBranch: acc.gitBranch,
      sourcePaths: [...acc.sourcePaths].sort(),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ── Commit 节点 + TOUCHES 边 ─────────────────────────────────────────────────

function hunkLineCounts(cf: CommitFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of cf.hunks) {
    added += h.addedLines.length;
    removed += h.removedLines.length;
  }
  return { added, removed };
}

function buildCommitsAndTouches(commits: CommitInfo[]): {
  commits: CommitNodeData[];
  touches: TouchesEdgeData[];
  files: Set<string>;
} {
  const commitNodes: CommitNodeData[] = [];
  const touches: TouchesEdgeData[] = [];
  const files = new Set<string>();

  for (const c of commits) {
    commitNodes.push({
      hash: c.hash,
      subject: firstLine(c.message),
      authorDate: c.authorDate,
      committerDate: c.committerDate,
      isMerge: c.isMerge,
    });
    for (const cf of c.files) {
      files.add(cf.path);
      const { added, removed } = hunkLineCounts(cf);
      touches.push({
        commitHash: c.hash,
        filePath: cf.path,
        status: cf.status,
        addedLines: added,
        removedLines: removed,
      });
    }
  }

  return { commits: commitNodes, touches, files };
}

// ── PRODUCED 边：按 (sessionId, commitHash) 聚合 MatchCandidate ───────────────

interface ProducedAccum {
  sessionId: string;
  commitHash: string;
  confidence: number; // max
  matchedVia: 'sha' | 'content';
  files: Set<string>;
  matchedLines: number; // sum
  /** sourcePath → 该解析单元累计的 matchedLines（用于挑证据指针）。 */
  bySource: Map<string, number>;
}

function buildProduced(matches: MatchCandidate[]): ProducedEdgeData[] {
  const byKey = new Map<string, ProducedAccum>();

  for (const m of matches) {
    const key = m.sessionId + ' ' + m.commitHash;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        sessionId: m.sessionId,
        commitHash: m.commitHash,
        confidence: m.confidence,
        matchedVia: m.matchedVia,
        files: new Set<string>(),
        matchedLines: 0,
        bySource: new Map<string, number>(),
      };
      byKey.set(key, acc);
    }
    acc.files.add(m.filePath);
    acc.matchedLines += m.matchedLines;
    if (m.confidence > acc.confidence) {
      acc.confidence = m.confidence;
      // matchedVia 跟随置信度最高的候选（sha 锚定通常 1.0，会胜出）。
      acc.matchedVia = m.matchedVia;
    }
    const src = m.sourcePath || '';
    acc.bySource.set(src, (acc.bySource.get(src) ?? 0) + m.matchedLines);
  }

  const out: ProducedEdgeData[] = [];
  for (const acc of byKey.values()) {
    // 证据指针：取贡献 matchedLines 最多的解析单元。平局取字典序最小（确定性）。
    let bestSource = '';
    let bestLines = -1;
    for (const [src, lines] of [...acc.bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (lines > bestLines) {
        bestLines = lines;
        bestSource = src;
      }
    }
    out.push({
      sessionId: acc.sessionId,
      commitHash: acc.commitHash,
      confidence: acc.confidence,
      matchedVia: acc.matchedVia,
      sourcePath: bestSource,
      matchedLines: acc.matchedLines,
      fileCount: acc.files.size,
    });
  }
  out.sort(
    (a, b) =>
      a.sessionId.localeCompare(b.sessionId) || a.commitHash.localeCompare(b.commitHash),
  );
  return out;
}

// ── EDITED 边：按 (sessionId, filePath) 聚合 file-edit 事件 ───────────────────

interface EditedAccum {
  sessionId: string;
  filePath: string;
  sourcePath: string;
  editCount: number;
  firstTs: string;
  lastTs: string;
}

function buildEdited(
  repoPath: string,
  sessions: ParsedSession[],
  commits: CommitInfo[],
): EditedEdgeData[] {
  const suffixResolve = buildSuffixResolver(commits);
  const commitPaths = new Set<string>();
  for (const c of commits) for (const cf of c.files) commitPaths.add(cf.path);

  const byKey = new Map<string, EditedAccum>();

  for (const session of sessions) {
    const cwd = session.meta.cwd;
    const sourcePath = session.meta.sourcePath;

    for (const ev of session.events) {
      if (ev.kind !== 'file-edit') continue;
      const edit = ev as FileEditEvent;
      // 与匹配引擎一致：失败编辑（succeeded===false）不计入。
      if (edit.succeeded === false) continue;

      let rel = normalizePath(edit.filePath, repoPath, cwd);
      // 前缀可能剥出 repo 内但不在 commit 集的错误路径（如 worktree 在 repo 内部）——
      // 交给后缀解析兜底，使 EDITED 文件口径与 commit/PRODUCED 对齐。
      if (rel === null || rel === '' || !commitPaths.has(rel)) {
        const resolved = suffixResolve(edit.filePath);
        if (resolved) rel = resolved;
      }
      if (rel === null || rel === '') continue;

      // EDITED 是"transcript 事实"，按 sessionId 聚合（PRODUCED 的证据指针才细到解析单元）。
      const key = session.meta.sessionId + ' ' + rel;
      let acc = byKey.get(key);
      if (!acc) {
        acc = {
          sessionId: session.meta.sessionId,
          filePath: rel,
          sourcePath,
          editCount: 0,
          firstTs: edit.ts,
          lastTs: edit.ts,
        };
        byKey.set(key, acc);
      }
      acc.editCount += 1;
      acc.firstTs = earlier(acc.firstTs, edit.ts);
      acc.lastTs = later(acc.lastTs, edit.ts);
      // 同 session 跨解析单元编辑同一文件：sourcePath 取首个（稳定即可，证据由 PRODUCED 承担）。
    }
  }

  const out: EditedEdgeData[] = [];
  for (const acc of byKey.values()) {
    out.push({
      sessionId: acc.sessionId,
      filePath: acc.filePath,
      sourcePath: acc.sourcePath,
      editCount: acc.editCount,
      firstTs: acc.firstTs,
      lastTs: acc.lastTs,
    });
  }
  out.sort(
    (a, b) => a.sessionId.localeCompare(b.sessionId) || a.filePath.localeCompare(b.filePath),
  );
  return out;
}

// ── 顶层入口 ─────────────────────────────────────────────────────────────────

/**
 * 纯函数聚合：把 git 历史、解析好的 session、匹配报告折叠成图谱数据。
 * File 节点 = TOUCHES 与 EDITED 涉及的全部相对路径并集。
 */
export function buildGraphData(
  repoPath: string,
  commits: CommitInfo[],
  sessions: ParsedSession[],
  report: RepoMatchReport,
): GraphData {
  const sessionNodes = buildSessions(sessions);
  const { commits: commitNodes, touches, files } = buildCommitsAndTouches(commits);
  const produced = buildProduced(report.matches);
  const edited = buildEdited(repoPath, sessions, commits);

  // File 节点：commit 触碰 ∪ session 编辑。
  const fileSet = new Set<string>(files);
  for (const e of edited) fileSet.add(e.filePath);
  const fileNodes: FileNodeData[] = [...fileSet].sort().map((path) => ({ path }));

  return {
    sessions: sessionNodes,
    commits: commitNodes,
    files: fileNodes,
    produced,
    touches,
    edited,
  };
}
