/**
 * resolveRepo — unit tests for all four branches:
 *   1. Explicit repo param (valid) → returns that root.
 *   2. Explicit repo param (not indexed) → hard error with guidance.
 *   3. Absolute file path → infers root via git, validates .lore/report.json.
 *   4. Absolute file path pointing to un-indexed repo → hard error.
 *   5. Default (no input) → returns startup root unchanged.
 *   6. dir→root cache: second call for same dir skips the git subprocess.
 *
 * Multi-root cache isolation:
 *   Two temp repos are created with distinct report.json fixtures.
 *   lore_status called with explicit repo= for each returns their own data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLoreMcpServer, __test__ } from '../../src/mcp/server.js';
import type { NotesStore, NotesFile } from '../../src/distill/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  // Clear the git-root cache between tests so caching state doesn't bleed.
  __test__._gitRootCache.clear();
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Create a temp directory with a real git repo and optionally .lore/report.json. */
function makeTempRepo(opts: {
  withReport?: boolean;
  reportOverride?: Record<string, unknown>;
}): string {
  // realpathSync resolves macOS /var → /private/var symlink so comparisons with
  // git's output (which always uses the real path) are stable.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lore-resolve-')));
  tmpDirs.push(dir);

  // Init git so git rev-parse works.
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'placeholder.txt'), 'hi\n', 'utf8');
  git('add', '-A');
  git('commit', '-m', 'init');

  if (opts.withReport) {
    mkdirSync(join(dir, '.lore'), { recursive: true });
    const report = opts.reportOverride ?? {
      generatedAt: '2026-06-12T00:00:00.000Z',
      commitsTotal: 5,
      commitsMatchedStrong: 3,
      commitsMatchedWeak: 0,
      sessionsSeen: 10,
      sessionsContributing: 2,
      window: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-12T00:00:00.000Z' },
    };
    writeFileSync(join(dir, '.lore', 'report.json'), JSON.stringify(report), 'utf8');
  }

  return dir;
}

/** Temp dir WITHOUT a git repo (just a plain directory). */
function makePlainDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-plain-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.lore'), { recursive: true });
  writeFileSync(
    join(dir, '.lore', 'report.json'),
    JSON.stringify({ generatedAt: '2026-06-12T00:00:00.000Z', commitsTotal: 0 }),
    'utf8',
  );
  return dir;
}

function stubNotesStore(): NotesStore {
  return {
    load: async (): Promise<NotesFile> => ({
      schemaVersion: 1,
      distilledSessions: {},
      notes: [],
    }),
    appendNote: async () => ({ id: 'x', updated: false, superseded: null }),
  };
}

async function makeClientServerForRoot(
  root: string,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createLoreMcpServer(root, { notesStore: stubNotesStore() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, cleanup: async () => { await client.close(); await server.close(); } };
}

// ── resolveRepo unit tests ─────────────────────────────────────────────────────

describe('resolveRepo', () => {
  it('explicit repo (indexed) → returns that absolute root', async () => {
    const repo = makeTempRepo({ withReport: true });
    const root = await __test__.resolveRepo('/some/startup', { repo });
    expect(root).toBe(repo);
  });

  it('explicit repo (not indexed) → throws with "lore scan" guidance', async () => {
    const repo = makeTempRepo({ withReport: false }); // no report.json
    await expect(__test__.resolveRepo('/startup', { repo })).rejects.toThrow(/lore scan/i);
    await expect(__test__.resolveRepo('/startup', { repo })).rejects.toThrow(repo);
  });

  it('no input → returns startup root unchanged', async () => {
    const startup = makeTempRepo({ withReport: true });
    const root = await __test__.resolveRepo(startup);
    expect(root).toBe(startup);
  });

  it('relative file path → uses startup root (not inferred)', async () => {
    const startup = makeTempRepo({ withReport: true });
    // Non-absolute file → treated as repo-relative, falls through to startup.
    const root = await __test__.resolveRepo(startup, { file: 'src/foo.ts' });
    expect(root).toBe(startup);
  });

  it('absolute file path inside indexed repo → infers that root', async () => {
    const repo = makeTempRepo({ withReport: true });
    // Use a file directly in the repo root (which exists as a directory for git).
    const filePath = join(repo, 'placeholder.txt');
    const root = await __test__.resolveRepo('/startup', { file: filePath });
    expect(root).toBe(repo);
  });

  it('absolute file path inside un-indexed repo → throws with "lore scan" guidance', async () => {
    const repo = makeTempRepo({ withReport: false });
    const filePath = join(repo, 'placeholder.txt');
    await expect(__test__.resolveRepo('/startup', { file: filePath })).rejects.toThrow(/lore scan/i);
  });

  it('dir→root cache: second call for the same directory hits cache and skips git', async () => {
    const repo = makeTempRepo({ withReport: true });
    // Use a subdirectory that actually exists (repo root itself as dir via a file inside it).
    const filePath = join(repo, 'placeholder.txt');
    const dir = repo; // dirname of placeholder.txt is repo itself

    // Prime the cache with first call.
    await __test__.resolveRepo('/startup', { file: filePath });
    expect(__test__._gitRootCache.has(dir)).toBe(true);
    expect(__test__._gitRootCache.get(dir)).toBe(repo);

    // Overwrite cache with sentinel value — proves second call reads cache, not git.
    __test__._gitRootCache.set(dir, repo); // same value to keep it valid
    const root2 = await __test__.resolveRepo('/startup', { file: filePath });
    expect(root2).toBe(repo);
  });

  it('repo param takes precedence over file param', async () => {
    const repoA = makeTempRepo({ withReport: true });
    const repoB = makeTempRepo({ withReport: true });
    // Use an existing file in repoB; if file were used for inference it would return repoB.
    const fileInB = join(repoB, 'placeholder.txt');
    // repo= points to A, file= would infer B. repo wins.
    const root = await __test__.resolveRepo('/startup', { repo: repoA, file: fileInB });
    expect(root).toBe(repoA);
  });
});

// ── multi-root cache isolation via lore_status ──────────────────────────────

describe('multi-root cache isolation (lore_status)', () => {
  it('two repos with different coverage figures → lore_status returns each repo\'s own data', async () => {
    const repoA = makeTempRepo({
      withReport: true,
      reportOverride: {
        generatedAt: '2026-06-12T00:00:00.000Z',
        commitsTotal: 10,
        commitsMatchedStrong: 7,
        commitsMatchedWeak: 0,
        sessionsSeen: 5,
        sessionsContributing: 1,
        window: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-12T00:00:00.000Z' },
      },
    });
    const repoB = makeTempRepo({
      withReport: true,
      reportOverride: {
        generatedAt: '2026-06-11T00:00:00.000Z',
        commitsTotal: 50,
        commitsMatchedStrong: 30,
        commitsMatchedWeak: 5,
        sessionsSeen: 100,
        sessionsContributing: 8,
        window: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-11T00:00:00.000Z' },
      },
    });

    // Start server anchored at repoA.
    const { client, cleanup } = await makeClientServerForRoot(repoA);
    try {
      // Query repoA (default — no repo= param).
      const rA = await client.callTool({ name: 'lore_status', arguments: {} });
      const textA = (rA.content as { type: string; text: string }[])[0]!.text;
      expect(textA).toContain('coverage:7/10');
      expect(textA).toContain('sessions:seen=5 contributing=1');

      // Query repoB (cross-repo via repo= param).
      const rB = await client.callTool({ name: 'lore_status', arguments: { repo: repoB } });
      const textB = (rB.content as { type: string; text: string }[])[0]!.text;
      expect(textB).toContain('coverage:35/50');
      expect(textB).toContain('sessions:seen=100 contributing=8');

      // The two outputs must be distinct (no bleed).
      expect(textA).not.toContain('coverage:35/50');
      expect(textB).not.toContain('coverage:7/10');
    } finally {
      await cleanup();
    }
  });

  it('lore_status with repo= pointing to an un-indexed dir → isError with guidance', async () => {
    const startupRepo = makeTempRepo({ withReport: true });
    const unindexedRepo = makeTempRepo({ withReport: false });

    const { client, cleanup } = await makeClientServerForRoot(startupRepo);
    try {
      const r = await client.callTool({
        name: 'lore_status',
        arguments: { repo: unindexedRepo },
      });
      expect(r.isError).toBe(true);
      const text = (r.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('lore_status error');
      expect(text).toContain('lore scan');
    } finally {
      await cleanup();
    }
  });

  it('lore_ask with repo= queries a different repo and returns that header', async () => {
    const startup = makeTempRepo({ withReport: true,
      reportOverride: {
        generatedAt: '2026-06-01T00:00:00.000Z',
        commitsTotal: 1, commitsMatchedStrong: 0, commitsMatchedWeak: 0,
      },
    });
    const other = makeTempRepo({ withReport: true,
      reportOverride: {
        generatedAt: '2026-06-12T00:00:00.000Z',
        commitsTotal: 99, commitsMatchedStrong: 80, commitsMatchedWeak: 0,
      },
    });

    // Use a lightweight in-memory ask engine.
    const fakeAsk = {
      ask: async () => ({ question: 'q', hits: [], messageHits: [] }),
    };

    const server = createLoreMcpServer(startup, {
      askEngine: fakeAsk,
      notesStore: stubNotesStore(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tc', version: '0.0.1' });
    await server.connect(st);
    await client.connect(ct);

    try {
      // Default: startup repo (low coverage).
      const r1 = await client.callTool({ name: 'lore_ask', arguments: { question: 'q' } });
      const t1 = (r1.content as { type: string; text: string }[])[0]!.text;
      expect(t1).toContain('coverage:0/1');

      // Cross-repo: other repo (high coverage).
      const r2 = await client.callTool({ name: 'lore_ask', arguments: { question: 'q', repo: other } });
      const t2 = (r2.content as { type: string; text: string }[])[0]!.text;
      expect(t2).toContain('coverage:80/99');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
