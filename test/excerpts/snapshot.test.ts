/**
 * 摘录快照 writeSnapshot / loadSnapshot / excerptsForCommit 往返测试。
 *
 * - 真实临时目录，原子写读。
 * - 覆盖：往返一致、缺失文件、损坏 JSON、schema 不符、短/全 hash 前缀命中。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeSnapshot,
  loadSnapshot,
  excerptsForCommit,
  EXCERPTS_SNAPSHOT_VERSION,
} from '../../src/excerpts/snapshot.js';
import type { ViewerExcerpt } from '../../src/viewer/types.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'lore-snap-'));
  tmpDirs.push(dir);
  return dir;
}

function ex(sessionId: string, seq: number, role: 'user' | 'assistant', text: string): ViewerExcerpt {
  return { sessionId, seq, role, text, ts: '2026-06-01T10:00:00.000Z' };
}

describe('excerpts snapshot — write/load round-trip', () => {
  it('writes then loads identical byCommit content', async () => {
    const repo = makeRepo();
    const byCommit: Record<string, ViewerExcerpt[]> = {
      abc111: [ex('ses-1', 0, 'user', 'add foo helper'), ex('ses-1', 1, 'assistant', 'doing it')],
      def222: [ex('ses-2', 3, 'user', 'rename bar')],
    };

    await writeSnapshot(repo, byCommit);
    const loaded = await loadSnapshot(repo);

    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBe(EXCERPTS_SNAPSHOT_VERSION);
    expect(typeof loaded!.generatedAt).toBe('string');
    expect(loaded!.byCommit).toEqual(byCommit);
  });

  it('writes the snapshot at .lore/excerpts.json and creates .lore if missing', async () => {
    const repo = makeRepo();
    expect(existsSync(join(repo, '.lore'))).toBe(false);
    await writeSnapshot(repo, { abc: [ex('s', 0, 'user', 'hi')] });
    expect(existsSync(join(repo, '.lore', 'excerpts.json'))).toBe(true);
  });

  it('leaves no .tmp-* turds behind after an atomic write', async () => {
    const repo = makeRepo();
    await writeSnapshot(repo, { abc: [ex('s', 0, 'user', 'hi')] });
    const stragglers = readdirSync(join(repo, '.lore')).filter((f) => f.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });

  it('round-trips an empty byCommit map', async () => {
    const repo = makeRepo();
    await writeSnapshot(repo, {});
    const loaded = await loadSnapshot(repo);
    expect(loaded).not.toBeNull();
    expect(loaded!.byCommit).toEqual({});
  });

  it('overwrites a prior snapshot (idempotent re-scan)', async () => {
    const repo = makeRepo();
    await writeSnapshot(repo, { old: [ex('s', 0, 'user', 'stale')] });
    await writeSnapshot(repo, { fresh: [ex('s', 1, 'user', 'current')] });
    const loaded = await loadSnapshot(repo);
    expect(loaded!.byCommit).toEqual({ fresh: [ex('s', 1, 'user', 'current')] });
    expect(loaded!.byCommit['old']).toBeUndefined();
  });
});

describe('excerpts snapshot — loadSnapshot resilience', () => {
  it('returns null when the file is absent', async () => {
    const repo = makeRepo();
    expect(await loadSnapshot(repo)).toBeNull();
  });

  it('returns null on corrupt JSON', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.lore'), { recursive: true });
    writeFileSync(join(repo, '.lore', 'excerpts.json'), '{ this is not json', 'utf8');
    expect(await loadSnapshot(repo)).toBeNull();
  });

  it('returns null when schemaVersion mismatches', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.lore'), { recursive: true });
    writeFileSync(
      join(repo, '.lore', 'excerpts.json'),
      JSON.stringify({ schemaVersion: 999, generatedAt: '', byCommit: {} }),
      'utf8',
    );
    expect(await loadSnapshot(repo)).toBeNull();
  });

  it('returns null when byCommit is missing', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.lore'), { recursive: true });
    writeFileSync(
      join(repo, '.lore', 'excerpts.json'),
      JSON.stringify({ schemaVersion: EXCERPTS_SNAPSHOT_VERSION, generatedAt: '' }),
      'utf8',
    );
    expect(await loadSnapshot(repo)).toBeNull();
  });
});

describe('excerptsForCommit — hash matching', () => {
  const snapshot = {
    schemaVersion: EXCERPTS_SNAPSHOT_VERSION,
    generatedAt: '2026-06-01T10:00:00.000Z',
    byCommit: {
      '0123456789abcdef0123456789abcdef01234567': [ex('s', 0, 'user', 'full hash entry')],
      abcd123: [ex('s', 1, 'user', 'short hash entry')],
    },
  };

  it('exact match returns the excerpts', () => {
    const r = excerptsForCommit(snapshot, '0123456789abcdef0123456789abcdef01234567');
    expect(r?.[0]!.text).toBe('full hash entry');
  });

  it('full query hash matches a stored short hash (prefix)', () => {
    // snapshot stored short "abcd123"; query is the full hash starting with it.
    const r = excerptsForCommit(snapshot, 'abcd1234567890abcdef');
    expect(r?.[0]!.text).toBe('short hash entry');
  });

  it('short query hash matches a stored full hash (prefix)', () => {
    const r = excerptsForCommit(snapshot, '0123456');
    expect(r?.[0]!.text).toBe('full hash entry');
  });

  it('returns null for an unknown commit', () => {
    expect(excerptsForCommit(snapshot, 'ffffffffff')).toBeNull();
  });
});
