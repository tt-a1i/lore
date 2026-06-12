/**
 * Subprocess integration tests for `lore brief` and `lore guard --hook`.
 *
 * Exercises the full CLI wiring (commander → cmdBrief/cmdGuard → brief modules)
 * via `tsx src/cli.ts`. These assert the contract that hooks depend on:
 *   - brief --format hook-json emits a valid SessionStart envelope
 *   - guard --hook reads a PreToolUse stdin JSON and emits a PreToolUse envelope
 *     with NO permissionDecision (never blocks)
 *   - guard is SILENT (empty stdout, exit 0) on: non-JSON stdin, no file_path,
 *     missing .lore. (The "never break the user's session" contract.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';

const CWD = '/Users/tushaokun/code/deltaDb';
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Run `tsx src/cli.ts <args>` feeding `stdin`, capturing stdout + exit code. */
function runCli(args: string[], stdin = ''): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile('npx', ['tsx', 'src/cli.ts', ...args], { cwd: CWD, encoding: 'utf8' },
      (err, stdout) => {
        const code = err && typeof (err as { code?: number }).code === 'number'
          ? (err as { code: number }).code : 0;
        resolve({ stdout: stdout ?? '', code });
      });
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function makeRepoWithNotes(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-bg-cli-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.lore'), { recursive: true });
  writeFileSync(join(dir, '.lore', 'report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), matches: [] }), 'utf8');
  writeFileSync(join(dir, '.lore', 'notes.json'), JSON.stringify({
    schemaVersion: 1, distilledSessions: {},
    notes: [
      { id: 'n1', kind: 'constraint', title: 'HTTP only via client', body: 'b',
        files: ['src/http/client.ts'], anchors: [], sessionId: '', validAt: '2026-06-12T00:00:00Z',
        invalidAt: null, supersededBy: null, source: 'agent' },
    ],
  }), 'utf8');
  return dir;
}

describe('lore brief (subprocess)', () => {
  it('emits a valid SessionStart envelope with --format hook-json', async () => {
    const repo = makeRepoWithNotes();
    const { stdout, code } = await runCli(['brief', '--repo', repo, '--format', 'hook-json']);
    expect(code).toBe(0);
    const obj = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(obj.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(obj.hookSpecificOutput.additionalContext).toContain('HTTP only via client');
  }, 30_000);

  it('text format prints the brief to stdout', async () => {
    const repo = makeRepoWithNotes();
    const { stdout } = await runCli(['brief', '--repo', repo]);
    expect(stdout).toContain('lore memory:');
    expect(stdout).toContain('HTTP only via client');
  }, 30_000);
});

describe('lore guard --hook (subprocess)', () => {
  it('emits a PreToolUse envelope (no permissionDecision) for a file with a constraint', async () => {
    const repo = makeRepoWithNotes();
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: { file_path: 'src/http/client.ts' }, cwd: repo,
    });
    const { stdout, code } = await runCli(['guard', '--hook', '--repo', repo], stdin);
    expect(code).toBe(0);
    const obj = JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(obj.hookSpecificOutput['hookEventName']).toBe('PreToolUse');
    expect(obj.hookSpecificOutput['additionalContext']).toContain('HTTP only via client');
    // NEVER blocks:
    expect('permissionDecision' in obj.hookSpecificOutput).toBe(false);
  }, 30_000);

  it('is SILENT (empty stdout, exit 0) on non-JSON stdin', async () => {
    const repo = makeRepoWithNotes();
    const { stdout, code } = await runCli(['guard', '--hook', '--repo', repo], 'this is not json');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  }, 30_000);

  it('is SILENT when tool_input has no file_path', async () => {
    const repo = makeRepoWithNotes();
    const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const { stdout, code } = await runCli(['guard', '--hook', '--repo', repo], stdin);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  }, 30_000);

  it('is SILENT when .lore is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lore-bg-empty-'));
    tmpDirs.push(empty);
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: { file_path: join(empty, 'x.ts') }, cwd: empty,
    });
    const { stdout, code } = await runCli(['guard', '--hook', '--repo', empty], stdin);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  }, 30_000);

  it('is SILENT when the edited file has no relevant constraint', async () => {
    const repo = makeRepoWithNotes();
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: { file_path: 'src/unrelated/elsewhere.ts' }, cwd: repo,
    });
    const { stdout, code } = await runCli(['guard', '--hook', '--repo', repo], stdin);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  }, 30_000);
});
