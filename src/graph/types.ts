/**
 * 图谱层契约 —— lore 的核心数据结构。
 *
 * 节点三类（M2 骨架，零 LLM 成本，确定性构建）：
 *   Session（逻辑会话，含其全部子 agent 的工作）
 *   Commit（git commit，含分支/squash 两形态）
 *   File（repo 相对路径）
 * M3 语义层追加：Decision / Constraint / RejectedApproach（双时间模型）。
 *
 * 边：
 *   (Session)-[PRODUCED]->(Commit)   匹配引擎产出，带置信度与证据指针
 *   (Commit)-[TOUCHES]->(File)       git 事实
 *   (Session)-[EDITED]->(File)       transcript 事实（即使未匹配到 commit 也保留）
 *
 * 存储采用适配器模式（借鉴 MiroFish 的 Zep/Graphiti 双后端经验）：
 * KuzuGraphStore（嵌入式，主选）+ JsonGraphStore（零原生依赖兜底）。
 * 数据放 <repo>/.lore/graph/ 下，随仓库走。
 */

export interface SessionNodeData {
  id: string; // sessionId
  agent: string; // AgentKind
  startedAt: string;
  endedAt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  /** 该 session 全部解析单元（主链 + 子 agent transcript 路径）。 */
  sourcePaths: string[];
}

export interface CommitNodeData {
  hash: string;
  subject: string;
  authorDate: string;
  committerDate: string;
  isMerge: boolean;
}

export interface FileNodeData {
  path: string; // repo 相对路径
}

export interface ProducedEdgeData {
  sessionId: string;
  commitHash: string;
  confidence: number;
  matchedVia: 'sha' | 'content';
  /** 证据指针：真正包含编辑的解析单元。 */
  sourcePath: string;
  matchedLines: number;
  /** 该归因覆盖的文件数（来自 MatchCandidate 聚合）。 */
  fileCount: number;
}

export interface TouchesEdgeData {
  commitHash: string;
  filePath: string;
  status: 'A' | 'M' | 'D' | 'R';
  addedLines: number;
  removedLines: number;
}

export interface EditedEdgeData {
  sessionId: string;
  filePath: string;
  sourcePath: string;
  editCount: number;
  firstTs: string;
  lastTs: string;
}

export interface GraphData {
  sessions: SessionNodeData[];
  commits: CommitNodeData[];
  files: FileNodeData[];
  produced: ProducedEdgeData[];
  touches: TouchesEdgeData[];
  edited: EditedEdgeData[];
}

/** PRODUCED 查询结果（why 管线的核心输入）。 */
export interface ProducedInfo extends ProducedEdgeData {
  session: SessionNodeData;
}

/**
 * 存储适配器。实现必须幂等：rebuild 时先清后写或全量 upsert。
 * 所有实现持久化到 <repo>/.lore/graph/ 下（kuzu: 目录；json: graph.json）。
 */
export interface GraphStore {
  readonly backend: 'kuzu' | 'json';
  init(): Promise<void>;
  /** 全量重建（M2 策略：scan 后整体重建，增量留给后续）。 */
  rebuild(data: GraphData): Promise<void>;
  /** 谁产出了这个 commit（按 confidence 降序）。 */
  whoProducedCommit(hash: string): Promise<ProducedInfo[]>;
  /** 文件的演化：触碰它的 commit（时间升序）+ 各自的归因。 */
  fileHistory(path: string): Promise<{ commit: CommitNodeData; produced: ProducedInfo[] }[]>;
  /** 编辑过该文件的 session（含未匹配到 commit 的——盲区也是信息）。 */
  sessionsEditingFile(path: string): Promise<{ session: SessionNodeData; edge: EditedEdgeData }[]>;
  /** viewer 导出：全图（M4 用，节点数有限直接全量）。 */
  exportAll(): Promise<GraphData>;
  close(): Promise<void>;
}

/** 工厂：优先 kuzu，原生绑定加载失败时降级 json 并在 stderr 提示。 */
export type GraphStoreFactory = (repoPath: string) => Promise<GraphStore>;
