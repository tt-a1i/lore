/**
 * Unit tests for pure functions added in the "lore go / lore init" feature:
 *   - renderSummaryBox  (summary box after lore go completes)
 *   - injectLoreSection (idempotent injection into CLAUDE.md / AGENTS.md)
 *
 * No I/O, no graph, no parsers — pure string → string tests.
 */

import { describe, it, expect } from 'vitest';
import { renderSummaryBox, injectLoreSection } from '../../src/cli.js';

// ── renderSummaryBox ──────────────────────────────────────────────────────────

describe('renderSummaryBox', () => {
  const baseOpts = {
    matchRate: '74.2% in-window',
    nodeCount: 120,
    edgeCount: 340,
    url: 'http://localhost:4017',
  };

  it('returns a non-empty string', () => {
    const out = renderSummaryBox(baseOpts);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('includes the match rate', () => {
    const out = renderSummaryBox(baseOpts);
    expect(out).toContain('74.2%');
  });

  it('includes node count', () => {
    const out = renderSummaryBox(baseOpts);
    expect(out).toContain('120');
  });

  it('includes edge count', () => {
    const out = renderSummaryBox(baseOpts);
    expect(out).toContain('340');
  });

  it('includes the URL', () => {
    const out = renderSummaryBox(baseOpts);
    expect(out).toContain('http://localhost:4017');
  });

  it('uses box-drawing characters for borders', () => {
    const out = renderSummaryBox(baseOpts);
    expect(out).toContain('┌');
    expect(out).toContain('┐');
    expect(out).toContain('└');
    expect(out).toContain('┘');
  });

  it('spans multiple lines', () => {
    const out = renderSummaryBox(baseOpts);
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(3);
  });

  it('handles zero nodes and edges', () => {
    const out = renderSummaryBox({ ...baseOpts, nodeCount: 0, edgeCount: 0 });
    expect(out).toContain('0');
  });

  it('handles a different URL', () => {
    const out = renderSummaryBox({ ...baseOpts, url: 'http://localhost:4099' });
    expect(out).toContain('4099');
  });

  it('handles a percentage-only match rate', () => {
    const out = renderSummaryBox({ ...baseOpts, matchRate: '50.0%' });
    expect(out).toContain('50.0%');
  });

  it('includes "lore" branding', () => {
    const out = renderSummaryBox(baseOpts);
    expect(out).toContain('lore');
  });
});

// ── injectLoreSection ─────────────────────────────────────────────────────────

const MARKER_START = '<!-- lore:start -->';
const MARKER_END = '<!-- lore:end -->';

describe('injectLoreSection', () => {
  it('injects section into empty string', () => {
    const { content, injected } = injectLoreSection('');
    expect(injected).toBe(true);
    expect(content).toContain(MARKER_START);
    expect(content).toContain(MARKER_END);
  });

  it('injects into file that has no lore section', () => {
    const existing = '# CLAUDE.md\n\nSome existing content.\n';
    const { content, injected } = injectLoreSection(existing);
    expect(injected).toBe(true);
    // Should preserve existing content
    expect(content).toContain('# CLAUDE.md');
    expect(content).toContain('Some existing content.');
    // Should have the lore section appended
    expect(content).toContain(MARKER_START);
    expect(content).toContain(MARKER_END);
  });

  it('returns injected=false when section already present', () => {
    const existing = '# CLAUDE.md\n\n' + MARKER_START + '\nstuff\n' + MARKER_END + '\n';
    const { injected } = injectLoreSection(existing);
    expect(injected).toBe(false);
  });

  it('is idempotent: double injection produces the same result', () => {
    const original = '# CLAUDE.md\n\nHello.\n';
    const { content: first } = injectLoreSection(original);
    const { content: second } = injectLoreSection(first);
    expect(first).toBe(second);
  });

  it('section contains npx lore why usage hint', () => {
    const { content } = injectLoreSection('');
    expect(content).toContain('npx lore why');
  });

  it('section contains npx lore ask usage hint', () => {
    const { content } = injectLoreSection('');
    expect(content).toContain('npx lore ask');
  });

  it('section contains session-start status trigger (v2 replaces bare lore go hint)', () => {
    // v2 guidance rewrites the section with specific trigger moments;
    // lore status --repo . is the session-start hint (step 4).
    const { content } = injectLoreSection('');
    expect(content).toContain('npx lore status');
  });

  it('section contains the ## lore heading', () => {
    const { content } = injectLoreSection('');
    expect(content).toContain('## lore');
  });

  it('preserves content before the lore section on re-injection', () => {
    const preamble = '# My Project\n\nThis project does stuff.\n';
    const { content: after1 } = injectLoreSection(preamble);
    expect(after1.startsWith(preamble.trimEnd())).toBe(true);
  });

  it('works with only whitespace as existing content', () => {
    const { content, injected } = injectLoreSection('   \n\n  ');
    expect(injected).toBe(true);
    expect(content).toContain(MARKER_START);
  });

  it('does not duplicate heading when called twice on file with section', () => {
    const { content: first } = injectLoreSection('');
    const { content: second } = injectLoreSection(first);
    // "## lore" should appear exactly once
    const matches = [...second.matchAll(/## lore/g)];
    expect(matches.length).toBe(1);
  });

  it('refreshes content between markers on re-injection', () => {
    // Simulate an older injection with stale content
    const stale = `# CLAUDE.md\n\n${MARKER_START}\nOLD CONTENT\n${MARKER_END}\n`;
    const { content, injected } = injectLoreSection(stale);
    expect(injected).toBe(false);
    // Old content should be replaced
    expect(content).not.toContain('OLD CONTENT');
    // New content should have the standard hints
    expect(content).toContain('npx lore why');
  });
});
