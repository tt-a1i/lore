/**
 * Unit tests for the hook-protocol envelope builders (src/brief/hook.ts).
 *
 * Verified against Claude Code 2.1.x:
 *   - SessionStart → {hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}}
 *   - PreToolUse   → {hookSpecificOutput:{hookEventName:'PreToolUse', additionalContext}}
 *     with NO permissionDecision (never blocks).
 *   - parseHookInput tolerates non-JSON / empty → null
 *   - extractFilePath pulls tool_input.file_path
 */

import { describe, it, expect } from 'vitest';
import {
  parseHookInput,
  extractFilePath,
  sessionStartEnvelope,
  preToolUseEnvelope,
} from '../../src/brief/hook.js';

describe('parseHookInput', () => {
  it('parses a valid PreToolUse JSON', () => {
    const raw = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x.ts' } });
    const out = parseHookInput(raw);
    expect(out?.tool_name).toBe('Edit');
  });

  it('returns null for non-JSON', () => {
    expect(parseHookInput('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseHookInput('')).toBeNull();
    expect(parseHookInput('   ')).toBeNull();
  });

  it('returns null for a JSON primitive (not an object)', () => {
    expect(parseHookInput('42')).toBeNull();
    expect(parseHookInput('"hello"')).toBeNull();
  });
});

describe('extractFilePath', () => {
  it('extracts file_path from tool_input', () => {
    expect(extractFilePath({ tool_input: { file_path: '/a/b.ts' } })).toBe('/a/b.ts');
  });

  it('returns null when file_path missing', () => {
    expect(extractFilePath({ tool_input: { command: 'ls' } })).toBeNull();
    expect(extractFilePath({})).toBeNull();
    expect(extractFilePath({ tool_input: {} })).toBeNull();
  });
});

describe('sessionStartEnvelope', () => {
  it('wraps text in a SessionStart additionalContext envelope', () => {
    const out = JSON.parse(sessionStartEnvelope('hello memory')) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toBe('hello memory');
  });
});

describe('preToolUseEnvelope', () => {
  it('wraps text in a PreToolUse additionalContext envelope', () => {
    const out = JSON.parse(preToolUseEnvelope('a constraint')) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(out.hookSpecificOutput['hookEventName']).toBe('PreToolUse');
    expect(out.hookSpecificOutput['additionalContext']).toBe('a constraint');
  });

  it('does NOT include permissionDecision (never blocks the tool call)', () => {
    const out = JSON.parse(preToolUseEnvelope('x')) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect('permissionDecision' in out.hookSpecificOutput).toBe(false);
  });
});
