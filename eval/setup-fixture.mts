#!/usr/bin/env tsx
/**
 * eval/setup-fixture.mts — North-star eval fixture generator.
 *
 * Builds a small, real, compilable TypeScript git repo in a tmpdir, then plants
 * a `.lore/` index (notes.json + report.json + excerpts.json + a transcript)
 * so that the lore MCP tools (lore_status / lore_ask / lore_why) work against it.
 *
 * The notes encode 6 SPECIFIC, decidable project constraints. The companion task
 * set (tasks.json) is authored so each task's *natural* solution violates exactly
 * one planted note — letting us measure, objectively, whether a lore-equipped
 * agent obeys constraints more than an unequipped one.
 *
 * Usage:
 *   tsx eval/setup-fixture.mts [--out <dir>]
 *     --out <dir>   Where to build the fixture (default: a fresh mkdtemp dir).
 *                   The resolved path is printed as the LAST stdout line so the
 *                   runner can capture it.
 *
 * Idempotent: if --out exists it is removed and rebuilt.
 *
 * Does NOT touch src/ and is NOT part of the npm package (files whitelist is
 * dist/README/LICENSE only).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── arg parsing ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { out?: string } {
  const out: { out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out.out = argv[++i];
    }
  }
  return out;
}

// ── source skeleton (4–6 real, compilable TS files) ────────────────────────────

/**
 * Each file is a believable slice of a small event-driven TS service.
 *
 * IMPORTANT (eval integrity): these source files describe WHAT each module does,
 * but they deliberately do NOT editorialize about which approach is mandated or
 * which was rejected. The "you must use the bus / no polling / no raw fetch /
 * config via the schema / ids via newId" knowledge lives ONLY in .lore/notes.json,
 * which only the treatment arm can see. If a source comment leaked the constraint,
 * the control arm could comply without lore and the experiment would be void.
 *
 * No package.json / tsconfig.json is shipped on purpose: their presence tempts an
 * agent with Bash access to run `npm install` and pollute the diff with
 * node_modules. The compliant module surfaces (bus/config/http-client/ids) still
 * exist and are importable; we never actually run tsc in the agent's repo copy.
 */
const SOURCE_FILES: Record<string, string> = {
  // node_modules must never enter a diff even if an agent installs something.
  '.gitignore': 'node_modules/\n*.log\n',

  // README gives the agent orientation WITHOUT prescribing approaches.
  'README.md': `# acme-svc

A small event-driven TypeScript service. Modules under \`src/\`:

- \`bus.ts\` — a tiny pub/sub event bus (\`on\` / \`emit\`).
- \`config.ts\` — typed configuration access (\`get\` / \`load\` / \`reload\`).
- \`http/client.ts\` — an HTTP helper with timeout + retry (\`request\` / \`getJson\`).
- \`ids.ts\` — id helpers (\`newId\` / \`isValidId\`).
- \`watcher.ts\` — file watcher that signals changes.
- \`cache.ts\` — in-memory TTL cache.
`,

  // ── the event bus ─────────────────────────────────────────────────────────────
  'src/bus.ts': `/**
 * A small pub/sub event bus.
 *
 * Modules can subscribe to named events with on() and broadcast with emit().
 */

export type EventName = 'file-changed' | 'config-reloaded' | 'cache-invalidated';

type Handler = (payload: unknown) => void;

const handlers = new Map<EventName, Set<Handler>>();

/** Subscribe to an event. Returns an unsubscribe function. */
export function on(event: EventName, handler: Handler): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

/** Publish an event to all subscribers. */
export function emit(event: EventName, payload: unknown): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const h of set) h(payload);
}
`,

  // ── config ────────────────────────────────────────────────────────────────────
  'src/config.ts': `/**
 * Typed configuration access.
 *
 * \`schema\` maps each known key to a parser/validator; \`load()\` reads them all
 * from the environment once and caches; \`get(key)\` returns one validated value.
 */

import { emit } from './bus.js';

export interface ConfigSchema {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  refreshMs: number;
}

const schema: { [K in keyof ConfigSchema]: (raw: string | undefined) => ConfigSchema[K] } = {
  port: (raw) => (raw ? parseInt(raw, 10) : 8080),
  logLevel: (raw) => {
    const v = raw ?? 'info';
    if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
    throw new Error(\`invalid logLevel: \${v}\`);
  },
  refreshMs: (raw) => (raw ? parseInt(raw, 10) : 1000),
};

let cache: ConfigSchema | null = null;

/** Load + validate the whole config from the environment. Idempotent. */
export function load(): ConfigSchema {
  if (cache) return cache;
  cache = {
    port: schema.port(process.env.PORT),
    logLevel: schema.logLevel(process.env.LOG_LEVEL),
    refreshMs: schema.refreshMs(process.env.REFRESH_MS),
  };
  return cache;
}

/** Read a single validated config value. */
export function get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
  return load()[key];
}

/** Force a reload (e.g. after the env changes) and announce it on the bus. */
export function reload(): ConfigSchema {
  cache = null;
  const next = load();
  emit('config-reloaded', next);
  return next;
}
`,

  // ── the HTTP client helper ────────────────────────────────────────────────────
  'src/http/client.ts': `/**
 * An HTTP helper built on fetch, adding a per-attempt timeout and bounded
 * retry-with-backoff. \`request()\` returns the Response; \`getJson()\` parses JSON.
 */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /** Per-attempt timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Max attempts including the first (default 3). */
  retries?: number;
}

/** Perform an HTTP request with timeout + bounded retry/backoff. */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // exponential backoff before the next attempt
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
  throw new Error(\`request failed after \${retries} attempts: \${String(lastErr)}\`);
}

/** Convenience JSON GET built on \`request\`. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await request(url, { method: 'GET' });
  return (await res.json()) as T;
}
`,

  // ── id helper ─────────────────────────────────────────────────────────────────
  'src/ids.ts': `/**
 * Identifier helpers. \`newId()\` returns a fresh id; \`isValidId()\` checks shape.
 */

import { randomUUID } from 'node:crypto';

/** Generate a fresh, collision-resistant, URL-safe id. */
export function newId(): string {
  return randomUUID();
}

/** Validate that a string is a well-formed id produced by newId(). */
export function isValidId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}
`,

  // ── the watcher (stub seam for the eval task) ─────────────────────────────────
  'src/watcher.ts': `/**
 * File watcher. Tracks a set of watched paths and signals when one changes via
 * notifyChanged(). Automatic change detection is not wired up yet.
 */

import { emit } from './bus.js';

const watched = new Set<string>();

/** Register a path to be watched for changes. */
export function watch(filePath: string): void {
  watched.add(filePath);
}

/** Stop watching a path. */
export function unwatch(filePath: string): void {
  watched.delete(filePath);
}

/** Currently-watched paths (snapshot). */
export function watchedPaths(): string[] {
  return [...watched];
}

/** Call this when a change is detected for \`filePath\`. */
export function notifyChanged(filePath: string): void {
  emit('file-changed', { path: filePath });
}
`,

  // ── cache (TTL; invalidation seam for the eval task) ──────────────────────────
  'src/cache.ts': `/**
 * In-memory cache with a per-entry TTL. Values expire lazily on read, and the
 * cache clears itself when it sees a 'config-reloaded' event on the bus.
 */

import { on } from './bus.js';

interface Entry {
  value: unknown;
  /** epoch ms after which the entry is considered stale. */
  expiresAt: number;
}

const store = new Map<string, Entry>();

/** Put a value with a TTL (ms). */
export function set(key: string, value: unknown, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Get a value, or undefined if missing or expired (lazy expiry on read). */
export function get(key: string): unknown {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return e.value;
}

/** Drop a single key. */
export function invalidate(key: string): void {
  store.delete(key);
}

on('config-reloaded', () => store.clear());
`,
};

// ── the planted notes (look like real distilled output, with WHY in the body) ──

interface PlantedNote {
  id: string;
  kind: 'decision' | 'constraint' | 'rejected-approach';
  title: string;
  body: string;
  files: string[];
}

const SESSION_ID = 'eval-fixture-sess-0001';

const PLANTED_NOTES: PlantedNote[] = [
  {
    id: `${SESSION_ID}#1`,
    kind: 'rejected-approach',
    title: 'No polling for change detection — use the src/bus.ts event bridge',
    body:
      'File-change auto-refresh must publish onto the event bus in src/bus.ts ' +
      '(emit("file-changed", ...)). A setInterval/setTimeout polling loop that ' +
      're-stats files on a wall-clock tick was tried and rejected: it pinned a CPU ' +
      'core at idle on large trees and added refresh latency equal to the poll ' +
      'interval. Reactive bus events are both cheaper and lower-latency.',
    files: ['src/watcher.ts', 'src/bus.ts'],
  },
  {
    id: `${SESSION_ID}#2`,
    kind: 'constraint',
    title: 'All outbound HTTP must go through src/http/client.ts (no raw fetch)',
    body:
      'Every outbound HTTP call must use request()/getJson() from src/http/client.ts, ' +
      'which centralises per-attempt timeout and bounded retry-with-backoff. Calling ' +
      'the global fetch() directly at any other call site is forbidden — such calls ' +
      'can hang forever and die on the first transient network blip, which is exactly ' +
      'the failure mode the wrapper exists to prevent.',
    files: ['src/http/client.ts'],
  },
  {
    id: `${SESSION_ID}#3`,
    kind: 'decision',
    title: 'Config is read only via src/config.ts get(); new keys go through the schema',
    body:
      'Configuration is read and validated in exactly one place: src/config.ts. New ' +
      'config keys must be added to the schema map and read via get()/load(), so they ' +
      'are validated and defaulted on load. Reading process.env.* directly from other ' +
      'modules is forbidden because it silently bypasses validation and the default ' +
      'values, producing NaN/undefined bugs far from the real cause.',
    files: ['src/config.ts'],
  },
  {
    id: `${SESSION_ID}#4`,
    kind: 'constraint',
    title: 'Generate ids with newId() (crypto.randomUUID) — never Math.random()',
    body:
      'All new entity ids must come from newId() in src/ids.ts, which wraps ' +
      'crypto.randomUUID(). Math.random()-based id schemes were rejected: they are ' +
      'not collision-resistant under concurrent load and are not URL-safe without ' +
      'extra encoding. Do not hand-roll an id from Math.random() or Date.now().',
    files: ['src/ids.ts'],
  },
  {
    id: `${SESSION_ID}#5`,
    kind: 'rejected-approach',
    title: 'Cache invalidation is bus-driven — no background setInterval sweeper',
    body:
      'The cache (src/cache.ts) invalidates entries reactively by subscribing to bus ' +
      'events, plus lazy expiry on read. A background setInterval sweep that walks the ' +
      'whole map every N seconds to evict expired entries was rejected: it wakes the ' +
      'event loop continuously even when the cache is idle and scales with map size, ' +
      'not with actual access. Rely on lazy expiry + bus events instead.',
    files: ['src/cache.ts', 'src/bus.ts'],
  },
  {
    id: `${SESSION_ID}#6`,
    kind: 'decision',
    title: 'Cross-module change signals go through the bus, not direct imports/calls',
    body:
      'When one module needs to react to another module changing state (file changed, ' +
      'config reloaded, cache needs clearing), it must publish/subscribe via the event ' +
      'bus in src/bus.ts rather than importing the other module and calling it ' +
      'directly. Direct calls were creating tight coupling and import cycles; the bus ' +
      'keeps producers and consumers decoupled.',
    files: ['src/bus.ts'],
  },
];

// ── transcript (Claude Code jsonl) — gives lore_ask a real message index ───────

/**
 * A believable distillation-source transcript: user asks to build the service,
 * assistant records the decisions. This is what the notes were "distilled" from.
 * The ask engine re-parses it for the RAW CONVERSATION fallback zone.
 */
function buildTranscript(repoDir: string): { path: string; sessionId: string } {
  const ts = '2026-06-10T09:00:00.000Z';
  const lines: object[] = [];
  const userMsgs = [
    'Set up the acme-svc skeleton: an event bus, schema-validated config, and an ' +
      'HTTP client wrapper with timeout and retry. Wire the file watcher and cache to the bus.',
    'For the file watcher, do NOT poll with setInterval — that pinned a CPU core in ' +
      'the prototype. Publish file-changed on the bus instead.',
    'All outbound HTTP has to go through src/http/client.ts so we get timeout + retry ' +
      'in one place. No raw fetch anywhere else.',
    'Read config only through src/config.ts get(); new keys must go through the schema ' +
      'so they are validated. Do not read process.env directly elsewhere.',
    'Use crypto.randomUUID via newId() for ids; the Math.random scheme had collisions.',
    'Cache invalidation should be bus-driven with lazy expiry — no background sweeper interval.',
  ];
  const asstMsgs = [
    'Done. Created src/bus.ts (on/emit), src/config.ts (schema + get/load/reload), and ' +
      'src/http/client.ts (request/getJson with timeout + bounded retry).',
    'Understood — recorded "no polling, use the bus" as a rejected-approach. watcher ' +
      'now calls emit("file-changed").',
    'Recorded the constraint: all outbound HTTP via src/http/client.ts, no direct fetch.',
    'Recorded the decision: config via src/config.ts get(), new keys through the schema.',
    'Recorded: ids via newId() (crypto.randomUUID), Math.random rejected.',
    'Recorded: cache invalidation is bus-driven + lazy expiry, no setInterval sweeper.',
  ];
  let seq = 0;
  for (let i = 0; i < userMsgs.length; i++) {
    seq++;
    lines.push({
      type: 'user',
      uuid: `u-${seq}`,
      sessionId: SESSION_ID,
      cwd: repoDir,
      isMeta: false,
      timestamp: ts,
      message: { role: 'user', content: userMsgs[i] },
    });
    seq++;
    lines.push({
      type: 'assistant',
      uuid: `a-${seq}`,
      sessionId: SESSION_ID,
      cwd: repoDir,
      timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text: asstMsgs[i] }] },
    });
  }
  // Keep the transcript inside the repo so the ask engine's repo-ownership filter
  // (sourcePathBelongsToRepo) accepts it without depending on ~/.claude layout.
  const transcriptPath = path.join(repoDir, '.lore', `${SESSION_ID}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return { path: transcriptPath, sessionId: SESSION_ID };
}

// ── .lore artifacts ────────────────────────────────────────────────────────────

function writeNotesJson(loreDir: string): void {
  const validAt = '2026-06-10T09:00:00.000Z';
  const notes = PLANTED_NOTES.map((n, i) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    files: n.files,
    anchors: [{ sessionId: SESSION_ID, seq: i * 2 + 1 }],
    sessionId: SESSION_ID,
    validAt,
    invalidAt: null,
    supersededBy: null,
    source: 'distilled' as const,
  }));
  const notesFile = {
    schemaVersion: 1,
    distilledSessions: { [SESSION_ID]: 'fixture-hash' },
    notes,
    distilledAt: validAt,
  };
  fs.writeFileSync(path.join(loreDir, 'notes.json'), JSON.stringify(notesFile, null, 2) + '\n', 'utf8');
}

/**
 * Write a minimal-but-valid report.json. Shapes required by the consumers:
 *   - ask engine: sessionSourceMap (sid → transcript path)
 *   - mcp freshness header / status: generatedAt, commitsTotal,
 *     commitsMatchedStrong/Weak, sessionsSeen/Contributing, window
 */
function writeReportJson(loreDir: string, repoDir: string, transcriptPath: string): void {
  const report = {
    repo: repoDir,
    generatedAt: '2026-06-10T09:05:00.000Z',
    schemaVersion: 1,
    commitsTotal: 1,
    commitsMatchedStrong: 1,
    commitsMatchedWeak: 0,
    sessionsSeen: 1,
    sessionsContributing: 1,
    window: { start: '2026-06-10T08:58:00.000Z', end: '2026-06-10T09:02:00.000Z' },
    commitsInWindow: 1,
    strongInWindow: 1,
    weakInWindow: 0,
    matches: [],
    unmatchedCommits: [],
    sessionSourceMap: { [SESSION_ID]: transcriptPath },
    skippedBySession: { [SESSION_ID]: { count: 0, samples: [] } },
  };
  fs.writeFileSync(path.join(loreDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

/** Minimal excerpts.json so the viewer/why-snapshot path has a valid file. */
function writeExcerptsJson(loreDir: string): void {
  fs.writeFileSync(path.join(loreDir, 'excerpts.json'), JSON.stringify({}, null, 2) + '\n', 'utf8');
}

// ── CLAUDE.md — lore guidance section (treatment arm reads this) ───────────────

/**
 * The lore-aware CLAUDE.md. Mirrors what `lore init` injects: it tells the agent
 * the lore MCP tools exist and WHEN to call them. Kept inside markers so it is
 * unambiguous which text is the "lore section".
 */
const CLAUDE_MD_LORE = `# acme-svc

A small event-driven TypeScript service.

## Engineering conventions

- TypeScript strict mode; keep modules small and single-purpose.
- Prefer composition over inheritance; avoid global mutable state beyond the
  documented singletons (bus, config cache).
- Write code that compiles under \`npm run build\` (tsc --noEmit).

## lore — AI-conversation ↔ commit traceability

<!-- lore:start -->
This repo is indexed by **lore**. Prior design decisions, hard constraints, and
rejected approaches are recorded as distilled notes. The lore MCP tools expose them.

**When to use lore (trigger moments):**

1. **At task start — read the trust/coverage snapshot:** call \`lore_status\`.
2. **Before proposing or implementing a design/approach:** call \`lore_ask\` with a
   natural-language question (e.g. "how should file-change refresh work?"). It returns
   distilled decisions / constraints / rejected-approaches you must respect.
3. **Before editing a file you do not fully understand:** call \`lore_why\` (file, line)
   or \`lore_ask\` scoped to that file.
4. **After making an important decision or rejecting an approach:** record it with
   \`lore_note\`.

Distilled notes encode prior decisions — respect them. A "rejected-approach" note means
that approach was already tried and found wanting; do not re-introduce it.
<!-- lore:end -->
`;

// ── CLAUDE.md — control (same volume, generic engineering only, NO lore) ───────

const CLAUDE_MD_CONTROL = `# acme-svc

A small event-driven TypeScript service.

## Engineering conventions

- TypeScript strict mode; keep modules small and single-purpose.
- Prefer composition over inheritance; avoid global mutable state beyond the
  documented singletons (bus, config cache).
- Write code that compiles under \`npm run build\` (tsc --noEmit).
- Reuse existing helpers and module surfaces rather than re-implementing them;
  scan the relevant src/ file before adding a new one.
- Keep changes minimal and focused on the task; do not refactor unrelated code.
- Match the surrounding code style and existing patterns in the file you edit.
`;

// ── main ───────────────────────────────────────────────────────────────────────

function git(repoDir: string, args: string[]): void {
  execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
}

function main(): void {
  const { out } = parseArgs(process.argv.slice(2));
  const repoDir = out
    ? path.resolve(out)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'lore-eval-fixture-'));

  // Idempotent: wipe + rebuild.
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });

  // 1. Write source skeleton.
  for (const [rel, content] of Object.entries(SOURCE_FILES)) {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  // 2. git init + a single commit (so lore_why / git-root resolution work).
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'eval@lore.local']);
  git(repoDir, ['config', 'user.name', 'lore-eval']);
  git(repoDir, ['add', '-A']);
  // Deterministic commit env so the fixture is reproducible.
  execFileSync('git', ['-C', repoDir, 'commit', '-q', '-m', 'init: acme-svc skeleton'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-06-10T09:01:00',
      GIT_COMMITTER_DATE: '2026-06-10T09:01:00',
    },
  });

  // 3. Plant .lore/ index.
  const loreDir = path.join(repoDir, '.lore');
  fs.mkdirSync(loreDir, { recursive: true });
  // Safety: never let .lore artifacts be committed (mirrors `lore scan`).
  fs.writeFileSync(path.join(loreDir, '.gitignore'), '*\n', 'utf8');
  const { path: transcriptPath } = buildTranscript(repoDir);
  writeNotesJson(loreDir);
  writeReportJson(loreDir, repoDir, transcriptPath);
  writeExcerptsJson(loreDir);

  // 4. Write BOTH CLAUDE.md variants (the runner copies the right one per arm).
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.lore.md'), CLAUDE_MD_LORE, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.control.md'), CLAUDE_MD_CONTROL, 'utf8');

  // The repo's committed CLAUDE.md is NOT present (we did the commit before
  // writing these); the runner places the per-arm CLAUDE.md fresh each task.

  // Print the resolved repo path as the LAST line for the runner to capture.
  process.stdout.write(`fixture built at:\n${repoDir}\n`);
}

main();
