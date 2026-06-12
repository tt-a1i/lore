/**
 * claude-cli 蒸馏后端 —— shell 出 `claude -p` 做语义蒸馏。
 *
 * 设计：
 * - 用户装了 Claude Code 就能用，零 API key 配置（available() 探 `claude --version`）。
 * - 每 session 一次调用：把 SessionDigest（user 全文 + assistant 关键消息 + commits）
 *   组成 prompt，要求模型抽 decision / constraint / rejected-approach，严格 JSON 输出。
 * - `claude -p --output-format json` 返回一个 envelope（{type,result,...}），真正的
 *   模型文本在 .result 字段——必须先 JSON.parse envelope，再从 result 里宽容解析 LLM JSON。
 * - 容错铁律（见 Distiller 契约）：任何解析失败都返回空 notes + error，绝不抛异常，
 *   否则会中断 orchestrate 的批量蒸馏。
 *
 * exec 层依赖注入：构造函数可注入一个 execFile 风格的函数，便于单测 mock，
 * 不真实调用 claude CLI。
 */

import { execFile } from 'node:child_process';

import type { Distiller, DistillInput, DistilledNote } from './types.js';

/** 注入用的 execFile 形态（promisify 后的子集，只用我们需要的字段）。 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** 默认 exec：promisify(execFile)，不引第三方。 */
const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** 蒸馏用的模型（便宜、快）。 */
export const DISTILL_MODEL = 'claude-haiku-4-5-20251001';

/** execFile 的 maxBuffer：LLM JSON 可能不小，给足 16MB。 */
const MAX_BUFFER = 16 * 1024 * 1024;

/** 单次蒸馏超时（ms）：本地 CLI 偶尔卡住，给 3min 上限避免批量永久挂起。 */
const DISTILL_TIMEOUT = 180_000;

/** 蒸馏器期望模型吐出的形态（id/时间由调用方分配，这里只要 kind/title/body/files/anchors）。 */
type RawNote = Omit<
  DistilledNote,
  'id' | 'sessionId' | 'validAt' | 'invalidAt' | 'supersededBy'
>;

/**
 * Prompt 模板（导出常量，便于测试与迭代）。
 * 输入用占位符填充：{{COMMITS}} {{FILES}} {{EXISTING}} {{MESSAGES}}。
 */
export const DISTILL_PROMPT_TEMPLATE = `You are a software-archaeology distiller. You read a condensed transcript of one AI-agent coding session (its user messages, the agent's key replies, the files it edited, and the git commits it produced) and extract the *durable engineering knowledge* that future developers or agents would need.

Extract three kinds of notes:
  - "decision": a concrete choice that was made and acted on (an approach, a design, a library, a config). Body must state WHAT was decided and WHY.
  - "constraint": a rule, invariant, requirement, or limitation that must hold going forward (e.g. "must stay zero-dependency", "API key must never be logged"). Body states the rule and its rationale.
  - "rejected-approach": an approach that was explicitly considered and NOT taken. Body MUST include the reason it was rejected.

STRICT RULES:
  - Only extract notes backed by *substantive* evidence in the transcript. If the session has no real engineering decision/constraint/rejected approach, return an EMPTY notes array. Prefer too few over too many — do NOT invent, do NOT pad, do NOT restate trivial mechanics ("ran the tests", "fixed a typo").
  - Each note's "title" is one line, <= 80 chars.
  - Each note's "body" is 2-4 sentences: content + why. For "rejected-approach" the reason for rejection is mandatory.
  - "files" is an array of repo-relative paths the note concerns (use the EDITED FILES list; may be empty).
  - "anchors" point back to the conversation: an array of message sequence numbers (the "seq" field). EVERY seq you put in anchors MUST be a seq that literally appears in the MESSAGES section below. Never invent a seq. Anchor each note to the 1-3 messages that best evidence it.
  - You are also given EXISTING NOTES (currently-valid notes touching the same files). If a new note you extract *supersedes* (overturns, replaces, or contradicts) one of them, put that existing note's "id" into the top-level "supersededIds" array. Only supersede on a genuine reversal — not mere elaboration.

OUTPUT FORMAT — return ONLY a single JSON object, no prose, no markdown fences:
{
  "notes": [
    {
      "kind": "decision" | "constraint" | "rejected-approach",
      "title": "string",
      "body": "string",
      "files": ["string", ...],
      "anchors": [{ "seq": <number> }, ...]
    }
  ],
  "supersededIds": ["existing-note-id", ...]
}

If there is nothing worth distilling, return {"notes": [], "supersededIds": []}.

=== COMMITS PRODUCED ===
{{COMMITS}}

=== EDITED FILES ===
{{FILES}}

=== EXISTING NOTES (same files, currently valid) ===
{{EXISTING}}

=== MESSAGES (seq | role | text) ===
{{MESSAGES}}
`;

/** 用 digest + existingNotes 渲染最终 prompt。导出供测试断言。 */
export function buildPrompt(input: DistillInput): string {
  const { digest, existingNotes } = input;

  const commitsBlock =
    digest.commits.length > 0
      ? digest.commits.map((c) => `- ${c.hash} ${c.subject}`).join('\n')
      : '(none)';

  const filesBlock =
    digest.editedFiles.length > 0 ? digest.editedFiles.map((f) => `- ${f}`).join('\n') : '(none)';

  const existingBlock =
    existingNotes.length > 0
      ? existingNotes
          .map((n) => {
            const files = n.files.length > 0 ? n.files.join(', ') : '(no files)';
            return `- id=${n.id} kind=${n.kind} files=[${files}]\n  title: ${n.title}`;
          })
          .join('\n')
      : '(none)';

  const messagesBlock =
    digest.messages.length > 0
      ? digest.messages.map((m) => `[seq=${m.seq}] ${m.role}: ${m.text}`).join('\n\n')
      : '(none)';

  return DISTILL_PROMPT_TEMPLATE.replace('{{COMMITS}}', commitsBlock)
    .replace('{{FILES}}', filesBlock)
    .replace('{{EXISTING}}', existingBlock)
    .replace('{{MESSAGES}}', messagesBlock);
}

/**
 * 从 `claude -p --output-format json` 的 stdout 提取模型文本。
 * envelope 形如 {"type":"result","subtype":"success","result":"<模型文本>",...}。
 * 解析失败时退回原始 stdout（兼容未来 CLI 可能直接吐文本的情况）。
 */
export function extractResultText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const env = JSON.parse(trimmed) as unknown;
    if (env && typeof env === 'object' && 'result' in env) {
      const r = (env as { result: unknown }).result;
      if (typeof r === 'string') return r;
    }
  } catch {
    // 不是合法 envelope JSON——当作模型直接吐了文本。
  }
  return trimmed;
}

/**
 * 宽容解析 LLM 文本里的 JSON：
 *  1. 剥 ```json ... ``` / ``` ... ``` 围栏。
 *  2. 找第一个 `{` 或 `[` 起、能括号配平的合法 JSON 子串。
 * 返回 parse 后的对象；失败返回 null。
 */
export function lenientJsonParse(text: string): unknown {
  let t = text.trim();
  if (!t) return null;

  // 剥围栏：```json\n...\n``` 或 ```\n...\n```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence && fence[1]) {
    t = fence[1].trim();
  }

  // 直接尝试整体 parse。
  try {
    return JSON.parse(t);
  } catch {
    // 落到子串扫描。
  }

  // 找首个 { 或 [，做括号配平扫描（跳过字符串字面量内的括号）。
  const startIdx = firstJsonStart(t);
  if (startIdx === -1) return null;

  const candidate = extractBalanced(t, startIdx);
  if (candidate === null) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function firstJsonStart(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[') return i;
  }
  return -1;
}

/** 从 startIdx（{ 或 [）起，做括号配平扫描，返回配平子串或 null。 */
function extractBalanced(s: string, startIdx: number): string | null {
  const open = s[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = startIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(startIdx, i + 1);
    }
  }
  return null;
}

const VALID_KINDS = new Set(['decision', 'constraint', 'rejected-approach']);

/**
 * 把解析后的对象规整成 { notes, supersededIds }。
 * 对每条 note 做结构校验 + anchors.seq 必须存在于 digest.messages 的真实 seq 集合，
 * 不合格的 note 整条丢弃（宁缺毋滥）。anchors 里非法 seq 过滤掉，全非法则丢该 note。
 */
export function coerceDistillOutput(
  parsed: unknown,
  validSeqs: Set<number>,
): { notes: RawNote[]; supersededIds: string[] } {
  const notes: RawNote[] = [];
  const supersededIds: string[] = [];

  if (!parsed || typeof parsed !== 'object') {
    return { notes, supersededIds };
  }

  const obj = parsed as Record<string, unknown>;

  const rawNotes = Array.isArray(obj.notes) ? obj.notes : [];
  for (const rn of rawNotes) {
    const coerced = coerceNote(rn, validSeqs);
    if (coerced) notes.push(coerced);
  }

  const rawSup = Array.isArray(obj.supersededIds) ? obj.supersededIds : [];
  for (const s of rawSup) {
    if (typeof s === 'string' && s.length > 0) supersededIds.push(s);
  }

  return { notes, supersededIds };
}

function coerceNote(rn: unknown, validSeqs: Set<number>): RawNote | null {
  if (!rn || typeof rn !== 'object') return null;
  const o = rn as Record<string, unknown>;

  const kind = o.kind;
  if (typeof kind !== 'string' || !VALID_KINDS.has(kind)) return null;

  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  if (!title || !body) return null;

  const files: string[] = [];
  if (Array.isArray(o.files)) {
    for (const f of o.files) {
      if (typeof f === 'string' && f.trim()) files.push(f.trim());
    }
  }

  // anchors：每个 seq 必须存在于 digest.messages 的真实 seq 集合。
  const anchors: { sessionId: string; seq: number }[] = [];
  if (Array.isArray(o.anchors)) {
    for (const a of o.anchors) {
      const seq = extractSeq(a);
      if (seq !== null && validSeqs.has(seq)) {
        // sessionId 由调用方在 orchestrate 里补齐；这里占位空串，
        // 但契约 anchors 需 sessionId——orchestrate 会回填。先放空。
        anchors.push({ sessionId: '', seq });
      }
    }
  }
  // 无有效锚点的 note 丢弃：没有回到原文的地址就没有审计价值。
  if (anchors.length === 0) return null;

  return {
    kind: kind as RawNote['kind'],
    title: title.slice(0, 80),
    body,
    files,
    anchors,
  };
}

/** anchors 元素可能是 number 或 {seq:number}。 */
function extractSeq(a: unknown): number | null {
  if (typeof a === 'number' && Number.isFinite(a)) return a;
  if (a && typeof a === 'object' && 'seq' in a) {
    const s = (a as { seq: unknown }).seq;
    if (typeof s === 'number' && Number.isFinite(s)) return s;
  }
  return null;
}

export class ClaudeCliDistiller implements Distiller {
  readonly name = 'claude-cli';

  constructor(private readonly exec: ExecFn = defaultExec) {}

  async available(): Promise<boolean> {
    try {
      await this.exec('claude', ['--version'], { maxBuffer: 1024 * 1024, timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  async distill(input: DistillInput): Promise<{
    notes: RawNote[];
    supersededIds: string[];
    error?: string;
  }> {
    const validSeqs = new Set(input.digest.messages.map((m) => m.seq));
    const prompt = buildPrompt(input);

    let stdout: string;
    try {
      const res = await this.exec(
        'claude',
        ['-p', prompt, '--output-format', 'json', '--model', DISTILL_MODEL],
        { maxBuffer: MAX_BUFFER, timeout: DISTILL_TIMEOUT },
      );
      stdout = res.stdout;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { notes: [], supersededIds: [], error: `claude CLI failed: ${msg}` };
    }

    const resultText = extractResultText(stdout);
    const parsed = lenientJsonParse(resultText);
    if (parsed === null) {
      return {
        notes: [],
        supersededIds: [],
        error: 'could not parse JSON from claude output',
      };
    }

    return coerceDistillOutput(parsed, validSeqs);
  }
}

/** Named export for symmetry with other modules' self-wiring style. */
export const distiller: Distiller = new ClaudeCliDistiller();

export default ClaudeCliDistiller;
