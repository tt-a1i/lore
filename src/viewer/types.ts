/**
 * `lore serve` —— 本地图谱可视化（M4）。
 *
 * 形态：node:http 单文件服务，零前端构建链——单页 HTML 内嵌 JS，
 * D3 v7 走 CDN（含离线降级提示）。借鉴 MiroFish GraphPanel 的交互：
 * 力导向布局、节点类型配色、点击节点出详情侧栏、缩放平移；
 * lore 特有：时间轴回放（按 commit 时间过滤图谱演化）、置信度边宽、
 * Decision 节点（来自 notes.json）挂在 Session 上。
 *
 * 端点：
 *   GET /            单页 HTML
 *   GET /api/payload ViewerPayload JSON
 */

import type { GraphData } from '../graph/types.js';
import type { DistilledNote } from '../distill/types.js';

export interface ViewerPayload {
  repo: string;
  generatedAt: string;
  graph: GraphData;
  /** notes.json 不存在时为空数组。 */
  notes: DistilledNote[];
  /** 时间轴范围（commit 时间的 min/max，ISO）。 */
  timeRange: { start: string; end: string } | null;
}

export interface ViewerServer {
  /** 返回实际监听端口（port=0 时随机）。 */
  start(port: number): Promise<number>;
  stop(): Promise<void>;
}
