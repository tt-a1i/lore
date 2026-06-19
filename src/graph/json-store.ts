/**
 * JsonGraphStore — 零原生依赖的 JSON 文件后端，用于 kuzu 不可用时的降级。
 *
 * 存储路径：<repo>/.lore/graph/graph.json（全量序列化 GraphData）。
 * 内存中维护 Map 索引以避免 O(n²) 查询。
 * rebuild 策略：全量覆写文件（GraphData 是派生数据，幂等最简）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  GraphStore,
  GraphData,
  SessionNodeData,
  CommitNodeData,
  EditedEdgeData,
  ProducedInfo,
} from './types.js';

export class JsonGraphStore implements GraphStore {
  readonly backend = 'json' as const;

  private readonly graphDir: string;
  private readonly graphFile: string;

  // In-memory state (loaded on init or after rebuild)
  private data: GraphData = {
    sessions: [],
    commits: [],
    files: [],
    produced: [],
    touches: [],
    edited: [],
  };

  // Indexes
  private sessionById = new Map<string, SessionNodeData>();
  private commitByHash = new Map<string, CommitNodeData>();
  // commitHash → ProducedInfo[] (sorted by confidence desc)
  private producedByCommit = new Map<string, ProducedInfo[]>();
  // filePath → commitHash[] (in authorDate asc order)
  private commitsByFile = new Map<string, string[]>();
  // filePath → { session, edge }[]
  private editedByFile = new Map<string, { session: SessionNodeData; edge: EditedEdgeData }[]>();

  constructor(repoPath: string) {
    this.graphDir = path.join(repoPath, '.lore', 'graph');
    this.graphFile = path.join(this.graphDir, 'graph.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.graphDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.graphFile, 'utf8');
      const loaded = JSON.parse(raw) as GraphData;
      this._loadData(loaded);
    } catch {
      // File doesn't exist yet — start empty
    }
  }

  private _loadData(d: GraphData): void {
    this.data = d;
    this._buildIndexes();
  }

  private _buildIndexes(): void {
    this.sessionById = new Map(this.data.sessions.map((s) => [s.id, s]));
    this.commitByHash = new Map(this.data.commits.map((c) => [c.hash, c]));

    // PRODUCED: group by commitHash, sort by confidence desc
    this.producedByCommit = new Map();
    for (const e of this.data.produced) {
      const session = this.sessionById.get(e.sessionId);
      if (!session) continue;
      const info: ProducedInfo = { ...e, session };
      const arr = this.producedByCommit.get(e.commitHash) ?? [];
      arr.push(info);
      this.producedByCommit.set(e.commitHash, arr);
    }
    for (const arr of this.producedByCommit.values()) {
      arr.sort((a, b) => b.confidence - a.confidence);
    }

    // TOUCHES: group filePath → commit hashes, sorted by commit authorDate asc
    const touchesByFile = new Map<string, string[]>();
    for (const e of this.data.touches) {
      const arr = touchesByFile.get(e.filePath) ?? [];
      arr.push(e.commitHash);
      touchesByFile.set(e.filePath, arr);
    }
    this.commitsByFile = new Map();
    for (const [fp, hashes] of touchesByFile) {
      const unique = [...new Set(hashes)];
      unique.sort((a, b) => {
        const ca = this.commitByHash.get(a);
        const cb = this.commitByHash.get(b);
        const da = ca?.authorDate ?? '';
        const db = cb?.authorDate ?? '';
        return da < db ? -1 : da > db ? 1 : 0;
      });
      this.commitsByFile.set(fp, unique);
    }

    // EDITED: group by filePath
    this.editedByFile = new Map();
    for (const e of this.data.edited) {
      const session = this.sessionById.get(e.sessionId);
      if (!session) continue;
      const arr = this.editedByFile.get(e.filePath) ?? [];
      arr.push({ session, edge: e });
      this.editedByFile.set(e.filePath, arr);
    }
  }

  // ── rebuild ───────────────────────────────────────────────────────────────

  async rebuild(data: GraphData): Promise<void> {
    await fs.mkdir(this.graphDir, { recursive: true });
    await fs.writeFile(this.graphFile, JSON.stringify(data, null, 2), 'utf8');
    this._loadData(data);
  }

  // ── queries ───────────────────────────────────────────────────────────────

  async whoProducedCommit(hash: string): Promise<ProducedInfo[]> {
    return this.producedByCommit.get(hash) ?? [];
  }

  async fileHistory(
    filePath: string,
  ): Promise<{ commit: CommitNodeData; produced: ProducedInfo[] }[]> {
    const hashes = this.commitsByFile.get(filePath) ?? [];
    const result: { commit: CommitNodeData; produced: ProducedInfo[] }[] = [];
    for (const hash of hashes) {
      const commit = this.commitByHash.get(hash);
      if (!commit) continue;
      const produced = (this.producedByCommit.get(hash) ?? []).filter(
        (p) => !Array.isArray(p.files) || p.files.length === 0 || p.files.includes(filePath),
      );
      result.push({ commit, produced });
    }
    return result;
  }

  async sessionsEditingFile(
    filePath: string,
  ): Promise<{ session: SessionNodeData; edge: EditedEdgeData }[]> {
    return this.editedByFile.get(filePath) ?? [];
  }

  async exportAll(): Promise<GraphData> {
    // Return a deep clone so callers can't mutate internal state
    return structuredClone(this.data);
  }

  async close(): Promise<void> {
    // No-op: JSON store is stateless after rebuild (data already flushed to disk)
  }
}
