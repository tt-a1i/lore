/**
 * Direct-read data layer for `lore brief` / `lore guard`.
 *
 * 性能契约（<150ms）：只读 .lore/notes.json 的 notes[] 与 .lore/report.json 的
 * generatedAt，外加一次 `git log -1`。绝不 import 匹配引擎、graph、parser，
 * 也不解析 transcript。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { BriefNote } from './types.js';

/**
 * 读 .lore/report.json 的 generatedAt（只取这一个字段）。
 * 缺文件 / 损坏 / 无字段 → null（brief 据此提示「未 scan」）。
 */
export async function readGeneratedAt(repoPath: string): Promise<string | null> {
  const reportPath = path.join(repoPath, '.lore', 'report.json');
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    const obj = JSON.parse(raw) as { generatedAt?: unknown };
    return typeof obj.generatedAt === 'string' ? obj.generatedAt : null;
  } catch {
    return null;
  }
}

/**
 * 读 .lore/notes.json，返回活跃 notes（invalidAt===null）的最小形态。
 * 缺文件 / 损坏 → []（brief 据此提示「无 notes」）。
 * 缺 source 字段视为 'distilled'（与 NotesStore 口径一致）。
 */
export async function readActiveNotes(repoPath: string): Promise<BriefNote[]> {
  const notesPath = path.join(repoPath, '.lore', 'notes.json');
  let raw: string;
  try {
    raw = await fs.readFile(notesPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const rawNotes = (parsed as { notes?: unknown }).notes;
  if (!Array.isArray(rawNotes)) return [];

  const out: BriefNote[] = [];
  for (const n of rawNotes) {
    if (!n || typeof n !== 'object') continue;
    const note = n as Record<string, unknown>;
    // 只要活跃的：invalidAt 非 null 即已被推翻，跳过。
    if (note['invalidAt'] !== null && note['invalidAt'] !== undefined) continue;
    if (typeof note['kind'] !== 'string') continue;
    out.push({
      kind: note['kind'],
      title: typeof note['title'] === 'string' ? note['title'] : '',
      body: typeof note['body'] === 'string' ? note['body'] : '',
      files: Array.isArray(note['files'])
        ? note['files'].filter((f): f is string => typeof f === 'string')
        : [],
      source: note['source'] === 'agent' || note['source'] === 'human' || note['source'] === 'distilled'
        ? note['source']
        : 'distilled',
      invalidAt: null,
    });
  }
  return out;
}

/**
 * 读 HEAD commit 时间（git log -1）。取不到 → null（不影响新鲜度降级判定）。
 * 超时硬上限 1s——绝不让钩子因 git 卡死而拖垮 session。
 */
export async function readHeadTime(repoPath: string): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'log', '-1', '--format=%cI'],
      { encoding: 'utf8', timeout: 1000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 检测 lore MCP 是否对当前 repo 配置（决定使用指引的措辞）。
 * 启发式：扫 <repo>/.mcp.json 与 <repo>/.claude/settings.json，任一含含 "lore" 的
 * mcpServers key / command 即视为有 MCP。读不到一律 false（保守——提 npx 命令更通用）。
 */
export async function detectLoreMcp(repoPath: string): Promise<boolean> {
  const candidates = [
    path.join(repoPath, '.mcp.json'),
    path.join(repoPath, '.claude', 'settings.json'),
    path.join(repoPath, '.claude', 'settings.local.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const obj = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const servers = obj.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [key, val] of Object.entries(servers)) {
          if (key.toLowerCase().includes('lore')) return true;
          const cmd = (val as { command?: unknown })?.command;
          const args = (val as { args?: unknown })?.args;
          if (typeof cmd === 'string' && cmd.includes('lore')) return true;
          if (Array.isArray(args) && args.some((a) => typeof a === 'string' && a.includes('lore'))) return true;
        }
      }
    } catch {
      // 缺文件 / 损坏 — 跳过这个候选。
    }
  }
  return false;
}
