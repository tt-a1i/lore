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

import type { ViewerExcerpt, ViewerPayload, ViewerServer } from './types.js';
import { buildPage } from './page.js';
import { computeExcerpts } from '../excerpts/compute.js';
import { loadSnapshot } from '../excerpts/snapshot.js';

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

// ── 对话摘录（抽屉内嵌）────────────────────────────────────────────────────
//
// 提取逻辑（per-commit top-1 strong candidate → parse sourcePath → editSeqs 前后
// 最近 user/assistant 消息 → ≤2 条 ≤320 字符）已抽到 src/excerpts/compute.ts，
// 与 `lore scan` 的快照固化共用。这里只负责"获取"：
//
//   快照文件（.lore/excerpts.json）→ 实时重算（transcript 还在时）
//
// transcript 被 Claude Code 清理后实时重算会落空，快照兜底保证摘录不丢。

/**
 * 获取一个 repo 的全量摘录（commitHash → ViewerExcerpt[]）。
 * fallback 链：快照文件 → 实时重算。两者都失败时返回 {}（绝不让 payload 挂掉）。
 *
 * 顺序取舍：快照优先于实时重算。快照是 scan 时定格的"产出当下"对话，比实时重算更
 * 权威（transcript 可能已被部分清理/改写）；且省去逐 transcript 重 parse 的开销。
 */
async function fetchExcerpts(repoPath: string): Promise<Record<string, ViewerExcerpt[]>> {
  // 1. 快照文件。
  const snapshot = await loadSnapshot(repoPath);
  if (snapshot && Object.keys(snapshot.byCommit).length > 0) {
    return snapshot.byCommit;
  }
  // 2. 实时重算（transcript 还在时）。computeExcerpts 自身全程容错。
  return computeExcerpts(repoPath);
}

/**
 * Build ViewerPayload on demand (graph/notes not cached — small repos run sub-second).
 * `excerpts` is computed once (transcript parsing is the expensive part) and the
 * resulting map is passed back in on subsequent requests.
 */
async function buildPayload(
  repoPath: string,
  excerpts: Record<string, ViewerExcerpt[]>,
): Promise<ViewerPayload> {
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
    excerpts,
  };
}

export function createViewerServer(repoPath: string): ViewerServer {
  let httpServer: http.Server | null = null;
  const htmlPage = buildPage();

  // 内存缓存（fallback 链第一环）：首次 /api/payload 请求时获取一次摘录（快照读 / 实时
  // 解析较重），之后复用。fetchExcerpts 自身全程容错；再兜一层以防意外，永不让 payload 挂掉。
  let excerptsPromise: Promise<Record<string, ViewerExcerpt[]>> | null = null;
  function getExcerpts(): Promise<Record<string, ViewerExcerpt[]>> {
    if (!excerptsPromise) {
      excerptsPromise = fetchExcerpts(repoPath).catch(() => ({}));
    }
    return excerptsPromise;
  }

  return {
    async start(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
          // 只按 pathname 路由——query string（如 ?intro=1 演示后门）不参与匹配。
          const url = (req.url ?? '/').split('?')[0] ?? '/';

          try {
            if (url === '/' || url === '/index.html') {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(htmlPage);
              return;
            }

            if (url === '/api/payload') {
              let payload: ViewerPayload;
              try {
                const excerpts = await getExcerpts();
                payload = await buildPayload(repoPath, excerpts);
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
