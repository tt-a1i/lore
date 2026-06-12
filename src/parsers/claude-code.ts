/**
 * Claude Code transcript parser.
 *
 * Implements TranscriptParser for agent='claude-code'.
 * Parses ~/.claude/projects/<encoded-path>/<sessionUuid>.jsonl and
 * <sessionUuid>/subagents/ (recursive) agent-*.jsonl.
 *
 * See docs/research/transcript-format.md for the authoritative format spec.
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
  type SessionMeta,
  type ShellExecEvent,
  type TranscriptParser,
  type UserMessageEvent,
  type AssistantMessageEvent,
  type PatchHunk,
} from '../schema/events.js';

// ---------------------------------------------------------------------------
// Raw JSONL line shapes (permissive — extra keys are ignored)
// ---------------------------------------------------------------------------

interface RawBase {
  type: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  agentId?: string;
}

interface RawUserLine extends RawBase {
  type: 'user';
  message?: {
    role?: string;
    content?: unknown; // string | ContentBlock[]
  };
  toolUseResult?: RawToolUseResult;
}

interface RawAssistantLine extends RawBase {
  type: 'assistant';
  message?: {
    role?: string;
    content?: RawContentBlock[];
    stop_reason?: string | null;
    model?: string;
  };
}

interface RawContentBlock {
  type: string;
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: RawToolUseInput;
  // tool_result block
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawToolUseInput {
  // Edit
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  // Write
  content?: string;
  // Bash
  command?: string;
  description?: string;
}

interface RawToolUseResult {
  type?: string; // "create" | "update" | "text" | "error" | …
  filePath?: string;
  content?: string;
  structuredPatch?: RawPatchHunk[];
  originalFile?: string | null;
  userModified?: boolean;
  // 无 type 字段的 Edit 变体（v2.1.x 实测主力形态）：
  // { filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll }
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  gitOperation?: {
    commit?: { sha?: string; kind?: string };
    push?: { branch?: string };
    pr?: { number?: number; action?: string };
  };
}

interface RawPatchHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: string[];
}

/**
 * 无 pendingTu 时从 toolUseResult 自身推断 op：
 * - type: "create" → write；type: "update" → edit
 * - 无 type 变体：有 oldString（Edit 形态）→ edit；originalFile 为 null（新建）→ write；其余 → edit
 */
function inferOp(
  turType: string | undefined,
  tur: RawToolUseResult
): 'edit' | 'write' {
  if (turType === 'create') return 'write';
  if (turType === 'update') return 'edit';
  if (tur.oldString !== undefined) return 'edit';
  if (tur.originalFile === null) return 'write';
  return 'edit';
}

// ---------------------------------------------------------------------------
// Internal state kept while streaming a file
// ---------------------------------------------------------------------------

interface PendingToolUse {
  toolUseId: string;
  name: string; // "Edit" | "Write" | …
  filePath: string;
  oldString: string | null; // Edit: old_string; Write: null
  newString: string;        // Edit: new_string; Write: content
}

interface AssistantDelta {
  parentUuid: string;
  // We accumulate across streaming chunks; only committed on stop_reason != null
  textBlocks: string[];
  toolUses: PendingToolUse[];
  stopReason: string | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeProjectPath(repoPath: string): string {
  // Replace every '/' with '-'
  return repoPath.replace(/\//g, '-');
}

function normalizePatch(raw: RawPatchHunk[]): PatchHunk[] {
  return raw.map((h) => ({
    oldStart: h.oldStart ?? 0,
    oldLines: h.oldLines ?? 0,
    newStart: h.newStart ?? 0,
    newLines: h.newLines ?? 0,
    lines: h.lines ?? [],
  }));
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as RawContentBlock).type === 'text') {
        const txt = (block as RawContentBlock).text;
        if (typeof txt === 'string') parts.push(txt);
      }
    }
    return parts.join('').trim() || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core streaming parse logic
// ---------------------------------------------------------------------------

async function parseFile(
  transcriptPath: string,
  isSidechain: boolean,
): Promise<ParseResult> {
  let sessionId = path.basename(transcriptPath, '.jsonl');
  // For subagent files the sessionId is the parent session uuid (directory name)
  if (isSidechain) {
    // path: <dir>/<sessionUuid>/subagents/**/agent-*.jsonl
    // We want the <sessionUuid> part
    const parts = transcriptPath.split(path.sep);
    const subagentsIdx = parts.lastIndexOf('subagents');
    if (subagentsIdx > 0) {
      sessionId = parts[subagentsIdx - 1] ?? sessionId;
    }
  }

  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  const events: LoreEvent[] = [];
  let seq = 0;

  // assistant streaming accumulation: parentUuid → delta
  const assistantDeltas = new Map<string, AssistantDelta>();

  // pending tool_use data from assistant, by toolUseId
  const pendingToolUses = new Map<string, PendingToolUse>();

  // For producing events from assistant deltas in the right order we need
  // to flush them when we see the corresponding user tool_result line.
  // We also flush on encountering the next user message that is NOT a tool_result.

  // We process lines in order; accumulate assistant deltas; flush when:
  //   - We see a user line whose parentUuid matches the delta's parentUuid (tool results batch)
  //   - Or we see any user non-tool-result message (ordering: flush all pending)

  const skippedSamples: string[] = [];
  let skippedCount = 0;

  function recordSkip(reason: string): void {
    skippedCount++;
    if (skippedSamples.length < 5) {
      skippedSamples.push(reason.slice(0, 200));
    }
  }

  function nextSeq(): number {
    return seq++;
  }

  function flushAssistantDelta(delta: AssistantDelta): void {
    const ts = delta.timestamp;

    // Emit assistant-message if there's text content
    const text = delta.textBlocks.join('').trim();
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

    // Emit shell-exec events for Bash tool_uses
    for (const tu of delta.toolUses) {
      if (tu.name === 'Bash') {
        const ev: ShellExecEvent = {
          kind: 'shell-exec',
          sessionId,
          ts,
          seq: nextSeq(),
          command: tu.newString, // We stored command in newString for Bash
          description: tu.oldString, // We stored description in oldString for Bash
        };
        events.push(ev);
      }
    }
  }

  function flushAllDeltas(): void {
    // Flush in insertion order
    for (const [parentUuid, delta] of assistantDeltas) {
      if (delta.stopReason !== null) {
        flushAssistantDelta(delta);
      }
      assistantDeltas.delete(parentUuid);
    }
  }

  function processUserLine(raw: RawUserLine, lineStr: string): void {
    const ts = raw.timestamp ?? '';
    if (!ts) {
      // Likely a metadata line without timestamp (ai-title etc.); skip silently
      return;
    }

    // Track session metadata
    if (raw.sessionId) sessionId = raw.sessionId;
    if (raw.cwd && !cwd) cwd = raw.cwd;
    if (raw.gitBranch && !gitBranch) gitBranch = raw.gitBranch;
    if (raw.version && !version) version = raw.version;
    if (!startedAt) startedAt = ts;
    endedAt = ts;

    // isMeta=true: harness-injected; skip as user-message but toolUseResult may still be valid
    const isMeta = raw.isMeta === true || raw.isCompactSummary === true;

    // --- Process toolUseResult (file edits, git commits) ---
    const tur = raw.toolUseResult;
    if (tur) {
      // Git commit anchor (Tier-0)
      if (tur.gitOperation?.commit?.sha) {
        const ev: GitCommitEvent = {
          kind: 'git-commit',
          sessionId,
          ts,
          seq: nextSeq(),
          sha: tur.gitOperation.commit.sha,
        };
        events.push(ev);
      }

      // File edit —— 两种实测形态：
      // a) 带 type 的：{ type: "create"|"update", filePath, content, structuredPatch, … }
      // b) 无 type 的（v2.1.x Edit 主力形态）：
      //    { filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll }
      const turType = tur.type;
      const isTypedEdit =
        (turType === 'create' || turType === 'update') && typeof tur.filePath === 'string';
      const isTypelessEdit =
        turType === undefined &&
        typeof tur.filePath === 'string' &&
        (tur.structuredPatch !== undefined ||
          tur.newString !== undefined ||
          tur.originalFile !== undefined);
      if ((isTypedEdit || isTypelessEdit) && typeof tur.filePath === 'string') {
        // Find the corresponding tool_use in message.content[] to get toolUseId
        // The message.content[] may have tool_result blocks referencing toolu_X
        let toolUseId: string | null = null;
        let pendingTu: PendingToolUse | null = null;

        // Try to find via tool_result block in message.content
        const msgContent = raw.message?.content;
        if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (
              block &&
              typeof block === 'object' &&
              (block as RawContentBlock).type === 'tool_result'
            ) {
              const trBlock = block as RawContentBlock;
              const tuId = trBlock.tool_use_id;
              if (tuId && pendingToolUses.has(tuId)) {
                const candidate = pendingToolUses.get(tuId)!;
                if (
                  candidate.filePath === tur.filePath ||
                  candidate.name === 'Edit' ||
                  candidate.name === 'Write'
                ) {
                  toolUseId = tuId;
                  pendingTu = candidate;
                  pendingToolUses.delete(tuId);
                  break;
                }
              }
            }
          }
        }

        // Fallback: look for any pending tool_use matching the filePath
        if (!pendingTu) {
          for (const [tuId, tu] of pendingToolUses) {
            if (tu.filePath === tur.filePath && (tu.name === 'Edit' || tu.name === 'Write')) {
              toolUseId = tuId;
              pendingTu = tu;
              pendingToolUses.delete(tuId);
              break;
            }
          }
        }

        // Determine op
        let op: FileEditEvent['op'];
        if (pendingTu) {
          if (pendingTu.name === 'Edit') op = 'edit';
          else if (pendingTu.name === 'Write') op = 'write';
          else if (pendingTu.name === 'MultiEdit') op = 'multi-edit';
          else if (pendingTu.name === 'NotebookEdit') op = 'notebook-edit';
          else op = inferOp(turType, tur);
        } else {
          op = inferOp(turType, tur);
          toolUseId = null;
        }

        const patch = tur.structuredPatch ? normalizePatch(tur.structuredPatch) : null;
        const oldText = pendingTu?.oldString ?? tur.oldString ?? null;
        const newText =
          pendingTu?.newString ?? tur.newString ?? tur.content ?? '';
        const userModified = typeof tur.userModified === 'boolean' ? tur.userModified : null;

        const ev: FileEditEvent = {
          kind: 'file-edit',
          sessionId,
          ts,
          seq: nextSeq(),
          toolUseId,
          op,
          filePath: tur.filePath,
          oldText,
          newText,
          patch,
          userModified,
          succeeded: true, // toolUseResult present means success unless is_error
        };
        events.push(ev);
      }
    }

    // --- Fallback：subagent/workflow transcript 没有 toolUseResult 侧通道 ---
    // 它们的编辑只有 assistant tool_use 的 input。看到对应 tool_result（任意形态）
    // 即用暂存的 input 发 file-edit（patch=null，匹配引擎退 newText 行集）。
    // 主链场景中上面的 toolUseResult 分支已消费掉 pending，不会重复发。
    {
      const msgContent = raw.message?.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (!block || typeof block !== 'object') continue;
          const b = block as RawContentBlock;
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          const pending = pendingToolUses.get(b.tool_use_id);
          if (!pending) continue;
          if (
            pending.name !== 'Edit' &&
            pending.name !== 'Write' &&
            pending.name !== 'MultiEdit' &&
            pending.name !== 'NotebookEdit'
          ) {
            continue;
          }
          pendingToolUses.delete(b.tool_use_id);
          const op: FileEditEvent['op'] =
            pending.name === 'Write'
              ? 'write'
              : pending.name === 'MultiEdit'
                ? 'multi-edit'
                : pending.name === 'NotebookEdit'
                  ? 'notebook-edit'
                  : 'edit';
          const ev: FileEditEvent = {
            kind: 'file-edit',
            sessionId,
            ts,
            seq: nextSeq(),
            toolUseId: b.tool_use_id,
            op,
            filePath: pending.filePath,
            oldText: pending.oldString,
            newText: pending.newString,
            patch: null,
            userModified: null,
            succeeded: b.is_error === true ? false : true,
          };
          events.push(ev);
        }
      }
    }

    // --- User message (intent) ---
    if (!isMeta) {
      const msgContent = raw.message?.content;
      const text = extractTextFromContent(msgContent);
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
    }
  }

  function processAssistantLine(raw: RawAssistantLine, lineStr: string): void {
    const ts = raw.timestamp ?? '';
    if (!ts) return;

    // Track session metadata
    if (raw.sessionId) sessionId = raw.sessionId;
    if (raw.cwd && !cwd) cwd = raw.cwd;
    if (raw.gitBranch && !gitBranch) gitBranch = raw.gitBranch;
    if (raw.version && !version) version = raw.version;
    if (!startedAt) startedAt = ts;
    endedAt = ts;

    const parentUuid = raw.parentUuid ?? raw.uuid ?? '';
    const stopReason = raw.message?.stop_reason ?? null;
    const blocks: RawContentBlock[] = raw.message?.content ?? [];

    let delta = assistantDeltas.get(parentUuid);
    if (!delta) {
      delta = {
        parentUuid,
        textBlocks: [],
        toolUses: [],
        stopReason: null,
        timestamp: ts,
      };
      assistantDeltas.set(parentUuid, delta);
    }

    // Update timestamp to latest chunk
    delta.timestamp = ts;

    // Accumulate content
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        delta.textBlocks.push(block.text);
      } else if (block.type === 'tool_use' && block.id && block.name) {
        const input = block.input ?? {};
        const tuName = block.name;
        let tu: PendingToolUse;

        if (tuName === 'Bash') {
          // Special: store command/description
          tu = {
            toolUseId: block.id,
            name: 'Bash',
            filePath: '',
            oldString: typeof input.description === 'string' ? input.description : null,
            newString: typeof input.command === 'string' ? input.command : '',
          };
        } else {
          const filePath = typeof input.file_path === 'string' ? input.file_path : '';
          let oldString: string | null = null;
          let newString = '';

          if (tuName === 'Edit') {
            oldString = typeof input.old_string === 'string' ? input.old_string : null;
            newString = typeof input.new_string === 'string' ? input.new_string : '';
          } else if (tuName === 'Write') {
            oldString = null;
            newString = typeof input.content === 'string' ? input.content : '';
          } else if (tuName === 'MultiEdit' || tuName === 'NotebookEdit') {
            // Defensive: unknown shape, capture what we can
            oldString = null;
            newString = '';
          }

          tu = {
            toolUseId: block.id,
            name: tuName,
            filePath,
            oldString,
            newString,
          };
        }

        delta.toolUses.push(tu);
        // Register in pendingToolUses for cross-reference with user tool_result
        if (tuName !== 'Bash') {
          pendingToolUses.set(block.id, tu);
        }
      }
    }

    if (stopReason !== null) {
      delta.stopReason = stopReason;
      // Flush immediately — all chunks for this parentUuid are done
      flushAssistantDelta(delta);
      assistantDeltas.delete(parentUuid);
    }
  }

  // Stream the file line by line
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

    const obj = raw as RawBase;
    const lineType = obj.type;

    if (lineType === 'user') {
      // Flush any completed assistant deltas first (ordering: assistant before its follow-up user)
      // Note: we flush selectively on stop_reason in processAssistantLine;
      // here we flush any that got stuck (e.g., no stop_reason encountered)
      processUserLine(obj as RawUserLine, trimmed);
    } else if (lineType === 'assistant') {
      processAssistantLine(obj as RawAssistantLine, trimmed);
    } else {
      // system, attachment, ai-title, custom-title, last-prompt, mode, etc.
      // Silently skip — these are documented to be ignored
    }
  }

  // Flush any remaining assistant deltas that never got a stop_reason
  for (const [, delta] of assistantDeltas) {
    if (delta.textBlocks.length > 0 || delta.toolUses.length > 0) {
      // Emit what we have
      delta.stopReason = 'end_turn'; // synthetic
      flushAssistantDelta(delta);
    }
  }

  const meta: SessionMeta = {
    schemaVersion: SCHEMA_VERSION,
    agent: 'claude-code' as AgentKind,
    sessionId,
    cwd,
    gitBranch,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt,
    sourcePath: transcriptPath,
    agentVersion: version,
  };

  // Sort events by seq (they should already be in order, but re-sort to be safe)
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

async function discoverTranscripts(repoPath: string, broad = false): Promise<string[]> {
  if (!broad) {
    const encoded = encodeProjectPath(repoPath);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
    return discoverInProjectDir(projectDir);
  }

  // broad 模式：扫全部项目目录。session 常跑在 worktree（如 /tmp/hive-pr15）里，
  // transcript 落在按 cwd 命名的其他项目目录下，只扫本仓库目录会漏掉它们。
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const found = await discoverInProjectDir(path.join(projectsRoot, d.name));
    results.push(...found);
  }
  return results;
}

async function discoverInProjectDir(projectDir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch {
    // Directory does not exist or is not accessible
    return [];
  }

  const results: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      // Main-chain transcript
      results.push(path.join(projectDir, entry.name));
    } else if (entry.isDirectory()) {
      // Potential session directory — look for subagents
      const sessionDir = path.join(projectDir, entry.name);
      await collectSubagentFiles(sessionDir, results);
    }
  }

  return results;
}

async function collectSubagentFiles(
  sessionDir: string,
  results: string[],
): Promise<void> {
  const subagentsDir = path.join(sessionDir, 'subagents');
  let subEntries: fs.Dirent[];
  try {
    subEntries = await fs.promises.readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of subEntries) {
    if (entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
      results.push(path.join(subagentsDir, entry.name));
    } else if (entry.isDirectory()) {
      // Recurse into subdirectories (e.g., workflows/wf_*/agent-*.jsonl)
      await collectSubagentFilesRecursive(path.join(subagentsDir, entry.name), results);
    }
  }
}

async function collectSubagentFilesRecursive(dir: string, results: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      // Skip journal.jsonl
      if (entry.name === 'journal.jsonl') continue;
      if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
        results.push(path.join(dir, entry.name));
      }
    } else if (entry.isDirectory()) {
      await collectSubagentFilesRecursive(path.join(dir, entry.name), results);
    }
  }
}

// ---------------------------------------------------------------------------
// TranscriptParser implementation
// ---------------------------------------------------------------------------

export const claudeCodeParser: TranscriptParser = {
  agent: 'claude-code',

  async discover(repoPath: string, opts?: { broad?: boolean }): Promise<string[]> {
    return discoverTranscripts(repoPath, opts?.broad === true);
  },

  async parse(transcriptPath: string): Promise<ParseResult> {
    // Determine if this is a sidechain file based on path
    const isSidechain = transcriptPath.includes(`${path.sep}subagents${path.sep}`);
    return parseFile(transcriptPath, isSidechain);
  },
};

/** Named export `parser` expected by cli.ts dynamic import. */
export const parser: TranscriptParser = claudeCodeParser;

export default claudeCodeParser;
