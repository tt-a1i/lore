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
import type { MatchCandidate } from '../match/types.js';
import type { LoreEvent, ParsedSession } from '../schema/events.js';

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
// .lore/report.json 的 matches 里，每个 (commit, file) 一条 MatchCandidate。
// 我们为每个 commit 取 confidence 最高的那条 candidate，重 parse 它的 sourcePath
// transcript，按 editSeqs 找贡献编辑前后最近的 user/assistant 消息，取 ≤2 条
// （user 优先），每条 ≤320 字符。同一 transcript 只 parse 一次（内存缓存）。
// 容错：任何一步失败该 commit 无摘录即可，绝不让 /api/payload 挂掉。

const EXCERPT_MAX = 320;
const EXCERPTS_PER_COMMIT = 2;

/** .lore/report.json 的最小形态（仅取我们用到的字段）。 */
interface ReportFileShape {
  matches?: MatchCandidate[];
}

function truncateExcerpt(s: string): string {
  const t = s.trim();
  if (t.length <= EXCERPT_MAX) return t;
  return t.slice(0, EXCERPT_MAX - 1) + '…';
}

/** 在事件流中向某方向找第一条指定 kind 的消息，返回摘录或 null。 */
function findNearestMessage(
  events: LoreEvent[],
  fromIdx: number,
  direction: -1 | 1,
  kind: 'user-message' | 'assistant-message',
): ViewerExcerpt | null {
  for (let i = fromIdx + direction; i >= 0 && i < events.length; i += direction) {
    const e = events[i];
    if (!e || e.kind !== kind) continue;
    return {
      sessionId: e.sessionId,
      seq: e.seq,
      role: kind === 'user-message' ? 'user' : 'assistant',
      text: truncateExcerpt((e as { text: string }).text),
      ts: e.ts,
    };
  }
  return null;
}

/**
 * 按 editSeqs 定位 file-edit 事件，抽前后最近的 user/assistant 消息，
 * 按 (seq, role) 去重，user 优先、再按 seq 升序，取前 N 条。
 */
function excerptsForCandidate(session: ParsedSession, editSeqs: number[]): ViewerExcerpt[] {
  const events = session.events;
  const editSeqSet = new Set(editSeqs);
  const byAnchor = new Map<string, ViewerExcerpt>();

  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    if (!e || e.kind !== 'file-edit' || !editSeqSet.has(e.seq)) continue;
    const candidates = [
      findNearestMessage(events, idx, -1, 'user-message'),
      findNearestMessage(events, idx, -1, 'assistant-message'),
      findNearestMessage(events, idx, 1, 'user-message'),
      findNearestMessage(events, idx, 1, 'assistant-message'),
    ];
    for (const c of candidates) {
      if (!c || !c.text) continue;
      const key = c.seq + ':' + c.role;
      if (!byAnchor.has(key)) byAnchor.set(key, c);
    }
  }

  const all = [...byAnchor.values()];
  // user 优先；同 role 内按 seq 升序（对话先后）。
  all.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1;
    return a.seq - b.seq;
  });
  return all.slice(0, EXCERPTS_PER_COMMIT);
}

/**
 * 读 .lore/report.json，为每个 commit 取 top-1 confidence 的 candidate，
 * parse 其 sourcePath（同文件只 parse 一次），抽 ≤2 条摘录。
 * 任何失败都安静跳过——返回的 map 只含成功算出摘录的 commit。
 */
async function computeExcerpts(repoPath: string): Promise<Record<string, ViewerExcerpt[]>> {
  const result: Record<string, ViewerExcerpt[]> = {};

  let report: ReportFileShape;
  try {
    const raw = await fs.readFile(path.join(repoPath, '.lore', 'report.json'), 'utf8');
    report = JSON.parse(raw) as ReportFileShape;
  } catch {
    return result; // 没有 report（未 scan）：无摘录。
  }
  const matches = report.matches;
  if (!Array.isArray(matches) || matches.length === 0) return result;

  // 每个 commit 取 confidence 最高的 candidate；只有 strong（≥0.8）配摘录——
  // weak 归因展示置信度即可，引导用户去读"可能错误的对话"比没有更糟。
  const topByCommit = new Map<string, MatchCandidate>();
  for (const m of matches) {
    if (!m || !m.commitHash) continue;
    if ((m.confidence ?? 0) < 0.8) continue;
    const cur = topByCommit.get(m.commitHash);
    if (!cur || (m.confidence ?? 0) > (cur.confidence ?? 0)) {
      topByCommit.set(m.commitHash, m);
    }
  }
  if (topByCommit.size === 0) return result;

  // 懒加载 parser；失败则全体无摘录（不抛）。
  let parser: import('../schema/events.js').TranscriptParser;
  try {
    const mod = await import('../parsers/claude-code.js');
    parser = mod.claudeCodeParser;
  } catch {
    return result;
  }

  // 同一 sourcePath 只 parse 一次（内存缓存，含失败的 null）。
  const parseCache = new Map<string, ParsedSession | null>();
  async function parseOnce(sourcePath: string): Promise<ParsedSession | null> {
    if (parseCache.has(sourcePath)) return parseCache.get(sourcePath) ?? null;
    let session: ParsedSession | null = null;
    try {
      const parsed = await parser.parse(sourcePath);
      session = parsed.session;
    } catch {
      session = null;
    }
    parseCache.set(sourcePath, session);
    return session;
  }

  for (const [commitHash, cand] of topByCommit) {
    try {
      if (!cand.sourcePath) continue;
      const session = await parseOnce(cand.sourcePath);
      if (!session) continue;
      const excerpts = excerptsForCandidate(session, cand.editSeqs ?? []);
      if (excerpts.length) result[commitHash] = excerpts;
    } catch {
      // 单 commit 失败：跳过，不影响其余。
    }
  }

  return result;
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

  // 首次 /api/payload 请求时计算一次摘录（解析 transcript 较重），之后复用。
  let excerptsPromise: Promise<Record<string, ViewerExcerpt[]>> | null = null;
  function getExcerpts(): Promise<Record<string, ViewerExcerpt[]>> {
    if (!excerptsPromise) {
      // computeExcerpts 自身全程容错；再兜一层以防意外，永不让 payload 挂掉。
      excerptsPromise = computeExcerpts(repoPath).catch(() => ({}));
    }
    return excerptsPromise;
  }

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
