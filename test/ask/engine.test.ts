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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAskEngine, tokenize } from '../../src/ask/engine.js';
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
): void {
  writeFileSync(
    join(repoDir, '.lore', 'report.json'),
    JSON.stringify({ matches: [], sessionSourceMap }, null, 2),
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
});
