/**
 * Claude Code hook protocol envelopes (verified against Claude Code 2.1.x).
 *
 * 注入机制实测确认（docs + 本仓库 2.1.173）：
 *   - SessionStart：stdout 纯文本即上下文，或 JSON {hookSpecificOutput:{hookEventName,
 *     additionalContext}}。我们用 JSON 形态（更稳，明确走 additionalContext）。
 *   - PreToolUse：stdout 纯文本只进 debug log，要进上下文必须用
 *     hookSpecificOutput.additionalContext。permissionDecision 省略 → 不影响放行
 *     （绝不 block）。
 *
 * 这些是纯函数（无 I/O），便于单测注入形态。
 */

/** PreToolUse / SessionStart 钩子从 stdin 收到的协议 JSON 的相关字段。 */
export interface PreToolUseHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    [k: string]: unknown;
  };
  cwd?: string;
  [k: string]: unknown;
}

/** 解析 PreToolUse stdin JSON；非 JSON / 空 → null（调用方据此静默退出）。 */
export function parseHookInput(raw: string): PreToolUseHookInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    return obj as PreToolUseHookInput;
  } catch {
    return null;
  }
}

/** 从 PreToolUse 输入里取出被编辑文件的路径（Edit/Write/MultiEdit 都用 file_path）。 */
export function extractFilePath(input: PreToolUseHookInput): string | null {
  const fp = input.tool_input?.file_path;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

/** SessionStart additionalContext 信封。 */
export function sessionStartEnvelope(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
}

/**
 * PreToolUse additionalContext 信封。
 * 不带 permissionDecision —— 永远放行，只注入上下文，绝不 block 工具调用。
 */
export function preToolUseEnvelope(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  });
}
