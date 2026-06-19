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
import type { MatchEngine, RepoMatchReport } from './match/types.js';
import { renderReport } from './report/markdown.js';
import type { GraphStore } from './graph/types.js';
import type { WhyEngine, WhyOptions, WhyResult } from './why/types.js';
import type { AskEngine } from './ask/types.js';
import type { Distiller } from './distill/types.js';
import { green, blue, yellow, red, dim, bold } from './cli/ui.js';
import {
  renderSummaryBox,
  renderWhyResult,
  renderFileHistory,
  renderAskResult,
} from './cli/render.js';
import { staleness } from './cli/staleness.js';

export { green, blue, yellow, red, dim, bold } from './cli/ui.js';
export {
  renderSummaryBox,
  renderWhyResult,
  renderFileHistory,
  renderAskResult,
  renderStatusCard,
} from './cli/render.js';
export { injectLoreSection } from './cli/inject.js';
export { staleness } from './cli/staleness.js';

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

/**
 * 消息索引固化：scan 把所有 session 的 user-message 抽到 .lore/messages.json，
 * 让后续 `lore ask` 不必每次都重 parse 全部 transcript。失败仅警告，不阻塞 scan。
 */
async function loadMessagesIndexer(): Promise<{
  computeMessagesIndex: typeof import('./messages/index.js').computeMessagesIndex;
  computeMessagesIndexFromSessions: typeof import('./messages/index.js').computeMessagesIndexFromSessions;
  writeMessagesIndex: typeof import('./messages/index.js').writeMessagesIndex;
}> {
  const mod = await import('./messages/index.js');
  return {
    computeMessagesIndex: mod.computeMessagesIndex,
    computeMessagesIndexFromSessions: mod.computeMessagesIndexFromSessions,
    writeMessagesIndex: mod.writeMessagesIndex,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): number {
  return performance.now();
}

/** Read package.json version at runtime so CLI help never drifts from npm metadata. */
function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Works in both dev (src/cli.ts -> ../package.json) and dist (dist/cli.js -> ../package.json).
    const pkgPath = path.resolve(here, '..', 'package.json');
    const raw = fssync.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function elapsed(start: number): string {
  return ((performance.now() - start) / 1000).toFixed(2) + 's';
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

  // 6.6 Messages index：固化 user-message 索引到 .lore/messages.json，让 `lore ask`
  //     的 raw-conversation fallback 不必每次都重 parse 全部 transcript。
  //     输入是已经 parse 过的 sessions——零额外 IO，O(events) 内存。
  {
    const tm = now();
    try {
      const { computeMessagesIndexFromSessions, writeMessagesIndex } = await loadMessagesIndexer();
      // 复用上面已 parse 的 sessions，省一次 parse 全程。
      const entries = computeMessagesIndexFromSessions(repoPath, parseResults.map((r) => r.session));
      await writeMessagesIndex(repoPath, entries);
      progress(
        `${green('✓')} [messages] index ${entries.length} user-messages  ${dim(elapsed(tm))}`,
      );
    } catch (e) {
      progressWarn(`${yellow('⚠')} [messages] index failed (${String(e)})`);
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

  await requireReport(repoPath);

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

// ── Commander wiring ─────────────────────────────────────────────────────────

program
  .name('lore')
  .description(
    'lore — the intent layer for Git.\n' +
    'Link AI agent conversations to the commits they produced,\n' +
    'then query why any line of code was written.\n\n' +
    'Run `lore` (no subcommand) to scan + open the viewer — equivalent to `lore go`.',
  )
  .version(readPackageVersion())
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
    import('./cli/commands/init.js').then(({ cmdInit }) => cmdInit(opts)).then(
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
    import('./cli/commands/sample.js').then(({ cmdSample }) => cmdSample(opts)).then(
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
    import('./cli/commands/note.js').then(({ cmdNote }) => cmdNote(opts)).then(
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
    import('./cli/commands/status.js').then(({ cmdStatus }) => cmdStatus(opts)).then(
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
    import('./cli/commands/memory.js').then(({ cmdBrief }) => cmdBrief(opts)).then(
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
    import('./cli/commands/memory.js').then(({ cmdGuard }) => cmdGuard(opts)).then(
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
    import('./cli/commands/memory.js').then(({ cmdHookInstall }) => cmdHookInstall(opts)).then(
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
    import('./cli/commands/memory.js').then(({ cmdHookUninstall }) => cmdHookUninstall(opts)).then(
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
