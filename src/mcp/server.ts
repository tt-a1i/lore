/**
 * lore MCP server — exposes three tools for agent consumption:
 *
 *   lore_why      {file, line}  → WhyEngine pipeline, compact text
 *   lore_ask      {question}    → AskEngine, top5 notes + top3 message hits
 *   lore_history  {path}        → fileHistory compact timeline
 *
 * Design:
 * - Errors are always caught and returned as isError text — server never crashes.
 * - All output is token-friendly compact text; anchors (sessionId+seq) are preserved.
 * - stdio mode: no stdout logging (would corrupt JSON-RPC); stderr is fine.
 * - zod is the SDK's peer dep (available in node_modules/zod); we import from there.
 *
 * Every tool's output starts with a freshness header so the consuming agent can
 * judge how trustworthy / current the index is:
 *   coverage:<attributed>/<total> · generated:<ISO date> [· stale:<bool>]
 * where attributed = commits with ≥1 match, total = commits scanned, generated =
 * report.json generatedAt, stale = report predates the current git HEAD commit.
 * The header is computed once per server (cached) — git/report reads are not free.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { WhyEngine, WhyResult } from '../why/types.js';
import type { AskEngine, AskResult } from '../ask/types.js';
import type { GraphStore, SessionNodeData } from '../graph/types.js';
import type { NotesStore, NotesFile, DistilledNote } from '../distill/types.js';

const execFileAsync = promisify(execFile);

/** Strong-tier floor: attributions at or above this confidence are "trustworthy". */
const STRONG_FLOOR = 0.8;

/** lore_note abuse guards: a note is a terse留言, not an essay. */
const NOTE_TITLE_MAX = 120;
const NOTE_BODY_MAX = 2000;

// ── session sourcePaths slimming ───────────────────────────────────────────────

/**
 * Slim a session's `sourcePaths` array down to a count + the basename of the
 * primary (first) source, for token-frugal responses. Full absolute paths cost
 * tokens and leak the user's home layout while telling the agent nothing it can
 * act on; `sourceCount` + `primarySource` (basename only) carries the signal.
 */
function slimSession(session: SessionNodeData): {
  sourceCount: number;
  primarySource: string;
} {
  const paths = Array.isArray(session.sourcePaths) ? session.sourcePaths : [];
  const first = paths[0] ?? '';
  // basename: last path segment, tolerating both / and \ separators.
  const primarySource = first ? first.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '' : '';
  return { sourceCount: paths.length, primarySource };
}

// ── compact renderers (token-friendly, no ANSI, deterministic) ────────────────

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/** Collapse a multi-line excerpt body to a single line (newlines → spaces). */
function foldLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Render WhyResult as a compact, token-friendly string for agent consumption.
 *
 * - Strong attribution (confidence ≥ 0.8): unchanged — up to 2 excerpts (≤300
 *   chars each) with their [sessionId+seq] anchors.
 * - Weak attribution (confidence < 0.8, only present when include_weak was set):
 *   the session line is prefixed "⚠ LOW-CONFIDENCE" and the excerpt body is
 *   folded to a single line + anchor (do not invite the agent to trust it).
 *
 * @param header  Optional freshness header prepended as the first line.
 */
function renderWhyCompact(result: WhyResult, header?: string): string {
  const parts: string[] = [];
  if (header) parts.push(header);

  parts.push(`file:${result.file}:${result.line}`);
  parts.push(`commit:${result.commit.hash.slice(0, 12)} ${truncate(result.commit.subject, 80)}`);

  if (result.attributions.length === 0) {
    parts.push('attribution:none');
    if (result.editedBy.length > 0) {
      const hints = result.editedBy
        .slice(0, 3)
        .map((e) => `${e.sessionId.slice(0, 12)} agent=${e.agent} last=${e.lastTs.slice(0, 10)}`)
        .join('; ');
      parts.push(`edited_by:${hints}`);
    }
    return parts.join('\n');
  }

  const attr = result.attributions[0]!;
  const p = attr.produced;
  const isWeak = p.confidence < STRONG_FLOOR;
  const tier = isWeak ? 'weak' : 'strong';
  parts.push(`confidence:${p.confidence.toFixed(3)}(${tier})`);

  // sourcePaths slimmed to count + primary basename (token-frugal, no home leak).
  const slim = slimSession(p.session);
  const srcSeg = slim.sourceCount > 0 ? ` src=${slim.sourceCount}(${slim.primarySource})` : '';
  const sessionLine = `session:${p.sessionId.slice(0, 16)} via=${p.matchedVia} lines=${p.matchedLines}${srcSeg}`;
  parts.push(isWeak ? `⚠ LOW-CONFIDENCE ${sessionLine}` : sessionLine);

  if (isWeak) {
    // Weak: fold to a single excerpt, body collapsed to one line + anchor.
    const ex = attr.excerpts[0];
    if (ex) {
      const anchor = `[${ex.sessionId.slice(0, 8)}+${ex.seq}]`;
      const role = ex.role === 'user' ? 'USER' : 'ASST';
      parts.push(`${anchor} ${role}: ${truncate(foldLine(ex.text), 200)}`);
    }
  } else {
    // Strong: up to 2 excerpts, each ≤300 chars (unchanged behaviour).
    const excerpts = attr.excerpts.slice(0, 2);
    for (const ex of excerpts) {
      const anchor = `[${ex.sessionId.slice(0, 8)}+${ex.seq}]`;
      const role = ex.role === 'user' ? 'USER' : 'ASST';
      parts.push(`${anchor} ${role}: ${truncate(ex.text, 300)}`);
    }
  }

  // anchor for re-lookup
  if (attr.editSeqs.length > 0) {
    parts.push(`anchors:${attr.editSeqs.slice(0, 4).join(',')}`);
  }

  return parts.join('\n');
}

/**
 * Map a note's `source` field to a trust marker. Missing source = 'distilled'
 * (the bi-temporal types.ts law: legacy notes without source are distilled).
 */
function sourceMarker(source: DistilledNote['source']): string {
  return source === 'agent' ? '[agent]' : source === 'human' ? '[human]' : '[distilled]';
}

/**
 * Render AskResult as compact text, partitioned into two TRUST ZONES so the
 * consuming agent never confuses vetted knowledge with raw chatter:
 *
 *   DISTILLED KNOWLEDGE (vetted)  — the notes. Each carries a source marker:
 *     [agent]     recorded live by an agent via lore_note (high intent)
 *     [distilled] extracted offline by the LLM distiller (default)
 *     [human]     entered by a person
 *   RAW CONVERSATION (unvetted)   — message hits, a low-trust fallback. Messages
 *     show only their RANK (msg1, msg2…), not a raw score, so the agent does not
 *     read precision into a noisy heuristic number.
 *
 * @param header  Optional freshness header prepended as the first line.
 */
function renderAskCompact(result: AskResult, header?: string): string {
  const parts: string[] = [];
  if (header) parts.push(header);
  parts.push(`query:${truncate(result.question, 120)}`);

  if (result.hits.length === 0 && result.messageHits.length === 0) {
    parts.push('results:none');
    return parts.join('\n');
  }

  const topNotes = result.hits.slice(0, 5);
  if (topNotes.length > 0) {
    parts.push('── DISTILLED KNOWLEDGE (vetted) ──');
    for (let i = 0; i < topNotes.length; i++) {
      const h = topNotes[i]!;
      const n = h.note;
      const anchor = n.anchors.length > 0
        ? `[${n.anchors[0]!.sessionId.slice(0, 8)}+${n.anchors[0]!.seq}]`
        : '';
      const marker = sourceMarker(n.source);
      parts.push(
        `note${i + 1} ${marker} kind=${n.kind} score=${h.score.toFixed(3)} ${anchor} ${truncate(n.title, 60)}`
      );
      parts.push(`  body:${truncate(n.body, 200)}`);
      if (n.files.length > 0) {
        parts.push(`  files:${n.files.slice(0, 3).join(',')}`);
      }
    }
  }

  const topMsgs = result.messageHits.slice(0, 3);
  if (topMsgs.length > 0) {
    parts.push('── RAW CONVERSATION (unvetted) ──');
    for (let i = 0; i < topMsgs.length; i++) {
      const m = topMsgs[i]!;
      const anchor = `[${m.sessionId.slice(0, 8)}+${m.seq}]`;
      // Show RANK, not raw score (heuristic; precision would mislead).
      parts.push(`msg${i + 1} rank=${i + 1} ${anchor} ${truncate(m.text, 200)}`);
    }
  }

  return parts.join('\n');
}

/**
 * Render fileHistory as a compact timeline.
 *
 * Weak attributions (confidence < 0.8) are flagged "⚠ LOW-CONFIDENCE" so the
 * agent does not mistake a low-trust match for a confident one.
 *
 * @param header  Optional freshness header prepended as the first line.
 */
function renderHistoryCompact(
  filePath: string,
  history: { commit: import('../graph/types.js').CommitNodeData; produced: import('../graph/types.js').ProducedInfo[] }[],
  header?: string,
): string {
  const parts: string[] = [];
  if (header) parts.push(header);
  parts.push(`file:${filePath} commits:${history.length}`);

  for (const entry of history) {
    const c = entry.commit;
    const date = c.authorDate.slice(0, 10);
    const line = `${c.hash.slice(0, 10)} ${date} ${truncate(c.subject, 60)}`;
    if (entry.produced.length > 0) {
      const p = entry.produced[0]!;
      const isWeak = p.confidence < STRONG_FLOOR;
      const tier = isWeak ? 'weak' : 'strong';
      const attr = `session:${p.sessionId.slice(0, 12)} conf=${p.confidence.toFixed(3)}(${tier})`;
      parts.push(
        isWeak
          ? `${line} ← ⚠ LOW-CONFIDENCE ${attr}`
          : `${line} ← ${attr}`
      );
    } else {
      parts.push(`${line} ← (unattributed)`);
    }
  }

  return parts.join('\n');
}

// ── freshness header ──────────────────────────────────────────────────────────

/** Minimal shape of .lore/report.json we read for the header. */
interface ReportHeaderShape {
  generatedAt?: string;
  commitsTotal?: number;
  commitsMatchedStrong?: number;
  commitsMatchedWeak?: number;
}

/**
 * Build the freshness header line:
 *   coverage:<attributed>/<total> · generated:<ISO date> [· stale:<bool>]
 *
 * - coverage: commits with ≥1 match (strong+weak) over total commits scanned.
 * - generated: report.json generatedAt date (YYYY-MM-DD).
 * - stale: true when report.generatedAt is older than the current git HEAD commit
 *   time (the report no longer reflects the latest commit). When the git lookup
 *   fails (not a repo, detached, etc.) the stale field is omitted entirely.
 *
 * Returns null when report.json is missing/unreadable — callers then render
 * without a header (degrade gracefully, never throw).
 */
async function buildFreshnessHeader(repoPath: string): Promise<string | null> {
  let report: ReportHeaderShape;
  try {
    const raw = await fs.readFile(path.join(repoPath, '.lore', 'report.json'), 'utf8');
    report = JSON.parse(raw) as ReportHeaderShape;
  } catch {
    return null;
  }

  const total = typeof report.commitsTotal === 'number' ? report.commitsTotal : 0;
  const strong = typeof report.commitsMatchedStrong === 'number' ? report.commitsMatchedStrong : 0;
  const weak = typeof report.commitsMatchedWeak === 'number' ? report.commitsMatchedWeak : 0;
  const attributed = strong + weak;
  const generatedAt = typeof report.generatedAt === 'string' ? report.generatedAt : '';
  const generatedDate = generatedAt ? generatedAt.slice(0, 10) : 'unknown';

  const segs = [`coverage:${attributed}/${total}`, `generated:${generatedDate}`];

  // stale: compare report.generatedAt against HEAD commit time. Omit on any failure.
  if (generatedAt) {
    const headTime = await headCommitISO(repoPath);
    if (headTime !== null) {
      const genMs = Date.parse(generatedAt);
      const headMs = Date.parse(headTime);
      if (!Number.isNaN(genMs) && !Number.isNaN(headMs)) {
        segs.push(`stale:${genMs < headMs}`);
      }
    }
  }

  return segs.join(' · ');
}

/** Fuller report shape for the status block (superset of the header shape). */
interface ReportStatusShape extends ReportHeaderShape {
  sessionsSeen?: number;
  sessionsContributing?: number;
  window?: { start: string; end: string } | null;
}

/**
 * Render the compact lore_status block — a one-shot trust/coverage snapshot the
 * agent should read FIRST to judge how much to trust the rest of lore. Reuses the
 * P0 freshness header (coverage / generated / stale) verbatim, then adds:
 *   - sessions: seen / contributing
 *   - notes:  total, bucketed by kind and by source
 *   - distilledAt + window.end (how current the underlying data is)
 *
 * Degrades gracefully: a missing report.json or notes.json yields "unknown"
 * segments rather than an error — the block is always renderable.
 */
async function renderStatusBlock(
  repoPath: string,
  header: string | undefined,
  notesFile: NotesFile | null,
): Promise<string> {
  const parts: string[] = ['lore_status'];
  // 1. Freshness header (coverage / generated / stale) — reuse P0 verbatim.
  parts.push(header ? header : 'coverage:unknown · generated:unknown (no report.json)');

  // 2. Sessions seen / contributing (from report.json).
  let report: ReportStatusShape | null = null;
  try {
    const raw = await fs.readFile(path.join(repoPath, '.lore', 'report.json'), 'utf8');
    report = JSON.parse(raw) as ReportStatusShape;
  } catch {
    report = null;
  }
  if (report) {
    const seen = typeof report.sessionsSeen === 'number' ? report.sessionsSeen : 0;
    const contributing =
      typeof report.sessionsContributing === 'number' ? report.sessionsContributing : 0;
    parts.push(`sessions:seen=${seen} contributing=${contributing}`);
    const windowEnd =
      report.window && typeof report.window.end === 'string' ? report.window.end : 'unknown';
    parts.push(`window.end:${windowEnd}`);
  } else {
    parts.push('sessions:unknown');
    parts.push('window.end:unknown');
  }

  // 3. Notes bucketed by kind and by source.
  const notes = notesFile?.notes ?? [];
  const byKind = new Map<string, number>();
  const bySource = new Map<string, number>();
  let valid = 0;
  for (const n of notes) {
    if (n.invalidAt === null) valid += 1;
    byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
    // Missing source = distilled (types.ts law).
    const src = n.source ?? 'distilled';
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }
  const kindStr = ['decision', 'constraint', 'rejected-approach']
    .map((k) => `${k}=${byKind.get(k) ?? 0}`)
    .join(' ');
  const srcStr = ['agent', 'distilled', 'human']
    .map((s) => `${s}=${bySource.get(s) ?? 0}`)
    .join(' ');
  parts.push(`notes:total=${notes.length} valid=${valid}`);
  parts.push(`  byKind:${kindStr}`);
  parts.push(`  bySource:${srcStr}`);

  // 4. distilledAt (last distill run; agent notes do not update it).
  const distilledAt = notesFile?.distilledAt ?? 'never';
  parts.push(`distilledAt:${distilledAt}`);

  return parts.join('\n');
}

/** git HEAD committer date (ISO), or null if git is unavailable / not a repo. */
async function headCommitISO(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'show', '-s', '--format=%cI', 'HEAD'],
      { encoding: 'utf8' },
    );
    const t = stdout.trim();
    return t || null;
  } catch {
    return null;
  }
}

// ── server factory ────────────────────────────────────────────────────────────

/**
 * Create a configured McpServer with the three lore tools registered.
 *
 * @param repoPath  Absolute path to the git repository being analysed.
 * @param engines   Optional engine overrides (for testing / DI).
 */
export function createLoreMcpServer(
  repoPath: string,
  engines?: {
    whyEngine?: WhyEngine;
    askEngine?: AskEngine;
    graphStore?: GraphStore;
    notesStore?: NotesStore;
  },
): McpServer {
  const server = new McpServer({
    name: 'lore',
    version: '0.0.1',
  });

  // Freshness header is computed once and reused across all tool calls.
  let headerCache: string | null | undefined;
  async function freshnessHeader(): Promise<string | undefined> {
    if (headerCache === undefined) {
      headerCache = await buildFreshnessHeader(repoPath);
    }
    return headerCache ?? undefined;
  }

  // ── lore_why ────────────────────────────────────────────────────────────────

  server.registerTool(
    'lore_why',
    {
      description:
        'Trace a line of source code back to the AI conversation that produced it. ' +
        'CALL THIS before editing a file you do not fully understand — it surfaces the ' +
        'intent, decisions, and rejected approaches behind the current code. ' +
        'Returns: the commit, a confidence score, conversation excerpts, and anchors.\n' +
        'TRUST MODEL — confidence ≥ 0.8 = "strong", a reliable attribution you can act on; ' +
        'confidence < 0.8 = "weak", a low-confidence guess that is HIDDEN by default ' +
        '(pass include_weak:true to surface it; weak results are prefixed "⚠ LOW-CONFIDENCE"). ' +
        'matchedVia=sha means an exact commit-hash anchor (certain); matchedVia=content means ' +
        'edited-lines were matched to commit lines (heuristic). ' +
        'Each [sessionId+seq] is a PERMANENT anchor you can quote or re-look-up.',
      inputSchema: {
        file: z.string().describe('Repo-relative file path, e.g. "src/cli.ts"'),
        line: z.number().int().positive().describe('1-based line number'),
        include_weak: z
          .boolean()
          .optional()
          .describe(
            'Surface low-confidence (<0.8) attributions, flagged "⚠ LOW-CONFIDENCE" (default: false)',
          ),
      },
    },
    async (args) => {
      try {
        let whyEngine: WhyEngine;
        if (engines?.whyEngine) {
          whyEngine = engines.whyEngine;
        } else {
          // Self-wire: load the self-assembling engine (same pattern as cli.ts).
          const mod = await import('../why/engine.js') as { engine: WhyEngine };
          whyEngine = mod.engine;
        }
        const includeWeak = args.include_weak ?? false;
        const result = await whyEngine.why(repoPath, args.file, args.line, { includeWeak });
        const header = await freshnessHeader();
        return { content: [{ type: 'text', text: renderWhyCompact(result, header) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `lore_why error: ${msg}` }],
        };
      }
    },
  );

  // ── lore_ask ────────────────────────────────────────────────────────────────

  server.registerTool(
    'lore_ask',
    {
      description:
        'Search the project\'s memory for why something was done the way it was. ' +
        'CALL THIS when you need the rationale behind a design, a constraint you must not ' +
        'violate, or an approach that was already tried and rejected. ' +
        'Returns two kinds of hits, each with a [sessionId+seq] anchor:\n' +
        'kind=decision|constraint|rejected-approach (a "note") = DISTILLED, high-trust ' +
        'engineering knowledge extracted from the conversation — prefer these. ' +
        'A "msg" hit = a RAW, unvetted conversation snippet (low-trust, may be noisy or ' +
        'speculative) shown only as a fallback when notes do not cover the query. ' +
        'Superseded (overturned) notes are hidden unless include_weak / includeSuperseded is set.',
      inputSchema: {
        question: z.string().describe('Natural-language question about the codebase'),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe('Include invalidated/superseded notes (default: false)'),
        file: z
          .string()
          .optional()
          .describe(
            'Scope to one file before you change it: returns only the constraints / ' +
              'decisions attached to this path (repo-relative or absolute, suffix-matched). ' +
              'Raw conversation hits are omitted when scoped — notes only.',
          ),
      },
    },
    async (args) => {
      try {
        let askEngine: AskEngine;
        if (engines?.askEngine) {
          askEngine = engines.askEngine;
        } else {
          const mod = await import('../ask/engine.js') as { engine: AskEngine };
          askEngine = mod.engine;
        }
        const askOpts: { topK: number; includeSuperseded: boolean; file?: string } = {
          topK: 5,
          includeSuperseded: args.includeSuperseded ?? false,
        };
        if (args.file !== undefined) askOpts.file = args.file;
        const result = await askEngine.ask(repoPath, args.question, askOpts);
        const header = await freshnessHeader();
        return { content: [{ type: 'text', text: renderAskCompact(result, header) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `lore_ask error: ${msg}` }],
        };
      }
    },
  );

  // ── lore_history ────────────────────────────────────────────────────────────

  server.registerTool(
    'lore_history',
    {
      description:
        'Show the commit timeline for a file, each commit annotated with the AI session ' +
        'that produced it. CALL THIS to understand how a file evolved and which conversations ' +
        'shaped it before you change it. Returns commits (hash, date, subject) in time order, ' +
        'each either attributed to a session or marked (unattributed).\n' +
        'TRUST MODEL — conf ≥ 0.8 = "strong" (reliable); conf < 0.8 = "weak", flagged ' +
        '"⚠ LOW-CONFIDENCE" (treat as a hint, not fact). session:<id> is a PERMANENT anchor ' +
        'you can pass to lore_why or quote in a follow-up.',
      inputSchema: {
        path: z.string().describe('Repo-relative file path, e.g. "src/cli.ts"'),
      },
    },
    async (args) => {
      try {
        let store: GraphStore;
        if (engines?.graphStore) {
          store = engines.graphStore;
          await store.init();
        } else {
          const mod = await import('../graph/factory.js') as {
            createGraphStore: (p: string) => Promise<GraphStore>;
          };
          store = await mod.createGraphStore(repoPath);
          await store.init();
        }
        try {
          const history = await store.fileHistory(args.path);
          const header = await freshnessHeader();
          return {
            content: [{ type: 'text', text: renderHistoryCompact(args.path, history, header) }],
          };
        } finally {
          // Only close stores we created ourselves, not injected test stores.
          if (!engines?.graphStore) {
            await store.close();
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `lore_history error: ${msg}` }],
        };
      }
    },
  );

  // ── notes store loader (shared by lore_note / lore_status) ────────────────────

  async function getNotesStore(): Promise<NotesStore> {
    if (engines?.notesStore) return engines.notesStore;
    const mod = (await import('../notes/store.js')) as { notesStore: NotesStore };
    return mod.notesStore;
  }

  // ── lore_note ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'lore_note',
    {
      description:
        'Leave a durable note for FUTURE agents. CALL THIS the moment you (a) make a ' +
        'decision someone will later ask "why?" about, (b) discover a hard constraint that ' +
        'must not be violated, or (c) reject an approach (record WHY you rejected it). ' +
        'This is a message in a bottle to whoever touches this code next — it is recorded as ' +
        'source="agent" (higher trust than offline-distilled notes) and surfaces in lore_ask. ' +
        'Same-title agent notes are updated in place (no duplicates). Use supersedes to ' +
        'overturn an earlier note by id (it is marked invalid, not deleted). ' +
        'Keep it terse: title ≤120 chars, body ≤2000.',
      inputSchema: {
        kind: z
          .enum(['decision', 'constraint', 'rejected-approach'])
          .describe('decision | constraint | rejected-approach'),
        title: z.string().describe('One-line summary (≤120 chars)'),
        body: z
          .string()
          .describe('2-4 sentences: what + why. For rejected-approach, state why it was rejected.'),
        files: z
          .array(z.string())
          .optional()
          .describe('Repo-relative paths this note concerns (helps file-scoped lore_ask)'),
        supersedes: z
          .string()
          .optional()
          .describe('Id of an earlier note this overturns (it is marked invalid, not deleted)'),
      },
    },
    async (args) => {
      try {
        // Abuse guards — fail loudly with guidance rather than store an essay.
        const title = args.title.trim();
        const body = args.body.trim();
        if (title.length === 0) {
          throw new Error('title is empty — give a one-line summary of the decision/constraint.');
        }
        if (title.length > NOTE_TITLE_MAX) {
          throw new Error(
            `title too long (${title.length} > ${NOTE_TITLE_MAX}). Tighten it to a single line; ` +
              'put detail in body.',
          );
        }
        if (body.length === 0) {
          throw new Error('body is empty — say what the decision is AND why (1 sentence min).');
        }
        if (body.length > NOTE_BODY_MAX) {
          throw new Error(
            `body too long (${body.length} > ${NOTE_BODY_MAX}). A note is a terse留言, not a doc; ` +
              'summarise the rationale and link code via files[].',
          );
        }

        const store = await getNotesStore();
        const appendArgs: {
          kind: typeof args.kind;
          title: string;
          body: string;
          files?: string[];
          source: 'agent';
          supersedes?: string;
        } = { kind: args.kind, title, body, source: 'agent' };
        if (args.files !== undefined) appendArgs.files = args.files;
        if (args.supersedes !== undefined) appendArgs.supersedes = args.supersedes;
        const res = await store.appendNote(repoPath, appendArgs);

        const verb = res.updated ? 'updated' : 'created';
        const sup = res.superseded ? ` superseded=${res.superseded}` : '';
        return {
          content: [
            { type: 'text', text: `lore_note ${verb} id=${res.id}${sup}` },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `lore_note error: ${msg}` }],
        };
      }
    },
  );

  // ── lore_status ───────────────────────────────────────────────────────────────

  server.registerTool(
    'lore_status',
    {
      description:
        'CALL THIS FIRST to judge how much to trust lore here and what it covers. ' +
        'Returns a compact snapshot: data freshness (generated date + stale flag), commit ' +
        'coverage, sessions seen vs contributing, note counts bucketed by kind and by source ' +
        '(agent / distilled / human), the last distill time, and the transcript window end. ' +
        'If coverage is low or the data is stale, weight lore_ask / lore_why results accordingly.',
      inputSchema: {},
    },
    async () => {
      try {
        const header = await freshnessHeader();
        let notesFile: NotesFile | null = null;
        try {
          const store = await getNotesStore();
          notesFile = await store.load(repoPath);
        } catch {
          notesFile = null;
        }
        const text = await renderStatusBlock(repoPath, header, notesFile);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `lore_status error: ${msg}` }],
        };
      }
    },
  );

  return server;
}

// ── test-only exports ──────────────────────────────────────────────────────────
// Exported for unit tests of the pure renderers / header builder; not part of the
// public MCP surface (the server factory above is the real entry point).
export const __test__ = {
  renderWhyCompact,
  renderAskCompact,
  renderHistoryCompact,
  renderStatusBlock,
  buildFreshnessHeader,
  slimSession,
};
