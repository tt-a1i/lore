/**
 * Parser 注册表 —— scan 的统一入口：对一个 repo 跑全部已知 agent 的 parser，
 * 事件归一后对引擎/图谱完全透明。
 *
 * M4 在此注册 codexParser / opencodeParser。
 * discover 互不重叠（各家数据目录不同）；parse 失败的文件由调用方计警告跳过。
 */

import type { TranscriptParser } from '../schema/events.js';
import { claudeCodeParser } from './claude-code.js';

export const allParsers: TranscriptParser[] = [
  claudeCodeParser,
  // M4: codexParser（~/.codex/sessions rollout jsonl）
  // M4: opencodeParser（~/.local/share/opencode/opencode.db，node:sqlite）
];
