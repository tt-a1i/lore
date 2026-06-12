#!/usr/bin/env node
/**
 * lore CLI — two commands:
 *
 *   lore scan  --repo <path> [--max-commits N]
 *   lore sample --repo <path> -n <num> [--tier strong|weak]
 */

import { program } from 'commander';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

// ── type-only imports (contracts) ────────────────────────────────────────────
import type { TranscriptParser, ParseResult } from './schema/events.js';
import type { GitHistoryReader } from './git/types.js';
import type { MatchEngine, RepoMatchReport, MatchCandidate } from './match/types.js';
import { tierOf } from './match/types.js';
import { renderReport } from './report/markdown.js';

// ── Report file schema (extends RepoMatchReport with operational metadata) ───

/**
 * What we persist to .lore/report.json.
 * Extends RepoMatchReport with:
 *   - skippedBySession: parser skipped-line counts per session
 *   - sessionSourceMap: sessionId → sourcePath (needed by `lore sample`)
 */
export interface LoreReportFile extends RepoMatchReport {
  /** sessionId → absolute sourcePath of the transcript file. */
  sessionSourceMap: Record<string, string>;
  /** sessionId → skipped-line stats from the parser. */
  skippedBySession: Record<string, { count: number; samples: string[] }>;
}

// ── Dynamic imports for sibling modules (implemented by others) ──────────────

async function loadParser(): Promise<TranscriptParser> {
  const mod = await import('./parsers/claude-code.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.parser as TranscriptParser;
}

async function loadGitReader(): Promise<GitHistoryReader> {
  const mod = await import('./git/history.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.reader as GitHistoryReader;
}

async function loadMatchEngine(): Promise<MatchEngine> {
  const mod = await import('./match/engine.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.engine as MatchEngine;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): number {
  return performance.now();
}

function elapsed(start: number): string {
  return ((performance.now() - start) / 1000).toFixed(2) + 's';
}

function randomSample<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const result: T[] = [];
  while (result.length < n && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0] as T);
  }
  return result;
}

/** Truncate a string to maxLen with an ellipsis if needed. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

// ── lore scan ────────────────────────────────────────────────────────────────

async function cmdScan(opts: { repo: string; maxCommits?: number }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const t0 = now();

  console.log(`\nlore scan: ${repoPath}\n`);

  // 1. Discover transcripts
  const t1 = now();
  const parser = await loadParser();
  const transcriptPaths = await parser.discover(repoPath);
  console.log(`[discover] found ${transcriptPaths.length} transcripts  ${elapsed(t1)}`);

  // 2. Parse concurrently — warn and skip failures
  const t2 = now();
  const settled = await Promise.allSettled(
    transcriptPaths.map((p) => parser.parse(p)),
  );

  const parseResults: ParseResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (!s) continue;
    if (s.status === 'fulfilled') {
      parseResults.push(s.value);
    } else {
      console.warn(`[parse] WARN: skipped ${transcriptPaths[i]}: ${String(s.reason)}`);
    }
  }
  console.log(`[parse]    parsed ${parseResults.length}/${transcriptPaths.length} sessions  ${elapsed(t2)}`);

  // 3. Read git history
  const t3 = now();
  const gitReader = await loadGitReader();
  const historyOpts: { since?: string; maxCommits?: number } = {};
  if (opts.maxCommits !== undefined) historyOpts.maxCommits = opts.maxCommits;
  const commits = await gitReader.readHistory(repoPath, historyOpts);
  console.log(`[git]      read ${commits.length} commits  ${elapsed(t3)}`);

  // 4. Run match engine
  const t4 = now();
  const engine = await loadMatchEngine();
  const sessions = parseResults.map((r) => r.session);
  const report: RepoMatchReport = engine.match(repoPath, commits, sessions);
  console.log(`[match]    produced ${report.matches.length} candidates  ${elapsed(t4)}`);

  // 5. Build extended report file
  const sessionSourceMap: Record<string, string> = {};
  const skippedBySession: Record<string, { count: number; samples: string[] }> = {};
  for (const r of parseResults) {
    const sid = r.session.meta.sessionId;
    sessionSourceMap[sid] = r.session.meta.sourcePath;
    skippedBySession[sid] = r.skipped;
  }

  const loreReport: LoreReportFile = {
    ...report,
    sessionSourceMap,
    skippedBySession,
  };

  // 6. Write .lore/report.json
  const loreDir = path.join(repoPath, '.lore');
  await fs.mkdir(loreDir, { recursive: true });
  const reportPath = path.join(loreDir, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(loreReport, null, 2), 'utf8');
  console.log(`\n[write]    ${reportPath}  ${elapsed(t0)} total\n`);

  // 7. Print human summary
  console.log(renderReport(report));
}

// ── lore sample ──────────────────────────────────────────────────────────────

async function cmdSample(opts: {
  repo: string;
  n: string;
  tier?: string;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const n = parseInt(opts.n, 10);
  if (isNaN(n) || n <= 0) {
    console.error('Error: -n must be a positive integer');
    process.exit(1);
  }

  const tier = opts.tier as 'strong' | 'weak' | undefined;
  if (tier !== undefined && tier !== 'strong' && tier !== 'weak') {
    console.error('Error: --tier must be "strong" or "weak"');
    process.exit(1);
  }

  const reportPath = path.join(repoPath, '.lore', 'report.json');
  let loreReport: LoreReportFile;
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    loreReport = JSON.parse(raw) as LoreReportFile;
  } catch (e) {
    console.error(`Error: cannot read ${reportPath}. Run "lore scan" first.`);
    process.exit(1);
  }

  // Filter by tier
  let pool: MatchCandidate[];
  if (tier) {
    pool = loreReport.matches.filter((m) => tierOf(m.confidence) === tier);
  } else {
    pool = loreReport.matches.filter((m) => tierOf(m.confidence) !== 'none');
  }

  if (pool.length === 0) {
    console.log(`No matches found${tier ? ` for tier "${tier}"` : ''}.`);
    return;
  }

  const sampled = randomSample(pool, Math.min(n, pool.length));
  const parser = await loadParser();

  // Group by sessionId to avoid re-parsing the same file multiple times
  const bySession = new Map<string, MatchCandidate[]>();
  for (const m of sampled) {
    const arr = bySession.get(m.sessionId) ?? [];
    arr.push(m);
    bySession.set(m.sessionId, arr);
  }

  console.log(`\n# lore sample — ${sampled.length} match(es) from ${repoPath}\n`);

  for (const [sessionId, matches] of bySession) {
    const sourcePath = loreReport.sessionSourceMap[sessionId];
    if (!sourcePath) {
      console.warn(`WARN: no sourcePath for session ${sessionId}, skipping`);
      continue;
    }

    let parseResult: ParseResult | null = null;
    try {
      parseResult = await parser.parse(sourcePath);
    } catch (e) {
      console.warn(`WARN: failed to re-parse ${sourcePath}: ${String(e)}`);
    }

    for (const match of matches) {
      await renderSampleBlock(match, sourcePath, parseResult);
    }
  }
}

async function renderSampleBlock(
  match: MatchCandidate,
  sourcePath: string,
  parseResult: { session: import('./schema/events.js').ParsedSession } | null,
): Promise<void> {
  const tierLabel = tierOf(match.confidence);
  console.log('─'.repeat(72));
  console.log(`## Commit: ${match.commitHash}  file: ${match.filePath}`);
  console.log(`   Session: ${match.sessionId}`);
  console.log(`   Confidence: ${match.confidence.toFixed(3)} (${tierLabel})`);
  if (match.evidence.length > 0) {
    console.log(`   Evidence:`);
    for (const e of match.evidence) {
      console.log(`     • ${e}`);
    }
  }
  console.log(`   Source: ${sourcePath}`);
  console.log('');

  if (!parseResult) {
    console.log('   [session could not be re-parsed]');
    console.log('');
    return;
  }

  const { events } = parseResult.session;
  const editSeqSet = new Set(match.editSeqs);

  // Find the edit events that contributed
  const editEvents = events.filter(
    (e) => e.kind === 'file-edit' && editSeqSet.has(e.seq),
  );

  if (editEvents.length === 0) {
    console.log('   [no contributing edit events found in session]');
    console.log('');
    return;
  }

  // For each edit event, find the nearest user-message and assistant-message
  // that precede and follow it in the event stream.
  for (const editEvt of editEvents) {
    const idx = events.findIndex((e) => e.seq === editEvt.seq);
    if (idx === -1) continue;

    // Search backwards for nearest user-message
    let nearestUserBefore: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'user-message') {
        nearestUserBefore = truncate(e.text.trim(), 300);
        break;
      }
    }

    // Search backwards for nearest assistant-message
    let nearestAssistantBefore: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'assistant-message') {
        nearestAssistantBefore = truncate(e.text.trim(), 300);
        break;
      }
    }

    // Search forwards for nearest user-message
    let nearestUserAfter: string | null = null;
    for (let i = idx + 1; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'user-message') {
        nearestUserAfter = truncate(e.text.trim(), 300);
        break;
      }
    }

    // Search forwards for nearest assistant-message
    let nearestAssistantAfter: string | null = null;
    for (let i = idx + 1; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'assistant-message') {
        nearestAssistantAfter = truncate(e.text.trim(), 300);
        break;
      }
    }

    console.log(`   Edit seq=${editEvt.seq}  op=${editEvt.kind === 'file-edit' ? (editEvt as import('./schema/events.js').FileEditEvent).op : '?'}`);

    if (nearestUserBefore) {
      console.log(`   [USER before]`);
      console.log(`   > ${nearestUserBefore}`);
    }
    if (nearestAssistantBefore) {
      console.log(`   [ASSISTANT before]`);
      console.log(`   > ${nearestAssistantBefore}`);
    }
    if (nearestUserAfter) {
      console.log(`   [USER after]`);
      console.log(`   > ${nearestUserAfter}`);
    }
    if (nearestAssistantAfter) {
      console.log(`   [ASSISTANT after]`);
      console.log(`   > ${nearestAssistantAfter}`);
    }
    console.log('');
  }
}

// ── Commander wiring ─────────────────────────────────────────────────────────

program
  .name('lore')
  .description('Link AI agent conversations to the git commits they produced')
  .version('0.0.1');

program
  .command('scan')
  .description('Scan a repository: discover transcripts → parse → match → write .lore/report.json')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--max-commits <n>', 'limit git history to N commits', (v) => parseInt(v, 10))
  .action((opts: { repo: string; maxCommits?: number }) => {
    cmdScan(opts).catch((e) => {
      console.error('scan failed:', e);
      process.exit(1);
    });
  });

program
  .command('sample')
  .description('Sample matches from .lore/report.json and display context for review')
  .requiredOption('--repo <path>', 'path to the git repository')
  .requiredOption('-n <num>', 'number of matches to sample')
  .option('--tier <tier>', 'filter by tier: strong | weak')
  .action((opts: { repo: string; n: string; tier?: string }) => {
    cmdSample(opts).catch((e) => {
      console.error('sample failed:', e);
      process.exit(1);
    });
  });

program.parse();
