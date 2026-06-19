/**
 * MatchEngine 实现 —— 纯函数、无 IO、无 git 调用。
 *
 * 算法严格遵循 src/match/types.ts 文件头注释的三级体系：
 *   Tier-0 sha 锚定（confidence 1.0）
 *   Tier-1 内容信号（权重 0.8）
 *   Tier-2 时间信号（权重 0.2）
 *
 * 复杂度：建索引 O(总编辑行数)，匹配 O(总 commit 行数)，整体线性。
 */

import type { CommitInfo, CommitFile } from '../git/types.js';
import type { ParsedSession, FileEditEvent } from '../schema/events.js';
import type { MatchEngine, MatchCandidate, RepoMatchReport } from './types.js';
import { tierOf } from './types.js';
import { SCHEMA_VERSION } from '../schema/events.js';
import { prefixMatch } from '../util/text.js';

/** 时钟容差：commit 时间之后仍允许编辑落入窗口（2 分钟）。 */
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;
/** 窗口外线性衰减：每超出 1h 扣 1/24。 */
const DECAY_PER_MS = 1 / 24 / (60 * 60 * 1000);

/** 行归一化：trim；长度 ≤1 的行（空白行、单字符行）不计入。返回 null 表示丢弃。 */
function normalizeLine(line: string): string | null {
  const t = line.trim();
  if (t.length <= 1) return null;
  return t;
}

/** 把一组原始行归一化为有效行数组（已剔除空白/单字符行）。 */
function normalizeLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const n = normalizeLine(l);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * 路径归一：朴素前缀剥离。
 * - absPath 以 repoPath + '/' 开头 → 剥成相对路径。
 * - session.meta.cwd 与 repoPath 不同时，也尝试剥 cwd 前缀（cwd 可能是 repo 的子目录或别名根）。
 * - 已是相对路径则原样返回（仅去掉前导 './'）。
 * 返回 null 表示无法归一（不在 repo 内）。
 */
function normalizePath(rawPath: string, repoPath: string, cwd: string | null): string | null {
  const stripTrailingSlash = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p);
  const repo = stripTrailingSlash(repoPath);

  // 绝对路径：优先用 repoPath 前缀。
  if (rawPath.startsWith(repo + '/')) {
    return rawPath.slice(repo.length + 1);
  }
  if (rawPath === repo) return ''; // 整 repo 路径，无文件名，视为不可用

  // cwd 前缀处理：当 cwd 与 repo 不同，cwd 下的绝对路径需要先剥 cwd，
  // 再拼回相对 repo 的部分。但因 engine 不知道 cwd 相对 repo 的位置，
  // 只在 cwd === repo 的子串关系外做朴素处理：剥掉 cwd 前缀得到相对 cwd 的路径，
  // 该相对路径即视作相对 repo（适用于 cwd 就是 repo 根、或调用方已对齐的情形）。
  if (cwd) {
    const c = stripTrailingSlash(cwd);
    if (c !== repo && rawPath.startsWith(c + '/')) {
      return rawPath.slice(c.length + 1);
    }
  }

  // 相对路径：去掉前导 './'
  if (!rawPath.startsWith('/')) {
    return rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  }

  return null;
}

interface EditContentLines {
  added: string[];
  removed: string[];
}

/** 取一个 FileEditEvent 贡献的归一化行集（patch +/- 行优先，退 newText/oldText）。
 *
 * 注意：write op 整文件覆盖，应与 commit 全文件内容比对，用 newText；
 * 若 oldText 存在，也可用于 delete-only 归因。
 * edit/multi-edit/notebook-edit 才走 patch（+/- 行分通道）。
 * patch 为 null 时统一退 newText/oldText。
 */
function editContentLines(edit: FileEditEvent): EditContentLines {
  // write 整文件覆盖：使用 newText 全文比对，不走 patch（patch 只含变更行，会严重低估重叠率）。
  if (edit.op === 'write') {
    return {
      added: normalizeLines(edit.newText.split('\n')),
      removed: edit.oldText === null ? [] : normalizeLines(edit.oldText.split('\n')),
    };
  }
  if (edit.patch && edit.patch.length > 0) {
    const plus: string[] = [];
    const minus: string[] = [];
    for (const hunk of edit.patch) {
      for (const line of hunk.lines) {
        // structuredPatch 行带 +/-/空格 前缀。
        if (line.startsWith('+')) {
          const n = normalizeLine(line.slice(1));
          if (n !== null) plus.push(n);
        } else if (line.startsWith('-')) {
          const n = normalizeLine(line.slice(1));
          if (n !== null) minus.push(n);
        }
      }
    }
    return { added: plus, removed: minus };
  }
  // 无 patch 的 edit/multi-edit：退回 newText 行集。
  return {
    added: normalizeLines(edit.newText.split('\n')),
    removed: edit.oldText === null ? [] : normalizeLines(edit.oldText.split('\n')),
  };
}

interface EditRecord {
  sessionId: string;
  seq: number;
  ts: number; // epoch ms
  /** 该 edit 贡献的归一化行（多重集，保留重复以做交集计数）。 */
  lines: string[];
}

/**
 * 倒排索引：相对路径 → sessionId → 该 session 该文件所有 edit 的并集（行计数多重集）+ 贡献 seq。
 * 行的多重集合并：同 session 同文件多个 edit 取并集（计数相加）。
 */
interface SessionFileBucket {
  sessionId: string;
  /** 解析单元（transcript 文件）——父 session 与各子 agent 必须分桶，证据才可复核。 */
  sourcePath: string;
  /** 新增归一化行 → 出现次数（多重集）。 */
  lineCounts: Map<string, number>;
  /** 删除归一化行 → 出现次数（多重集）。 */
  removedLineCounts: Map<string, number>;
  /** 贡献了内容的 edit seq（去重、升序）。 */
  seqs: Set<number>;
  /** 该 session 该文件最早/最晚编辑时间，及每个 edit 的 (seq,ts)。 */
  edits: { seq: number; ts: number }[];
}

interface Index {
  /** 相对路径 → (sessionId → bucket) */
  byPath: Map<string, Map<string, SessionFileBucket>>;
  /** sessionId → cwd（用于路径归一与时间） */
  sessions: Map<string, ParsedSession>;
}

function parseTs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * worktree/别名根兜底：前缀剥离失败的绝对路径，用后缀对 commit 文件清单做唯一匹配。
 * 现实动机：agent 常在 git worktree（如 /tmp/hive-pr15/src/a.ts）里编辑，
 * 而 repoPath 是主工作区路径，前缀永远对不上。
 * 规则：从长到短取路径的后 k 段（k 从全长到 2），若恰好唯一命中一个 commit 路径
 * 的等长后缀则采用；始终要求 ≥2 段，避免 README.md 这类 basename 误归。
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
      if (hits.length === 0) continue; // 后缀太长（含 worktree 根目录段），缩短再试
    }
    return null;
  };
}

export class ContentTimeMatchEngine implements MatchEngine {
  match(repoPath: string, commits: CommitInfo[], sessions: ParsedSession[]): RepoMatchReport {
    const suffixResolve = buildSuffixResolver(commits);
    const commitPaths = new Set<string>();
    for (const c of commits) for (const cf of c.files) commitPaths.add(cf.path);
    const index = this.buildIndex(repoPath, sessions, suffixResolve, commitPaths);

    // Tier-0: 预先建立 commit hash 前缀映射，用于把 GitCommitEvent.sha 锚定到 commit。
    // 一个 session 内的 git-commit 事件：sha 前缀匹配 commits.hash。
    // anchored: commitHash -> Set<sessionId>（被锚定），及 commit 事件时间。
    const anchors = this.computeAnchors(commits, sessions);

    const matches: MatchCandidate[] = [];
    const strongCommits = new Set<string>();
    const weakCommits = new Set<string>();
    const matchedAnyCommit = new Set<string>();
    const contributingSessions = new Set<string>();

    // 为时间窗：每个相对路径，按时间升序排列触碰它的 commit，用于求"上一个触碰该文件的 commit 时间"。
    const prevCommitTimeByPath = this.buildPrevCommitTimeIndex(commits);

    for (const commit of commits) {
      const commitTimes = {
        author: parseTs(commit.authorDate),
        committer: parseTs(commit.committerDate),
      };

      for (const cf of commit.files) {
        const relPath = cf.path;

        // ---- Tier-0: 该 commit 被某 session 通过 sha 锚定 ----
        const anchoredSessions = anchors.byCommit.get(commit.hash);
        if (anchoredSessions && anchoredSessions.size > 0) {
          for (const [sid, anchor] of anchoredSessions) {
            // 找该 session 名下、触碰本文件的解析单元桶；证据指向真正干活的文件。
            const sessMap0 = index.byPath.get(relPath);
            const buckets = sessMap0
              ? [...sessMap0.values()].filter((b) => b.sessionId === sid)
              : [];
            const targets = buckets.length > 0 ? buckets : [null];
            for (const bucket of targets) {
              const editSeqs =
                bucket === null
                  ? []
                  : bucket.edits
                      .filter((e) => anchor.ts === 0 || e.ts <= anchor.ts)
                      .map((e) => e.seq)
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .sort((a, b) => a - b);
              const cand: MatchCandidate = {
                commitHash: commit.hash,
                filePath: relPath,
                sessionId: sid,
                editSeqs,
                sourcePath: bucket ? bucket.sourcePath : anchor.sourcePath,
                matchedVia: 'sha',
                matchedLines: bucket ? bucket.lineCounts.size : 0,
                contentScore: 1.0,
                timeScore: 1.0,
                confidence: 1.0,
                evidence: [
                  `anchor: GitCommitEvent.sha 前缀匹配 commit ${commit.hash}`,
                  `editSeqs: ${editSeqs.length} 个 commit 前触碰本文件的编辑`,
                ],
              };
              matches.push(cand);
              strongCommits.add(commit.hash);
              matchedAnyCommit.add(commit.hash);
              contributingSessions.add(sid);
            }
          }
          // Tier-0 命中后不再为同一 (commit,file) 做 Tier-1/2（已 1.0，无需降级）。
          continue;
        }

        // ---- Tier-1 + Tier-2: 内容 + 时间 ----
        const sessionBuckets = index.byPath.get(relPath);
        if (!sessionBuckets || sessionBuckets.size === 0) continue;

        // commit 该文件的目标行集（新增/删除分通道归一化）。
        const targetLines = this.collectContentLines(cf);
        // 目标行多重集计数，便于交集。
        const targetAddedCounts = new Map<string, number>();
        for (const l of targetLines.added) targetAddedCounts.set(l, (targetAddedCounts.get(l) ?? 0) + 1);
        const targetRemovedCounts = new Map<string, number>();
        for (const l of targetLines.removed) targetRemovedCounts.set(l, (targetRemovedCounts.get(l) ?? 0) + 1);

        const prevCommitTime = prevCommitTimeByPath.get(relPath)?.get(commit.hash) ?? null;

        for (const bucket of sessionBuckets.values()) {
          // contentScore: 命中行数 / 可由该 bucket 证明的 commit 侧有效行数。
          // newText-only bucket 没有 removed evidence 时，不把 commit removedLines 计入分母。
          let hits = 0;
          const hasRemovedEvidence = bucket.removedLineCounts.size > 0;
          const targetTotal =
            targetLines.added.length + (hasRemovedEvidence ? targetLines.removed.length : 0);
          if (targetTotal > 0) {
            // 多重集交集：min(目标计数, edit 侧计数) 求和。
            for (const [line, tcount] of targetAddedCounts) {
              const ecount = bucket.lineCounts.get(line);
              if (ecount !== undefined) hits += Math.min(tcount, ecount);
            }
            if (hasRemovedEvidence) {
              for (const [line, tcount] of targetRemovedCounts) {
                const ecount = bucket.removedLineCounts.get(line);
                if (ecount !== undefined) hits += Math.min(tcount, ecount);
              }
            }
          }
          const contentScore = targetTotal > 0 ? hits / targetTotal : 0;

          // timeScore: 取该 session 该文件所有 edit 的最优时间分。
          let timeScore = 0;
          for (const e of bucket.edits) {
            const s = this.timeScoreFor(e.ts, prevCommitTime, commitTimes);
            if (s > timeScore) timeScore = s;
          }

          // 证据下限：<2 行命中直接丢弃；<3 行封顶 weak（单行重叠碰巧率太高）。
          if (hits < 2) continue;
          let confidence = 0.8 * contentScore + 0.2 * timeScore;
          if (hits < 3) confidence = Math.min(confidence, 0.79);
          if (tierOf(confidence) === 'none') continue;

          const editSeqs = [...bucket.seqs].sort((a, b) => a - b);
          const evidence: string[] = [
            `content: ${hits}/${targetTotal} 归一化行重叠 (score=${contentScore.toFixed(3)})`,
            `time: score=${timeScore.toFixed(3)}`,
          ];
          if (hits < 3) evidence.push(`evidence floor: 仅 ${hits} 行命中，封顶 weak`);

          const cand: MatchCandidate = {
            commitHash: commit.hash,
            filePath: relPath,
            sessionId: bucket.sessionId,
            editSeqs,
            sourcePath: bucket.sourcePath,
            matchedVia: 'content',
            matchedLines: hits,
            contentScore,
            timeScore,
            confidence,
            evidence,
          };
          matches.push(cand);
          matchedAnyCommit.add(commit.hash);
          contributingSessions.add(bucket.sessionId);
          const tier = tierOf(confidence);
          if (tier === 'strong') strongCommits.add(commit.hash);
          else if (tier === 'weak') weakCommits.add(commit.hash);
        }
      }
    }

    const unmatchedCommits = commits
      .filter((c) => !matchedAnyCommit.has(c.hash))
      .map((c) => ({ hash: c.hash, subject: firstLine(c.message) }));

    // transcript 覆盖窗口与窗口内口径。
    let window: { start: string; end: string } | null = null;
    let winStart = Infinity;
    let winEnd = -Infinity;
    for (const s of sessions) {
      const st = parseTs(s.meta.startedAt);
      const en = s.meta.endedAt ? parseTs(s.meta.endedAt) : st;
      if (st > 0 && st < winStart) winStart = st;
      if (en > winEnd) winEnd = en;
    }
    let commitsInWindow = 0;
    let strongInWindow = 0;
    let weakInWindow = 0;
    if (winStart !== Infinity && winEnd !== -Infinity) {
      const lo = winStart - CLOCK_TOLERANCE_MS;
      const hi = winEnd + CLOCK_TOLERANCE_MS;
      window = { start: new Date(lo).toISOString(), end: new Date(hi).toISOString() };
      for (const c of commits) {
        const a = parseTs(c.authorDate);
        const ct = parseTs(c.committerDate);
        const inWin = (a >= lo && a <= hi) || (ct >= lo && ct <= hi);
        if (!inWin) continue;
        commitsInWindow++;
        if (strongCommits.has(c.hash)) strongInWindow++;
        else if (weakCommits.has(c.hash)) weakInWindow++;
      }
    }

    // tier 在 commit 级互斥：同一 commit 既有 strong 又有 weak 候选时只计 strong——
    // 否则 strong+weak 会超过 commitsTotal（实测 23+15>27），下游 coverage/unmatched 全部失真。
    for (const h of strongCommits) weakCommits.delete(h);

    return {
      repo: repoPath,
      generatedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      commitsTotal: commits.length,
      commitsMatchedStrong: strongCommits.size,
      commitsMatchedWeak: weakCommits.size,
      sessionsSeen: sessions.length,
      sessionsContributing: contributingSessions.size,
      window,
      commitsInWindow,
      strongInWindow,
      weakInWindow,
      matches,
      unmatchedCommits,
    };
  }

  // ---------------------------------------------------------------------------

  private buildIndex(
    repoPath: string,
    sessions: ParsedSession[],
    suffixResolve?: (absPath: string) => string | null,
    commitPaths?: Set<string>
  ): Index {
    const byPath = new Map<string, Map<string, SessionFileBucket>>();
    const sessionMap = new Map<string, ParsedSession>();

    for (const session of sessions) {
      sessionMap.set(session.meta.sessionId, session);
      const cwd = session.meta.cwd;
      const sourcePath = session.meta.sourcePath;

      for (const ev of session.events) {
        if (ev.kind !== 'file-edit') continue;
        const edit = ev as FileEditEvent;
        // failed (succeeded === false) 的 edit 排除。succeeded === null/true 保留。
        if (edit.succeeded === false) continue;

        let rel = normalizePath(edit.filePath, repoPath, cwd);
        // 前缀剥离可能"成功"地剥出错误路径——典型：worktree 在 repo 内部
        // （<repo>/.claude/worktrees/wf_x-6/src/a.ts → ".claude/worktrees/…"）。
        // 只要剥出的路径不在 commit 文件集里，就交给后缀解析兜底。
        if (suffixResolve && (rel === null || rel === '' || (commitPaths && !commitPaths.has(rel)))) {
          const resolved = suffixResolve(edit.filePath);
          if (resolved) rel = resolved;
        }
        if (rel === null || rel === '') continue;

        const lines = editContentLines(edit);
        // 即便行集为空（极端 write），仍登记 edit 时间用于 anchor/time，但内容无贡献。
        let sessMap = byPath.get(rel);
        if (!sessMap) {
          sessMap = new Map();
          byPath.set(rel, sessMap);
        }
        // 桶按解析单元（sessionId + sourcePath）分，不按 sessionId 合并——
        // 否则父 session 与子 agent 的编辑混在一起，证据无法指向真正的出处。
        const bucketKey = session.meta.sessionId + '\0' + sourcePath;
        let bucket = sessMap.get(bucketKey);
        if (!bucket) {
          bucket = {
            sessionId: session.meta.sessionId,
            sourcePath,
            lineCounts: new Map(),
            removedLineCounts: new Map(),
            seqs: new Set(),
            edits: [],
          };
          sessMap.set(bucketKey, bucket);
        }
        for (const l of lines.added) {
          bucket.lineCounts.set(l, (bucket.lineCounts.get(l) ?? 0) + 1);
        }
        for (const l of lines.removed) {
          bucket.removedLineCounts.set(l, (bucket.removedLineCounts.get(l) ?? 0) + 1);
        }
        if (lines.added.length > 0 || lines.removed.length > 0) bucket.seqs.add(edit.seq);
        bucket.edits.push({ seq: edit.seq, ts: parseTs(edit.ts) });
      }
    }

    return { byPath, sessions: sessionMap };
  }

  /**
   * Tier-0 锚点：扫描每个 session 的 git-commit 事件，sha 前缀匹配 commits.hash。
   * 返回 commitHash -> (sessionId -> anchorTs[commit 事件时间])。
   * 同一 commit 被多 session 锚定时全部保留。
   *
   * 性能（之前是 O(sessions × events × commits) 三层循环）：
   * 按 commit.hash 前 7 位建前缀桶（git 短 hash 默认 7 位，远小于 sha 抬升碰撞）。
   * 一条 git-commit 事件只查 sha 前 7 位对应的桶——平均桶大小 = 总 commit 数 / 16⁷ ≈ 0
   * （任何现实仓库），最坏情况下退化为短 hash 同前缀的极少数 commit。整体 O(events + commits)。
   */
  private computeAnchors(
    commits: CommitInfo[],
    sessions: ParsedSession[]
  ): { byCommit: Map<string, Map<string, { ts: number; sourcePath: string }>> } {
    const byCommit = new Map<string, Map<string, { ts: number; sourcePath: string }>>();

    // 前缀桶：hash 前 7 字符 → 该前缀对应的全 hash 列表。
    // 选 7 是因为 git 短 hash 默认 7；session 里 sha 不太可能比 7 短。
    // sha 长度 < 7 的退化情形（极罕见）走兜底全扫——保正确性。
    const PREFIX_LEN = 7;
    const buckets = new Map<string, CommitInfo[]>();
    for (const c of commits) {
      const key = c.hash.slice(0, PREFIX_LEN).toLowerCase();
      const arr = buckets.get(key);
      if (arr) arr.push(c);
      else buckets.set(key, [c]);
    }

    for (const session of sessions) {
      for (const ev of session.events) {
        if (ev.kind !== 'git-commit') continue;
        const sha = ev.sha;
        if (!sha) continue;

        // 候选 commit 集：
        //   sha 长度 ≥ 7 → 取 sha 前 7 位的桶（大概率桶里只有 1 个候选）。
        //   sha 长度 < 7 → 退化全扫（极罕见——transcript 一般给 7+ 位）。
        const candidates =
          sha.length >= PREFIX_LEN
            ? (buckets.get(sha.slice(0, PREFIX_LEN).toLowerCase()) ?? [])
            : commits;

        for (const commit of candidates) {
          if (!prefixMatch(commit.hash, sha)) continue;
          let m = byCommit.get(commit.hash);
          if (!m) {
            m = new Map();
            byCommit.set(commit.hash, m);
          }
          const ts = parseTs(ev.ts);
          const existing = m.get(session.meta.sessionId);
          // 同 session 多个 commit 事件命中同一 commit：取最早的事件时间。
          if (existing === undefined || ts < existing.ts) {
            m.set(session.meta.sessionId, { ts, sourcePath: session.meta.sourcePath });
          }
        }
      }
    }
    return { byCommit };
  }

  /**
   * 对每个相对路径，求"上一个触碰该文件的 commit 时间"（按 committerDate 升序）。
   * 返回 path -> (commitHash -> prevCommitTime|null)。
   */
  private buildPrevCommitTimeIndex(
    commits: CommitInfo[]
  ): Map<string, Map<string, number | null>> {
    const result = new Map<string, Map<string, number | null>>();
    // 按 committerDate 升序遍历，记录每个 path 上一次出现的时间。
    const sorted = [...commits].sort(
      (a, b) => parseTs(a.committerDate) - parseTs(b.committerDate)
    );
    const lastTimeByPath = new Map<string, number>();
    for (const commit of sorted) {
      const ct = parseTs(commit.committerDate);
      for (const cf of commit.files) {
        let m = result.get(cf.path);
        if (!m) {
          m = new Map();
          result.set(cf.path, m);
        }
        m.set(commit.hash, lastTimeByPath.get(cf.path) ?? null);
        lastTimeByPath.set(cf.path, ct);
      }
    }
    return result;
  }

  /**
   * timeScore：窗口 (prevCommitTime, commitTime + 2min] 内为 1，
   * 窗口外线性衰减（每超出 1h 扣 1/24，地板 0）。
   * 对 authorDate / committerDate 各算一次取高者。
   */
  private timeScoreFor(
    editTs: number,
    prevCommitTime: number | null,
    commitTimes: { author: number; committer: number }
  ): number {
    if (editTs === 0) return 0;
    const a = this.timeScoreOne(editTs, prevCommitTime, commitTimes.author);
    const c = this.timeScoreOne(editTs, prevCommitTime, commitTimes.committer);
    return Math.max(a, c);
  }

  private timeScoreOne(editTs: number, prevCommitTime: number | null, commitTime: number): number {
    if (commitTime === 0) return 0;
    const upper = commitTime + CLOCK_TOLERANCE_MS;
    const lower = prevCommitTime; // null 表示无下界（文件首次出现）

    const inLower = lower === null ? true : editTs > lower;
    const inUpper = editTs <= upper;
    if (inLower && inUpper) return 1;

    // 窗口外：求到最近窗口边界的距离，线性衰减。
    let overshoot: number;
    if (!inUpper) {
      overshoot = editTs - upper; // 编辑晚于 commit + 容差
    } else {
      // editTs <= lower（早于上一个 commit），距离 lower 的下边界。
      overshoot = (lower as number) - editTs;
    }
    const score = 1 - overshoot * DECAY_PER_MS;
    return score > 0 ? score : 0;
  }

  /** 收集一个 CommitFile 全部 hunk 的 addedLines/removedLines（未归一化）。 */
  private collectContentLines(cf: CommitFile): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    for (const h of cf.hunks) {
      for (const l of h.addedLines) added.push(l);
      for (const l of h.removedLines) removed.push(l);
    }
    return { added: normalizeLines(added), removed: normalizeLines(removed) };
  }
}

function firstLine(message: string): string {
  const idx = message.indexOf('\n');
  return idx === -1 ? message : message.slice(0, idx);
}

/** 默认导出实例工厂，方便消费方直接使用。 */
export function createMatchEngine(): MatchEngine {
  return new ContentTimeMatchEngine();
}

/** Named alias expected by cli.ts dynamic import (`mod.engine`). */
export const engine: MatchEngine = new ContentTimeMatchEngine();
