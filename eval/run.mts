#!/usr/bin/env tsx
/**
 * eval/run.mts — North-star eval treadmill.
 *
 * For each task in tasks.json, runs TWO arms and a blind judge:
 *
 *   control    — `claude -p` (haiku) in a fresh copy of the fixture repo, with a
 *                generic-engineering CLAUDE.md (no lore section) and NO MCP. This
 *                is the "agent without project memory" baseline.
 *   treatment  — same prompt + same model, but with the lore MCP server wired in
 *                (--mcp-config) and a CLAUDE.md that contains the lore guidance
 *                section. This is "agent WITH project memory".
 *
 * Both arms edit files directly (bypassPermissions); we capture `git diff` as the
 * artifact. The treatment arm runs with --output-format stream-json so we can see
 * whether it actually CALLED a lore tool (mcp__lore__*).
 *
 * A blind Sonnet judge then scores each diff against the task's ground-truth note:
 * "does this change VIOLATE the constraint <note text>?" → {violated, evidence}.
 * Each diff is judged TWICE; agreement → that verdict, disagreement → disputed.
 *
 * Output: eval/results-<ISO-date>.json with per-task per-arm verdicts + summary.
 *
 * Isolation: every (task, arm) gets its own fresh copy of the fixture (clean git
 * working tree) so diffs never bleed across runs. All temp copies are removed at
 * the end. Does NOT touch src/.
 *
 * Usage:
 *   tsx eval/run.mts [--fixture <dir>] [--tasks <ids>] [--model <m>]
 *                    [--judge-model <m>] [--keep] [--dry-run]
 *     --fixture <dir>   Use an existing fixture instead of building one.
 *     --tasks <ids>     Comma-separated task ids to run (default: all).
 *     --model <m>       Agent model for both arms (default: haiku).
 *     --judge-model <m> Judge model (default: sonnet).
 *     --keep            Do not delete per-run repo copies (for debugging).
 *     --dry-run         Build fixture + print the plan, run nothing.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

// Resolve the claude binary once. PATH in non-login shells may lack it.
function resolveClaude(): string {
  const candidates = [
    process.env.CLAUDE_BIN,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to PATH lookup.
  try {
    return execFileSync('command', ['-v', 'claude'], { shell: '/bin/zsh', encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}
const CLAUDE = resolveClaude();

// ── types ──────────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  groundTruthNoteId: string;
  violatedKind: string;
  targetFiles: string[];
  prompt: string;
  naturalTrap: string;
  compliantSolution: string;
  violationSignals: string[];
  complianceSignals: string[];
}

interface Note {
  id: string;
  kind: string;
  title: string;
  body: string;
  files: string[];
}

type Arm = 'control' | 'treatment';

interface ArmRun {
  arm: Arm;
  diff: string;
  /** lore tool calls observed (treatment only; [] for control). */
  loreToolCalls: string[];
  /** treatment: were mcp__lore__* tools actually exposed at session init? */
  loreAvailable: boolean;
  /** treatment: did the MCP warm-up reach "connected" before the run? */
  mcpWarmed: boolean;
  durationMs: number | null;
  costUSD: number | null;
  numTurns: number | null;
  agentError: boolean;
  /** substring signal scan (cheap, deterministic pre-check; advisory only). */
  signalViolation: boolean;
  signalCompliant: boolean;
}

interface Verdict {
  violated: boolean;
  evidence: string;
}

interface JudgedArm extends ArmRun {
  verdicts: Verdict[];
  violated: boolean | null; // consensus; null when disputed
  disputed: boolean;
}

// ── args ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const out: {
    fixture?: string;
    tasks?: string[];
    model: string;
    judgeModel: string;
    keep: boolean;
    dryRun: boolean;
  } = { model: 'haiku', judgeModel: 'sonnet', keep: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--tasks') out.tasks = argv[++i]!.split(',').map((s) => s.trim());
    else if (a === '--model') out.model = argv[++i]!;
    else if (a === '--judge-model') out.judgeModel = argv[++i]!;
    else if (a === '--keep') out.keep = true;
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

// ── claude invocation ──────────────────────────────────────────────────────────

/**
 * Tools both arms are allowed to use. Kept identical so the ONLY difference
 * between arms is the presence of the lore MCP server + lore CLAUDE.md section.
 * We disallow web/sub-agent/task tools so neither arm can wander off the task.
 */
const DISALLOWED = ['WebFetch', 'WebSearch', 'Task'];

interface ClaudeResult {
  stdoutPath: string;
  durationMs: number | null;
  costUSD: number | null;
  numTurns: number | null;
  agentError: boolean;
  loreToolCalls: string[];
}

/**
 * Run claude headless in `cwd`. Treatment passes an mcpConfigPath; control does not.
 * stream-json is used so we can extract lore tool_use calls and the final envelope.
 */
function runClaude(opts: {
  cwd: string;
  prompt: string;
  model: string;
  mcpConfigPath?: string;
  outPath: string;
  timeoutMs: number;
}): Promise<ClaudeResult> {
  const args = [
    '-p',
    opts.prompt,
    '--permission-mode',
    'bypassPermissions',
    '--model',
    opts.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--disallowedTools',
    ...DISALLOWED,
  ];
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath);
  }

  return new Promise((resolve) => {
    const outFd = fs.openSync(opts.outPath, 'w');
    const child = execFile(
      CLAUDE,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      () => {
        try { fs.closeSync(outFd); } catch { /* ignore */ }
        const parsed = parseStreamJson(opts.outPath);
        resolve(parsed);
      },
    );
    child.stdout?.on('data', (d) => { try { fs.writeSync(outFd, d); } catch { /* ignore */ } });
    // stderr is the MCP server's startup log + claude diagnostics; ignore but drain.
    child.stderr?.on('data', () => { /* drain */ });
  });
}

/** Parse a stream-json transcript: collect lore tool_use names + final envelope. */
function parseStreamJson(outPath: string): ClaudeResult {
  let raw = '';
  try { raw = fs.readFileSync(outPath, 'utf8'); } catch { /* ignore */ }
  const loreToolCalls: string[] = [];
  let durationMs: number | null = null;
  let costUSD: number | null = null;
  let numTurns: number | null = null;
  let agentError = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const b of msg.message.content) {
        if (b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith('mcp__lore__')) {
          loreToolCalls.push(b.name);
        }
      }
    }
    if (msg.type === 'result') {
      durationMs = typeof msg.duration_ms === 'number' ? msg.duration_ms : null;
      costUSD = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null;
      numTurns = typeof msg.num_turns === 'number' ? msg.num_turns : null;
      agentError = msg.is_error === true;
    }
  }
  return { stdoutPath: outPath, durationMs, costUSD, numTurns, agentError, loreToolCalls };
}

// ── git diff capture ─────────────────────────────────────────────────────────

function gitDiff(repoDir: string): string {
  try {
    // Include untracked new files (agents create new modules) via add -N, but
    // never node_modules / logs (the fixture .gitignore excludes them; git
    // honours .gitignore on `add -AN` so an `npm install` cannot pollute the diff).
    execFileSync('git', ['-C', repoDir, 'add', '-AN'], { stdio: 'ignore' });
    const diff = execFileSync(
      'git',
      ['-C', repoDir, 'diff', '--', '.', ':(exclude)node_modules', ':(exclude)package-lock.json'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    return diff;
  } catch {
    return '';
  }
}

// ── signal pre-scan (advisory, deterministic) ──────────────────────────────────

function scanSignals(diff: string, task: Task): { violation: boolean; compliant: boolean } {
  // Only consider ADDED lines (+) so we don't flag deletions of the trap.
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  const violation = task.violationSignals.some((s) => added.includes(s));
  const compliant = task.complianceSignals.some((s) => added.includes(s));
  return { violation, compliant };
}

// ── blind judge ─────────────────────────────────────────────────────────────

const JUDGE_SYSTEM =
  'You are a strict, impartial code reviewer. You judge whether a code diff ' +
  'VIOLATES a single stated project constraint. You do not know which tool or ' +
  'agent produced the diff and must not speculate about it. Judge ONLY the diff ' +
  'against the constraint. Output STRICT JSON only.';

function judgePrompt(note: Note, diff: string): string {
  return [
    'PROJECT CONSTRAINT (a distilled note from the project memory):',
    `  kind: ${note.kind}`,
    `  title: ${note.title}`,
    `  rule: ${note.body}`,
    '',
    'A change was made to the repository. Here is the unified diff:',
    '```diff',
    diff.length > 12000 ? diff.slice(0, 12000) + '\n... (truncated)' : diff,
    '```',
    '',
    'Question: does this diff VIOLATE the constraint above?',
    '- "violated": true  if the change does the forbidden thing / re-introduces the',
    '  rejected approach / ignores the constraint.',
    '- "violated": false if the change respects the constraint (or does not touch the',
    '  area the constraint governs).',
    'If the diff is empty or unrelated to the constraint, answer false.',
    '',
    'Respond with STRICT JSON ONLY, no prose, no code fence:',
    '{"violated": <true|false>, "evidence": "<one sentence quoting the offending or',
    'compliant line>"}',
  ].join('\n');
}

function runJudge(opts: {
  note: Note;
  diff: string;
  model: string;
  timeoutMs: number;
}): Promise<Verdict> {
  const prompt = judgePrompt(opts.note, opts.diff);
  return new Promise((resolve) => {
    execFile(
      CLAUDE,
      [
        '-p',
        prompt,
        '--model',
        opts.model,
        '--append-system-prompt',
        JUDGE_SYSTEM,
        '--output-format',
        'json',
        '--disallowedTools',
        ...DISALLOWED,
        'Edit',
        'Write',
        'Bash',
      ],
      { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (_err, stdout) => {
        resolve(parseJudge(stdout));
      },
    );
  });
}

function parseJudge(stdout: string): Verdict {
  // claude --output-format json wraps the model's text in an envelope { result: "<text>" }.
  let resultText = stdout;
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.result === 'string') resultText = env.result;
  } catch { /* not the envelope — treat stdout as raw */ }
  // Extract the first {...} JSON object from the result text.
  const m = resultText.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      return {
        violated: obj.violated === true,
        evidence: typeof obj.evidence === 'string' ? obj.evidence : '',
      };
    } catch { /* fall through */ }
  }
  return { violated: false, evidence: `UNPARSEABLE_JUDGE_OUTPUT: ${resultText.slice(0, 200)}` };
}

// ── per-(task,arm) execution ───────────────────────────────────────────────────

function makeRepoCopy(fixtureDir: string, label: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `lore-eval-${label}-`));
  // Copy everything including .git and .lore.
  fs.cpSync(fixtureDir, dest, { recursive: true });
  return dest;
}

function writeMcpConfig(repoDir: string): string {
  const cfg = {
    mcpServers: {
      lore: { command: 'node', args: [DIST_CLI, 'mcp', '--repo', repoDir] },
    },
  };
  const p = path.join(os.tmpdir(), `lore-eval-mcp-${path.basename(repoDir)}.json`);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return p;
}

/**
 * Warm the lore MCP server for `repoDir`: spawn it, wait until it prints its
 * "connected" line on stderr (or time out), then kill it. This loads node + the
 * kuzu native module into the OS cache so that when claude spawns the server it
 * reaches "connected" before claude snapshots its tool list — otherwise the very
 * first cold spawn can stay "pending" and the agent never sees the lore tools.
 * Returns true if the server reported connected.
 */
function warmMcp(repoDir: string, timeoutMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('node', [DIST_CLI, 'mcp', '--repo', repoDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stderr?.on('data', (d) => {
      if (String(d).includes('connected')) {
        clearTimeout(timer);
        finish(true);
      }
    });
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('exit', () => { clearTimeout(timer); finish(false); });
  });
}

/** Read the system/init line from a stream-json log: were lore tools exposed? */
function loreToolsExposed(streamPath: string): boolean {
  let raw = '';
  try { raw = fs.readFileSync(streamPath, 'utf8'); } catch { return false; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.tools)) {
      return msg.tools.some((x: string) => typeof x === 'string' && x.startsWith('mcp__lore__'));
    }
  }
  return false;
}

async function runArm(opts: {
  task: Task;
  arm: Arm;
  fixtureDir: string;
  model: string;
  keep: boolean;
  logDir: string;
}): Promise<{ run: ArmRun; repoDir: string }> {
  const { task, arm, fixtureDir, model } = opts;
  const repoDir = makeRepoCopy(fixtureDir, `${task.id}-${arm}`);

  // Place the per-arm CLAUDE.md (treatment = lore section, control = generic only).
  const src = arm === 'treatment' ? 'CLAUDE.lore.md' : 'CLAUDE.control.md';
  fs.copyFileSync(path.join(repoDir, src), path.join(repoDir, 'CLAUDE.md'));
  // Remove the helper variants so the agent doesn't read the "other" one.
  for (const f of ['CLAUDE.lore.md', 'CLAUDE.control.md']) {
    try { fs.rmSync(path.join(repoDir, f)); } catch { /* ignore */ }
  }
  // For treatment, the planted .lore notes must point the MCP at THIS copy. We
  // rewrite report.json's sessionSourceMap + transcript path to the copy dir so
  // lore_ask re-parses the right transcript. (cpSync copied them verbatim with the
  // original fixture path; fix that here.)
  if (arm === 'treatment') retargetLore(repoDir, fixtureDir);

  const outPath = path.join(opts.logDir, `${task.id}-${arm}.stream.jsonl`);
  const mcpConfigPath = arm === 'treatment' ? writeMcpConfig(repoDir) : undefined;

  // Treatment: warm the MCP server first so it is "connected" (not "pending")
  // before claude snapshots its tool list.
  let warmed = false;
  if (arm === 'treatment') {
    warmed = await warmMcp(repoDir);
  }

  const TIMEOUT_MS = 5 * 60 * 1000;
  const res = await runClaude({
    cwd: repoDir,
    prompt: task.prompt,
    model,
    mcpConfigPath,
    outPath,
    timeoutMs: TIMEOUT_MS,
  });

  const diff = gitDiff(repoDir);
  const sig = scanSignals(diff, task);
  const loreAvailable = arm === 'treatment' ? loreToolsExposed(outPath) : false;

  const run: ArmRun = {
    arm,
    diff,
    loreToolCalls: res.loreToolCalls,
    loreAvailable,
    mcpWarmed: warmed,
    durationMs: res.durationMs,
    costUSD: res.costUSD,
    numTurns: res.numTurns,
    agentError: res.agentError,
    signalViolation: sig.violation,
    signalCompliant: sig.compliant,
  };
  return { run, repoDir };
}

/** Rewrite .lore/report.json so its sessionSourceMap points inside the copy. */
function retargetLore(repoDir: string, fixtureDir: string): void {
  const reportPath = path.join(repoDir, '.lore', 'report.json');
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.sessionSourceMap && typeof report.sessionSourceMap === 'object') {
      const next: Record<string, string> = {};
      for (const [sid, p] of Object.entries(report.sessionSourceMap as Record<string, string>)) {
        next[sid] = p.startsWith(fixtureDir) ? path.join(repoDir, path.relative(fixtureDir, p)) : p;
      }
      report.sessionSourceMap = next;
    }
    report.repo = repoDir;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch { /* leave as-is; ask still works off notes.json */ }
}

// ── judging a run twice ────────────────────────────────────────────────────────

async function judgeRun(run: ArmRun, note: Note, judgeModel: string): Promise<JudgedArm> {
  if (!run.diff.trim()) {
    // No change → trivially not a violation; skip judge calls, mark both false.
    const v: Verdict = { violated: false, evidence: 'empty diff (no change made)' };
    return { ...run, verdicts: [v, v], violated: false, disputed: false };
  }
  const TIMEOUT_MS = 3 * 60 * 1000;
  const v1 = await runJudge({ note, diff: run.diff, model: judgeModel, timeoutMs: TIMEOUT_MS });
  const v2 = await runJudge({ note, diff: run.diff, model: judgeModel, timeoutMs: TIMEOUT_MS });
  const agree = v1.violated === v2.violated;
  return {
    ...run,
    verdicts: [v1, v2],
    violated: agree ? v1.violated : null,
    disputed: !agree,
  };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 1. Build (or reuse) the fixture.
  let fixtureDir: string;
  if (args.fixture) {
    fixtureDir = path.resolve(args.fixture);
    console.error(`[run] using existing fixture: ${fixtureDir}`);
  } else {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-eval-fixture-'));
    console.error(`[run] building fixture at ${fixtureDir} …`);
    execFileSync('npx', ['tsx', path.join(__dirname, 'setup-fixture.mts'), '--out', fixtureDir], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
  }

  // 2. Load tasks + notes.
  const taskFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
  let tasks: Task[] = taskFile.tasks;
  if (args.tasks) tasks = tasks.filter((t) => args.tasks!.includes(t.id));
  const notesFile = JSON.parse(fs.readFileSync(path.join(fixtureDir, '.lore', 'notes.json'), 'utf8'));
  const noteById = new Map<string, Note>();
  for (const n of notesFile.notes) noteById.set(n.id, n);

  console.error(`[run] tasks: ${tasks.map((t) => t.id).join(', ')}`);
  console.error(`[run] model=${args.model} judge=${args.judgeModel} claude=${CLAUDE}`);

  if (args.dryRun) {
    console.error('[run] --dry-run: plan only, exiting.');
    for (const t of tasks) {
      const note = noteById.get(t.groundTruthNoteId);
      console.error(`  ${t.id} → violates ${t.groundTruthNoteId} (${note?.kind}): ${note?.title}`);
    }
    return;
  }

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-eval-logs-'));
  console.error(`[run] stream logs → ${logDir}`);

  const results: any[] = [];
  const repoDirsToClean: string[] = [];

  for (const task of tasks) {
    const note = noteById.get(task.groundTruthNoteId);
    if (!note) {
      console.error(`[run] SKIP ${task.id}: ground-truth note ${task.groundTruthNoteId} not found`);
      continue;
    }
    console.error(`\n[run] ── task ${task.id} (violates ${note.kind} "${note.title.slice(0, 40)}…") ──`);

    // Run arms SEQUENTIALLY (avoid hammering the API / rate limits).
    const armRuns: Record<Arm, JudgedArm> = {} as any;
    for (const arm of ['control', 'treatment'] as Arm[]) {
      console.error(`[run]   ${arm}: invoking agent …`);
      const { run, repoDir } = await runArm({
        task,
        arm,
        fixtureDir,
        model: args.model,
        keep: args.keep,
        logDir,
      });
      repoDirsToClean.push(repoDir);
      const toolNote = arm === 'treatment'
        ? ` lore_calls=${run.loreToolCalls.length}`
        : '';
      console.error(
        `[run]   ${arm}: diff=${run.diff.length}B sigV=${run.signalViolation} sigC=${run.signalCompliant}${toolNote} judging …`,
      );
      const judged = await judgeRun(run, note, args.judgeModel);
      armRuns[arm] = judged;
      console.error(
        `[run]   ${arm}: violated=${judged.violated}${judged.disputed ? ' (DISPUTED)' : ''}`,
      );
    }

    results.push({
      taskId: task.id,
      groundTruthNoteId: task.groundTruthNoteId,
      violatedKind: note.kind,
      noteTitle: note.title,
      arms: {
        control: serializeArm(armRuns.control),
        treatment: serializeArm(armRuns.treatment),
      },
    });
  }

  // 3. Summary.
  const summary = summarize(results);

  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(__dirname, `results-${today}.json`);
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: args.model,
    judgeModel: args.judgeModel,
    fixtureDir,
    taskCount: results.length,
    summary,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.error(`\n[run] wrote ${outPath}`);
  console.error(`[run] SUMMARY: ${JSON.stringify(summary, null, 2)}`);

  // 4. Cleanup temp copies (unless --keep).
  if (!args.keep) {
    for (const d of repoDirsToClean) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!args.fixture) {
      try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    console.error('[run] cleaned temp repo copies.');
  } else {
    console.error(`[run] --keep: left ${repoDirsToClean.length} repo copies + logs in ${logDir}`);
  }
}

function serializeArm(a: JudgedArm) {
  return {
    arm: a.arm,
    violated: a.violated,
    disputed: a.disputed,
    verdicts: a.verdicts,
    loreToolCalls: a.loreToolCalls,
    loreToolCallCount: a.loreToolCalls.length,
    durationMs: a.durationMs,
    costUSD: a.costUSD,
    numTurns: a.numTurns,
    agentError: a.agentError,
    signalViolation: a.signalViolation,
    signalCompliant: a.signalCompliant,
    diffBytes: a.diff.length,
    diff: a.diff,
  };
}

function summarize(results: any[]) {
  function rate(arm: Arm) {
    let violated = 0;
    let disputed = 0;
    let decided = 0;
    for (const r of results) {
      const a = r.arms[arm];
      if (a.disputed) { disputed++; continue; }
      decided++;
      if (a.violated === true) violated++;
    }
    return {
      n: results.length,
      decided,
      disputed,
      violations: violated,
      violationRate: decided > 0 ? +(violated / decided).toFixed(3) : null,
    };
  }
  const control = rate('control');
  const treatment = rate('treatment');
  const treatmentLoreCalls = results.filter((r) => r.arms.treatment.loreToolCallCount > 0).length;
  return {
    control,
    treatment,
    treatmentTasksThatCalledLore: treatmentLoreCalls,
    treatmentTaskCount: results.length,
  };
}

main().catch((e) => {
  console.error('[run] FATAL:', e);
  process.exit(1);
});
