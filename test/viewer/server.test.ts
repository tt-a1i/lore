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
    // The page includes an onerror handler and a #cdn-error element
    expect(text).toContain('cdn-error');
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
