/**
 * NotesStore unit tests.
 *
 * All fixtures synthetic — temp dirs, no real ~/.claude, no LLM, no git.
 * Exercises the contract in distill/types.ts:
 *   - load: missing file → empty shell; missing `source` → 'distilled'
 *   - load: format-compatible with orchestrate.ts's notes.json shape
 *   - appendNote: id allocation (agent-…), validAt=now, source recorded
 *   - appendNote: same-title agent dedup → update in place (id preserved)
 *   - appendNote: human notes are NOT title-deduped
 *   - appendNote: supersedes marks the target invalid + supersededBy
 *   - appendNote: atomic write (valid JSON on disk) + read-before-write merge
 *     (a note written by a "concurrent" writer between load and append survives)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNotesStore } from '../../src/notes/store.js';
import type { NotesFile, DistilledNote } from '../../src/distill/types.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'lore-notes-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.lore'), { recursive: true });
  return dir;
}

function notesPath(repo: string): string {
  return join(repo, '.lore', 'notes.json');
}

function readNotes(repo: string): NotesFile {
  return JSON.parse(readFileSync(notesPath(repo), 'utf8')) as NotesFile;
}

/** A distilled note as orchestrate.ts writes it (note: includes source here). */
function distilledNote(over: Partial<DistilledNote> = {}): DistilledNote {
  return {
    id: 'sess-1#0',
    kind: 'decision',
    title: 'Use Kuzu as the embedded graph store',
    body: 'Picked Kuzu over SQLite-graph for native graph queries.',
    files: ['src/graph/kuzu-store.ts'],
    anchors: [{ sessionId: 'sess-1', seq: 12 }],
    sessionId: 'sess-1',
    validAt: '2026-06-10T10:00:00.000Z',
    invalidAt: null,
    supersededBy: null,
    source: 'distilled',
    ...over,
  };
}

describe('NotesStore.load', () => {
  it('missing file → empty shell', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    const file = await store.load(repo);
    expect(file).toEqual({ schemaVersion: 1, distilledSessions: {}, notes: [] });
  });

  it('missing `source` field on a note → treated as distilled', async () => {
    const repo = makeRepo();
    // Write a note WITHOUT a source field (legacy / orchestrate format).
    const legacy = distilledNote();
    delete (legacy as Partial<DistilledNote>).source;
    writeFileSync(
      notesPath(repo),
      JSON.stringify({ schemaVersion: 1, distilledSessions: {}, notes: [legacy] }, null, 2),
      'utf8',
    );
    const store = createNotesStore();
    const file = await store.load(repo);
    expect(file.notes).toHaveLength(1);
    expect(file.notes[0]!.source).toBe('distilled');
  });

  it('is format-compatible with orchestrate.ts notes.json (distilledSessions + distilledAt)', async () => {
    const repo = makeRepo();
    writeFileSync(
      notesPath(repo),
      JSON.stringify(
        {
          schemaVersion: 1,
          distilledSessions: { 'sess-1': 'hashabc' },
          notes: [distilledNote()],
          distilledAt: '2026-06-11T09:00:00.000Z',
        },
        null,
        2,
      ),
      'utf8',
    );
    const store = createNotesStore();
    const file = await store.load(repo);
    expect(file.distilledSessions).toEqual({ 'sess-1': 'hashabc' });
    expect(file.distilledAt).toBe('2026-06-11T09:00:00.000Z');
    expect(file.notes).toHaveLength(1);
  });

  it('corrupt JSON → empty shell (defensive, never throws)', async () => {
    const repo = makeRepo();
    writeFileSync(notesPath(repo), '{ this is not valid json', 'utf8');
    const store = createNotesStore();
    const file = await store.load(repo);
    expect(file.notes).toEqual([]);
  });
});

describe('NotesStore.appendNote', () => {
  it('allocates an agent id, sets validAt≈now, records source', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    const before = Date.now();
    const res = await store.appendNote(repo, {
      kind: 'constraint',
      title: 'Never read real ~/.claude in tests',
      body: 'Tests must build fixtures; reading the real home is flaky and unsafe.',
      source: 'agent',
    });
    expect(res.updated).toBe(false);
    expect(res.superseded).toBeNull();
    expect(res.id).toMatch(/^agent-/);

    const file = readNotes(repo);
    expect(file.notes).toHaveLength(1);
    const n = file.notes[0]!;
    expect(n.source).toBe('agent');
    expect(n.kind).toBe('constraint');
    expect(n.invalidAt).toBeNull();
    expect(Date.parse(n.validAt)).toBeGreaterThanOrEqual(before);
  });

  it('same-title agent note → updates in place (id preserved, no duplicate)', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    const first = await store.appendNote(repo, {
      kind: 'decision',
      title: 'Use JSON graph backend as fallback',
      body: 'Original rationale.',
      files: ['src/graph/json-store.ts'],
      source: 'agent',
    });
    const second = await store.appendNote(repo, {
      kind: 'decision',
      title: 'Use JSON graph backend as fallback',
      body: 'Updated rationale with more detail.',
      files: ['src/graph/json-store.ts', 'src/graph/factory.ts'],
      source: 'agent',
    });
    expect(second.updated).toBe(true);
    expect(second.id).toBe(first.id);

    const file = readNotes(repo);
    expect(file.notes).toHaveLength(1);
    expect(file.notes[0]!.body).toBe('Updated rationale with more detail.');
    expect(file.notes[0]!.files).toEqual(['src/graph/json-store.ts', 'src/graph/factory.ts']);
  });

  it('does NOT dedup against a superseded (invalid) same-title agent note', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    const first = await store.appendNote(repo, {
      kind: 'decision',
      title: 'Same title',
      body: 'v1',
      source: 'agent',
    });
    // Supersede the first with a different-title note pointing at it.
    await store.appendNote(repo, {
      kind: 'decision',
      title: 'Replacement',
      body: 'v2',
      source: 'agent',
      supersedes: first.id,
    });
    // Now appending "Same title" again must create a NEW note (old one is invalid).
    const third = await store.appendNote(repo, {
      kind: 'decision',
      title: 'Same title',
      body: 'v3',
      source: 'agent',
    });
    expect(third.updated).toBe(false);
    expect(third.id).not.toBe(first.id);
  });

  it('human notes are NOT title-deduped (intentional repeats allowed)', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    const a = await store.appendNote(repo, {
      kind: 'constraint',
      title: 'Identical human title',
      body: 'first',
      source: 'human',
    });
    const b = await store.appendNote(repo, {
      kind: 'constraint',
      title: 'Identical human title',
      body: 'second',
      source: 'human',
    });
    expect(b.updated).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(readNotes(repo).notes).toHaveLength(2);
  });

  it('supersedes marks the target invalid + supersededBy = new id', async () => {
    const repo = makeRepo();
    // Seed a distilled note to supersede.
    writeFileSync(
      notesPath(repo),
      JSON.stringify(
        { schemaVersion: 1, distilledSessions: {}, notes: [distilledNote({ id: 'sess-1#0' })] },
        null,
        2,
      ),
      'utf8',
    );
    const store = createNotesStore();
    const res = await store.appendNote(repo, {
      kind: 'decision',
      title: 'Switch from Kuzu to plain JSON store',
      body: 'Kuzu native binding too fragile across platforms; JSON store is the new default.',
      files: ['src/graph/json-store.ts'],
      source: 'agent',
      supersedes: 'sess-1#0',
    });
    expect(res.superseded).toBe('sess-1#0');

    const file = readNotes(repo);
    const old = file.notes.find((n) => n.id === 'sess-1#0')!;
    expect(old.invalidAt).not.toBeNull();
    expect(old.supersededBy).toBe(res.id);
    // The new note is valid.
    const fresh = file.notes.find((n) => n.id === res.id)!;
    expect(fresh.invalidAt).toBeNull();
  });

  it('supersedes a non-existent / already-invalid id → no-op (superseded=null)', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    const res = await store.appendNote(repo, {
      kind: 'decision',
      title: 'Points at nothing',
      body: 'There is no note with this id.',
      source: 'agent',
      supersedes: 'does-not-exist#9',
    });
    expect(res.superseded).toBeNull();
    expect(readNotes(repo).notes).toHaveLength(1);
  });

  it('writes valid JSON atomically (no leftover tmp files, parseable result)', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    await store.appendNote(repo, {
      kind: 'decision',
      title: 'Atomic write check',
      body: 'Ensures tmp+rename leaves a clean directory.',
      source: 'agent',
    });
    expect(existsSync(notesPath(repo))).toBe(true);
    // No leftover temp files in .lore.
    const leftovers = readdirSync(join(repo, '.lore')).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
    // Result is valid JSON.
    expect(() => readNotes(repo)).not.toThrow();
  });

  it('read-before-write: a note added between load and the next append survives', async () => {
    const repo = makeRepo();
    const store = createNotesStore();
    // First append.
    await store.appendNote(repo, {
      kind: 'decision',
      title: 'Writer A note',
      body: 'a',
      source: 'agent',
    });
    // Simulate a concurrent writer that appended directly to disk.
    const onDisk = readNotes(repo);
    onDisk.notes.push(distilledNote({ id: 'concurrent#0', title: 'Concurrent note' }));
    writeFileSync(notesPath(repo), JSON.stringify(onDisk, null, 2), 'utf8');
    // Now a second store.appendNote must re-read and preserve the concurrent note.
    await store.appendNote(repo, {
      kind: 'decision',
      title: 'Writer B note',
      body: 'b',
      source: 'agent',
    });
    const final = readNotes(repo);
    const titles = final.notes.map((n) => n.title).sort();
    expect(titles).toEqual(['Concurrent note', 'Writer A note', 'Writer B note']);
  });

  it('in-process concurrent appends: 50 parallel writes never lose a note', async () => {
    // 回归 P0-1：之前 read-modify-write 之间没串行，并发 Promise.all 会丢笔记。
    // 修复后进程内 mutex 应保证 N 次 append 全部落盘。
    const repo = makeRepo();
    const store = createNotesStore();
    const N = 50;

    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      tasks.push(
        store.appendNote(repo, {
          kind: 'decision',
          title: `concurrent note ${i}`, // 每个唯一 title — 不会触发 dedup
          body: `body ${i}`,
          source: 'human', // human 来源不做 title 防重，所以全部都应是新 note
        }),
      );
    }
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(N);

    const final = readNotes(repo);
    expect(final.notes).toHaveLength(N);
    const titles = new Set(final.notes.map((n) => n.title));
    for (let i = 0; i < N; i++) {
      expect(titles.has(`concurrent note ${i}`)).toBe(true);
    }
    // 所有 id 唯一（crypto 随机不该碰撞）
    const ids = new Set(final.notes.map((n) => n.id));
    expect(ids.size).toBe(N);
  });

  it('in-process concurrent agent dedup: same title only ever yields one note', async () => {
    // agent 来源的 title 防重在并发下也必须成立——50 次并发同 title append
    // 应该恰好落 1 条 note（其余都走 update-in-place）。
    const repo = makeRepo();
    const store = createNotesStore();
    const N = 50;

    const tasks: Promise<{ id: string; updated: boolean }>[] = [];
    for (let i = 0; i < N; i++) {
      tasks.push(
        store.appendNote(repo, {
          kind: 'decision',
          title: 'singleton',
          body: `body ${i}`,
          source: 'agent',
        }) as Promise<{ id: string; updated: boolean }>,
      );
    }
    const results = await Promise.all(tasks);
    // 第一个是新增，其余是 update。
    const created = results.filter((r) => !r.updated);
    const updated = results.filter((r) => r.updated);
    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(N - 1);

    const final = readNotes(repo);
    expect(final.notes).toHaveLength(1);
    expect(final.notes[0]!.title).toBe('singleton');
  });

  it('preserves distilledSessions / distilledAt across an agent append', async () => {
    const repo = makeRepo();
    writeFileSync(
      notesPath(repo),
      JSON.stringify(
        {
          schemaVersion: 1,
          distilledSessions: { 'sess-1': 'h' },
          notes: [],
          distilledAt: '2026-06-11T00:00:00.000Z',
        },
        null,
        2,
      ),
      'utf8',
    );
    const store = createNotesStore();
    await store.appendNote(repo, {
      kind: 'decision',
      title: 'Agent note',
      body: 'agent notes must not clobber distill bookkeeping',
      source: 'agent',
    });
    const file = readNotes(repo);
    expect(file.distilledSessions).toEqual({ 'sess-1': 'h' });
    expect(file.distilledAt).toBe('2026-06-11T00:00:00.000Z');
  });
});
