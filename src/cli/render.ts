import path from 'node:path';

import type { WhyResult, WhyAttribution } from '../why/types.js';
import type { AskResult } from '../ask/types.js';
import type { CommitNodeData, ProducedInfo } from '../graph/types.js';
import { bold } from './ui.js';

/** Truncate a string to maxLen with an ellipsis if needed. Preserve existing CLI behavior: no trim. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/** Render a summary box after lore go completes. Pure function — exported for testing. */
export function renderSummaryBox(opts: {
  matchRate: string;
  nodeCount: number;
  edgeCount: number;
  url: string;
}): string {
  const { matchRate, nodeCount, edgeCount, url } = opts;

  const lines = [
    '┌─────────────────────────────────────────────────────────────┐',
    `│  ${bold('lore')} — graph ready                                          │`,
    '│                                                             │',
    `│  match rate   ${matchRate.padEnd(10)}                                 │`,
    `│  graph        ${String(nodeCount).padEnd(6)} nodes  ${String(edgeCount).padEnd(6)} edges           │`,
    `│  viewer       ${url.padEnd(44)} │`,
    '└─────────────────────────────────────────────────────────────┘',
  ];
  return lines.join('\n');
}

/** Render a WhyResult as human-readable terminal output. */
export function renderWhyResult(result: WhyResult, _repoPath: string): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`file:  ${result.file}:${result.line}`);
  lines.push(`line:  ${result.lineContent}`);
  lines.push('');
  lines.push(`commit: ${result.commit.hash.slice(0, 8)}  ${result.commit.subject}`);
  lines.push(`        author ${result.commit.authorDate.slice(0, 10)}  ` +
    `committer ${result.commit.committerDate.slice(0, 10)}`);

  if (result.attributions.length === 0) {
    lines.push('');
    lines.push('attribution: none  (no conversation linked to this commit)');

    if (result.editedBy.length > 0) {
      lines.push('');
      lines.push('sessions that edited this file (blind-spot hints):');
      for (const eb of result.editedBy) {
        lines.push(`  • session ${eb.sessionId.slice(0, 12)}…  agent=${eb.agent}  last=${eb.lastTs.slice(0, 16)}`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  for (let ai = 0; ai < result.attributions.length; ai++) {
    const attr = result.attributions[ai] as WhyAttribution;
    const p = attr.produced;
    const tier = p.confidence >= 0.8 ? 'strong' : 'weak';
    lines.push('');
    lines.push(`attribution [${ai + 1}/${result.attributions.length}]`);
    lines.push(`  confidence: ${p.confidence.toFixed(3)} (${tier})`);
    lines.push(`  matchedVia: ${p.matchedVia}`);
    lines.push(`  session:    ${p.sessionId.slice(0, 12)}…`);
    lines.push(`  source:     ${path.basename(p.sourcePath)}`);
    lines.push(`  lines:      ${p.matchedLines}  files: ${p.fileCount}`);

    if (attr.editSeqs.length > 0) {
      lines.push(`  editSeqs:   ${attr.editSeqs.slice(0, 8).join(', ')}${attr.editSeqs.length > 8 ? ' …' : ''}`);
    }

    if (attr.excerpts.length > 0) {
      lines.push('');
      lines.push('  conversation excerpts:');
      for (const ex of attr.excerpts) {
        const anchor = `[${ex.sessionId.slice(0, 8)}+${ex.seq}]`;
        const roleLabel = ex.role === 'user' ? 'USER     ' : 'ASSISTANT';
        lines.push(`    ${anchor} ${roleLabel}  ${ex.ts.slice(0, 16)}`);
        const textLines = truncate(ex.text.trim(), 400).split('\n');
        for (const tl of textLines) {
          lines.push(`      ${tl}`);
        }
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Render a fileHistory result as human-readable terminal output. */
export function renderFileHistory(
  filePath: string,
  history: { commit: CommitNodeData; produced: ProducedInfo[] }[],
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`file evolution: ${filePath}`);
  lines.push(`commits: ${history.length}`);
  lines.push('');

  if (history.length === 0) {
    lines.push('  (no commit history found in graph)');
    lines.push('');
    return lines.join('\n');
  }

  for (const entry of history) {
    const c = entry.commit;
    const dateStr = c.authorDate.slice(0, 10);
    lines.push(`  ${c.hash.slice(0, 8)}  ${dateStr}  ${c.subject}`);

    if (entry.produced.length > 0) {
      for (const p of entry.produced) {
        const tier = p.confidence >= 0.8 ? 'strong' : 'weak';
        lines.push(
          `            ← session ${p.sessionId.slice(0, 12)}…  ` +
          `conf=${p.confidence.toFixed(3)} (${tier})  ` +
          `via=${p.matchedVia}  ` +
          `src=${path.basename(p.sourcePath)}`,
        );
      }
    } else {
      lines.push('            ← (no conversation attribution)');
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Render AskResult for human-readable terminal output. */
export function renderAskResult(result: AskResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`question: ${result.question}`);
  lines.push('');

  if (result.hits.length === 0 && result.messageHits.length === 0) {
    lines.push('  (no results found)');
    lines.push('');
    return lines.join('\n');
  }

  if (result.hits.length > 0) {
    lines.push(`notes (${result.hits.length}):`);
    for (let i = 0; i < result.hits.length; i++) {
      const h = result.hits[i]!;
      const n = h.note;
      const anchor = n.anchors.length > 0
        ? `  [${n.anchors[0]!.sessionId.slice(0, 8)}+${n.anchors[0]!.seq}]`
        : '';
      lines.push('');
      const src = n.source && n.source !== 'distilled' ? `  [${n.source}]` : '';
      lines.push(`  [${i + 1}] ${n.kind}${src}  score=${h.score.toFixed(3)}${anchor}`);
      lines.push(`      ${n.title}`);
      lines.push(`      ${n.body}`);
      if (n.files.length > 0) {
        lines.push(`      files: ${n.files.slice(0, 5).join(', ')}`);
      }
      if (n.invalidAt !== null) {
        lines.push(`      (superseded ${n.invalidAt.slice(0, 10)})`);
      }
    }
  }

  if (result.messageHits.length > 0) {
    lines.push('');
    lines.push(`message hits (${result.messageHits.length}):`);
    for (let i = 0; i < result.messageHits.length; i++) {
      const m = result.messageHits[i]!;
      const anchor = `[${m.sessionId.slice(0, 8)}+${m.seq}]`;
      lines.push('');
      lines.push(`  [${i + 1}] ${anchor}  score=${m.score.toFixed(3)}`);
      lines.push(`      ${truncate(m.text, 300)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Render a status card for `lore status`. */
export function renderStatusCard(opts: {
  repoPath: string;
  report: {
    generatedAt: string;
    commitsTotal: number;
    commitsMatchedStrong: number;
    commitsMatchedWeak: number;
    commitsInWindow: number;
    strongInWindow: number;
    weakInWindow: number;
    window: { start: string; end: string } | null;
    sessionsSeen: number;
  };
  notesFile: {
    notes: { kind: string; source?: string; invalidAt: string | null }[];
    distilledAt?: string;
  } | null;
  headTime: string | null;
  nowMs: number;
}): string {
  const { repoPath, report, notesFile, headTime, nowMs } = opts;
  const lines: string[] = [];

  const generatedMs = Date.parse(report.generatedAt);
  const ageMs = nowMs - generatedMs;
  const FOUR_H = 4 * 60 * 60 * 1000;
  let freshnessLabel: string;

  if (isNaN(generatedMs)) {
    freshnessLabel = 'unknown';
  } else {
    const headNewer = headTime ? Date.parse(headTime) > generatedMs : false;
    const isStale = ageMs > FOUR_H || headNewer;
    if (isStale) {
      freshnessLabel = `stale  (run: lore scan --repo ${repoPath})`;
    } else {
      const mins = Math.floor(ageMs / 60_000);
      freshnessLabel = mins < 60
        ? `fresh  (${mins}m ago)`
        : `fresh  (${(ageMs / 3_600_000).toFixed(1)}h ago)`;
    }
  }

  lines.push('');
  lines.push(`lore status: ${repoPath}`);
  lines.push('');
  lines.push(`  generated   ${report.generatedAt.slice(0, 19).replace('T', ' ')}`);
  lines.push(`  freshness   ${freshnessLabel}`);
  if (headTime) {
    lines.push(`  HEAD        ${headTime.slice(0, 19).replace('T', ' ')}`);
  }
  lines.push('');

  const inWindowPct = report.commitsInWindow > 0
    ? (((report.strongInWindow + report.weakInWindow) / report.commitsInWindow) * 100).toFixed(1)
    : '0.0';
  lines.push(`  coverage    ${inWindowPct}% in-window  (${report.strongInWindow} strong + ${report.weakInWindow} weak / ${report.commitsInWindow} commits)`);
  lines.push(`  sessions    ${report.sessionsSeen} seen`);
  lines.push(`  commits     ${report.commitsTotal} total  /  ${report.commitsMatchedStrong} strong  ${report.commitsMatchedWeak} weak`);
  if (report.window) {
    lines.push(`  window      ${report.window.start.slice(0, 10)} → ${report.window.end.slice(0, 10)}`);
  }

  lines.push('');
  if (!notesFile) {
    lines.push(`  notes       0  (no notes.json — run: lore distill --repo ${repoPath})`);
  } else {
    const activeNotes = notesFile.notes.filter((n) => n.invalidAt === null);
    const byKind = new Map<string, number>();
    const bySource = new Map<string, number>();
    for (const n of activeNotes) {
      byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
      const src = n.source ?? 'distilled';
      bySource.set(src, (bySource.get(src) ?? 0) + 1);
    }
    const kindStr = Array.from(byKind.entries()).map(([k, v]) => `${k}=${v}`).join(' ');
    const srcStr = Array.from(bySource.entries()).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`  notes       ${activeNotes.length} active (${notesFile.notes.length} total)`);
    if (kindStr) lines.push(`              by kind:    ${kindStr}`);
    if (srcStr) lines.push(`              by source:  ${srcStr}`);
    if (notesFile.distilledAt) {
      lines.push(`  distilledAt ${notesFile.distilledAt.slice(0, 19).replace('T', ' ')}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
