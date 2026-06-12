/**
 * 对话摘录快照固化 —— 把 computeExcerpts 的结果落到 .lore/excerpts.json，
 * 使记忆不再依赖 Claude Code transcript 的留存窗口。
 *
 * 动机：transcript 文件由 Claude Code 管理、有留存窗口；一旦被清理，`lore why`
 * 的 attribution 摘录就只能静默落空。scan 时把摘录快照下来，消费端（viewer / why）
 * 在 transcript 不在时改从快照出，记忆得以持久。
 *
 * 文件形态：
 *   {
 *     schemaVersion: 1,
 *     generatedAt: ISO8601,
 *     byCommit: { [commitHash]: ViewerExcerpt[] }
 *   }
 *
 * 原子写：先写临时文件再 rename（同目录），避免读到半截 JSON。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ViewerExcerpt } from '../viewer/types.js';

export const EXCERPTS_SNAPSHOT_VERSION = 1;
export const EXCERPTS_SNAPSHOT_FILE = 'excerpts.json';

export interface ExcerptsSnapshot {
  schemaVersion: number;
  generatedAt: string;
  byCommit: Record<string, ViewerExcerpt[]>;
}

function snapshotPath(repoPath: string): string {
  return path.join(repoPath, '.lore', EXCERPTS_SNAPSHOT_FILE);
}

/**
 * 原子写 .lore/excerpts.json。确保 .lore 目录存在（scan 已建，但独立调用也安全）。
 * 临时文件名带随机后缀，避免并发写互踩；rename 在同目录内是原子的。
 */
export async function writeSnapshot(
  repoPath: string,
  excerpts: Record<string, ViewerExcerpt[]>,
): Promise<void> {
  const loreDir = path.join(repoPath, '.lore');
  await fs.mkdir(loreDir, { recursive: true });

  const snapshot: ExcerptsSnapshot = {
    schemaVersion: EXCERPTS_SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    byCommit: excerpts,
  };

  const finalPath = snapshotPath(repoPath);
  const tmpPath =
    finalPath + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
  await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (e) {
    // rename 失败时尽量清掉临时文件，再上抛。
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * 读 .lore/excerpts.json。文件缺失 / 损坏 / schema 不符 → 返回 null（视作无快照）。
 * 消费方据此走 fallback 链的下一环，绝不因快照问题抛。
 */
export async function loadSnapshot(repoPath: string): Promise<ExcerptsSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath(repoPath), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ExcerptsSnapshot>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== EXCERPTS_SNAPSHOT_VERSION ||
      typeof parsed.byCommit !== 'object' ||
      parsed.byCommit === null
    ) {
      return null;
    }
    return {
      schemaVersion: parsed.schemaVersion,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      byCommit: parsed.byCommit as Record<string, ViewerExcerpt[]>,
    };
  } catch {
    return null;
  }
}

/**
 * 取某 commit 的快照摘录。短 hash / 全 hash 双向前缀匹配——report 里可能存短 hash，
 * blame 给的是全 hash。先精确命中，再退而求前缀匹配（避免歧义优先精确）。
 * 找不到返回 null。
 */
export function excerptsForCommit(
  snapshot: ExcerptsSnapshot,
  commitHash: string,
): ViewerExcerpt[] | null {
  const exact = snapshot.byCommit[commitHash];
  if (exact) return exact;

  const lc = commitHash.toLowerCase();
  for (const [hash, excerpts] of Object.entries(snapshot.byCommit)) {
    const h = hash.toLowerCase();
    if (h.startsWith(lc) || lc.startsWith(h)) return excerpts;
  }
  return null;
}
