/**
 * Tests for the Claude Code transcript parser.
 *
 * Fixtures are hand-crafted JSONL files in fixtures/claude-code/.
 * No real ~/.claude transcripts are read.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { claudeCodeParser } from '../../src/parsers/claude-code.js';
import type {
  UserMessageEvent,
  AssistantMessageEvent,
  FileEditEvent,
  GitCommitEvent,
  ShellExecEvent,
  LoreEvent,
} from '../../src/schema/events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(process.cwd(), 'fixtures/claude-code');

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
// 1. Basic conversation
// ---------------------------------------------------------------------------

describe('basic conversation', () => {
  it('parses user and assistant messages with correct text', async () => {
    const result = await claudeCodeParser.parse(fixture('basic-conversation.jsonl'));
    const { session, skipped } = result;

    expect(skipped.count).toBe(0);

    const userMsgs = eventsOfKind(session.events, 'user-message');
    const assistantMsgs = eventsOfKind(session.events, 'assistant-message');

    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0]!.text).toBe('Please help me refactor the login function.');
    expect(userMsgs[1]!.text).toBe('Sure, here is the code.');

    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0]!.text).toContain('help you refactor');
    expect(assistantMsgs[1]!.text).toContain('recommend extracting');
  });

  it('captures session metadata from message fields', async () => {
    const { session } = await claudeCodeParser.parse(fixture('basic-conversation.jsonl'));
    const { meta } = session;

    expect(meta.agent).toBe('claude-code');
    expect(meta.sessionId).toBe('sess-basic');
    expect(meta.cwd).toBe('/Users/x/code/proj');
    expect(meta.gitBranch).toBe('main');
    expect(meta.agentVersion).toBe('2.1.170');
    expect(meta.startedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(meta.endedAt).toBe('2026-06-01T10:00:15.000Z');
  });

  it('assigns monotonically increasing seq numbers', async () => {
    const { session } = await claudeCodeParser.parse(fixture('basic-conversation.jsonl'));
    const seqs = session.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Edit tool (structuredPatch + userModified)
// ---------------------------------------------------------------------------

describe('Edit tool', () => {
  it('produces a file-edit event with op=edit and correct fields', async () => {
    const { session, skipped } = await claudeCodeParser.parse(fixture('edit-tool.jsonl'));

    expect(skipped.count).toBe(0);

    const fileEdits = eventsOfKind(session.events, 'file-edit');
    expect(fileEdits).toHaveLength(1);

    const edit = fileEdits[0]!;
    expect(edit.op).toBe('edit');
    expect(edit.filePath).toBe('/Users/x/code/proj/src/auth.ts');
    expect(edit.toolUseId).toBe('toolu_edit01');
    expect(edit.oldText).toBe('function login(username: string) {');
    expect(edit.newText).toBe('function login(username: string, password: string): boolean {');
    expect(edit.userModified).toBe(false);
    expect(edit.succeeded).toBe(true);
  });

  it('includes structuredPatch as PatchHunk array', async () => {
    const { session } = await claudeCodeParser.parse(fixture('edit-tool.jsonl'));
    const edit = eventsOfKind(session.events, 'file-edit')[0]!;

    expect(edit.patch).not.toBeNull();
    expect(edit.patch).toHaveLength(1);
    const hunk = edit.patch![0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toContain('-function login(username: string) {');
    expect(hunk.lines).toContain('+function login(username: string, password: string): boolean {');
  });

  it('also emits assistant-message with the text before tool_use', async () => {
    const { session } = await claudeCodeParser.parse(fixture('edit-tool.jsonl'));
    const assistantMsgs = eventsOfKind(session.events, 'assistant-message');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs[0]!.text).toContain("I'll update the function signature");
  });
});

// ---------------------------------------------------------------------------
// 3. Write tool
// ---------------------------------------------------------------------------

describe('Write tool', () => {
  it('produces a file-edit event with op=write', async () => {
    const { session, skipped } = await claudeCodeParser.parse(fixture('write-tool.jsonl'));

    expect(skipped.count).toBe(0);

    const fileEdits = eventsOfKind(session.events, 'file-edit');
    expect(fileEdits).toHaveLength(1);

    const edit = fileEdits[0]!;
    expect(edit.op).toBe('write');
    expect(edit.filePath).toBe('/Users/x/code/proj/config.json');
    expect(edit.toolUseId).toBe('toolu_write01');
    expect(edit.oldText).toBeNull();
    expect(edit.newText).toContain('"debug": false');
    expect(edit.patch).toBeNull();
    expect(edit.userModified).toBe(false);
    expect(edit.succeeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Git commit event
// ---------------------------------------------------------------------------

describe('git commit event', () => {
  it('emits a git-commit event when toolUseResult has gitOperation.commit.sha', async () => {
    const { session, skipped } = await claudeCodeParser.parse(fixture('git-commit.jsonl'));

    expect(skipped.count).toBe(0);

    const commits = eventsOfKind(session.events, 'git-commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe('81b52a8');
  });

  it('also emits a shell-exec event for the Bash tool_use', async () => {
    const { session } = await claudeCodeParser.parse(fixture('git-commit.jsonl'));
    const shells = eventsOfKind(session.events, 'shell-exec');
    expect(shells).toHaveLength(1);
    expect(shells[0]!.command).toBe("git commit -m 'refactor: update login function'");
    expect(shells[0]!.description).toBe('Commit the auth refactor');
  });
});

// ---------------------------------------------------------------------------
// 5. Streaming increment deduplication
// ---------------------------------------------------------------------------

describe('streaming deduplication', () => {
  it('merges streaming chunks into a single assistant-message', async () => {
    const { session, skipped } = await claudeCodeParser.parse(fixture('streaming-dedup.jsonl'));

    expect(skipped.count).toBe(0);

    const assistantMsgs = eventsOfKind(session.events, 'assistant-message');
    // All chunks share parentUuid=u-0001, should produce exactly one assistant-message
    expect(assistantMsgs).toHaveLength(1);
    const msg = assistantMsgs[0]!;
    expect(msg.text).toContain('This module');
    expect(msg.text).toContain('handles authentication');
    expect(msg.text).toContain('and session management.');
  });

  it('does not emit assistant-message for chunks without stop_reason', async () => {
    // Verify that only the final flush emits one event
    const { session } = await claudeCodeParser.parse(fixture('streaming-dedup.jsonl'));
    const assistantMsgs = eventsOfKind(session.events, 'assistant-message');
    expect(assistantMsgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. isMeta exclusion
// ---------------------------------------------------------------------------

describe('isMeta exclusion', () => {
  it('excludes isMeta=true lines from user-message events', async () => {
    const { session } = await claudeCodeParser.parse(fixture('is-meta-exclude.jsonl'));
    const userMsgs = eventsOfKind(session.events, 'user-message');

    // Only the real user message should be included
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.text).toBe('What should I do next?');
  });

  it('excludes isCompactSummary=true lines from user-message events', async () => {
    const { session } = await claudeCodeParser.parse(fixture('is-meta-exclude.jsonl'));
    const userMsgs = eventsOfKind(session.events, 'user-message');

    const summaryMsgs = userMsgs.filter((m) => m.text.includes('Summary of earlier'));
    expect(summaryMsgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Bad lines skipped
// ---------------------------------------------------------------------------

describe('bad lines skipped', () => {
  it('skips non-JSON lines and increments skipped.count', async () => {
    const { session, skipped } = await claudeCodeParser.parse(fixture('bad-lines.jsonl'));

    // Two bad lines: "this is not json..." and "{invalid json line: ...}"
    expect(skipped.count).toBe(2);
    expect(skipped.samples.length).toBeGreaterThanOrEqual(1);
  });

  it('still parses good lines despite bad ones', async () => {
    const { session } = await claudeCodeParser.parse(fixture('bad-lines.jsonl'));
    const userMsgs = eventsOfKind(session.events, 'user-message');
    const assistantMsgs = eventsOfKind(session.events, 'assistant-message');

    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.text).toBe('Fix the bug.');
    expect(assistantMsgs).toHaveLength(1);
  });

  it('samples at most 5 skip reasons', async () => {
    const { skipped } = await claudeCodeParser.parse(fixture('bad-lines.jsonl'));
    expect(skipped.samples.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 8. Subagent file (isSidechain)
// ---------------------------------------------------------------------------

describe('subagent file', () => {
  it('parses subagent transcript and uses parent sessionId', async () => {
    const subagentPath = fixture('subagent-session/subagents/agent-worker.jsonl');
    const { session, skipped } = await claudeCodeParser.parse(subagentPath);

    expect(skipped.count).toBe(0);
    // The sessionId should be the parent session directory name
    expect(session.meta.sessionId).toBe('sess-parent');
  });

  it('emits shell-exec event for Bash in subagent', async () => {
    const subagentPath = fixture('subagent-session/subagents/agent-worker.jsonl');
    const { session } = await claudeCodeParser.parse(subagentPath);

    const shells = eventsOfKind(session.events, 'shell-exec');
    expect(shells).toHaveLength(1);
    expect(shells[0]!.command).toBe('npm run lint');
    expect(shells[0]!.description).toBe('Run lint');
  });

  it('emits user-message event for subagent user lines', async () => {
    const subagentPath = fixture('subagent-session/subagents/agent-worker.jsonl');
    const { session } = await claudeCodeParser.parse(subagentPath);

    const userMsgs = eventsOfKind(session.events, 'user-message');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.text).toBe('Run the linting task.');
  });
});

// ---------------------------------------------------------------------------
// 9. discover() — uses a temp fake ~/.claude structure
// ---------------------------------------------------------------------------

describe('discover()', () => {
  let fakeHome: string;
  let savedHome: string | undefined;

  beforeAll(async () => {
    // Create a temporary home dir with a fake .claude structure
    fakeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));

    const projectPath = '/Users/x/code/myproject';
    const encodedPath = projectPath.replace(/\//g, '-');
    const projectDir = path.join(fakeHome, '.claude', 'projects', encodedPath);

    // Main session file
    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(projectDir, 'session-abc123.jsonl'),
      '{"type":"user","sessionId":"abc123","timestamp":"2026-06-01T10:00:00.000Z","cwd":"/Users/x/code/myproject","gitBranch":"main","version":"2.1.170","isMeta":false,"message":{"role":"user","content":"hello"}}\n',
    );

    // Subagent session dir
    const sessionSubDir = path.join(projectDir, 'session-parent');
    const subagentsDir = path.join(sessionSubDir, 'subagents');
    await fs.promises.mkdir(subagentsDir, { recursive: true });
    await fs.promises.writeFile(path.join(subagentsDir, 'agent-001.jsonl'), '');
    // journal.jsonl should be excluded
    const workflowsDir = path.join(subagentsDir, 'workflows', 'wf_001');
    await fs.promises.mkdir(workflowsDir, { recursive: true });
    await fs.promises.writeFile(path.join(workflowsDir, 'journal.jsonl'), '');
    await fs.promises.writeFile(path.join(workflowsDir, 'agent-wf001.jsonl'), '');

    // Patch HOME for the duration of the test
    savedHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
  });

  afterAll(async () => {
    process.env['HOME'] = savedHome;
    await fs.promises.rm(fakeHome, { recursive: true, force: true });
  });

  it('returns main session jsonl files', async () => {
    const files = await claudeCodeParser.discover('/Users/x/code/myproject');
    const mainFiles = files.filter((f) => f.endsWith('session-abc123.jsonl'));
    expect(mainFiles).toHaveLength(1);
  });

  it('returns subagent agent-*.jsonl files', async () => {
    const files = await claudeCodeParser.discover('/Users/x/code/myproject');
    const subFiles = files.filter((f) => f.includes('subagents') && f.endsWith('.jsonl'));
    expect(subFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes journal.jsonl', async () => {
    const files = await claudeCodeParser.discover('/Users/x/code/myproject');
    const journals = files.filter((f) => f.endsWith('journal.jsonl'));
    expect(journals).toHaveLength(0);
  });

  it('returns [] for a repo with no claude project directory', async () => {
    const files = await claudeCodeParser.discover('/nonexistent/repo/path');
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. Schema version and agent kind
// ---------------------------------------------------------------------------

describe('schema version and agent kind', () => {
  it('sets schemaVersion=1 and agent=claude-code', async () => {
    const { session } = await claudeCodeParser.parse(fixture('basic-conversation.jsonl'));
    expect(session.meta.schemaVersion).toBe(1);
    expect(session.meta.agent).toBe('claude-code');
  });

  it('sets sourcePath to the transcript file path', async () => {
    const filePath = fixture('basic-conversation.jsonl');
    const { session } = await claudeCodeParser.parse(filePath);
    expect(session.meta.sourcePath).toBe(filePath);
  });
});

// ---------------------------------------------------------------------------
// 11. Input-fallback: subagent transcripts without toolUseResult side-channel
// ---------------------------------------------------------------------------

describe('input fallback for subagent transcripts (no toolUseResult)', () => {
  it('emits file-edit from tool_use input when tool_result has no toolUseResult', async () => {
    const { session } = await claudeCodeParser.parse(fixture('input-fallback.jsonl'));
    const edits = session.events.filter(
      (e): e is FileEditEvent => e.kind === 'file-edit',
    );
    expect(edits).toHaveLength(2);

    const edit = edits[0]!;
    expect(edit.op).toBe('edit');
    expect(edit.toolUseId).toBe('toolu_f1');
    expect(edit.filePath).toBe('/repo/.claude/worktrees/wf-1/src/a.ts');
    expect(edit.oldText).toBe('const a = 1;');
    expect(edit.newText).toBe('const a = 2;');
    expect(edit.patch).toBeNull();
    expect(edit.succeeded).toBe(true);
  });

  it('marks failed edits with succeeded=false (is_error tool_result)', async () => {
    const { session } = await claudeCodeParser.parse(fixture('input-fallback.jsonl'));
    const edits = session.events.filter(
      (e): e is FileEditEvent => e.kind === 'file-edit',
    );
    const write = edits[1]!;
    expect(write.op).toBe('write');
    expect(write.newText).toBe('export const b = 42;\n');
    expect(write.succeeded).toBe(false);
  });
});
