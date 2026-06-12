/**
 * lore viewer 单页组装器 —— 零构建链：把 tokens/shell/各视图的 CSS 与 JS
 * 拼成一份自包含 HTML（D3 v7 走 CDN，含失败提示）。
 *
 * 架构：shell 提供运行时（视图切换/共享状态/抽屉/时间轴），
 * 每个视图模块（ui/view-*.ts）导出 CSS 与 JS 字符串，JS 内通过
 * window.LORE_VIEWS.push({...}) 注册（协议见 ui/shell.ts 头注释）。
 * 视图注册顺序 = 切换器顺序 = 数字快捷键顺序。
 */

import { TOKENS_CSS } from './ui/tokens.js';
import { SHELL_HTML, SHELL_CSS, SHELL_JS } from './ui/shell.js';
import * as story from './ui/view-story.js';
import * as graph from './ui/view-graph.js';
import * as map from './ui/view-map.js';
import * as decisions from './ui/view-decisions.js';

const VIEWS = [story, graph, map, decisions];

export function buildPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lore — ${'graph viewer'}</title>
<style>
${TOKENS_CSS}
${SHELL_CSS}
${VIEWS.map((v) => v.CSS).join('\n')}
</style>
</head>
<body>
${SHELL_HTML}
<script>
function showCdnError() {
  document.getElementById('loading').textContent =
    'failed to load D3 from CDN — check your network connection';
}
</script>
<script src="https://cdn.jsdelivr.net/npm/d3@7" crossorigin="anonymous" onerror="showCdnError()"></script>
<script>
window.LORE_VIEWS = [];
${VIEWS.map((v) => v.JS).join('\n')}
${SHELL_JS}
</script>
</body>
</html>`;
}
