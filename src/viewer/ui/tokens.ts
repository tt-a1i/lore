/**
 * lore viewer 设计 tokens —— 全部视图共用的视觉语言。唯一事实源，视图不许自定颜色。
 *
 * 基调：深墨底 + 霜玻璃面板 + 单一品牌绿（attribution 的颜色）+ 克制的辉光。
 * 节点语义色固定：session 蓝、commit 绿（时间深浅）、file 灰、decision 琥珀。
 */

export const TOKENS_CSS = `
:root {
  /* surfaces */
  --bg: #0a0d12;
  --bg-vignette: radial-gradient(1200px 800px at 30% 20%, #0f141c 0%, #0a0d12 60%);
  --panel: rgba(22, 27, 34, 0.66);
  --panel-solid: #161b22;
  --border: rgba(240, 246, 252, 0.09);
  --border-strong: rgba(240, 246, 252, 0.16);

  /* text */
  --text: #e6edf3;
  --text-dim: #9da7b3;
  --text-faint: #6e7a87;

  /* brand & semantics */
  --green: #56d364;          /* attribution / brand */
  --green-soft: #2ea04366;
  --blue: #58a6ff;           /* sessions */
  --amber: #e3b341;          /* decisions */
  --gray-node: #6e7a87;      /* files */
  --danger: #f85149;

  /* commit time ramp (old → new) */
  --commit-old: #1c4428;
  --commit-new: #7ee787;

  /* typography */
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "PingFang SC", "Noto Sans SC", sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;

  /* shape & motion */
  --radius: 12px;
  --radius-sm: 7px;
  --shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --t-fast: 160ms var(--ease);
  --t-med: 280ms var(--ease);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body { height: 100%; }
body {
  background: var(--bg-vignette), var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

/* ── 通用组件 ───────────────────────────────────────────────── */

.glass {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: var(--shadow);
}

.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(240, 246, 252, 0.04);
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
.chip .dot { width: 7px; height: 7px; border-radius: 50%; }

.btn {
  appearance: none;
  background: rgba(240, 246, 252, 0.05);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font: inherit; font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
  transition: all var(--t-fast);
}
.btn:hover { background: rgba(240, 246, 252, 0.1); color: var(--text); border-color: var(--border-strong); }
.btn.active { color: var(--green); border-color: var(--green-soft); background: rgba(86, 211, 100, 0.08); }

.mono { font-family: var(--mono); font-size: 11.5px; letter-spacing: -0.01em; }

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: rgba(240, 246, 252, 0.12); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(240, 246, 252, 0.2); }
`;
