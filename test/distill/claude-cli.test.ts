/**
 * ClaudeCliDistiller 单测 —— 全程 mock exec（依赖注入），不真实调用 claude CLI。
 * 覆盖：正常 JSON envelope、带 ```json 围栏、坏输出降级、envelope 解析、
 * anchors seq 校验、available()。
 */

import { describe, it, expect } from 'vitest';

import {
  ClaudeCliDistiller,
  buildPrompt,
  extractResultText,
  lenientJsonParse,
  coerceDistillOutput,
  DISTILL_MODEL,
  type ExecFn,
} from '../../src/distill/claude-cli.js';
import type { DistillInput, DistilledNote } from '../../src/distill/types.js';

function digestInput(overrides: Partial<DistillInput['digest']> = {}): DistillInput {
  return {
    digest: {
      sessionId: 'sess-1',
      agent: 'claude-code',
      startedAt: '2026-06-01T10:00:00Z',
      messages: [
        { seq: 1, role: 'user', text: 'use kuzu embedded graph, zero native deps fallback' },
        { seq: 4, role: 'assistant', text: 'I chose kuzu because it is embedded and fast.' },
      ],
      editedFiles: ['src/graph/kuzu-store.ts'],
      commits: [{ hash: 'abc1234', subject: 'add kuzu store' }],
      ...overrides,
    },
    existingNotes: [],
  };
}

/** envelope 包装 LLM 文本（模拟 claude -p --output-format json 的 stdout）。 */
function envelope(resultText: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resultText,
  });
}

function makeExec(stdout: string): ExecFn {
  return async () => ({ stdout, stderr: '' });
}

const VALID_NOTE_JSON = JSON.stringify({
  notes: [
    {
      kind: 'decision',
      title: 'Use Kuzu embedded graph',
      body: 'Chose Kuzu for the graph store because it is embedded and fast. JSON fallback covers zero-native-dep environments.',
      files: ['src/graph/kuzu-store.ts'],
      anchors: [{ seq: 1 }, { seq: 4 }],
    },
  ],
  supersededIds: [],
});

describe('extractResultText', () => {
  it('pulls .result out of the json envelope', () => {
    expect(extractResultText(envelope('hello world'))).toBe('hello world');
  });

  it('falls back to raw stdout when not an envelope', () => {
    expect(extractResultText('plain text')).toBe('plain text');
  });

  it('returns empty for empty stdout', () => {
    expect(extractResultText('   ')).toBe('');
  });
});

describe('lenientJsonParse', () => {
  it('parses plain JSON', () => {
    expect(lenientJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    const txt = 'Here you go:\n```json\n{"a": 2}\n```\nthanks';
    expect(lenientJsonParse(txt)).toEqual({ a: 2 });
  });

  it('strips bare ``` fences', () => {
    expect(lenientJsonParse('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('finds first balanced object amid prose', () => {
    const txt = 'Sure. {"notes": [], "supersededIds": []} done.';
    expect(lenientJsonParse(txt)).toEqual({ notes: [], supersededIds: [] });
  });

  it('handles braces inside strings', () => {
    const txt = 'x {"body": "use { and } chars"} y';
    expect(lenientJsonParse(txt)).toEqual({ body: 'use { and } chars' });
  });

  it('returns null on garbage', () => {
    expect(lenientJsonParse('not json at all')).toBeNull();
    expect(lenientJsonParse('')).toBeNull();
  });
});

describe('coerceDistillOutput', () => {
  const validSeqs = new Set([1, 4]);

  it('keeps a well-formed note', () => {
    const parsed = JSON.parse(VALID_NOTE_JSON);
    const out = coerceDistillOutput(parsed, validSeqs);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]!.kind).toBe('decision');
    expect(out.notes[0]!.anchors.map((a) => a.seq)).toEqual([1, 4]);
    expect(out.supersededIds).toEqual([]);
  });

  it('drops notes whose anchors are all invalid seqs', () => {
    const parsed = {
      notes: [
        {
          kind: 'decision',
          title: 't',
          body: 'b',
          files: [],
          anchors: [{ seq: 999 }],
        },
      ],
      supersededIds: [],
    };
    expect(coerceDistillOutput(parsed, validSeqs).notes).toHaveLength(0);
  });

  it('filters out invalid seqs but keeps note if at least one valid', () => {
    const parsed = {
      notes: [
        { kind: 'constraint', title: 't', body: 'b', files: [], anchors: [{ seq: 1 }, { seq: 999 }] },
      ],
      supersededIds: [],
    };
    const out = coerceDistillOutput(parsed, validSeqs);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]!.anchors.map((a) => a.seq)).toEqual([1]);
  });

  it('accepts bare-number anchors', () => {
    const parsed = {
      notes: [{ kind: 'decision', title: 't', body: 'b', files: [], anchors: [1, 4] }],
      supersededIds: [],
    };
    expect(coerceDistillOutput(parsed, validSeqs).notes[0]!.anchors.map((a) => a.seq)).toEqual([1, 4]);
  });

  it('drops notes with invalid kind / missing title / missing body', () => {
    const parsed = {
      notes: [
        { kind: 'bogus', title: 't', body: 'b', files: [], anchors: [{ seq: 1 }] },
        { kind: 'decision', title: '', body: 'b', files: [], anchors: [{ seq: 1 }] },
        { kind: 'decision', title: 't', body: '', files: [], anchors: [{ seq: 1 }] },
      ],
      supersededIds: [],
    };
    expect(coerceDistillOutput(parsed, validSeqs).notes).toHaveLength(0);
  });

  it('collects valid supersededIds', () => {
    const parsed = { notes: [], supersededIds: ['s#0', 's#1', 123, ''] };
    expect(coerceDistillOutput(parsed, validSeqs).supersededIds).toEqual(['s#0', 's#1']);
  });

  it('truncates title to 80 chars', () => {
    const longTitle = 'x'.repeat(120);
    const parsed = {
      notes: [{ kind: 'decision', title: longTitle, body: 'b', files: [], anchors: [{ seq: 1 }] }],
      supersededIds: [],
    };
    expect(coerceDistillOutput(parsed, validSeqs).notes[0]!.title).toHaveLength(80);
  });

  it('returns empty for non-object input', () => {
    expect(coerceDistillOutput(null, validSeqs)).toEqual({ notes: [], supersededIds: [] });
    expect(coerceDistillOutput('str', validSeqs)).toEqual({ notes: [], supersededIds: [] });
  });
});

describe('buildPrompt', () => {
  it('includes commits, files, messages with real seqs', () => {
    const p = buildPrompt(digestInput());
    expect(p).toContain('abc1234 add kuzu store');
    expect(p).toContain('src/graph/kuzu-store.ts');
    expect(p).toContain('[seq=1]');
    expect(p).toContain('[seq=4]');
    expect(p).toContain('(none)'); // existing notes empty
  });

  it('renders existing notes when present', () => {
    const input = digestInput();
    const existing: DistilledNote = {
      id: 'old#0',
      kind: 'decision',
      title: 'Old decision',
      body: 'b',
      files: ['src/graph/kuzu-store.ts'],
      anchors: [{ sessionId: 'old', seq: 2 }],
      sessionId: 'old',
      validAt: '2026-05-01T00:00:00Z',
      invalidAt: null,
      supersededBy: null,
    };
    const p = buildPrompt({ ...input, existingNotes: [existing] });
    expect(p).toContain('id=old#0');
    expect(p).toContain('Old decision');
  });
});

describe('ClaudeCliDistiller.distill', () => {
  it('parses a normal JSON envelope into notes', async () => {
    const d = new ClaudeCliDistiller(makeExec(envelope(VALID_NOTE_JSON)));
    const out = await d.distill(digestInput());
    expect(out.error).toBeUndefined();
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]!.title).toBe('Use Kuzu embedded graph');
    expect(out.notes[0]!.anchors.map((a) => a.seq)).toEqual([1, 4]);
  });

  it('handles ```json fenced output inside the envelope result', async () => {
    const fenced = '```json\n' + VALID_NOTE_JSON + '\n```';
    const d = new ClaudeCliDistiller(makeExec(envelope(fenced)));
    const out = await d.distill(digestInput());
    expect(out.notes).toHaveLength(1);
  });

  it('degrades gracefully on unparseable LLM output', async () => {
    const d = new ClaudeCliDistiller(makeExec(envelope('I could not produce JSON, sorry.')));
    const out = await d.distill(digestInput());
    expect(out.notes).toEqual([]);
    expect(out.supersededIds).toEqual([]);
    expect(out.error).toMatch(/parse/i);
  });

  it('degrades gracefully when exec throws (CLI failure)', async () => {
    const failExec: ExecFn = async () => {
      throw new Error('command not found: claude');
    };
    const d = new ClaudeCliDistiller(failExec);
    const out = await d.distill(digestInput());
    expect(out.notes).toEqual([]);
    expect(out.error).toMatch(/claude CLI failed/i);
  });

  it('rejects anchors with seqs not in the digest', async () => {
    const badAnchors = JSON.stringify({
      notes: [
        { kind: 'decision', title: 't', body: 'b', files: [], anchors: [{ seq: 777 }] },
      ],
      supersededIds: [],
    });
    const d = new ClaudeCliDistiller(makeExec(envelope(badAnchors)));
    const out = await d.distill(digestInput());
    expect(out.notes).toHaveLength(0);
  });

  it('invokes claude with the right model and flags', async () => {
    let capturedCmd = '';
    let capturedArgs: string[] = [];
    const spyExec: ExecFn = async (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return { stdout: envelope(VALID_NOTE_JSON), stderr: '' };
    };
    const d = new ClaudeCliDistiller(spyExec);
    await d.distill(digestInput());
    expect(capturedCmd).toBe('claude');
    expect(capturedArgs).toContain('-p');
    expect(capturedArgs).toContain('--output-format');
    expect(capturedArgs).toContain('json');
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain(DISTILL_MODEL);
  });
});

describe('ClaudeCliDistiller.available', () => {
  it('true when claude --version succeeds', async () => {
    const d = new ClaudeCliDistiller(makeExec('1.2.3'));
    expect(await d.available()).toBe(true);
  });

  it('false when claude --version throws', async () => {
    const d = new ClaudeCliDistiller(async () => {
      throw new Error('not found');
    });
    expect(await d.available()).toBe(false);
  });

  it('has the expected name', () => {
    expect(new ClaudeCliDistiller().name).toBe('claude-cli');
  });
});
