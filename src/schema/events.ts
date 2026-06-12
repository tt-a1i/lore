/**
 * lore 统一事件 schema —— 所有 agent transcript 归一到这一层。
 *
 * 设计约束：
 * - 各家 transcript 格式随时会变，parser 输出必须带 schemaVersion，
 *   消费方（匹配引擎/图谱）只依赖本文件，不接触原始格式。
 * - 事件是不可变事实流：parser 不做任何"理解"，只做无损的结构归一。
 */

export const SCHEMA_VERSION = 1;

export type AgentKind = 'claude-code' | 'codex' | 'opencode';

/** 一个 session 的元数据（一份 transcript 文件 ≈ 一个 session）。 */
export interface SessionMeta {
  schemaVersion: number;
  agent: AgentKind;
  sessionId: string;
  /** session 运行时的工作目录（用于把绝对路径归一成 repo 相对路径）。 */
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string; // ISO8601
  endedAt: string | null;
  /** 原始 transcript 文件路径，所有事件可回溯到源。 */
  sourcePath: string;
  agentVersion: string | null;
}

interface BaseEvent {
  sessionId: string;
  ts: string; // ISO8601
  /** session 内全序，用作稳定锚点（sessionId + seq 即事件的永久地址）。 */
  seq: number;
}

/** 用户消息——"意图"的原文。 */
export interface UserMessageEvent extends BaseEvent {
  kind: 'user-message';
  text: string;
}

/** assistant 的文本输出（不含工具调用）。 */
export interface AssistantMessageEvent extends BaseEvent {
  kind: 'assistant-message';
  text: string;
}

/**
 * diff hunk，行内容保留 +/-/空格 前缀（与 Claude Code toolUseResult.structuredPatch 同构）。
 */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** 文件编辑——匹配引擎的核心输入。 */
export interface FileEditEvent extends BaseEvent {
  kind: 'file-edit';
  toolUseId: string | null;
  op: 'edit' | 'write' | 'multi-edit' | 'notebook-edit';
  /** transcript 记录的原始路径（通常是绝对路径，归一化交给消费方）。 */
  filePath: string;
  /** edit 的被替换文本；write（整文件覆盖）为 null。 */
  oldText: string | null;
  newText: string;
  /**
   * harness 预计算的 diff（Claude Code: toolUseResult.structuredPatch）。
   * 有它时匹配引擎优先用它，比从 old/new text 重建更可靠。
   */
  patch: PatchHunk[] | null;
  /** harness 标记的"用户在工具调用前手改过文件"（Claude Code: userModified）。 */
  userModified: boolean | null;
  /** 对应 tool_result 是否成功；未知为 null。失败的编辑不参与匹配。 */
  succeeded: boolean | null;
}

/**
 * session 内发生的 git commit——匹配引擎的 Tier-0 精确锚点。
 * 来源：Claude Code Bash toolUseResult.gitOperation.commit.sha（短 hash）。
 * 注意：rebase/squash 会改写 hash，消费方需做前缀匹配 + 找不到时降级到内容匹配。
 */
export interface GitCommitEvent extends BaseEvent {
  kind: 'git-commit';
  /** 可能是短 hash（7 位）。 */
  sha: string;
}

/** shell 执行——commit 动作本身、测试运行等都在这里。 */
export interface ShellExecEvent extends BaseEvent {
  kind: 'shell-exec';
  command: string;
  description: string | null;
}

export type LoreEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | FileEditEvent
  | GitCommitEvent
  | ShellExecEvent;

export interface ParsedSession {
  meta: SessionMeta;
  events: LoreEvent[];
}

/** 每种 agent 一个实现。parser 必须容错：跳过无法识别的行并计数，绝不抛弃整个文件。 */
export interface TranscriptParser {
  agent: AgentKind;
  /** 找出与某个仓库工作目录相关的所有 transcript 文件。 */
  discover(repoPath: string): Promise<string[]>;
  parse(transcriptPath: string): Promise<ParseResult>;
}

export interface ParseResult {
  session: ParsedSession;
  /** 跳过的行数与原因采样，用于监控格式漂移。 */
  skipped: { count: number; samples: string[] };
}
