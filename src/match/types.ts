/**
 * 匹配引擎契约——整个项目的地基。
 *
 * 问题定义：给定一个仓库的 commit 流（含 hunk）和若干 session 的事件流，
 * 输出 (commit, file) ← (session, edits) 的归因关系及置信度。
 *
 三级匹配体系：
 *
 * Tier 0 —— 精确锚定（confidence = 1.0）：
 *   session 的 GitCommitEvent.sha（短 hash）对 commits 列表做前缀匹配。
 *   命中即把该 commit 全部文件归因到该 session（editSeqs 取该 commit 时间前、
 *   touching 相同文件的编辑事件）。rebase/squash 改写过的 hash 会 miss，自然降级到 Tier 1。
 *
 * Tier 1 —— 内容信号（主，权重 0.8）：
 *   优先用 FileEditEvent.patch（harness 预计算的 structuredPatch）的 +行 与
 *   commit hunk 的 addedLines 做归一化行重叠（trim 后多重集交集）；
 *   无 patch 时退回 newText 行集。write 类与整文件内容比对。
 *   多个 edit 事件可联合贡献一个 hunk。空白行与单字符行不计入分子分母。
 *
 * Tier 2 —— 时间信号（辅，权重 0.2）：
 *   编辑时间落在该文件的归因窗口内——
 *   (上一个触碰该文件的 commit 时间, 本 commit 时间 + 2min 时钟容差]。
 *   窗口同时对 authorDate 和 committerDate 计算，取较优（rebase 会让两者漂移）。
 *   窗口外的内容匹配降权而非淘汰（应对 stash/延迟提交）：
 *   线性衰减，每超出窗口 1h 扣 1/24，地板 0。
 *
 * contentScore 的分母是 commit 侧归一化后的有效 addedLines 总数
 * （语义："这个 hunk 有多少出自该 session"——commit 是被归因对象）。
 *
 * 已知困难（来自 hive-private 画像，验证阶段重点观察）：
 * 超大 squash commit（最大 429 文件）、单日 107 commit 的密集提交、
 * agent 多轮改写同一行（取最终态）、人工编辑混入（userModified 标志可用）、
 * rebase 后时间漂移、trailer 覆盖率仅 4.4% 不可作为 agent 判定依据。
 */

export interface MatchCandidate {
  commitHash: string;
  /** repo 相对路径。 */
  filePath: string;
  sessionId: string;
  /** 贡献了内容的 FileEditEvent.seq 列表。 */
  editSeqs: number[];
  /** 归因路径：sha = Tier-0 精确锚定；content = Tier-1/2 信号匹配。 */
  matchedVia: 'sha' | 'content';
  /** 0-1，归一化行重叠率。 */
  contentScore: number;
  /** 0-1，时间窗符合度。 */
  timeScore: number;
  /** 0.8*content + 0.2*time。 */
  confidence: number;
  /** 人类可读的证据摘要（重叠行数、时间差等），供抽查用。 */
  evidence: string[];
}

export type ConfidenceTier = 'strong' | 'weak' | 'none';

/** strong ≥ 0.8；weak ≥ 0.5；其余丢弃。 */
export function tierOf(confidence: number): ConfidenceTier {
  if (confidence >= 0.8) return 'strong';
  if (confidence >= 0.5) return 'weak';
  return 'none';
}

export interface RepoMatchReport {
  repo: string;
  generatedAt: string;
  schemaVersion: number;
  commitsTotal: number;
  /** 至少有一个 strong 匹配的 commit 数。 */
  commitsMatchedStrong: number;
  commitsMatchedWeak: number;
  sessionsSeen: number;
  sessionsContributing: number;
  matches: MatchCandidate[];
  /** 无任何匹配的 commit（hash + 首行 message），用于分析盲区。 */
  unmatchedCommits: { hash: string; subject: string }[];
}

import type { CommitInfo } from '../git/types.js';
import type { ParsedSession } from '../schema/events.js';

export interface MatchEngine {
  match(repoPath: string, commits: CommitInfo[], sessions: ParsedSession[]): RepoMatchReport;
}
