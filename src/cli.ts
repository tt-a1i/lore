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
import type { Distiller, NotesStore, NoteKind } from './distill/types.js';

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

async function loadNotesStore(): Promise<NotesStore> {
  const mod = await import('./notes/store.js');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod.notesStore as NotesStore;
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

/**
 * 推送式记忆模块（brief/guard）。惰性 import：只在 brief/guard 路径加载，
 * 不拖累其它命令（更重要的是不拖累钩子启动延迟——这些模块零重依赖，
 * 不碰匹配引擎/graph/parser）。
 */
async function loadBrief(): Promise<{
  renderBrief: typeof import('./brief/render.js').renderBrief;
  readGeneratedAt: typeof import('./brief/load.js').readGeneratedAt;
  readActiveNotes: typeof import('./brief/load.js').readActiveNotes;
  readHeadTime: typeof import('./brief/load.js').readHeadTime;
  detectLoreMcp: typeof import('./brief/load.js').detectLoreMcp;
  parseHookInput: typeof import('./brief/hook.js').parseHookInput;
  extractFilePath: typeof import('./brief/hook.js').extractFilePath;
  sessionStartEnvelope: typeof import('./brief/hook.js').sessionStartEnvelope;
  preToolUseEnvelope: typeof import('./brief/hook.js').preToolUseEnvelope;
}> {
  const [render, load, hook] = await Promise.all([
    import('./brief/render.js'),
    import('./brief/load.js'),
    import('./brief/hook.js'),
  ]);
  return {
    renderBrief: render.renderBrief,
    readGeneratedAt: load.readGeneratedAt,
    readActiveNotes: load.readActiveNotes,
    readHeadTime: load.readHeadTime,
    detectLoreMcp: load.detectLoreMcp,
    parseHookInput: hook.parseHookInput,
    extractFilePath: hook.extractFilePath,
    sessionStartEnvelope: hook.sessionStartEnvelope,
    preToolUseEnvelope: hook.preToolUseEnvelope,
  };
}

/**
 * 摘录快照固化：scan 写完 report 后据此算并落 .lore/excerpts.json。
 * 让 `lore why` / viewer 在 Claude Code 清理 transcript 后仍能出对话摘录。
 * 收进 excerpts 模块，cli 只做一次调用。
 */
async function loadExcerptsSnapshotter(): Promise<{
  computeExcerpts: (repoPath: string) => Promise<Record<string, import('./viewer/types.js').ViewerExcerpt[]>>;
  writeSnapshot: (repoPath: string, excerpts: Record<string, import('./viewer/types.js').ViewerExcerpt[]>) => Promise<void>;
}> {
  const [compute, snapshot] = await Promise.all([
    import('./excerpts/compute.js'),
    import('./excerpts/snapshot.js'),
  ]);
  return { computeExcerpts: compute.computeExcerpts, writeSnapshot: snapshot.writeSnapshot };
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
    '**When to use lore (trigger moments):**',
    '',
    '1. **Before editing a file changed by another session in the last 30 days** →',
    '   ```',
    '   npx lore why <file>:<line> --repo .',
    '   ```',
    '',
    '2. **Before proposing a design decision** →',
    '   ```',
    '   npx lore ask "<your question>" --repo .',
    '   # To check constraints on a specific file:',
    '   npx lore ask "<question>" --repo . --file <path>',
    '   ```',
    '',
    '3. **After making an important decision, discovering a hard constraint, or rejecting an approach** →',
    '   ```',
    '   npx lore note --repo . --kind decision --title "..." --body "..." --source agent',
    '   npx lore note --repo . --kind constraint --title "..." --body "..." --source agent',
    '   npx lore note --repo . --kind rejected-approach --title "..." --body "..." --source agent',
    '   ```',
    '',
    '4. **At session start — check data freshness** →',
    '   ```',
    '   npx lore status --repo .',
    '   ```',
    '',
    'Distilled constraints in `.lore/notes.json` encode prior decisions — respect them.',
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
  json?: boolean;
}): Promise<ScanResult> {
  const repoPath = path.resolve(opts.repo);
  const t0 = now();

  // When --json: all progress lines go to stderr so stdout stays pure JSON.
  const progress = opts.json
    ? (msg: string) => process.stderr.write(msg + '\n')
    : (msg: string) => { if (!opts.quiet) console.log(msg); };
  const progressWarn = (msg: string) => process.stderr.write(msg + '\n');

  progress(`\n${blue('▶')} lore scan: ${repoPath}\n`);

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
  progress(`${green('✓')} [discover] found ${totalPaths} transcripts  ${dim(parserCountParts.join(' '))}  ${dim(elapsed(t1))}`);

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
      progressWarn(`[parse] WARN: skipped ${parseJobs[i]!.path}: ${String(s.reason)}`);
    }
  }
  progress(`${green('✓')} [parse]    parsed ${parseResults.length}/${totalPaths} sessions  ${dim(elapsed(t2))}`);

  // 3. Read git history
  const t3 = now();
  const gitReader = await loadGitReader();
  // 默认 --all：agent 的真实 commit 常在 PR 分支上（squash 合并后 main 上只有改写版）。
  const historyOpts: { since?: string; maxCommits?: number; allRefs?: boolean } = {
    allRefs: true,
  };
  if (opts.maxCommits !== undefined) historyOpts.maxCommits = opts.maxCommits;
  const commits = await gitReader.readHistory(repoPath, historyOpts);
  progress(`${green('✓')} [git]      read ${commits.length} commits  ${dim(elapsed(t3))}`);

  // 4. Run match engine
  const t4 = now();
  const engine = await loadMatchEngine();
  const sessions = parseResults.map((r) => r.session);
  const report: RepoMatchReport = engine.match(repoPath, commits, sessions);
  progress(`${green('✓')} [match]    produced ${report.matches.length} candidates  ${dim(elapsed(t4))}`);

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
  progress(`\n${green('✓')} [write]    ${reportPath}  ${dim(elapsed(t0) + ' total')}\n`);

  // 6.5 Excerpts snapshot：固化对话摘录到 .lore/excerpts.json，让记忆不再依赖
  //     Claude Code 的 transcript 留存窗口。失败不阻塞 scan——只警告。
  {
    const te = now();
    try {
      const { computeExcerpts, writeSnapshot } = await loadExcerptsSnapshotter();
      const excerpts = await computeExcerpts(repoPath);
      await writeSnapshot(repoPath, excerpts);
      progress(
        `${green('✓')} [excerpts] snapshot ${Object.keys(excerpts).length} commits  ${dim(elapsed(te))}`,
      );
    } catch (e) {
      progressWarn(`${yellow('⚠')} [excerpts] snapshot failed (${String(e)})`);
    }
  }

  // 7. Print human summary (skipped in --json mode)
  if (!opts.json) progress(renderReport(report));

  // 8. Build graph (skipped with --no-graph)
  let nodeCount = 0;
  let edgeCount = 0;
  let graphBuilt = false;
  let graphBackend: 'kuzu' | 'json' | null = null;

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
      graphBackend = store.backend;
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

      progress(
        `${green('✓')} [graph]    nodes=${nodeCount} edges=${edgeCount} backend=${store.backend}  ${dim(elapsed(tg))}`,
      );
    } catch (e) {
      progressWarn(`${yellow('⚠')} [graph]    graph build failed (${String(e)})`);
    }
  }

  // 9. JSON output (stdout pure)
  if (opts.json) {
    const jsonOut = {
      schemaVersion: 1,
      generatedAt: report.generatedAt,
      commitsTotal: report.commitsTotal,
      strong: report.commitsMatchedStrong,
      weak: report.commitsMatchedWeak,
      window: report.window,
      inWindow: report.commitsInWindow,
      graph: graphBuilt
        ? { nodes: nodeCount, edges: edgeCount, backend: graphBackend }
        : null,
    };
    console.log(JSON.stringify(jsonOut, null, 2));
  }

  return { report, nodeCount, edgeCount, graphBuilt };
}

// ── lore sample ──────────────────────────────────────────────────────────────

async function cmdSample(opts: {
  repo: string;
  n: string;
  tier?: string;
  json?: boolean;
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
    if (opts.json) {
      console.log(JSON.stringify({ schemaVersion: 1, matches: [] }, null, 2));
    } else {
      console.log(`No matches found${tier ? ` for tier "${tier}"` : ''}.`);
    }
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

  if (opts.json) {
    // In JSON mode, collect structured results and emit once
    const jsonMatches: object[] = [];
    for (const [sourcePath, matches] of bySource) {
      if (!sourcePath) continue;
      let parseResult: ParseResult | null = null;
      for (const p of parsers) {
        try { parseResult = await p.parse(sourcePath); break; } catch { /* try next */ }
      }
      for (const match of matches) {
        const excerpts: object[] = [];
        if (parseResult) {
          const { events } = parseResult.session;
          const editSeqSet = new Set(match.editSeqs);
          const editEvents = events.filter((e) => e.kind === 'file-edit' && editSeqSet.has(e.seq));
          for (const editEvt of editEvents) {
            const idx = events.findIndex((e) => e.seq === editEvt.seq);
            if (idx === -1) continue;
            for (let i = idx - 1; i >= 0; i--) {
              const e = events[i];
              if (!e) continue;
              if (e.kind === 'user-message' || e.kind === 'assistant-message') {
                excerpts.push({ seq: e.seq, role: e.kind === 'user-message' ? 'user' : 'assistant', text: truncate(e.text.trim(), 300) });
                break;
              }
            }
          }
        }
        jsonMatches.push({
          commitHash: match.commitHash,
          filePath: match.filePath,
          sessionId: match.sessionId,
          confidence: match.confidence,
          tier: tierOf(match.confidence),
          matchedVia: match.matchedVia,
          matchedLines: match.matchedLines,
          sourcePath,
          evidence: match.evidence,
          excerpts,
        });
      }
    }
    console.log(JSON.stringify({ schemaVersion: 1, matches: jsonMatches }, null, 2));
    return;
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

  let result: WhyResult;
  try {
    result = await whyEngine.why(repoPath, file, line, whyOpts);
  } catch (e) {
    const msg = String(e);
    // Map common git-blame failures to actionable guidance messages.
    if (/no such path/i.test(msg) || /does not exist/i.test(msg) || /unknown revision/i.test(msg)) {
      console.error(
        `${red('Error:')} file not found in HEAD — use a repo-relative path like src/x.ts\n` +
        `  Received: ${file}`,
      );
    } else if (/bad line range/i.test(msg) || /invalid.*line/i.test(msg) || /out of range/i.test(msg)) {
      // Try to extract file line count from error message for a better hint.
      const countMatch = /(\d+)\s+lines?/i.exec(msg);
      const hint = countMatch ? ` (file has ${countMatch[1]} lines)` : '';
      console.error(
        `${red('Error:')} line ${line} out of range${hint} — use a valid line number\n` +
        `  File: ${file}`,
      );
    } else {
      // msg 可能已带 "Error: " 前缀（如底层 execFile 错误），剥掉避免双前缀。
      console.error(`${red('Error:')} ${msg.replace(/^Error:\s*/i, '')}`);
    }
    process.exit(1);
  }

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
    let history: { commit: import('./graph/types.js').CommitNodeData; produced: import('./graph/types.js').ProducedInfo[] }[];
    try {
      history = await store.fileHistory(relPath);
    } catch (e) {
      const msg = String(e);
      if (/no such path/i.test(msg) || /does not exist/i.test(msg) || /not found/i.test(msg)) {
        console.error(
          `${red('Error:')} file not found in HEAD — use a repo-relative path like src/x.ts\n` +
          `  Received: ${relPath}`,
        );
      } else {
        console.error(`${red('Error:')} ${msg}`);
      }
      process.exit(1);
    }

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
  json?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  if (!opts.json) console.log(`\nlore distill: ${repoPath}\n`);
  else process.stderr.write(`lore distill: ${repoPath}\n`);

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

  if (opts.json) {
    console.log(JSON.stringify({ schemaVersion: 1, ...stats }, null, 2));
    return;
  }

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

async function cmdAsk(
  question: string,
  opts: { repo: string; includeSuperseded?: boolean; json?: boolean; file?: string },
): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  // Guard: require .lore/report.json
  await requireReport(repoPath);

  const askEngine = await loadAskEngine();

  const askOpts: { topK: number; includeSuperseded: boolean; file?: string } = {
    topK: 5,
    includeSuperseded: opts.includeSuperseded === true,
  };
  if (opts.file) askOpts.file = opts.file;
  const result = await askEngine.ask(repoPath, question, askOpts);

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

// ── lore note ────────────────────────────────────────────────────────────────

async function cmdNote(opts: {
  repo: string;
  kind: string;
  title: string;
  body: string;
  files?: string;
  supersedes?: string;
  source?: string;
  json?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  // Validate kind
  const validKinds: NoteKind[] = ['decision', 'constraint', 'rejected-approach'];
  if (!validKinds.includes(opts.kind as NoteKind)) {
    console.error(
      `${red('Error:')} --kind must be one of: ${validKinds.join(', ')}\n  Got: ${opts.kind}`,
    );
    process.exit(1);
  }
  const kind = opts.kind as NoteKind;

  // Validate source
  const source: 'agent' | 'human' = opts.source === 'agent' ? 'agent' : 'human';

  // Parse files list
  const files = opts.files ? opts.files.split(',').map((f) => f.trim()).filter(Boolean) : [];

  const store = await loadNotesStore();
  const appendArgs: {
    kind: NoteKind;
    title: string;
    body: string;
    files: string[];
    source: 'agent' | 'human';
    supersedes?: string;
  } = { kind, title: opts.title, body: opts.body, files, source };
  if (opts.supersedes !== undefined) appendArgs.supersedes = opts.supersedes;
  const result = await store.appendNote(repoPath, appendArgs);

  if (opts.json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      id: result.id,
      updated: result.updated,
      superseded: result.superseded,
    }, null, 2));
    return;
  }

  const action = result.updated ? 'updated' : 'added';
  const superMsg = result.superseded ? `  supersedes: ${result.superseded}` : '';
  console.log(`${green('✓')} note ${action}: ${result.id}  [${kind}]  source=${source}${superMsg}`);
}

// ── lore status ───────────────────────────────────────────────────────────────

/**
 * Render a status card for `lore status`.
 * Pure function — exported for testing.
 */
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
  let isStale = false;

  if (isNaN(generatedMs)) {
    freshnessLabel = 'unknown';
    isStale = true;
  } else {
    const headNewer = headTime ? Date.parse(headTime) > generatedMs : false;
    isStale = ageMs > FOUR_H || headNewer;
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

  // Coverage
  const inWindowPct = report.commitsInWindow > 0
    ? (((report.strongInWindow + report.weakInWindow) / report.commitsInWindow) * 100).toFixed(1)
    : '0.0';
  lines.push(`  coverage    ${inWindowPct}% in-window  (${report.strongInWindow} strong + ${report.weakInWindow} weak / ${report.commitsInWindow} commits)`);
  lines.push(`  sessions    ${report.sessionsSeen} seen`);
  lines.push(`  commits     ${report.commitsTotal} total  /  ${report.commitsMatchedStrong} strong  ${report.commitsMatchedWeak} weak`);
  if (report.window) {
    lines.push(`  window      ${report.window.start.slice(0, 10)} → ${report.window.end.slice(0, 10)}`);
  }

  // Notes breakdown
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

async function cmdStatus(opts: { repo: string; json?: boolean }): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  // Read report.json — if missing, give actionable guidance rather than a stack trace.
  const reportPath = path.join(repoPath, '.lore', 'report.json');
  let report: LoreReportFile;
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    report = JSON.parse(raw) as LoreReportFile;
  } catch {
    if (opts.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        status: 'no-report',
        message: `run-scan-first: lore scan --repo ${repoPath}`,
      }, null, 2));
    } else {
      console.log(
        `\n${yellow('⚠')}  No lore data found for: ${repoPath}\n\n` +
        `  To get started, run:\n` +
        `    ${bold(`lore scan --repo ${repoPath}`)}\n` +
        `\n  Or for a one-step scan + viewer:\n` +
        `    ${bold(`lore go --repo ${repoPath}`)}\n`,
      );
    }
    return;
  }

  // Read notes.json — optional, absence is fine.
  type NotesFileSummary = {
    notes: { kind: string; source?: string; invalidAt: string | null }[];
    distilledAt?: string;
  };
  const notesPath = path.join(repoPath, '.lore', 'notes.json');
  let notesFile: NotesFileSummary | null = null;
  try {
    const raw = await fs.readFile(notesPath, 'utf8');
    notesFile = JSON.parse(raw) as NotesFileSummary;
  } catch {
    // Missing notes.json is not an error — distill hasn't run yet.
  }

  // Read HEAD commit time — best effort.
  let headTime: string | null = null;
  try {
    const { execFile: execFileCb } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFileCb);
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'log', '-1', '--format=%cI'], { encoding: 'utf8' });
    headTime = stdout.trim() || null;
  } catch {
    // git not available — skip.
  }

  if (opts.json) {
    const generatedMs = Date.parse(report.generatedAt);
    const FOUR_H = 4 * 60 * 60 * 1000;
    const headNewer = headTime ? Date.parse(headTime) > generatedMs : false;
    const isStale = isNaN(generatedMs) || Date.now() - generatedMs > FOUR_H || headNewer;

    const activeNotes = notesFile?.notes.filter((n) => n.invalidAt === null) ?? [];
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const n of activeNotes) {
      byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
      const src = n.source ?? 'distilled';
      bySource[src] = (bySource[src] ?? 0) + 1;
    }

    console.log(JSON.stringify({
      schemaVersion: 1,
      status: isStale ? 'stale' : 'fresh',
      generatedAt: report.generatedAt,
      headCommitTime: headTime,
      coverage: {
        commitsTotal: report.commitsTotal,
        strong: report.commitsMatchedStrong,
        weak: report.commitsMatchedWeak,
        inWindow: report.commitsInWindow,
        strongInWindow: report.strongInWindow,
        weakInWindow: report.weakInWindow,
        window: report.window,
      },
      sessions: report.sessionsSeen,
      notes: {
        total: notesFile?.notes.length ?? 0,
        active: activeNotes.length,
        byKind,
        bySource,
        distilledAt: notesFile?.distilledAt ?? null,
      },
    }, null, 2));
    return;
  }

  console.log(renderStatusCard({
    repoPath,
    report,
    notesFile,
    headTime,
    nowMs: Date.now(),
  }));
}

// ── lore brief (push-based memory: SessionStart) ──────────────────────────────

/**
 * `lore brief` —— 紧凑项目记忆简报。推送式记忆的 SessionStart 注入源。
 *
 * 性能契约 <150ms：只读 .lore/notes.json + report.json 的 generatedAt，外加
 * 一次 `git log -1`。绝不加载匹配引擎/graph/parser（loadBrief 模块零重依赖）。
 *
 * --format text     人读文本（默认）。
 * --format hook-json  SessionStart hookSpecificOutput.additionalContext 信封。
 * --file <f>        只输出与该文件相关的约束。
 */
async function cmdBrief(opts: {
  repo: string;
  file?: string;
  format?: string;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const b = await loadBrief();

  // 并发读三个来源——三者互不依赖，省往返。
  const [generatedAt, notes, headTime, hasMcp] = await Promise.all([
    b.readGeneratedAt(repoPath),
    b.readActiveNotes(repoPath),
    b.readHeadTime(repoPath),
    b.detectLoreMcp(repoPath),
  ]);

  const briefInput = {
    repoPath,
    generatedAt,
    headTime,
    nowMs: Date.now(),
    notes,
    hasMcp,
    ...(opts.file ? { file: opts.file } : {}),
  };
  const text = b.renderBrief(briefInput);

  if (opts.format === 'hook-json') {
    // SessionStart 信封。注意：即便文本为空也输出有效 JSON（钩子不报错）。
    console.log(b.sessionStartEnvelope(text));
    return;
  }
  console.log(text);
}

// ── lore guard --hook (push-based memory: PreToolUse) ─────────────────────────

/**
 * `lore guard --hook` —— 专为 PreToolUse 钩子设计。
 *
 * 从 stdin 读 hook 协议 JSON（tool_input.file_path），找该文件的活跃约束：
 *   - 有 → PreToolUse additionalContext 信封注入（不带 permissionDecision，绝不 block）。
 *   - 无约束 / stdin 非 JSON / .lore 缺失 → 静默 exit 0（钩子绝不搞挂 session）。
 *
 * 容错铁律：任何异常都吞掉、静默 exit 0。同 <150ms 预算。
 */
async function cmdGuard(opts: { repo: string }): Promise<void> {
  // 读 stdin（hook 协议 JSON）。读不到 / 出错 → 静默退出。
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    return; // 读 stdin 失败 → 静默
  }

  let b: Awaited<ReturnType<typeof loadBrief>>;
  try {
    b = await loadBrief();
  } catch {
    return; // 模块加载失败 → 静默（绝不报错给钩子）
  }

  const input = b.parseHookInput(raw);
  if (!input) return; // 非 JSON / 空 → 静默

  const filePath = b.extractFilePath(input);
  if (!filePath) return; // 没有被编辑文件 → 静默

  // repo 优先用 --repo；否则退回 hook 输入里的 cwd；再退回当前 cwd。
  const repoPath = path.resolve(
    opts.repo && opts.repo !== '.' ? opts.repo
      : (typeof input.cwd === 'string' && input.cwd ? input.cwd : '.'),
  );

  let notes: Awaited<ReturnType<typeof b.readActiveNotes>>;
  try {
    notes = await b.readActiveNotes(repoPath);
  } catch {
    return; // 读 notes 失败 → 静默
  }
  if (notes.length === 0) return; // 无 notes → 静默

  // 渲染 file-scoped 约束（renderBrief 在 file 模式下省略 freshness 头之外的指引）。
  // guard 只要「与该文件相关的约束」本身——给 renderBrief 传 file，并丢掉新鲜度行
  // 之外不必要的噪声：我们用 file 模式，但若该文件无相关约束则静默。
  const { noteRelatedToFile } = await import('./brief/render.js');
  const relevant = notes.filter((n) => noteRelatedToFile(n, filePath, repoPath));
  if (relevant.length === 0) return; // 该文件无相关约束 → 静默

  const text = b.renderBrief({
    repoPath,
    generatedAt: null,
    headTime: null,
    nowMs: Date.now(),
    notes: relevant,
    hasMcp: false,
    file: filePath,
    suppressFreshness: true, // guard 不渲新鲜度行（保最短）——纯 file-scoped 约束
  });

  // PreToolUse 信封——永远放行，只注入上下文。
  console.log(b.preToolUseEnvelope(text));
}

/** 读 process.stdin 全文（hook 协议）。非 TTY 才读；TTY 立即返回空串。 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve, reject) => {
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

// ── lore hook install/uninstall ───────────────────────────────────────────────

/**
 * Read a Claude Code settings.json (tolerates missing file → returns {}).
 * Returns { data, raw } where raw is the original file text (for diagnostics).
 * Throws if the file exists but cannot be JSON-parsed.
 */
async function readSettingsJson(settingsPath: string): Promise<{
  data: Record<string, unknown>;
  existed: boolean;
}> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    try {
      return { data: JSON.parse(raw) as Record<string, unknown>, existed: true };
    } catch {
      throw new Error(`${settingsPath}: JSON parse failed — aborting to avoid corruption`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { data: {}, existed: false };
    }
    throw e;
  }
}

/** Atomic write: write to tmp then rename. */
async function writeSettingsJson(settingsPath: string, data: unknown): Promise<void> {
  const tmp = settingsPath + '.lore-tmp-' + Date.now().toString(36);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, settingsPath);
}

/** The command string injected into Stop hooks. */
function hookCommand(repoPath: string): string {
  return `npx -y lore scan --repo ${repoPath} --broad --no-graph >/dev/null 2>&1 || true`;
}

/**
 * 解析「跑 lore CLI」的命令前缀，用于 SessionStart/PreToolUse 钩子。
 *
 * 性能要求：钩子在每次 session 启动 / 每次 Edit 前都跑，启动延迟敏感。
 * 优先用 `node <绝对 dist/cli.js>`（零 npx 解析延迟）；若当前进程不是从 dist 跑的
 * （如开发态 tsx），退回 `npx -y lore`（保证可用，牺牲启动速度）。
 *
 * 解析逻辑：import.meta.url 指向正在执行的 cli 文件。生产态它是 .../dist/cli.js；
 * 开发态（tsx）是 .../src/cli.ts。仅当落在一个名为 dist 的目录且是 .js 时，才信任
 * 它作为 `node <path>` 的目标。
 */
function loreRunPrefix(): string {
  try {
    const self = fileURLToPath(import.meta.url);
    const real = _resolveReal(self);
    // 只有当真实路径是 dist 下的 .js 才用 node 直跑（最快）。
    if (real.endsWith('.js') && real.split(path.sep).includes('dist')) {
      return `node ${real}`;
    }
  } catch {
    // 落到 npx 兜底。
  }
  return 'npx -y lore';
}

/** SessionStart 钩子命令：注入项目简报（hook-json 信封）。 */
function sessionStartCommand(repoPath: string): string {
  return `${loreRunPrefix()} brief --repo ${repoPath} --format hook-json 2>/dev/null || true`;
}

/** PreToolUse 钩子命令：注入被编辑文件的相关约束（绝不 block）。 */
function preToolUseCommand(repoPath: string): string {
  return `${loreRunPrefix()} guard --hook --repo ${repoPath} 2>/dev/null || true`;
}

interface HookEntry {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

/** PreToolUse 钩子的 matcher：仅在写文件类工具上触发。 */
const GUARD_MATCHER = 'Edit|Write|MultiEdit';

/**
 * 三钩规格：event → { matcher, command }。install/uninstall 共用同一份清单，
 * 保证两端对称（uninstall 移除的正是 install 装的）。
 */
function hookSpecs(repoPath: string): {
  event: string;
  matcher: string;
  command: string;
}[] {
  return [
    { event: 'SessionStart', matcher: '', command: sessionStartCommand(repoPath) },
    { event: 'PreToolUse', matcher: GUARD_MATCHER, command: preToolUseCommand(repoPath) },
    { event: 'Stop', matcher: '', command: hookCommand(repoPath) },
  ];
}

/**
 * 把一条 (event, matcher, command) 幂等地装进 settings.hooks。
 * 返回 true=新装，false=已存在（按 command 字面相等判定，不重复追加）。
 *
 * 注意：guard/brief 命令含 loreRunPrefix()（可能是绝对 node 路径），幂等判定按
 * 完整 command 字符串相等。若 dist 路径变了（如 npm 全局升级），旧 command 不匹配，
 * 会并存——uninstall 用「event+repo 关键片段」宽松匹配清掉残留（见 removeHookSpec）。
 */
function installHookSpec(
  hooks: Record<string, unknown>,
  event: string,
  matcher: string,
  command: string,
): boolean {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  const list = hooks[event] as HookMatcher[];
  const exists = list.some(
    (m) => Array.isArray(m.hooks) && m.hooks.some((h) => h.command === command),
  );
  if (exists) return false;
  list.push({ matcher, hooks: [{ type: 'command', command }] });
  return true;
}

/**
 * 从 settings.hooks 移除某 event 下属于本 repo 的 lore 钩子。
 * 宽松匹配：command 同时含 `lore` 关键字 + 该 repoPath，即视为本 repo 的 lore 钩子，
 * 不论前缀是 `node …/dist/cli.js` 还是 `npx -y lore`（容忍升级导致的路径漂移）。
 * 返回移除条数。
 */
function removeHookSpec(
  hooks: Record<string, unknown>,
  event: string,
  repoPath: string,
  subcommand: string,
): number {
  if (!Array.isArray(hooks[event])) return 0;
  const list = hooks[event] as HookMatcher[];
  let removed = 0;
  const filtered = list
    .map((m) => {
      if (!Array.isArray(m.hooks)) return m;
      const kept = m.hooks.filter((h) => {
        const cmd = h.command ?? '';
        const isLoreForRepo =
          cmd.includes('lore') && cmd.includes(repoPath) && cmd.includes(subcommand);
        if (isLoreForRepo) { removed++; return false; }
        return true;
      });
      return { ...m, hooks: kept };
    })
    .filter((m) => Array.isArray(m.hooks) && m.hooks.length > 0);
  hooks[event] = filtered;
  return removed;
}

/** 解析 install/uninstall 的 settings.json 路径（--global → ~/.claude）。 */
function resolveSettingsPath(repoPath: string, global?: boolean): string {
  if (global) {
    const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
    if (!homeDir) {
      console.error(`${red('Error:')} cannot determine home directory for --global flag`);
      process.exit(1);
    }
    return path.join(homeDir, '.claude', 'settings.json');
  }
  return path.join(repoPath, '.claude', 'settings.json');
}

async function cmdHookInstall(opts: { repo: string; global?: boolean }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const settingsPath = resolveSettingsPath(repoPath, opts.global);

  let data: Record<string, unknown>;
  try {
    const result = await readSettingsJson(settingsPath);
    data = result.data;
  } catch (e) {
    console.error(`${red('Error:')} ${String(e)}`);
    process.exit(1);
  }

  // hooks 对象——缺则建，其它 key 不动。
  if (typeof data['hooks'] !== 'object' || data['hooks'] === null) {
    data['hooks'] = {};
  }
  const hooks = data['hooks'] as Record<string, unknown>;

  // 三钩幂等安装：SessionStart(brief) + PreToolUse(guard) + Stop(scan refresh)。
  const specs = hookSpecs(repoPath);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const spec of specs) {
    const added = installHookSpec(hooks, spec.event, spec.matcher, spec.command);
    if (added) installed.push(spec.event);
    else skipped.push(spec.event);
  }

  if (installed.length === 0) {
    console.log(`${dim('–')} all hooks already installed in: ${settingsPath}`);
    console.log(`  (SessionStart + PreToolUse + Stop present — no changes made)`);
    return;
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  try {
    await writeSettingsJson(settingsPath, data);
  } catch (e) {
    console.error(`${red('Error:')} failed to write ${settingsPath}: ${String(e)}`);
    process.exit(1);
  }

  console.log(`${green('✓')} lore hooks installed: ${settingsPath}`);
  console.log(`  ${green('SessionStart')} → inject project-memory brief at session start`);
  console.log(`  ${green('PreToolUse')}   → inject file constraints before Edit/Write/MultiEdit`);
  console.log(`  ${green('Stop')}         → auto-refresh lore index at session end`);
  console.log(`  repo: ${repoPath}`);
  if (skipped.length > 0) {
    console.log(`  ${dim('(' + skipped.join(', ') + ' already present)')}`);
  }
}

async function cmdHookUninstall(opts: { repo: string; global?: boolean }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const settingsPath = resolveSettingsPath(repoPath, opts.global);

  let data: Record<string, unknown>;
  let existed: boolean;
  try {
    const result = await readSettingsJson(settingsPath);
    data = result.data;
    existed = result.existed;
  } catch (e) {
    console.error(`${red('Error:')} ${String(e)}`);
    process.exit(1);
  }

  if (!existed) {
    console.log(`${dim('–')} settings file not found: ${settingsPath}  (nothing to remove)`);
    return;
  }

  const hooksObj = data['hooks'];
  if (typeof hooksObj !== 'object' || hooksObj === null) {
    console.log(`${dim('–')} no hooks found in: ${settingsPath}  (nothing to remove)`);
    return;
  }
  const hooks = hooksObj as Record<string, unknown>;

  // 三钩全移除（按 event + repo + 子命令宽松匹配，容忍前缀路径漂移）。
  let removed = 0;
  removed += removeHookSpec(hooks, 'SessionStart', repoPath, 'brief');
  removed += removeHookSpec(hooks, 'PreToolUse', repoPath, 'guard');
  removed += removeHookSpec(hooks, 'Stop', repoPath, 'scan');

  if (removed === 0) {
    console.log(`${dim('–')} no lore hooks found in: ${settingsPath}  (nothing to remove)`);
    return;
  }

  try {
    await writeSettingsJson(settingsPath, data);
  } catch (e) {
    console.error(`${red('Error:')} failed to write ${settingsPath}: ${String(e)}`);
    process.exit(1);
  }

  console.log(`${green('✓')} lore hooks removed from: ${settingsPath}  (${removed} hook${removed === 1 ? '' : 's'})`);
  console.log(`  Push-based memory + auto-refresh for ${repoPath} is now disabled.`);
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
  .option('--json', 'output structured JSON to stdout (progress goes to stderr)')
  .action((opts: { repo: string; maxCommits?: number; broad?: boolean; graph?: boolean; json?: boolean }) => {
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
  .option('--json', 'output structured JSON (MatchCandidate[] + excerpts) to stdout')
  .action((opts: { repo: string; n: string; tier?: string; json?: boolean }) => {
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
  .option('--json', 'output RunDistillStats as JSON to stdout')
  .action((opts: { repo: string; maxSessions?: number; json?: boolean }) => {
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
  .option('--file <path>', 'only return notes attached to this file (e.g. before editing it)')
  .option('--json', 'output raw AskResult as JSON instead of human-readable text')
  .action((question: string, opts: { repo: string; includeSuperseded?: boolean; json?: boolean; file?: string }) => {
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
  .command('note')
  .description('Manually record a Decision, Constraint, or RejectedApproach note to .lore/notes.json')
  .requiredOption('--repo <path>', 'path to the git repository')
  .requiredOption('--kind <kind>', 'note kind: decision | constraint | rejected-approach')
  .requiredOption('--title <text>', 'one-sentence title (≤80 chars)')
  .requiredOption('--body <text>', '2-4 sentence body explaining the why')
  .option('--files <paths>', 'comma-separated repo-relative file paths')
  .option('--supersedes <id>', 'id of the note this supersedes')
  .option('--source <source>', 'source: agent | human (default: human)', 'human')
  .option('--json', 'output {schemaVersion, id, updated, superseded} as JSON')
  .action((opts: {
    repo: string; kind: string; title: string; body: string;
    files?: string; supersedes?: string; source?: string; json?: boolean;
  }) => {
    cmdNote(opts).then(
      () => process.exit(0),
      (e) => {
        console.error(red('note failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('status')
  .description('Show lore data freshness, coverage, and notes summary for a repo')
  .option('--repo <path>', 'path to the git repository (default: cwd)', '.')
  .option('--json', 'output structured status JSON')
  .action((opts: { repo: string; json?: boolean }) => {
    cmdStatus(opts).then(
      () => process.exit(0),
      (e) => {
        console.error(red('status failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('brief')
  .description(
    'Print a compact project-memory brief (freshness + active notes by kind + a one-line usage hint). ' +
    'Designed for SessionStart hook injection — reads only .lore/*.json, no engine load (<150ms).',
  )
  .option('--repo <path>', 'path to the git repository (default: cwd)', '.')
  .option('--file <path>', 'only output constraints relevant to this file')
  .option('--format <fmt>', 'output format: text | hook-json (SessionStart additionalContext envelope)', 'text')
  .action((opts: { repo: string; file?: string; format?: string }) => {
    cmdBrief(opts).then(
      () => process.exit(0),
      (e) => {
        console.error(red('brief failed:'), e);
        process.exit(1);
      },
    );
  });

program
  .command('guard')
  .description(
    'PreToolUse hook: read a Claude Code hook-protocol JSON on stdin, find active constraints for the ' +
    'edited file, and inject them as additionalContext. Never blocks a tool call. Silent on any error.',
  )
  .option('--repo <path>', 'path to the git repository (default: hook cwd, else .)', '.')
  .option('--hook', 'PreToolUse hook mode (read stdin, emit additionalContext envelope)')
  .action((opts: { repo: string; hook?: boolean }) => {
    // 容错铁律：guard 绝不让钩子搞挂 session。任何失败一律静默 exit 0。
    cmdGuard(opts).then(
      () => process.exit(0),
      () => process.exit(0), // 失败也 exit 0——钩子绝不报错
    );
  });

const hookCmd = program
  .command('hook')
  .description('Manage Claude Code hooks that push lore memory into agents and auto-refresh the index');

hookCmd
  .command('install')
  .description(
    'Install three Claude Code hooks into <repo>/.claude/settings.json (or ~/.claude with --global): ' +
    'SessionStart (inject project-memory brief), PreToolUse (inject file constraints before Edit/Write/MultiEdit), ' +
    'Stop (auto-refresh the lore index). Idempotent — safe to run multiple times.',
  )
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--global', 'install into ~/.claude/settings.json instead of <repo>/.claude/settings.json')
  .action((opts: { repo: string; global?: boolean }) => {
    cmdHookInstall(opts).then(
      () => process.exit(0),
      (e) => {
        console.error(red('hook install failed:'), e);
        process.exit(1);
      },
    );
  });

hookCmd
  .command('uninstall')
  .description('Remove all three lore hooks (SessionStart + PreToolUse + Stop) from settings.json (reverse of hook install)')
  .requiredOption('--repo <path>', 'path to the git repository')
  .option('--global', 'remove from ~/.claude/settings.json instead of <repo>/.claude/settings.json')
  .action((opts: { repo: string; global?: boolean }) => {
    cmdHookUninstall(opts).then(
      () => process.exit(0),
      (e) => {
        console.error(red('hook uninstall failed:'), e);
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
