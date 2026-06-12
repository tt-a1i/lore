/**
 * `lore ask <question>` —— 对项目记忆的检索。
 *
 * M3 实现为确定性混合检索（零 LLM、零 embedding 依赖）：
 *   关键词切分（中英文、驼峰/下划线拆词）→ 对 notes（title/body/files 加权）
 *   与 user-message 索引做 tf 评分 → 双时间过滤（默认只看有效 notes，
 *   --include-superseded 看全史）→ 返回 top-k 带锚点。
 * 未来：embedding 后端走同一接口（AskEngine 不变，换 retriever）。
 *
 * MCP server 暴露同一引擎：lore_ask / lore_why / lore_history 三个工具，
 * 返回紧凑、带锚点、token 友好的文本（给 agent 消费，不是给人看的长文）。
 */

import type { DistilledNote } from '../distill/types.js';

export interface AskHit {
  score: number;
  note: DistilledNote;
}

export interface AskResult {
  question: string;
  hits: AskHit[];
  /** notes 之外补充的原始消息命中（notes 覆盖不到时的兜底）。 */
  messageHits: { sessionId: string; seq: number; text: string; score: number }[];
}

export interface AskEngine {
  ask(repoPath: string, question: string, opts?: { topK?: number; includeSuperseded?: boolean }): Promise<AskResult>;
}
