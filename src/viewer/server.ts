/**
 * ViewerServer implementation — node:http single-file server for `lore serve`.
 *
 * GET /            → single-page HTML (from page.ts)
 * GET /api/payload → ViewerPayload JSON
 *
 * No external runtime dependencies; graph data comes from createGraphStore(repoPath).exportAll(),
 * notes from .lore/notes.json, timeRange from commit authorDate min/max.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ViewerPayload, ViewerServer } from './types.js';
import { buildPage } from './page.js';

// Lazy import so that the kuzu fallback path runs at serve time, not import time.
async function loadGraphStore(repoPath: string) {
  const mod = await import('../graph/factory.js');
  return mod.createGraphStore(repoPath);
}

async function loadNotesFile(
  repoPath: string,
): Promise<import('../distill/types.js').DistilledNote[]> {
  const notesPath = path.join(repoPath, '.lore', 'notes.json');
  try {
    const raw = await fs.readFile(notesPath, 'utf8');
    const parsed = JSON.parse(raw) as { notes?: import('../distill/types.js').DistilledNote[] };
    return parsed.notes ?? [];
  } catch {
    return [];
  }
}

function computeTimeRange(
  commits: import('../graph/types.js').CommitNodeData[],
): { start: string; end: string } | null {
  if (commits.length === 0) return null;
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const c of commits) {
    const t = new Date(c.authorDate).getTime();
    if (!isNaN(t)) {
      if (t < minMs) minMs = t;
      if (t > maxMs) maxMs = t;
    }
  }
  if (!isFinite(minMs)) return null;
  return {
    start: new Date(minMs).toISOString(),
    end: new Date(maxMs).toISOString(),
  };
}

/** Build ViewerPayload on demand (not cached — small repos run sub-second). */
async function buildPayload(repoPath: string): Promise<ViewerPayload> {
  const store = await loadGraphStore(repoPath);
  let graphData: import('../graph/types.js').GraphData;
  try {
    graphData = await store.exportAll();
  } finally {
    await store.close();
  }

  const notes = await loadNotesFile(repoPath);
  const timeRange = computeTimeRange(graphData.commits);

  return {
    repo: repoPath,
    generatedAt: new Date().toISOString(),
    graph: graphData,
    notes,
    timeRange,
  };
}

export function createViewerServer(repoPath: string): ViewerServer {
  let httpServer: http.Server | null = null;
  const htmlPage = buildPage();

  return {
    async start(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
          const url = req.url ?? '/';

          try {
            if (url === '/' || url === '/index.html') {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(htmlPage);
              return;
            }

            if (url === '/api/payload') {
              let payload: ViewerPayload;
              try {
                payload = await buildPayload(repoPath);
              } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: String(e) }));
                return;
              }
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
              });
              res.end(JSON.stringify(payload));
              return;
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
          } catch (e) {
            // Catch-all: surface error rather than crash
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            res.end(String(e));
          }
        });

        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          httpServer = server;
          resolve(actualPort);
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!httpServer) { resolve(); return; }
        httpServer.close((err) => {
          httpServer = null;
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
