/**
 * buildGraphData 聚合正确性测试。全部合成数据，零 IO。
 */

import { describe, it, expect } from 'vitest';
import { buildGraphData } from '../../src/graph/build.js';
import type { CommitInfo, CommitFile, Hunk } from '../../src/git/types.js';
import type { ParsedSession, FileEditEvent } from '../../src/schema/events.js';
import type { RepoMatchReport, MatchCandidate } from '../../src/match/types.js';

const REPO = '/Users/dev/proj';

// ── fixture helpers ──────────────────────────────────────────────────────────

function hunk(added: string[], removed: string[] = []): Hunk {
  return {
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    addedLines: added,
    removedLines: removed,
  };
}

function commitFile(
  path: string,
  added: string[],
  removed: string[] = [],
  status: CommitFile['status'] = 'M',
): CommitFile {
  return { path, status, hunks: [hunk(added, removed)] };
}

function commit(
  hash: string,
  files: CommitFile[],
  opts: { authorDate?: string; committerDate?: string; message?: string; isMerge?: boolean } = {},
): CommitInfo {
  const d = opts.committerDate ?? opts.authorDate ?? '2026-06-01T12:00:00.000Z';
  return {
    hash,
    authorDate: opts.authorDate ?? d,
    committerDate: opts.committerDate ?? d,
    message: opts.message ?? 'commit ' + hash,
    isMerge: opts.isMerge ?? false,
    trailers: {},
    files,
  };
}

function fileEdit(
  seq: number,
  filePath: string,
  ts: string,
  opts: { succeeded?: boolean | null; op?: FileEditEvent['op'] } = {},
): FileEditEvent {
  return {
    kind: 'file-edit',
    sessionId: 'S',
    ts,
    seq,
    toolUseId: null,
    op: opts.op ?? 'edit',
    filePath,
    oldText: null,
    newText: 'x',
    patch: null,
    userModified: null,
    succeeded: opts.succeeded ?? true,
  };
}

function session(
  sessionId: string,
  sourcePath: string,
  events: ParsedSession['events'],
  opts: {
    cwd?: string | null;
    startedAt?: string;
    endedAt?: string | null;
    gitBranch?: string | null;
    agent?: 'claude-code' | 'codex' | 'opencode';
  } = {},
): ParsedSession {
  return {
    meta: {
      schemaVersion: 1,
      agent: opts.agent ?? 'claude-code',
      sessionId,
      cwd: opts.cwd === undefined ? REPO : opts.cwd,
      gitBranch: opts.gitBranch === undefined ? 'main' : opts.gitBranch,
      startedAt: opts.startedAt ?? '2026-06-01T11:00:00.000Z',
      endedAt: opts.endedAt === undefined ? '2026-06-01T13:00:00.000Z' : opts.endedAt,
      sourcePath,
      agentVersion: 'test',
    },
    events,
  };
}

function candidate(
  commitHash: string,
  filePath: string,
  sessionId: string,
  sourcePath: string,
  opts: {
    confidence?: number;
    matchedLines?: number;
    matchedVia?: 'sha' | 'content';
    editSeqs?: number[];
  } = {},
): MatchCandidate {
  return {
    commitHash,
    filePath,
    sessionId,
    editSeqs: opts.editSeqs ?? [1],
    sourcePath,
    matchedVia: opts.matchedVia ?? 'content',
    matchedLines: opts.matchedLines ?? 3,
    contentScore: 1,
    timeScore: 1,
    confidence: opts.confidence ?? 0.9,
    evidence: [],
  };
}

function report(matches: MatchCandidate[]): RepoMatchReport {
  return {
    repo: REPO,
    generatedAt: '2026-06-01T14:00:00.000Z',
    schemaVersion: 1,
    commitsTotal: 0,
    commitsMatchedStrong: 0,
    commitsMatchedWeak: 0,
    sessionsSeen: 0,
    sessionsContributing: 0,
    window: null,
    commitsInWindow: 0,
    strongInWindow: 0,
    weakInWindow: 0,
    matches,
    unmatchedCommits: [],
  };
}

// ── Session 节点聚合 ─────────────────────────────────────────────────────────

describe('Session node aggregation', () => {
  it('folds multiple parse units of the same sessionId into one node', () => {
    const main = session('S1', '/tmp/S1.jsonl', [], {
      startedAt: '2026-06-01T11:00:00.000Z',
      endedAt: '2026-06-01T12:00:00.000Z',
    });
    const sub = session('S1', '/tmp/S1/subagents/agent-x.jsonl', [], {
      startedAt: '2026-06-01T11:30:00.000Z',
      endedAt: '2026-06-01T13:30:00.000Z',
    });
    const g = buildGraphData(REPO, [], [main, sub], report([]));
    expect(g.sessions).toHaveLength(1);
    const node = g.sessions[0]!;
    expect(node.id).toBe('S1');
    // sourcePaths = both parse units, sorted
    expect(node.sourcePaths).toEqual([
      '/tmp/S1.jsonl',
      '/tmp/S1/subagents/agent-x.jsonl',
    ]);
    // earliest start, latest end across units
    expect(node.startedAt).toBe('2026-06-01T11:00:00.000Z');
    expect(node.endedAt).toBe('2026-06-01T13:30:00.000Z');
  });

  it('takes first non-null cwd/gitBranch and preserves agent', () => {
    // First unit has null cwd/branch; second supplies them → "first non-null" picks the second.
    const a = session('S2', '/tmp/a.jsonl', [], { cwd: null, gitBranch: null });
    const b = session('S2', '/tmp/b.jsonl', [], { cwd: '/work/dir', gitBranch: 'feat' });
    const g = buildGraphData(REPO, [], [a, b], report([]));
    const node = g.sessions[0]!;
    expect(node.cwd).toBe('/work/dir');
    expect(node.gitBranch).toBe('feat');
    expect(node.agent).toBe('claude-code');
  });

  it('null endedAt does not clobber a real endedAt', () => {
    const a = session('S3', '/tmp/a.jsonl', [], { endedAt: '2026-06-01T12:00:00.000Z' });
    const b = session('S3', '/tmp/b.jsonl', [], { endedAt: null });
    const g = buildGraphData(REPO, [], [a, b], report([]));
    expect(g.sessions[0]!.endedAt).toBe('2026-06-01T12:00:00.000Z');
  });
});

// ── Commit nodes + TOUCHES ───────────────────────────────────────────────────

describe('Commit nodes and TOUCHES edges', () => {
  it('emits one commit node per commit with subject = first line', () => {
    const commits = [
      commit('h1', [commitFile('a.ts', ['line one', 'line two'])], {
        message: 'feat: add a\n\nbody text',
      }),
    ];
    const g = buildGraphData(REPO, commits, [], report([]));
    expect(g.commits).toHaveLength(1);
    expect(g.commits[0]!.subject).toBe('feat: add a');
  });

  it('aggregates added/removed line counts from hunks per file', () => {
    const commits = [
      commit('h2', [
        commitFile('a.ts', ['added 1', 'added 2', 'added 3'], ['removed 1'], 'M'),
        commitFile('b.ts', ['new file line'], [], 'A'),
      ]),
    ];
    const g = buildGraphData(REPO, commits, [], report([]));
    const touchA = g.touches.find((t) => t.filePath === 'a.ts')!;
    const touchB = g.touches.find((t) => t.filePath === 'b.ts')!;
    expect(touchA.addedLines).toBe(3);
    expect(touchA.removedLines).toBe(1);
    expect(touchA.status).toBe('M');
    expect(touchB.addedLines).toBe(1);
    expect(touchB.status).toBe('A');
  });

  it('merge commit with no files produces a node but no TOUCHES', () => {
    const commits = [commit('m1', [], { isMerge: true, message: 'Merge branch' })];
    const g = buildGraphData(REPO, commits, [], report([]));
    expect(g.commits[0]!.isMerge).toBe(true);
    expect(g.touches).toHaveLength(0);
  });
});

// ── PRODUCED aggregation ─────────────────────────────────────────────────────

describe('PRODUCED edge aggregation', () => {
  it('aggregates candidates by (sessionId, commitHash): max confidence, file count, summed lines', () => {
    const matches = [
      candidate('h1', 'a.ts', 'S1', '/tmp/S1.jsonl', { confidence: 0.6, matchedLines: 3 }),
      candidate('h1', 'b.ts', 'S1', '/tmp/S1.jsonl', { confidence: 0.95, matchedLines: 5 }),
    ];
    const g = buildGraphData(REPO, [], [], report(matches));
    expect(g.produced).toHaveLength(1);
    const p = g.produced[0]!;
    expect(p.sessionId).toBe('S1');
    expect(p.commitHash).toBe('h1');
    expect(p.confidence).toBe(0.95); // max
    expect(p.fileCount).toBe(2); // distinct files
    expect(p.matchedLines).toBe(8); // summed
  });

  it('sourcePath points to the parse unit contributing the most matchedLines', () => {
    const matches = [
      // parent contributes 2 lines, subagent contributes 7 → subagent wins
      candidate('h1', 'a.ts', 'S1', '/tmp/S1.jsonl', { matchedLines: 2 }),
      candidate('h1', 'b.ts', 'S1', '/tmp/S1/subagents/agent-x.jsonl', { matchedLines: 7 }),
    ];
    const g = buildGraphData(REPO, [], [], report(matches));
    expect(g.produced[0]!.sourcePath).toBe('/tmp/S1/subagents/agent-x.jsonl');
  });

  it('keeps separate PRODUCED edges for different sessions on the same commit', () => {
    const matches = [
      candidate('h1', 'a.ts', 'S1', '/tmp/S1.jsonl'),
      candidate('h1', 'a.ts', 'S2', '/tmp/S2.jsonl'),
    ];
    const g = buildGraphData(REPO, [], [], report(matches));
    expect(g.produced).toHaveLength(2);
    expect(g.produced.map((p) => p.sessionId).sort()).toEqual(['S1', 'S2']);
  });

  it('matchedVia follows the highest-confidence candidate (sha anchoring wins)', () => {
    const matches = [
      candidate('h1', 'a.ts', 'S1', '/tmp/S1.jsonl', { confidence: 0.7, matchedVia: 'content' }),
      candidate('h1', 'b.ts', 'S1', '/tmp/S1.jsonl', { confidence: 1.0, matchedVia: 'sha' }),
    ];
    const g = buildGraphData(REPO, [], [], report(matches));
    expect(g.produced[0]!.matchedVia).toBe('sha');
    expect(g.produced[0]!.confidence).toBe(1.0);
  });
});

// ── EDITED aggregation ───────────────────────────────────────────────────────

describe('EDITED edge aggregation', () => {
  it('aggregates file-edit events per (sessionId, filePath): count + first/last ts', () => {
    const s = session('S1', '/tmp/S1.jsonl', [
      fileEdit(1, REPO + '/src/a.ts', '2026-06-01T11:10:00.000Z'),
      fileEdit(2, REPO + '/src/a.ts', '2026-06-01T11:05:00.000Z'),
      fileEdit(3, REPO + '/src/a.ts', '2026-06-01T11:20:00.000Z'),
    ]);
    const commits = [commit('h1', [commitFile('src/a.ts', ['x'])])];
    const g = buildGraphData(REPO, commits, [s], report([]));
    const e = g.edited.find((x) => x.filePath === 'src/a.ts')!;
    expect(e.editCount).toBe(3);
    expect(e.firstTs).toBe('2026-06-01T11:05:00.000Z');
    expect(e.lastTs).toBe('2026-06-01T11:20:00.000Z');
  });

  it('excludes failed (succeeded===false) edits', () => {
    const s = session('S1', '/tmp/S1.jsonl', [
      fileEdit(1, REPO + '/src/a.ts', '2026-06-01T11:10:00.000Z', { succeeded: false }),
    ]);
    const commits = [commit('h1', [commitFile('src/a.ts', ['x'])])];
    const g = buildGraphData(REPO, commits, [s], report([]));
    expect(g.edited.find((x) => x.filePath === 'src/a.ts')).toBeUndefined();
  });

  it('keeps EDITED even when no commit matched (blind spot stays visible)', () => {
    // No commits → suffix resolver empty; path normalizes off repo prefix.
    const s = session('S1', '/tmp/S1.jsonl', [
      fileEdit(1, REPO + '/never/committed.ts', '2026-06-01T11:10:00.000Z'),
    ]);
    const g = buildGraphData(REPO, [], [s], report([]));
    const e = g.edited.find((x) => x.filePath === 'never/committed.ts');
    expect(e).toBeDefined();
    expect(e!.editCount).toBe(1);
  });

  it('resolves worktree paths via suffix against the commit file set', () => {
    // Edit path is under a worktree root that is NOT repoPath; prefix strip fails,
    // suffix resolver maps it to the committed src/x.ts.
    const s = session('S1', '/tmp/S1.jsonl', [
      fileEdit(1, '/tmp/wt-pr15/src/x.ts', '2026-06-01T11:10:00.000Z'),
    ], { cwd: '/tmp/wt-pr15' });
    const commits = [commit('h1', [commitFile('src/x.ts', ['line a', 'line b'])])];
    const g = buildGraphData(REPO, commits, [s], report([]));
    const e = g.edited.find((x) => x.filePath === 'src/x.ts');
    expect(e).toBeDefined();
  });
});

// ── File nodes ───────────────────────────────────────────────────────────────

describe('File nodes', () => {
  it('is the union of committed (TOUCHES) and edited (EDITED) paths, deduped + sorted', () => {
    const commits = [commit('h1', [commitFile('src/committed.ts', ['x'])])];
    const s = session('S1', '/tmp/S1.jsonl', [
      fileEdit(1, REPO + '/src/committed.ts', '2026-06-01T11:10:00.000Z'),
      fileEdit(2, REPO + '/src/edited-only.ts', '2026-06-01T11:11:00.000Z'),
    ]);
    const g = buildGraphData(REPO, commits, [s], report([]));
    expect(g.files.map((f) => f.path)).toEqual([
      'src/committed.ts',
      'src/edited-only.ts',
    ]);
  });
});

// ── determinism ──────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces identical output across runs regardless of input order quirks', () => {
    const commits = [
      commit('h2', [commitFile('b.ts', ['x'])]),
      commit('h1', [commitFile('a.ts', ['y'])]),
    ];
    const s1 = session('S2', '/tmp/S2.jsonl', [
      fileEdit(1, REPO + '/b.ts', '2026-06-01T11:00:00.000Z'),
    ]);
    const s2 = session('S1', '/tmp/S1.jsonl', [
      fileEdit(1, REPO + '/a.ts', '2026-06-01T11:00:00.000Z'),
    ]);
    const m = report([
      candidate('h1', 'a.ts', 'S1', '/tmp/S1.jsonl'),
      candidate('h2', 'b.ts', 'S2', '/tmp/S2.jsonl'),
    ]);
    const g1 = buildGraphData(REPO, commits, [s1, s2], m);
    const g2 = buildGraphData(REPO, [...commits].reverse(), [s2, s1], m);
    expect(g1.sessions).toEqual(g2.sessions);
    expect(g1.produced).toEqual(g2.produced);
    expect(g1.edited).toEqual(g2.edited);
    expect(g1.files).toEqual(g2.files);
  });
});
