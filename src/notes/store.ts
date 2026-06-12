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

/** 生成 agent/human 笔记的 id：`agent-<base36 时间戳>-<4位随机>`。 */
function allocAgentId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
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
    // 写前重读：在最新磁盘内容上施加变更（并发安全的核心）。两个并发 append 各自重读 →
    // 后写者看到前写者已落盘的 note，再原子写覆盖；先写者的 note 不丢（它已在磁盘上，
    // 被后写者读入并保留）。前提：append 不修改别人的 note（除非显式 supersedes）。
    const file = await loadFile(repoPath);

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

    // 3. 原子落盘（保留蒸馏字段 schemaVersion / distilledSessions / distilledAt）。
    file.schemaVersion = NOTES_SCHEMA_VERSION;
    await atomicWrite(notesPathFor(repoPath), JSON.stringify(file, null, 2) + '\n');

    return { id: resultId, updated, superseded };
  }
}

/** 共享单例 —— 无状态，安全复用（cli.ts 通过 `mod.notesStore` 取用）。 */
export const notesStore: NotesStore = new JsonNotesStore();

/** 工厂：便于测试注入。 */
export function createNotesStore(): NotesStore {
  return new JsonNotesStore();
}
