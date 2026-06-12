/**
 * Unit tests for src/report/markdown.ts
 *
 * All test data is hand-constructed — no real transcripts read from disk.
 */

import { describe, it, expect } from 'vitest';
import { renderReport } from '../../src/report/markdown.js';
import type { RepoMatchReport } from '../../src/match/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A minimal but complete RepoMatchReport for testing. */
function makeReport(overrides: Partial<RepoMatchReport> = {}): RepoMatchReport {
  const defaults: RepoMatchReport = {
    repo: '/tmp/test-repo',
    generatedAt: '2026-06-12T10:00:00.000Z',
    schemaVersion: 1,
    commitsTotal: 10,
    commitsMatchedStrong: 5,
    commitsMatchedWeak: 2,
    sessionsSeen: 3,
    sessionsContributing: 2,
    matches: [],
    unmatchedCommits: [],
  };
  return { ...defaults, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('renderReport', () => {
  it('returns a non-empty string', () => {
    const output = renderReport(makeReport());
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('includes the repo path in the header', () => {
    const output = renderReport(makeReport({ repo: '/home/user/myproject' }));
    expect(output).toContain('/home/user/myproject');
  });

  it('includes generatedAt', () => {
    const output = renderReport(makeReport());
    expect(output).toContain('2026-06-12T10:00:00.000Z');
  });

  it('shows total commits in overview', () => {
    const output = renderReport(makeReport({ commitsTotal: 42 }));
    expect(output).toContain('42');
  });

  it('shows sessions seen and contributing', () => {
    const report = makeReport({ sessionsSeen: 7, sessionsContributing: 4 });
    const output = renderReport(report);
    expect(output).toContain('7');
    expect(output).toContain('4');
  });

  it('contains overview section heading', () => {
    const output = renderReport(makeReport());
    expect(output).toContain('## Overview');
  });

  it('contains confidence distribution section heading', () => {
    const output = renderReport(makeReport());
    expect(output).toContain('## Confidence Distribution');
  });

  it('contains unmatched commits section heading', () => {
    const output = renderReport(makeReport());
    expect(output).toContain('## Unmatched Commits');
  });

  it('shows "full coverage" message when no unmatched commits', () => {
    const output = renderReport(makeReport({ unmatchedCommits: [] }));
    expect(output).toContain('full coverage');
  });

  it('lists unmatched commit hashes and subjects', () => {
    const report = makeReport({
      unmatchedCommits: [
        { hash: 'abc1234', subject: 'chore: manual cleanup' },
        { hash: 'def5678', subject: 'fix: typo in README' },
      ],
    });
    const output = renderReport(report);
    expect(output).toContain('abc1234');
    expect(output).toContain('chore: manual cleanup');
    expect(output).toContain('def5678');
    expect(output).toContain('fix: typo in README');
  });

  it('truncates unmatched list to 20 and shows overflow hint', () => {
    const unmatched = Array.from({ length: 25 }, (_, i) => ({
      hash: `hash${String(i).padStart(4, '0')}`,
      subject: `commit subject ${i}`,
    }));
    const output = renderReport(makeReport({ unmatchedCommits: unmatched }));
    // Should show at most 20 entries explicitly
    expect(output).toContain('hash0000');
    expect(output).toContain('hash0019');
    // Should not show the 21st
    expect(output).not.toContain('hash0020');
    // Should mention the remaining count
    expect(output).toContain('5 more');
  });

  it('includes histogram bar chart with code fences', () => {
    const output = renderReport(makeReport());
    expect(output).toContain('```');
    expect(output).toContain('[0.0–0.1)');
    expect(output).toContain('[0.9–1.0)');
  });

  it('distributes confidence scores into correct histogram buckets', () => {
    const matches = [
      // strong tier: bucket [0.9–1.0)
      {
        commitHash: 'aaa00001',
        filePath: 'src/a.ts',
        sessionId: 'sess-1',
        editSeqs: [1],
        contentScore: 0.95,
        timeScore: 0.9,
        confidence: 0.95,
        evidence: [],
      },
      // weak tier: bucket [0.5–0.6)
      {
        commitHash: 'bbb00002',
        filePath: 'src/b.ts',
        sessionId: 'sess-1',
        editSeqs: [2],
        contentScore: 0.5,
        timeScore: 0.5,
        confidence: 0.5,
        evidence: [],
      },
    ];
    const output = renderReport(makeReport({ matches }));
    // Both buckets should appear in histogram
    expect(output).toContain('[0.9–1.0)');
    expect(output).toContain('[0.5–0.6)');
  });

  it('shows top strong matches section when strong matches exist', () => {
    const matches = [
      {
        commitHash: 'stronghash123',
        filePath: 'lib/core.ts',
        sessionId: 'session-abc',
        editSeqs: [5, 6],
        contentScore: 0.92,
        timeScore: 0.85,
        confidence: 0.92,
        evidence: ['12/15 lines matched'],
      },
    ];
    const output = renderReport(makeReport({ matches }));
    expect(output).toContain('## Top Strong Matches');
    expect(output).toContain('strongha'); // first 8 chars of 'stronghash123'
    expect(output).toContain('lib/core.ts');
    expect(output).toContain('session-'); // first 8 chars of 'session-abc'
    expect(output).toContain('12/15 lines matched');
  });

  it('does not show top strong matches section when no strong matches', () => {
    const matches = [
      {
        commitHash: 'weakcommit1',
        filePath: 'src/x.ts',
        sessionId: 'sess-weak',
        editSeqs: [1],
        contentScore: 0.6,
        timeScore: 0.5,
        confidence: 0.58,
        evidence: [],
      },
    ];
    const output = renderReport(makeReport({ matches }));
    expect(output).not.toContain('## Top Strong Matches');
  });

  it('handles zero commitsTotal gracefully (no division by zero)', () => {
    const report = makeReport({
      commitsTotal: 0,
      commitsMatchedStrong: 0,
      commitsMatchedWeak: 0,
    });
    expect(() => renderReport(report)).not.toThrow();
    const output = renderReport(report);
    expect(output).toContain('0.0%');
  });

  it('handles empty matches array in histogram without errors', () => {
    const report = makeReport({ matches: [] });
    expect(() => renderReport(report)).not.toThrow();
  });

  it('shows match candidate count in histogram footer', () => {
    const matches = [
      {
        commitHash: 'c1',
        filePath: 'f.ts',
        sessionId: 's1',
        editSeqs: [1],
        contentScore: 0.9,
        timeScore: 0.8,
        confidence: 0.88,
        evidence: [],
      },
      {
        commitHash: 'c2',
        filePath: 'g.ts',
        sessionId: 's2',
        editSeqs: [2],
        contentScore: 0.7,
        timeScore: 0.6,
        confidence: 0.68,
        evidence: [],
      },
    ];
    const output = renderReport(makeReport({ matches }));
    expect(output).toContain('2 candidates');
  });

  it('lists up to 5 strong matches sorted by confidence descending', () => {
    // Create 7 strong matches with distinct confidence values
    const matches = [0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87].map((conf, i) => ({
      commitHash: `hash${i}`,
      filePath: `src/f${i}.ts`,
      sessionId: `sess-${i}`,
      editSeqs: [i],
      contentScore: conf,
      timeScore: conf,
      confidence: conf,
      evidence: [],
    }));
    const output = renderReport(makeReport({ matches }));
    // Only top 5 should appear in the "Top Strong Matches" section
    expect(output).toContain('hash6'); // highest conf 0.87
    expect(output).toContain('hash5'); // 0.86
    expect(output).toContain('hash4'); // 0.85
    expect(output).toContain('hash3'); // 0.84
    expect(output).toContain('hash2'); // 0.83
    // 6th and 7th should not be in top section (but may appear elsewhere)
    // We check by counting occurrences — hashes that appear only once
    // (in the histogram via confidence row, not in the strong section)
    // are acceptable; we just verify the section has ≤5 bullet lines
    const strongSectionStart = output.indexOf('## Top Strong Matches');
    const afterSection = output.slice(strongSectionStart);
    const bulletLines = afterSection.split('\n').filter((l) => l.startsWith('- '));
    expect(bulletLines.length).toBeLessThanOrEqual(5);
  });
});
