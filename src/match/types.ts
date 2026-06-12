/**
 * 匹配引擎契约——整个项目的地基。
 *
 * 问题定义：给定一个仓库的 commit 流（含 hunk）和若干 session 的事件流，
 * 输出 (commit, file) ← (session, edits) 的归因关系及置信度。
 *
 * 双信号：
 * 1. 内容信号（主，权重 0.8）：hunk 的 addedLines 与 session 中该文件
 *    FileEditEvent.newText 的归一化行重叠率（行 trim 后做多重集交集）。
 *    write 类事件与整文件内容比对。多个 edit 事件可联合贡献一个 hunk。
 * 2. 时间信号（辅，权重 0.2）：编辑时间必须落在该文件的归因窗口内——
 *    (上一个触碰该文件的 commit 时间, 本 commit 时间 + 2min 时钟容差]。
 *    窗口外的内容匹配降权而非淘汰（应对 stash/延迟提交）。
 *
 * 已知困难（验证阶段重点观察）：squash 提交、agent 多轮改写同一行（取最终态）、
 * 人工编辑混入、rebase 后 committer time 漂移。
 */

export interface MatchCandidate {
  commitHash: string;
  /** repo 相对路径。 */
  filePath: string;
  sessionId: string;
  /** 贡献了内容的 FileEditEvent.seq 列表。 */
  editSeqs: number[];
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
