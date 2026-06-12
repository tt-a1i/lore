/**
 * Unit tests for push-based memory render functions (src/brief/render.ts).
 *
 * Pure functions — no I/O, no process. All fixtures in-memory.
 *   - freshnessLine: fresh / stale / no-scan / head-newer
 *   - noteRelatedToFile: exact / suffix match, basename-collision NOT matched,
 *     file-less constraint = global, file-less decision = NOT global
 *   - renderBrief: constraint-first ordering, maxPerKind cap, --file scoping,
 *     usage hint (MCP vs npx), suppressFreshness for guard
 *   - usageHint: tool names with MCP, npx commands without
 */

import { describe, it, expect } from 'vitest';
import {
  freshnessLine,
  noteRelatedToFile,
  renderBrief,
  usageHint,
} from '../../src/brief/render.js';
import type { BriefNote } from '../../src/brief/types.js';

const REPO = '/tmp/test-repo';
const NOW = 1_750_000_000_000;

function note(over: Partial<BriefNote> = {}): BriefNote {
  return {
    kind: 'constraint',
    title: 'A constraint',
    body: 'body',
    files: [],
    source: 'distilled',
    invalidAt: null,
    ...over,
  };
}

// ── freshnessLine ─────────────────────────────────────────────────────────────

describe('freshnessLine', () => {
  it('says "no scan yet" when generatedAt is null', () => {
    const out = freshnessLine({ repoPath: REPO, generatedAt: null, headTime: null, nowMs: NOW });
    expect(out).toContain('no scan yet');
    expect(out).toContain('lore scan');
  });

  it('says "fresh" when generated < 4h ago and HEAD older', () => {
    const generatedAt = new Date(NOW - 10 * 60_000).toISOString(); // 10 min ago
    const out = freshnessLine({ repoPath: REPO, generatedAt, headTime: null, nowMs: NOW });
    expect(out).toContain('fresh');
    expect(out).toContain('10m ago');
  });

  it('says "STALE" when generated > 4h ago', () => {
    const generatedAt = new Date(NOW - 5 * 60 * 60_000).toISOString(); // 5h ago
    const out = freshnessLine({ repoPath: REPO, generatedAt, headTime: null, nowMs: NOW });
    expect(out).toContain('STALE');
    expect(out).toContain('lore scan');
  });

  it('says "STALE" when HEAD commit is newer than generatedAt', () => {
    const generatedAt = new Date(NOW - 10 * 60_000).toISOString(); // 10 min ago
    const headTime = new Date(NOW - 30_000).toISOString(); // 30s ago — newer
    const out = freshnessLine({ repoPath: REPO, generatedAt, headTime, nowMs: NOW });
    expect(out).toContain('STALE');
  });

  it('handles unparseable generatedAt gracefully', () => {
    const out = freshnessLine({ repoPath: REPO, generatedAt: 'not-a-date', headTime: null, nowMs: NOW });
    expect(out).toContain('unknown');
  });
});

// ── noteRelatedToFile ─────────────────────────────────────────────────────────

describe('noteRelatedToFile', () => {
  it('matches when files list contains the exact repo-relative path', () => {
    const n = note({ files: ['src/http/client.ts'] });
    expect(noteRelatedToFile(n, 'src/http/client.ts', REPO)).toBe(true);
  });

  it('matches when given an absolute path inside the repo', () => {
    const n = note({ files: ['src/http/client.ts'] });
    expect(noteRelatedToFile(n, `${REPO}/src/http/client.ts`, REPO)).toBe(true);
  });

  it('does NOT match a different file with the same basename (collision guard)', () => {
    // The key correctness fix: src/mcp/server.ts must not match src/viewer/server.ts
    const n = note({ files: ['src/viewer/server.ts'] });
    expect(noteRelatedToFile(n, 'src/mcp/server.ts', REPO)).toBe(false);
  });

  it('matches via path suffix (worktree/absolute prefix differences)', () => {
    const n = note({ files: ['src/http/client.ts'] });
    expect(noteRelatedToFile(n, '/some/worktree/copy/src/http/client.ts', REPO)).toBe(true);
  });

  it('treats a file-less CONSTRAINT as global (applies to any file)', () => {
    const n = note({ kind: 'constraint', files: [] });
    expect(noteRelatedToFile(n, 'src/anything.ts', REPO)).toBe(true);
  });

  it('treats a file-less REJECTED-APPROACH as global', () => {
    const n = note({ kind: 'rejected-approach', files: [] });
    expect(noteRelatedToFile(n, 'src/anything.ts', REPO)).toBe(true);
  });

  it('does NOT treat a file-less DECISION as global (avoids per-edit spam)', () => {
    const n = note({ kind: 'decision', files: [] });
    expect(noteRelatedToFile(n, 'src/anything.ts', REPO)).toBe(false);
  });
});

// ── usageHint ─────────────────────────────────────────────────────────────────

describe('usageHint', () => {
  it('mentions MCP tool names when MCP is present', () => {
    const h = usageHint(true);
    expect(h).toContain('lore_ask');
    expect(h).toContain('lore_note');
  });

  it('mentions npx commands when no MCP', () => {
    const h = usageHint(false);
    expect(h).toContain('lore ask');
    expect(h).toContain('lore note');
    expect(h).toContain('--source agent');
  });
});

// ── renderBrief ───────────────────────────────────────────────────────────────

function mixedNotes(): BriefNote[] {
  return [
    note({ kind: 'decision', title: 'Use Kuzu', files: ['src/graph/store.ts'] }),
    note({ kind: 'constraint', title: 'HTTP via client', files: ['src/http/client.ts'] }),
    note({ kind: 'rejected-approach', title: 'No polling', files: ['src/watcher.ts'] }),
    note({ kind: 'constraint', title: 'IDs via newId', files: ['src/ids.ts'] }),
  ];
}

describe('renderBrief', () => {
  it('puts constraint group before decision group (kind ordering)', () => {
    const out = renderBrief({
      repoPath: REPO, generatedAt: new Date(NOW).toISOString(), headTime: null,
      nowMs: NOW, notes: mixedNotes(), hasMcp: false,
    });
    const constraintIdx = out.indexOf('constraint (');
    const rejectedIdx = out.indexOf('rejected-approach (');
    const decisionIdx = out.indexOf('decision (');
    expect(constraintIdx).toBeGreaterThan(-1);
    expect(constraintIdx).toBeLessThan(rejectedIdx);
    expect(rejectedIdx).toBeLessThan(decisionIdx);
  });

  it('includes the freshness line in default (SessionStart) mode', () => {
    const out = renderBrief({
      repoPath: REPO, generatedAt: new Date(NOW).toISOString(), headTime: null,
      nowMs: NOW, notes: mixedNotes(), hasMcp: false,
    });
    expect(out).toContain('lore memory:');
  });

  it('includes a usage hint in default mode', () => {
    const out = renderBrief({
      repoPath: REPO, generatedAt: new Date(NOW).toISOString(), headTime: null,
      nowMs: NOW, notes: mixedNotes(), hasMcp: true,
    });
    expect(out).toContain('lore_ask');
  });

  it('caps each kind at maxPerKind and shows an overflow line', () => {
    const many: BriefNote[] = [];
    for (let i = 0; i < 10; i++) many.push(note({ kind: 'constraint', title: `c${i}`, files: [`src/f${i}.ts`] }));
    const out = renderBrief({
      repoPath: REPO, generatedAt: new Date(NOW).toISOString(), headTime: null,
      nowMs: NOW, notes: many, hasMcp: false, maxPerKind: 3,
    });
    // 3 shown + overflow note
    expect(out).toContain('and 7 more');
    expect(out).toContain('c0');
    expect(out).toContain('c2');
    expect(out).not.toContain('c5');
  });

  it('--file scopes to constraints relevant to that file', () => {
    const out = renderBrief({
      repoPath: REPO, generatedAt: new Date(NOW).toISOString(), headTime: null,
      nowMs: NOW, notes: mixedNotes(), hasMcp: false, file: 'src/http/client.ts',
    });
    expect(out).toContain('HTTP via client');
    // unrelated file-specific notes excluded
    expect(out).not.toContain('Use Kuzu');
    expect(out).not.toContain('IDs via newId');
  });

  it('suppressFreshness omits the freshness line (guard mode)', () => {
    const out = renderBrief({
      repoPath: REPO, generatedAt: null, headTime: null,
      nowMs: NOW, notes: [note({ kind: 'constraint', title: 'X', files: ['a.ts'] })],
      hasMcp: false, file: 'a.ts', suppressFreshness: true,
    });
    expect(out).not.toContain('lore memory:');
    expect(out).not.toContain('no scan yet');
    expect(out.startsWith('lore — recorded constraints')).toBe(true);
  });

  it('shows a friendly "no active notes" message with empty notes', () => {
    const out = renderBrief({
      repoPath: REPO, generatedAt: new Date(NOW).toISOString(), headTime: null,
      nowMs: NOW, notes: [], hasMcp: false,
    });
    expect(out).toContain('No active lore notes');
  });

  it('renders file path in each note line', () => {
    const out = renderBrief({
      repoPath: REPO, generatedAt: new Date(NOW).toISOString(), headTime: null,
      nowMs: NOW, notes: [note({ kind: 'constraint', title: 'X', files: ['src/a.ts'] })], hasMcp: false,
    });
    expect(out).toContain('src/a.ts');
  });
});
