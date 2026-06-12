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
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { WhyEngine, WhyResult } from '../why/types.js';
import type { AskEngine, AskResult } from '../ask/types.js';
import type { GraphStore } from '../graph/types.js';

// ── compact renderers (token-friendly, no ANSI, deterministic) ────────────────

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/**
 * Render WhyResult as a compact, token-friendly string for agent consumption.
 * Includes: commit, confidence, ≤2 excerpts (each ≤300 chars), anchors.
 */
function renderWhyCompact(result: WhyResult): string {
  const parts: string[] = [];

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
  const tier = p.confidence >= 0.8 ? 'strong' : 'weak';
  parts.push(`confidence:${p.confidence.toFixed(3)}(${tier})`);
  parts.push(`session:${p.sessionId.slice(0, 16)} via=${p.matchedVia} lines=${p.matchedLines}`);

  // ≤2 excerpts, each ≤300 chars
  const excerpts = attr.excerpts.slice(0, 2);
  for (const ex of excerpts) {
    const anchor = `[${ex.sessionId.slice(0, 8)}+${ex.seq}]`;
    const role = ex.role === 'user' ? 'USER' : 'ASST';
    parts.push(`${anchor} ${role}: ${truncate(ex.text, 300)}`);
  }

  // anchor for re-lookup
  if (attr.editSeqs.length > 0) {
    parts.push(`anchors:${attr.editSeqs.slice(0, 4).join(',')}`);
  }

  return parts.join('\n');
}

/**
 * Render AskResult as compact text: top5 notes + top3 message hits.
 */
function renderAskCompact(result: AskResult): string {
  const parts: string[] = [];
  parts.push(`query:${truncate(result.question, 120)}`);

  if (result.hits.length === 0 && result.messageHits.length === 0) {
    parts.push('results:none');
    return parts.join('\n');
  }

  const topNotes = result.hits.slice(0, 5);
  for (let i = 0; i < topNotes.length; i++) {
    const h = topNotes[i]!;
    const n = h.note;
    const anchor = n.anchors.length > 0
      ? `[${n.anchors[0]!.sessionId.slice(0, 8)}+${n.anchors[0]!.seq}]`
      : '';
    parts.push(
      `note${i + 1} kind=${n.kind} score=${h.score.toFixed(3)} ${anchor} ${truncate(n.title, 60)}`
    );
    parts.push(`  body:${truncate(n.body, 200)}`);
    if (n.files.length > 0) {
      parts.push(`  files:${n.files.slice(0, 3).join(',')}`);
    }
  }

  const topMsgs = result.messageHits.slice(0, 3);
  for (let i = 0; i < topMsgs.length; i++) {
    const m = topMsgs[i]!;
    const anchor = `[${m.sessionId.slice(0, 8)}+${m.seq}]`;
    parts.push(`msg${i + 1} ${anchor} score=${m.score.toFixed(3)} ${truncate(m.text, 200)}`);
  }

  return parts.join('\n');
}

/**
 * Render fileHistory as a compact timeline.
 */
function renderHistoryCompact(
  filePath: string,
  history: { commit: import('../graph/types.js').CommitNodeData; produced: import('../graph/types.js').ProducedInfo[] }[],
): string {
  const parts: string[] = [];
  parts.push(`file:${filePath} commits:${history.length}`);

  for (const entry of history) {
    const c = entry.commit;
    const date = c.authorDate.slice(0, 10);
    const line = `${c.hash.slice(0, 10)} ${date} ${truncate(c.subject, 60)}`;
    if (entry.produced.length > 0) {
      const p = entry.produced[0]!;
      const tier = p.confidence >= 0.8 ? 'strong' : 'weak';
      parts.push(
        `${line} ← session:${p.sessionId.slice(0, 12)} conf=${p.confidence.toFixed(3)}(${tier})`
      );
    } else {
      parts.push(`${line} ← (unattributed)`);
    }
  }

  return parts.join('\n');
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
  },
): McpServer {
  const server = new McpServer({
    name: 'lore',
    version: '0.0.1',
  });

  // ── lore_why ────────────────────────────────────────────────────────────────

  server.registerTool(
    'lore_why',
    {
      description:
        'Trace a line of source code back to the AI conversation that produced it. ' +
        'Returns: commit, confidence, up to 2 conversation excerpts (≤300 chars each), anchors.',
      inputSchema: {
        file: z.string().describe('Repo-relative file path, e.g. "src/cli.ts"'),
        line: z.number().int().positive().describe('1-based line number'),
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
        const result = await whyEngine.why(repoPath, args.file, args.line);
        return { content: [{ type: 'text', text: renderWhyCompact(result) }] };
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
        'Search the project\'s distilled knowledge (decisions, constraints, rejected approaches) ' +
        'for the given question. Returns top 5 notes + top 3 raw message hits with anchors.',
      inputSchema: {
        question: z.string().describe('Natural-language question about the codebase'),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe('Include invalidated/superseded notes (default: false)'),
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
        const result = await askEngine.ask(repoPath, args.question, {
          topK: 5,
          includeSuperseded: args.includeSuperseded ?? false,
        });
        return { content: [{ type: 'text', text: renderAskCompact(result) }] };
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
        'Show the commit timeline for a file, annotated with AI session attributions. ' +
        'Returns: list of commits (hash, date, subject) each attributed or unattributed.',
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
          return {
            content: [{ type: 'text', text: renderHistoryCompact(args.path, history) }],
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

  return server;
}
