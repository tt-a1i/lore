/**
 * NotesStore 实现 —— .lore/notes.json 的唯一读写入口。
 *
 * 契约见 distill/types.ts。蒸馏编排（orchestrate.ts）、`lore note` CLI、
 * MCP lore_note 共用本实现，杜绝三处各写各的格式漂移。
 *
 * load：
 *   - 缺文件 / 损坏 → 返回空壳（schemaVersion=1, distilledSessions={}, notes=[]）。
 *   - 兼容 orchestrate.ts 现有写出格式（同 readNotesFile 的容错口径）。
 *   - 缺 source 字段的 note 视为 'distilled'（与 types.ts 的法律一致，旧数据兼容）。
 *
 * appendNote：
 *   - id 分配：agent/human 来源用 `agent-<base36 时间戳>-<4位随机>`（与蒸馏的
 *     `sessionId#n` 命名空间不冲突）。
 *   - 防重：同 source='agent' 且 title 完全相同且 invalidAt===null 的既存笔记 →
 *     更新其 body/files（保 id）而非追加，返回 { updated: true }。
 *   - supersedes：给目标旧 note（仍有效者）打 invalidAt=now + supersededBy=新 id。
 *   - 并发安全：写前重读文件做合并（last-writer-wins 按 note id），原子写（tmp+rename）。
 *
 * 设计取舍：
 *   - 「写前重读合并」指：appendNote 进入时重新 load 当前磁盘内容（而非依赖调用方
 *     传入的快照），在最新数据上施加变更后落盘。两个并发 append 各自重读 → 后写者
 *     看到前写者的 note；按 note id 去重（last-writer-wins）后合并，二者都不丢。
 *   - 原子写：先写 `<file>.tmp.<pid>.<rand>`，fsync 后 rename 覆盖目标。rename 在
 *     同目录内是原子操作，读者永远看到完整 JSON（不会读到半截文件）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  NotesFile,
  NotesStore,
  DistilledNote,
  NoteKind,
} from '../distill/types.js';

const NOTES_SCHEMA_VERSION = 1;

/** 空壳 NotesFile（缺文件 / 损坏时返回）。 */
function emptyNotesFile(): NotesFile {
  return { schemaVersion: NOTES_SCHEMA_VERSION, distilledSessions: {}, notes: [] };
}

/** .lore/notes.json 的绝对路径。 */
function notesPathFor(repoPath: string): string {
  return path.join(path.resolve(repoPath), '.lore', 'notes.json');
}

/**
 * 把任意已解析的 JSON 规整成 NotesFile，并为缺 source 的 note 补默认值
 * （'distilled'）。其余字段做防御式兜底（损坏的单字段不应炸掉整体加载）。
 */
function coerceNotesFile(parsed: unknown): NotesFile {
  if (!parsed || typeof parsed !== 'object') return emptyNotesFile();
  const obj = parsed as Partial<NotesFile> & Record<string, unknown>;

  const rawNotes = Array.isArray(obj.notes) ? obj.notes : [];
  const notes: DistilledNote[] = [];
  for (const n of rawNotes) {
    if (!n || typeof n !== 'object') continue;
    const note = n as Partial<DistilledNote> & Record<string, unknown>;
    // 必备字段缺失则跳过（防御：不让一条坏 note 污染整个文件）。
    if (typeof note.id !== 'string' || typeof note.kind !== 'string') continue;
    notes.push({
      id: note.id,
      kind: note.kind as NoteKind,
      title: typeof note.title === 'string' ? note.title : '',
      body: typeof note.body === 'string' ? note.body : '',
      files: Array.isArray(note.files) ? note.files.filter((f): f is string => typeof f === 'string') : [],
      anchors: Array.isArray(note.anchors)
        ? (note.anchors.filter(
            (a) => a && typeof a === 'object' && typeof (a as Record<string, unknown>).sessionId === 'string',
          ) as DistilledNote['anchors'])
        : [],
      sessionId: typeof note.sessionId === 'string' ? note.sessionId : '',
      validAt: typeof note.validAt === 'string' ? note.validAt : '',
      invalidAt: typeof note.invalidAt === 'string' ? note.invalidAt : null,
      supersededBy: typeof note.supersededBy === 'string' ? note.supersededBy : null,
      // 缺 source 视为 distilled（types.ts 的法律：旧数据缺省此字段视为 distilled）。
      source: note.source === 'agent' || note.source === 'human' || note.source === 'distilled'
        ? note.source
        : 'distilled',
    });
  }

  const result: NotesFile = {
    schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : NOTES_SCHEMA_VERSION,
    distilledSessions:
      obj.distilledSessions && typeof obj.distilledSessions === 'object'
        ? (obj.distilledSessions as Record<string, string>)
        : {},
    notes,
  };
  if (typeof obj.distilledAt === 'string') result.distilledAt = obj.distilledAt;
  return result;
}

/** 读 + 规整。缺文件 / 解析失败 → 空壳。 */
async function loadFile(repoPath: string): Promise<NotesFile> {
  const p = notesPathFor(repoPath);
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return emptyNotesFile();
  }
  try {
    return coerceNotesFile(JSON.parse(raw));
  } catch {
    // 文件存在但损坏：返回空壳而非抛异常（防御式；写路径会在其上重建）。
    return emptyNotesFile();
  }
}

/**
 * 生成 agent/human 笔记的 id：`agent-<base36 时间戳>-<6位随机>`。
 * 用 crypto.randomBytes 而非 Math.random：高并发下 Math.random 同毫秒 4 位随机
 * 仍有 36⁻⁴≈6e-7 碰撞概率（一次 distill 几百条 note 时不容忽视），
 * crypto 对应 16⁻⁶≈6e-8 且不可预测，几乎零成本。
 */
function allocAgentId(): string {
  const ts = Date.now().toString(36);
  // 3 字节 = 6 hex 字符，足够全局唯一且仍紧凑。
  const rand = randomBytes(3).toString('hex');
  return `agent-${ts}-${rand}`;
}

/**
 * 原子写：写临时文件 → rename 覆盖目标。rename 同目录内原子，读者不会读到半截文件。
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.notes.json.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`,
  );
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (e) {
    // 失败时清理临时文件，不留垃圾。
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ── 并发控制 ────────────────────────────────────────────────────────────────
//
// 多层防御：
//   L1 进程内 mutex —— 同进程内 appendNote 按 repoPath 串行（最常见情形：
//      MCP server / CLI / 蒸馏编排都跑在同一个 lore 进程里）。
//   L2 跨进程 lockfile —— `.notes.json.lock` 用 O_EXCL（wx）独占创建；
//      获不到等待并指数退避，超时则失败（绝不无锁写，避免 lost-update）。
//   L3 mtime 校验 + 重试 —— read-modify-write 期间若文件 mtime 变了，
//      说明别的进程刚写过，重读重做（读路径上的 last-writer-wins 防御）。
//
// 任一层单独不够：L1 抓不住跨进程；L2 lockfile 在 NFS / 强 kill 后会成僵尸锁；
// L3 在 L1+L2 都失效时仍能保正确（代价是多一轮 IO）。

const LOCK_FILENAME = '.notes.json.lock';
const LOCK_STALE_MS = 5_000; // 锁文件超过 5s 视为僵尸（强 kill 残留）
const LOCK_RETRY_BASE_MS = 10;
const LOCK_RETRY_MAX_MS = 200;
const LOCK_TOTAL_TIMEOUT_MS = 3_000; // 总等待超时——超过则失败，调用方可重试
const APPEND_RETRY_LIMIT = 3;

/** 进程内 mutex：repoPath → 当前正在 hold 的 promise 链尾。 */
const _processMutex = new Map<string, Promise<unknown>>();

/** 把 fn 排到 repoPath 的队尾，串行执行。返回 fn 的结果。 */
async function withProcessMutex<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _processMutex.get(repoPath) ?? Promise.resolve();
  // 不让前一个的失败传染下一个；用 .catch 吞掉，但当前 fn 自身错误正常抛。
  const next = prev.then(fn, fn);
  // 把"完成（无论成败）"的 promise 链给下一个等待者。
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  _processMutex.set(repoPath, tail);
  try {
    return await next;
  } finally {
    // 链尾若仍是当前 tail，清掉，避免内存常驻（Map 长期累积）。
    if (_processMutex.get(repoPath) === tail) {
      _processMutex.delete(repoPath);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** O_EXCL 创建 lock 文件，返回 true=拿到锁，false=已被占。 */
async function tryAcquireLockOnce(lockPath: string): Promise<boolean> {
  try {
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL：已存在即失败。
    const fh = await fs.open(lockPath, 'wx');
    await fh.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8');
    await fh.close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // 目录不存在等错误：交给上层处理。
    throw e;
  }
}

/** 检查 lockfile 是否陈旧（pid 不存在或文件 mtime 太老），陈旧则清理。 */
async function reapStaleLock(lockPath: string): Promise<void> {
  try {
    const st = await fs.stat(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      // 不验证 pid（kill -9 后 pid 复用；mtime 阈值更可靠）。
      await fs.unlink(lockPath).catch(() => {});
    }
  } catch {
    // ENOENT 等：锁已不在，无事。
  }
}

/**
 * 拿锁：指数退避重试，总超时后抛错。绝不无锁写——无锁写无法保证 read-modify-write 原子性，
 * 会重新引入跨进程 lost-update。
 * 返回 release 函数。
 */
async function acquireLock(repoPath: string): Promise<() => Promise<void>> {
  const dir = path.join(path.resolve(repoPath), '.lore');
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILENAME);

  const start = Date.now();
  let delay = LOCK_RETRY_BASE_MS;

  while (Date.now() - start < LOCK_TOTAL_TIMEOUT_MS) {
    if (await tryAcquireLockOnce(lockPath)) {
      return async () => {
        await fs.unlink(lockPath).catch(() => {});
      };
    }
    // 失败：清陈旧锁 + 退避。
    await reapStaleLock(lockPath);
    await sleep(delay + Math.floor(Math.random() * delay)); // jitter
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }

  throw new Error(`notes.json lock timeout after ${LOCK_TOTAL_TIMEOUT_MS}ms (${lockPath})`);
}

/** 读 mtime；不存在返回 0（表示"刚被创建"，下次读到非 0 即视为变化）。 */
async function readMtime(filePath: string): Promise<number> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

class JsonNotesStore implements NotesStore {
  async load(repoPath: string): Promise<NotesFile> {
    return loadFile(repoPath);
  }

  async appendNote(
    repoPath: string,
    note: {
      kind: NoteKind;
      title: string;
      body: string;
      files?: string[];
      source: 'agent' | 'human';
      supersedes?: string;
    },
  ): Promise<{ id: string; updated: boolean; superseded: string | null }> {
    // L1 进程内串行 + L2/L3 跨进程防御。
    return withProcessMutex(path.resolve(repoPath), () => this._appendLocked(repoPath, note));
  }

  /** 实际的 read-modify-write，带跨进程锁 + mtime 重试。 */
  private async _appendLocked(
    repoPath: string,
    note: {
      kind: NoteKind;
      title: string;
      body: string;
      files?: string[];
      source: 'agent' | 'human';
      supersedes?: string;
    },
  ): Promise<{ id: string; updated: boolean; superseded: string | null }> {
    const notesPath = notesPathFor(repoPath);

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < APPEND_RETRY_LIMIT; attempt++) {
      const release = await acquireLock(repoPath);
      try {
        const mtimeBefore = await readMtime(notesPath);
        const file = await loadFile(repoPath);

        // 拿锁后再读 mtime 一次；若与 loadFile 之间被改写（极少见，锁未拿到时的兜底窗口），
        // 走重试路径。
        const mtimeAfterLoad = await readMtime(notesPath);
        if (mtimeAfterLoad !== mtimeBefore) {
          // 数据竞争：重试。
          lastErr = new Error('notes.json mtime changed during load — retrying');
          continue;
        }

        const result = applyAppend(file, note);

        // 写前最后一次 mtime 校验（双保险）：拿锁失败的并发写者可能刚抢先写过。
        const mtimeBeforeWrite = await readMtime(notesPath);
        if (mtimeBeforeWrite !== mtimeAfterLoad) {
          lastErr = new Error('notes.json mtime changed before write — retrying');
          continue;
        }

        await atomicWrite(notesPath, JSON.stringify(file, null, 2) + '\n');
        return result;
      } finally {
        await release();
      }
    }

    throw new Error(
      `notes.json: failed to write after ${APPEND_RETRY_LIMIT} attempts due to concurrent contention (${String(lastErr)})`,
    );
  }
}

/**
 * 纯函数：把一个 append 应用到 NotesFile（防重 + supersede + 新增）。
 * 抽出来便于单测，也让重试路径可重复执行（不带副作用直到 atomicWrite）。
 */
function applyAppend(
  file: NotesFile,
  note: {
    kind: NoteKind;
    title: string;
    body: string;
    files?: string[];
    source: 'agent' | 'human';
    supersedes?: string;
  },
): { id: string; updated: boolean; superseded: string | null } {
  const now = new Date().toISOString();
  const title = note.title;
  const files = note.files ?? [];

  let resultId: string;
  let updated = false;
  let superseded: string | null = null;

  // 1. 防重：同 source='agent' 且 title 完全相同且 invalidAt===null → 更新而非追加。
  //    （human 来源不做 title 防重：人工录入可能有意重复标题。契约只规定 agent 防重。）
  const dup =
    note.source === 'agent'
      ? file.notes.find(
          (n) => n.source === 'agent' && n.invalidAt === null && n.title === title,
        )
      : undefined;

  if (dup) {
    dup.body = note.body;
    dup.files = files;
    resultId = dup.id;
    updated = true;
  } else {
    const id = allocAgentId();
    const newNote: DistilledNote = {
      id,
      kind: note.kind,
      title,
      body: note.body,
      files,
      anchors: [],
      sessionId: '',
      validAt: now,
      invalidAt: null,
      supersededBy: null,
      source: note.source,
    };
    file.notes.push(newNote);
    resultId = id;
  }

  // 2. supersedes：给目标旧 note（仍有效者）打 invalidAt + supersededBy。
  if (note.supersedes) {
    const target = file.notes.find(
      (n) => n.id === note.supersedes && n.invalidAt === null,
    );
    if (target && target.id !== resultId) {
      target.invalidAt = now;
      target.supersededBy = resultId;
      superseded = target.id;
    }
  }

  // 3. schemaVersion 维持（保留蒸馏字段 distilledSessions / distilledAt）。
  file.schemaVersion = NOTES_SCHEMA_VERSION;

  return { id: resultId, updated, superseded };
}

/** 共享单例 —— 无状态，安全复用（cli.ts 通过 `mod.notesStore` 取用）。 */
export const notesStore: NotesStore = new JsonNotesStore();

/** 工厂：便于测试注入。 */
export function createNotesStore(): NotesStore {
  return new JsonNotesStore();
}
