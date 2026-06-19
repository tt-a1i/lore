/**
 * 消息索引 writeMessagesIndex / loadMessagesIndex 往返 + 容错测试。
 *
 * - 真实临时目录，原子写读。
 * - 覆盖：往返一致、缺失文件 → null、损坏 JSON → null、schema 不符 → null。
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeMessagesIndex,
  loadMessagesIndex,
  MESSAGES_INDEX_VERSION,
  type MessageIndexEntry,
} from '../../src/messages/index.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'lore-msg-'));
  tmpDirs.push(dir);
  return dir;
}

function entry(sessionId: string, seq: number, text: string): MessageIndexEntry {
  return { sessionId, seq, text };
}

describe('messages index — write/load round-trip', () => {
  it('writes then loads identical entries', async () => {
    const repo = makeRepo();
    const entries: MessageIndexEntry[] = [
      entry('ses-1', 0, 'add foo helper'),
      entry('ses-1', 4, 'rename bar'),
      entry('ses-2', 0, '修复并发 bug'),
    ];

    await writeMessagesIndex(repo, entries);
    const loaded = await loadMessagesIndex(repo);

    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBe(MESSAGES_INDEX_VERSION);
    expect(typeof loaded!.generatedAt).toBe('string');
    expect(loaded!.entries).toEqual(entries);
  });

  it('creates .lore/ when missing and writes messages.json there', async () => {
    const repo = makeRepo();
    expect(existsSync(join(repo, '.lore'))).toBe(false);
    await writeMessagesIndex(repo, [entry('s', 0, 'hi')]);
    expect(existsSync(join(repo, '.lore', 'messages.json'))).toBe(true);
  });

  it('leaves no .tmp-* turds behind after an atomic write', async () => {
    const repo = makeRepo();
    await writeMessagesIndex(repo, [entry('s', 0, 'hi')]);
    const stragglers = readdirSync(join(repo, '.lore')).filter((f) => f.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });

  it('round-trips an empty entries list', async () => {
    const repo = makeRepo();
    await writeMessagesIndex(repo, []);
    const loaded = await loadMessagesIndex(repo);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toEqual([]);
  });

  it('returns null when messages.json is missing', async () => {
    const repo = makeRepo();
    expect(await loadMessagesIndex(repo)).toBeNull();
  });

  it('returns null when messages.json is corrupt JSON', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.lore'), { recursive: true });
    writeFileSync(join(repo, '.lore', 'messages.json'), '{not valid json', 'utf8');
    expect(await loadMessagesIndex(repo)).toBeNull();
  });

  it('returns null on wrong schemaVersion', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.lore'), { recursive: true });
    writeFileSync(
      join(repo, '.lore', 'messages.json'),
      JSON.stringify({ schemaVersion: 99, generatedAt: '', entries: [] }),
      'utf8',
    );
    expect(await loadMessagesIndex(repo)).toBeNull();
  });

  it('filters out malformed entries on load (does not crash)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.lore'), { recursive: true });
    writeFileSync(
      join(repo, '.lore', 'messages.json'),
      JSON.stringify({
        schemaVersion: MESSAGES_INDEX_VERSION,
        generatedAt: '2026-06-18T00:00:00Z',
        entries: [
          { sessionId: 'ok', seq: 1, text: 'good' },
          { sessionId: 'bad', text: 'no seq' }, // missing seq
          null,
          { sessionId: 'ok2', seq: 'not-a-number', text: 'wrong type' },
          { sessionId: 'ok3', seq: 2, text: 'good2' },
        ],
      }),
      'utf8',
    );
    const loaded = await loadMessagesIndex(repo);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries.map((e) => e.sessionId)).toEqual(['ok', 'ok3']);
  });
});
