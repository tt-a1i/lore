/**
 * Push-based memory injection — shared types for `lore brief` and `lore guard`.
 *
 * 背景：北极星 eval 发现拉取式记忆（MCP 工具 / CLAUDE.md 指令）对弱/headless agent
 * 失效（haiku 0/6 主动调用 MCP）。brief/guard 把项目记忆「推」进 agent 上下文：
 *   - brief：SessionStart 注入紧凑项目简报（新鲜度 + 活跃 notes 分组 + 使用指引）。
 *   - guard：PreToolUse 注入「即将编辑的文件」相关约束（绝不 block 工具调用）。
 *
 * 性能契约：两者都只直接读 .lore/notes.json 与 .lore/report.json，禁止加载匹配
 * 引擎或解析 transcript。预算 <150ms。
 */

/** brief / guard 读到的活跃 note 的最小形态（从 notes.json 直接解析，不经引擎）。 */
export interface BriefNote {
  kind: string;
  title: string;
  body: string;
  files: string[];
  source: string;
  /** null = 仍有效；非 null = 已被推翻（brief/guard 只看有效的）。 */
  invalidAt: string | null;
}

/** brief 渲染所需的全部输入（纯函数边界——便于测试，无 I/O）。 */
export interface BriefInput {
  repoPath: string;
  /** report.json 的 generatedAt；null = 无 report（未 scan）。 */
  generatedAt: string | null;
  /** HEAD commit 时间（git）；null = 取不到（不影响新鲜度判定降级）。 */
  headTime: string | null;
  /** 当前时间（ms）——注入以便测试。 */
  nowMs: number;
  /** 活跃 notes（已过滤 invalidAt===null）。 */
  notes: BriefNote[];
  /** 是否检测到 lore MCP（决定使用指引提工具名还是 npx 命令）。 */
  hasMcp: boolean;
  /** --file 过滤：仅渲染与该文件相关的约束（repo 相对或绝对路径的 basename 匹配）。 */
  file?: string;
  /** 每个 kind 最多列出的条数（默认 6）。 */
  maxPerKind?: number;
  /**
   * 抑制新鲜度行（guard / PreToolUse 用）——钩子注入只要约束本身，越短越好，
   * 不重复 SessionStart 已给过的新鲜度信息。默认 false（brief 会渲新鲜度行）。
   */
  suppressFreshness?: boolean;
}
