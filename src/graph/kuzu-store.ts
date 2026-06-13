/**
 * KuzuGraphStore — kuzu 0.11.3 嵌入式后端实现。
 *
 * 存储路径：<repo>/.lore/graph/kuzu/graph.kuzu（单文件数据库）。
 * rebuild 策略：删除整个 kuzu/ 目录并重建（派生数据，幂等最简）。
 *
 * kuzu ESM 加载：createRequire，避免静态 import 在无原生绑定时炸掉整个进程。
 * 参数注入：全部走 cypherLit 手工转义的内联字面量——不用 PreparedStatement，
 * 它在所属连接关闭后任何一次 GC 都可能 use-after-free（kuzu 0.11.3，flaky SIGSEGV）。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  GraphStore,
  GraphData,
  SessionNodeData,
  CommitNodeData,
  FileNodeData,
  ProducedEdgeData,
  TouchesEdgeData,
  EditedEdgeData,
  ProducedInfo,
} from './types.js';

// ── kuzu type shim (we load it dynamically) ──────────────────────────────────

interface KuzuModule {
  Database: new (path: string) => KuzuDatabase;
  Connection: new (db: KuzuDatabase) => KuzuConnection;
}

interface KuzuDatabase {
  /** kuzu 0.11.x 的 close 是异步的——不 await 会与进程退出竞态导致 SIGSEGV。 */
  close(): Promise<void>;
}

interface KuzuQueryResult {
  getAll(): Promise<Record<string, unknown>[]>;
}

interface KuzuConnection {
  query(cypher: string): Promise<KuzuQueryResult>;
  /** 同 Database.close：异步，必须 await。 */
  close(): Promise<void>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Coerce unknown kuzu cell values to the expected TypeScript types. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function bool(v: unknown): boolean {
  return v === true || v === 'true';
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [];
}

/** Cypher 字面量编码（kuzu 单引号字符串）：转义 \ ' 换行回车；null → NULL。 */
function cypherLit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(cypherLit).join(', ') + ']';
  return (
    "'" +
    String(v)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r') +
    "'"
  );
}

function structLit(row: Record<string, unknown>): string {
  return '{' + Object.entries(row).map(([k, v]) => `${k}: ${cypherLit(v)}`).join(', ') + '}';
}

// ── DDL ───────────────────────────────────────────────────────────────────────

const DDL_STATEMENTS = [
  // Node tables
  `CREATE NODE TABLE Session(
    id         STRING,
    agent      STRING,
    startedAt  STRING,
    endedAt    STRING,
    cwd        STRING,
    gitBranch  STRING,
    sourcePaths STRING[],
    PRIMARY KEY (id)
  )`,
  `CREATE NODE TABLE CommitNode(
    hash           STRING,
    subject        STRING,
    authorDate     STRING,
    committerDate  STRING,
    isMerge        BOOL,
    PRIMARY KEY (hash)
  )`,
  `CREATE NODE TABLE File(
    path STRING,
    PRIMARY KEY (path)
  )`,
  // Rel tables
  `CREATE REL TABLE PRODUCED(
    FROM Session TO CommitNode,
    confidence   DOUBLE,
    matchedVia   STRING,
    sourcePath   STRING,
    matchedLines INT64,
    fileCount    INT64,
    files        STRING[]
  )`,
  `CREATE REL TABLE TOUCHES(
    FROM CommitNode TO File,
    status       STRING,
    addedLines   INT64,
    removedLines INT64
  )`,
  `CREATE REL TABLE EDITED(
    FROM Session TO File,
    sourcePath STRING,
    editCount  INT64,
    firstTs    STRING,
    lastTs     STRING
  )`,
];

// ── KuzuGraphStore ────────────────────────────────────────────────────────────

export class KuzuGraphStore implements GraphStore {
  readonly backend = 'kuzu' as const;

  private readonly kuzuDir: string;   // <repo>/.lore/graph/kuzu/
  private readonly dbFile: string;    // <repo>/.lore/graph/kuzu/graph.kuzu

  private db: KuzuDatabase | null = null;
  private conn: KuzuConnection | null = null;
  private kuzu: KuzuModule;

  constructor(repoPath: string, kuzu: KuzuModule) {
    this.kuzuDir = path.join(repoPath, '.lore', 'graph', 'kuzu');
    this.dbFile = path.join(this.kuzuDir, 'graph.kuzu');
    this.kuzu = kuzu;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.kuzuDir, { recursive: true });
    await this._openDb();
  }

  // kuzu 0.11.x 的 conn.close()/db.close() 都是异步的：不 await 会与进程退出竞态
  // 触发 SIGSEGV（实测 exit 139）；不关闭则每个 Database 泄漏 ~8TB 虚拟地址空间的
  // mmap，多次 rebuild 后报 "Mmap failed"。所以必须逐个 await 关闭。
  private async _openDb(): Promise<void> {
    await this._closeHandles();
    this.db = new this.kuzu.Database(this.dbFile);
    this.conn = new this.kuzu.Connection(this.db);
  }

  private async _closeHandles(): Promise<void> {
    if (this.conn) {
      try { await this.conn.close(); } catch { /* ignore */ }
      this.conn = null;
    }
    if (this.db) {
      try { await this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }

  private get c(): KuzuConnection {
    if (!this.conn) throw new Error('KuzuGraphStore: not initialised — call init() first');
    return this.conn;
  }

  // ── rebuild ──────────────────────────────────────────────────────────────

  async rebuild(data: GraphData): Promise<void> {
    // Close handles (awaited — see _openDb) before deleting files.
    await this._closeHandles();

    // Wipe entire kuzu directory and recreate
    try {
      await fs.rm(this.kuzuDir, { recursive: true, force: true });
    } catch { /* ignore if not present */ }
    await fs.mkdir(this.kuzuDir, { recursive: true });

    // Fresh database
    await this._openDb();

    // Create schema
    for (const stmt of DDL_STATEMENTS) {
      await this.c.query(stmt);
    }

    // 批量插入：逐行 execute 过原生桥约 235 行/秒（实测 7500 行要 32s）；
    // UNWIND 批量后 5000 行 72ms。每批 500 行。
    await this._batchInsert(
      data.sessions.map((s) => ({
        id: s.id,
        agent: s.agent,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? null,
        cwd: s.cwd ?? null,
        gitBranch: s.gitBranch ?? null,
        sourcePaths: s.sourcePaths,
      })),
      `UNWIND $rows AS r CREATE (:Session {
        id: r.id, agent: r.agent, startedAt: r.startedAt, endedAt: r.endedAt,
        cwd: r.cwd, gitBranch: r.gitBranch, sourcePaths: r.sourcePaths
      })`,
    );

    await this._batchInsert(
      data.commits.map((c) => ({
        hash: c.hash,
        subject: c.subject,
        authorDate: c.authorDate,
        committerDate: c.committerDate,
        isMerge: c.isMerge,
      })),
      `UNWIND $rows AS r CREATE (:CommitNode {
        hash: r.hash, subject: r.subject, authorDate: r.authorDate,
        committerDate: r.committerDate, isMerge: r.isMerge
      })`,
    );

    await this._batchInsert(
      data.files.map((f) => ({ path: f.path })),
      `UNWIND $rows AS r CREATE (:File { path: r.path })`,
    );

    // confidence 必须以字符串传参 + CAST：UNWIND 的 struct 类型按第一行推断，
    // 整数值的 1.0 会把整批推成 INT64，后续 0.999 的位模式被重解释成垃圾值（实测）。
    await this._batchInsert(
      data.produced.map((e) => ({
        sessionId: e.sessionId,
        commitHash: e.commitHash,
        confidence: String(e.confidence),
        matchedVia: e.matchedVia,
        sourcePath: e.sourcePath,
        matchedLines: e.matchedLines,
        fileCount: e.fileCount,
        files: e.files ?? [],
      })),
      `UNWIND $rows AS r
       MATCH (s:Session {id: r.sessionId}), (c:CommitNode {hash: r.commitHash})
       CREATE (s)-[:PRODUCED {
         confidence: CAST(r.confidence AS DOUBLE), matchedVia: r.matchedVia, sourcePath: r.sourcePath,
         matchedLines: r.matchedLines, fileCount: r.fileCount, files: r.files
       }]->(c)`,
    );

    await this._batchInsert(
      data.touches.map((e) => ({
        commitHash: e.commitHash,
        filePath: e.filePath,
        status: e.status,
        addedLines: e.addedLines,
        removedLines: e.removedLines,
      })),
      `UNWIND $rows AS r
       MATCH (c:CommitNode {hash: r.commitHash}), (f:File {path: r.filePath})
       CREATE (c)-[:TOUCHES {
         status: r.status, addedLines: r.addedLines, removedLines: r.removedLines
       }]->(f)`,
    );

    await this._batchInsert(
      data.edited.map((e) => ({
        sessionId: e.sessionId,
        filePath: e.filePath,
        sourcePath: e.sourcePath,
        editCount: e.editCount,
        firstTs: e.firstTs,
        lastTs: e.lastTs,
      })),
      `UNWIND $rows AS r
       MATCH (s:Session {id: r.sessionId}), (f:File {path: r.filePath})
       CREATE (s)-[:EDITED {
         sourcePath: r.sourcePath, editCount: r.editCount,
         firstTs: r.firstTs, lastTs: r.lastTs
       }]->(f)`,
    );
  }

  /**
   * 不用 prepare/execute：kuzu 0.11.3 的 PreparedStatement 在其连接关闭后，
   * 任何一次 GC 都可能触发 use-after-free（SIGSEGV，且 flaky）。
   * 改为内联字面量 Cypher（cypherLit 手工转义），单次 query 调用，零残留句柄。
   */
  private async _batchInsert(rows: Record<string, unknown>[], cypher: string): Promise<void> {
    if (rows.length === 0) return;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const listLit = '[' + rows.slice(i, i + BATCH).map(structLit).join(', ') + ']';
      await this.c.query(cypher.replace('$rows', listLit));
    }
  }

  // ── queries ───────────────────────────────────────────────────────────────

  async whoProducedCommit(hash: string): Promise<ProducedInfo[]> {
    const result = await this.c.query(
      `MATCH (s:Session)-[e:PRODUCED]->(c:CommitNode {hash: ${cypherLit(hash)}})
       RETURN s.id, s.agent, s.startedAt, s.endedAt, s.cwd, s.gitBranch, s.sourcePaths,
              e.confidence, e.matchedVia, e.sourcePath, e.matchedLines, e.fileCount, e.files
       ORDER BY e.confidence DESC`,
    );
    const rows = await result.getAll();
    return rows.map((r) => ({
      session: {
        id: str(r['s.id']),
        agent: str(r['s.agent']),
        startedAt: str(r['s.startedAt']),
        endedAt: strOrNull(r['s.endedAt']),
        cwd: strOrNull(r['s.cwd']),
        gitBranch: strOrNull(r['s.gitBranch']),
        sourcePaths: strArr(r['s.sourcePaths']),
      } satisfies SessionNodeData,
      sessionId: str(r['s.id']),
      commitHash: hash,
      confidence: num(r['e.confidence']),
      matchedVia: str(r['e.matchedVia']) as 'sha' | 'content',
      sourcePath: str(r['e.sourcePath']),
      matchedLines: num(r['e.matchedLines']),
      fileCount: num(r['e.fileCount']),
      files: strArr(r['e.files']),
    } satisfies ProducedInfo));
  }

  async fileHistory(
    filePath: string,
  ): Promise<{ commit: CommitNodeData; produced: ProducedInfo[] }[]> {
    // Get all commits touching this file, ordered by authorDate ascending
    const commitResult = await this.c.query(
      `MATCH (c:CommitNode)-[:TOUCHES]->(f:File {path: ${cypherLit(filePath)}})
       RETURN c.hash, c.subject, c.authorDate, c.committerDate, c.isMerge
       ORDER BY c.authorDate ASC`,
    );
    const commitRows = await commitResult.getAll();

    const items: { commit: CommitNodeData; produced: ProducedInfo[] }[] = [];
    for (const cr of commitRows) {
      const commit: CommitNodeData = {
        hash: str(cr['c.hash']),
        subject: str(cr['c.subject']),
        authorDate: str(cr['c.authorDate']),
        committerDate: str(cr['c.committerDate']),
        isMerge: bool(cr['c.isMerge']),
      };
      const produced = (await this.whoProducedCommit(commit.hash)).filter(
        (p) => !Array.isArray(p.files) || p.files.length === 0 || p.files.includes(filePath),
      );
      items.push({ commit, produced });
    }
    return items;
  }

  async sessionsEditingFile(
    filePath: string,
  ): Promise<{ session: SessionNodeData; edge: EditedEdgeData }[]> {
    const result = await this.c.query(
      `MATCH (s:Session)-[e:EDITED]->(f:File {path: ${cypherLit(filePath)}})
       RETURN s.id, s.agent, s.startedAt, s.endedAt, s.cwd, s.gitBranch, s.sourcePaths,
              e.sourcePath, e.editCount, e.firstTs, e.lastTs`,
    );
    const rows = await result.getAll();
    return rows.map((r) => ({
      session: {
        id: str(r['s.id']),
        agent: str(r['s.agent']),
        startedAt: str(r['s.startedAt']),
        endedAt: strOrNull(r['s.endedAt']),
        cwd: strOrNull(r['s.cwd']),
        gitBranch: strOrNull(r['s.gitBranch']),
        sourcePaths: strArr(r['s.sourcePaths']),
      } satisfies SessionNodeData,
      edge: {
        sessionId: str(r['s.id']),
        filePath,
        sourcePath: str(r['e.sourcePath']),
        editCount: num(r['e.editCount']),
        firstTs: str(r['e.firstTs']),
        lastTs: str(r['e.lastTs']),
      } satisfies EditedEdgeData,
    }));
  }

  async exportAll(): Promise<GraphData> {
    const [sessRows, commitRows, fileRows, producedRows, touchesRows, editedRows] =
      await Promise.all([
        this.c.query('MATCH (n:Session) RETURN n.id, n.agent, n.startedAt, n.endedAt, n.cwd, n.gitBranch, n.sourcePaths').then((r) => r.getAll()),
        this.c.query('MATCH (n:CommitNode) RETURN n.hash, n.subject, n.authorDate, n.committerDate, n.isMerge').then((r) => r.getAll()),
        this.c.query('MATCH (n:File) RETURN n.path').then((r) => r.getAll()),
        this.c.query('MATCH (s:Session)-[e:PRODUCED]->(c:CommitNode) RETURN s.id, c.hash, e.confidence, e.matchedVia, e.sourcePath, e.matchedLines, e.fileCount, e.files').then((r) => r.getAll()),
        this.c.query('MATCH (c:CommitNode)-[e:TOUCHES]->(f:File) RETURN c.hash, f.path, e.status, e.addedLines, e.removedLines').then((r) => r.getAll()),
        this.c.query('MATCH (s:Session)-[e:EDITED]->(f:File) RETURN s.id, f.path, e.sourcePath, e.editCount, e.firstTs, e.lastTs').then((r) => r.getAll()),
      ]);

    return {
      sessions: sessRows.map((r) => ({
        id: str(r['n.id']),
        agent: str(r['n.agent']),
        startedAt: str(r['n.startedAt']),
        endedAt: strOrNull(r['n.endedAt']),
        cwd: strOrNull(r['n.cwd']),
        gitBranch: strOrNull(r['n.gitBranch']),
        sourcePaths: strArr(r['n.sourcePaths']),
      })),
      commits: commitRows.map((r) => ({
        hash: str(r['n.hash']),
        subject: str(r['n.subject']),
        authorDate: str(r['n.authorDate']),
        committerDate: str(r['n.committerDate']),
        isMerge: bool(r['n.isMerge']),
      })),
      files: fileRows.map((r) => ({
        path: str(r['n.path']),
      })),
      produced: producedRows.map((r) => ({
        sessionId: str(r['s.id']),
        commitHash: str(r['c.hash']),
        confidence: num(r['e.confidence']),
        matchedVia: str(r['e.matchedVia']) as 'sha' | 'content',
        sourcePath: str(r['e.sourcePath']),
        matchedLines: num(r['e.matchedLines']),
        fileCount: num(r['e.fileCount']),
        files: strArr(r['e.files']),
      })),
      touches: touchesRows.map((r) => ({
        commitHash: str(r['c.hash']),
        filePath: str(r['f.path']),
        status: str(r['e.status']) as TouchesEdgeData['status'],
        addedLines: num(r['e.addedLines']),
        removedLines: num(r['e.removedLines']),
      })),
      edited: editedRows.map((r) => ({
        sessionId: str(r['s.id']),
        filePath: str(r['f.path']),
        sourcePath: str(r['e.sourcePath']),
        editCount: num(r['e.editCount']),
        firstTs: str(r['e.firstTs']),
        lastTs: str(r['e.lastTs']),
      })),
    };
  }

  async close(): Promise<void> {
    await this._closeHandles();
  }
}

// ── factory helper ────────────────────────────────────────────────────────────

/**
 * Load kuzu via createRequire and return a KuzuGraphStore.
 * Throws if kuzu native binding is unavailable.
 */
export function createKuzuStore(repoPath: string): KuzuGraphStore {
  const req = createRequire(import.meta.url);
  const kuzu = req('kuzu') as KuzuModule;
  return new KuzuGraphStore(repoPath, kuzu);
}
