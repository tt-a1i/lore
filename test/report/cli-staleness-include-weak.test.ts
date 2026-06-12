/**
 * Tests for:
 *   1. staleness() — pure helper that decides whether to emit a WARNING.
 *   2. --include-weak passthrough — renderWhyResult shows weak attributions
 *      when includeWeak is set (the confidence floor is lowered in the engine;
 *      the renderer always shows what it receives).
 *
 * No real fs/git/transcript reads — all fixtures constructed in-memory.
 */

import { describe, it, expect } from 'vitest';
import { staleness, renderWhyResult } from '../../src/cli.js';
import type { WhyResult, WhyAttribution } from '../../src/why/types.js';
import type { CommitNodeData, ProducedInfo, SessionNodeData } from '../../src/graph/types.js';

// ── Staleness helper ──────────────────────────────────────────────────────────

const NOW = 1_750_000_000_000; // fixed "now" in ms (approx 2025-06)

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

describe('staleness()', () => {
  const REPO = '/tmp/test-repo';

  it('returns null when generatedAt is fresh and HEAD is older', () => {
    const generatedAt = msToIso(NOW - 60_000); // 1 minute ago
    const headTime = msToIso(NOW - 120_000);   // 2 minutes ago (older than report)
    const result = staleness({ generatedAt, nowMs: NOW, headTime, repoPath: REPO, useColor: false });
    expect(result).toBeNull();
  });

  it('returns null when generatedAt is exactly 4 hours ago (boundary — not stale)', () => {
    const FOUR_H = 4 * 60 * 60 * 1000;
    const generatedAt = msToIso(NOW - FOUR_H);
    const result = staleness({ generatedAt, nowMs: NOW, headTime: null, repoPath: REPO, useColor: false });
    // Boundary: nowMs - generatedMs === FOUR_H, NOT > FOUR_H, so not stale.
    expect(result).toBeNull();
  });

  it('returns a warning string when generatedAt is more than 4 hours old', () => {
    const FOUR_H = 4 * 60 * 60 * 1000;
    const generatedAt = msToIso(NOW - FOUR_H - 1); // 1 ms over the limit
    const result = staleness({ generatedAt, nowMs: NOW, headTime: null, repoPath: REPO, useColor: false });
    expect(result).not.toBeNull();
    expect(result).toContain('WARNING');
    expect(result).toContain('stale');
    expect(result).toContain('lore scan');
    expect(result).toContain(REPO);
  });

  it('returns a warning string when HEAD commit is newer than generatedAt', () => {
    const generatedAt = msToIso(NOW - 60_000); // 1 minute ago
    const headTime = msToIso(NOW - 30_000);    // 30 seconds ago — newer!
    const result = staleness({ generatedAt, nowMs: NOW, headTime, repoPath: REPO, useColor: false });
    expect(result).not.toBeNull();
    expect(result).toContain('WARNING');
    expect(result).toContain('stale');
  });

  it('includes the generated timestamp and HEAD timestamp in the warning', () => {
    const generatedAt = '2025-06-10T08:00:00.000Z';
    const headTime = '2025-06-10T09:00:00.000Z'; // newer
    const result = staleness({ generatedAt, nowMs: NOW, headTime, repoPath: REPO, useColor: false });
    expect(result).not.toBeNull();
    expect(result!).toContain('2025-06-10 08:00:00');
    expect(result!).toContain('2025-06-10 09:00:00');
  });

  it('shows "unknown" for HEAD in the warning when headTime is null and age is stale', () => {
    const FOUR_H = 4 * 60 * 60 * 1000;
    const generatedAt = msToIso(NOW - FOUR_H - 60_000);
    const result = staleness({ generatedAt, nowMs: NOW, headTime: null, repoPath: REPO, useColor: false });
    expect(result).not.toBeNull();
    expect(result!).toContain('unknown');
  });

  it('wraps WARNING in ANSI yellow when useColor=true', () => {
    const FOUR_H = 4 * 60 * 60 * 1000;
    const generatedAt = msToIso(NOW - FOUR_H - 1);
    const result = staleness({ generatedAt, nowMs: NOW, headTime: null, repoPath: REPO, useColor: true });
    expect(result).not.toBeNull();
    // ANSI escape for bold yellow
    expect(result!).toContain('\x1b[1;33m');
    expect(result!).toContain('\x1b[0m');
  });

  it('does NOT wrap WARNING in ANSI when useColor=false', () => {
    const FOUR_H = 4 * 60 * 60 * 1000;
    const generatedAt = msToIso(NOW - FOUR_H - 1);
    const result = staleness({ generatedAt, nowMs: NOW, headTime: null, repoPath: REPO, useColor: false });
    expect(result).not.toBeNull();
    expect(result!).not.toContain('\x1b[');
    // Plain text WARNING
    expect(result!.startsWith('WARNING')).toBe(true);
  });

  it('returns null when generatedAt is not a valid ISO string', () => {
    const result = staleness({ generatedAt: 'not-a-date', nowMs: NOW, headTime: null, repoPath: REPO, useColor: false });
    expect(result).toBeNull();
  });

  it('returns null when headTime is not a valid ISO string (only age check matters)', () => {
    const generatedAt = msToIso(NOW - 60_000); // 1 minute ago — fresh
    const result = staleness({ generatedAt, nowMs: NOW, headTime: 'invalid', repoPath: REPO, useColor: false });
    // Age < 4h, headTime invalid → not stale
    expect(result).toBeNull();
  });
});

// ── --include-weak passthrough via renderWhyResult ────────────────────────────
//
// The confidence floor is enforced in the engine (why/engine.ts); the CLI
// simply passes the flag through to the engine and renders whatever comes back.
// These tests verify that renderWhyResult faithfully renders weak attributions
// when they are present — i.e., the renderer does NOT silently drop them.

function makeSession(overrides: Partial<SessionNodeData> = {}): SessionNodeData {
  return {
    id: 'test-session-abc',
    agent: 'claude-code',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T11:00:00.000Z',
    cwd: '/repo',
    gitBranch: 'main',
    sourcePaths: ['/tmp/test.jsonl'],
    ...overrides,
  };
}

function makeCommit(overrides: Partial<CommitNodeData> = {}): CommitNodeData {
  return {
    hash: 'abc1234567890abc',
    subject: 'chore: weak test',
    authorDate: '2026-01-01T12:00:00.000Z',
    committerDate: '2026-01-01T12:05:00.000Z',
    isMerge: false,
    ...overrides,
  };
}

function makeProduced(confidence: number, sessionId = 'test-session-abc'): ProducedInfo {
  return {
    sessionId,
    commitHash: 'abc1234567890abc',
    confidence,
    matchedVia: 'content',
    sourcePath: '/tmp/test.jsonl',
    matchedLines: 3,
    fileCount: 1,
    session: makeSession({ id: sessionId }),
  };
}

function makeAttr(confidence: number, sessionId = 'test-session-abc'): WhyAttribution {
  return {
    produced: makeProduced(confidence, sessionId),
    editSeqs: [],
    excerpts: [],
  };
}

function makeResult(attributions: WhyAttribution[]): WhyResult {
  return {
    file: 'src/foo.ts',
    line: 10,
    lineContent: 'export const x = 1;',
    commit: makeCommit(),
    attributions,
    editedBy: [],
  };
}

describe('renderWhyResult — --include-weak passthrough', () => {
  const REPO = '/repo';

  it('renders a weak attribution (confidence 0.65) without hiding it', () => {
    const result = makeResult([makeAttr(0.65)]);
    const out = renderWhyResult(result, REPO);
    expect(out).toContain('0.650');
    expect(out).toContain('weak');
  });

  it('renders a strong attribution and labels it correctly', () => {
    const result = makeResult([makeAttr(0.85)]);
    const out = renderWhyResult(result, REPO);
    expect(out).toContain('0.850');
    expect(out).toContain('strong');
  });

  it('renders mixed strong + weak attributions in order when both present', () => {
    const result = makeResult([makeAttr(0.92, 'sess-strong'), makeAttr(0.60, 'sess-weak')]);
    const out = renderWhyResult(result, REPO);
    expect(out).toContain('[1/2]');
    expect(out).toContain('[2/2]');
    expect(out).toContain('strong');
    expect(out).toContain('weak');
  });

  it('shows attribution:none when engine returns no attributions (default strong floor filtered all)', () => {
    // Engine was called without --include-weak and returned [] — the CLI
    // renders the blind-spot path.
    const result = makeResult([]);
    const out = renderWhyResult(result, REPO);
    expect(out).toContain('attribution: none');
    expect(out).toContain('no conversation linked');
  });
});
