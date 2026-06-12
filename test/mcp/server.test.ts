/**
 * MCP server tests — verifies tool output shape and error handling.
 *
 * Strategy: use InMemoryTransport (SDK) to wire a real McpServer ↔ Client pair
 * in-process. WhyEngine, AskEngine, and GraphStore are all mocked — no real git,
 * no real transcripts, no file system reads.
 *
 * Each tool is tested for:
 *   1. Happy-path: output contains expected fields.
 *   2. Error path: engine throws → isError=true, message surfaced in content.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLoreMcpServer, __test__ } from '../../src/mcp/server.js';
import type { WhyEngine, WhyResult } from '../../src/why/types.js';
import type { AskEngine, AskResult } from '../../src/ask/types.js';
import type {
  GraphStore,
  GraphData,
  ProducedInfo,
  SessionNodeData,
  CommitNodeData,
  EditedEdgeData,
} from '../../src/graph/types.js';
import type { DistilledNote } from '../../src/distill/types.js';

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeSession(id = 'session-abc123'): SessionNodeData {
  return {
    id,
    agent: 'claude-code',
    startedAt: '2026-06-10T10:00:00.000Z',
    endedAt: '2026-06-10T11:00:00.000Z',
    cwd: '/repo',
    gitBranch: 'main',
    sourcePaths: ['/Users/dev/.claude/projects/repo/transcript.jsonl'],
  };
}

function makeCommit(hash = 'abc123def456'): CommitNodeData {
  return {
    hash,
    subject: 'feat: add config parser',
    authorDate: '2026-06-10T10:30:00.000Z',
    committerDate: '2026-06-10T10:31:00.000Z',
    isMerge: false,
  };
}

function makeProduced(sessionId = 'session-abc123'): ProducedInfo {
  return {
    sessionId,
    commitHash: 'abc123def456',
    confidence: 0.92,
    matchedVia: 'content',
    sourcePath: '/Users/dev/.claude/projects/repo/transcript.jsonl',
    matchedLines: 10,
    fileCount: 2,
    session: makeSession(sessionId),
  };
}

function makeWhyResult(): WhyResult {
  return {
    file: 'src/config/parser.ts',
    line: 42,
    lineContent: '  return parseYaml(content);',
    commit: makeCommit(),
    attributions: [
      {
        produced: makeProduced(),
        editSeqs: [5, 7, 12],
        excerpts: [
          {
            sessionId: 'session-abc123',
            seq: 4,
            role: 'user',
            text: 'Please implement the config parser',
            ts: '2026-06-10T10:20:00.000Z',
          },
          {
            sessionId: 'session-abc123',
            seq: 6,
            role: 'assistant',
            text: 'I will implement the YAML config parser now.',
            ts: '2026-06-10T10:21:00.000Z',
          },
        ],
      },
    ],
    editedBy: [],
  };
}

function makeNote(id = 'sess1#0'): DistilledNote {
  return {
    id,
    kind: 'decision',
    title: 'Use YAML for config format',
    body: 'We chose YAML over JSON for readability. Config files need multi-line support.',
    files: ['src/config/parser.ts'],
    anchors: [{ sessionId: 'session-abc123', seq: 4 }],
    sessionId: 'session-abc123',
    validAt: '2026-06-10T10:00:00.000Z',
    invalidAt: null,
    supersededBy: null,
  };
}

function makeAskResult(): AskResult {
  return {
    question: 'why YAML for config?',
    hits: [
      {
        score: 0.85,
        note: makeNote(),
      },
    ],
    messageHits: [
      {
        sessionId: 'session-abc123',
        seq: 4,
        text: 'Please implement the config parser with YAML support',
        score: 0.72,
      },
    ],
  };
}

// ── Mock engines ──────────────────────────────────────────────────────────────

function mockWhyEngine(result: WhyResult | Error): WhyEngine {
  return {
    why: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function mockAskEngine(result: AskResult | Error): AskEngine {
  return {
    ask: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function mockGraphStore(
  history: { commit: CommitNodeData; produced: ProducedInfo[] }[] | Error,
): GraphStore {
  return {
    backend: 'json',
    init: async () => {},
    rebuild: async (_d: GraphData) => {},
    whoProducedCommit: async () => [],
    fileHistory: async () => {
      if (history instanceof Error) throw history;
      return history;
    },
    sessionsEditingFile: async (): Promise<{ session: SessionNodeData; edge: EditedEdgeData }[]> => [],
    exportAll: async () => ({
      sessions: [],
      commits: [],
      files: [],
      produced: [],
      touches: [],
      edited: [],
    }),
    close: async () => {},
  };
}

// ── Test harness: wire McpServer ↔ Client via InMemoryTransport ───────────────

async function makeClientServer(
  engines: {
    whyEngine?: WhyEngine;
    askEngine?: AskEngine;
    graphStore?: GraphStore;
  },
  repoPath = '/fake/repo',
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createLoreMcpServer(repoPath, engines);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '0.0.1' });

  // Connect server first, then client.
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ── lore_why tests ────────────────────────────────────────────────────────────

describe('lore_why', () => {
  it('happy path: output contains file, commit, confidence', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(makeWhyResult()),
    });
    try {
      const result = await client.callTool({
        name: 'lore_why',
        arguments: { file: 'src/config/parser.ts', line: 42 },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as { type: string; text: string }[];
      expect(content.length).toBeGreaterThan(0);
      const text = content[0]!.text;
      expect(text).toContain('src/config/parser.ts:42');
      expect(text).toContain('abc123def4');
      expect(text).toContain('feat: add config parser');
    } finally {
      await cleanup();
    }
  });

  it('happy path: output contains confidence and session id', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(makeWhyResult()),
    });
    try {
      const result = await client.callTool({
        name: 'lore_why',
        arguments: { file: 'src/config/parser.ts', line: 42 },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('0.920');
      expect(text).toContain('strong');
      expect(text).toContain('session-abc123');
    } finally {
      await cleanup();
    }
  });

  it('happy path: output contains excerpts with anchors', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(makeWhyResult()),
    });
    try {
      const result = await client.callTool({
        name: 'lore_why',
        arguments: { file: 'src/config/parser.ts', line: 42 },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      // anchor: [sessionId[:8]+seq]
      expect(text).toContain('[session-');
      expect(text).toContain('+4');
      expect(text).toContain('Please implement the config parser');
    } finally {
      await cleanup();
    }
  });

  it('blind-spot: no attribution gives attribution:none', async () => {
    const whyResult: WhyResult = {
      ...makeWhyResult(),
      attributions: [],
      editedBy: [{ sessionId: 'other-session-xyz', agent: 'claude-code', lastTs: '2026-06-09T10:00:00.000Z' }],
    };
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(whyResult),
    });
    try {
      const result = await client.callTool({
        name: 'lore_why',
        arguments: { file: 'src/config/parser.ts', line: 42 },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('attribution:none');
      // sessionId 'other-session-xyz' sliced to 12 chars => 'other-sessio'
      expect(text).toContain('other-sessio');
    } finally {
      await cleanup();
    }
  });

  it('error path: engine throws → isError=true with message', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(new Error('git blame failed for test.ts:1 — no such file')),
    });
    try {
      const result = await client.callTool({
        name: 'lore_why',
        arguments: { file: 'test.ts', line: 1 },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('lore_why error');
      expect(text).toContain('git blame failed');
    } finally {
      await cleanup();
    }
  });

  it('error path: server does not crash after error', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(new Error('simulated failure')),
    });
    try {
      // First call: error
      const r1 = await client.callTool({
        name: 'lore_why',
        arguments: { file: 'a.ts', line: 1 },
      });
      expect(r1.isError).toBe(true);

      // Second call with a good engine path (reuse same server, different mock not possible here,
      // but we verify the server is still responsive).
      const r2 = await client.callTool({
        name: 'lore_why',
        arguments: { file: 'a.ts', line: 1 },
      });
      expect(r2.isError).toBe(true); // still same engine but server alive
    } finally {
      await cleanup();
    }
  });
});

// ── lore_ask tests ────────────────────────────────────────────────────────────

describe('lore_ask', () => {
  it('happy path: output contains question and note kind/title', async () => {
    const { client, cleanup } = await makeClientServer({
      askEngine: mockAskEngine(makeAskResult()),
    });
    try {
      const result = await client.callTool({
        name: 'lore_ask',
        arguments: { question: 'why YAML for config?' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('why YAML for config?');
      expect(text).toContain('decision');
      expect(text).toContain('Use YAML for config format');
    } finally {
      await cleanup();
    }
  });

  it('happy path: output contains scores and anchors', async () => {
    const { client, cleanup } = await makeClientServer({
      askEngine: mockAskEngine(makeAskResult()),
    });
    try {
      const result = await client.callTool({
        name: 'lore_ask',
        arguments: { question: 'why YAML for config?' },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('0.850');
      // anchor: sessionId 'session-abc123' sliced to 8 chars => 'session-', then '+4'
      expect(text).toContain('[session-+4]');
      expect(text).toContain('+4');
    } finally {
      await cleanup();
    }
  });

  it('happy path: output contains message hits', async () => {
    const { client, cleanup } = await makeClientServer({
      askEngine: mockAskEngine(makeAskResult()),
    });
    try {
      const result = await client.callTool({
        name: 'lore_ask',
        arguments: { question: 'why YAML for config?' },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('0.720');
      expect(text).toContain('Please implement the config parser with YAML');
    } finally {
      await cleanup();
    }
  });

  it('happy path: empty results → "results:none"', async () => {
    const emptyResult: AskResult = {
      question: 'nothing here',
      hits: [],
      messageHits: [],
    };
    const { client, cleanup } = await makeClientServer({
      askEngine: mockAskEngine(emptyResult),
    });
    try {
      const result = await client.callTool({
        name: 'lore_ask',
        arguments: { question: 'nothing here' },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('results:none');
    } finally {
      await cleanup();
    }
  });

  it('includeSuperseded flag is passed through (engine invoked)', async () => {
    let capturedOpts: { includeSuperseded?: boolean } | undefined;
    const spyEngine: AskEngine = {
      ask: async (_repo, _q, opts) => {
        capturedOpts = opts;
        return makeAskResult();
      },
    };
    const { client, cleanup } = await makeClientServer({ askEngine: spyEngine });
    try {
      await client.callTool({
        name: 'lore_ask',
        arguments: { question: 'test', includeSuperseded: true },
      });

      expect(capturedOpts?.includeSuperseded).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('error path: engine throws → isError=true', async () => {
    const { client, cleanup } = await makeClientServer({
      askEngine: mockAskEngine(new Error('notes.json not found')),
    });
    try {
      const result = await client.callTool({
        name: 'lore_ask',
        arguments: { question: 'anything' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('lore_ask error');
      expect(text).toContain('notes.json not found');
    } finally {
      await cleanup();
    }
  });
});

// ── lore_history tests ────────────────────────────────────────────────────────

describe('lore_history', () => {
  it('happy path: output contains file path and commit info', async () => {
    const history = [
      { commit: makeCommit(), produced: [makeProduced()] },
    ];
    const { client, cleanup } = await makeClientServer({
      graphStore: mockGraphStore(history),
    });
    try {
      const result = await client.callTool({
        name: 'lore_history',
        arguments: { path: 'src/config/parser.ts' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('src/config/parser.ts');
      expect(text).toContain('commits:1');
      expect(text).toContain('abc123def4');
      expect(text).toContain('feat: add config parser');
    } finally {
      await cleanup();
    }
  });

  it('happy path: attributed commit shows session + confidence', async () => {
    const history = [
      { commit: makeCommit(), produced: [makeProduced()] },
    ];
    const { client, cleanup } = await makeClientServer({
      graphStore: mockGraphStore(history),
    });
    try {
      const result = await client.callTool({
        name: 'lore_history',
        arguments: { path: 'src/config/parser.ts' },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('session:session-abc1');
      expect(text).toContain('0.920');
      expect(text).toContain('strong');
    } finally {
      await cleanup();
    }
  });

  it('happy path: unattributed commit shows "(unattributed)"', async () => {
    const history = [
      { commit: makeCommit(), produced: [] },
    ];
    const { client, cleanup } = await makeClientServer({
      graphStore: mockGraphStore(history),
    });
    try {
      const result = await client.callTool({
        name: 'lore_history',
        arguments: { path: 'src/config/parser.ts' },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('(unattributed)');
    } finally {
      await cleanup();
    }
  });

  it('happy path: empty history renders zero commits', async () => {
    const { client, cleanup } = await makeClientServer({
      graphStore: mockGraphStore([]),
    });
    try {
      const result = await client.callTool({
        name: 'lore_history',
        arguments: { path: 'src/never-edited.ts' },
      });

      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('commits:0');
    } finally {
      await cleanup();
    }
  });

  it('error path: store throws → isError=true', async () => {
    const { client, cleanup } = await makeClientServer({
      graphStore: mockGraphStore(new Error('graph not initialised')),
    });
    try {
      const result = await client.callTool({
        name: 'lore_history',
        arguments: { path: 'src/config/parser.ts' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('lore_history error');
      expect(text).toContain('graph not initialised');
    } finally {
      await cleanup();
    }
  });

  it('error path: server stays alive after store error', async () => {
    const { client, cleanup } = await makeClientServer({
      graphStore: mockGraphStore(new Error('simulated error')),
    });
    try {
      const r1 = await client.callTool({
        name: 'lore_history',
        arguments: { path: 'src/a.ts' },
      });
      expect(r1.isError).toBe(true);

      const r2 = await client.callTool({
        name: 'lore_history',
        arguments: { path: 'src/a.ts' },
      });
      expect(r2.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// ── tool listing ──────────────────────────────────────────────────────────────

describe('server tool listing', () => {
  it('advertises exactly three tools', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(makeWhyResult()),
      askEngine: mockAskEngine(makeAskResult()),
      graphStore: mockGraphStore([]),
    });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['lore_ask', 'lore_history', 'lore_why']);
    } finally {
      await cleanup();
    }
  });

  it('each tool has a description and inputSchema', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(makeWhyResult()),
      askEngine: mockAskEngine(makeAskResult()),
      graphStore: mockGraphStore([]),
    });
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(typeof tool.description).toBe('string');
        expect(tool.description!.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
      }
    } finally {
      await cleanup();
    }
  });

  // ── semantic legend in descriptions (task 4) ───────────────────────────────
  it('lore_why description documents the trust model, anchors, and when to call', async () => {
    const { client, cleanup } = await makeClientServer({
      whyEngine: mockWhyEngine(makeWhyResult()),
    });
    try {
      const { tools } = await client.listTools();
      const why = tools.find((t) => t.name === 'lore_why')!;
      const d = why.description!;
      expect(d).toContain('0.8'); // strong/weak boundary
      expect(d.toLowerCase()).toContain('strong');
      expect(d.toLowerCase()).toContain('weak');
      expect(d).toContain('matchedVia'); // matchedVia meaning explained
      expect(d.toLowerCase()).toContain('anchor'); // [sessionId+seq] is a permanent anchor
      expect(d.toLowerCase()).toMatch(/before (editing|you)/i); // when to call
      // include_weak is exposed in the schema
      const props = (why.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).toHaveProperty('include_weak');
    } finally {
      await cleanup();
    }
  });

  it('lore_ask description documents kind enum and note-vs-msg trust', async () => {
    const { client, cleanup } = await makeClientServer({
      askEngine: mockAskEngine(makeAskResult()),
    });
    try {
      const { tools } = await client.listTools();
      const ask = tools.find((t) => t.name === 'lore_ask')!;
      const d = ask.description!;
      expect(d).toContain('decision');
      expect(d).toContain('constraint');
      expect(d).toContain('rejected-approach');
      expect(d.toLowerCase()).toContain('distilled'); // note = distilled high-trust
      expect(d.toLowerCase()).toMatch(/raw|unvetted/); // msg = raw low-trust
    } finally {
      await cleanup();
    }
  });

  it('lore_history description documents the trust model and anchors', async () => {
    const { client, cleanup } = await makeClientServer({
      graphStore: mockGraphStore([]),
    });
    try {
      const { tools } = await client.listTools();
      const hist = tools.find((t) => t.name === 'lore_history')!;
      const d = hist.description!;
      expect(d).toContain('0.8');
      expect(d.toLowerCase()).toContain('strong');
      expect(d.toLowerCase()).toContain('weak');
      expect(d.toLowerCase()).toContain('anchor');
    } finally {
      await cleanup();
    }
  });
});

// ── weak-confidence rendering (task 1, MCP side) ───────────────────────────────

function makeWeakWhyResult(): WhyResult {
  const r = makeWhyResult();
  // Drop to a weak (<0.8) confidence; give a multi-line excerpt to verify folding.
  r.attributions[0]!.produced.confidence = 0.55;
  r.attributions[0]!.excerpts = [
    {
      sessionId: 'session-abc123',
      seq: 4,
      role: 'user',
      text: 'Line one of the excerpt.\nLine two should be folded.\nLine three too.',
      ts: '2026-06-10T10:20:00.000Z',
    },
  ];
  return r;
}

describe('weak-confidence rendering', () => {
  it('renderWhyCompact prefixes weak attributions with ⚠ LOW-CONFIDENCE and folds the body', () => {
    const text = __test__.renderWhyCompact(makeWeakWhyResult());
    expect(text).toContain('confidence:0.550(weak)');
    expect(text).toContain('⚠ LOW-CONFIDENCE');
    // body folded to a single line — no embedded newline in the excerpt line
    const excerptLine = text.split('\n').find((l) => l.includes('USER:'))!;
    expect(excerptLine).toContain('Line one of the excerpt. Line two should be folded.');
    expect(excerptLine).not.toContain('\n');
    // anchor preserved
    expect(text).toContain('[session-+4]');
  });

  it('renderWhyCompact leaves strong attributions unchanged (no ⚠, full excerpts)', () => {
    const text = __test__.renderWhyCompact(makeWhyResult());
    expect(text).toContain('confidence:0.920(strong)');
    expect(text).not.toContain('⚠ LOW-CONFIDENCE');
    // strong path keeps up to 2 excerpts
    expect(text).toContain('Please implement the config parser');
    expect(text).toContain('I will implement the YAML config parser now.');
  });

  it('renderHistoryCompact flags weak attributions with ⚠ LOW-CONFIDENCE', () => {
    const weakProduced = { ...makeProduced(), confidence: 0.6 };
    const text = __test__.renderHistoryCompact('src/x.ts', [
      { commit: makeCommit(), produced: [weakProduced] },
    ]);
    expect(text).toContain('⚠ LOW-CONFIDENCE');
    expect(text).toContain('conf=0.600(weak)');
  });

  it('renderHistoryCompact leaves strong attributions unflagged', () => {
    const text = __test__.renderHistoryCompact('src/x.ts', [
      { commit: makeCommit(), produced: [makeProduced()] },
    ]);
    expect(text).not.toContain('⚠ LOW-CONFIDENCE');
    expect(text).toContain('conf=0.920(strong)');
  });

  it('lore_why passes include_weak through to the engine', async () => {
    let capturedOpts: { includeWeak?: boolean } | undefined;
    const spyEngine: WhyEngine = {
      why: async (_repo, _file, _line, opts) => {
        capturedOpts = opts;
        return makeWhyResult();
      },
    };
    const { client, cleanup } = await makeClientServer({ whyEngine: spyEngine });
    try {
      await client.callTool({
        name: 'lore_why',
        arguments: { file: 'a.ts', line: 1, include_weak: true },
      });
      expect(capturedOpts?.includeWeak).toBe(true);

      await client.callTool({
        name: 'lore_why',
        arguments: { file: 'a.ts', line: 1 },
      });
      expect(capturedOpts?.includeWeak).toBe(false); // default
    } finally {
      await cleanup();
    }
  });
});

// ── freshness header (task 4) ──────────────────────────────────────────────────

const headerTmpDirs: string[] = [];
afterEach(() => {
  for (const dir of headerTmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeRepoWithReport(
  report: Record<string, unknown>,
  opts: { initGit?: boolean; commitDate?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-mcp-hdr-'));
  headerTmpDirs.push(dir);
  mkdirSync(join(dir, '.lore'), { recursive: true });
  writeFileSync(join(dir, '.lore', 'report.json'), JSON.stringify(report), 'utf8');
  if (opts.initGit) {
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'f.txt'), 'hello\n', 'utf8');
    git('add', '-A');
    const env = opts.commitDate
      ? { ...process.env, GIT_AUTHOR_DATE: opts.commitDate, GIT_COMMITTER_DATE: opts.commitDate }
      : process.env;
    execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { encoding: 'utf8', env });
  }
  return dir;
}

describe('freshnessHeader', () => {
  it('returns null when report.json is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-mcp-noreport-'));
    headerTmpDirs.push(dir);
    expect(await __test__.buildFreshnessHeader(dir)).toBeNull();
  });

  it('builds coverage + generated without stale when not a git repo', async () => {
    const dir = makeRepoWithReport({
      generatedAt: '2026-06-12T09:00:00.000Z',
      commitsTotal: 100,
      commitsMatchedStrong: 40,
      commitsMatchedWeak: 10,
    });
    const header = await __test__.buildFreshnessHeader(dir);
    expect(header).toContain('coverage:50/100');
    expect(header).toContain('generated:2026-06-12');
    // No git repo → stale omitted.
    expect(header).not.toContain('stale:');
  });

  it('marks stale:true when report predates HEAD commit', async () => {
    const dir = makeRepoWithReport(
      {
        generatedAt: '2026-06-01T00:00:00.000Z',
        commitsTotal: 10,
        commitsMatchedStrong: 5,
        commitsMatchedWeak: 0,
      },
      { initGit: true, commitDate: '2026-06-10T12:00:00 +0000' },
    );
    const header = await __test__.buildFreshnessHeader(dir);
    expect(header).toContain('coverage:5/10');
    expect(header).toContain('stale:true');
  });

  it('marks stale:false when report is newer than HEAD commit', async () => {
    const dir = makeRepoWithReport(
      {
        generatedAt: '2026-06-20T00:00:00.000Z',
        commitsTotal: 10,
        commitsMatchedStrong: 5,
        commitsMatchedWeak: 2,
      },
      { initGit: true, commitDate: '2026-06-10T12:00:00 +0000' },
    );
    const header = await __test__.buildFreshnessHeader(dir);
    expect(header).toContain('coverage:7/10');
    expect(header).toContain('stale:false');
  });

  it('tool output first line carries the freshness header', async () => {
    const dir = makeRepoWithReport({
      generatedAt: '2026-06-12T09:00:00.000Z',
      commitsTotal: 100,
      commitsMatchedStrong: 40,
      commitsMatchedWeak: 10,
    });
    const { client, cleanup } = await makeClientServer(
      { askEngine: mockAskEngine(makeAskResult()) },
      dir,
    );
    try {
      const result = await client.callTool({
        name: 'lore_ask',
        arguments: { question: 'why YAML?' },
      });
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      const firstLine = text.split('\n')[0]!;
      expect(firstLine).toContain('coverage:50/100');
      expect(firstLine).toContain('generated:2026-06-12');
    } finally {
      await cleanup();
    }
  });
});
