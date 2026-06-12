/**
 * Tests for GitHistoryReader (src/git/history.ts).
 *
 * Each test builds a temporary git repository from scratch using shell
 * commands so the parser is exercised against real git output.
 * No ~/.claude transcript files are read.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitHistoryReader } from '../../src/git/history.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function git(repoDir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-test-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function writeFile(repoDir: string, relPath: string, content: string) {
  const full = join(repoDir, relPath);
  const dirPart = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dirPart, { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function commit(repoDir: string, message: string, env?: Record<string, string>) {
  git(repoDir, 'add', '-A');
  execFileSync(
    'git',
    ['-C', repoDir, 'commit', '-m', message],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
  return git(repoDir, 'rev-parse', 'HEAD');
}

// Repos created during a test; cleaned up in afterEach.
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRepo(): string {
  const dir = initRepo();
  tmpDirs.push(dir);
  return dir;
}

// ─── test suite ──────────────────────────────────────────────────────────────

describe('GitHistoryReader.readHistory', () => {
  it('returns commits in chronological (reverse) order', async () => {
    const repo = makeRepo();

    writeFile(repo, 'a.txt', 'first\n');
    const sha1 = commit(repo, 'first commit');

    writeFile(repo, 'b.txt', 'second\n');
    const sha2 = commit(repo, 'second commit');

    const history = await gitHistoryReader.readHistory(repo);
    expect(history).toHaveLength(2);
    expect(history[0]!.hash).toBe(sha1);
    expect(history[1]!.hash).toBe(sha2);
  });

  it('parses authorDate and committerDate as ISO8601 strings', async () => {
    const repo = makeRepo();
    writeFile(repo, 'x.txt', 'hello\n');
    commit(repo, 'date test');

    const [c] = await gitHistoryReader.readHistory(repo);
    expect(c!.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(c!.committerDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('parses added lines from a simple edit commit', async () => {
    const repo = makeRepo();

    writeFile(repo, 'hello.ts', 'const a = 1;\n');
    commit(repo, 'init');

    writeFile(repo, 'hello.ts', 'const a = 1;\nconst b = 2;\n');
    commit(repo, 'add b');

    const history = await gitHistoryReader.readHistory(repo);
    expect(history).toHaveLength(2);
    const second = history[1]!;
    expect(second.files).toHaveLength(1);
    const file = second.files[0]!;
    expect(file.path).toBe('hello.ts');
    expect(file.status).toBe('M');
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.addedLines).toContain('const b = 2;');
    expect(hunk.removedLines).toHaveLength(0);
  });

  it('parses removed lines in a deletion commit', async () => {
    const repo = makeRepo();

    writeFile(repo, 'data.txt', 'line1\nline2\nline3\n');
    commit(repo, 'init');

    writeFile(repo, 'data.txt', 'line1\nline3\n');
    commit(repo, 'remove line2');

    const history = await gitHistoryReader.readHistory(repo);
    const second = history[1]!;
    const hunk = second.files[0]!.hunks[0]!;
    expect(hunk.removedLines).toContain('line2');
    expect(hunk.addedLines).toHaveLength(0);
  });

  it('handles multiple hunks in one file', async () => {
    const repo = makeRepo();

    // Write a file with enough lines that two separate edits produce two hunks.
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    writeFile(repo, 'multi.txt', lines);
    commit(repo, 'init');

    // Change line 2 and line 18 separately — with -U0 these become two hunks.
    const changed = lines
      .replace('line2', 'LINE2_CHANGED')
      .replace('line18', 'LINE18_CHANGED');
    writeFile(repo, 'multi.txt', changed);
    commit(repo, 'two hunks');

    const history = await gitHistoryReader.readHistory(repo);
    const second = history[1]!;
    const file = second.files[0]!;
    expect(file.hunks.length).toBeGreaterThanOrEqual(2);

    const allAdded = file.hunks.flatMap((h) => h.addedLines);
    expect(allAdded).toContain('LINE2_CHANGED');
    expect(allAdded).toContain('LINE18_CHANGED');
  });

  it('marks new files with status A', async () => {
    const repo = makeRepo();

    writeFile(repo, 'existing.txt', 'hi\n');
    commit(repo, 'init');

    writeFile(repo, 'brand-new.txt', 'new content\n');
    commit(repo, 'add new file');

    const history = await gitHistoryReader.readHistory(repo);
    const second = history[1]!;
    const newFile = second.files.find((f) => f.path === 'brand-new.txt');
    expect(newFile).toBeDefined();
    expect(newFile!.status).toBe('A');
    expect(newFile!.hunks[0]!.addedLines).toContain('new content');
  });

  it('marks deleted files with status D', async () => {
    const repo = makeRepo();

    writeFile(repo, 'to-delete.txt', 'bye\n');
    commit(repo, 'init');

    git(repo, 'rm', 'to-delete.txt');
    commit(repo, 'delete file');

    const history = await gitHistoryReader.readHistory(repo);
    const second = history[1]!;
    const deletedFile = second.files.find((f) => f.path === 'to-delete.txt');
    expect(deletedFile).toBeDefined();
    expect(deletedFile!.status).toBe('D');
    expect(deletedFile!.hunks[0]!.removedLines).toContain('bye');
  });

  it('handles file rename with status R', async () => {
    const repo = makeRepo();

    writeFile(repo, 'old-name.ts', 'export const x = 1;\n');
    commit(repo, 'init');

    git(repo, 'mv', 'old-name.ts', 'new-name.ts');
    commit(repo, 'rename file');

    const history = await gitHistoryReader.readHistory(repo);
    const renameCommit = history[1]!;
    const renamedFile = renameCommit.files.find((f) => f.status === 'R');
    expect(renamedFile).toBeDefined();
    expect(renamedFile!.path).toBe('new-name.ts');
  });

  it('parses Co-Authored-By trailer (lowercase key)', async () => {
    const repo = makeRepo();

    writeFile(repo, 'trailer.txt', 'test\n');
    const message = 'feat: add something\n\nCo-Authored-By: Agent <agent@bot.ai>\nCo-Authored-By: Human <human@example.com>';
    git(repo, 'add', '-A');
    execFileSync('git', ['-C', repo, 'commit', '-m', message], {
      encoding: 'utf8',
      env: { ...process.env },
    });

    const history = await gitHistoryReader.readHistory(repo);
    const c = history[0]!;
    expect(c.trailers['co-authored-by']).toBeDefined();
    expect(c.trailers['co-authored-by']!.length).toBeGreaterThanOrEqual(1);
    // At least one value should contain the agent email
    expect(c.trailers['co-authored-by']!.some((v) => v.includes('agent@bot.ai'))).toBe(true);
  });

  it('marks merge commits as isMerge=true and does not expand diff', async () => {
    const repo = makeRepo();

    // Create initial commit on main
    writeFile(repo, 'main.txt', 'main\n');
    commit(repo, 'main: init');

    // Create a feature branch from main
    git(repo, 'checkout', '-b', 'feature');
    writeFile(repo, 'feature.txt', 'feature\n');
    commit(repo, 'feature: add file');

    // Switch back to main and add another commit
    git(repo, 'checkout', 'main');
    writeFile(repo, 'main2.txt', 'main2\n');
    commit(repo, 'main: second');

    // Merge feature into main (creates a merge commit)
    execFileSync(
      'git',
      ['-C', repo, 'merge', '--no-ff', 'feature', '-m', 'Merge branch feature'],
      { encoding: 'utf8', env: { ...process.env } },
    );

    const history = await gitHistoryReader.readHistory(repo);
    const mergeCommit = history.find((c) => c.isMerge);
    expect(mergeCommit).toBeDefined();
    expect(mergeCommit!.files).toHaveLength(0);
  });

  it('respects maxCommits option', async () => {
    const repo = makeRepo();

    for (let i = 0; i < 5; i++) {
      writeFile(repo, `file${i}.txt`, `content${i}\n`);
      commit(repo, `commit ${i}`);
    }

    const history = await gitHistoryReader.readHistory(repo, { maxCommits: 3 });
    expect(history).toHaveLength(3);
  });

  it('handles binary files gracefully (no hunks, file recorded)', async () => {
    const repo = makeRepo();

    // Write a minimal PNG (1x1 red pixel) as binary content
    const binaryContent = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
      '2e0000000c4944415408d76360f8cfc00000000200018ee1a80000000049454e44ae426082',
      'hex',
    );
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(repo, 'image.png'), binaryContent);
    commit(repo, 'add binary');

    const history = await gitHistoryReader.readHistory(repo);
    const c = history[0]!;
    const binFile = c.files.find((f) => f.path === 'image.png');
    expect(binFile).toBeDefined();
    // Binary files may have no hunks or hunks with no lines
    expect(binFile!.hunks.flatMap((h) => [...h.addedLines, ...h.removedLines])).toHaveLength(0);
  });
});

describe('GitHistoryReader.toRepoRelative', () => {
  it('returns repo-relative path for a file inside the repo', () => {
    const repo = makeRepo();
    // The sync version uses the cached toplevel or resolve(repoPath).
    // We can prime the cache by reading history, but for the sync version we
    // just test that it converts correctly when given the actual toplevel.
    const result = gitHistoryReader.toRepoRelative(repo, join(repo, 'src/foo.ts'));
    expect(result).toBe('src/foo.ts');
  });

  it('returns null for a path outside the repo', () => {
    const repo = makeRepo();
    const result = gitHistoryReader.toRepoRelative(repo, '/tmp/outside/file.ts');
    expect(result).toBe(null);
  });

  it('returns null for a relative path', () => {
    const repo = makeRepo();
    const result = gitHistoryReader.toRepoRelative(repo, 'relative/path.ts');
    expect(result).toBe(null);
  });

  it('handles nested subdirectory paths correctly', () => {
    const repo = makeRepo();
    const result = gitHistoryReader.toRepoRelative(repo, join(repo, 'a/b/c/d.ts'));
    expect(result).toBe('a/b/c/d.ts');
  });
});
