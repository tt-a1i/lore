/**
 * `lore why <file>:<line>` —— 从任意一行代码回到产生它的对话。
 *
 * 管线（M2，确定性、零 LLM）：
 *   git blame -L line,line --porcelain → commit hash
 *   → GraphStore.whoProducedCommit(hash)（含 squash 前的分支 commit 形态由图谱吸收）
 *   → 对 top 归因重新 parse 其 sourcePath（解析单元），取 editSeqs 中
 *     触碰该文件的编辑事件，抽取其前后最近的 user/assistant 消息摘录
 *   → 渲染：commit + 归因（置信度/证据）+ 对话摘录 + 锚点（sessionId+seq）
 *
 * blame 落在无归因的 commit 时：输出 commit 信息 + "no conversation attribution"
 * + 该文件的 EDITED session 列表（盲区也要可见）。
 * M3 在此之上加 LLM 蒸馏的"三句话回答"。
 */

import type { CommitNodeData, ProducedInfo } from '../graph/types.js';

export interface ConversationExcerpt {
  /** 锚点：sessionId + 事件 seq（lore 的永久地址）。 */
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant';
  /** ≤400 字符摘录。 */
  text: string;
  ts: string;
}

export interface WhyAttribution {
  produced: ProducedInfo;
  /** 该归因下触碰目标文件的编辑事件 seq。 */
  editSeqs: number[];
  excerpts: ConversationExcerpt[];
}

export interface WhyResult {
  file: string; // repo 相对路径
  line: number;
  /** blame 出的行内容。 */
  lineContent: string;
  commit: CommitNodeData;
  /** 按 confidence 降序；空数组 = 盲区。 */
  attributions: WhyAttribution[];
  /** 盲区时的辅助信息：编辑过该文件的 session。 */
  editedBy: { sessionId: string; agent: string; lastTs: string }[];
}

export interface WhyEngine {
  why(repoPath: string, file: string, line: number): Promise<WhyResult>;
}
