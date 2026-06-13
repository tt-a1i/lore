/**
 * Codex CLI transcript parser.
 *
 * Implements TranscriptParser for agent='codex'.
 * Parses ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl —— the full
 * event stream for one Codex thread.
 *
 * Authoritative format spec: docs/research/codex-opencode-format.md
 *
 * Each rollout line is { timestamp, type, payload }. Record types:
 *   - session_meta : thread metadata (cwd, model, cli_version). cwd from FIRST occurrence.
 *   - event_msg    : runtime events (user_message, agent_message, patch_apply_end, …)
 *   - response_item: LLM stream items (message, function_call, function_call_output,
 *                    custom_tool_call apply_patch, …)
 *   - turn_context : per-turn env snapshot (ignored)
 *   - compacted    : context compaction record (ignored; earlier turns irretrievable)
 *
 * Event extraction:
 *   user-message  ← event_msg/user_message.payload.message
 *   assistant-message ← event_msg/agent_message.payload.message
 *                        (response_item/message role=assistant is the streamed twin —
 *                         we prefer event_msg and de-dup the response_item copy)
 *   file-edit     ← event_msg/patch_apply_end.payload.changes (PRIMARY)
 *                    fallback: response_item/custom_tool_call apply_patch envelope
 *   shell-exec    ← response_item/function_call exec_command (arguments JSON.cmd)
 *   git-commit    ← function_call_output.output of an exec_command whose cmd has
 *                    `git commit`, SHA parsed from `[branch <sha>]` after `Output:\n`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import {
  SCHEMA_VERSION,
  type AgentKind,
  type FileEditEvent,
  type GitCommitEvent,
  type LoreEvent,
  type ParseResult,
  type ParsedSession,
  type PatchHunk,
  type SessionMeta,
  type ShellExecEvent,
  type TranscriptParser,
  type UserMessageEvent,
  type AssistantMessageEvent,
} from '../schema/events.js';

// ---------------------------------------------------------------------------
// Raw line shapes (permissive — extra keys ignored)
// ---------------------------------------------------------------------------

interface RawLine {
  timestamp?: string;
  type?: string;
  payload?: unknown;
}

interface SessionMetaPayload {
  id?: string;
  cwd?: string;
  cli_version?: string;
  model?: string;
  model_provider?: string;
}

interface UserMessagePayload {
  type: 'user_message';
  message?: string;
}

interface AgentMessagePayload {
  type: 'agent_message';
  message?: string;
  phase?: string;
}

interface PatchApplyEndPayload {
  type: 'patch_apply_end';
  call_id?: string;
  success?: boolean;
  changes?: Record<string, ChangeEntry>;
}

interface ChangeEntry {
  type?: string; // "add" | "update" | "delete"
  content?: string;
  unified_diff?: string;
}

interface ResponseMessagePayload {
  type: 'message';
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface FunctionCallPayload {
  type: 'function_call';
  name?: string;
  arguments?: string; // JSON-encoded string
  call_id?: string;
}

interface FunctionCallOutputPayload {
  type: 'function_call_output';
  call_id?: string;
  output?: string;
}

interface CustomToolCallPayload {
  type: 'custom_tool_call';
  name?: string;
  input?: string; // apply_patch envelope (plain string)
  call_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSIONS_GLOB_ROOT = ['.codex', 'sessions'];

/**
 * Git commit SHA from a status line like `[main 1a2b3c4] msg`,
 * `[detached HEAD deadbee] msg`, or `[branch (root-commit) abc1234]`. The SHA
 * is the last bracketed token before `]`, matched as a 7–40 hex run that is
 * NOT followed by more hex (so it's word-bounded inside the bracket).
 */
const COMMIT_SHA_PATTERN = /\[[^\]]*?\b([0-9a-f]{7,40})\]/;

/** Strip the exec_command output prefix and return text after `Output:\n`. */
function stripExecOutputPrefix(output: string): string {
  const marker = 'Output:\n';
  const idx = output.indexOf(marker);
  if (idx === -1) return output;
  return output.slice(idx + marker.length);
}

/**
 * Resolve a patch path against the session cwd. `Update File` uses absolute
 * paths, `Add File`/`Delete File` may use relative paths.
 */
function resolvePath(p: string, cwd: string | null): string {
  if (path.isAbsolute(p)) return p;
  if (cwd) return path.join(cwd, p);
  return p;
}

/**
 * Map a Codex change `type` to a lore FileEditEvent op.
 * add → write (whole-file), update → edit, delete → write (empty new content).
 */
function changeTypeToOp(t: string | undefined): FileEditEvent['op'] {
  if (t === 'add') return 'write';
  if (t === 'delete') return 'write';
  return 'edit';
}

/**
 * Parse a unified_diff string into PatchHunk[] (with line-number ranges).
 * Returns null when no parseable hunk header is present (the engine then
 * falls back to the newText line set).
 */
function parseUnifiedDiff(diff: string): PatchHunk[] | null {
  const lines = diff.split('\n');
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  const headerRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of lines) {
    const m = headerRe.exec(line);
    if (m) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newLines: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      };
      continue;
    }
    if (current) {
      // Body line: keep the leading +/-/space prefix verbatim. Drop file
      // headers (---/+++) and the trailing "\ No newline" marker.
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('\\')) continue;
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks.length > 0 ? hunks : null;
}

/** Extract the added/new content lines (no +/- prefix) from a unified diff. */
function newTextFromUnifiedDiff(diff: string): string {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) continue; // removed line
    if (line.startsWith('+')) {
      out.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      out.push(line.slice(1)); // context line
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// apply_patch envelope parser (SECONDARY file-edit path)
// ---------------------------------------------------------------------------

interface EnvelopeFile {
  op: 'add' | 'update' | 'delete';
  filePath: string;
  /** For add: full content. For update: new/context lines. For delete: ''. */
  newText: string;
}

/**
 * Parse a Codex `*** Begin Patch … *** End Patch` envelope into per-file edits.
 *
 * Envelope grammar (proprietary, NOT unified diff):
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +<line>
 *   *** Update File: <path>
 *   @@
 *   -<old> / +<new> / <context>
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * We collapse each file's body to its resulting content lines (newText): for
 * Add, the `+` lines; for Update, the `+` and context lines (drop `-`).
 */
function parseApplyPatchEnvelope(input: string): EnvelopeFile[] {
  const lines = input.split('\n');
  const files: EnvelopeFile[] = [];
  let current: EnvelopeFile | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (current) {
      current.newText = body.join('\n');
      files.push(current);
    }
    current = null;
    body = [];
  };

  for (const line of lines) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      continue;
    }
    const addM = /^\*\*\* Add File: (.+)$/.exec(line);
    const updM = /^\*\*\* Update File: (.+)$/.exec(line);
    const delM = /^\*\*\* Delete File: (.+)$/.exec(line);
    if (addM) {
      flush();
      current = { op: 'add', filePath: addM[1]!.trim(), newText: '' };
      continue;
    }
    if (updM) {
      flush();
      current = { op: 'update', filePath: updM[1]!.trim(), newText: '' };
      continue;
    }
    if (delM) {
      flush();
      current = { op: 'delete', filePath: delM[1]!.trim(), newText: '' };
      continue;
    }
    if (!current) continue;
    if (current.op === 'delete') continue;
    // Hunk separator inside Update — drop bare @@ markers.
    if (line === '@@' || line.startsWith('@@ ')) continue;
    if (current.op === 'add') {
      // Add lines are prefixed with '+'.
      body.push(line.startsWith('+') ? line.slice(1) : line);
    } else {
      // Update: keep '+' and context lines, drop '-'.
      if (line.startsWith('-')) continue;
      if (line.startsWith('+')) body.push(line.slice(1));
      else if (line.startsWith(' ')) body.push(line.slice(1));
      else body.push(line);
    }
  }
  flush();
  return files;
}

// ---------------------------------------------------------------------------
// Core streaming parse
// ---------------------------------------------------------------------------

async function parseFile(transcriptPath: string): Promise<ParseResult> {
  let sessionId = path.basename(transcriptPath, '.jsonl');
  let cwd: string | null = null;
  let cliVersion: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  const events: LoreEvent[] = [];
  let seq = 0;

  const skippedSamples: string[] = [];
  let skippedCount = 0;

  // exec_command call_id → cmd (to detect git-commit on the matching output)
  const execCommands = new Map<string, string>();
  // patch_apply_end call_ids we've emitted from. The secondary custom_tool_call
  // path is DEFERRED to end-of-file so we know whether a patch_apply_end
  // (which can come AFTER the custom_tool_call line) covered the same call_id.
  const emittedPatchCallIds = new Set<string>();
  const deferredEnvelopeEdits: Array<{
    ts: string;
    callId: string | null;
    files: EnvelopeFile[];
  }> = [];

  function recordSkip(reason: string): void {
    skippedCount++;
    if (skippedSamples.length < 5) {
      skippedSamples.push(reason.slice(0, 200));
    }
  }

  function nextSeq(): number {
    return seq++;
  }

  function noteTs(ts: string): void {
    if (!ts) return;
    if (!startedAt) startedAt = ts;
    endedAt = ts;
  }

  function emitFileEditFromChange(
    ts: string,
    callId: string | null,
    rawPath: string,
    change: ChangeEntry,
  ): void {
    const filePath = resolvePath(rawPath, cwd);
    const op = changeTypeToOp(change.type);
    let oldText: string | null = null;
    let newText = '';
    let patch: PatchHunk[] | null = null;
    if (change.type === 'update' && typeof change.unified_diff === 'string') {
      patch = parseUnifiedDiff(change.unified_diff);
      newText = newTextFromUnifiedDiff(change.unified_diff);
    } else if (typeof change.content === 'string') {
      // add / delete carry full content
      if (change.type === 'delete') oldText = change.content;
      newText = change.type === 'delete' ? '' : change.content;
    }
    const ev: FileEditEvent = {
      kind: 'file-edit',
      sessionId,
      ts,
      seq: nextSeq(),
      toolUseId: callId,
      op,
      filePath,
      oldText,
      newText,
      patch,
      userModified: null,
      succeeded: true,
    };
    events.push(ev);
  }

  function processEventMsg(payload: unknown, ts: string, lineStr: string): void {
    if (!payload || typeof payload !== 'object') {
      recordSkip(`event_msg without object payload: ${lineStr.slice(0, 80)}`);
      return;
    }
    const p = payload as { type?: string };
    switch (p.type) {
      case 'user_message': {
        const um = payload as UserMessagePayload;
        const text = typeof um.message === 'string' ? um.message.trim() : '';
        if (text) {
          const ev: UserMessageEvent = {
            kind: 'user-message',
            sessionId,
            ts,
            seq: nextSeq(),
            text,
          };
          events.push(ev);
        }
        return;
      }
      case 'agent_message': {
        const am = payload as AgentMessagePayload;
        const text = typeof am.message === 'string' ? am.message.trim() : '';
        if (text) {
          const ev: AssistantMessageEvent = {
            kind: 'assistant-message',
            sessionId,
            ts,
            seq: nextSeq(),
            text,
          };
          events.push(ev);
        }
        return;
      }
      case 'patch_apply_end': {
        const pe = payload as PatchApplyEndPayload;
        const callId = typeof pe.call_id === 'string' ? pe.call_id : null;
        // A companion patch_apply_end, successful or failed, means the custom
        // tool call was observed. Failed applies must suppress the deferred
        // envelope fallback, otherwise attempted patches become succeeded edits.
        if (callId) emittedPatchCallIds.add(callId);
        // Only count successful applies (success defaults to true when absent).
        if (pe.success === false) return;
        const changes = pe.changes;
        if (changes && typeof changes === 'object') {
          for (const [rawPath, change] of Object.entries(changes)) {
            if (change && typeof change === 'object') {
              emitFileEditFromChange(ts, callId, rawPath, change);
            }
          }
        }
        return;
      }
      default:
        // task_started / task_complete / token_count / mcp_tool_call_end /
        // context_compacted etc. — no lore event.
        return;
    }
  }

  function processResponseItem(payload: unknown, ts: string, lineStr: string): void {
    if (!payload || typeof payload !== 'object') {
      recordSkip(`response_item without object payload: ${lineStr.slice(0, 80)}`);
      return;
    }
    const p = payload as { type?: string };
    switch (p.type) {
      case 'message': {
        // assistant text is captured via event_msg/agent_message; the
        // response_item copy is its streamed twin. We skip it to avoid dupes.
        // (role=user here is machine-injected context XML, also skipped.)
        return;
      }
      case 'function_call': {
        const fc = payload as FunctionCallPayload;
        if (fc.name !== 'exec_command') return;
        let cmd = '';
        let workdir: string | undefined;
        if (typeof fc.arguments === 'string') {
          try {
            const args = JSON.parse(fc.arguments) as { cmd?: string; workdir?: string };
            if (typeof args.cmd === 'string') cmd = args.cmd;
            if (typeof args.workdir === 'string') workdir = args.workdir;
          } catch {
            recordSkip(`function_call.arguments not JSON: ${lineStr.slice(0, 80)}`);
          }
        }
        if (!cmd) return;
        if (typeof fc.call_id === 'string') execCommands.set(fc.call_id, cmd);
        const ev: ShellExecEvent = {
          kind: 'shell-exec',
          sessionId,
          ts,
          seq: nextSeq(),
          command: cmd,
          description: workdir ?? null,
        };
        events.push(ev);
        return;
      }
      case 'function_call_output': {
        const fo = payload as FunctionCallOutputPayload;
        const callId = typeof fo.call_id === 'string' ? fo.call_id : null;
        if (!callId || typeof fo.output !== 'string') return;
        const cmd = execCommands.get(callId);
        if (!cmd || !/git\s+commit/.test(cmd)) return;
        const body = stripExecOutputPrefix(fo.output);
        const m = COMMIT_SHA_PATTERN.exec(body);
        if (m && m[1]) {
          const ev: GitCommitEvent = {
            kind: 'git-commit',
            sessionId,
            ts,
            seq: nextSeq(),
            sha: m[1],
          };
          events.push(ev);
        }
        return;
      }
      case 'custom_tool_call': {
        // SECONDARY file-edit path: DEFERRED. The companion patch_apply_end
        // (PRIMARY) usually follows this line, so we can't decide here whether
        // it will cover this call_id. Stash it; flush at end-of-file only when
        // no patch_apply_end claimed the same call_id (e.g. compaction dropped
        // the event_msg).
        const ct = payload as CustomToolCallPayload;
        if (ct.name !== 'apply_patch' || typeof ct.input !== 'string') return;
        const callId = typeof ct.call_id === 'string' ? ct.call_id : null;
        const files = parseApplyPatchEnvelope(ct.input);
        if (files.length > 0) {
          deferredEnvelopeEdits.push({ ts, callId, files });
        }
        return;
      }
      default:
        // reasoning / custom_tool_call_output / function_call_output for
        // non-commit commands — no lore event.
        return;
    }
  }

  function processSessionMeta(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as SessionMetaPayload;
    // cwd from FIRST occurrence (compaction repeats session_meta).
    if (cwd === null && typeof p.cwd === 'string' && p.cwd) cwd = p.cwd;
    if (sessionId && typeof p.id === 'string' && p.id) {
      // Prefer the explicit thread id over the filename-derived id.
      sessionId = p.id;
    }
    if (cliVersion === null && typeof p.cli_version === 'string') {
      cliVersion = p.cli_version;
    }
  }

  const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      recordSkip(`JSON parse error: ${trimmed.slice(0, 80)}`);
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      recordSkip(`Not an object: ${trimmed.slice(0, 80)}`);
      continue;
    }

    const obj = raw as RawLine;
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    noteTs(ts);

    switch (obj.type) {
      case 'session_meta':
        processSessionMeta(obj.payload);
        break;
      case 'event_msg':
        processEventMsg(obj.payload, ts, trimmed);
        break;
      case 'response_item':
        processResponseItem(obj.payload, ts, trimmed);
        break;
      case 'turn_context':
      case 'compacted':
        // No lore events. compacted is a hard boundary for completeness but we
        // keep parsing subsequent lines (they carry full tool-call data).
        break;
      default:
        recordSkip(`Unknown line type: ${String(obj.type)}`);
        break;
    }
  }

  // Flush deferred apply_patch envelopes that NO patch_apply_end covered.
  // These keep file-edit coverage when compaction dropped the event_msg.
  for (const d of deferredEnvelopeEdits) {
    if (d.callId && emittedPatchCallIds.has(d.callId)) continue;
    for (const ef of d.files) {
      const filePath = resolvePath(ef.filePath, cwd);
      const op: FileEditEvent['op'] = ef.op === 'update' ? 'edit' : 'write';
      const ev: FileEditEvent = {
        kind: 'file-edit',
        sessionId,
        ts: d.ts,
        seq: nextSeq(),
        toolUseId: d.callId,
        op,
        filePath,
        oldText: null,
        newText: ef.op === 'delete' ? '' : ef.newText,
        patch: null,
        userModified: null,
        succeeded: true,
      };
      events.push(ev);
    }
  }

  const meta: SessionMeta = {
    schemaVersion: SCHEMA_VERSION,
    agent: 'codex' as AgentKind,
    sessionId,
    cwd,
    gitBranch: null, // Codex rollout has no explicit git branch field.
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt,
    sourcePath: transcriptPath,
    agentVersion: cliVersion,
  };

  events.sort((a, b) => a.seq - b.seq);

  const session: ParsedSession = { meta, events };
  return {
    session,
    skipped: { count: skippedCount, samples: skippedSamples },
  };
}

// ---------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------

/**
 * Read just enough of a rollout file to find the first session_meta cwd,
 * without fully parsing. Returns null when no session_meta cwd is found in the
 * first handful of lines.
 */
async function peekCwd(filePath: string): Promise<string | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lineCount++;
      if (lineCount > 8) break; // session_meta is the first record in practice
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as RawLine;
      if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
        const cwd = (obj.payload as SessionMetaPayload).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

/**
 * True when `cwd` belongs to `repoPath`: identical, or a subdirectory of it
 * (covers a session run from inside the repo or a nested package dir).
 */
function cwdMatchesRepo(cwd: string, repoPath: string): boolean {
  const a = path.resolve(cwd);
  const b = path.resolve(repoPath);
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Recursively collect rollout-*.jsonl files under ~/.codex/sessions. */
async function collectRolloutFiles(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith('.jsonl')
    ) {
      out.push(full);
    }
  }
}

async function discoverTranscripts(repoPath: string, broad: boolean): Promise<string[]> {
  const sessionsRoot = path.join(os.homedir(), ...SESSIONS_GLOB_ROOT);
  const all: string[] = [];
  await collectRolloutFiles(sessionsRoot, all);

  if (broad) return all;

  const matched: string[] = [];
  for (const f of all) {
    const cwd = await peekCwd(f);
    if (cwd && cwdMatchesRepo(cwd, repoPath)) {
      matched.push(f);
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// TranscriptParser implementation
// ---------------------------------------------------------------------------

export const codexParser: TranscriptParser = {
  agent: 'codex',

  async discover(repoPath: string, opts?: { broad?: boolean }): Promise<string[]> {
    return discoverTranscripts(repoPath, opts?.broad === true);
  },

  async parse(transcriptPath: string): Promise<ParseResult> {
    return parseFile(transcriptPath);
  },
};

/** Named export `parser` expected by cli.ts dynamic import. */
export const parser: TranscriptParser = codexParser;

export default codexParser;
