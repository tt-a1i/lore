/**
 * 共享摘录提取（src/excerpts/compute.ts）测试。
 *
 * - excerptsForCandidate / topStrongCandidateByCommit 是纯函数：用手搓的 ParsedSession
 *   / MatchCandidate 直接断言（不碰文件系统）。
 * - computeExcerpts 端到端：真实临时 repo + fixture transcript + report.json，
 *   验证与原 server.ts 行为一致（user 优先、≤2 条、≤320 字符、仅 strong）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  excerptsForCandidate,
  topStrongCandidateByCommit,
  computeExcerpts,
  EXCERPT_MAX,
} from '../../src/excerpts/compute.js';
import { claudeCodeParser } from '../../src/parsers/claude-code.js';
import { codexParser } from '../../src/parsers/codex.js';
import type { ParsedSession, LoreEvent } from '../../src/schema/events.js';
import type { MatchCandidate } from '../../src/match/types.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'lore-compute-'));
  tmpDirs.push(dir);
  return dir;
}

// ── synthetic ParsedSession for the pure-function tests ──────────────────────

function userMsg(seq: number, text: string): LoreEvent {
  return { kind: 'user-message', sessionId: 'ses-x', ts: '2026-06-01T10:00:00.000Z', seq, text };
}
function asstMsg(seq: number, text: string): LoreEvent {
  return { kind: 'assistant-message', sessionId: 'ses-x', ts: '2026-06-01T10:00:01.000Z', seq, text };
}
function fileEdit(seq: number): LoreEvent {
  return {
    kind: 'file-edit',
    sessionId: 'ses-x',
    ts: '2026-06-01T10:00:02.000Z',
    seq,
    toolUseId: 't1',
    op: 'edit',
    filePath: '/x/foo.ts',
    oldText: 'a',
    newText: 'b',
    patch: null,
    userModified: null,
    succeeded: true,
  };
}

function session(events: LoreEvent[]): ParsedSession {
  return {
    meta: {
      schemaVersion: 1,
      agent: 'claude-code',
      sessionId: 'ses-x',
      cwd: '/x',
      gitBranch: 'main',
      startedAt: '2026-06-01T10:00:00.000Z',
      endedAt: null,
      sourcePath: '/x/ses-x.jsonl',
      agentVersion: null,
    },
    events,
  };
}

function cand(commitHash: string, confidence: number): MatchCandidate {
  return {
    commitHash,
    filePath: 'foo.ts',
    sessionId: 'ses-x',
    editSeqs: [],
    sourcePath: '/x/ses-x.jsonl',
    matchedVia: 'content',
    matchedLines: 1,
    contentScore: confidence,
    timeScore: 1,
    confidence,
    evidence: [],
  };
}

describe('excerptsForCandidate — pure extraction', () => {
  it('picks nearest user + assistant around the edit, user first, ≤2', () => {
    const s = session([
      userMsg(0, 'add foo helper'),
      asstMsg(1, 'doing it now'),
      fileEdit(2),
    ]);
    const out = excerptsForCandidate(s, [2]);
    expect(out.length).toBe(2);
    expect(out[0]!.role).toBe('user'); // user 优先
    expect(out[0]!.text).toBe('add foo helper');
    expect(out[1]!.role).toBe('assistant');
  });

  it('truncates to EXCERPT_MAX (320) with ellipsis', () => {
    const long = 'Z'.repeat(900);
    const s = session([userMsg(0, long), fileEdit(1)]);
    const out = excerptsForCandidate(s, [1]);
    const u = out.find((e) => e.role === 'user')!;
    expect(u.text.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(u.text.endsWith('…')).toBe(true);
  });

  it('returns empty when no editSeq matches a file-edit', () => {
    const s = session([userMsg(0, 'hi'), fileEdit(1)]);
    expect(excerptsForCandidate(s, [99])).toEqual([]);
  });

  it('dedupes the same (seq, role) anchor across multiple edits', () => {
    const s = session([
      userMsg(0, 'shared intent'),
      fileEdit(1),
      fileEdit(2),
    ]);
    const out = excerptsForCandidate(s, [1, 2]);
    // both edits resolve to the same nearest user-message seq 0 → one entry.
    const users = out.filter((e) => e.role === 'user');
    expect(users.length).toBe(1);
  });
});

describe('topStrongCandidateByCommit — pure selection', () => {
  it('keeps only strong (≥0.8) and the top per commit', () => {
    const top = topStrongCandidateByCommit([
      cand('aaa', 0.6), // weak — dropped
      cand('bbb', 0.85),
      cand('bbb', 0.95), // higher for bbb wins
      cand('ccc', 0.79), // just below floor — dropped
    ]);
    expect([...top.keys()].sort()).toEqual(['bbb']);
    expect(top.get('bbb')!.confidence).toBe(0.95);
  });

  it('returns an empty map when all candidates are weak', () => {
    expect(topStrongCandidateByCommit([cand('a', 0.5), cand('b', 0.1)]).size).toBe(0);
  });
});

// ── computeExcerpts end-to-end (matches old server.ts behaviour) ─────────────

function writeTranscript(dir: string): string {
  const cwd = '/x/proj';
  const lines = [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'ses-c',
      cwd, gitBranch: 'main', version: '2.1.170',
      timestamp: '2026-06-01T10:00:00.000Z', isMeta: false,
      message: { role: 'user', content: 'Add a foo helper to src/foo.ts please.' },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'ses-c',
      timestamp: '2026-06-01T10:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure — adding the foo helper now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {
            file_path: `${cwd}/src/foo.ts`,
            old_string: 'export const x = 1;',
            new_string: 'export const x = 1;\nexport function foo() { return 42; }',
          } },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'ses-c',
      timestamp: '2026-06-01T10:00:05.000Z',
      toolUseResult: {
        type: 'update', filePath: `${cwd}/src/foo.ts`,
        content: 'export const x = 1;\nexport function foo() { return 42; }\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
          lines: ['+export function foo() { return 42; }'] }],
        originalFile: 'export const x = 1;\n', userModified: false,
      },
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'File updated.', is_error: false },
      ] },
    },
  ];
  const p = join(dir, 'ses-c.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function writeCodexTranscript(
  dir: string,
  opts: {
    sessionId: string;
    cwd: string;
    relFile: string;
    userText: string;
    assistantText: string;
    oldLine: string;
    newLine: string;
  },
): string {
  const diff = [
    '@@ -1,1 +1,1 @@',
    '-' + opts.oldLine,
    '+' + opts.newLine,
  ].join('\n');
  const lines = [
    {
      timestamp: '2026-06-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: opts.sessionId, cwd: opts.cwd, cli_version: '0.139.0' },
    },
    {
      timestamp: '2026-06-01T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: opts.userText },
    },
    {
      timestamp: '2026-06-01T10:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: opts.assistantText },
    },
    {
      timestamp: '2026-06-01T10:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call_codex_1',
        success: true,
        changes: {
          [opts.relFile]: { type: 'update', unified_diff: diff },
        },
      },
    },
  ];
  const p = join(dir, `${opts.sessionId}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function writeReport(repo: string, matches: object[]): void {
  mkdirSync(join(repo, '.lore'), { recursive: true });
  writeFileSync(join(repo, '.lore', 'report.json'), JSON.stringify({ matches }), 'utf8');
}

describe('computeExcerpts — end to end', () => {
  it('extracts shaped excerpts for the top strong candidate', async () => {
    const repo = makeRepo();
    const transcript = writeTranscript(repo);
    writeReport(repo, [
      {
        commitHash: 'abc111', filePath: 'src/foo.ts', sessionId: 'ses-c',
        editSeqs: [2], sourcePath: transcript, matchedVia: 'content',
        matchedLines: 3, contentScore: 0.9, timeScore: 1, confidence: 0.92, evidence: [],
      },
    ]);

    const out = await computeExcerpts(repo, claudeCodeParser);
    expect(Object.keys(out)).toEqual(['abc111']);
    const quotes = out['abc111']!;
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.length).toBeLessThanOrEqual(2);
    expect(quotes[0]!.role).toBe('user');
    expect(quotes.some((q) => q.text.includes('foo helper'))).toBe(true);
    expect(quotes[0]!.sessionId).toBe('ses-c');
    for (const q of quotes) expect(q.text.length).toBeLessThanOrEqual(EXCERPT_MAX);
  });

  it('extracts excerpts for a Codex strong candidate through the default parser registry', async () => {
    const repo = makeRepo();
    const transcript = writeCodexTranscript(repo, {
      sessionId: 'codex-excerpt',
      cwd: repo,
      relFile: 'src/codex.ts',
      userText: 'Please rename the Codex flag.',
      assistantText: 'I will apply the Codex flag rename now.',
      oldLine: 'export const flagName = "old";',
      newLine: 'export const flagName = "new";',
    });
    const parsed = await codexParser.parse(transcript);
    const editEvent = parsed.session.events.find((e) => e.kind === 'file-edit')!;

    writeReport(repo, [
      {
        commitHash: 'codex111', filePath: 'src/codex.ts', sessionId: 'codex-excerpt',
        editSeqs: [editEvent.seq], sourcePath: transcript, matchedVia: 'content',
        matchedLines: 3, contentScore: 1, timeScore: 1, confidence: 0.93, evidence: [],
      },
    ]);

    const out = await computeExcerpts(repo);
    expect(Object.keys(out)).toEqual(['codex111']);
    expect(out['codex111']!.some((q) => q.text.includes('Codex flag'))).toBe(true);
    expect(out['codex111']!.some((q) => q.sessionId === 'codex-excerpt')).toBe(true);
  });

  it('returns {} when report.json is absent', async () => {
    const repo = makeRepo();
    expect(await computeExcerpts(repo, claudeCodeParser)).toEqual({});
  });

  it('returns {} when only weak candidates exist', async () => {
    const repo = makeRepo();
    const transcript = writeTranscript(repo);
    writeReport(repo, [
      {
        commitHash: 'weak1', filePath: 'src/foo.ts', sessionId: 'ses-c',
        editSeqs: [2], sourcePath: transcript, matchedVia: 'content',
        matchedLines: 3, contentScore: 0.5, timeScore: 1, confidence: 0.5, evidence: [],
      },
    ]);
    expect(await computeExcerpts(repo, claudeCodeParser)).toEqual({});
  });

  it('skips a commit whose transcript cannot be parsed (no throw)', async () => {
    const repo = makeRepo();
    writeReport(repo, [
      {
        commitHash: 'gone1', filePath: 'src/foo.ts', sessionId: 'ses-c',
        editSeqs: [2], sourcePath: join(repo, 'does-not-exist.jsonl'),
        matchedVia: 'content', matchedLines: 3, contentScore: 0.9, timeScore: 1,
        confidence: 0.92, evidence: [],
      },
    ]);
    expect(await computeExcerpts(repo, claudeCodeParser)).toEqual({});
  });
});
