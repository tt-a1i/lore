/**
 * M3 语义蒸馏层 —— 把 session 蒸馏成 Decision / Constraint / RejectedApproach。
 *
 * 原则：
 * - 每 session 一次 LLM 调用（成本可控），输入是"会话摘要包"而非原始 transcript。
 * - 蒸馏器是适配器：默认后端 claude-cli（shell 出 `claude -p`，用户装了
 *   Claude Code 就能用，零 API key 配置）；接口留给未来的 API 后端。
 * - 双时间模型（借鉴 Graphiti）：决策被推翻不删除，打 invalidAt + supersededBy。
 *   新蒸馏会拿到同文件域的现存有效 notes，可声明 supersedes。
 * - notes.json 是事实源（.lore/notes.json），图谱从它重建语义层节点。
 */

export type NoteKind = 'decision' | 'constraint' | 'rejected-approach';

export interface DistilledNote {
  /** `${sessionId}#${n}` —— 稳定 id，supersedes 引用它。 */
  id: string;
  kind: NoteKind;
  /** 一句话标题（≤80 字符）。 */
  title: string;
  /** 2-4 句正文：内容 + 为什么。rejected-approach 必须含否决原因。 */
  body: string;
  /** 涉及的 repo 相对路径（可空）。 */
  files: string[];
  /** 支撑锚点：回到对话原文的地址。 */
  anchors: { sessionId: string; seq: number }[];
  sessionId: string;
  /** 生效时间（session 时间）。 */
  validAt: string;
  /** 被推翻时间；null = 仍有效。 */
  invalidAt: string | null;
  /** 推翻它的 note id。 */
  supersededBy: string | null;
  /**
   * 笔记来源（信任分级的依据之一）：
   * 'distilled' = LLM 离线蒸馏（默认；旧数据缺省此字段视为 distilled）
   * 'agent'     = agent 在任务中通过 lore_note / lore note 主动记录
   * 'human'     = 人工录入
   */
  source?: 'distilled' | 'agent' | 'human';
}

/** 喂给蒸馏器的会话摘要包（调用方负责构建，控制 token 量）。 */
export interface SessionDigest {
  sessionId: string;
  agent: string;
  startedAt: string;
  /** 用户消息全文（截断到单条 ≤1000 字符）+ assistant 关键消息（截断）。带 seq。 */
  messages: { seq: number; role: 'user' | 'assistant'; text: string }[];
  /** 该 session 编辑过的 repo 相对路径。 */
  editedFiles: string[];
  /** 归因到的 commit（hash + subject）。 */
  commits: { hash: string; subject: string }[];
}

export interface DistillInput {
  digest: SessionDigest;
  /** 同文件域现存有效 notes（供判断 supersede）。 */
  existingNotes: DistilledNote[];
  /**
   * 目标仓库根（可选）。提供时，claude-cli 后端会把蒸馏调用返回 envelope 里的
   * session_id 追加记录到 <repoPath>/.lore/distill-sessions.json，便于审计/清理
   * 蒸馏自身产生的 session。缺省则不记录（不影响蒸馏结果）。
   */
  repoPath?: string;
}

/** 蒸馏后端适配器。 */
export interface Distiller {
  readonly name: string;
  /** 后端是否可用（如 claude CLI 是否在 PATH）。 */
  available(): Promise<boolean>;
  /**
   * 返回新 notes（id 由调用方分配后写入）+ 被推翻的现存 note id。
   * 实现必须容错：LLM 输出不合法时返回空数组并附原因，绝不抛异常中断批量蒸馏。
   */
  distill(input: DistillInput): Promise<{
    notes: Omit<DistilledNote, 'id' | 'sessionId' | 'validAt' | 'invalidAt' | 'supersededBy'>[];
    supersededIds: string[];
    error?: string;
  }>;
}

/** notes.json 的形态。 */
export interface NotesFile {
  schemaVersion: number;
  /** sessionId → 摘要包内容 hash，用于跳过已蒸馏且未变化的 session。 */
  distilledSessions: Record<string, string>;
  notes: DistilledNote[];
  /** 最近一次蒸馏运行时间（agent 笔记写入不更新此字段）。 */
  distilledAt?: string;
}

/**
 * NotesStore —— notes.json 的唯一读写入口（蒸馏编排、lore note CLI、
 * MCP lore_note 共用；杜绝三处各写各的格式漂移）。
 *
 * 写路径语义：
 * - appendNote：分配 id（agent 来源用 `agent-<base36 时间戳>-<4位随机>`），
 *   validAt=now，source 必填；可选 supersedes（旧 note 打 invalidAt+supersededBy）。
 * - 防重：同 source='agent' 且 title 完全相同且 invalidAt===null 的既存笔记 →
 *   更新其 body/files（保 id）而非追加，返回 { updated: true }。
 * - 并发安全：写前重读文件做合并（last-writer-wins 按 note id），原子写（tmp+rename）。
 */
export interface NotesStore {
  load(repoPath: string): Promise<NotesFile>;
  appendNote(
    repoPath: string,
    note: {
      kind: NoteKind;
      title: string;
      body: string;
      files?: string[];
      source: 'agent' | 'human';
      supersedes?: string;
    },
  ): Promise<{ id: string; updated: boolean; superseded: string | null }>;
}
