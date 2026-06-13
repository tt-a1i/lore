/**
 * 行为测试：KuzuGraphStore 与 JsonGraphStore 跑同一套用例（describe.each）。
 *
 * kuzu 测试使用 os.tmpdir() 临时目录并在 afterEach 清理。
 * 不读真实 ~/.claude transcript。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { JsonGraphStore } from '../../src/graph/json-store.js';
import type { GraphStore, GraphData } from '../../src/graph/types.js';

import { makeData } from './fixture.js';

// ── backend factory table ─────────────────────────────────────────────────────

type BackendLabel = 'kuzu' | 'json';

interface BackendEntry {
  label: BackendLabel;
  createStore: (tmpDir: string) => GraphStore;
}

// kuzu 后端不在 vitest 里跑：原生绑定与 tinypool worker 不兼容（IPC 崩溃/SIGSEGV）。
// kuzu 的同一套行为断言在 scripts/test-kuzu-store.mts，由 `npm test` 串联独立进程执行。
const backends: BackendEntry[] = [
  {
    label: 'json',
    createStore: (tmpDir: string) => new JsonGraphStore(tmpDir),
  },
];

// ── shared behaviour suite ────────────────────────────────────────────────────

describe.each(backends)('GraphStore backend=$label', ({ createStore }) => {
  let tmpDir: string;
  let store: GraphStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-graph-test-'));
    store = createStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // ── 1. rebuild → whoProducedCommit 按 confidence 降序 ──────────────────────

  it('rebuild + whoProducedCommit returns results sorted by confidence desc', async () => {
    const data = makeData();
    await store.rebuild(data);

    const results = await store.whoProducedCommit('abc111');
    expect(results.length).toBe(2);
    expect(results[0]!.confidence).toBeGreaterThan(results[1]!.confidence);
    expect(results[0]!.confidence).toBeCloseTo(0.95);
    expect(results[1]!.confidence).toBeCloseTo(0.60);
    expect(results[0]!.session.id).toBe('ses-alpha');
    expect(results[1]!.session.id).toBe('ses-beta');
    // ProducedInfo includes full session node data
    expect(results[0]!.session.agent).toBe('claude-code');
    expect(results[0]!.session.gitBranch).toBe('feat/x');
    expect(results[0]!.matchedVia).toBe('sha');
  });

  it('whoProducedCommit returns empty array for unknown hash', async () => {
    await store.rebuild(makeData());
    const results = await store.whoProducedCommit('nonexistent');
    expect(results).toEqual([]);
  });

  // ── 2. fileHistory 时间升序 ───────────────────────────────────────────────

  it('fileHistory returns commits in authorDate ascending order', async () => {
    await store.rebuild(makeData());

    const history = await store.fileHistory('src/bar.ts');
    // bar.ts is touched by abc111 (2026-06-01) and def222 (2026-06-02)
    expect(history.length).toBe(2);
    const dates = history.map((h) => h.commit.authorDate);
    expect(dates[0]! < dates[1]!).toBe(true);
    expect(history[0]!.commit.hash).toBe('abc111');
    expect(history[1]!.commit.hash).toBe('def222');
  });

  it('fileHistory includes produced attributions for each commit', async () => {
    await store.rebuild(makeData());

    const history = await store.fileHistory('src/bar.ts');
    // abc111 has 2 producers, def222 has 1
    const h0 = history.find((h) => h.commit.hash === 'abc111');
    expect(h0).toBeDefined();
    expect(h0!.produced.length).toBe(2);
    // sorted by confidence desc
    expect(h0!.produced[0]!.confidence).toBeGreaterThan(h0!.produced[1]!.confidence);
  });

  it('fileHistory filters produced attributions to sessions that matched the queried file', async () => {
    const data = makeData();
    data.produced = data.produced.map((p) => {
      if (p.sessionId === 'ses-alpha' && p.commitHash === 'abc111') {
        return { ...p, files: ['src/bar.ts', 'src/foo.ts'] };
      }
      if (p.sessionId === 'ses-beta' && p.commitHash === 'abc111') {
        return { ...p, files: ['src/bar.ts'] };
      }
      return p;
    });
    await store.rebuild(data);

    const fooHistory = await store.fileHistory('src/foo.ts');
    const fooCommit = fooHistory.find((h) => h.commit.hash === 'abc111')!;
    expect(fooCommit.produced.map((p) => p.sessionId)).toEqual(['ses-alpha']);

    const barHistory = await store.fileHistory('src/bar.ts');
    const barCommit = barHistory.find((h) => h.commit.hash === 'abc111')!;
    expect(barCommit.produced.map((p) => p.sessionId)).toEqual(['ses-alpha', 'ses-beta']);
  });

  it('fileHistory returns empty for unknown file', async () => {
    await store.rebuild(makeData());
    const history = await store.fileHistory('nonexistent.ts');
    expect(history).toEqual([]);
  });

  // ── 3. sessionsEditingFile ────────────────────────────────────────────────

  it('sessionsEditingFile returns all sessions that edited the file', async () => {
    await store.rebuild(makeData());

    const results = await store.sessionsEditingFile('src/bar.ts');
    expect(results.length).toBe(2);
    const sessionIds = results.map((r) => r.session.id).sort();
    expect(sessionIds).toEqual(['ses-alpha', 'ses-beta']);
  });

  it('sessionsEditingFile returns edge details', async () => {
    await store.rebuild(makeData());

    const results = await store.sessionsEditingFile('src/foo.ts');
    expect(results.length).toBe(1);
    expect(results[0]!.session.id).toBe('ses-alpha');
    expect(results[0]!.edge.editCount).toBe(3);
    expect(results[0]!.edge.filePath).toBe('src/foo.ts');
  });

  it('sessionsEditingFile returns empty for file with no edits', async () => {
    await store.rebuild(makeData());
    const results = await store.sessionsEditingFile('README.md');
    expect(results).toEqual([]);
  });

  // ── 4. exportAll 往返一致 ─────────────────────────────────────────────────

  it('exportAll round-trips all GraphData faithfully', async () => {
    const data = makeData();
    await store.rebuild(data);

    const exported = await store.exportAll();

    // Check counts
    expect(exported.sessions.length).toBe(data.sessions.length);
    expect(exported.commits.length).toBe(data.commits.length);
    expect(exported.files.length).toBe(data.files.length);
    expect(exported.produced.length).toBe(data.produced.length);
    expect(exported.touches.length).toBe(data.touches.length);
    expect(exported.edited.length).toBe(data.edited.length);

    // Spot-check session with null fields
    const betaSess = exported.sessions.find((s) => s.id === 'ses-beta');
    expect(betaSess).toBeDefined();
    expect(betaSess!.endedAt).toBeNull();
    expect(betaSess!.cwd).toBeNull();
    expect(betaSess!.gitBranch).toBeNull();

    // Spot-check commit boolean
    const c1 = exported.commits.find((c) => c.hash === 'abc111');
    expect(c1).toBeDefined();
    expect(c1!.isMerge).toBe(false);

    // Spot-check sourcePaths array
    const alphaSess = exported.sessions.find((s) => s.id === 'ses-alpha');
    expect(alphaSess!.sourcePaths.length).toBe(1);
    expect(alphaSess!.sourcePaths[0]).toBe(
      '/home/user/.claude/projects/proj/ses-alpha.jsonl',
    );

    // Spot-check produced confidence preserved
    const p = exported.produced.find(
      (e) => e.sessionId === 'ses-alpha' && e.commitHash === 'abc111',
    );
    expect(p).toBeDefined();
    expect(p!.confidence).toBeCloseTo(0.95);
    expect(p!.matchedVia).toBe('sha');

    // Spot-check touches status
    const t = exported.touches.find(
      (e) => e.commitHash === 'abc111' && e.filePath === 'src/foo.ts',
    );
    expect(t).toBeDefined();
    expect(t!.status).toBe('A');
    expect(t!.addedLines).toBe(20);
  });

  // ── 5. rebuild 幂等 ───────────────────────────────────────────────────────

  it('rebuild is idempotent: second rebuild with same data returns same results', async () => {
    const data = makeData();
    await store.rebuild(data);

    const firstExport = await store.exportAll();

    // Second rebuild with identical data
    await store.rebuild(data);
    const secondExport = await store.exportAll();

    expect(secondExport.sessions.length).toBe(firstExport.sessions.length);
    expect(secondExport.commits.length).toBe(firstExport.commits.length);
    expect(secondExport.produced.length).toBe(firstExport.produced.length);
    expect(secondExport.touches.length).toBe(firstExport.touches.length);
    expect(secondExport.edited.length).toBe(firstExport.edited.length);
  });

  it('rebuild with new data replaces old data (no stale rows)', async () => {
    const data = makeData();
    await store.rebuild(data);

    // Rebuild with minimal data
    const minimal: GraphData = {
      sessions: [
        {
          id: 'new-ses',
          agent: 'claude-code',
          startedAt: '2026-06-10T00:00:00.000Z',
          endedAt: null,
          cwd: null,
          gitBranch: null,
          sourcePaths: [],
        },
      ],
      commits: [],
      files: [],
      produced: [],
      touches: [],
      edited: [],
    };
    await store.rebuild(minimal);

    const exported = await store.exportAll();
    expect(exported.sessions.length).toBe(1);
    expect(exported.sessions[0]!.id).toBe('new-ses');
    expect(exported.commits.length).toBe(0);

    // Old data should be gone
    const oldResult = await store.whoProducedCommit('abc111');
    expect(oldResult).toEqual([]);
  });

  // ── 6. edge cases ─────────────────────────────────────────────────────────

  it('handles special characters in string fields without injection', async () => {
    const data: GraphData = {
      sessions: [
        {
          id: "session-with-'quotes'-and-\"double\"",
          agent: 'claude-code',
          startedAt: '2026-06-01T00:00:00.000Z',
          endedAt: null,
          cwd: '/path/with spaces/and\\backslash',
          gitBranch: 'feat/with-special-chars',
          sourcePaths: [],
        },
      ],
      commits: [
        {
          hash: 'special001',
          subject: "fix: handle O'Brien's edge case",
          authorDate: '2026-06-01T01:00:00.000Z',
          committerDate: '2026-06-01T01:01:00.000Z',
          isMerge: false,
        },
      ],
      files: [],
      produced: [],
      touches: [],
      edited: [],
    };

    await store.rebuild(data);
    const exported = await store.exportAll();
    expect(exported.sessions[0]!.id).toBe("session-with-'quotes'-and-\"double\"");
    expect(exported.commits[0]!.subject).toBe("fix: handle O'Brien's edge case");
    expect(exported.sessions[0]!.cwd).toBe('/path/with spaces/and\\backslash');
  });

  it('empty GraphData rebuild produces empty exportAll', async () => {
    const empty: GraphData = {
      sessions: [],
      commits: [],
      files: [],
      produced: [],
      touches: [],
      edited: [],
    };
    await store.rebuild(empty);
    const exported = await store.exportAll();
    expect(exported.sessions).toEqual([]);
    expect(exported.commits).toEqual([]);
    expect(exported.files).toEqual([]);
    expect(exported.produced).toEqual([]);
    expect(exported.touches).toEqual([]);
    expect(exported.edited).toEqual([]);
  });
});
