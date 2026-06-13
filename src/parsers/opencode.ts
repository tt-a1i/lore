/**
 * OpenCode transcript parser.
 *
 * Implements TranscriptParser for agent='opencode'.
 *
 * Data source: SQLite single database at ~/.local/share/opencode/opencode.db.
 * Each session becomes one virtual "file" with pseudo-path:
 *   <dbPath>#<sessionId>
 *
 * See docs/research/codex-opencode-format.md §2 for the authoritative schema.
 *
 * Granularity notes (reported in parse() skipped.samples when applicable):
 * - User/assistant text is extracted from the `part` table (type='text').
 * - File-edit granularity: the `session` table has `summary_diffs` (JSON array
 *   of diff summaries) and `summary_files/additions/deletions` counters. If
 *   `summary_diffs` is non-empty, per-file FileEditEvent entries are emitted.
 *   Tool-call `part` types (e.g. "tool-call"/"tool-result") are not confirmed
 *   from real data; the parser degrades gracefully to message-only events when
 *   no tool-call parts are found.
 * - Git commits are not auto-detected from OpenCode data (no exec_command
 *   equivalent confirmed); git-commit events are omitted.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  SCHEMA_VERSION,
  type AgentKind,
  type FileEditEvent,
  type LoreEvent,
  type ParseResult,
  type ParsedSession,
  type SessionMeta,
  type TranscriptParser,
  type UserMessageEvent,
  type AssistantMessageEvent,
  type PatchHunk,
} from '../schema/events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENCODE_DB_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'opencode',
  'opencode.db',
);

const PSEUDO_PATH_SEP = '#';
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// SQLite row shapes (permissive — extra columns ignored)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
  model: string | null;
  path: string | null;
  summary_files: number | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_diffs: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

// ---------------------------------------------------------------------------
// Parsed shapes for part.data
// ---------------------------------------------------------------------------

interface PartDataText {
  type: 'text';
  text: string;
  time?: { start?: number; end?: number };
}

interface PartDataReasoning {
  type: 'reasoning';
  text: string;
  time?: { start?: number; end?: number };
}

interface PartDataStepStart {
  type: 'step-start';
}

interface PartDataStepFinish {
  type: 'step-finish';
  reason?: string;
}

interface PartDataToolCall {
  type: 'tool-call' | 'tool_call';
  toolName?: string;
  tool_name?: string;
  input?: unknown;
  args?: unknown;
  call_id?: string;
  id?: string;
}

interface PartDataToolResult {
  type: 'tool-result' | 'tool_result';
  call_id?: string;
  id?: string;
  output?: unknown;
  result?: unknown;
  error?: boolean;
}

interface PartDataFileEdit {
  type: 'file-edit';
  path?: string;
  filePath?: string;
  op?: 'edit' | 'write' | 'multi-edit' | 'notebook-edit';
  oldText?: string | null;
  newText?: string;
  patch?: unknown;
}

type PartData =
  | PartDataText
  | PartDataReasoning
  | PartDataStepStart
  | PartDataStepFinish
  | PartDataToolCall
  | PartDataToolResult
  | PartDataFileEdit
  | { type: string };

// ---------------------------------------------------------------------------
// summary_diffs schema (confirmed from schema docs)
// ---------------------------------------------------------------------------

interface SummaryDiff {
  path?: string;
  additions?: number;
  deletions?: number;
  /** Unified diff string if available */
  diff?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Safely open the OpenCode DB read-only.
 * Returns null if not available or node:sqlite not present.
 */
function openDb(dbPath: string): import('node:sqlite').DatabaseSync | null {
  try {
    // node:sqlite is built-in Node ≥22; may be absent on older Node.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    // Open read-only; also set WAL journal mode reading via uri=true immutable flag.
    // DatabaseSync constructor signature: new DatabaseSync(location, options?)
    // options.readOnly is the canonical flag (Node 26 verified).
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  } catch {
    return null;
  }
}

/**
 * Check if a table exists in the given db.
 */
function tableExists(db: import('node:sqlite').DatabaseSync, tableName: string): boolean {
  try {
    const stmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    );
    const row = stmt.get(tableName) as unknown as { name: string } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Parse summary_diffs JSON into SummaryDiff[]; returns [] on any error.
 */
function parseSummaryDiffs(raw: string | null): SummaryDiff[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SummaryDiff[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Parse a unified-diff string (standard format with @@ hunks) into PatchHunk[].
 * Returns null if the input is empty or unparseable.
 */
function parseUnifiedDiff(diffStr: string): PatchHunk[] | null {
  if (!diffStr.trim()) return null;
  const hunks: PatchHunk[] = [];
  const lines = diffStr.split('\n');
  let current: PatchHunk | null = null;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkHeader) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(hunkHeader[1] ?? '1', 10),
        oldLines: hunkHeader[2] !== undefined ? parseInt(hunkHeader[2], 10) : 1,
        newStart: parseInt(hunkHeader[3] ?? '1', 10),
        newLines: hunkHeader[4] !== undefined ? parseInt(hunkHeader[4], 10) : 1,
        lines: [],
      };
      continue;
    }
    if (current) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
        current.lines.push(line);
      }
    }
  }
  if (current) hunks.push(current);
  return hunks.length > 0 ? hunks : null;
}

/**
 * Extract the db path and sessionId from a pseudo-path.
 * Format: <dbPath>#<sessionId>
 */
function splitPseudoPath(pseudoPath: string): { dbPath: string; sessionId: string } | null {
  const sepIdx = pseudoPath.lastIndexOf(PSEUDO_PATH_SEP);
  if (sepIdx < 0) return null;
  return {
    dbPath: pseudoPath.slice(0, sepIdx),
    sessionId: pseudoPath.slice(sepIdx + 1),
  };
}

/**
 * Build a pseudo-path from db path and session id.
 */
function buildPseudoPath(dbPath: string, sessionId: string): string {
  return `${dbPath}${PSEUDO_PATH_SEP}${sessionId}`;
}

// ---------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------

async function discoverSessions(repoPath: string, broad = false): Promise<string[]> {
  const dbPath = OPENCODE_DB_PATH;

  // Check existence without throwing
  try {
    await fs.promises.access(dbPath, fs.constants.R_OK);
  } catch {
    return [];
  }

  const db = openDb(dbPath);
  if (!db) return [];

  try {
    if (!tableExists(db, 'session')) return [];

    const stmt = db.prepare(
      `SELECT id, directory, path FROM session ORDER BY time_created ASC`,
    );
    const rows = stmt.all() as unknown as Array<{ id: string; directory: string | null; path: string | null }>;

    const results: string[] = [];
    for (const row of rows) {
      if (!broad) {
        // Only include sessions whose directory or path is under repoPath
        const sessionDir = row.directory ?? '';
        const sessionPath = row.path ?? '';
        const underRepo =
          sessionDir === repoPath ||
          sessionDir.startsWith(repoPath + path.sep) ||
          sessionPath === repoPath ||
          sessionPath.startsWith(repoPath + path.sep);
        if (!underRepo) continue;
      }
      results.push(buildPseudoPath(dbPath, row.id));
    }
    return results;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

async function parseSession(pseudoPath: string): Promise<ParseResult> {
  const split = splitPseudoPath(pseudoPath);
  if (!split) {
    // Malformed pseudo-path — return empty session
    return emptyResult(pseudoPath, 'malformed pseudo-path');
  }

  const { dbPath, sessionId } = split;

  // Check db existence
  try {
    await fs.promises.access(dbPath, fs.constants.R_OK);
  } catch {
    return emptyResult(pseudoPath, 'db not found');
  }

  const db = openDb(dbPath);
  if (!db) {
    return emptyResult(pseudoPath, 'node:sqlite unavailable');
  }

  try {
    // Verify required tables exist
    if (!tableExists(db, 'session') || !tableExists(db, 'message') || !tableExists(db, 'part')) {
      return emptyResult(pseudoPath, 'required tables missing');
    }

    // -----------------------------------------------------------------------
    // Load session row
    // -----------------------------------------------------------------------
    const sessionStmt = db.prepare(`SELECT * FROM session WHERE id = ?`);
    const sessionRow = sessionStmt.get(sessionId) as unknown as SessionRow | undefined;
    if (!sessionRow) {
      return emptyResult(pseudoPath, `session not found: ${sessionId}`);
    }

    const cwd: string | null = sessionRow.directory || sessionRow.path || null;
    const startedAt = msToIso(sessionRow.time_created);
    const endedAt = msToIso(sessionRow.time_updated);

    // Derive agentVersion from model JSON
    let agentVersion: string | null = null;
    if (sessionRow.model) {
      try {
        const modelObj = JSON.parse(sessionRow.model) as {
          id?: string;
          providerID?: string;
          variant?: string;
        };
        agentVersion = modelObj.id ?? null;
      } catch {
        // ignore
      }
    }

    // -----------------------------------------------------------------------
    // Load messages with parts for this session
    // -----------------------------------------------------------------------
    const msgStmt = db.prepare(
      `SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`,
    );
    const messages = msgStmt.all(sessionId) as unknown as MessageRow[];

    const partStmt = db.prepare(
      `SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC`,
    );
    const allParts = partStmt.all(sessionId) as unknown as PartRow[];

    // Group parts by message_id
    const partsByMessage = new Map<string, PartRow[]>();
    for (const part of allParts) {
      const list = partsByMessage.get(part.message_id) ?? [];
      list.push(part);
      partsByMessage.set(part.message_id, list);
    }

    // -----------------------------------------------------------------------
    // Build events
    // -----------------------------------------------------------------------
    const events: LoreEvent[] = [];
    let seq = 0;
    const skippedSamples: string[] = [];
    let skippedCount = 0;
    const notes: string[] = [];

    function nextSeq(): number { return seq++; }
    function recordSkip(reason: string): void {
      skippedCount++;
      if (skippedSamples.length < 5) skippedSamples.push(reason.slice(0, 200));
    }

    for (const msg of messages) {
      let msgData: { role?: string; time?: { created?: number }; path?: { cwd?: string } };
      try {
        msgData = JSON.parse(msg.data) as typeof msgData;
      } catch {
        recordSkip(`message.data parse error: msgId=${msg.id}`);
        continue;
      }

      const role = msgData.role;
      const ts = msToIso(
        msgData.time?.created ?? msg.time_created,
      );

      const parts = partsByMessage.get(msg.id) ?? [];

      for (const part of parts) {
        let pd: PartData;
        try {
          pd = JSON.parse(part.data) as PartData;
        } catch {
          recordSkip(`part.data parse error: partId=${part.id}`);
          continue;
        }

        const partTs = msToIso(part.time_created > 0 ? part.time_created : msg.time_created);

        switch (pd.type) {
          case 'text': {
            const text = (pd as PartDataText).text.trim();
            if (!text) continue;
            if (role === 'user') {
              const ev: UserMessageEvent = {
                kind: 'user-message',
                sessionId,
                ts: partTs,
                seq: nextSeq(),
                text,
              };
              events.push(ev);
            } else if (role === 'assistant') {
              const ev: AssistantMessageEvent = {
                kind: 'assistant-message',
                sessionId,
                ts: partTs,
                seq: nextSeq(),
                text,
              };
              events.push(ev);
            }
            // Ignore other roles (developer, system context, etc.)
            break;
          }

          case 'tool-call':
          case 'tool_call': {
            // Tool call parts — extract file edits if possible.
            // Tool-call part types are schema-confirmed but not observed
            // from real data. Best-effort extraction below.
            const tc = pd as PartDataToolCall;
            const toolName = tc.toolName ?? tc.tool_name ?? '';
            const isFileEdit =
              toolName.toLowerCase().includes('edit') ||
              toolName.toLowerCase().includes('write') ||
              toolName.toLowerCase().includes('patch');
            if (!isFileEdit) {
              // Non-file-edit tool call — skip silently (shell exec etc.)
            }
            break;
          }

          case 'tool-result':
          case 'tool_result': {
            // Tool result — currently no confirmed schema for file edits.
            // Skip silently; file edits are captured via summary_diffs below.
            break;
          }

          case 'file-edit': {
            // If OpenCode ever emits explicit file-edit parts, handle them here.
            const fe = pd as PartDataFileEdit;
            const filePath = fe.path ?? fe.filePath ?? '';
            if (!filePath) break;
            const op = fe.op ?? 'edit';
            const patchHunks =
              Array.isArray(fe.patch)
                ? (fe.patch as PatchHunk[])
                : null;
            const ev: FileEditEvent = {
              kind: 'file-edit',
              sessionId,
              ts: partTs,
              seq: nextSeq(),
              toolUseId: null,
              op,
              filePath,
              oldText: fe.oldText ?? null,
              newText: fe.newText ?? '',
              patch: patchHunks,
              userModified: null,
              succeeded: null,
            };
            events.push(ev);
            break;
          }

          case 'step-start':
          case 'step-finish':
          case 'reasoning':
            // Structural / metadata parts — skip silently.
            break;

          default:
            // Unknown part type — skip silently (format may evolve).
            break;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Supplement with session-level summary_diffs when no file-edit events
    // were extracted from parts (graceful degradation).
    // -----------------------------------------------------------------------
    const existingFileEdits = events.filter((e) => e.kind === 'file-edit');
    if (existingFileEdits.length === 0) {
      const diffs = parseSummaryDiffs(sessionRow.summary_diffs);
      if (diffs.length > 0) {
        // Emit one FileEditEvent per diff entry, using session endedAt as ts.
        for (const diff of diffs) {
          const filePath = diff.path ?? '';
          if (!filePath) continue;
          const patch = diff.diff ? parseUnifiedDiff(diff.diff) : null;
          const ev: FileEditEvent = {
            kind: 'file-edit',
            sessionId,
            ts: endedAt,
            seq: nextSeq(),
            toolUseId: null,
            op: 'edit',
            filePath,
            oldText: null,
            newText: '',
            patch,
            userModified: null,
            succeeded: null,
          };
          events.push(ev);
        }
        notes.push(
          `file-edit events sourced from session.summary_diffs (${diffs.length} entries); ` +
          `per-tool-call granularity unavailable (tool-call part types not confirmed from real data)`,
        );
      } else if (
        (sessionRow.summary_files ?? 0) > 0 &&
        diffs.length === 0
      ) {
        // Session touched files but summary_diffs is empty — log as skipped info.
        notes.push(
          `session.summary_files=${sessionRow.summary_files} but summary_diffs is empty; ` +
          `file-edit events omitted (insufficient granularity for matching engine)`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Build final result
    // -----------------------------------------------------------------------
    const meta: SessionMeta = {
      schemaVersion: SCHEMA_VERSION,
      agent: 'opencode' as AgentKind,
      sessionId,
      cwd,
      gitBranch: null, // OpenCode does not store branch in DB schema
      startedAt,
      endedAt,
      sourcePath: pseudoPath,
      agentVersion,
    };

    events.sort((a, b) => a.seq - b.seq);

    const session: ParsedSession = { meta, events };

    // Include granularity notes in skipped.samples if present
    const allSamples = [...skippedSamples, ...notes];

    return {
      session,
      skipped: { count: skippedCount, samples: allSamples },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return emptyResult(pseudoPath, `unexpected error: ${msg}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Helper: return a well-formed empty ParseResult on failure
// ---------------------------------------------------------------------------

function emptyResult(sourcePath: string, reason: string): ParseResult {
  const now = new Date().toISOString();
  const session: ParsedSession = {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      agent: 'opencode' as AgentKind,
      sessionId: '',
      cwd: null,
      gitBranch: null,
      startedAt: now,
      endedAt: null,
      sourcePath,
      agentVersion: null,
    },
    events: [],
  };
  return {
    session,
    skipped: { count: 0, samples: [reason] },
  };
}

// ---------------------------------------------------------------------------
// TranscriptParser export
// ---------------------------------------------------------------------------

export const opencodeParser: TranscriptParser = {
  agent: 'opencode',

  async discover(repoPath: string, opts?: { broad?: boolean }): Promise<string[]> {
    return discoverSessions(repoPath, opts?.broad === true);
  },

  async parse(transcriptPath: string): Promise<ParseResult> {
    return parseSession(transcriptPath);
  },
};

export const parser: TranscriptParser = opencodeParser;
export default opencodeParser;
