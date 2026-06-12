/**
 * 蒸馏编排单测 —— 合成 session + fake distiller + fake parser，tmpdir 写真实
 * report.json / notes.json 做往返。覆盖：digest 构建、hash 跳过、supersede 应用、
 * notes.json 往返、id 分配、anchors.sessionId 回填。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSessionDigest,
  digestHash,
  runDistill,
} from '../../src/distill/orchestrate.js';
import type {
  Distiller,
  DistillInput,
  NotesFile,
} from '../../src/distill/types.js';
import type {
  ParsedSession,
  LoreEvent,
  TranscriptParser,
  ParseResult,
} from '../../src/schema/events.js';
import type { RepoMatchReport, MatchCandidate } from '../../src/match/types.js';

// ── synthetic builders ───────────────────────────────────────────────────────

let seqCounter = 0;
function userMsg(text: string, seq?: number): LoreEvent {
  return { kind: 'user-message', sessionId: 'x', ts: '2026-06-01T10:00:00Z', seq: seq ?? ++seqCounter, text };
}
function asstMsg(text: string, seq?: number): LoreEvent {
  return { kind: 'assistant-message', sessionId: 'x', ts: '2026-06-01T10:00:00Z', seq: seq ?? ++seqCounter, text };
}
function fileEdit(filePath: string, seq?: number, succeeded: boolean | null = true): LoreEvent {
  return {
    kind: 'file-edit',
    sessionId: 'x',
    ts: '2026-06-01T10:00:00Z',
    seq: seq ?? ++seqCounter,
    toolUseId: null,
    op: 'edit',
    filePath,
    oldText: 'old',
    newText: 'new',
    patch: null,
    userModified: null,
    succeeded,
  };
}

function makeSession(
  sessionId: string,
  sourcePath: string,
  events: LoreEvent[],
  startedAt = '2026-06-01T10:00:00Z',
): ParsedSession {
  return {
    meta: {
      schemaVersion: 1,
      agent: 'claude-code',
      sessionId,
      cwd: '/repo',
      gitBranch: 'main',
      startedAt,
      endedAt: '2026-06-01T11:00:00Z',
      sourcePath,
      agentVersion: null,
    },
    events: events.map((e) => ({ ...e, sessionId })),
  };
}

function makeReport(matches: MatchCandidate[]): RepoMatchReport {
  return {
    repo: '/repo',
    generatedAt: '2026-06-01T12:00:00Z',
    schemaVersion: 1,
    commitsTotal: 1,
    commitsMatchedStrong: matches.length,
    commitsMatchedWeak: 0,
    sessionsSeen: 1,
    sessionsContributing: 1,
    window: null,
    commitsInWindow: 1,
    strongInWindow: matches.length,
    weakInWindow: 0,
    matches,
    unmatchedCommits: [],
  };
}

function match(sessionId: string, commitHash: string, filePath: string): MatchCandidate {
  return {
    commitHash,
    filePath,
    sessionId,
    editSeqs: [],
    sourcePath: `/transcripts/${sessionId}.jsonl`,
    matchedVia: 'content',
    matchedLines: 5,
    contentScore: 0.9,
    timeScore: 1,
    confidence: 0.92,
    evidence: [],
  };
}

/** fake parser：按 sourcePath 返回预置 session。 */
function fakeParser(map: Record<string, ParsedSession>): TranscriptParser {
  return {
    agent: 'claude-code',
    discover: async () => Object.keys(map),
    parse: async (p: string): Promise<ParseResult> => {
      const s = map[p];
      if (!s) throw new Error(`no fake session for ${p}`);
      return { session: s, skipped: { count: 0, samples: [] } };
    },
  };
}

/** fake distiller：返回固定结果，记录收到的 input。 */
function fakeDistiller(
  responder: (input: DistillInput) => Awaited<ReturnType<Distiller['distill']>>,
): Distiller & { calls: DistillInput[] } {
  const calls: DistillInput[] = [];
  return {
    name: 'fake',
    calls,
    available: async () => true,
    distill: async (input: DistillInput) => {
      calls.push(input);
      return responder(input);
    },
  };
}

// ── tmpdir harness ───────────────────────────────────────────────────────────

let repoDir: string;

beforeEach(() => {
  seqCounter = 0;
  repoDir = mkdtempSync(join(tmpdir(), 'lore-distill-'));
  mkdirSync(join(repoDir, '.lore'), { recursive: true });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function writeReport(report: RepoMatchReport, sourceMap: Record<string, string>): void {
  const file = { ...report, sessionSourceMap: sourceMap, skippedBySession: {} };
  writeFileSync(join(repoDir, '.lore', 'report.json'), JSON.stringify(file, null, 2), 'utf8');
}

function readNotes(): NotesFile {
  return JSON.parse(readFileSync(join(repoDir, '.lore', 'notes.json'), 'utf8')) as NotesFile;
}

// ── buildSessionDigest ───────────────────────────────────────────────────────

describe('buildSessionDigest', () => {
  it('collects all user messages and key assistant messages, normalizes edited files', () => {
    const session = makeSession('s1', '/transcripts/s1.jsonl', [
      userMsg('please use kuzu', 1),
      asstMsg('Sure.', 2), // too short / no decision hint → dropped
      asstMsg('I chose kuzu because it is embedded and avoids native deps in the fallback path.', 3),
      fileEdit('/repo/src/graph/kuzu-store.ts', 4),
    ]);
    const report = makeReport([match('s1', 'abc1234', 'src/graph/kuzu-store.ts')]);

    const d = buildSessionDigest(session, report, '/repo');
    expect(d.sessionId).toBe('s1');
    expect(d.editedFiles).toEqual(['src/graph/kuzu-store.ts']);
    expect(d.commits).toEqual([{ hash: 'abc1234', subject: '' }]);

    const seqs = d.messages.map((m) => m.seq);
    expect(seqs).toContain(1); // user
    expect(seqs).toContain(3); // key assistant
    expect(seqs).not.toContain(2); // dropped noise
    // ordered by seq ascending
    expect([...seqs]).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('truncates long user messages to 1000 chars', () => {
    const long = 'a'.repeat(2000);
    const session = makeSession('s1', '/t.jsonl', [userMsg(long, 1), fileEdit('/repo/a.ts', 2)]);
    const report = makeReport([match('s1', 'h', 'a.ts')]);
    const d = buildSessionDigest(session, report, '/repo');
    expect(d.messages[0]!.text.length).toBeLessThanOrEqual(1000);
  });

  it('ignores failed file edits', () => {
    const session = makeSession('s1', '/t.jsonl', [
      userMsg('hi', 1),
      fileEdit('/repo/good.ts', 2, true),
      fileEdit('/repo/bad.ts', 3, false),
    ]);
    const report = makeReport([match('s1', 'h', 'good.ts'), match('s1', 'h', 'bad.ts')]);
    const d = buildSessionDigest(session, report, '/repo');
    expect(d.editedFiles).toEqual(['good.ts']);
  });
});

describe('digestHash', () => {
  it('is stable for identical content and changes with content', () => {
    const session = makeSession('s1', '/t.jsonl', [userMsg('hi', 1), fileEdit('/repo/a.ts', 2)]);
    const report = makeReport([match('s1', 'h', 'a.ts')]);
    const d1 = buildSessionDigest(session, report, '/repo');
    const d2 = buildSessionDigest(session, report, '/repo');
    expect(digestHash(d1)).toBe(digestHash(d2));

    const session2 = makeSession('s1', '/t.jsonl', [userMsg('changed', 1), fileEdit('/repo/a.ts', 2)]);
    const d3 = buildSessionDigest(session2, report, '/repo');
    expect(digestHash(d3)).not.toBe(digestHash(d1));
  });
});

// ── runDistill ───────────────────────────────────────────────────────────────

describe('runDistill', () => {
  it('distills a session, assigns ids, backfills anchor sessionId, writes notes.json', async () => {
    const session = makeSession('s1', '/transcripts/s1.jsonl', [
      userMsg('use kuzu graph store', 1),
      asstMsg('I chose kuzu because it is embedded and fast for our use case.', 2),
      fileEdit('/repo/src/graph/kuzu-store.ts', 3),
    ]);
    writeReport(makeReport([match('s1', 'abc1234', 'src/graph/kuzu-store.ts')]), {
      s1: '/transcripts/s1.jsonl',
    });

    const distiller = fakeDistiller(() => ({
      notes: [
        {
          kind: 'decision',
          title: 'Use Kuzu',
          body: 'Chose kuzu because embedded.',
          files: ['src/graph/kuzu-store.ts'],
          anchors: [{ sessionId: '', seq: 1 }],
        },
      ],
      supersededIds: [],
    }));

    const parser = fakeParser({ '/transcripts/s1.jsonl': session });
    const stats = await runDistill(repoDir, { distiller, parser });

    expect(stats.distilled).toBe(1);
    expect(stats.notesAdded).toBe(1);
    expect(stats.skipped).toBe(0);

    const notes = readNotes();
    expect(notes.notes).toHaveLength(1);
    const n = notes.notes[0]!;
    expect(n.id).toBe('s1#0');
    expect(n.sessionId).toBe('s1');
    expect(n.validAt).toBe('2026-06-01T10:00:00Z');
    expect(n.invalidAt).toBeNull();
    expect(n.anchors[0]!.sessionId).toBe('s1'); // backfilled
    expect(n.anchors[0]!.seq).toBe(1);
    expect(notes.distilledSessions['s1']).toBeDefined();
  });

  it('skips a session whose digest hash is unchanged', async () => {
    const session = makeSession('s1', '/transcripts/s1.jsonl', [
      userMsg('use kuzu', 1),
      fileEdit('/repo/a.ts', 2),
    ]);
    writeReport(makeReport([match('s1', 'h', 'a.ts')]), { s1: '/transcripts/s1.jsonl' });
    const parser = fakeParser({ '/transcripts/s1.jsonl': session });

    const distiller = fakeDistiller(() => ({
      notes: [
        { kind: 'decision', title: 't', body: 'b', files: ['a.ts'], anchors: [{ sessionId: '', seq: 1 }] },
      ],
      supersededIds: [],
    }));

    // first run distills
    const r1 = await runDistill(repoDir, { distiller, parser });
    expect(r1.distilled).toBe(1);

    // second run: same digest → skipped, no new distill call
    const callsBefore = distiller.calls.length;
    const r2 = await runDistill(repoDir, { distiller, parser });
    expect(r2.skipped).toBe(1);
    expect(r2.distilled).toBe(0);
    expect(distiller.calls.length).toBe(callsBefore); // distiller not re-invoked

    // notes not duplicated
    expect(readNotes().notes).toHaveLength(1);
  });

  it('applies supersede: marks the old note invalid with supersededBy pointing at the new note', async () => {
    // session A (earlier) creates a decision; session B (later) supersedes it.
    const sessA = makeSession(
      'A',
      '/transcripts/A.jsonl',
      [userMsg('use json store', 1), fileEdit('/repo/src/store.ts', 2)],
      '2026-06-01T10:00:00Z',
    );
    const sessB = makeSession(
      'B',
      '/transcripts/B.jsonl',
      [userMsg('switch to kuzu store instead', 1), fileEdit('/repo/src/store.ts', 2)],
      '2026-06-02T10:00:00Z',
    );
    writeReport(
      makeReport([match('A', 'h1', 'src/store.ts'), match('B', 'h2', 'src/store.ts')]),
      { A: '/transcripts/A.jsonl', B: '/transcripts/B.jsonl' },
    );
    const parser = fakeParser({
      '/transcripts/A.jsonl': sessA,
      '/transcripts/B.jsonl': sessB,
    });

    // distiller: A produces a note; B produces a note AND supersedes A's note (id A#0).
    const distiller = fakeDistiller((input) => {
      if (input.digest.sessionId === 'A') {
        return {
          notes: [
            { kind: 'decision', title: 'Use JSON store', body: 'json store chosen', files: ['src/store.ts'], anchors: [{ sessionId: '', seq: 1 }] },
          ],
          supersededIds: [],
        };
      }
      // B sees A#0 as existing note and supersedes it.
      expect(input.existingNotes.map((n) => n.id)).toContain('A#0');
      return {
        notes: [
          { kind: 'decision', title: 'Use Kuzu store', body: 'switched to kuzu', files: ['src/store.ts'], anchors: [{ sessionId: '', seq: 1 }] },
        ],
        supersededIds: ['A#0'],
      };
    });

    const stats = await runDistill(repoDir, { distiller, parser });
    expect(stats.distilled).toBe(2);
    expect(stats.notesAdded).toBe(2);
    expect(stats.superseded).toBe(1);

    const notes = readNotes();
    const a0 = notes.notes.find((n) => n.id === 'A#0')!;
    const b0 = notes.notes.find((n) => n.id === 'B#0')!;
    expect(a0.invalidAt).toBe('2026-06-02T10:00:00Z'); // = B's validAt
    expect(a0.supersededBy).toBe('B#0');
    expect(b0.invalidAt).toBeNull();
  });

  it('round-trips notes.json: a second distinct session appends without clobbering', async () => {
    const sessA = makeSession('A', '/transcripts/A.jsonl', [userMsg('a decision', 1), fileEdit('/repo/a.ts', 2)], '2026-06-01T10:00:00Z');
    writeReport(makeReport([match('A', 'h1', 'a.ts')]), { A: '/transcripts/A.jsonl' });
    const parserA = fakeParser({ '/transcripts/A.jsonl': sessA });
    const distiller = fakeDistiller((input) => ({
      notes: [
        {
          kind: 'decision',
          title: 'decision ' + input.digest.sessionId,
          body: 'b',
          files: [input.digest.editedFiles[0] ?? ''],
          anchors: [{ sessionId: '', seq: 1 }],
        },
      ],
      supersededIds: [],
    }));
    await runDistill(repoDir, { distiller, parser: parserA });
    expect(readNotes().notes).toHaveLength(1);

    // now add session B to the report and run again — A is skipped (hash), B appended.
    const sessB = makeSession('B', '/transcripts/B.jsonl', [userMsg('b decision', 1), fileEdit('/repo/b.ts', 2)], '2026-06-02T10:00:00Z');
    writeReport(
      makeReport([match('A', 'h1', 'a.ts'), match('B', 'h2', 'b.ts')]),
      { A: '/transcripts/A.jsonl', B: '/transcripts/B.jsonl' },
    );
    const parserAB = fakeParser({ '/transcripts/A.jsonl': sessA, '/transcripts/B.jsonl': sessB });
    const stats = await runDistill(repoDir, { distiller, parser: parserAB });
    expect(stats.skipped).toBe(1);
    expect(stats.distilled).toBe(1);

    const notes = readNotes();
    expect(notes.notes.map((n) => n.id).sort()).toEqual(['A#0', 'B#0']);
  });

  it('records an error when report.json is missing, without throwing', async () => {
    const distiller = fakeDistiller(() => ({ notes: [], supersededIds: [] }));
    const parser = fakeParser({});
    const stats = await runDistill(repoDir, { distiller, parser });
    expect(stats.errors.length).toBeGreaterThan(0);
    expect(stats.distilled).toBe(0);
  });

  it('propagates distiller-reported error into stats but still counts as distilled', async () => {
    const session = makeSession('s1', '/transcripts/s1.jsonl', [userMsg('x', 1), fileEdit('/repo/a.ts', 2)]);
    writeReport(makeReport([match('s1', 'h', 'a.ts')]), { s1: '/transcripts/s1.jsonl' });
    const parser = fakeParser({ '/transcripts/s1.jsonl': session });
    const distiller = fakeDistiller(() => ({ notes: [], supersededIds: [], error: 'bad LLM output' }));
    const stats = await runDistill(repoDir, { distiller, parser });
    expect(stats.distilled).toBe(1);
    expect(stats.notesAdded).toBe(0);
    expect(stats.errors.some((e) => e.error === 'bad LLM output')).toBe(true);
  });

  it('respects maxSessions', async () => {
    const sessA = makeSession('A', '/transcripts/A.jsonl', [userMsg('a', 1), fileEdit('/repo/a.ts', 2)], '2026-06-01T10:00:00Z');
    const sessB = makeSession('B', '/transcripts/B.jsonl', [userMsg('b', 1), fileEdit('/repo/b.ts', 2)], '2026-06-02T10:00:00Z');
    writeReport(
      makeReport([match('A', 'h1', 'a.ts'), match('B', 'h2', 'b.ts')]),
      { A: '/transcripts/A.jsonl', B: '/transcripts/B.jsonl' },
    );
    const parser = fakeParser({ '/transcripts/A.jsonl': sessA, '/transcripts/B.jsonl': sessB });
    const distiller = fakeDistiller(() => ({
      notes: [{ kind: 'decision', title: 't', body: 'b', files: [], anchors: [{ sessionId: '', seq: 1 }] }],
      supersededIds: [],
    }));
    const stats = await runDistill(repoDir, { distiller, parser, maxSessions: 1 });
    expect(stats.distilled).toBe(1);
    // earliest session (A) processed first
    expect(distiller.calls).toHaveLength(1);
    expect(distiller.calls[0]!.digest.sessionId).toBe('A');
  });
});
