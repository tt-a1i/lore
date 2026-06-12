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

import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLoreMcpServer } from '../../src/mcp/server.js';
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

async function makeClientServer(engines: {
  whyEngine?: WhyEngine;
  askEngine?: AskEngine;
  graphStore?: GraphStore;
}): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createLoreMcpServer('/fake/repo', engines);
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
});
