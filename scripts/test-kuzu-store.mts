/**
 * KuzuGraphStore 行为测试（独立进程版）。
 *
 * 为什么不在 vitest 里：kuzu 原生绑定与 tinypool worker 池不兼容
 * （worker 内加载/关闭会 IPC 崩溃甚至 SIGSEGV），裸 node 下完全稳定。
 * 断言集与 test/graph/stores.test.ts 的 json 后端一一对应，fixture 共享。
 *
 * 运行：npx tsx scripts/test-kuzu-store.mts（npm test 自动串联）
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createKuzuStore } from '../src/graph/kuzu-store.js';
import { makeData } from '../test/graph/fixture.js';

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

async function withStore(fn: (store: ReturnType<typeof createKuzuStore>) => Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-kuzu-standalone-'));
  const store = createKuzuStore(tmpDir);
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('KuzuGraphStore standalone behaviour tests');

await withStore(async (store) => {
  await store.rebuild(makeData());

  await check('whoProducedCommit sorted by confidence desc', async () => {
    const r = await store.whoProducedCommit('abc111');
    assert.equal(r.length, 2);
    assert.ok(r[0]!.confidence > r[1]!.confidence);
    assert.equal(r[0]!.session.id, 'ses-alpha');
    assert.equal(r[0]!.matchedVia, 'sha');
    assert.equal(r[0]!.session.gitBranch, 'feat/x');
  });

  await check('whoProducedCommit empty for unknown hash', async () => {
    assert.deepEqual(await store.whoProducedCommit('nonexistent'), []);
  });

  await check('fileHistory ascending + attributions', async () => {
    const h = await store.fileHistory('src/bar.ts');
    assert.ok(h.length >= 2);
    for (let i = 1; i < h.length; i++) {
      assert.ok(h[i - 1]!.commit.authorDate <= h[i]!.commit.authorDate);
    }
    assert.ok(h.some((x) => x.produced.length > 0));
  });

  await check('fileHistory empty for unknown file', async () => {
    assert.deepEqual(await store.fileHistory('does/not/exist.ts'), []);
  });

  await check('sessionsEditingFile returns sessions + edge details', async () => {
    const e = await store.sessionsEditingFile('src/foo.ts');
    assert.ok(e.length >= 1);
    assert.ok(e[0]!.session.id.length > 0);
    assert.ok(e[0]!.edge.editCount > 0);
    assert.ok(e[0]!.edge.sourcePath.length > 0);
  });

  await check('sessionsEditingFile empty for untouched file', async () => {
    assert.deepEqual(await store.sessionsEditingFile('untouched.ts'), []);
  });

  await check('exportAll round-trips counts', async () => {
    const d = makeData();
    const all = await store.exportAll();
    assert.equal(all.sessions.length, d.sessions.length);
    assert.equal(all.commits.length, d.commits.length);
    assert.equal(all.files.length, d.files.length);
    assert.equal(all.produced.length, d.produced.length);
    assert.equal(all.touches.length, d.touches.length);
    assert.equal(all.edited.length, d.edited.length);
    // 字段保真抽查
    const alpha = all.sessions.find((s) => s.id === 'ses-alpha')!;
    assert.deepEqual(alpha.sourcePaths, ['/home/user/.claude/projects/proj/ses-alpha.jsonl']);
  });

  await check('rebuild is idempotent', async () => {
    await store.rebuild(makeData());
    const r = await store.whoProducedCommit('abc111');
    assert.equal(r.length, 2);
    const all = await store.exportAll();
    assert.equal(all.sessions.length, makeData().sessions.length);
  });

  await check('rebuild with new data replaces old (no stale rows)', async () => {
    await store.rebuild({
      sessions: [{ id: 'only', agent: 'claude-code', startedAt: '2026-06-05T00:00:00Z', endedAt: null, cwd: null, gitBranch: null, sourcePaths: ['/x.jsonl'] }],
      commits: [{ hash: 'zzz999', subject: 'new', authorDate: '2026-06-05T01:00:00Z', committerDate: '2026-06-05T01:00:00Z', isMerge: false }],
      files: [{ path: 'new.ts' }],
      produced: [{ sessionId: 'only', commitHash: 'zzz999', confidence: 0.9, matchedVia: 'content', sourcePath: '/x.jsonl', matchedLines: 5, fileCount: 1 }],
      touches: [{ commitHash: 'zzz999', filePath: 'new.ts', status: 'A', addedLines: 5, removedLines: 0 }],
      edited: [],
    });
    assert.deepEqual(await store.whoProducedCommit('abc111'), []);
    assert.equal((await store.whoProducedCommit('zzz999')).length, 1);
  });

  await check('special characters survive without injection', async () => {
    await store.rebuild({
      sessions: [{ id: 's"q\'\\', agent: 'claude-code', startedAt: '2026-06-05T00:00:00Z', endedAt: null, cwd: null, gitBranch: 'a"b\nc', sourcePaths: ['/p "x".jsonl'] }],
      commits: [{ hash: 'h1', subject: 'subj with "quotes" and \\backslash\n newline', authorDate: '2026-06-05T01:00:00Z', committerDate: '2026-06-05T01:00:00Z', isMerge: false }],
      files: [{ path: 'sp ace/“uni”.ts' }],
      produced: [{ sessionId: 's"q\'\\', commitHash: 'h1', confidence: 1, matchedVia: 'sha', sourcePath: '/p "x".jsonl', matchedLines: 1, fileCount: 1 }],
      touches: [{ commitHash: 'h1', filePath: 'sp ace/“uni”.ts', status: 'A', addedLines: 1, removedLines: 0 }],
      edited: [],
    });
    const r = await store.whoProducedCommit('h1');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.session.id, 's"q\'\\');
    const all = await store.exportAll();
    assert.ok(all.commits[0]!.subject.includes('"quotes"'));
  });

  await check('integral-first confidence batch keeps DOUBLE precision', async () => {
    // 回归：UNWIND struct 类型按第一行推断——第一行 confidence=1（整数值）曾把
    // 整批推成 INT64，0.999 的位模式被重解释成 4.6e18。修复 = 字符串传参 + CAST。
    await store.rebuild({
      sessions: [
        { id: 'sa', agent: 'claude-code', startedAt: '2026-06-05T00:00:00Z', endedAt: null, cwd: null, gitBranch: null, sourcePaths: ['/a.jsonl'] },
        { id: 'sb', agent: 'claude-code', startedAt: '2026-06-05T00:00:00Z', endedAt: null, cwd: null, gitBranch: null, sourcePaths: ['/b.jsonl'] },
      ],
      commits: [{ hash: 'c1', subject: 'x', authorDate: '2026-06-05T01:00:00Z', committerDate: '2026-06-05T01:00:00Z', isMerge: false }],
      files: [],
      produced: [
        { sessionId: 'sa', commitHash: 'c1', confidence: 1, matchedVia: 'sha', sourcePath: '/a.jsonl', matchedLines: 3, fileCount: 1 },
        { sessionId: 'sb', commitHash: 'c1', confidence: 0.999, matchedVia: 'content', sourcePath: '/b.jsonl', matchedLines: 5, fileCount: 1 },
      ],
      touches: [],
      edited: [],
    });
    const r = await store.whoProducedCommit('c1');
    assert.equal(r.length, 2);
    assert.equal(r[0]!.confidence, 1);
    assert.ok(Math.abs(r[1]!.confidence - 0.999) < 1e-9, `expected 0.999, got ${r[1]!.confidence}`);
  });

  await check('empty rebuild produces empty exportAll', async () => {
    await store.rebuild({ sessions: [], commits: [], files: [], produced: [], touches: [], edited: [] });
    const all = await store.exportAll();
    assert.equal(all.sessions.length + all.commits.length + all.files.length + all.produced.length + all.touches.length + all.edited.length, 0);
  });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
// 显式 exit：kuzu 0.11.3 的 PreparedStatement 终结器在自然退出的 NAPI 清理阶段
// use-after-free（SIGSEGV exit 139）；process.exit 跳过终结器，实测干净退出。
process.exit(failures.length > 0 ? 1 : 0);
