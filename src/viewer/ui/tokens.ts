/**
 * lore viewer 设计 tokens —— 唯一视觉事实源，视图不许自定颜色。
 *
 * 设计方向："paper blueprint"（编辑部/技术图纸风）为默认主题——
 * 暖纸底、墨色文字、衬线展示标题、蓝图点阵、mono 数据标注、单一深绿强调。
 * 高级感来自排版与留白，不靠模糊和辉光。深色主题保留（[data-theme="dark"]，
 * 顶栏可切换 + 跟随系统偏好），因此**所有颜色必须走 var()**；
 * 需要透明变体时用 color-mix(in srgb, var(--x) N%, transparent)，禁止写死 rgba。
 */

export const TOKENS_CSS = `
:root {
  /* ── paper（默认）────────────────────────────────────────── */
  --bg: #f6f4ee;
  --bg-dots: radial-gradient(circle, rgba(26, 29, 33, 0.075) 1px, transparent 1px);
  --panel: rgba(255, 255, 255, 0.82);
  --panel-solid: #ffffff;
  --border: rgba(26, 29, 33, 0.12);
  --border-strong: rgba(26, 29, 33, 0.24);

  --text: #1a1d21;
  --text-dim: #57606a;
  --text-faint: #8b939e;

  --green: #1a7f37;          /* attribution / 品牌强调（深绿，纸上够实） */
  --green-soft: color-mix(in srgb, var(--green) 32%, transparent);
  --blue: #0a5bd3;           /* sessions */
  --amber: #9a6700;          /* decisions */
  --gray-node: #8b939e;      /* files */
  --danger: #cf222e;

  /* commit 时间渐变：纸面上"越深越新"（墨水越浓 = 越近） */
  --commit-old: #b9d8bc;
  --commit-new: #1a7f37;

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "PingFang SC", "Noto Sans SC", sans-serif;
  --serif: "Iowan Old Style", "Palatino", Georgia, "Songti SC", serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;

  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 2px rgba(26, 29, 33, 0.06), 0 8px 24px rgba(26, 29, 33, 0.07);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --t-fast: 160ms var(--ease);
  --t-med: 280ms var(--ease);

  /* 视图层效果开关：纸面无辉光，墨线说话 */
  --glow-opacity: 0;
  --grid-line: rgba(26, 29, 33, 0.06);
}

[data-theme="dark"] {
  --bg: #0a0d12;
  --bg-dots: radial-gradient(circle, rgba(240, 246, 252, 0.05) 1px, transparent 1px);
  --panel: rgba(22, 27, 34, 0.72);
  --panel-solid: #161b22;
  --border: rgba(240, 246, 252, 0.09);
  --border-strong: rgba(240, 246, 252, 0.18);

  --text: #e6edf3;
  --text-dim: #9da7b3;
  --text-faint: #6e7a87;

  --green: #56d364;
  --green-soft: color-mix(in srgb, var(--green) 40%, transparent);
  --blue: #58a6ff;
  --amber: #e3b341;
  --gray-node: #6e7a87;
  --danger: #f85149;

  /* 深色维持"越亮越新" */
  --commit-old: #1c4428;
  --commit-new: #7ee787;

  --shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  --glow-opacity: 0.85;
  --grid-line: rgba(240, 246, 252, 0.05);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body { height: 100%; }
body {
  background-color: var(--bg);
  background-image: var(--bg-dots);
  background-size: 18px 18px;
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.55;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  transition: background-color var(--t-med), color var(--t-med);
}

/* ── 通用组件 ───────────────────────────────────────────────── */

.glass {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(10px) saturate(1.05);
  -webkit-backdrop-filter: blur(10px) saturate(1.05);
  box-shadow: var(--shadow);
}

.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 3%, transparent);
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
.chip .dot { width: 7px; height: 7px; border-radius: 50%; }

.btn {
  appearance: none;
  background: color-mix(in srgb, var(--text) 4%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font: inherit; font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
  transition: all var(--t-fast);
}
.btn:hover { background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--text); border-color: var(--border-strong); }
.btn.active { color: var(--green); border-color: var(--green-soft); background: color-mix(in srgb, var(--green) 9%, transparent); }

.mono { font-family: var(--mono); font-size: 11.5px; letter-spacing: -0.01em; }

/* 展示级标题（intro 大标题、空态）走衬线——编辑部气质的核心 */
.display {
  font-family: var(--serif);
  font-weight: 600;
  letter-spacing: 0.005em;
  font-feature-settings: "liga", "kern";
}

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--text) 16%, transparent); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--text) 26%, transparent); }
`;
