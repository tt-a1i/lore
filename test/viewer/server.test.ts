/**
 * ViewerServer tests.
 *
 * Strategy:
 *   - Spin up a real ViewerServer on port 0 (OS-assigned free port).
 *   - The graph store is driven by a pre-built graph.json written to a temp dir,
 *     so createGraphStore (JSON backend) picks it up without mocking.
 *   - notes.json is written to the same temp dir.
 *   - Tests focus on:
 *       1. GET / returns valid HTML with <html
 *       2. GET /api/payload returns a ViewerPayload with correct shape
 *       3. payload.graph, payload.notes, payload.timeRange correctness
 *   - HTML internal interaction logic is NOT tested here (no browser).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createViewerServer } from '../../src/viewer/server.js';
import type { ViewerPayload } from '../../src/viewer/types.js';
import type { GraphData } from '../../src/graph/types.js';
import type { NotesFile, DistilledNote } from '../../src/distill/types.js';
import { makeData } from '../graph/fixture.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeNote(id: string, sessionId: string, invalidAt: string | null = null): DistilledNote {
  return {
    id,
    kind: 'decision',
    title: 'Use JSON graph backend as default',
    body: 'Kuzu has flaky SIGSEGV at exit; JSON backend is stable and fast enough for current graph sizes.',
    files: ['src/graph/factory.ts'],
    anchors: [{ sessionId, seq: 3 }],
    sessionId,
    validAt: '2026-06-01T10:00:00.000Z',
    invalidAt,
    supersededBy: invalidAt ? 'ses-beta#1' : null,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ViewerServer', () => {
  let tmpDir: string;
  let serverUrl: string;
  let server: ReturnType<typeof createViewerServer>;
  let graphData: GraphData;

  beforeAll(async () => {
    // 1. Create temp repo directory with .lore/graph/graph.json and .lore/notes.json
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-viewer-test-'));

    const loreDir = path.join(tmpDir, '.lore');
    const graphDir = path.join(loreDir, 'graph');
    await fs.mkdir(graphDir, { recursive: true });

    graphData = makeData();
    await fs.writeFile(
      path.join(graphDir, 'graph.json'),
      JSON.stringify(graphData, null, 2),
      'utf8',
    );

    // A parseable fake transcript (claude-code jsonl) for the excerpts pipeline.
    // Shape mirrors fixtures/claude-code/edit-tool.jsonl: a user intent, an
    // assistant Edit tool_use, then a toolUseResult that produces a file-edit event.
    // The file-edit gets seq 2 (user-message=0, assistant-message=1, file-edit=2).
    const transcriptPath = path.join(tmpDir, 'ses-excerpt.jsonl');
    const transcriptLines = [
      {
        type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'ses-excerpt',
        cwd: '/x/proj', gitBranch: 'main', version: '2.1.170',
        timestamp: '2026-06-01T10:00:00.000Z', isMeta: false,
        message: { role: 'user', content: 'Add a foo helper to src/foo.ts please.' },
      },
      {
        type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'ses-excerpt',
        timestamp: '2026-06-01T10:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure — adding the foo helper now.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {
              file_path: '/x/proj/src/foo.ts',
              old_string: 'export const x = 1;',
              new_string: 'export const x = 1;\nexport function foo() { return 42; }',
            } },
          ],
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'ses-excerpt',
        timestamp: '2026-06-01T10:00:05.000Z',
        toolUseResult: {
          type: 'update', filePath: '/x/proj/src/foo.ts',
          content: 'export const x = 1;\nexport function foo() { return 42; }\n',
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
            lines: ['+export function foo() { return 42; }'] }],
          originalFile: 'export const x = 1;\n', userModified: false,
        },
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'File updated.', is_error: false },
        ] },
      },
    ];
    await fs.writeFile(
      transcriptPath,
      transcriptLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );

    // report.json: one MatchCandidate for commit abc111 / src/foo.ts pointing at
    // the transcript above, editSeqs = [2] (the file-edit event's seq).
    const reportFile = {
      repo: tmpDir,
      generatedAt: '2026-06-01T12:00:00.000Z',
      schemaVersion: 1,
      commitsTotal: 3,
      commitsMatchedStrong: 1,
      commitsMatchedWeak: 0,
      sessionsSeen: 1,
      sessionsContributing: 1,
      window: { start: '2026-06-01T09:00:00.000Z', end: '2026-06-01T11:00:00.000Z' },
      commitsInWindow: 1,
      strongInWindow: 1,
      weakInWindow: 0,
      matches: [
        {
          commitHash: 'abc111',
          filePath: 'src/foo.ts',
          sessionId: 'ses-excerpt',
          editSeqs: [2],
          sourcePath: transcriptPath,
          matchedVia: 'content',
          matchedLines: 3,
          contentScore: 0.9,
          timeScore: 1,
          confidence: 0.92,
          evidence: ['content: 3 lines'],
        },
      ],
      unmatchedCommits: [],
    };
    await fs.writeFile(
      path.join(loreDir, 'report.json'),
      JSON.stringify(reportFile, null, 2),
      'utf8',
    );

    const notesFile: NotesFile = {
      schemaVersion: 1,
      distilledSessions: { 'ses-alpha': 'abc123' },
      notes: [
        makeNote('ses-alpha#0', 'ses-alpha'),
        makeNote('ses-beta#0', 'ses-beta', '2026-06-02T09:00:00.000Z'),
      ],
    };
    await fs.writeFile(
      path.join(loreDir, 'notes.json'),
      JSON.stringify(notesFile, null, 2),
      'utf8',
    );

    // 2. Start server on OS-assigned port
    server = createViewerServer(tmpDir);
    const port = await server.start(0);
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── HTML endpoint ─────────────────────────────────────────────────────────────

  it('GET / returns 200 with Content-Type text/html', async () => {
    const res = await fetch(serverUrl + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET / body contains <html', async () => {
    const res = await fetch(serverUrl + '/');
    const text = await res.text();
    expect(text).toContain('<html');
  });

  it('GET / body contains D3 CDN script tag', async () => {
    const res = await fetch(serverUrl + '/');
    const text = await res.text();
    expect(text).toContain('cdn.jsdelivr.net/npm/d3@7');
  });

  it('GET / body contains CDN failure notice', async () => {
    const res = await fetch(serverUrl + '/');
    const text = await res.text();
    // The page includes a CDN onerror handler (redesigned page uses showCdnError)
    expect(text).toContain('showCdnError');
  });

  // ── API payload endpoint ──────────────────────────────────────────────────────

  it('GET /api/payload returns 200 with Content-Type application/json', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('GET /api/payload returns valid ViewerPayload shape', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;

    // Top-level fields
    expect(typeof payload.repo).toBe('string');
    expect(typeof payload.generatedAt).toBe('string');
    expect(payload.graph).toBeDefined();
    expect(Array.isArray(payload.notes)).toBe(true);
    // timeRange: null or { start, end }
    if (payload.timeRange !== null) {
      expect(typeof payload.timeRange.start).toBe('string');
      expect(typeof payload.timeRange.end).toBe('string');
    }
  });

  it('payload.repo equals the tmp repo path', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;
    expect(payload.repo).toBe(tmpDir);
  });

  it('payload.graph contains correct session/commit/file counts', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;
    const g = payload.graph;

    expect(g.sessions.length).toBe(graphData.sessions.length);
    expect(g.commits.length).toBe(graphData.commits.length);
    expect(g.files.length).toBe(graphData.files.length);
    expect(g.produced.length).toBe(graphData.produced.length);
    expect(g.touches.length).toBe(graphData.touches.length);
    expect(g.edited.length).toBe(graphData.edited.length);
  });

  it('payload.graph sessions have expected ids', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;
    const ids = payload.graph.sessions.map(s => s.id).sort();
    expect(ids).toEqual(['ses-alpha', 'ses-beta']);
  });

  it('payload.graph produced edges have confidence values', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;
    const confidences = payload.graph.produced.map(p => p.confidence);
    expect(confidences.every(c => typeof c === 'number' && c >= 0 && c <= 1)).toBe(true);
  });

  it('payload.notes contains notes from notes.json', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;
    expect(payload.notes.length).toBe(2);
    const ids = payload.notes.map(n => n.id).sort();
    expect(ids).toEqual(['ses-alpha#0', 'ses-beta#0']);
  });

  it('payload.notes preserves invalidAt for superseded notes', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;
    const superseded = payload.notes.find(n => n.id === 'ses-beta#0');
    expect(superseded).toBeDefined();
    expect(superseded!.invalidAt).toBe('2026-06-02T09:00:00.000Z');
  });

  it('payload.timeRange is computed from commit authorDates', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;
    expect(payload.timeRange).not.toBeNull();
    // Fixture commits: 2026-06-01 and 2026-06-02
    expect(payload.timeRange!.start).toContain('2026-06-01');
    expect(payload.timeRange!.end).toContain('2026-06-02');
  });

  // ── Conversation excerpts (drawer-embedded) ──────────────────────────────────

  it('payload.excerpts is keyed by commitHash with shaped excerpts', async () => {
    const res = await fetch(serverUrl + '/api/payload');
    const payload = await res.json() as ViewerPayload;

    expect(payload.excerpts).toBeDefined();
    const ex = payload.excerpts!;
    // The report has a top candidate for abc111 → excerpts present for it.
    expect(Array.isArray(ex['abc111'])).toBe(true);
    const quotes = ex['abc111']!;
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.length).toBeLessThanOrEqual(2);

    // Shape of each excerpt.
    for (const q of quotes) {
      expect(typeof q.sessionId).toBe('string');
      expect(typeof q.seq).toBe('number');
      expect(q.role === 'user' || q.role === 'assistant').toBe(true);
      expect(typeof q.text).toBe('string');
      expect(q.text.length).toBeLessThanOrEqual(320);
      expect(typeof q.ts).toBe('string');
    }

    // user 优先：若两条都在，第一条应为 user。
    expect(quotes[0]!.role).toBe('user');
    expect(quotes.some((q) => q.text.includes('foo helper'))).toBe(true);
    // anchor 指向正确 session。
    expect(quotes[0]!.sessionId).toBe('ses-excerpt');
  });

  it('payload.excerpts is an empty object when report.json is absent', async () => {
    // tmpDir2 has no report.json — excerpts should be present but empty.
    const tmpDirNR = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-viewer-norep-'));
    const graphDirNR = path.join(tmpDirNR, '.lore', 'graph');
    await fs.mkdir(graphDirNR, { recursive: true });
    await fs.writeFile(
      path.join(graphDirNR, 'graph.json'),
      JSON.stringify(makeData(), null, 2),
      'utf8',
    );
    const srvNR = createViewerServer(tmpDirNR);
    const pNR = await srvNR.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${pNR}/api/payload`);
      const payload = await res.json() as ViewerPayload;
      expect(payload.excerpts).toEqual({});
    } finally {
      await srvNR.stop();
      await fs.rm(tmpDirNR, { recursive: true, force: true });
    }
  });

  // ── Notes absent ─────────────────────────────────────────────────────────────

  it('payload.notes is empty array when notes.json is absent', async () => {
    // Create a second temp dir without notes.json
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-viewer-nonotes-'));
    const graphDir2 = path.join(tmpDir2, '.lore', 'graph');
    await fs.mkdir(graphDir2, { recursive: true });
    await fs.writeFile(
      path.join(graphDir2, 'graph.json'),
      JSON.stringify(makeData(), null, 2),
      'utf8',
    );

    const srv2 = createViewerServer(tmpDir2);
    const p2 = await srv2.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${p2}/api/payload`);
      const payload = await res.json() as ViewerPayload;
      expect(payload.notes).toEqual([]);
    } finally {
      await srv2.stop();
      await fs.rm(tmpDir2, { recursive: true, force: true });
    }
  });

  // ── timeRange absent when no commits ─────────────────────────────────────────

  it('payload.timeRange is null when graph has no commits', async () => {
    const tmpDir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-viewer-nocommits-'));
    const graphDir3 = path.join(tmpDir3, '.lore', 'graph');
    await fs.mkdir(graphDir3, { recursive: true });
    const empty: GraphData = {
      sessions: [],
      commits: [],
      files: [],
      produced: [],
      touches: [],
      edited: [],
    };
    await fs.writeFile(
      path.join(graphDir3, 'graph.json'),
      JSON.stringify(empty, null, 2),
      'utf8',
    );

    const srv3 = createViewerServer(tmpDir3);
    const p3 = await srv3.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${p3}/api/payload`);
      const payload = await res.json() as ViewerPayload;
      expect(payload.timeRange).toBeNull();
    } finally {
      await srv3.stop();
      await fs.rm(tmpDir3, { recursive: true, force: true });
    }
  });

  // ── 404 for unknown paths ─────────────────────────────────────────────────────

  it('GET /unknown returns 404', async () => {
    const res = await fetch(serverUrl + '/unknown');
    expect(res.status).toBe(404);
  });

  // ── Multiple sequential requests ──────────────────────────────────────────────

  it('server handles multiple sequential requests without error', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(serverUrl + '/api/payload');
      expect(res.status).toBe(200);
    }
  });
});
