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
    <div class="brand">lore<span class="brand-dot">.</span></div>
    <span class="chip" id="repo-chip"></span>
    <span class="chip" id="stats-chip"></span>
    <nav id="view-switch" role="tablist"></nav>
  </header>

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
.brand { font-size: 17px; font-weight: 700; letter-spacing: 0.02em; margin-right: 4px; }
.brand-dot { color: var(--green); }

#view-switch {
  margin-left: auto;
  display: flex; gap: 2px;
  background: rgba(240, 246, 252, 0.05);
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
  background: rgba(240, 246, 252, 0.1);
  box-shadow: 0 1px 4px rgba(0,0,0,0.3);
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
  color: var(--text-dim); font-size: 12px; background: rgba(86,211,100,0.04);
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
  background: rgba(240, 246, 252, 0.1); border-radius: 2px;
}
#scrubber-fill {
  position: absolute; left: 0; top: 10px; height: 3px; width: 100%;
  background: linear-gradient(90deg, var(--commit-old), var(--green));
  border-radius: 2px; pointer-events: none;
}
#scrubber-knob {
  position: absolute; top: 4px; width: 15px; height: 15px; margin-left: -7px; left: 100%;
  background: var(--text); border-radius: 50%;
  box-shadow: 0 0 0 4px rgba(86, 211, 100, 0.25), 0 2px 6px rgba(0,0,0,0.5);
  pointer-events: none; transition: box-shadow var(--t-fast);
}
#scrubber:hover #scrubber-knob { box-shadow: 0 0 0 6px rgba(86, 211, 100, 0.35), 0 2px 6px rgba(0,0,0,0.5); }
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
  document.getElementById('stats-chip').textContent =
    g.sessions.length + ' sessions · ' + g.commits.length + ' commits · ' + payload.notes.length + ' decisions';

  // ── 视图切换 ────────────────────────────────────────────────────
  const stage = document.getElementById('stage');
  const nav = document.getElementById('view-switch');
  const mounted = new Set();
  let activeView = null;

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
    location.hash = view.id;
  }

  for (const view of window.LORE_VIEWS) {
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

  function stopPlay() {
    playing = false; playBtn.textContent = '▶';
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
  }
  playBtn.addEventListener('click', () => {
    if (playing) { stopPlay(); return; }
    playing = true; playBtn.textContent = '⏸';
    if (frac >= 1) applyFrac(0);
    playTimer = setInterval(() => {
      if (frac >= 1) { stopPlay(); return; }
      applyFrac(frac + 0.004);
    }, 40);
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

  // ── 启动 ────────────────────────────────────────────────────────
  applyFrac(1, false);
  const initial = window.LORE_VIEWS.find(v => '#' + v.id === location.hash) || window.LORE_VIEWS[0];
  if (initial) activate(initial);
  document.getElementById('loading').classList.add('done');
}

bootShell();
`;
