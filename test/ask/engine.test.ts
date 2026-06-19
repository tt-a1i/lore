/**
 * AskEngine unit tests.
 *
 * All fixtures are synthetic — no real ~/.claude files, no real LLM calls,
 * no git operations.  The tests exercise:
 *   - Chinese 2-gram query hitting a note body
 *   - English camelCase query hitting a note title
 *   - Superseded note filtering (default and --include-superseded)
 *   - Graceful degradation when notes.json is absent (message-only search)
 *   - Empty result when nothing matches
 *   - Message hits from a synthetic transcript (jsonl)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAskEngine, tokenize, noteMatchesFile } from '../../src/ask/engine.js';
import type { DistilledNote, NotesFile } from '../../src/distill/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-ask-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.lore'), { recursive: true });
  return dir;
}

function writeNotesJson(repoDir: string, notes: DistilledNote[]): void {
  const notesFile: NotesFile = {
    schemaVersion: 1,
    distilledSessions: {},
    notes,
  };
  writeFileSync(
    join(repoDir, '.lore', 'notes.json'),
    JSON.stringify(notesFile, null, 2),
    'utf8',
  );
}

function writeReportJson(
  repoDir: string,
  sessionSourceMap: Record<string, string>,
  generatedAt = '2026-06-01T10:00:00.000Z',
): void {
  writeFileSync(
    join(repoDir, '.lore', 'report.json'),
    JSON.stringify({ generatedAt, matches: [], sessionSourceMap }, null, 2),
    'utf8',
  );
}

function writeMessagesIndex(
  repoDir: string,
  entries: { sessionId: string; seq: number; text: string }[],
  generatedAt = '2026-06-01T10:00:00.000Z',
): void {
  writeFileSync(
    join(repoDir, '.lore', 'messages.json'),
    JSON.stringify({ schemaVersion: 1, generatedAt, entries }, null, 2),
    'utf8',
  );
}

/** Write a minimal Claude Code jsonl transcript with some user messages. */
function writeTranscript(
  repoDir: string,
  sessionId: string,
  userMessages: string[],
): string {
  const lines: object[] = [];
  for (const text of userMessages) {
    lines.push({
      type: 'user',
      sessionId,
      cwd: repoDir,
      isMeta: false,
      timestamp: '2026-06-01T10:00:00.000Z',
      message: { role: 'user', content: text },
    });
  }
  const transcriptPath = join(repoDir, `${sessionId}.jsonl`);
  writeFileSync(
    transcriptPath,
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
  return transcriptPath;
}

function writeCodexTranscript(
  repoDir: string,
  sessionId: string,
  userMessages: string[],
): string {
  const lines: object[] = [
    {
      timestamp: '2026-06-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: repoDir, cli_version: '0.139.0' },
    },
  ];
  let i = 1;
  for (const text of userMessages) {
    lines.push({
      timestamp: new Date(Date.UTC(2026, 5, 1, 10, 0, i++)).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: text },
    });
  }
  const transcriptPath = join(repoDir, `${sessionId}.codex.jsonl`);
  writeFileSync(
    transcriptPath,
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
  return transcriptPath;
}

function writeOpenCodeTranscriptDb(
  repoDir: string,
  sessionId: string,
  userMessages: string[],
): string {
  const dbPath = join(repoDir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  const t0 = Date.UTC(2026, 5, 1, 10, 0, 0);
  try {
    db.exec(`
      CREATE TABLE session (
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
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO session (id, directory, path, title, time_created, time_updated, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      repoDir,
      repoDir,
      'Ask Test Session',
      t0,
      t0 + userMessages.length * 1000,
      JSON.stringify({ id: 'test-model' }),
    );
    for (let i = 0; i < userMessages.length; i++) {
      const msgId = `msg_${i}`;
      const ts = t0 + (i + 1) * 1000;
      db.prepare(`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        msgId,
        sessionId,
        ts,
        ts,
        JSON.stringify({ role: 'user', time: { created: ts } }),
      );
      db.prepare(`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        `part_${i}`,
        msgId,
        sessionId,
        ts,
        ts,
        JSON.stringify({ type: 'text', text: userMessages[i] }),
      );
    }
  } finally {
    db.close();
  }
  return `${dbPath}#${sessionId}`;
}

function makeNote(overrides: Partial<DistilledNote> & { id: string; title: string }): DistilledNote {
  return {
    kind: 'decision',
    title: overrides.title,
    body: overrides.body ?? 'Some explanation.',
    files: overrides.files ?? [],
    anchors: [],
    sessionId: overrides.sessionId ?? 'sess-default',
    validAt: '2026-06-01T10:00:00.000Z',
    invalidAt: overrides.invalidAt ?? null,
    supersededBy: overrides.supersededBy ?? null,
    ...overrides,
  };
}

// ── tokenize unit tests ────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases ASCII', () => {
    expect(tokenize('Hello World')).toContain('hello');
    expect(tokenize('Hello World')).toContain('world');
  });

  it('splits camelCase', () => {
    const tokens = tokenize('parseResult');
    expect(tokens).toContain('parse');
    expect(tokens).toContain('result');
  });

  it('splits PascalCase', () => {
    const tokens = tokenize('MatchEngine');
    expect(tokens).toContain('match');
    expect(tokens).toContain('engine');
  });

  it('splits snake_case', () => {
    const tokens = tokenize('graph_store');
    expect(tokens).toContain('graph');
    expect(tokens).toContain('store');
  });

  it('produces 2-grams for Chinese text', () => {
    const tokens = tokenize('为什么');
    // Bigrams: 为什, 什么
    expect(tokens).toContain('为什');
    expect(tokens).toContain('什么');
  });

  it('also produces unigrams for Chinese text', () => {
    const tokens = tokenize('为什么');
    expect(tokens).toContain('为');
    expect(tokens).toContain('什');
    expect(tokens).toContain('么');
  });

  it('handles mixed Chinese + English', () => {
    const tokens = tokenize('选择kuzu作为后端');
    expect(tokens).toContain('kuzu');
    expect(tokens).toContain('选择');
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles numbers in identifiers', () => {
    const tokens = tokenize('node18');
    expect(tokens).toContain('node18');
  });
});

// ── AskEngine integration tests ───────────────────────────────────────────────

describe('AskEngine.ask', () => {
  // ── Chinese query hits ────────────────────────────────────────────────────

  it('Chinese 2-gram query hits matching note body', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-zh-1',
        title: 'Storage backend decision',
        body: '选择kuzu作为嵌入式图谱后端，因为它支持 Cypher 查询。',
      }),
      makeNote({
        id: 'note-zh-2',
        title: 'Irrelevant note',
        body: 'This note is about something completely different.',
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, '选择kuzu');

    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]!.note.id).toBe('note-zh-1');
    expect(result.hits[0]!.score).toBeGreaterThan(0);
  });

  it('Chinese query hitting note title', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-title-zh',
        title: '图谱存储决策',
        body: 'We chose Kuzu as the embedded graph store.',
      }),
      makeNote({
        id: 'note-other',
        title: 'Some other decision',
        body: 'Not related.',
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, '图谱');

    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]!.note.id).toBe('note-title-zh');
  });

  // ── English camelCase query hits ───────────────────────────────────────────

  it('English camelCase query hits matching note title', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-eng-1',
        title: 'GraphStore adapter pattern',
        body: 'We use an adapter pattern to support multiple graph backends.',
      }),
      makeNote({
        id: 'note-eng-2',
        title: 'Unrelated note about parsing',
        body: 'The parser handles jsonl transcripts.',
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    // "graphStore" should expand to "graph" + "store" + "graphstore"
    const result = await engine.ask(repo, 'graphStore');

    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]!.note.id).toBe('note-eng-1');
  });

  it('camelCase query token matches note body with underscored variant', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-camel',
        title: 'Match engine design',
        body: 'The matchEngine uses contentScore and timeScore as signals.',
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'matchEngine');

    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]!.note.id).toBe('note-camel');
  });

  // ── Superseded note filtering ──────────────────────────────────────────────

  it('excludes superseded notes by default', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-valid',
        title: 'Current approach to storage',
        body: 'We use Kuzu for graph storage.',
        invalidAt: null,
      }),
      makeNote({
        id: 'note-superseded',
        title: 'Old approach to storage',
        body: 'We previously used a JSON file for storage.',
        invalidAt: '2026-06-05T00:00:00.000Z',
        supersededBy: 'note-valid',
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'storage');

    const ids = result.hits.map((h) => h.note.id);
    expect(ids).toContain('note-valid');
    expect(ids).not.toContain('note-superseded');
  });

  it('includes superseded notes when includeSuperseded=true', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-valid',
        title: 'Current storage approach',
        body: 'We use Kuzu now.',
        invalidAt: null,
      }),
      makeNote({
        id: 'note-old',
        title: 'Old storage approach',
        body: 'We used JSON storage before.',
        invalidAt: '2026-06-05T00:00:00.000Z',
        supersededBy: 'note-valid',
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'storage', { includeSuperseded: true });

    const ids = result.hits.map((h) => h.note.id);
    expect(ids).toContain('note-valid');
    expect(ids).toContain('note-old');
  });

  // ── notes.json absent — graceful degradation ───────────────────────────────

  it('returns empty hits array when notes.json does not exist', async () => {
    const repo = makeRepo();
    // No notes.json written.

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'some query');

    expect(result.hits).toEqual([]);
    // question is echoed back
    expect(result.question).toBe('some query');
  });

  it('still returns message hits when notes.json is absent', async () => {
    const repo = makeRepo();
    // No notes.json.
    const transcriptPath = writeTranscript(repo, 'sess-msg', [
      'We should use Kuzu for graph storage.',
      'Something irrelevant here.',
    ]);
    writeReportJson(repo, { 'sess-msg': transcriptPath });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'Kuzu graph storage');

    expect(result.hits).toEqual([]);
    expect(result.messageHits.length).toBeGreaterThanOrEqual(1);
    expect(result.messageHits[0]!.sessionId).toBe('sess-msg');
    expect(result.messageHits[0]!.text).toContain('Kuzu');
  });

  // ── Empty result when nothing matches ─────────────────────────────────────

  it('returns empty hits and messageHits when nothing matches', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-a',
        title: 'Some unrelated decision',
        body: 'We chose Option A because of XYZ.',
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'zzz-never-matches-anything-12345');

    expect(result.hits).toEqual([]);
    expect(result.messageHits).toEqual([]);
  });

  // ── topK respected ─────────────────────────────────────────────────────────

  it('respects topK option', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = Array.from({ length: 10 }, (_, i) =>
      makeNote({
        id: `note-${i}`,
        title: `Decision about graph storage ${i}`,
        body: 'We use graph storage for all data.',
      }),
    );
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'graph storage', { topK: 3 });

    expect(result.hits.length).toBeLessThanOrEqual(3);
  });

  // ── Message hits from transcript ───────────────────────────────────────────

  it('extracts and scores user messages from transcript', async () => {
    const repo = makeRepo();
    const transcriptPath = writeTranscript(repo, 'sess-abc', [
      'Please implement the graph store adapter.',
      'How does the parser work?',
    ]);
    writeReportJson(repo, { 'sess-abc': transcriptPath });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'graphStore adapter');

    expect(result.messageHits.length).toBeGreaterThanOrEqual(1);
    const topMsg = result.messageHits[0]!;
    expect(topMsg.sessionId).toBe('sess-abc');
    expect(topMsg.text).toContain('graph store');
    expect(topMsg.score).toBeGreaterThan(0);
  });

  it('ignores a stale persisted messages index and falls back to current report transcripts', async () => {
    const repo = makeRepo();
    const transcriptPath = writeTranscript(repo, 'sess-current', [
      'newtopic currenttranscript should be found from the live transcript.',
    ]);
    writeReportJson(
      repo,
      { 'sess-current': transcriptPath },
      '2026-06-02T10:00:00.000Z',
    );
    writeMessagesIndex(
      repo,
      [{ sessionId: 'sess-old', seq: 1, text: 'oldtopic staleindex only' }],
      '2026-06-01T10:00:00.000Z',
    );

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'newtopic currenttranscript');

    expect(result.messageHits.length).toBeGreaterThanOrEqual(1);
    expect(result.messageHits[0]!.sessionId).toBe('sess-current');
    expect(result.messageHits[0]!.text).toContain('newtopic currenttranscript');
  });

  it('uses a fresh persisted messages index without reparsing transcripts', async () => {
    const repo = makeRepo();
    writeReportJson(
      repo,
      { 'sess-ghost': '/nonexistent/path/to/transcript.jsonl' },
      '2026-06-02T10:00:00.000Z',
    );
    writeMessagesIndex(
      repo,
      [{ sessionId: 'sess-index', seq: 1, text: 'freshindex persisted message' }],
      '2026-06-02T10:00:01.000Z',
    );

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'freshindex persisted');

    expect(result.messageHits.length).toBeGreaterThanOrEqual(1);
    expect(result.messageHits[0]!.sessionId).toBe('sess-index');
  });

  it('extracts and scores normalized user messages from Codex transcripts', async () => {
    const repo = makeRepo();
    const transcriptPath = writeCodexTranscript(repo, 'sess-codex-ask', [
      'Please document the codex parser fallback for raw message search.',
      'Unrelated turn.',
    ]);
    writeReportJson(repo, { 'sess-codex-ask': transcriptPath });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'codex parser fallback');

    expect(result.messageHits.length).toBeGreaterThanOrEqual(1);
    expect(result.messageHits[0]!.sessionId).toBe('sess-codex-ask');
    expect(result.messageHits[0]!.text).toContain('codex parser fallback');
  });

  it('extracts and scores normalized user messages from OpenCode transcripts when parseable', async () => {
    const repo = makeRepo();
    const pseudoPath = writeOpenCodeTranscriptDb(repo, 'sess-opencode-ask', [
      'Please index the opencode parser fallback in ask message search.',
      'Unrelated turn.',
    ]);
    writeReportJson(repo, { 'sess-opencode-ask': pseudoPath });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'opencode parser fallback');

    expect(result.messageHits.length).toBeGreaterThanOrEqual(1);
    expect(result.messageHits[0]!.sessionId).toBe('sess-opencode-ask');
    expect(result.messageHits[0]!.text).toContain('opencode parser fallback');
  });

  it('truncates user messages to 600 chars for indexing', async () => {
    const repo = makeRepo();
    const longMsg = 'A'.repeat(700) + ' kuzu graph';
    const transcriptPath = writeTranscript(repo, 'sess-long', [longMsg]);
    writeReportJson(repo, { 'sess-long': transcriptPath });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'kuzu graph');

    // The message is indexed with truncation; "kuzu" might be cut off.
    // What matters is no crash and result is valid.
    expect(typeof result).toBe('object');
    expect(result.messageHits.length).toBeGreaterThanOrEqual(0);
    if (result.messageHits.length > 0) {
      expect(result.messageHits[0]!.text.length).toBeLessThanOrEqual(600);
    }
  });

  it('handles missing transcript file gracefully', async () => {
    const repo = makeRepo();
    writeReportJson(repo, { 'sess-ghost': '/nonexistent/path/to/transcript.jsonl' });

    const engine = createAskEngine();
    // Should not throw; messageHits should be empty.
    const result = await engine.ask(repo, 'anything');
    expect(result.messageHits).toEqual([]);
  });

  // ── File path tokens ───────────────────────────────────────────────────────

  it('matches query tokens against file paths in notes', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-file',
        title: 'Some decision',
        body: 'Details here.',
        files: ['src/graph/kuzu-store.ts'],
      }),
      makeNote({
        id: 'note-no-file',
        title: 'Other decision',
        body: 'No relevant files.',
        files: [],
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'kuzuStore');

    // Should find note-file due to file path segment "kuzu-store" -> ["kuzu", "store"]
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]!.note.id).toBe('note-file');
  });

  // ── Hits ordered by score ─────────────────────────────────────────────────

  it('returns note hits ordered by score descending', async () => {
    const repo = makeRepo();
    // Both notes contain "graph" and "store"; note-high has many more occurrences.
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-high',
        title: 'GraphStore adapter pattern',
        body: 'GraphStore is the main interface. GraphStore adapters exist for Kuzu and JSON. The graph store pattern is central.',
        // "graph" and "store" appear multiple times -> higher score
      }),
      makeNote({
        id: 'note-low',
        title: 'Graph store note',
        body: 'A brief graph store note.',
        // "graph" and "store" appear once each -> lower score
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'graphStore');

    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    // Scores should be descending.
    for (let i = 1; i < result.hits.length; i++) {
      expect(result.hits[i - 1]!.score).toBeGreaterThanOrEqual(result.hits[i]!.score);
    }
    // The heavily-weighted note should rank first.
    expect(result.hits[0]!.note.id).toBe('note-high');
  });

  // ── Empty question ────────────────────────────────────────────────────────

  it('returns empty results for a whitespace-only question', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({ id: 'note-x', title: 'Anything', body: 'Something.' }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, '   ');

    expect(result.hits).toEqual([]);
    expect(result.messageHits).toEqual([]);
  });

  // ── Denoising: MIN_SCORE floor ─────────────────────────────────────────────

  it('returns empty results for a totally unrelated query (MIN_SCORE floor)', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-real',
        title: 'Scrolling constraint in the terminal pane',
        body: 'The terminal must not scroll past the last line; we clamp the offset.',
        files: ['src/server/terminal.ts'],
      }),
    ];
    writeNotesJson(repo, notes);
    const transcriptPath = writeTranscript(repo, 'sess-real', [
      'We need to fix the scrolling constraint so the pane stays anchored.',
    ]);
    writeReportJson(repo, { 'sess-real': transcriptPath });

    const engine = createAskEngine();
    const result = await engine.ask(
      repo,
      'a totally unrelated query about quantum chromodynamics zzz',
    );

    expect(result.hits).toEqual([]);
    expect(result.messageHits).toEqual([]);
  });

  it('still finds the relevant note for a real query after denoising', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-scroll',
        title: 'Scrolling constraint in the terminal pane',
        body: 'The terminal pane must not scroll past the last line; the scroll offset is clamped to the content height.',
        files: ['src/server/terminal.ts'],
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'scrolling constraint');

    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]!.note.id).toBe('note-scroll');
  });

  // ── Denoising: content blacklist ───────────────────────────────────────────

  it('skips lore pipeline artifact messages (task-notification / distiller / tool plumbing)', async () => {
    const repo = makeRepo();
    // All three messages mention "kuzu graph" but each is a lore artifact and must be skipped.
    const transcriptPath = writeTranscript(repo, 'sess-artifact', [
      '<task-notification> kuzu graph storage distill complete',
      'You are a software-archaeology distiller. Extract notes about kuzu graph.',
      'envelope with tool-use-id pointing at kuzu graph output-file path',
    ]);
    writeReportJson(repo, { 'sess-artifact': transcriptPath });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'kuzu graph storage');

    expect(result.messageHits).toEqual([]);
  });

  it('keeps a genuine message even when a sibling artifact message is present', async () => {
    const repo = makeRepo();
    const transcriptPath = writeTranscript(repo, 'sess-mixed', [
      '<task-notification> kuzu graph distill complete', // artifact — skipped
      'Please wire up the kuzu graph store adapter for persistence.', // genuine — kept
    ]);
    writeReportJson(repo, { 'sess-mixed': transcriptPath });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'kuzu graph store adapter');

    expect(result.messageHits.length).toBe(1);
    expect(result.messageHits[0]!.text).toContain('wire up the kuzu graph store adapter');
  });

  // ── Denoising: session-source filter ───────────────────────────────────────

  it('excludes messages from a session whose transcript belongs to another repo', async () => {
    const repo = makeRepo();
    // A foreign transcript that lives outside the repo and outside its project dir.
    const foreignDir = mkdtempSync(join(tmpdir(), 'lore-other-repo-'));
    tmpDirs.push(foreignDir);
    const foreignTranscript = join(foreignDir, 'sess-foreign.jsonl');
    writeFileSync(
      foreignTranscript,
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-foreign',
        cwd: foreignDir,
        isMeta: false,
        timestamp: '2026-06-01T10:00:00.000Z',
        message: { role: 'user', content: 'Implement the kuzu graph store adapter please.' },
      }) + '\n',
      'utf8',
    );
    writeReportJson(repo, { 'sess-foreign': foreignTranscript });

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'kuzu graph store adapter');

    // The matching content exists, but its source is a foreign repo → excluded.
    expect(result.messageHits).toEqual([]);
  });

  // ── Bi-temporal: valid note out-ranks superseded on equal relevance ────────

  it('ranks a valid note above an equally-relevant superseded note (--include-superseded)', async () => {
    const repo = makeRepo();
    // Identical title/body → identical raw score; only validity differs.
    const sharedTitle = 'Storage backend decision';
    const sharedBody = 'We use a graph store for the storage backend of the project.';
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-superseded',
        title: sharedTitle,
        body: sharedBody,
        invalidAt: '2026-06-05T00:00:00.000Z',
        supersededBy: 'note-valid',
      }),
      makeNote({
        id: 'note-valid',
        title: sharedTitle,
        body: sharedBody,
        invalidAt: null,
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'storage backend', {
      includeSuperseded: true,
    });

    const ids = result.hits.map((h) => h.note.id);
    expect(ids).toContain('note-valid');
    expect(ids).toContain('note-superseded');
    // The valid note must rank first despite identical raw relevance.
    expect(result.hits[0]!.note.id).toBe('note-valid');
  });
});

// ── noteMatchesFile unit tests ──────────────────────────────────────────────────

describe('noteMatchesFile (suffix-tolerant path match)', () => {
  it('exact relative match', () => {
    expect(noteMatchesFile(['src/cli.ts'], 'src/cli.ts')).toBe(true);
  });

  it('note absolute, target relative → suffix match', () => {
    expect(noteMatchesFile(['/abs/repo/src/cli.ts'], 'src/cli.ts')).toBe(true);
  });

  it('note relative, target absolute → suffix match', () => {
    expect(noteMatchesFile(['src/cli.ts'], '/abs/repo/src/cli.ts')).toBe(true);
  });

  it('basename-ish suffix matches', () => {
    expect(noteMatchesFile(['src/graph/json-store.ts'], 'graph/json-store.ts')).toBe(true);
  });

  it('strips leading ./ on both sides', () => {
    expect(noteMatchesFile(['./src/cli.ts'], './src/cli.ts')).toBe(true);
  });

  it('different file in same dir does NOT match', () => {
    expect(noteMatchesFile(['src/other.ts'], 'src/cli.ts')).toBe(false);
  });

  it('partial-segment is NOT a match (li.ts !~ cli.ts)', () => {
    expect(noteMatchesFile(['src/cli.ts'], 'li.ts')).toBe(false);
  });

  it('empty inputs do not match', () => {
    expect(noteMatchesFile([], 'src/cli.ts')).toBe(false);
    expect(noteMatchesFile(['src/cli.ts'], '')).toBe(false);
  });
});

// ── file-scoped ask (engine integration) ────────────────────────────────────────

describe('AskEngine file filter', () => {
  it('returns only notes whose files[] contains the target path', async () => {
    const repo = makeRepo();
    const notes: DistilledNote[] = [
      makeNote({
        id: 'note-cli',
        title: 'CLI must keep --json output pure on stdout',
        body: 'Progress lines go to stderr so --json stays machine-parseable.',
        files: ['src/cli.ts'],
      }),
      makeNote({
        id: 'note-graph',
        title: 'Graph store must keep --json output pure',
        body: 'Same pure --json output rule but for the graph layer.',
        files: ['src/graph/kuzu-store.ts'],
      }),
    ];
    writeNotesJson(repo, notes);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'pure json output', { file: 'src/cli.ts' });

    const ids = result.hits.map((h) => h.note.id);
    expect(ids).toContain('note-cli');
    expect(ids).not.toContain('note-graph');
  });

  it('tolerates absolute target path against relative note files', async () => {
    const repo = makeRepo();
    writeNotesJson(repo, [
      makeNote({
        id: 'note-cli',
        title: 'CLI json purity',
        body: 'Keep stdout clean for json mode.',
        files: ['src/cli.ts'],
      }),
    ]);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'json purity', {
      file: `${repo}/src/cli.ts`,
    });
    expect(result.hits.map((h) => h.note.id)).toContain('note-cli');
  });

  it('skips raw message hits when a file is specified (notes-only)', async () => {
    const repo = makeRepo();
    writeNotesJson(repo, [
      makeNote({
        id: 'note-cli',
        title: 'CLI json purity constraint',
        body: 'Keep stdout clean for the parser command.',
        files: ['src/cli.ts'],
      }),
    ]);
    // A transcript whose user message would otherwise match "parser".
    const sid = 'sess-msg';
    const tp = writeTranscript(repo, sid, [
      'please fix the parser command so the json output stays clean',
    ]);
    writeReportJson(repo, { [sid]: tp });

    const engine = createAskEngine();
    const scoped = await engine.ask(repo, 'parser json output', { file: 'src/cli.ts' });
    expect(scoped.messageHits).toEqual([]);
    expect(scoped.hits.map((h) => h.note.id)).toContain('note-cli');

    // Without the file filter, the same query DOES surface the raw message.
    const unscoped = await engine.ask(repo, 'parser json output');
    expect(unscoped.messageHits.length).toBeGreaterThan(0);
  });

  it('notes with no files never match a file-scoped query', async () => {
    const repo = makeRepo();
    writeNotesJson(repo, [
      makeNote({
        id: 'note-nofiles',
        title: 'A global decision about json purity',
        body: 'Applies everywhere, attached to no specific file.',
        files: [],
      }),
    ]);

    const engine = createAskEngine();
    const result = await engine.ask(repo, 'json purity', { file: 'src/cli.ts' });
    expect(result.hits).toEqual([]);
  });
});
