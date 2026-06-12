/**
 * Shell —— 视图无关的运行时：布局骨架、视图切换、共享状态、抽屉、时间轴。
 *
 * 视图模块协议（每个 view-*.ts 的 JS 通过 IIFE 注册）：
 *   window.LORE_VIEWS.push({
 *     id: 'story', label: 'Story',
 *     mount(el, ctx),        // 首次进入时调用一次，el 是该视图的 <section>
 *     onTimeline(cutoffMs),  // 时间轴变化（null = 全量）
 *     onShow(), onResize(),  // 可选
 *   })
 *
 * ctx（shell 提供给视图的服务）：
 *   ctx.payload                     // ViewerPayload
 *   ctx.cutoffMs                    // 当前时间轴位置（ms，null=全量）
 *   ctx.drawer.show(html) / hide()  // 右侧详情抽屉
 *   ctx.fmt.date(d) / hash(h) / esc(s)
 *   ctx.commitColor(dateMs)         // 时间渐变色
 *   ctx.attributionIndex             // commitHash -> ProducedEdgeData[]（预建索引）
 */

export const SHELL_HTML = `
<div id="app">
  <header id="topbar" class="glass">
    <div class="brand display">lore<span class="brand-dot">.</span></div>
    <span class="chip" id="repo-chip"></span>
    <span class="chip" id="stats-chip"></span>
    <button id="theme-toggle" class="btn" title="切换主题 / Toggle theme" aria-label="toggle theme">☾</button>
    <button id="intro-replay" class="btn" title="Replay intro" aria-label="replay intro">?</button>
    <nav id="view-switch" role="tablist"></nav>
  </header>

  <div id="view-subtitle"></div>

  <main id="stage"></main>

  <aside id="drawer">
    <button id="drawer-close" class="btn" aria-label="close">✕</button>
    <div id="drawer-body"></div>
  </aside>

  <footer id="timebar" class="glass">
    <button id="play-btn" class="btn" title="播放项目演化">▶</button>
    <div id="scrubber"><div id="scrubber-fill"></div><div id="scrubber-knob"></div></div>
    <span id="time-display" class="mono"></span>
  </footer>

  <div id="loading">loading the lore…</div>
</div>
`;

export const SHELL_CSS = `
#app { position: relative; width: 100vw; height: 100vh; overflow: hidden; }

#topbar {
  position: absolute; top: 14px; left: 14px; right: 14px; z-index: 30;
  display: flex; align-items: center; gap: 10px;
  padding: 9px 16px;
}
.brand { font-size: 18px; font-weight: 600; letter-spacing: 0.01em; margin-right: 4px; }
.brand-dot { color: var(--green); }

#intro-replay, #theme-toggle {
  width: 24px; height: 24px; padding: 0; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; line-height: 1; border-radius: 50%;
}

#view-subtitle {
  position: absolute; top: 74px; left: 30px; right: 30px; z-index: 28;
  font-family: var(--font); font-size: 12px; color: var(--text-dim);
  letter-spacing: 0.01em; pointer-events: none;
  opacity: 0; transform: translateY(-3px);
  transition: opacity var(--t-med), transform var(--t-med);
}
#view-subtitle.show { opacity: 1; transform: translateY(0); }

#view-switch {
  margin-left: auto;
  display: flex; gap: 2px;
  background: color-mix(in srgb, var(--text) 4%, transparent);
  border: 1px solid var(--border);
  border-radius: 9px; padding: 3px;
}
#view-switch button {
  appearance: none; border: 0; background: transparent;
  color: var(--text-dim); font: inherit; font-size: 12.5px;
  padding: 5px 16px; border-radius: 6px; cursor: pointer;
  transition: all var(--t-fast);
}
#view-switch button:hover { color: var(--text); }
#view-switch button.active {
  color: var(--text);
  background: var(--panel-solid);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--text) 14%, transparent);
}

#stage { position: absolute; inset: 0; }
#stage section.view { position: absolute; inset: 0; display: none; }
#stage section.view.visible { display: block; }

#drawer {
  position: absolute; top: 70px; right: 14px; bottom: 76px; z-index: 25;
  width: 360px; max-width: calc(100vw - 28px);
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  backdrop-filter: blur(14px) saturate(1.2); -webkit-backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: var(--shadow);
  transform: translateX(calc(100% + 28px));
  transition: transform var(--t-med);
  overflow-y: auto;
}
#drawer.open { transform: translateX(0); }
#drawer-close { position: absolute; top: 10px; right: 10px; padding: 2px 8px; z-index: 2; }
#drawer-body { padding: 18px; }
#drawer-body h3 { font-size: 14px; margin-bottom: 10px; padding-right: 30px; }
#drawer-body .row { display: flex; gap: 8px; margin: 5px 0; font-size: 12px; }
#drawer-body .row .k { color: var(--text-faint); min-width: 78px; flex-shrink: 0; }
#drawer-body .row .v { color: var(--text); word-break: break-all; }
#drawer-body .sep { border-top: 1px solid var(--border); margin: 13px 0; }
#drawer-body .quote {
  border-left: 2px solid var(--green-soft); padding: 6px 10px; margin: 8px 0;
  color: var(--text-dim); font-size: 12px; background: color-mix(in srgb, var(--green) 5%, transparent);
  border-radius: 0 6px 6px 0; white-space: pre-wrap;
}

#timebar {
  position: absolute; left: 14px; right: 14px; bottom: 14px; z-index: 30;
  display: flex; align-items: center; gap: 14px;
  padding: 10px 16px;
}
#scrubber {
  position: relative; flex: 1; height: 22px; cursor: pointer;
}
#scrubber::before {
  content: ''; position: absolute; left: 0; right: 0; top: 10px; height: 3px;
  background: color-mix(in srgb, var(--text) 10%, transparent); border-radius: 2px;
}
#scrubber-fill {
  position: absolute; left: 0; top: 10px; height: 3px; width: 100%;
  background: linear-gradient(90deg, var(--commit-old), var(--green));
  border-radius: 2px; pointer-events: none;
}
#scrubber-knob {
  position: absolute; top: 4px; width: 15px; height: 15px; margin-left: -7px; left: 100%;
  background: var(--panel-solid); border: 1px solid var(--border-strong); border-radius: 50%;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 25%, transparent), 0 2px 6px rgba(0,0,0,0.2);
  pointer-events: none; transition: box-shadow var(--t-fast);
}
#scrubber:hover #scrubber-knob { box-shadow: 0 0 0 6px color-mix(in srgb, var(--green) 35%, transparent), 0 2px 6px rgba(0,0,0,0.2); }
#time-display { color: var(--text-dim); min-width: 118px; text-align: right; font-size: 11.5px; }

#loading {
  position: absolute; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--text-faint);
  font-size: 13px; letter-spacing: 0.06em;
  transition: opacity 400ms ease;
}
#loading.done { opacity: 0; pointer-events: none; }
`;

export const SHELL_JS = `
// LORE_VIEWS 由组装器在视图脚本之前初始化（视图先注册、shell 后启动）。
window.LORE_VIEWS = window.LORE_VIEWS || [];

// ── 主题：boot 时按 localStorage('lore-theme') → 无则 prefers-color-scheme ──────
// 立即执行（尽量早，避免浅/深闪烁）。data-theme='dark' 走深色，移除=纸面浅色。
(function () {
  function resolveTheme() {
    try {
      var saved = localStorage.getItem('lore-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (e) {}
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    // 同步切换按钮字符（☾ 浅色态点深色 / ☀ 深色态点浅色）。
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
  }
  window.LORE_THEME = {
    get: resolveTheme,
    current: function () {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },
    apply: applyTheme,
    toggle: function () {
      var next = (window.LORE_THEME.current() === 'dark') ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('lore-theme', next); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('lore:theme', { detail: { theme: next } })); } catch (e) {}
    },
  };
  applyTheme(resolveTheme());
})();

// ── i18n：shell 持字典，按 navigator.language 选 zh/en ─────────────────
// 视图与 intro 通过 window.LORE_T(key) 取文案，且都做了 LORE_T 不存在的兜底。
(function () {
  var EN = {
    'intro.headline': 'Software is made between commits.',
    'intro.sub': 'In this repo, {sessions} conversations with AI agents shaped {commits} commits. Every glowing commit remembers the conversation that made it.',
    'intro.watch': 'Watch the story',
    'intro.skip': 'Skip',
    'intro.keys': '<kbd>1</kbd>–<kbd>4</kbd> views <span class="sepdot">·</span> <kbd>Space</kbd> play <span class="sepdot">·</span> <kbd>Esc</kbd> close',
    'story.subtitle': 'Who made what, and why — on one timeline',
    'graph.subtitle': 'Explore how conversations, commits and files connect',
    'map.subtitle': 'Which code has memory — and which is a black hole',
    'decisions.subtitle': 'Decisions, constraints and rejected paths — with their full history',
    'stats.template': '{s} conversations · {c} commits · {n} decisions',
    'coachmark': 'This is the conversation that wrote this commit.',
    'coachmark.text': 'This commit was written with an AI agent — click any row to read the conversation behind it.',
    'story.coverage': '{a} of {c} commits have conversation provenance',
    'story.noconvo': 'no conversation recorded',
    'map.legend': 'AI memory coverage',
  };
  var ZH = {
    'intro.headline': '软件诞生于提交之间。',
    'intro.sub': '在这个仓库里，{sessions} 段与 AI 的对话塑造了 {commits} 个 commit。每个发光的 commit，都记得造就它的那段对话。',
    'intro.watch': '看看这段历史',
    'intro.skip': '跳过',
    'intro.keys': '<kbd>1</kbd>–<kbd>4</kbd> 视图 <span class="sepdot">·</span> <kbd>Space</kbd> 播放 <span class="sepdot">·</span> <kbd>Esc</kbd> 关闭',
    'story.subtitle': '谁在什么时候、为什么做了什么——一条时间轴讲完',
    'graph.subtitle': '探索对话、提交与文件如何相连',
    'map.subtitle': '哪片代码有记忆，哪片是黑洞',
    'decisions.subtitle': '决策、约束与被否决的路——以及它们的完整历史',
    'stats.template': '{s} 段对话 · {c} 个 commit · {n} 条决策',
    'coachmark': '这就是写出这个 commit 的对话。',
    'coachmark.text': '这个 commit 由 AI agent 写就——点任意一行，读它背后的对话。',
    'story.coverage': '{a} / {c} 个 commit 带对话出处',
    'story.noconvo': '无对话记录',
    'map.legend': 'AI 记忆覆盖度',
  };
  var lang = 'en';
  try {
    var nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    if (nav.indexOf('zh') === 0) lang = 'zh';
  } catch (e) {}
  var dict = lang === 'zh' ? ZH : EN;
  window.LORE_LANG = lang;
  window.LORE_T = function (key) {
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    if (Object.prototype.hasOwnProperty.call(EN, key)) return EN[key];
    return key;
  };
})();

async function bootShell() {
  let payload;
  try {
    payload = await fetch('/api/payload').then(r => r.json());
  } catch (e) {
    document.getElementById('loading').textContent = 'failed to load payload: ' + e.message;
    return;
  }

  // ── 共享索引与工具 ──────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtDate = d => {
    const dt = (d instanceof Date) ? d : new Date(d);
    return isNaN(dt) ? '—' : dt.toISOString().slice(0, 10);
  };
  const fmtDateTime = d => {
    const dt = (d instanceof Date) ? d : new Date(d);
    return isNaN(dt) ? '—' : dt.toISOString().slice(0, 16).replace('T', ' ');
  };

  const attributionIndex = new Map(); // commitHash -> produced[]
  for (const p of payload.graph.produced) {
    if (!attributionIndex.has(p.commitHash)) attributionIndex.set(p.commitHash, []);
    attributionIndex.get(p.commitHash).push(p);
  }
  for (const arr of attributionIndex.values()) arr.sort((a, b) => b.confidence - a.confidence);

  const commitDates = payload.graph.commits.map(c => +new Date(c.authorDate)).filter(t => !isNaN(t));
  const tMin = commitDates.length ? Math.min(...commitDates) : Date.now();
  const tMax = commitDates.length ? Math.max(...commitDates) : Date.now();
  const commitColor = t => {
    const k = (tMax === tMin) ? 1 : (t - tMin) / (tMax - tMin);
    return d3.interpolateRgb(getComputedStyle(document.documentElement).getPropertyValue('--commit-old').trim(),
                             getComputedStyle(document.documentElement).getPropertyValue('--commit-new').trim())(k);
  };

  // ── 抽屉 ────────────────────────────────────────────────────────
  const drawerEl = document.getElementById('drawer');
  const drawerBody = document.getElementById('drawer-body');
  const drawer = {
    show(html) { drawerBody.innerHTML = html; drawerEl.classList.add('open'); },
    hide() { drawerEl.classList.remove('open'); },
  };
  document.getElementById('drawer-close').addEventListener('click', drawer.hide);

  // ── ctx ────────────────────────────────────────────────────────
  const ctx = {
    payload,
    cutoffMs: null,
    tMin, tMax,
    drawer,
    attributionIndex,
    commitColor,
    fmt: { date: fmtDate, datetime: fmtDateTime, esc, hash: h => String(h).slice(0, 8) },
  };

  // ── 头部信息 ────────────────────────────────────────────────────
  document.getElementById('repo-chip').textContent = (payload.repo || '').split('/').pop();
  const g = payload.graph;
  // 人话模板：{s} 段对话 · {c} 个 commit · {n} 条决策（LORE_T 不存在时英文兜底）
  const statsTmpl = (typeof window.LORE_T === 'function')
    ? window.LORE_T('stats.template')
    : '{s} conversations · {c} commits · {n} decisions';
  document.getElementById('stats-chip').textContent = String(statsTmpl)
    .replace('{s}', g.sessions.length)
    .replace('{c}', g.commits.length)
    .replace('{n}', payload.notes.length);

  // ── 视图切换 ────────────────────────────────────────────────────
  const stage = document.getElementById('stage');
  const nav = document.getElementById('view-switch');
  const subtitleEl = document.getElementById('view-subtitle');
  const mounted = new Set();
  let activeView = null;

  // 副标题：切视图时淡入。视图对象可带 subtitleKey（走 LORE_T），否则不显示。
  function renderSubtitle(view) {
    if (!subtitleEl) return;
    let text = '';
    const key = view && view.subtitleKey;
    if (key && typeof window.LORE_T === 'function') {
      const t = window.LORE_T(key);
      if (t && t !== key) text = t;
    }
    // 淡出 → 换字 → 淡入（即使切到无副标题的视图也优雅消失）
    subtitleEl.classList.remove('show');
    setTimeout(() => {
      subtitleEl.textContent = text;
      if (text) subtitleEl.classList.add('show');
    }, 90);
  }

  function activate(view) {
    activeView = view;
    for (const v of window.LORE_VIEWS) {
      v._section.classList.toggle('visible', v === view);
      v._tab.classList.toggle('active', v === view);
    }
    if (!mounted.has(view.id)) {
      mounted.add(view.id);
      try { view.mount(view._section, ctx); } catch (e) { console.error('view mount failed:', view.id, e); }
    }
    if (view.onShow) try { view.onShow(); } catch (e) { console.error(e); }
    renderSubtitle(view);
    location.hash = view.id;
  }

  for (const view of window.LORE_VIEWS) {
    // 副标题键：视图可显式提供 subtitleKey，否则按 '<id>.subtitle' 约定兜底，
    // 这样即使视图模块尚未更新也能显示对应文案。
    if (!view.subtitleKey) view.subtitleKey = view.id + '.subtitle';

    const section = document.createElement('section');
    section.className = 'view';
    section.id = 'view-' + view.id;
    stage.appendChild(section);
    view._section = section;

    const tab = document.createElement('button');
    tab.textContent = view.label;
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => activate(view));
    nav.appendChild(tab);
    view._tab = tab;
  }

  // ── 时间轴（自定义 scrubber）────────────────────────────────────
  const scrubber = document.getElementById('scrubber');
  const fill = document.getElementById('scrubber-fill');
  const knob = document.getElementById('scrubber-knob');
  const timeDisplay = document.getElementById('time-display');
  const playBtn = document.getElementById('play-btn');
  let frac = 1, playing = false, playTimer = null;

  function applyFrac(f, broadcast = true) {
    frac = Math.max(0, Math.min(1, f));
    fill.style.width = (frac * 100) + '%';
    knob.style.left = (frac * 100) + '%';
    ctx.cutoffMs = frac >= 1 ? null : tMin + frac * (tMax - tMin);
    timeDisplay.textContent = frac >= 1 ? 'now' : fmtDateTime(ctx.cutoffMs);
    if (broadcast) {
      for (const v of window.LORE_VIEWS) {
        if (mounted.has(v.id) && v.onTimeline) {
          try { v.onTimeline(ctx.cutoffMs); } catch (e) { console.error(e); }
        }
      }
    }
  }

  function fracFromEvent(ev) {
    const rect = scrubber.getBoundingClientRect();
    return (ev.clientX - rect.left) / rect.width;
  }
  let dragging = false;
  scrubber.addEventListener('pointerdown', ev => { dragging = true; scrubber.setPointerCapture(ev.pointerId); applyFrac(fracFromEvent(ev)); });
  scrubber.addEventListener('pointermove', ev => { if (dragging) applyFrac(fracFromEvent(ev)); });
  scrubber.addEventListener('pointerup', () => { dragging = false; });

  // ── 导览：从 payload.excerpts 选摘录总字符数最大的 commit ─────────────
  function pickDemoCommit() {
    const ex = payload.excerpts || {};
    let best = null, bestLen = -1;
    for (const hash in ex) {
      if (!Object.prototype.hasOwnProperty.call(ex, hash)) continue;
      const list = ex[hash] || [];
      let len = 0;
      for (let i = 0; i < list.length; i++) len += (list[i] && list[i].text ? list[i].text.length : 0);
      if (len > bestLen) { bestLen = len; best = hash; }
    }
    // 兜底：无 excerpts 时取归因数最高的 commit
    if (!best) {
      let bn = -1;
      for (const h of attributionIndex.keys()) {
        const n = (attributionIndex.get(h) || []).length;
        if (n > bn) { bn = n; best = h; }
      }
    }
    return best;
  }
  function dispatchDemo() {
    const hash = pickDemoCommit();
    if (!hash) return;
    try { window.dispatchEvent(new CustomEvent('lore:demo', { detail: { commitHash: hash } })); }
    catch (e) {}
  }

  // ── 电影化回放：8s，d3.easeCubicInOut 缓动驱动 applyFrac ───────────────
  const PLAY_MS = 8000;
  let playRAF = null, playStartTs = 0;

  function stopPlay(opts) {
    const wasPlaying = playing;
    playing = false; playBtn.textContent = '▶';
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (playRAF) { cancelAnimationFrame(playRAF); playRAF = null; }
    if (wasPlaying) {
      try { window.dispatchEvent(new CustomEvent('lore:play-end')); } catch (e) {}
      // 自然播完才导览（用户中途暂停不打扰）
      if (opts && opts.completed) dispatchDemo();
    }
  }

  function startPlay() {
    if (playing) return;
    playing = true; playBtn.textContent = '⏸';
    applyFrac(0);
    try { window.dispatchEvent(new CustomEvent('lore:play-start')); } catch (e) {}
    const easeFn = (typeof d3 !== 'undefined' && d3.easeCubicInOut)
      ? d3.easeCubicInOut
      : function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
    playStartTs = 0;
    function frame(ts) {
      if (!playing) return;
      if (!playStartTs) playStartTs = ts;
      const p = Math.min(1, (ts - playStartTs) / PLAY_MS);
      applyFrac(easeFn(p));
      if (p < 1) {
        playRAF = requestAnimationFrame(frame);
      } else {
        applyFrac(1);
        stopPlay({ completed: true });
      }
    }
    playRAF = requestAnimationFrame(frame);
  }

  playBtn.addEventListener('click', () => {
    if (playing) { stopPlay(); return; }
    startPlay();
  });

  // ── 键盘 ────────────────────────────────────────────────────────
  document.addEventListener('keydown', ev => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
    const idx = parseInt(ev.key, 10) - 1;
    if (idx >= 0 && idx < window.LORE_VIEWS.length) activate(window.LORE_VIEWS[idx]);
    if (ev.key === ' ') { ev.preventDefault(); playBtn.click(); }
    if (ev.key === 'Escape') drawer.hide();
  });

  window.addEventListener('resize', () => {
    for (const v of window.LORE_VIEWS) {
      if (mounted.has(v.id) && v.onResize) try { v.onResize(); } catch (e) { console.error(e); }
    }
  });

  // ── intro overlay 开场 ──────────────────────────────────────────
  // attributed 数 = excerpts 的 key 数（缺省用 attributionIndex.size）
  function attributedCount() {
    const ex = payload.excerpts;
    if (ex && typeof ex === 'object') {
      const n = Object.keys(ex).length;
      if (n > 0) return n;
    }
    return attributionIndex.size;
  }
  function openIntro() {
    if (!window.LORE_INTRO || typeof window.LORE_INTRO.open !== 'function') return false;
    window.LORE_INTRO.open({
      sessions: g.sessions.length,
      commits: g.commits.length,
      decisions: payload.notes.length,
      attributed: attributedCount(),
      onWatch: function () {
        // 确保 story 视图是当前视图（电影感主场）
        const story = window.LORE_VIEWS.find(v => v.id === 'story') || window.LORE_VIEWS[0];
        if (story && activeView !== story) activate(story);
        startPlay();
      },
      onSkip: function () { dispatchDemo(); },
    });
    return true;
  }

  // topbar "?" 随时重看
  const replayBtn = document.getElementById('intro-replay');
  if (replayBtn) replayBtn.addEventListener('click', () => { openIntro(); });

  // topbar 主题切换：切 data-theme、存 localStorage、派发 lore:theme（各视图重读颜色）。
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn && window.LORE_THEME) {
    // 同步初始字符（boot 时按钮可能尚未在 DOM）。
    themeBtn.textContent = window.LORE_THEME.current() === 'dark' ? '☀' : '☾';
    themeBtn.addEventListener('click', () => { window.LORE_THEME.toggle(); });
  }

  // ── 启动 ────────────────────────────────────────────────────────
  applyFrac(1, false);
  const initial = window.LORE_VIEWS.find(v => '#' + v.id === location.hash) || window.LORE_VIEWS[0];
  if (initial) activate(initial);
  document.getElementById('loading').classList.add('done');

  // loading 淡出后：未看过 intro 则显示，否则直进视图。
  // ?intro=1 强制重看（演示/录屏后门）。
  const forceIntro = /[?&]intro=1/.test(location.search);
  const introSeen = (window.LORE_INTRO && typeof window.LORE_INTRO.seen === 'function')
    ? window.LORE_INTRO.seen() : false;
  setTimeout(() => {
    if (forceIntro || !introSeen) openIntro();
  }, 420);
}

bootShell();
`;
