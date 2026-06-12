#!/usr/bin/env node
/**
 * lore CLI — commands:
 *
 *   lore           [--repo <path>]  (default: scan → serve → open browser)
 *   lore go        [--repo <path>]  (alias for default)
 *   lore scan      --repo <path> [--max-commits N] [--broad] [--no-graph]
 *   lore init      [--repo <path>]
 *   lore sample    --repo <path> -n <num> [--tier strong|weak]
 *   lore why       <target> --repo <path> [--json]
 *   lore history   <path>   --repo <path> [--json]
 *   lore distill   --repo <path> [--max-sessions N]
 *   lore ask       <question> --repo <path> [--include-superseded] [--json]
 *   lore mcp       --repo <path>
 *   lore serve     --repo <path> [--port 4017]
 */

import { Command } from 'commander';

// Create a fresh Command instance rather than using the shared commander
// singleton. This ensures the module is safe to import multiple times in
// the same process (e.g. vitest singleFork test runs).
const program = new Command();
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── type-only imports (contracts) ────────────────────────────────────────────
import type { TranscriptParser, ParseResult } from './schema/events.js';
import type { GitHistoryReader } from './git/types.js';
import type { MatchEngine, RepoMatchReport, MatchCandidate } from './match/types.js';
import { tierOf } from './match/types.js';
import { renderReport } from './report/markdown.js';
import type { GraphStore } from './graph/types.js';
import type { WhyEngine, WhyOptions, WhyResult, WhyAttribution } from './why/types.js';
import type { AskEngine, AskResult } from './ask/types.js';
import type { Distiller } from './distill/types.js';

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

async function loadParsers(): Promise<TranscriptParser[]> {
  const mod = await import('./parsers/registry.js');
  return mod.allParsers as TranscriptParser[];
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

async function loadGraphBuilder(): Promise<{
  buildGraphData: (
    repoPath: string,
    commits: import('./git/types.js').CommitInfo[],
    sessions: import('./schema/events.js').ParsedSession[],
    report: RepoMatchReport,
  ) => import('./graph/types.js').GraphData;
}> {
  return await import('./graph/build.js');
}

async function loadGraphFactory(): Promise<import('./graph/types.js').GraphStoreFactory> {
  const mod = await import('./graph/factory.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.createGraphStore as import('./graph/types.js').GraphStoreFactory;
}

async function loadWhyEngine(): Promise<WhyEngine> {
  const mod = await import('./why/engine.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.engine as WhyEngine;
}

async function loadAskEngine(): Promise<AskEngine> {
  const mod = await import('./ask/engine.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.engine as AskEngine;
}

async function loadDistiller(): Promise<Distiller> {
  const mod = await import('./distill/claude-cli.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.distiller as Distiller;
}

async function loadDistillOrchestrate(): Promise<{
  runDistill(
    repoPath: string,
    opts: { distiller: Distiller; maxSessions?: number },
  ): Promise<{
    distilled: number;
    skipped: number;
    notesAdded: number;
    superseded: number;
    errors: { sessionId: string; error: string }[];
  }>;
}> {
  return await import('./distill/orchestrate.js');
}

async function loadMcpServer(): Promise<{
  createLoreMcpServer: typeof import('./mcp/server.js').createLoreMcpServer;
}> {
  return await import('./mcp/server.js');
}

// ── ANSI color helpers (raw escape codes; gated on process.stdout.isTTY) ─────

const USE_COLOR = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;

function c(code: string, text: string): string {
  if (!USE_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

/** Bold green: success / checkmarks */
export function green(text: string): string { return c('1;32', text); }
/** Bold blue: info / steps */
export function blue(text: string): string { return c('1;34', text); }
/** Bold yellow: warnings */
export function yellow(text: string): string { return c('1;33', text); }
/** Bold red: errors */
export function red(text: string): string { return c('1;31', text); }
/** Dim/gray: secondary info */
export function dim(text: string): string { return c('2', text); }
/** Bold: emphasis */
export function bold(text: string): string { return c('1', text); }

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

/**
 * Render a summary box after lore go completes.
 * Pure function — exported for testing.
 *
 * @param matchRate     e.g. "74.2%"
 * @param nodeCount     total graph nodes
 * @param edgeCount     total graph edges
 * @param url           viewer URL
 */
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

/**
 * Idempotently inject (or refresh) a "## lore" section into a markdown file.
 * Pure function — exported for testing.
 *
 * Returns { content, injected } where:
 *   - content  is the final file text (with section present)
 *   - injected is true if the section was newly added (false if already present / updated)
 */
export function injectLoreSection(existing: string): { content: string; injected: boolean } {
  const MARKER_START = '<!-- lore:start -->';
  const MARKER_END = '<!-- lore:end -->';

  const section = [
    '',
    '## lore — AI-conversation ↔ commit traceability',
    '',
    MARKER_START,
    '<!-- This block is managed by `lore init` — do not edit manually. -->',
    '',
    'Before editing an unfamiliar file, run:',
    '```',
    'npx lore why <file>:<line> --repo .',
    '```',
    '',
    'Before making a design decision, run:',
    '```',
    "npx lore ask \"<your question>\" --repo .",
    '```',
    '',
    'Distilled constraints in `.lore/notes.json` encode prior decisions — respect them.',
    'Run `npx lore go --repo .` to rebuild the graph and open the viewer.',
    '',
    MARKER_END,
  ].join('\n');

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Section already present — replace its content (idempotent update)
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MARKER_END.length);
    // Check if already identical to avoid spurious "updated" messages
    const newContent = before + MARKER_START + section.slice(
      section.indexOf(MARKER_START) + MARKER_START.length,
      section.indexOf(MARKER_END) + MARKER_END.length,
    ) + after;
    return { content: newContent, injected: false };
  }

  // Not present — append
  const newContent = existing.trimEnd() + '\n' + section + '\n';
  return { content: newContent, injected: true };
}

/**
 * Determine whether a report is stale relative to now / a HEAD commit time.
 * Pure-ish logic (injectable nowMs + headTime for testability).
 * Returns a warning string to emit, or null if fresh.
 *
 * Staleness conditions:
 *   - HEAD commit is newer than generatedAt, OR
 *   - generatedAt is more than 4 hours before nowMs.
 */
export function staleness(opts: {
  generatedAt: string;
  nowMs: number;
  headTime: string | null;
  repoPath: string;
  useColor: boolean;
}): string | null {
  const { generatedAt, nowMs, headTime, repoPath, useColor } = opts;
  const generatedMs = Date.parse(generatedAt);
  if (isNaN(generatedMs)) return null;

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const ageStale = nowMs - generatedMs > FOUR_HOURS_MS;

  let headNewer = false;
  if (headTime) {
    const headMs = Date.parse(headTime);
    if (!isNaN(headMs) && headMs > generatedMs) {
      headNewer = true;
    }
  }

  if (!headNewer && !ageStale) return null;

  const genStr = generatedAt.slice(0, 19).replace('T', ' ');
  const headStr = headTime ? headTime.slice(0, 19).replace('T', ' ') : 'unknown';
  const warnLabel = useColor ? `\x1b[1;33mWARNING\x1b[0m` : 'WARNING';
  return (
    `${warnLabel}: lore data is stale (generated ${genStr}, HEAD ${headStr})` +
    ` — run \`lore scan --repo ${repoPath}\`\n`
  );
}

/**
 * Guard: ensure .lore/report.json exists; exit(1) with a helpful message if not.
 * Also emits a non-blocking staleness warning to stderr when:
 *   - HEAD commit is newer than report's generatedAt, OR
 *   - generatedAt is more than 4 hours before now.
 * Git failure silently skips the staleness check.
 * Called by commands (why, history, ask, serve) that need a prior `lore scan`.
 */
async function requireReport(repoPath: string): Promise<void> {
  const reportPath = path.join(repoPath, '.lore', 'report.json');
  try {
    await fs.access(reportPath);
  } catch {
    console.error(
      '\n' + red('Error:') + ' .lore/report.json not found.\n\n' +
      `  Run ${bold('`lore scan --repo <path>`')} first, or\n` +
      `  use ${bold('`lore go --repo <path>`')} for a one-step scan + viewer.\n`,
    );
    process.exit(1);
  }

  // Staleness warning — non-blocking; all failures are silently skipped.
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    const report = JSON.parse(raw) as { generatedAt?: string };
    const generatedAt = report.generatedAt;
    if (!generatedAt) return; // old report without timestamp — skip

    // Attempt to read HEAD commit time via git.
    let headTime: string | null = null;
    try {
      const { execFile: execFileCb } = await import('node:child_process');
      const { promisify: prom } = await import('node:util');
      const execFileAsync2 = prom(execFileCb);
      const { stdout } = await execFileAsync2(
        'git',
        ['-C', repoPath, 'log', '-1', '--format=%cI'],
        { encoding: 'utf8' },
      );
      headTime = stdout.trim() || null;
    } catch {
      // git not available or repo has no commits — skip git check.
    }

    const useColor = process.stderr.isTTY === true && process.env['NO_COLOR'] === undefined;
    const warning = staleness({
      generatedAt,
      nowMs: Date.now(),
      headTime,
      repoPath,
      useColor,
    });
    if (warning) {
      process.stderr.write(warning);
    }
  } catch {
    // Any unexpected error in staleness check must not block the command.
  }
}

/**
 * Ensure .lore/.gitignore exists with content "*".
 * Idempotent: does NOT overwrite if already present.
 * Called automatically during scan to prevent accidental commits.
 */
async function writeLoreGitignore(loreDir: string): Promise<void> {
  const giPath = path.join(loreDir, '.gitignore');
  try {
    await fs.access(giPath);
    // Already exists — leave it alone.
  } catch {
    // Does not exist — create it.
    await fs.writeFile(giPath, '*\n', 'utf8');
  }
}

/**
 * Find a free port starting from `start`, probing up to `start + range`.
 * Falls back to 0 (OS picks) if none found in range.
 */
async function findFreePort(start: number, range = 20): Promise<number> {
  const net = await import('node:net');
  for (let port = start; port < start + range; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => {
        s.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  return 0; // Let OS pick
}

/** Open a URL in the default browser (best-effort; errors are non-fatal). */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmds: Record<string, string[]> = {
    darwin: ['open'],
    linux: ['xdg-open'],
    win32: ['cmd', '/c', 'start'],
  };
  const platform = process.platform as string;
  const parts = cmds[platform];
  if (!parts) return; // unknown platform — skip silently
  try {
    spawn(parts[0]!, [...parts.slice(1), url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // Browser open is non-fatal
  }
}

// ── Render helpers (pure functions — tested independently) ───────────────────

/**
 * Render a WhyResult as human-readable terminal output.
 * Pure function: takes a WhyResult and repo path, returns a string.
 */
export function renderWhyResult(result: WhyResult, repoPath: string): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`file:  ${result.file}:${result.line}`);
  lines.push(`line:  ${result.lineContent}`);
  lines.push('');
  lines.push(`commit: ${result.commit.hash.slice(0, 8)}  ${result.commit.subject}`);
  lines.push(`        author ${result.commit.authorDate.slice(0, 10)}  ` +
    `committer ${result.commit.committerDate.slice(0, 10)}`);

  if (result.attributions.length === 0) {
    // Blind-spot path
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

/**
 * Render a fileHistory result as human-readable terminal output.
 * Pure function: takes history entries, returns a string.
 */
export function renderFileHistory(
  filePath: string,
  history: { commit: import('./graph/types.js').CommitNodeData; produced: import('./graph/types.js').ProducedInfo[] }[],
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
          `src=${path.basename(p.sourcePath)}`
        );
      }
    } else {
      lines.push('            ← (no conversation attribution)');
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── lore scan ────────────────────────────────────────────────────────────────

interface ScanResult {
  report: RepoMatchReport;
  nodeCount: number;
  edgeCount: number;
  graphBuilt: boolean;
}

async function cmdScan(opts: {
  repo: string;
  maxCommits?: number;
  broad?: boolean;
  graph?: boolean;
  quiet?: boolean;
}): Promise<ScanResult> {
  const repoPath = path.resolve(opts.repo);
  const t0 = now();

  if (!opts.quiet) console.log(`\n${blue('▶')} lore scan: ${repoPath}\n`);

  // 1. Discover transcripts — run all registered parsers
  const t1 = now();
  const parsers = await loadParsers();
  const discoverOpts = { broad: opts.broad === true };

  // Per-parser discover, collected in parallel
  const perParserPaths = await Promise.all(
    parsers.map((p) => p.discover(repoPath, discoverOpts)),
  );

  const parserCountParts: string[] = [];
  for (let i = 0; i < parsers.length; i++) {
    const p = parsers[i]!;
    const paths = perParserPaths[i]!;
    parserCountParts.push(`${p.agent}=${paths.length}`);
  }
  const totalPaths = perParserPaths.reduce((s, ps) => s + ps.length, 0);
  if (!opts.quiet) console.log(`${green('✓')} [discover] found ${totalPaths} transcripts  ${dim(parserCountParts.join(' '))}  ${dim(elapsed(t1))}`);

  // 2. Parse concurrently across all parsers — warn and skip failures
  const t2 = now();
  // Flatten: (parser, path) pairs
  const parseJobs: { parser: TranscriptParser; path: string }[] = [];
  for (let i = 0; i < parsers.length; i++) {
    const p = parsers[i]!;
    for (const tp of perParserPaths[i]!) {
      parseJobs.push({ parser: p, path: tp });
    }
  }

  const settled = await Promise.allSettled(
    parseJobs.map((job) => job.parser.parse(job.path)),
  );

  const parseResults: ParseResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (!s) continue;
    if (s.status === 'fulfilled') {
      parseResults.push(s.value);
    } else {
      console.warn(`[parse] WARN: skipped ${parseJobs[i]!.path}: ${String(s.reason)}`);
    }
  }
  if (!opts.quiet) console.log(`${green('✓')} [parse]    parsed ${parseResults.length}/${totalPaths} sessions  ${dim(elapsed(t2))}`);

  // 3. Read git history
  const t3 = now();
  const gitReader = await loadGitReader();
  // 默认 --all：agent 的真实 commit 常在 PR 分支上（squash 合并后 main 上只有改写版）。
  const historyOpts: { since?: string; maxCommits?: number; allRefs?: boolean } = {
    allRefs: true,
  };
  if (opts.maxCommits !== undefined) historyOpts.maxCommits = opts.maxCommits;
  const commits = await gitReader.readHistory(repoPath, historyOpts);
  if (!opts.quiet) console.log(`${green('✓')} [git]      read ${commits.length} commits  ${dim(elapsed(t3))}`);

  // 4. Run match engine
  const t4 = now();
  const engine = await loadMatchEngine();
  const sessions = parseResults.map((r) => r.session);
  const report: RepoMatchReport = engine.match(repoPath, commits, sessions);
  if (!opts.quiet) console.log(`${green('✓')} [match]    produced ${report.matches.length} candidates  ${dim(elapsed(t4))}`);

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

  // 6. Write .lore/report.json + production-safety .gitignore
  const loreDir = path.join(repoPath, '.lore');
  await fs.mkdir(loreDir, { recursive: true });
  // Safety: auto-create .lore/.gitignore="*" so transcripts/notes can't be
  // accidentally committed (they contain full conversation content).
  await writeLoreGitignore(loreDir);
  const reportPath = path.join(loreDir, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(loreReport, null, 2), 'utf8');
  if (!opts.quiet) console.log(`\n${green('✓')} [write]    ${reportPath}  ${dim(elapsed(t0) + ' total')}\n`);

  // 7. Print human summary
  if (!opts.quiet) console.log(renderReport(report));

  // 8. Build graph (skipped with --no-graph)
  let nodeCount = 0;
  let edgeCount = 0;
  let graphBuilt = false;

  if (opts.graph !== false) {
    const tg = now();
    try {
      const [builder, createStore] = await Promise.all([
        loadGraphBuilder(),
        loadGraphFactory(),
      ]);

      const graphData = builder.buildGraphData(repoPath, commits, sessions, report);
      // createGraphStore 内部已 init。
      const store: GraphStore = await createStore(repoPath);
      await store.rebuild(graphData);
      await store.close();

      nodeCount =
        graphData.sessions.length +
        graphData.commits.length +
        graphData.files.length;
      edgeCount =
        graphData.produced.length +
        graphData.touches.length +
        graphData.edited.length;
      graphBuilt = true;

      if (!opts.quiet) console.log(
        `${green('✓')} [graph]    nodes=${nodeCount} edges=${edgeCount} backend=${store.backend}  ${dim(elapsed(tg))}`,
      );
    } catch (e) {
      console.error(`${yellow('⚠')} [graph]    graph build failed (${String(e)})`);
    }
  }

  return { report, nodeCount, edgeCount, graphBuilt };
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
  } catch {
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
  const parsers = await loadParsers();

  // Group by sessionId to avoid re-parsing the same file multiple times
  // 按解析单元（candidate.sourcePath）分组——证据上下文必须取自真正包含编辑的文件，
  // 同 sessionId 的父 session 与子 agent 是不同解析单元。
  const bySource = new Map<string, MatchCandidate[]>();
  for (const m of sampled) {
    const src = m.sourcePath || loreReport.sessionSourceMap[m.sessionId] || '';
    const arr = bySource.get(src) ?? [];
    arr.push(m);
    bySource.set(src, arr);
  }

  console.log(`\n# lore sample — ${sampled.length} match(es) from ${repoPath}\n`);

  for (const [sourcePath, matches] of bySource) {
    if (!sourcePath) {
      console.warn(`WARN: no sourcePath for ${matches.length} match(es), skipping`);
      continue;
    }

    // Pick the right parser for this source path by trying each in turn.
    let parseResult: ParseResult | null = null;
    for (const p of parsers) {
      try {
        parseResult = await p.parse(sourcePath);
        break;
      } catch {
        // not this parser's format — try the next one
      }
    }
    if (parseResult === null) {
      console.warn(`WARN: failed to re-parse ${sourcePath} with any known parser`);
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

// ── lore why ─────────────────────────────────────────────────────────────────

async function cmdWhy(
  target: string,
  opts: { repo: string; json?: boolean; includeWeak?: boolean },
): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  // Parse target: accept "file:line" or absolute path containing a colon before line
  let file: string;
  let line: number;

  // Split on last colon to support paths like /abs/path/src/a.ts:42
  const colonIdx = target.lastIndexOf(':');
  if (colonIdx === -1) {
    console.error('Error: target must be in the form <file>:<line>, e.g. src/a.ts:42');
    process.exit(1);
  }

  const rawFile = target.slice(0, colonIdx);
  const rawLine = target.slice(colonIdx + 1);
  line = parseInt(rawLine, 10);
  if (isNaN(line) || line < 1) {
    console.error(`Error: line number must be a positive integer, got: ${rawLine}`);
    process.exit(1);
  }

  // Normalise to repo-relative path
  if (path.isAbsolute(rawFile)) {
    const rel = path.relative(repoPath, rawFile);
    if (rel.startsWith('..')) {
      console.error(`Error: path ${rawFile} is not inside repo ${repoPath}`);
      process.exit(1);
    }
    file = rel;
  } else {
    file = rawFile;
  }

  // Guard: require .lore/report.json
  await requireReport(repoPath);

  const whyEngine = await loadWhyEngine();
  const whyOpts: WhyOptions = {
    includeWeak: opts.includeWeak === true,
  };
  const result = await whyEngine.why(repoPath, file, line, whyOpts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderWhyResult(result, repoPath));
}

// ── lore history ─────────────────────────────────────────────────────────────

async function cmdHistory(
  filePath: string,
  opts: { repo: string; json?: boolean },
): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  // Normalise to repo-relative path
  let relPath: string;
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(repoPath, filePath);
    if (rel.startsWith('..')) {
      console.error(`Error: path ${filePath} is not inside repo ${repoPath}`);
      process.exit(1);
    }
    relPath = rel;
  } else {
    relPath = filePath;
  }

  // Guard: require .lore/report.json
  await requireReport(repoPath);

  const createStore = await loadGraphFactory();
  const store: GraphStore = await createStore(repoPath);
  await store.init();

  try {
    const history = await store.fileHistory(relPath);

    if (opts.json) {
      console.log(JSON.stringify(history, null, 2));
      return;
    }

    console.log(renderFileHistory(relPath, history));
  } finally {
    await store.close();
  }
}

// ── lore distill ─────────────────────────────────────────────────────────────

async function cmdDistill(opts: {
  repo: string;
  maxSessions?: number;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  console.log(`\nlore distill: ${repoPath}\n`);

  const distiller = await loadDistiller();
  const available = await distiller.available();
  if (!available) {
    console.error(
      'Error: claude CLI not found in PATH.\n' +
      'Install Claude Code (https://claude.ai/download) and ensure `claude` is on your PATH,\n' +
      'then re-run `lore distill`.',
    );
    process.exit(1);
  }

  const orchestrate = await loadDistillOrchestrate();
  const distillOpts: { distiller: Distiller; maxSessions?: number } = { distiller };
  if (opts.maxSessions !== undefined) distillOpts.maxSessions = opts.maxSessions;
  const stats = await orchestrate.runDistill(repoPath, distillOpts);

  console.log(`\ndistill complete:`);
  console.log(`  distilled:         ${stats.distilled}`);
  console.log(`  skipped (cached):  ${stats.skipped}`);
  console.log(`  notes added:       ${stats.notesAdded}`);
  console.log(`  superseded:        ${stats.superseded}`);
  console.log(`  errors:            ${stats.errors.length}`);
}

// ── lore ask ──────────────────────────────────────────────────────────────────

/**
 * Render AskResult for human-readable terminal output.
 * Pure function — exported for testing.
 */
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
      lines.push(`  [${i + 1}] ${n.kind}  score=${h.score.toFixed(3)}${anchor}`);
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

async function cmdAsk(
  question: string,
  opts: { repo: string; includeSuperseded?: boolean; json?: boolean },
): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  // Guard: require .lore/report.json
  await requireReport(repoPath);

  const askEngine = await loadAskEngine();

  const result = await askEngine.ask(repoPath, question, {
    topK: 5,
    includeSuperseded: opts.includeSuperseded === true,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderAskResult(result));
}

// ── lore mcp ──────────────────────────────────────────────────────────────────

async function cmdMcp(opts: { repo: string }): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  // Log to stderr — stdout is reserved for JSON-RPC.
  process.stderr.write(`[lore-mcp] starting MCP server for ${repoPath}\n`);

  const { createLoreMcpServer } = await loadMcpServer();
  const server = createLoreMcpServer(repoPath);

  // StdioServerTransport reads from process.stdin and writes to process.stdout.
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  ) as { StdioServerTransport: typeof import('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport };

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[lore-mcp] connected, waiting for requests\n');
  // Long-lived process — do NOT call process.exit.
  // The process will stay alive as long as the transport connection is open.
}

// ── lore serve ────────────────────────────────────────────────────────────────

async function cmdServe(opts: { repo: string; port?: number }): Promise<number> {
  const repoPath = path.resolve(opts.repo);
  const startPort = opts.port ?? 4017;

  // Guard: require .lore/report.json
  await requireReport(repoPath);

  const mod = await import('./viewer/server.js');
  const server = mod.createViewerServer(repoPath);
  const freePort = await findFreePort(startPort);
  const actualPort = await server.start(freePort);
  const url = `http://localhost:${actualPort}`;
  console.log(`\n${green('✓')} lore serve: ${repoPath}`);
  console.log(`  ${blue('→')} ${bold(url)}\n`);
  // Long-lived: stay alive until SIGINT/SIGTERM.
  return actualPort;
}

// ── lore go (default one-liner: scan → serve → open browser) ─────────────────

async function cmdGo(opts: { repo: string; port?: number }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const startPort = opts.port ?? 4017;

  console.log(`\n${blue('▶')} lore go — ${repoPath}\n`);

  // Step 1: scan (broad by default — catches all worktree sessions)
  console.log(`${blue('1/3')} scanning…\n`);
  const scanResult = await cmdScan({ repo: repoPath, broad: true, graph: true });

  if (!scanResult.graphBuilt) {
    console.log(`\n${yellow('⚠')}  graph not built — viewer may be empty.`);
    console.log(`    Run \`lore scan --repo ${repoPath}\` manually for details.\n`);
  }

  // Step 2: start viewer server
  console.log(`\n${blue('2/3')} starting viewer…`);
  const mod = await import('./viewer/server.js');
  const server = mod.createViewerServer(repoPath);
  const freePort = await findFreePort(startPort);
  const actualPort = await server.start(freePort);
  const url = `http://localhost:${actualPort}`;
  console.log(`${green('✓')} viewer ready at ${bold(url)}\n`);

  // Step 3: open browser (best-effort; failure is non-fatal)
  console.log(`${blue('3/3')} opening browser…`);
  try {
    await openBrowser(url);
    console.log(`${green('✓')} browser launched\n`);
  } catch {
    console.log(`${yellow('⚠')}  could not open browser automatically.\n    Visit: ${url}\n`);
  }

  // Summary box
  const report = scanResult.report;
  const strongPct = report.commitsTotal > 0
    ? ((report.commitsMatchedStrong / report.commitsTotal) * 100).toFixed(1) + '%'
    : '0.0%';
  const inWinRate = report.window && report.commitsInWindow > 0
    ? (((report.strongInWindow + report.weakInWindow) / report.commitsInWindow) * 100).toFixed(1) + '% in-window'
    : null;
  const matchRate = inWinRate ?? strongPct;

  console.log(renderSummaryBox({
    matchRate,
    nodeCount: scanResult.nodeCount,
    edgeCount: scanResult.edgeCount,
    url,
  }));
  console.log('');
  console.log(`${dim('Press Ctrl+C to stop the viewer server.')}`);
  // Long-lived: keep process alive until SIGINT/SIGTERM.
}

// ── lore init ─────────────────────────────────────────────────────────────────

async function cmdInit(opts: { repo: string }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  console.log(`\n${blue('▶')} lore init: ${repoPath}\n`);

  const targets: { file: string; label: string }[] = [
    { file: path.join(repoPath, 'CLAUDE.md'), label: 'CLAUDE.md' },
    { file: path.join(repoPath, 'AGENTS.md'), label: 'AGENTS.md' },
  ];

  let anyChanged = false;
  for (const { file, label } of targets) {
    let existing = '';
    let exists = true;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch {
      exists = false;
    }

    const { content, injected } = injectLoreSection(existing);

    if (!exists) {
      // File does not exist — only create CLAUDE.md, not AGENTS.md
      if (label === 'CLAUDE.md') {
        await fs.writeFile(file, content, 'utf8');
        console.log(`${green('✓')} created ${label} with lore section`);
        anyChanged = true;
      } else {
        console.log(`${dim('–')} ${label} — not found, skipping`);
      }
    } else if (injected) {
      await fs.writeFile(file, content, 'utf8');
      console.log(`${green('✓')} injected lore section into ${label}`);
      anyChanged = true;
    } else {
      // Section already present — refresh content (idempotent)
      if (existing !== content) {
        await fs.writeFile(file, content, 'utf8');
        console.log(`${dim('↻')} ${label} — lore section refreshed`);
        anyChanged = true;
      } else {
        console.log(`${dim('–')} ${label} — lore section already up to date`);
      }
    }
  }

  if (!anyChanged) {
    console.log(`\n${dim('All files already up to date — no changes made.')}`);
  }
  console.log('');
}

// ── Commander wiring ─────────────────────────────────────────────────────────

program
  .name('lore')
  .description(
    'lore — the intent layer for Git.\n' +
    'Link AI agent conversations to the commits they produced,\n' +
    'then query why any line of code was written.\n\n' +
    'Run `lore` (no subcommand) to scan + open the viewer — equivalent to `lore go`.',
  )
  .version('0.1.0')
  // NOTE: root-level options intentionally omitted to avoid shadowing subcommand --repo.
  // The default action below handles `lore` (no args) ≡ `lore go --repo .`.
  .action(() => {
    // lore go is long-lived: no process.exit(0).
    cmdGo({ repo: '.' }).catch((e) => {
      console.error(red('Error:'), e);
      process.exit(1);
    });
  });

program
  .command('go')
  .description('Scan repo, build graph, open viewer in browser — all in one step (default command)')
  .option('--repo <path>', 'path to the git repository (default: cwd)', '.')
  .option('--port <n>', 'viewer port (default: 4017, auto-increments if busy)', (v) => parseInt(v, 10))
  .action((opts: { repo: string; port?: number }) => {
    // lore go is long-lived: no process.exit(0).
    cmdGo(opts).catch((e) => {
      console.error(red('Error:'), e);
      process.exit(1);
    });
  });

program
  .command('init')
  .description('Inject lore guidance into CLAUDE.md / AGENTS.md (idempotent — safe to run multiple times)')
  .option('--repo <path>', 'path to the git repository (default: cwd)', '.')
  .action((opts: { repo: string }) => {
    cmdInit(opts).then(
      // 显式 exit(0)：kuzu 0.11.3 PreparedStatement 终结器在自然退出时
      // use-after-free（SIGSEGV 139）；process.exit 跳过终结器。
      () => process.exit(0),
      (e) => {
        console.error(red('init failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('scan')
  .description('Scan a repo: discover transcripts → parse → match → build graph → write .lore/report.json')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--max-commits <n>', 'limit git history to N commits', (v) => parseInt(v, 10))
  .option('--broad', 'scan ALL local transcripts, not just this repo\'s project dir (catches worktree sessions)')
  .option('--no-graph', 'skip graph build after scan')
  .action((opts: { repo: string; maxCommits?: number; broad?: boolean; graph?: boolean }) => {
    cmdScan(opts).then(
      // 显式 exit(0)：kuzu 0.11.3 PreparedStatement 终结器在自然退出时
      // use-after-free（SIGSEGV 139）；process.exit 跳过终结器。
      () => process.exit(0),
      (e) => {
        console.error(red('scan failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('sample')
  .description('Sample matches from .lore/report.json and display conversation context for review')
  .requiredOption('--repo <path>', 'path to the git repository')
  .requiredOption('-n <num>', 'number of matches to sample')
  .option('--tier <tier>', 'filter by tier: strong | weak')
  .action((opts: { repo: string; n: string; tier?: string }) => {
    cmdSample(opts).then(
      // 显式 exit(0)：kuzu 0.11.3 PreparedStatement 终结器在自然退出时
      // use-after-free（SIGSEGV 139）；process.exit 跳过终结器。
      () => process.exit(0),
      (e) => {
        console.error(red('sample failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('why')
  .description('Explain why a line of code was written — trace it back to the AI conversation')
  .argument('<target>', 'file and line, e.g. src/a.ts:42 or /abs/path/to/file.ts:42')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--json', 'output raw WhyResult as JSON instead of human-readable text')
  .option(
    '--include-weak',
    'include weak attributions (confidence < 0.8) in results; by default only strong-tier matches are shown',
  )
  .action((target: string, opts: { repo: string; json?: boolean; includeWeak?: boolean }) => {
    cmdWhy(target, opts).then(
      // 显式 exit(0)：kuzu 0.11.3 PreparedStatement 终结器在自然退出时
      // use-after-free（SIGSEGV 139）；process.exit 跳过终结器。
      () => process.exit(0),
      (e) => {
        console.error(red('why failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('history')
  .description('Show the full evolution timeline of a file: commits + conversation attributions')
  .argument('<path>', 'repo-relative or absolute path to the file')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--json', 'output raw history array as JSON')
  .action((filePath: string, opts: { repo: string; json?: boolean }) => {
    cmdHistory(filePath, opts).then(
      // 显式 exit(0)：kuzu 0.11.3 PreparedStatement 终结器在自然退出时
      // use-after-free（SIGSEGV 139）；process.exit 跳过终结器。
      () => process.exit(0),
      (e) => {
        console.error(red('history failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('distill')
  .description('Distil conversations into semantic notes (Decision/Constraint/RejectedApproach) using the claude CLI')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--max-sessions <n>', 'limit distillation to N sessions', (v) => parseInt(v, 10))
  .action((opts: { repo: string; maxSessions?: number }) => {
    cmdDistill(opts).then(
      // 显式 exit(0)：kuzu 0.11.3 PreparedStatement 终结器在自然退出时
      // use-after-free（SIGSEGV 139）；process.exit 跳过终结器。
      () => process.exit(0),
      (e) => {
        console.error(red('distill failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('ask')
  .description('Search the project\'s distilled knowledge for a natural-language question')
  .argument('<question>', 'natural-language question about the codebase')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--include-superseded', 'include invalidated/superseded notes in results')
  .option('--json', 'output raw AskResult as JSON instead of human-readable text')
  .action((question: string, opts: { repo: string; includeSuperseded?: boolean; json?: boolean }) => {
    cmdAsk(question, opts).then(
      // 显式 exit(0)：kuzu 0.11.3 PreparedStatement 终结器在自然退出时
      // use-after-free（SIGSEGV 139）；process.exit 跳过终结器。
      () => process.exit(0),
      (e) => {
        console.error(red('ask failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('mcp')
  .description(
    'Start the lore MCP server (stdio transport). ' +
    'Long-lived process — connect via any MCP client. ' +
    'All log output goes to stderr; stdout is reserved for JSON-RPC.',
  )
  .requiredOption('--repo <path>', 'path to the git repository')
  .action((opts: { repo: string }) => {
    // lore mcp is a long-lived process: no process.exit(0).
    // Any startup failure does exit(1) so the MCP host can detect it.
    cmdMcp(opts).catch((e) => {
      process.stderr.write(`[lore-mcp] fatal: ${String(e)}\n`);
      process.exit(1);
    });
  });

program
  .command('serve')
  .description('Start the local graph viewer server (force-directed graph + timeline playback)')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--port <n>', 'port to listen on (default: 4017, auto-increments if busy)', (v) => parseInt(v, 10))
  .action((opts: { repo: string; port?: number }) => {
    // lore serve is a long-lived process: no process.exit(0).
    cmdServe(opts).catch((e) => {
      console.error(red('serve failed:'), e);
      process.exit(1);
    });
  });

// Only parse argv when this module is run directly (not when imported for testing).
// ESM equivalent of `require.main === module`.
// Both sides are resolved through fs.realpathSync so that npm bin symlinks
// (e.g. node_modules/.bin/lore → ../../dist/cli.js) compare equal to the
// physical file path returned by import.meta.url.
function _resolveReal(p: string): string {
  try {
    return fssync.realpathSync(p);
  } catch {
    return p;
  }
}
const _thisFile = _resolveReal(fileURLToPath(import.meta.url));
const _argv1 = process.argv[1] !== undefined ? _resolveReal(process.argv[1]) : undefined;
if (_argv1 !== undefined && _thisFile === _argv1) {
  program.parse();
}
