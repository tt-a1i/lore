/**
 * Tests for the Codex CLI transcript parser.
 *
 * Fixtures are hand-crafted JSONL files in fixtures/codex/ (generated to
 * guarantee valid JSON escaping of multi-line patch envelopes).
 * No real ~/.codex sessions are read.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { codexParser } from '../../src/parsers/codex.js';
import type {
  UserMessageEvent,
  AssistantMessageEvent,
  FileEditEvent,
  GitCommitEvent,
  ShellExecEvent,
  LoreEvent,
} from '../../src/schema/events.js';

const FIXTURES = path.resolve(process.cwd(), 'fixtures/codex');

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

function eventsOfKind<K extends LoreEvent['kind']>(
  events: LoreEvent[],
  kind: K,
): Extract<LoreEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<LoreEvent, { kind: K }> => e.kind === kind);
}

// ---------------------------------------------------------------------------
// 1. Basic conversation: user/agent messages, dedup of streamed twin
// ---------------------------------------------------------------------------

describe('basic conversation', () => {
  it('extracts user message from event_msg/user_message (not response_item)', async () => {
    const { session, skipped } = await codexParser.parse(fixture('basic-conversation.jsonl'));
    expect(skipped.count).toBe(0);

    const users = eventsOfKind(session.events, 'user-message');
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe('Please refactor the login function.');
  });

  it('extracts assistant text from agent_message and de-dups the response_item twin', async () => {
    const { session } = await codexParser.parse(fixture('basic-conversation.jsonl'));
    const assistants = eventsOfKind(session.events, 'assistant-message');
    // Only ONE assistant event despite the response_item/message copy.
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe("I'll help you refactor the login function now.");
  });

  it('captures session metadata (cwd, agent, version, id)', async () => {
    const { session } = await codexParser.parse(fixture('basic-conversation.jsonl'));
    expect(session.meta.agent).toBe('codex');
    expect(session.meta.cwd).toBe('/Users/x/code/myproject');
    expect(session.meta.agentVersion).toBe('0.139.0');
    expect(session.meta.sessionId).toBe('019eb03e-2039-7991-9cb5-e6cc806b0bc9');
    expect(session.meta.gitBranch).toBeNull();
    expect(session.meta.startedAt).toBe('2026-06-10T06:35:22.201Z');
  });

  it('assigns a stable monotonic seq', async () => {
    const { session } = await codexParser.parse(fixture('basic-conversation.jsonl'));
    const seqs = session.events.map((e) => e.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

// ---------------------------------------------------------------------------
// 2. File edits via patch_apply_end (PRIMARY path)
// ---------------------------------------------------------------------------

describe('patch_apply_end file edits', () => {
  it('emits one file-edit per changed file with no double-emit from custom_tool_call', async () => {
    const { session } = await codexParser.parse(fixture('patch-apply.jsonl'));
    const edits = eventsOfKind(session.events, 'file-edit');
    // 3 changes (add/update/delete). custom_tool_call shares the call_id so it
    // must NOT double-emit.
    expect(edits).toHaveLength(3);
  });

  it('resolves relative add path against cwd and carries full content', async () => {
    const { session } = await codexParser.parse(fixture('patch-apply.jsonl'));
    const edits = eventsOfKind(session.events, 'file-edit');
    const add = edits.find((e) => e.filePath.endsWith('docs/new.md'))!;
    expect(add.op).toBe('write');
    expect(add.filePath).toBe('/Users/x/code/myproject/docs/new.md');
    expect(add.newText).toBe('line1\nline2\n');
    expect(add.toolUseId).toBe('call_PATCH1');
    expect(add.succeeded).toBe(true);
  });

  it('parses unified_diff for an update into patch hunks and newText', async () => {
    const { session } = await codexParser.parse(fixture('patch-apply.jsonl'));
    const edits = eventsOfKind(session.events, 'file-edit');
    const upd = edits.find((e) => e.filePath.endsWith('index.html'))!;
    expect(upd.op).toBe('edit');
    expect(upd.patch).not.toBeNull();
    expect(upd.patch!).toHaveLength(1);
    expect(upd.patch![0]!.oldStart).toBe(191);
    expect(upd.patch![0]!.newStart).toBe(191);
    // newText excludes removed lines, includes context + added lines.
    expect(upd.newText).toContain('new line');
    expect(upd.newText).not.toContain('old line');
  });

  it('treats a delete as a write with empty newText', async () => {
    const { session } = await codexParser.parse(fixture('patch-apply.jsonl'));
    const edits = eventsOfKind(session.events, 'file-edit');
    const del = edits.find((e) => e.filePath.endsWith('old.md'))!;
    expect(del.op).toBe('write');
    expect(del.newText).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. apply_patch envelope fallback (SECONDARY path, no patch_apply_end)
// ---------------------------------------------------------------------------

describe('apply_patch envelope fallback', () => {
  it('emits file-edit from custom_tool_call when patch_apply_end is absent', async () => {
    const { session } = await codexParser.parse(fixture('apply-patch-fallback.jsonl'));
    const edits = eventsOfKind(session.events, 'file-edit');
    expect(edits).toHaveLength(1);
    const e = edits[0]!;
    expect(e.op).toBe('write');
    expect(e.filePath).toBe('/Users/x/code/myproject/src/util.ts');
    expect(e.newText).toBe('export const x = 1;\nexport const y = 2;');
    expect(e.toolUseId).toBe('call_FB1');
  });

  it('does not turn a failed patch_apply_end into a succeeded fallback edit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-codex-failed-patch-'));
    try {
      const transcript = path.join(dir, 'failed.jsonl');
      const patch = [
        '*** Begin Patch',
        '*** Add File: src/failed.ts',
        '+export const shouldNotExist = true;',
        '*** End Patch',
      ].join('\n');
      const lines = [
        {
          timestamp: '2026-06-10T06:35:22.201Z',
          type: 'session_meta',
          payload: { id: 'sess-failed-patch', cwd: '/Users/x/code/myproject', cli_version: '0.139.0' },
        },
        {
          timestamp: '2026-06-10T06:35:23.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'apply_patch',
            call_id: 'call_FAILED',
            input: patch,
          },
        },
        {
          timestamp: '2026-06-10T06:35:24.000Z',
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'call_FAILED',
            success: false,
            changes: {
              'src/failed.ts': { type: 'add', content: 'export const shouldNotExist = true;\n' },
            },
          },
        },
      ];
      fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

      const { session } = await codexParser.parse(transcript);
      expect(eventsOfKind(session.events, 'file-edit')).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Shell exec + git commit SHA extraction
// ---------------------------------------------------------------------------

describe('shell exec and git commit', () => {
  it('emits shell-exec for each exec_command with the parsed cmd', async () => {
    const { session } = await codexParser.parse(fixture('shell-and-commit.jsonl'));
    const shells = eventsOfKind(session.events, 'shell-exec');
    expect(shells).toHaveLength(2);
    expect(shells.map((s) => s.command)).toEqual([
      'ls -la',
      'git add -A && git commit -m "add feature"',
    ]);
    expect(shells[0]!.description).toBe('/Users/x/code/myproject'); // workdir
  });

  it('extracts the commit SHA only from git-commit output', async () => {
    const { session } = await codexParser.parse(fixture('shell-and-commit.jsonl'));
    const commits = eventsOfKind(session.events, 'git-commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe('1a2b3c4');
  });

  it('ignores non-exec_command function calls (update_plan)', async () => {
    const { session } = await codexParser.parse(fixture('shell-and-commit.jsonl'));
    const shells = eventsOfKind(session.events, 'shell-exec');
    expect(shells.every((s) => s.command !== '')).toBe(true);
  });

  it('extracts SHA from a detached-HEAD style status line', async () => {
    const { session } = await codexParser.parse(fixture('detached-commit.jsonl'));
    const commits = eventsOfKind(session.events, 'git-commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe('deadbee');
  });
});

// ---------------------------------------------------------------------------
// 5. Fault tolerance: bad lines counted, valid lines still parsed
// ---------------------------------------------------------------------------

describe('fault tolerance', () => {
  it('skips malformed lines, counts them, and keeps parsing valid ones', async () => {
    const { session, skipped } = await codexParser.parse(fixture('bad-lines.jsonl'));
    // "this is not json", "42" (not object), unknown type, exec_command with
    // invalid arguments JSON, and event_msg without payload all get skipped.
    expect(skipped.count).toBeGreaterThanOrEqual(3);
    expect(skipped.samples.length).toBeGreaterThan(0);

    const users = eventsOfKind(session.events, 'user-message');
    const assistants = eventsOfKind(session.events, 'assistant-message');
    expect(users.map((u) => u.text)).toContain('valid after bad line');
    expect(assistants.map((a) => a.text)).toContain('still parsing fine');
  });

  it('never throws on a bad file', async () => {
    await expect(codexParser.parse(fixture('bad-lines.jsonl'))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Multi session_meta (compaction): cwd from first occurrence
// ---------------------------------------------------------------------------

describe('multi session_meta', () => {
  it('takes cwd from the FIRST session_meta despite later differing values', async () => {
    const { session } = await codexParser.parse(fixture('multi-meta.jsonl'));
    expect(session.meta.cwd).toBe('/Users/x/code/myproject');
  });

  it('keeps parsing events across a compacted boundary', async () => {
    const { session } = await codexParser.parse(fixture('multi-meta.jsonl'));
    const users = eventsOfKind(session.events, 'user-message');
    expect(users.map((u) => u.text)).toEqual(['first turn', 'second turn']);
  });
});

// ---------------------------------------------------------------------------
// 7. discover() — fake ~/.codex/sessions structure in a temp HOME
// ---------------------------------------------------------------------------

describe('discover()', () => {
  let fakeHome: string;
  let savedHome: string | undefined;

  const REPO = '/Users/x/code/myproject';

  function metaLine(cwd: string): string {
    return JSON.stringify({
      timestamp: '2026-06-10T06:35:22.201Z',
      type: 'session_meta',
      payload: { id: 'id-' + cwd.length, cwd, cli_version: '0.139.0' },
    }) + '\n';
  }

  beforeAll(async () => {
    fakeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lore-codex-test-'));
    const dayDir = path.join(fakeHome, '.codex', 'sessions', '2026', '06', '10');
    await fs.promises.mkdir(dayDir, { recursive: true });

    // 1) session whose cwd == repo
    await fs.promises.writeFile(
      path.join(dayDir, 'rollout-2026-06-10T06-35-22-aaaa.jsonl'),
      metaLine(REPO),
    );
    // 2) session whose cwd is a subdirectory of repo (nested package)
    await fs.promises.writeFile(
      path.join(dayDir, 'rollout-2026-06-10T07-00-00-bbbb.jsonl'),
      metaLine(REPO + '/packages/sub'),
    );
    // 3) session for an unrelated repo
    await fs.promises.writeFile(
      path.join(dayDir, 'rollout-2026-06-10T08-00-00-cccc.jsonl'),
      metaLine('/Users/x/code/other-project'),
    );
    // 4) a non-rollout file in the same dir — must be ignored
    await fs.promises.writeFile(path.join(dayDir, 'notes.txt'), 'ignore me');

    savedHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
  });

  afterAll(async () => {
    process.env['HOME'] = savedHome;
    await fs.promises.rm(fakeHome, { recursive: true, force: true });
  });

  it('non-broad: returns sessions whose cwd is the repo or a subdir', async () => {
    const files = await codexParser.discover(REPO);
    expect(files.some((f) => f.endsWith('aaaa.jsonl'))).toBe(true);
    expect(files.some((f) => f.endsWith('bbbb.jsonl'))).toBe(true);
    expect(files.some((f) => f.endsWith('cccc.jsonl'))).toBe(false);
    expect(files).toHaveLength(2);
  });

  it('non-broad: only collects rollout-*.jsonl files', async () => {
    const files = await codexParser.discover(REPO);
    expect(files.every((f) => path.basename(f).startsWith('rollout-'))).toBe(true);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('broad: returns all rollout files regardless of cwd', async () => {
    const files = await codexParser.discover(REPO, { broad: true });
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith('cccc.jsonl'))).toBe(true);
  });

  it('returns [] when no ~/.codex/sessions exists', async () => {
    process.env['HOME'] = path.join(fakeHome, 'nonexistent');
    const files = await codexParser.discover(REPO);
    expect(files).toEqual([]);
    process.env['HOME'] = fakeHome;
  });
});

// ---------------------------------------------------------------------------
// 8. Schema version and agent kind
// ---------------------------------------------------------------------------

describe('schema version and agent kind', () => {
  it('stamps schemaVersion and agent on the session meta', async () => {
    const { session } = await codexParser.parse(fixture('basic-conversation.jsonl'));
    expect(session.meta.schemaVersion).toBe(1);
    expect(session.meta.agent).toBe('codex');
    expect(session.meta.sourcePath).toBe(fixture('basic-conversation.jsonl'));
  });
});
