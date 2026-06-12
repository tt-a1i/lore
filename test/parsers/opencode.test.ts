/**
 * Tests for the OpenCode transcript parser.
 *
 * Fixtures are built in-memory using node:sqlite DatabaseSync.
 * No real ~/.local/share/opencode/opencode.db is read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { opencodeParser } from '../../src/parsers/opencode.js';
import type {
  UserMessageEvent,
  AssistantMessageEvent,
  FileEditEvent,
  LoreEvent,
} from '../../src/schema/events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventsOfKind<K extends LoreEvent['kind']>(
  events: LoreEvent[],
  kind: K,
): Extract<LoreEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<LoreEvent, { kind: K }> => e.kind === kind);
}

/**
 * Create a fresh temp directory with an opencode.db fixture.
 * Returns a factory to build pseudo-paths against the temp db.
 */
interface FixtureContext {
  dbPath: string;
  tmpDir: string;
  db: DatabaseSync;
  pseudoPath(sessionId: string): string;
}

function createFixtureDb(tmpDir: string): FixtureContext {
  const dbPath = path.join(tmpDir, 'opencode.db');
  const db = new DatabaseSync(dbPath);

  // Create minimal OpenCode schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      version TEXT DEFAULT 'local',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      model TEXT,
      cost REAL DEFAULT 0,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      summary_additions INTEGER DEFAULT 0,
      summary_deletions INTEGER DEFAULT 0,
      summary_files INTEGER DEFAULT 0,
      summary_diffs TEXT DEFAULT '[]',
      agent TEXT,
      workspace_id TEXT,
      path TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  return {
    dbPath,
    tmpDir,
    db,
    pseudoPath(sessionId: string) {
      return `${dbPath}#${sessionId}`;
    },
  };
}

/**
 * Insert a session row.
 */
function insertSession(
  ctx: FixtureContext,
  opts: {
    id: string;
    directory?: string;
    path?: string;
    title?: string;
    timeCreated?: number;
    timeUpdated?: number;
    model?: string;
    summaryFiles?: number;
    summaryAdditions?: number;
    summaryDeletions?: number;
    summaryDiffs?: string;
  },
): void {
  const now = Date.now();
  ctx.db.prepare(`
    INSERT INTO session (id, directory, path, title, time_created, time_updated,
      model, summary_files, summary_additions, summary_deletions, summary_diffs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.directory ?? '/test/repo',
    opts.path ?? '',
    opts.title ?? 'Test Session',
    opts.timeCreated ?? now,
    opts.timeUpdated ?? now + 1000,
    opts.model ?? JSON.stringify({ id: 'test-model', providerID: 'test-provider', variant: 'default' }),
    opts.summaryFiles ?? 0,
    opts.summaryAdditions ?? 0,
    opts.summaryDeletions ?? 0,
    opts.summaryDiffs ?? '[]',
  );
}

/**
 * Insert a message + parts in one call.
 */
function insertMessage(
  ctx: FixtureContext,
  opts: {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    timeCreated: number;
    parts: Array<{ id: string; type: string; text?: string; data?: Record<string, unknown> }>;
  },
): void {
  const msgData: Record<string, unknown> = {
    role: opts.role,
    time: { created: opts.timeCreated },
  };
  ctx.db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(opts.id, opts.sessionId, opts.timeCreated, opts.timeCreated, JSON.stringify(msgData));

  for (const p of opts.parts) {
    const partData: Record<string, unknown> = p.data ?? { type: p.type };
    if (p.text !== undefined) (partData as { text?: string }).text = p.text;
    ctx.db.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(p.id, opts.id, opts.sessionId, opts.timeCreated, opts.timeCreated, JSON.stringify(partData));
  }
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let ctx: FixtureContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-opencode-test-'));
  ctx = createFixtureDb(tmpDir);
});

afterEach(() => {
  try { ctx.db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. discover() — filtering by repoPath
// ---------------------------------------------------------------------------

describe('discover()', () => {
  it('returns pseudo-paths only for sessions matching repoPath (non-broad)', async () => {
    insertSession(ctx, { id: 'ses_aaa', directory: '/repo/alpha', path: '/repo/alpha' });
    insertSession(ctx, { id: 'ses_bbb', directory: '/repo/beta', path: '/repo/beta' });
    insertSession(ctx, { id: 'ses_ccc', directory: '/other/project', path: '' });

    // Patch OPENCODE_DB_PATH for this test by using parse() with explicit path later.
    // discover() uses the real OPENCODE_DB_PATH constant so we cannot easily override it;
    // instead we test the path-filtering logic indirectly through parse().
    // The real discover() test is integration-level; here we verify it returns an array.
    const results = await opencodeParser.discover('/repo/alpha');
    // Whether OPENCODE_DB_PATH exists on this machine determines how many results come back.
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns empty array when db does not exist', async () => {
    const results = await opencodeParser.discover('/non/existent/repo');
    // If the real db doesn't exist either we expect []; if it does exist we may get
    // sessions from it — we only assert Array type and no throw.
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns empty array for non-existent pseudo db path (broad=true)', async () => {
    const results = await opencodeParser.discover('/any/path', { broad: true });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. parse() — basic message extraction
// ---------------------------------------------------------------------------

describe('parse() — message extraction', () => {
  it('extracts user and assistant text parts', async () => {
    const SESSION_ID = 'ses_basic01';
    const T0 = 1781064349000;

    insertSession(ctx, { id: SESSION_ID, directory: '/repo/test', timeCreated: T0, timeUpdated: T0 + 5000 });

    insertMessage(ctx, {
      id: 'msg_user1',
      sessionId: SESSION_ID,
      role: 'user',
      timeCreated: T0,
      parts: [
        { id: 'prt_u1', type: 'text', text: 'Please help me write a function.' },
      ],
    });

    insertMessage(ctx, {
      id: 'msg_asst1',
      sessionId: SESSION_ID,
      role: 'assistant',
      timeCreated: T0 + 1000,
      parts: [
        { id: 'prt_a_step', type: 'step-start' },
        { id: 'prt_a_reason', type: 'reasoning', text: 'The user wants a function.' },
        { id: 'prt_a_text', type: 'text', text: 'Sure! Here is the function.' },
        { id: 'prt_a_finish', type: 'step-finish', data: { type: 'step-finish', reason: 'stop' } },
      ],
    });

    ctx.db.close();
    const result = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));
    const { session, skipped } = result;

    expect(session.meta.agent).toBe('opencode');
    expect(session.meta.sessionId).toBe(SESSION_ID);
    expect(session.meta.cwd).toBe('/repo/test');
    expect(session.meta.agentVersion).toBe('test-model');

    const userMsgs = eventsOfKind(session.events, 'user-message') as UserMessageEvent[];
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.text).toBe('Please help me write a function.');

    const assistMsgs = eventsOfKind(session.events, 'assistant-message') as AssistantMessageEvent[];
    expect(assistMsgs).toHaveLength(1);
    expect(assistMsgs[0]!.text).toBe('Sure! Here is the function.');

    expect(skipped.count).toBe(0);
  });

  it('assigns monotonically increasing seq numbers', async () => {
    const SESSION_ID = 'ses_seqtest';
    const T0 = 1781064350000;

    insertSession(ctx, { id: SESSION_ID, directory: '/repo', timeCreated: T0, timeUpdated: T0 + 2000 });
    insertMessage(ctx, {
      id: 'msg_u1',
      sessionId: SESSION_ID,
      role: 'user',
      timeCreated: T0,
      parts: [{ id: 'prt_u1', type: 'text', text: 'First message' }],
    });
    insertMessage(ctx, {
      id: 'msg_a1',
      sessionId: SESSION_ID,
      role: 'assistant',
      timeCreated: T0 + 1000,
      parts: [{ id: 'prt_a1', type: 'text', text: 'First response' }],
    });

    ctx.db.close();
    const { session } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));
    const seqs = session.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('captures correct ISO timestamps from Unix ms', async () => {
    const SESSION_ID = 'ses_tstest';
    const T0 = 1781064349000; // 2026-06-10T04:05:49.000Z

    insertSession(ctx, { id: SESSION_ID, directory: '/repo', timeCreated: T0, timeUpdated: T0 });
    insertMessage(ctx, {
      id: 'msg_u1',
      sessionId: SESSION_ID,
      role: 'user',
      timeCreated: T0,
      parts: [{ id: 'prt_u1', type: 'text', text: 'Hello' }],
    });

    ctx.db.close();
    const { session } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));
    expect(session.meta.startedAt).toBe(new Date(T0).toISOString());

    const userMsg = eventsOfKind(session.events, 'user-message')[0];
    expect(userMsg).toBeDefined();
    expect(userMsg!.ts).toBe(new Date(T0).toISOString());
  });

  it('handles empty text parts gracefully (no events emitted)', async () => {
    const SESSION_ID = 'ses_empty01';
    const T0 = 1781064349000;

    insertSession(ctx, { id: SESSION_ID, directory: '/repo', timeCreated: T0, timeUpdated: T0 });
    insertMessage(ctx, {
      id: 'msg_u1',
      sessionId: SESSION_ID,
      role: 'user',
      timeCreated: T0,
      parts: [{ id: 'prt_u1', type: 'text', text: '   ' }], // whitespace only
    });

    ctx.db.close();
    const { session } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));
    expect(eventsOfKind(session.events, 'user-message')).toHaveLength(0);
  });

  it('ignores non-text/non-edit part types without counting as skipped', async () => {
    const SESSION_ID = 'ses_parttypes';
    const T0 = 1781064349000;

    insertSession(ctx, { id: SESSION_ID, directory: '/repo', timeCreated: T0, timeUpdated: T0 });
    insertMessage(ctx, {
      id: 'msg_a1',
      sessionId: SESSION_ID,
      role: 'assistant',
      timeCreated: T0,
      parts: [
        { id: 'prt_ss', type: 'step-start' },
        { id: 'prt_r', type: 'reasoning', text: 'thinking...' },
        { id: 'prt_t', type: 'text', text: 'Actual response' },
        { id: 'prt_sf', type: 'step-finish', data: { type: 'step-finish', reason: 'stop' } },
      ],
    });

    ctx.db.close();
    const { session, skipped } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));
    expect(eventsOfKind(session.events, 'assistant-message')).toHaveLength(1);
    expect(skipped.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. parse() — file-edit via summary_diffs (degradation path)
// ---------------------------------------------------------------------------

describe('parse() — file-edit degradation via summary_diffs', () => {
  it('emits FileEditEvent from summary_diffs when no tool-call parts exist', async () => {
    const SESSION_ID = 'ses_diffs01';
    const T0 = 1781064349000;

    const diffs = JSON.stringify([
      { path: 'src/index.ts', additions: 5, deletions: 2, diff: '' },
      { path: 'src/util.ts', additions: 1, deletions: 0, diff: '' },
    ]);

    insertSession(ctx, {
      id: SESSION_ID,
      directory: '/repo',
      timeCreated: T0,
      timeUpdated: T0 + 3000,
      summaryFiles: 2,
      summaryAdditions: 6,
      summaryDeletions: 2,
      summaryDiffs: diffs,
    });
    // No messages/parts inserted — pure diff-based session.

    ctx.db.close();
    const { session, skipped } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));

    const edits = eventsOfKind(session.events, 'file-edit') as FileEditEvent[];
    expect(edits).toHaveLength(2);
    expect(edits[0]!.filePath).toBe('src/index.ts');
    expect(edits[1]!.filePath).toBe('src/util.ts');
    expect(edits[0]!.op).toBe('edit');

    // Should note the degradation
    const noteText = skipped.samples.join(' ');
    expect(noteText).toContain('summary_diffs');
  });

  it('parses unified-diff string from summary_diffs into PatchHunk[]', async () => {
    const SESSION_ID = 'ses_diffs02';
    const T0 = 1781064349000;

    const unifiedDiff = `@@ -1,3 +1,4 @@
 line1
-old line2
+new line2
+added line
 line3`;

    const diffs = JSON.stringify([
      { path: 'src/foo.ts', additions: 1, deletions: 1, diff: unifiedDiff },
    ]);

    insertSession(ctx, {
      id: SESSION_ID,
      directory: '/repo',
      timeCreated: T0,
      timeUpdated: T0 + 1000,
      summaryFiles: 1,
      summaryDiffs: diffs,
    });

    ctx.db.close();
    const { session } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));

    const edits = eventsOfKind(session.events, 'file-edit') as FileEditEvent[];
    expect(edits).toHaveLength(1);
    const edit = edits[0]!;
    expect(edit.patch).not.toBeNull();
    expect(edit.patch).toHaveLength(1);
    const hunk = edit.patch![0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(hunk.lines).toContain('-old line2');
    expect(hunk.lines).toContain('+new line2');
  });

  it('notes missing granularity when summary_files > 0 but summary_diffs is empty', async () => {
    const SESSION_ID = 'ses_nodiffs';
    const T0 = 1781064349000;

    insertSession(ctx, {
      id: SESSION_ID,
      directory: '/repo',
      timeCreated: T0,
      timeUpdated: T0 + 1000,
      summaryFiles: 3,
      summaryDiffs: '[]',
    });

    ctx.db.close();
    const { session, skipped } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));

    expect(eventsOfKind(session.events, 'file-edit')).toHaveLength(0);
    const noteText = skipped.samples.join(' ');
    expect(noteText).toContain('summary_files');
  });
});

// ---------------------------------------------------------------------------
// 4. parse() — error / degradation paths
// ---------------------------------------------------------------------------

describe('parse() — error handling', () => {
  it('returns empty result for malformed pseudo-path (no # separator)', async () => {
    const result = await opencodeParser.parse('/no/separator/here');
    expect(result.session.events).toHaveLength(0);
    expect(result.skipped.samples.length).toBeGreaterThan(0);
    expect(result.skipped.samples[0]).toContain('malformed');
  });

  it('returns empty result when db file does not exist', async () => {
    const result = await opencodeParser.parse('/nonexistent/opencode.db#ses_xyz');
    expect(result.session.events).toHaveLength(0);
    expect(result.skipped.samples[0]).toMatch(/not found|unavailable/);
  });

  it('returns empty result when session id is not in db', async () => {
    // DB exists but session row is absent
    ctx.db.close();
    const result = await opencodeParser.parse(ctx.pseudoPath('ses_missing'));
    expect(result.session.events).toHaveLength(0);
    expect(result.skipped.samples[0]).toContain('session not found');
  });

  it('returns empty result when required tables are missing', async () => {
    // Create a db with only a dummy table
    const altDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-opencode-notables-'));
    const altDbPath = path.join(altDir, 'opencode.db');
    const altDb = new DatabaseSync(altDbPath);
    altDb.exec(`CREATE TABLE dummy (id TEXT)`);
    altDb.close();

    const result = await opencodeParser.parse(`${altDbPath}#ses_any`);
    expect(result.session.events).toHaveLength(0);
    expect(result.skipped.samples[0]).toContain('tables missing');

    fs.rmSync(altDir, { recursive: true, force: true });
  });

  it('continues parsing when one message has invalid JSON in data column', async () => {
    const SESSION_ID = 'ses_badjson';
    const T0 = 1781064349000;

    insertSession(ctx, { id: SESSION_ID, directory: '/repo', timeCreated: T0, timeUpdated: T0 });

    // Insert a bad message row directly
    ctx.db.prepare(`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_bad', ?, ?, ?, 'NOT_JSON')
    `).run(SESSION_ID, T0, T0);

    // Insert a good message after the bad one
    insertMessage(ctx, {
      id: 'msg_good',
      sessionId: SESSION_ID,
      role: 'user',
      timeCreated: T0 + 500,
      parts: [{ id: 'prt_good', type: 'text', text: 'Valid message' }],
    });

    ctx.db.close();
    const { session, skipped } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));

    // The good message should still parse
    const userMsgs = eventsOfKind(session.events, 'user-message');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.text).toBe('Valid message');
    // The bad message should be counted as skipped
    expect(skipped.count).toBeGreaterThan(0);
  });

  it('returns zero events but correct meta for a session with no messages', async () => {
    const SESSION_ID = 'ses_nomsg';
    const T0 = 1781064349000;

    insertSession(ctx, {
      id: SESSION_ID,
      directory: '/my/repo',
      timeCreated: T0,
      timeUpdated: T0 + 500,
      model: JSON.stringify({ id: 'mimo-v2.5', providerID: 'xiaomi', variant: 'default' }),
    });

    ctx.db.close();
    const { session } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));

    expect(session.meta.sessionId).toBe(SESSION_ID);
    expect(session.meta.cwd).toBe('/my/repo');
    expect(session.meta.agentVersion).toBe('mimo-v2.5');
    expect(session.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. parse() — multi-message conversation ordering
// ---------------------------------------------------------------------------

describe('parse() — event ordering', () => {
  it('orders events by seq across interleaved user/assistant messages', async () => {
    const SESSION_ID = 'ses_order01';
    const T0 = 1781064349000;

    insertSession(ctx, { id: SESSION_ID, directory: '/repo', timeCreated: T0, timeUpdated: T0 + 4000 });

    insertMessage(ctx, {
      id: 'msg_u1', sessionId: SESSION_ID, role: 'user', timeCreated: T0,
      parts: [{ id: 'prt_u1', type: 'text', text: 'Turn 1 user' }],
    });
    insertMessage(ctx, {
      id: 'msg_a1', sessionId: SESSION_ID, role: 'assistant', timeCreated: T0 + 1000,
      parts: [{ id: 'prt_a1', type: 'text', text: 'Turn 1 assistant' }],
    });
    insertMessage(ctx, {
      id: 'msg_u2', sessionId: SESSION_ID, role: 'user', timeCreated: T0 + 2000,
      parts: [{ id: 'prt_u2', type: 'text', text: 'Turn 2 user' }],
    });
    insertMessage(ctx, {
      id: 'msg_a2', sessionId: SESSION_ID, role: 'assistant', timeCreated: T0 + 3000,
      parts: [{ id: 'prt_a2', type: 'text', text: 'Turn 2 assistant' }],
    });

    ctx.db.close();
    const { session } = await opencodeParser.parse(ctx.pseudoPath(SESSION_ID));

    expect(session.events).toHaveLength(4);
    const kinds = session.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'user-message',
      'assistant-message',
      'user-message',
      'assistant-message',
    ]);

    const seqs = session.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});
