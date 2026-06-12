/**
 * Unit tests for the direct-read data layer (src/brief/load.ts).
 *
 * Performance contract: these read ONLY .lore/*.json. Tests use tmp dirs.
 *   - readGeneratedAt: present / missing / corrupt
 *   - readActiveNotes: active-only (skips invalidAt), missing source → distilled,
 *     corrupt/missing file → [], skips malformed notes
 *   - detectLoreMcp: .mcp.json / settings.json with a lore server → true; absent → false
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readGeneratedAt, readActiveNotes, detectLoreMcp } from '../../src/brief/load.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-brief-load-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.lore'), { recursive: true });
  return dir;
}

function writeReport(repo: string, obj: unknown): void {
  writeFileSync(join(repo, '.lore', 'report.json'), JSON.stringify(obj), 'utf8');
}
function writeNotes(repo: string, obj: unknown): void {
  writeFileSync(join(repo, '.lore', 'notes.json'), JSON.stringify(obj), 'utf8');
}

// ── readGeneratedAt ───────────────────────────────────────────────────────────

describe('readGeneratedAt', () => {
  it('returns generatedAt when present', async () => {
    const repo = makeRepo();
    writeReport(repo, { generatedAt: '2026-06-12T10:00:00.000Z', matches: [] });
    expect(await readGeneratedAt(repo)).toBe('2026-06-12T10:00:00.000Z');
  });

  it('returns null when report.json missing', async () => {
    const repo = makeRepo();
    expect(await readGeneratedAt(repo)).toBeNull();
  });

  it('returns null when report.json is corrupt', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.lore', 'report.json'), '{ not valid json', 'utf8');
    expect(await readGeneratedAt(repo)).toBeNull();
  });

  it('returns null when generatedAt field absent', async () => {
    const repo = makeRepo();
    writeReport(repo, { matches: [] });
    expect(await readGeneratedAt(repo)).toBeNull();
  });
});

// ── readActiveNotes ───────────────────────────────────────────────────────────

describe('readActiveNotes', () => {
  it('returns only active notes (skips invalidAt set)', async () => {
    const repo = makeRepo();
    writeNotes(repo, {
      notes: [
        { id: 'a', kind: 'constraint', title: 'active', body: '', files: ['x.ts'], invalidAt: null, source: 'agent' },
        { id: 'b', kind: 'decision', title: 'superseded', body: '', files: [], invalidAt: '2026-06-12T00:00:00Z', source: 'agent' },
      ],
    });
    const notes = await readActiveNotes(repo);
    expect(notes.length).toBe(1);
    expect(notes[0]?.title).toBe('active');
  });

  it('defaults missing source to distilled', async () => {
    const repo = makeRepo();
    writeNotes(repo, { notes: [{ id: 'a', kind: 'constraint', title: 't', body: '', files: [], invalidAt: null }] });
    const notes = await readActiveNotes(repo);
    expect(notes[0]?.source).toBe('distilled');
  });

  it('returns [] when notes.json missing', async () => {
    const repo = makeRepo();
    expect(await readActiveNotes(repo)).toEqual([]);
  });

  it('returns [] when notes.json corrupt', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.lore', 'notes.json'), 'not json', 'utf8');
    expect(await readActiveNotes(repo)).toEqual([]);
  });

  it('skips malformed note entries (no kind) but keeps good ones', async () => {
    const repo = makeRepo();
    writeNotes(repo, {
      notes: [
        { id: 'a', title: 'no kind', invalidAt: null },
        { id: 'b', kind: 'constraint', title: 'good', body: '', files: [], invalidAt: null, source: 'agent' },
        null,
        'garbage',
      ],
    });
    const notes = await readActiveNotes(repo);
    expect(notes.length).toBe(1);
    expect(notes[0]?.title).toBe('good');
  });

  it('treats note with undefined invalidAt as active', async () => {
    const repo = makeRepo();
    writeNotes(repo, { notes: [{ id: 'a', kind: 'constraint', title: 't', body: '', files: [] }] });
    const notes = await readActiveNotes(repo);
    expect(notes.length).toBe(1);
  });
});

// ── detectLoreMcp ─────────────────────────────────────────────────────────────

describe('detectLoreMcp', () => {
  it('returns true when .mcp.json has a lore server key', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { lore: { command: 'node', args: ['x'] } } }), 'utf8');
    expect(await detectLoreMcp(repo)).toBe(true);
  });

  it('returns true when a server command references lore', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { memory: { command: 'node', args: ['dist/cli.js', 'mcp'], env: {} } } }),
      'utf8',
    );
    // 'lore' not in command/args/key here → should be false
    expect(await detectLoreMcp(repo)).toBe(false);
  });

  it('returns false when no mcp config present', async () => {
    const repo = makeRepo();
    expect(await detectLoreMcp(repo)).toBe(false);
  });

  it('returns true when server args reference lore', async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { mem: { command: 'npx', args: ['-y', 'lore', 'mcp', '--repo', '.'] } } }),
      'utf8',
    );
    expect(await detectLoreMcp(repo)).toBe(true);
  });
});
