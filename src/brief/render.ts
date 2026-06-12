/**
 * Pure render functions for push-based memory injection.
 *
 * 无 I/O、无 process.exit、可单测。cli.ts 的 brief/guard 命令在 I/O 外壳里调用这些。
 */

import path from 'node:path';
import type { BriefNote, BriefInput } from './types.js';

/** kind 排序：constraint 最优先（最硬的约束先看），然后 rejected-approach，再 decision。 */
const KIND_ORDER: Record<string, number> = {
  constraint: 0,
  'rejected-approach': 1,
  decision: 2,
};

function kindRank(kind: string): number {
  return KIND_ORDER[kind] ?? 99;
}

/**
 * 判断一条 note 是否与某文件相关。
 * 规则（保守但不啰嗦——guard/PreToolUse 每次编辑都注入，必须克制噪声）：
 *   - note.files 含该文件（repo 相对 / 后缀 / basename 任一匹配）→ 相关。
 *   - note.files 为空：
 *       · constraint / rejected-approach（祈使型硬规则）→ 视为全局，对所有文件相关
 *         （这类是「编辑前必须知道」的，宁可多注入）。
 *       · decision（项目方向，非编辑时硬规则）→ 不算文件相关（避免每次编辑刷屏）。
 * file 入参可为绝对路径或 repo 相对路径；按 basename + 后缀匹配做宽松比较。
 */
export function noteRelatedToFile(note: BriefNote, file: string, repoPath: string): boolean {
  if (note.files.length === 0) {
    // 无文件域：只有祈使型硬规则当作全局约束注入；decision 不刷屏。
    return note.kind === 'constraint' || note.kind === 'rejected-approach';
  }
  const norm = (p: string): string => {
    let rel = p;
    if (path.isAbsolute(p)) {
      const r = path.relative(repoPath, p);
      if (!r.startsWith('..')) rel = r;
    }
    return rel.replace(/\\/g, '/');
  };
  const target = norm(file);
  for (const f of note.files) {
    const nf = norm(f);
    if (nf === target) return true;
    // 路径后缀匹配：note 记 "src/http/client.ts"，编辑路径可能是同一文件的更长/更短
    // 形式（绝对 vs 相对、worktree 前缀）。只按「以 /<path> 结尾」匹配——这要求整段
    // 路径尾对齐，不会把同名不同目录的文件（src/mcp/server.ts vs src/viewer/server.ts）
    // 误判为相关。纯 basename 匹配已废弃（会跨目录撞名，产生假阳性约束注入）。
    if (target.endsWith('/' + nf) || nf.endsWith('/' + target)) return true;
  }
  return false;
}

/**
 * 计算新鲜度标签（复用与 status 相同的口径：>4h 或 HEAD 更新 → stale）。
 * 返回一行紧凑文本。
 */
export function freshnessLine(opts: {
  repoPath: string;
  generatedAt: string | null;
  headTime: string | null;
  nowMs: number;
}): string {
  const { repoPath, generatedAt, headTime, nowMs } = opts;
  if (!generatedAt) {
    return `lore: no scan yet — run \`lore scan --repo ${repoPath}\` to index this repo.`;
  }
  const generatedMs = Date.parse(generatedAt);
  if (isNaN(generatedMs)) {
    return `lore memory: freshness unknown (run \`lore scan --repo ${repoPath}\`).`;
  }
  const FOUR_H = 4 * 60 * 60 * 1000;
  const ageMs = nowMs - generatedMs;
  const headNewer = headTime ? Date.parse(headTime) > generatedMs : false;
  const isStale = ageMs > FOUR_H || headNewer;
  if (isStale) {
    return `lore memory: STALE (run \`lore scan --repo ${repoPath}\` to refresh).`;
  }
  const mins = Math.floor(ageMs / 60_000);
  const ageStr = mins < 60 ? `${mins}m ago` : `${(ageMs / 3_600_000).toFixed(1)}h ago`;
  return `lore memory: fresh (indexed ${ageStr}).`;
}

/** 把一条 note 渲染成单行：title + (files)。body 不入简报（保紧凑）。 */
function noteLine(note: BriefNote): string {
  const filesPart = note.files.length > 0
    ? `  [${note.files.slice(0, 3).join(', ')}${note.files.length > 3 ? ', …' : ''}]`
    : '';
  return `  • ${note.title}${filesPart}`;
}

/** agent 使用指引（有 MCP 提工具名，无则提 npx 命令）。 */
export function usageHint(hasMcp: boolean): string {
  if (hasMcp) {
    return 'Before editing, you can consult lore via the lore_ask / lore_why MCP tools; record new decisions with lore_note.';
  }
  return 'Before editing, consult prior decisions with `npx lore ask "<q>" --repo . --file <path>`; record new ones with `npx lore note --repo . --kind constraint --title "…" --body "…" --source agent`.';
}

/**
 * 渲染完整项目简报（SessionStart 注入文本）。
 *
 * 结构：
 *   1. 新鲜度行
 *   2. 活跃 notes 按 kind 分组（constraint 优先），每条一行 title + files，每组 ≤maxPerKind
 *   3. 一句使用指引
 *
 * 当 input.file 提供时：只渲染与该文件相关的约束（不分组、不加指引头），用于 PreToolUse。
 */
export function renderBrief(input: BriefInput): string {
  const maxPerKind = input.maxPerKind ?? 6;
  const lines: string[] = [];

  // 1. 新鲜度（guard / PreToolUse 用 suppressFreshness 省略）
  if (!input.suppressFreshness) {
    lines.push(freshnessLine({
      repoPath: input.repoPath,
      generatedAt: input.generatedAt,
      headTime: input.headTime,
      nowMs: input.nowMs,
    }));
  }

  // 2. notes —— 先按 --file 过滤（若有）
  let pool = input.notes;
  if (input.file) {
    pool = pool.filter((n) => noteRelatedToFile(n, input.file as string, input.repoPath));
  }

  if (pool.length === 0) {
    if (lines.length > 0) lines.push('');
    lines.push(input.file
      ? `No recorded lore constraints for ${input.file}.`
      : 'No active lore notes yet.');
    // 即便无 notes 也给一句指引（SessionStart 模式），file 模式则不啰嗦。
    if (!input.file) {
      lines.push('');
      lines.push(usageHint(input.hasMcp));
    }
    return lines.join('\n');
  }

  // 分组：按 kind 排序后输出。constraint 在前。
  const byKind = new Map<string, BriefNote[]>();
  for (const n of pool) {
    const arr = byKind.get(n.kind) ?? [];
    arr.push(n);
    byKind.set(n.kind, arr);
  }
  const kinds = Array.from(byKind.keys()).sort((a, b) => kindRank(a) - kindRank(b));

  if (lines.length > 0) lines.push('');
  lines.push(input.file
    ? `lore — recorded constraints relevant to ${input.file}:`
    : 'lore — active project memory (respect these recorded decisions):');

  for (const kind of kinds) {
    const group = (byKind.get(kind) ?? []).slice(0, maxPerKind);
    const total = byKind.get(kind)?.length ?? 0;
    lines.push('');
    lines.push(`${kind} (${total}):`);
    for (const n of group) {
      lines.push(noteLine(n));
    }
    if (total > group.length) {
      lines.push(`  … and ${total - group.length} more (run \`lore ask\` for detail)`);
    }
  }

  // 3. 使用指引（file 模式下省略——PreToolUse 只要约束本身，越短越好）。
  if (!input.file) {
    lines.push('');
    lines.push(usageHint(input.hasMcp));
  }

  return lines.join('\n');
}
