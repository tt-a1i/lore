/**
 * git 侧数据模型——匹配引擎消费的另一半输入。
 * 实现要求：直接 spawn git 命令（log/show），零原生依赖；
 * 大仓库（700+ commits）一次扫描应在秒级完成，注意批量化（单次 git log 拿全量，避免 per-commit 进程）。
 */

export interface CommitInfo {
  hash: string;
  authorDate: string; // ISO8601
  committerDate: string; // ISO8601
  message: string;
  isMerge: boolean;
  /** Co-Authored-By 等 trailer，小写 key。 */
  trailers: Record<string, string[]>;
  files: CommitFile[];
}

export interface CommitFile {
  /** repo 相对路径。rename 时为新路径。 */
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  hunks: Hunk[];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 不带 +/- 前缀的原始行内容。 */
  addedLines: string[];
  removedLines: string[];
}

export interface GitHistoryReader {
  /** 按时间升序返回 first-parent 链上的 commit（含 hunks）。merge commit 标记但不展开。 */
  readHistory(repoPath: string, opts?: { since?: string; maxCommits?: number }): Promise<CommitInfo[]>;
  /** path 归一化：把事件里的绝对路径转成 repo 相对路径；不在 repo 内返回 null。 */
  toRepoRelative(repoPath: string, absPath: string): string | null;
}
