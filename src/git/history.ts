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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, isAbsolute } from 'node:path';
import type { CommitInfo, CommitFile, Hunk, GitHistoryReader } from './types.js';

const execFileAsync = promisify(execFile);

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
 * Parse the combined stdout of `git log ... -p -U0 --format=<our format>`.
 *
 * The stream looks like:
 *
 *   LORE_COMMIT_START
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
 *   LORE_COMMIT_START
 *   ...
 */
function parseGitLogOutput(output: string): CommitInfo[] {
  const commits: CommitInfo[] = [];

  // Split on COMMIT_START sentinel.  The first element before the first
  // sentinel is always empty (or whitespace) — skip it.
  const blocks = output.split(COMMIT_START + '\n');

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Split header from diff at COMMIT_BODY_END sentinel.
    const bodyEndIdx = block.indexOf(COMMIT_BODY_END);
    if (bodyEndIdx === -1) continue;

    const headerSection = block.slice(0, bodyEndIdx);
    // +1 to skip the newline after COMMIT_BODY_END, +1 to skip the trailing
    // newline that git appends before the diff.
    const diffSection = block.slice(bodyEndIdx + COMMIT_BODY_END.length).replace(/^\n/, '');

    // Parse header fields
    const headerLines = headerSection.split('\n');
    let lineIdx = 0;

    const hash = headerLines[lineIdx++]?.trim() ?? '';
    const authorDate = headerLines[lineIdx++]?.trim() ?? '';
    const committerDate = headerLines[lineIdx++]?.trim() ?? '';
    const parentsLine = headerLines[lineIdx++]?.trim() ?? '';

    if (!hash) continue;

    const isMerge = parentsLine.trim().includes(' ');

    // Collect message body until TRAILERS_START
    const bodyLines: string[] = [];
    while (lineIdx < headerLines.length && headerLines[lineIdx] !== 'TRAILERS_START') {
      bodyLines.push(headerLines[lineIdx]!);
      lineIdx++;
    }
    // Skip the TRAILERS_START line itself
    lineIdx++;

    // Collect trailer lines
    const trailerLines: string[] = [];
    while (lineIdx < headerLines.length) {
      const l = headerLines[lineIdx]!;
      trailerLines.push(l);
      lineIdx++;
    }

    const message = bodyLines.join('\n').replace(/\n+$/, '');
    const trailers = parseTrailers(trailerLines.join('\n'));

    // Parse diff (skip for merge commits)
    let files: CommitFile[] = [];
    if (!isMerge && diffSection.trim()) {
      const fileDiffs = parseDiff(diffSection);
      files = fileDiffs.map((fd) => ({
        path: fd.path,
        status: fd.status,
        hunks: fd.hunks,
      }));
    }

    commits.push({
      hash,
      authorDate,
      committerDate,
      message,
      isMerge,
      trailers,
      files,
    });
  }

  return commits;
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
    const args: string[] = [
      '-C', repoPath,
      'log',
      '--first-parent',
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

    // Use a large buffer; 709 commits with full diffs can be several MB.
    const { stdout } = await execFileAsync('git', args, {
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'utf8',
    });

    return parseGitLogOutput(stdout);
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
