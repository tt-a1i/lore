/**
 * renderReport — turns a RepoMatchReport into a terminal-friendly markdown summary.
 *
 * Output sections:
 *   1. Overview table (match rates, sessions, blind-spot commits)
 *   2. Confidence distribution bar chart (text bars, 10 buckets 0–1)
 *   3. Top unmatched commits list (up to 20)
 *
 * This module only imports types; it has no runtime dependencies and its unit
 * tests run in isolation with mock data.
 */

import type { RepoMatchReport } from '../match/types.js';
import type { MatchCandidate } from '../match/types.js';
import { tierOf } from '../match/types.js';

/** Build a fixed-width bar string for a histogram bucket. */
function bar(count: number, maxCount: number, width = 20): string {
  if (maxCount === 0) return ' '.repeat(width);
  const filled = Math.round((count / maxCount) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Zero-pad a number to a given width. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, ' ');
}

/** Compute distribution across 10 equal buckets [0.0, 0.1), ..., [0.9, 1.0]. */
function confidenceBuckets(matches: MatchCandidate[]): number[] {
  const buckets = new Array<number>(10).fill(0);
  for (const m of matches) {
    const idx = Math.min(Math.floor(m.confidence * 10), 9);
    // idx is guaranteed to be 0-9 due to Math.min
    buckets[idx] = (buckets[idx] ?? 0) + 1;
  }
  return buckets;
}

export function renderReport(report: RepoMatchReport): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push(`# lore scan — ${report.repo}`);
  lines.push(`Generated: ${report.generatedAt}  |  schema v${report.schemaVersion}`);
  lines.push('');

  // ── Overview ─────────────────────────────────────────────────────────────
  lines.push('## Overview');
  lines.push('');

  const strongPct =
    report.commitsTotal > 0
      ? ((report.commitsMatchedStrong / report.commitsTotal) * 100).toFixed(1)
      : '0.0';
  const weakPct =
    report.commitsTotal > 0
      ? ((report.commitsMatchedWeak / report.commitsTotal) * 100).toFixed(1)
      : '0.0';
  const unmatchedCount =
    report.commitsTotal - report.commitsMatchedStrong - report.commitsMatchedWeak;
  const unmatchedPct =
    report.commitsTotal > 0
      ? ((unmatchedCount / report.commitsTotal) * 100).toFixed(1)
      : '0.0';

  lines.push(`| Metric                     | Value                          |`);
  lines.push(`|----------------------------|--------------------------------|`);
  lines.push(
    `| Total commits              | ${report.commitsTotal}                              |`.replace(
      /\s+\|$/,
      ' '.repeat(Math.max(0, 33 - String(report.commitsTotal).length)) + '|',
    ),
  );
  lines.push(
    `| Strong matches (≥0.8)      | ${report.commitsMatchedStrong} (${strongPct}%)` +
      ' '.repeat(Math.max(1, 24 - String(report.commitsMatchedStrong).length - strongPct.length)) +
      '|',
  );
  lines.push(
    `| Weak matches (≥0.5)        | ${report.commitsMatchedWeak} (${weakPct}%)` +
      ' '.repeat(Math.max(1, 26 - String(report.commitsMatchedWeak).length - weakPct.length)) +
      '|',
  );
  lines.push(
    `| Unmatched commits          | ${unmatchedCount} (${unmatchedPct}%)` +
      ' '.repeat(Math.max(1, 26 - String(unmatchedCount).length - unmatchedPct.length)) +
      '|',
  );
  // 窗口内口径——真正有意义的匹配率（窗口外的 commit 结构性不可匹配）。
  if (report.window) {
    const inWinPct =
      report.commitsInWindow > 0
        ? (((report.strongInWindow + report.weakInWindow) / report.commitsInWindow) * 100).toFixed(1)
        : '0.0';
    lines.push(
      `| Transcript window          | ${report.window.start.slice(0, 16)} → ${report.window.end.slice(0, 16)} |`,
    );
    lines.push(
      `| Commits in window          | ${report.commitsInWindow}` +
        ' '.repeat(Math.max(1, 33 - String(report.commitsInWindow).length)) +
        '|',
    );
    lines.push(
      `| In-window matched          | strong ${report.strongInWindow} + weak ${report.weakInWindow} (${inWinPct}%) |`,
    );
  }
  lines.push(
    `| Sessions seen              | ${report.sessionsSeen}` +
      ' '.repeat(Math.max(1, 33 - String(report.sessionsSeen).length)) +
      '|',
  );
  lines.push(
    `| Sessions contributing      | ${report.sessionsContributing}` +
      ' '.repeat(Math.max(1, 33 - String(report.sessionsContributing).length)) +
      '|',
  );
  lines.push(
    `| Total match candidates     | ${report.matches.length}` +
      ' '.repeat(Math.max(1, 33 - String(report.matches.length).length)) +
      '|',
  );
  lines.push('');

  // ── Confidence distribution histogram ────────────────────────────────────
  lines.push('## Confidence Distribution');
  lines.push('');

  const buckets = confidenceBuckets(report.matches);
  const maxBucket = Math.max(...buckets, 1);

  lines.push('```');
  lines.push('Confidence  Count  Bar');
  lines.push('─────────────────────────────────────────');
  for (let i = 0; i < 10; i++) {
    const lo = (i * 0.1).toFixed(1);
    const hi = i === 9 ? '1.0' : ((i + 1) * 0.1).toFixed(1);
    const count = buckets[i] ?? 0;
    const tier = i >= 8 ? 'strong' : i >= 5 ? 'weak  ' : 'none  ';
    lines.push(
      `[${lo}–${hi}) ${tier}  ${pad(count, 4)}  ${bar(count, maxBucket)}`,
    );
  }
  lines.push('─────────────────────────────────────────');
  lines.push(`Total: ${report.matches.length} candidates`);
  lines.push('```');
  lines.push('');

  // ── Top unmatched commits ─────────────────────────────────────────────────
  lines.push('## Unmatched Commits (blind spots)');
  lines.push('');

  if (report.unmatchedCommits.length === 0) {
    lines.push('_No unmatched commits — full coverage!_');
  } else {
    const limit = Math.min(report.unmatchedCommits.length, 20);
    lines.push(
      `Showing ${limit} of ${report.unmatchedCommits.length} unmatched commits:`,
    );
    lines.push('');
    for (let i = 0; i < limit; i++) {
      const c = report.unmatchedCommits[i];
      if (!c) continue;
      lines.push(`- \`${c.hash}\` ${c.subject}`);
    }
    if (report.unmatchedCommits.length > 20) {
      lines.push(`- _… and ${report.unmatchedCommits.length - 20} more_`);
    }
  }
  lines.push('');

  // ── Strong match sample (top 5 by confidence) ────────────────────────────
  const strongMatches = report.matches
    .filter((m) => tierOf(m.confidence) === 'strong')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  if (strongMatches.length > 0) {
    lines.push('## Top Strong Matches (by confidence)');
    lines.push('');
    for (const m of strongMatches) {
      lines.push(
        `- \`${m.commitHash.slice(0, 8)}\` ← session \`${m.sessionId.slice(0, 8)}…\`` +
          `  \`${m.filePath}\`  conf=${m.confidence.toFixed(3)}` +
          (m.evidence.length > 0 ? `  (${m.evidence[0]})` : ''),
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
