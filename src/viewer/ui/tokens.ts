/**
 * lore viewer 设计 tokens —— 唯一视觉事实源，视图不许自定颜色。
 *
 * 设计方向（用户钦定）：GitHub/Notion 浅色现代——白底、灰阶层次、
 * 一个强调绿、无衬线、标准密度、零特效（无点阵/衬线/辉光/玻璃模糊）。
 * 高级感来自：克制的灰阶、精确的间距节奏、熟悉的功能性形态。
 * 深色主题映射到 GitHub Dark（[data-theme="dark"]，顶栏切换）。
 * 透明变体一律 color-mix(in srgb, var(--x) N%, transparent)，禁止写死 rgba。
 */

export const TOKENS_CSS = `
:root {
  /* ── light（默认，GitHub Primer 族谱）────────────────────── */
  --bg: #f6f8fa;
  --bg-dots: none;
  --panel: #ffffff;
  --panel-solid: #ffffff;
  --border: #d1d9e0;
  --border-strong: #b6c0ca;

  --text: #1f2328;
  --text-dim: #59636e;
  --text-faint: #818b98;

  --green: #1f883d;
  --green-soft: color-mix(in srgb, var(--green) 30%, transparent);
  --blue: #0969da;
  --amber: #9a6700;
  --gray-node: #818b98;
  --danger: #cf222e;

  /* commit 时间渐变：浅底"越深越新" */
  --commit-old: #aceebb;
  --commit-new: #116329;

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "PingFang SC", "Noto Sans SC", sans-serif;
  --serif: var(--font);  /* 衬线已废，旧引用安全回落无衬线 */
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;

  --radius: 8px;
  --radius-sm: 6px;
  --shadow: 0 1px 3px color-mix(in srgb, #1f2328 8%, transparent), 0 8px 24px color-mix(in srgb, #1f2328 6%, transparent);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --t-fast: 140ms var(--ease);
  --t-med: 240ms var(--ease);

  --glow-opacity: 0;
  --grid-line: color-mix(in srgb, #1f2328 6%, transparent);
}

[data-theme="dark"] {
  --bg: #0d1117;
  --bg-dots: none;
  --panel: #161b22;
  --panel-solid: #161b22;
  --border: #30363d;
  --border-strong: #484f58;

  --text: #e6edf3;
  --text-dim: #9198a1;
  --text-faint: #6e7681;

  --green: #3fb950;
  --green-soft: color-mix(in srgb, var(--green) 35%, transparent);
  --blue: #4493f8;
  --amber: #d29922;
  --gray-node: #6e7681;
  --danger: #f85149;

  --commit-old: #033a16;
  --commit-new: #56d364;

  --shadow: 0 0 0 1px color-mix(in srgb, #ffffff 4%, transparent), 0 8px 24px color-mix(in srgb, #000000 50%, transparent);
  --glow-opacity: 0;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body { height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  transition: background-color var(--t-med), color var(--t-med);
}

/* ── 通用组件（GitHub 质感：实底卡片、发丝边、轻投影、无模糊）────── */

.glass {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
.chip .dot { width: 7px; height: 7px; border-radius: 50%; }

.btn {
  appearance: none;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font: inherit; font-size: 12px; font-weight: 500;
  padding: 4px 12px;
  cursor: pointer;
  box-shadow: 0 1px 0 color-mix(in srgb, #1f2328 4%, transparent);
  transition: all var(--t-fast);
}
.btn:hover { background: var(--bg); border-color: var(--border-strong); }
.btn.active { color: var(--green); border-color: var(--green-soft); background: color-mix(in srgb, var(--green) 7%, transparent); }

.mono { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0; }

/* .display 历史类：衬线已废，保留类名以兼容旧引用——回落为加重无衬线 */
.display {
  font-family: var(--font);
  font-weight: 700;
  letter-spacing: -0.01em;
}

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--text) 18%, transparent); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--text) 30%, transparent); }
`;
