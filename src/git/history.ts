/**
 * GitHistoryReader implementation.
 *
 * Strategy: single `git log --first-parent --reverse -p -U0` invocation
 * to pull all commits and their diffs in one process spawn.  Parsing is
 * done in a streaming fashion over the stdout buffer so even a 700-commit
 * repo completes in well under a second.
 *
 * Output format notes
 * -------------------
 * We use a sentinel-based format string to delimit commits inside the
 * combined diff stream:
 *
 *   --format=COMMIT_START%n%H%n%aI%n%cI%n%P%n%B%nTRAILERS%n%(trailers)%nCOMMIT_BODY_END
 *
 * Between each commit header block the raw unified diff follows (the -p
 * output).  A zero-context (-U0) diff is used so added/removed lines are
 * clean with no surrounding context lines.
 *
 * Rename detection (-M) is enabled so the diff header uses the
 * "rename from / rename to" notation and the status letter is 'R'.
 *
 * Binary files produce "Binary files a/… and b/… differ" — we collect
 * those files but leave hunks empty.
 */

import { spawn } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import type { CommitInfo, CommitFile, Hunk, GitHistoryReader } from './types.js';
import { execFileAsync } from '../util/exec.js';

// ─── sentinel tokens embedded in the format string ──────────────────────────
const COMMIT_START = 'LORE_COMMIT_START';
const COMMIT_BODY_END = 'LORE_COMMIT_BODY_END';

/**
 * Build the git-log format string.
 * Fields separated by newlines inside the block (safe because %B is last
 * before the trailers sentinel).
 */
function buildFormat(): string {
  return [
    COMMIT_START,
    '%H',        // full hash
    '%aI',       // author date ISO 8601
    '%cI',       // committer date ISO 8601
    '%P',        // parent hashes (space-separated; >1 means merge)
    '%B',        // raw body including trailers
    'TRAILERS_START',
    '%(trailers)',
    COMMIT_BODY_END,
  ].join('%n');
}

// ─── trailer parsing ─────────────────────────────────────────────────────────

/**
 * Parse git trailer lines (key: value) into a Record<string, string[]>.
 * Keys are lower-cased.  We accept both the %(trailers) section and a
 * fallback scan of the full commit body.
 */
function parseTrailers(trailerBlock: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const line of trailerBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    if (!result[key]) result[key] = [];
    result[key].push(value);
  }
  return result;
}

// ─── hunk header parsing  ────────────────────────────────────────────────────

/** Parse a `@@ -a,b +c,d @@` header line into numeric fields. */
function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  // @@ -<old_start>[,<old_lines>] +<new_start>[,<new_lines>] @@
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1]!, 10),
    oldLines: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    newStart: parseInt(m[3]!, 10),
    newLines: m[4] !== undefined ? parseInt(m[4], 10) : 1,
  };
}

// ─── diff block parser  ──────────────────────────────────────────────────────

interface FileDiff {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  hunks: Hunk[];
}

/**
 * Parse a raw diff block (lines between two COMMIT_START sentinels, after
 * the commit header has been stripped).
 *
 * Handles:
 *  - new file / deleted file headers  → status A / D
 *  - rename headers                   → status R
 *  - binary files                     → collected with empty hunks
 *  - multiple files per commit        → returns array
 */
function parseDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: Hunk | null = null;

  function flushHunk() {
    if (currentHunk && current) {
      current.hunks.push(currentHunk);
      currentHunk = null;
    }
  }

  function flushFile() {
    flushHunk();
    if (current) {
      files.push(current);
      current = null;
    }
  }

  const lines = diffText.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Start of a new file diff
    if (line.startsWith('diff --git ')) {
      flushFile();
      // Default: extract the b/ path as a placeholder; will be overridden by
      // rename/new-file/deleted-file headers below.
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      const path = m ? m[1]! : '';
      current = { path, status: 'M', hunks: [] };
      i++;
      continue;
    }

    if (!current) { i++; continue; }

    if (line.startsWith('new file mode')) {
      current.status = 'A';
      i++; continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'D';
      i++; continue;
    }
    if (line.startsWith('rename to ')) {
      current.status = 'R';
      current.path = line.slice('rename to '.length).trim();
      i++; continue;
    }
    if (line.startsWith('rename from ')) {
      // keep going; we'll pick up the new path from "rename to"
      i++; continue;
    }
    if (line.startsWith('Binary files')) {
      // Binary file — keep the file entry, no hunks
      i++; continue;
    }
    // Skip index / --- / +++ lines
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      i++; continue;
    }

    // Hunk header
    if (line.startsWith('@@ ')) {
      flushHunk();
      const header = parseHunkHeader(line);
      if (header) {
        currentHunk = { ...header, addedLines: [], removedLines: [] };
      }
      i++; continue;
    }

    // Hunk body lines
    if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++ ')) {
        currentHunk.addedLines.push(line.slice(1));
      } else if (line.startsWith('-') && !line.startsWith('--- ')) {
        currentHunk.removedLines.push(line.slice(1));
      }
      // context lines (space prefix) are present with U0 only for "\ No newline"
    }

    i++;
  }

  flushFile();
  return files;
}

// ─── full output parser  ─────────────────────────────────────────────────────

/**
 * Parse a single commit block (the bytes between two COMMIT_START sentinels,
 * not including the leading sentinel + newline). Returns null when the block
 * is malformed (missing body-end sentinel or empty hash) — caller skips silently.
 *
 * The block layout:
 *
 *   <hash>
 *   <authorDate>
 *   <committerDate>
 *   <parents>
 *   <body lines...>
 *   TRAILERS_START
 *   <trailer lines...>
 *   LORE_COMMIT_BODY_END
 *   diff --git a/... b/...
 *   ...
 */
function parseCommitBlock(block: string): CommitInfo | null {
  const bodyEndIdx = block.indexOf(COMMIT_BODY_END);
  if (bodyEndIdx === -1) return null;

  const headerSection = block.slice(0, bodyEndIdx);
  // Skip the trailing newline that git appends before the diff.
  const diffSection = block.slice(bodyEndIdx + COMMIT_BODY_END.length).replace(/^\n/, '');

  const headerLines = headerSection.split('\n');
  let lineIdx = 0;

  const hash = headerLines[lineIdx++]?.trim() ?? '';
  const authorDate = headerLines[lineIdx++]?.trim() ?? '';
  const committerDate = headerLines[lineIdx++]?.trim() ?? '';
  const parentsLine = headerLines[lineIdx++]?.trim() ?? '';

  if (!hash) return null;

  const isMerge = parentsLine.trim().includes(' ');

  const bodyLines: string[] = [];
  while (lineIdx < headerLines.length && headerLines[lineIdx] !== 'TRAILERS_START') {
    bodyLines.push(headerLines[lineIdx]!);
    lineIdx++;
  }
  lineIdx++; // skip TRAILERS_START

  const trailerLines: string[] = [];
  while (lineIdx < headerLines.length) {
    trailerLines.push(headerLines[lineIdx]!);
    lineIdx++;
  }

  const message = bodyLines.join('\n').replace(/\n+$/, '');
  const trailers = parseTrailers(trailerLines.join('\n'));

  let files: CommitFile[] = [];
  if (!isMerge && diffSection.trim()) {
    const fileDiffs = parseDiff(diffSection);
    files = fileDiffs.map((fd) => ({
      path: fd.path,
      status: fd.status,
      hunks: fd.hunks,
    }));
  }

  return {
    hash,
    authorDate,
    committerDate,
    message,
    isMerge,
    trailers,
    files,
  };
}

/**
 * Parse the combined stdout of `git log ... -p -U0 --format=<our format>`.
 * Used in non-streaming code paths (tests, fixture pipelines). Production
 * `readHistory` uses `streamGitLog` which feeds blocks one-by-one.
 */
function parseGitLogOutput(output: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const sentinel = COMMIT_START + '\n';
  const blocks = output.split(sentinel);

  for (const block of blocks) {
    if (!block.trim()) continue;
    const parsed = parseCommitBlock(block);
    if (parsed) commits.push(parsed);
  }

  return commits;
}

// ─── streaming spawn implementation ──────────────────────────────────────────
//
// Why streaming: a 5k-commit repo with rich diffs can produce >100MB of stdout.
// The previous `execFile` path bound the entire payload as a single utf8 string
// (maxBuffer 512MB) — V8 string heap peaks ~2× the byte size, so a single scan
// could spike RSS to >1GB. We now spawn git, accumulate at the COMMIT_START
// sentinel boundary, parse each block as soon as it's complete, and let GC
// reclaim the string. Steady-state memory ≈ size of the largest single commit.

/**
 * Spawn `git log` with the given args, parse its stdout block-by-block at
 * the COMMIT_START sentinel, and resolve with the full CommitInfo[].
 *
 * Memory: holds at most one in-flight commit block at a time (plus the small
 * `commits` array). Even on a 100MB diff stream peak RSS stays bounded.
 *
 * Errors: any git-side failure (non-zero exit, spawn error) rejects the
 * returned promise with the captured stderr message.
 */
function streamGitLog(repoPath: string, args: string[]): Promise<CommitInfo[]> {
  return new Promise<CommitInfo[]>((resolve, reject) => {
    const proc = spawn('git', ['-C', repoPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const commits: CommitInfo[] = [];
    // Carry-over buffer: text between the last sentinel we processed and the
    // most recent chunk boundary. Keeping it as a single string avoids splice
    // costs for large blocks (we slice once per block, not per chunk).
    let buffer = '';
    let stderr = '';
    let finished = false;
    const sentinel = COMMIT_START + '\n';

    /** Drain buffer up to the last complete block; parse + push each. */
    function drain(final: boolean): void {
      // We emit a block whenever we see a sentinel that ISN'T at the very start
      // of the buffer (because the bytes before it are a complete block).
      // After draining, `buffer` always begins with COMMIT_START\n (or is empty).
      while (true) {
        const firstSentinel = buffer.indexOf(sentinel);
        if (firstSentinel === -1) {
          // No sentinel yet — keep accumulating.
          break;
        }
        if (firstSentinel > 0) {
          // Discard the pre-sentinel garbage (e.g. shell-quirk leading lines).
          buffer = buffer.slice(firstSentinel);
        }
        // buffer now starts with sentinel; look for the NEXT sentinel.
        const nextSentinel = buffer.indexOf(sentinel, sentinel.length);
        if (nextSentinel === -1) {
          if (!final) break;
          // Final flush: parse the remainder (everything after sentinel).
          const block = buffer.slice(sentinel.length);
          if (block.trim()) {
            const parsed = parseCommitBlock(block);
            if (parsed) commits.push(parsed);
          }
          buffer = '';
          break;
        }
        // Complete block lies between sentinel and nextSentinel.
        const block = buffer.slice(sentinel.length, nextSentinel);
        if (block.trim()) {
          const parsed = parseCommitBlock(block);
          if (parsed) commits.push(parsed);
        }
        // Advance: keep the next sentinel as the new start.
        buffer = buffer.slice(nextSentinel);
      }
    }

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      // Defer drain when buffer is small to amortise indexOf cost; threshold
      // chosen so even a single max-size commit (a few MB of diff) emits
      // promptly. Using >0 here means each chunk triggers at most one drain.
      drain(false);
    });
    proc.stdout.on('end', () => {
      drain(true);
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      // Cap stderr accumulation — git rarely produces useful >64KB stderr.
      if (stderr.length < 64 * 1024) stderr += chunk;
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      reject(new Error(`git spawn failed: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      if (code === 0) {
        resolve(commits);
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(
        new Error(
          `git log exited with ${reason}` + (stderr ? `: ${stderr.trim().slice(0, 500)}` : ''),
        ),
      );
    });
  });
}

// ─── toRepoRelative helper ───────────────────────────────────────────────────

/** Cached git rev-parse --show-toplevel results, keyed by repoPath. */
const toplevelCache = new Map<string, string>();

async function getTopLevel(repoPath: string): Promise<string> {
  const cached = toplevelCache.get(repoPath);
  if (cached !== undefined) return cached;

  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel']);
  const toplevel = stdout.trim();
  toplevelCache.set(repoPath, toplevel);
  return toplevel;
}

// ─── GitHistoryReader implementation ─────────────────────────────────────────

export const gitHistoryReader: GitHistoryReader = {
  async readHistory(repoPath, opts = {}) {
    // 注意：args 里不带 `-C <repoPath>`——streamGitLog 自己注入，避免重复。
    const args: string[] = [
      'log',
      // allRefs: agent 的真实 commit 常在 PR 分支/远端引用上（squash 合并后 main 只有改写版）。
      ...(opts.allRefs ? ['--all'] : ['--first-parent']),
      '--reverse',
      '-p',
      '-U0',
      '-M',               // rename detection
      `--format=${buildFormat()}`,
    ];

    if (opts.since) {
      args.push(`--since=${opts.since}`);
    }
    if (opts.maxCommits !== undefined) {
      args.push(`-${opts.maxCommits}`);
    }

    // 流式 spawn：stdout 按 COMMIT_START sentinel 分块解析，
    // 单 block 解析完即释放——5k commit / >100MB diff 也只占用单 block 大小的内存。
    return streamGitLog(repoPath, args);
  },

  toRepoRelative(repoPath, absPath) {
    if (!isAbsolute(absPath)) return null;

    // Try to get the cached toplevel synchronously if available; otherwise
    // fall back to computing it from the provided repoPath.
    const cached = toplevelCache.get(repoPath);
    const toplevel = cached ?? resolve(repoPath);

    const normalised = resolve(absPath);
    if (!normalised.startsWith(toplevel + '/') && normalised !== toplevel) {
      return null;
    }
    return normalised.slice(toplevel.length + 1);
  },
};

/** Named alias expected by cli.ts dynamic import (`mod.reader`). */
export const reader = gitHistoryReader;

/**
 * Async version of toRepoRelative that correctly resolves the git toplevel
 * (rather than trusting the caller-supplied repoPath to be the root).
 * Prefer this when accuracy matters.
 */
export async function toRepoRelativeAsync(repoPath: string, absPath: string): Promise<string | null> {
  if (!isAbsolute(absPath)) return null;
  let toplevel: string;
  try {
    toplevel = await getTopLevel(repoPath);
  } catch {
    return null;
  }
  const normalised = resolve(absPath);
  if (!normalised.startsWith(toplevel + '/') && normalised !== toplevel) {
    return null;
  }
  return normalised.slice(toplevel.length + 1);
}
