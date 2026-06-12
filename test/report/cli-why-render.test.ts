/**
 * Unit tests for the pure render functions extracted from src/cli.ts.
 *
 * Tests renderWhyResult and renderFileHistory with mock data — no real
 * transcript files, graph stores, or git operations are involved.
 */

import { describe, it, expect } from 'vitest';
import { renderWhyResult, renderFileHistory } from '../../src/cli.js';
import type { WhyResult, WhyAttribution } from '../../src/why/types.js';
import type { CommitNodeData, ProducedInfo, SessionNodeData } from '../../src/graph/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCommitNode(overrides: Partial<CommitNodeData> = {}): CommitNodeData {
  return {
    hash: 'abcdef1234567890',
    subject: 'feat: add new feature',
    authorDate: '2026-06-10T12:00:00.000Z',
    committerDate: '2026-06-10T12:05:00.000Z',
    isMerge: false,
    ...overrides,
  };
}

function makeSessionNode(overrides: Partial<SessionNodeData> = {}): SessionNodeData {
  return {
    id: 'session-id-abc123',
    agent: 'claude-code',
    startedAt: '2026-06-10T11:00:00.000Z',
    endedAt: '2026-06-10T12:00:00.000Z',
    cwd: '/Users/dev/project',
    gitBranch: 'main',
    sourcePaths: ['/Users/dev/.claude/projects/project/transcript-abc.jsonl'],
    ...overrides,
  };
}

function makeProducedInfo(overrides: Partial<ProducedInfo> = {}): ProducedInfo {
  const session = makeSessionNode();
  return {
    sessionId: session.id,
    commitHash: 'abcdef1234567890',
    confidence: 0.92,
    matchedVia: 'content',
    sourcePath: '/Users/dev/.claude/projects/project/transcript-abc.jsonl',
    matchedLines: 8,
    fileCount: 2,
    session,
    ...overrides,
  };
}

function makeAttribution(overrides: Partial<WhyAttribution> = {}): WhyAttribution {
  return {
    produced: makeProducedInfo(),
    editSeqs: [5, 7, 12],
    excerpts: [
      {
        sessionId: 'session-id-abc123',
        seq: 4,
        role: 'user',
        text: 'Please implement the new feature for parsing config files',
        ts: '2026-06-10T11:30:00.000Z',
      },
      {
        sessionId: 'session-id-abc123',
        seq: 6,
        role: 'assistant',
        text: 'I will add the config parser. Here is my plan...',
        ts: '2026-06-10T11:31:00.000Z',
      },
    ],
    ...overrides,
  };
}

function makeWhyResult(overrides: Partial<WhyResult> = {}): WhyResult {
  return {
    file: 'src/config/parser.ts',
    line: 42,
    lineContent: '  return parseYaml(content);',
    commit: makeCommitNode(),
    attributions: [makeAttribution()],
    editedBy: [],
    ...overrides,
  };
}

// ── renderWhyResult tests ─────────────────────────────────────────────────────

describe('renderWhyResult', () => {
  const repoPath = '/Users/dev/project';

  it('returns a non-empty string', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('includes file and line number', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('src/config/parser.ts:42');
  });

  it('includes line content', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('return parseYaml(content);');
  });

  it('includes commit hash prefix and subject', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('abcdef12');
    expect(output).toContain('feat: add new feature');
  });

  it('includes commit dates', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('2026-06-10');
  });

  it('shows attribution confidence and tier', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('0.920');
    expect(output).toContain('strong');
  });

  it('shows matchedVia', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('content');
  });

  it('shows session id prefix', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('session-id');
  });

  it('shows source file basename (not full path)', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('transcript-abc.jsonl');
    // Full path should not appear (basename only)
    expect(output).not.toContain('/Users/dev/.claude/projects/project/transcript-abc.jsonl');
  });

  it('shows matchedLines and fileCount', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('8');
    expect(output).toContain('files: 2');
  });

  it('shows editSeqs', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('5');
    expect(output).toContain('7');
    expect(output).toContain('12');
  });

  it('shows conversation excerpts with anchors', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('session-i'); // first 8 chars of sessionId
    expect(output).toContain('+4'); // seq anchor for user message
    expect(output).toContain('+6'); // seq anchor for assistant message
    expect(output).toContain('USER');
    expect(output).toContain('ASSISTANT');
  });

  it('shows excerpt text content', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('Please implement the new feature');
    expect(output).toContain('I will add the config parser');
  });

  it('shows excerpt timestamps', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('2026-06-10T11:30');
    expect(output).toContain('2026-06-10T11:31');
  });

  it('shows weak tier for confidence below 0.8', () => {
    const result = makeWhyResult({
      attributions: [
        makeAttribution({
          produced: makeProducedInfo({ confidence: 0.65 }),
        }),
      ],
    });
    const output = renderWhyResult(result, repoPath);
    expect(output).toContain('0.650');
    expect(output).toContain('weak');
  });

  it('shows attribution index when multiple attributions', () => {
    const result = makeWhyResult({
      attributions: [
        makeAttribution({ produced: makeProducedInfo({ confidence: 0.92 }) }),
        makeAttribution({ produced: makeProducedInfo({ confidence: 0.71 }) }),
      ],
    });
    const output = renderWhyResult(result, repoPath);
    expect(output).toContain('[1/2]');
    expect(output).toContain('[2/2]');
  });

  it('blind-spot path: shows no attribution message when attributions empty', () => {
    const result = makeWhyResult({ attributions: [] });
    const output = renderWhyResult(result, repoPath);
    expect(output).toContain('none');
    expect(output).toContain('no conversation');
  });

  it('blind-spot path: shows editedBy hints when available', () => {
    const result = makeWhyResult({
      attributions: [],
      editedBy: [
        { sessionId: 'blind-session-xyz', agent: 'claude-code', lastTs: '2026-06-09T10:00:00.000Z' },
      ],
    });
    const output = renderWhyResult(result, repoPath);
    // sessionId is sliced to 12 chars: 'blind-sessio'
    expect(output).toContain('blind-sessio');
    expect(output).toContain('claude-code');
    expect(output).toContain('2026-06-09');
  });

  it('blind-spot path: no editedBy section when editedBy is empty', () => {
    const result = makeWhyResult({ attributions: [], editedBy: [] });
    const output = renderWhyResult(result, repoPath);
    // Should not have editedBy hints section
    expect(output).not.toContain('sessions that edited');
  });

  it('truncates very long excerpt text to 400 chars', () => {
    const longText = 'x'.repeat(500);
    const result = makeWhyResult({
      attributions: [
        makeAttribution({
          excerpts: [
            {
              sessionId: 'session-id-abc123',
              seq: 4,
              role: 'user',
              text: longText,
              ts: '2026-06-10T11:30:00.000Z',
            },
          ],
        }),
      ],
    });
    const output = renderWhyResult(result, repoPath);
    // The truncated text should not exceed 400 + small overhead for ellipsis
    // We check that the raw 500-char run is not present
    expect(output).not.toContain('x'.repeat(500));
    // But a truncated version (400 chars) should appear
    expect(output).toContain('x'.repeat(100));
  });

  it('shows attribution [1/1] label for single attribution', () => {
    const output = renderWhyResult(makeWhyResult(), repoPath);
    expect(output).toContain('[1/1]');
  });

  it('handles attribution with no excerpts gracefully', () => {
    const result = makeWhyResult({
      attributions: [makeAttribution({ excerpts: [] })],
    });
    const output = renderWhyResult(result, repoPath);
    expect(output).toContain('attribution [1/1]');
    expect(output).not.toContain('conversation excerpts:');
  });

  it('handles attribution with no editSeqs gracefully', () => {
    const result = makeWhyResult({
      attributions: [makeAttribution({ editSeqs: [] })],
    });
    // Should not throw
    const output = renderWhyResult(result, repoPath);
    expect(typeof output).toBe('string');
    expect(output).not.toContain('editSeqs:');
  });
});

// ── renderFileHistory tests ───────────────────────────────────────────────────

describe('renderFileHistory', () => {
  it('returns a non-empty string', () => {
    const output = renderFileHistory('src/config/parser.ts', []);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('shows file path in header', () => {
    const output = renderFileHistory('src/config/parser.ts', []);
    expect(output).toContain('src/config/parser.ts');
  });

  it('shows commit count', () => {
    const history = [
      { commit: makeCommitNode(), produced: [] },
      { commit: makeCommitNode({ hash: 'bbbbbbbb1234' }), produced: [] },
    ];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('commits: 2');
  });

  it('shows empty message when no history', () => {
    const output = renderFileHistory('src/unused.ts', []);
    expect(output).toContain('no commit history');
  });

  it('shows commit hash prefix and subject', () => {
    const history = [{ commit: makeCommitNode(), produced: [] }];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('abcdef12');
    expect(output).toContain('feat: add new feature');
  });

  it('shows commit date', () => {
    const history = [{ commit: makeCommitNode(), produced: [] }];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('2026-06-10');
  });

  it('shows no attribution message when produced is empty', () => {
    const history = [{ commit: makeCommitNode(), produced: [] }];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('no conversation attribution');
  });

  it('shows session attribution when produced is non-empty', () => {
    const produced = [makeProducedInfo()];
    const history = [{ commit: makeCommitNode(), produced }];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('session-id');
    expect(output).toContain('0.920');
    expect(output).toContain('strong');
  });

  it('shows matchedVia in attribution line', () => {
    const produced = [makeProducedInfo({ matchedVia: 'sha' })];
    const history = [{ commit: makeCommitNode(), produced }];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('via=sha');
  });

  it('shows source file basename in attribution line', () => {
    const produced = [makeProducedInfo()];
    const history = [{ commit: makeCommitNode(), produced }];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('transcript-abc.jsonl');
    // Full path should not appear in history output
    expect(output).not.toContain('/Users/dev/.claude/projects/project/transcript-abc.jsonl');
  });

  it('shows weak tier correctly', () => {
    const produced = [makeProducedInfo({ confidence: 0.65 })];
    const history = [{ commit: makeCommitNode(), produced }];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('0.650');
    expect(output).toContain('weak');
  });

  it('handles multiple commits in chronological order', () => {
    const history = [
      {
        commit: makeCommitNode({ hash: 'aaa0001', subject: 'first commit', authorDate: '2026-06-01T10:00:00.000Z' }),
        produced: [],
      },
      {
        commit: makeCommitNode({ hash: 'bbb0002', subject: 'second commit', authorDate: '2026-06-05T10:00:00.000Z' }),
        produced: [makeProducedInfo()],
      },
      {
        commit: makeCommitNode({ hash: 'ccc0003', subject: 'third commit', authorDate: '2026-06-10T10:00:00.000Z' }),
        produced: [],
      },
    ];
    const output = renderFileHistory('src/config/parser.ts', history);
    expect(output).toContain('first commit');
    expect(output).toContain('second commit');
    expect(output).toContain('third commit');
    // The attributed commit should show session info
    expect(output).toContain('session-id');
    // The non-attributed commits should show the no-attribution message
    const noAttrCount = (output.match(/no conversation attribution/g) ?? []).length;
    expect(noAttrCount).toBe(2);
  });

  it('handles multiple attributions per commit', () => {
    const produced = [
      makeProducedInfo({ confidence: 0.92 }),
      makeProducedInfo({ sessionId: 'other-session-xyz', confidence: 0.65 }),
    ];
    const history = [{ commit: makeCommitNode(), produced }];
    const output = renderFileHistory('src/config/parser.ts', history);
    // Both sessions should appear
    expect(output).toContain('session-id');
    expect(output).toContain('other-sess');
    // Both tiers
    expect(output).toContain('strong');
    expect(output).toContain('weak');
  });
});
