import { describe, it, expect } from 'vitest';
import { createMatchEngine } from '../../src/match/engine.js';
import type { CommitInfo, CommitFile, Hunk } from '../../src/git/types.js';
import type {
  ParsedSession,
  FileEditEvent,
  GitCommitEvent,
  PatchHunk,
} from '../../src/schema/events.js';
import { tierOf } from '../../src/match/types.js';

const REPO = '/Users/dev/proj';

// ---- fixture helpers (全部手工构造，不读真实 transcript) ----

function hunk(addedLines: string[], opts: Partial<Hunk> = {}): Hunk {
  return {
    oldStart: opts.oldStart ?? 1,
    oldLines: opts.oldLines ?? 0,
    newStart: opts.newStart ?? 1,
    newLines: opts.newLines ?? addedLines.length,
    addedLines,
    removedLines: opts.removedLines ?? [],
  };
}

function commitFile(path: string, addedLines: string[], status: CommitFile['status'] = 'M'): CommitFile {
  return { path, status, hunks: [hunk(addedLines)] };
}

function commit(
  hash: string,
  files: CommitFile[],
  opts: { authorDate?: string; committerDate?: string; message?: string } = {}
): CommitInfo {
  const d = opts.committerDate ?? opts.authorDate ?? '2026-06-01T12:00:00.000Z';
  return {
    hash,
    authorDate: opts.authorDate ?? d,
    committerDate: opts.committerDate ?? d,
    message: opts.message ?? 'commit ' + hash,
    isMerge: false,
    trailers: {},
    files,
  };
}

let seqCounter = 0;
function fileEdit(
  filePath: string,
  newText: string,
  opts: {
    op?: FileEditEvent['op'];
    patch?: PatchHunk[] | null;
    succeeded?: boolean | null;
    ts?: string;
    seq?: number;
    oldText?: string | null;
  } = {}
): FileEditEvent {
  return {
    kind: 'file-edit',
    sessionId: 'S',
    ts: opts.ts ?? '2026-06-01T11:59:00.000Z',
    seq: opts.seq ?? seqCounter++,
    toolUseId: null,
    op: opts.op ?? 'edit',
    filePath,
    oldText: opts.oldText ?? null,
    newText,
    patch: opts.patch ?? null,
    userModified: null,
    succeeded: opts.succeeded ?? true,
  };
}

function gitCommitEvent(sha: string, ts: string, seq: number): GitCommitEvent {
  return { kind: 'git-commit', sessionId: 'S', ts, seq, sha };
}

function session(sessionId: string, events: ParsedSession['events'], cwd: string | null = REPO): ParsedSession {
  return {
    meta: {
      schemaVersion: 1,
      agent: 'claude-code',
      sessionId,
      cwd,
      gitBranch: 'main',
      startedAt: '2026-06-01T11:00:00.000Z',
      endedAt: '2026-06-01T13:00:00.000Z',
      sourcePath: '/tmp/' + sessionId + '.jsonl',
      agentVersion: 'test',
    },
    events: events.map((e) => ({ ...e, sessionId })),
  };
}

function patchFrom(plusLines: string[], ctx: string[] = []): PatchHunk[] {
  return [
    {
      oldStart: 1,
      oldLines: ctx.length,
      newStart: 1,
      newLines: plusLines.length + ctx.length,
      lines: [...ctx.map((c) => ' ' + c), ...plusLines.map((p) => '+' + p)],
    },
  ];
}

const engine = createMatchEngine();

describe('Tier-0 sha anchoring', () => {
  it('anchors all commit files to the session, confidence 1.0, with anchor evidence', () => {
    const commits = [
      commit('abc1234def5678', [
        commitFile('src/a.ts', ['const a = 1', 'export default a']),
        commitFile('src/b.ts', ['const b = 2']),
      ]),
    ];
    const s = session('S', [
      fileEdit(REPO + '/src/a.ts', 'const a = 1\nexport default a', {
        ts: '2026-06-01T11:50:00.000Z',
        seq: 1,
      }),
      // git-commit event with SHORT hash that prefix-matches the full hash
      gitCommitEvent('abc1234', '2026-06-01T12:00:00.000Z', 2),
    ]);
    const report = engine.match(REPO, commits, [s]);

    const aMatch = report.matches.find((m) => m.filePath === 'src/a.ts');
    const bMatch = report.matches.find((m) => m.filePath === 'src/b.ts');
    expect(aMatch).toBeDefined();
    expect(bMatch).toBeDefined();
    expect(aMatch!.confidence).toBe(1.0);
    expect(bMatch!.confidence).toBe(1.0);
    expect(aMatch!.evidence.join(' ')).toContain('anchor');
    // editSeqs: the edit before the commit event touching a.ts is included
    expect(aMatch!.editSeqs).toContain(1);
    // b.ts had no edit -> empty editSeqs but still attributed
    expect(bMatch!.editSeqs).toEqual([]);
    expect(report.commitsMatchedStrong).toBe(1);
  });

  it('excludes edits that happen AFTER the commit event from anchor editSeqs', () => {
    const commits = [commit('deadbeef0000', [commitFile('x.ts', ['line one here'])])];
    const s = session('S', [
      fileEdit(REPO + '/x.ts', 'line one here', { ts: '2026-06-01T11:00:00.000Z', seq: 1 }),
      gitCommitEvent('deadbee', '2026-06-01T12:00:00.000Z', 2),
      fileEdit(REPO + '/x.ts', 'later edit content', { ts: '2026-06-01T13:00:00.000Z', seq: 3 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'x.ts')!;
    expect(m.editSeqs).toContain(1);
    expect(m.editSeqs).not.toContain(3);
  });
});

describe('Tier-0 miss degrades to Tier-1', () => {
  it('rewritten hash (no prefix match) falls back to content matching', () => {
    // commit hash does NOT match any git-commit event sha -> Tier-1
    const commits = [
      commit('ffffffffffff', [commitFile('src/a.ts', ['const value = 42', 'return value'])], {
        committerDate: '2026-06-01T12:00:00.000Z',
      }),
    ];
    const s = session('S', [
      fileEdit(REPO + '/src/a.ts', 'const value = 42\nreturn value', {
        ts: '2026-06-01T11:59:00.000Z',
        seq: 1,
      }),
      gitCommitEvent('aaaaaaa', '2026-06-01T11:59:30.000Z', 2), // unrelated sha
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'src/a.ts')!;
    expect(m).toBeDefined();
    // full content overlap + in-window time -> confidence 1.0 but via Tier-1
    expect(m.contentScore).toBe(1);
    expect(m.timeScore).toBe(1);
    expect(m.confidence).toBeCloseTo(1.0);
    expect(m.evidence.join(' ')).not.toContain('anchor');
    expect(tierOf(m.confidence)).toBe('strong');
  });
});

describe('Tier-1 content scoring', () => {
  it('partial overlap yields proportional content score', () => {
    // commit adds 4 effective lines; edit only contributes 2 of them
    const commits = [
      commit('c1', [
        commitFile('f.ts', ['alpha line', 'beta line', 'gamma line', 'delta line']),
      ]),
    ];
    const s = session('S', [
      fileEdit(REPO + '/f.ts', 'alpha line\nbeta line', { ts: '2026-06-01T11:59:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'f.ts')!;
    expect(m.contentScore).toBeCloseTo(2 / 4);
  });

  it('prefers patch + lines over newText when patch is present', () => {
    // newText is garbage; patch holds the real added lines matching the commit
    const commits = [commit('c2', [commitFile('g.ts', ['real added one', 'real added two'])])];
    const s = session('S', [
      fileEdit(REPO + '/g.ts', 'irrelevant newtext garbage', {
        ts: '2026-06-01T11:59:00.000Z',
        seq: 1,
        patch: patchFrom(['real added one', 'real added two'], ['some context line']),
      }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'g.ts')!;
    expect(m.contentScore).toBe(1);
  });

  it('merges multiple edits in the same session+file as a union', () => {
    const commits = [
      commit('c3', [commitFile('h.ts', ['part one aaa', 'part two bbb'])]),
    ];
    const s = session('S', [
      fileEdit(REPO + '/h.ts', 'part one aaa', { ts: '2026-06-01T11:58:00.000Z', seq: 1 }),
      fileEdit(REPO + '/h.ts', 'part two bbb', { ts: '2026-06-01T11:59:00.000Z', seq: 2 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'h.ts')!;
    expect(m.contentScore).toBe(1);
    expect(m.editSeqs).toEqual([1, 2]);
  });
});

describe('write (whole-file) matching', () => {
  it('a write op uses newText line set against commit added lines', () => {
    const commits = [
      commit('c4', [commitFile('new.ts', ['header comment', 'function foo() {}'], 'A')]),
    ];
    const s = session('S', [
      fileEdit(REPO + '/new.ts', 'header comment\nfunction foo() {}', {
        op: 'write',
        ts: '2026-06-01T11:59:00.000Z',
        seq: 1,
        patch: null,
      }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'new.ts')!;
    expect(m.contentScore).toBe(1);
  });
});

describe('failed edit exclusion', () => {
  it('excludes succeeded===false edits from matching', () => {
    const commits = [commit('c5', [commitFile('fail.ts', ['unique content xyz', 'second line qq'])])];
    const s = session('S', [
      fileEdit(REPO + '/fail.ts', 'unique content xyz\nsecond line qq', {
        ts: '2026-06-01T11:59:00.000Z',
        seq: 1,
        succeeded: false,
      }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'fail.ts');
    expect(m).toBeUndefined();
  });

  it('keeps succeeded===null edits (unknown result)', () => {
    const commits = [commit('c6', [commitFile('ok.ts', ['kept content here'])])];
    const s = session('S', [
      fileEdit(REPO + '/ok.ts', 'kept content here', {
        ts: '2026-06-01T11:59:00.000Z',
        seq: 1,
        succeeded: null,
      }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    expect(report.matches.find((x) => x.filePath === 'ok.ts')).toBeDefined();
  });
});

describe('Tier-2 time window', () => {
  const lines = ['shared line one', 'shared line two'];

  it('edit inside window scores time 1', () => {
    const commits = [
      commit('t1', [commitFile('t.ts', lines)], { committerDate: '2026-06-01T12:00:00.000Z' }),
    ];
    const s = session('S', [
      fileEdit(REPO + '/t.ts', lines.join('\n'), { ts: '2026-06-01T11:59:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 't.ts')!;
    expect(m.timeScore).toBe(1);
  });

  it('edit within 2min clock-tolerance after commit still scores 1', () => {
    const commits = [
      commit('t2', [commitFile('t.ts', lines)], { committerDate: '2026-06-01T12:00:00.000Z' }),
    ];
    const s = session('S', [
      fileEdit(REPO + '/t.ts', lines.join('\n'), { ts: '2026-06-01T12:01:30.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 't.ts')!;
    expect(m.timeScore).toBe(1);
  });

  it('edit well outside window decays toward 0', () => {
    const commits = [
      commit('t3', [commitFile('t.ts', lines)], { committerDate: '2026-06-01T12:00:00.000Z' }),
    ];
    // 12h after commit+tolerance -> 12 * (1/24) = 0.5 decay -> score 0.5
    const s = session('S', [
      fileEdit(REPO + '/t.ts', lines.join('\n'), { ts: '2026-06-02T00:02:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 't.ts')!;
    expect(m.timeScore).toBeCloseTo(0.5, 2);
  });

  it('uses the better of authorDate/committerDate (rebase drift)', () => {
    // committerDate far in past (would decay), authorDate near the edit -> picks author
    const commits = [
      commit('t4', [commitFile('t.ts', lines)], {
        authorDate: '2026-06-01T12:00:00.000Z',
        committerDate: '2026-05-01T12:00:00.000Z',
      }),
    ];
    const s = session('S', [
      fileEdit(REPO + '/t.ts', lines.join('\n'), { ts: '2026-06-01T11:59:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 't.ts')!;
    expect(m.timeScore).toBe(1);
  });

  it('respects lower bound: edit before previous commit on same file gets reduced time', () => {
    // two commits touch t.ts; for the second commit, the lower bound is commit1 time.
    const c1 = commit('p1', [commitFile('t.ts', ['old aaa', 'old bbb'])], {
      committerDate: '2026-06-01T10:00:00.000Z',
    });
    const c2 = commit('p2', [commitFile('t.ts', ['new ccc', 'new ddd'])], {
      committerDate: '2026-06-01T12:00:00.000Z',
    });
    // edit at 09:00 — BEFORE c1 (lower bound for c2). Should not be in c2's window.
    const s = session('S', [
      fileEdit(REPO + '/t.ts', 'new ccc\nnew ddd', { ts: '2026-06-01T09:00:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, [c1, c2], [s]);
    const m2 = report.matches.find((x) => x.commitHash === 'p2' && x.filePath === 't.ts')!;
    // 09:00 is 1h before lower bound (10:00) -> decay 1/24 -> ~0.958
    expect(m2.timeScore).toBeLessThan(1);
    expect(m2.timeScore).toBeCloseTo(1 - 1 / 24, 2);
  });
});

describe('cross-session competition', () => {
  it('keeps candidates from multiple sessions for the same (commit,file)', () => {
    const commits = [commit('x1', [commitFile('shared.ts', ['common line one', 'common line two'])])];
    const s1 = session('S1', [
      fileEdit(REPO + '/shared.ts', 'common line one\ncommon line two', {
        ts: '2026-06-01T11:59:00.000Z',
        seq: 1,
      }),
    ]);
    const s2 = session('S2', [
      fileEdit(REPO + '/shared.ts', 'common line one', { ts: '2026-06-01T11:58:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s1, s2]);
    const forFile = report.matches.filter((m) => m.filePath === 'shared.ts');
    const sids = forFile.map((m) => m.sessionId).sort();
    expect(sids).toEqual(['S1', 'S2']);
    expect(report.sessionsContributing).toBe(2);
  });
});

describe('whitespace / single-char lines not scored', () => {
  it('blank and single-char lines are excluded from numerator and denominator', () => {
    // commit added lines: 2 real + a blank + a single char "}". Only 2 count.
    const commits = [
      commit('w1', [commitFile('w.ts', ['meaningful line one', 'meaningful line two', '', '}'])]),
    ];
    const s = session('S', [
      // edit contributes the 2 real lines plus a blank + single char (ignored)
      fileEdit(REPO + '/w.ts', 'meaningful line one\nmeaningful line two\n\n}', {
        ts: '2026-06-01T11:59:00.000Z',
        seq: 1,
      }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    const m = report.matches.find((x) => x.filePath === 'w.ts')!;
    // denominator = 2 (blanks/single-char dropped), both hit
    expect(m.contentScore).toBe(1);
    expect(m.evidence.join(' ')).toContain('2/2');
  });
});

describe('path normalization', () => {
  it('strips repo prefix from absolute paths', () => {
    const commits = [commit('n1', [commitFile('deep/nested/file.ts', ['abc def ghi'])])];
    const s = session('S', [
      fileEdit(REPO + '/deep/nested/file.ts', 'abc def ghi', { ts: '2026-06-01T11:59:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    expect(report.matches.find((m) => m.filePath === 'deep/nested/file.ts')).toBeDefined();
  });

  it('strips cwd prefix when cwd differs from repoPath', () => {
    // session cwd is a subdir alias different from repo; edit path under cwd
    const cwd = '/Users/dev/proj-worktree';
    const commits = [commit('n2', [commitFile('lib/x.ts', ['unique aaa bbb'])])];
    const s = session(
      'S',
      [fileEdit(cwd + '/lib/x.ts', 'unique aaa bbb', { ts: '2026-06-01T11:59:00.000Z', seq: 1 })],
      cwd
    );
    const report = engine.match(REPO, commits, [s]);
    expect(report.matches.find((m) => m.filePath === 'lib/x.ts')).toBeDefined();
  });
});

describe('unmatched commits reporting', () => {
  it('lists commits with no matches and their subject', () => {
    const commits = [
      commit('u1', [commitFile('a.ts', ['matched content line'])]),
      commit('u2', [commitFile('manual.ts', ['hand written never seen'])], {
        message: 'manual commit\n\nbody',
      }),
    ];
    const s = session('S', [
      fileEdit(REPO + '/a.ts', 'matched content line', { ts: '2026-06-01T11:59:00.000Z', seq: 1 }),
    ]);
    const report = engine.match(REPO, commits, [s]);
    expect(report.unmatchedCommits).toEqual([{ hash: 'u2', subject: 'manual commit' }]);
  });
});
