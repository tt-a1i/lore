/**
 * view-story —— "Software is made between commits" 的时间轴叙事（主打视图）。
 *
 * 全屏 SVG 水平时间轴：
 *   - 顶部 session 泳道（蓝色胶囊，贪心装行）
 *   - 中央 commit 带（圆角方块，∝ 触碰文件数，归因者带绿辉光）
 *   - 归因丝带（session → 其归因 commit 的贝塞尔，蓝→绿渐变，宽 ∝ confidence）
 *   - 底部 decision 菱形（琥珀，supersede 链虚线相连）
 *   - d3.zoom 仅缩放 x（rescaleX），自适应刻度
 *
 * 协议：导出 CSS / JS 字符串；JS 内 IIFE + LORE_VIEWS.push 注册。
 * 注意：JS 处于 TS 模板字符串内，禁用反引号与 ${}，一律字符串拼接。
 */

export const CSS = `
#view-story { background: transparent; }
.story-svg { width: 100%; height: 100%; display: block; cursor: grab; }
.story-svg.grabbing { cursor: grabbing; }

.story-axis line, .story-axis path { stroke: var(--border); shape-rendering: crispEdges; }
.story-axis text { fill: var(--text-faint); font-size: 10.5px; font-family: var(--font); }
.story-axis .domain { display: none; }

.story-lane-label { fill: var(--text-faint); font-size: 10px; font-family: var(--font); letter-spacing: 0.04em; text-transform: uppercase; }

.story-session {
  cursor: pointer;
  transition: opacity var(--t-fast);
}
.story-session rect.cap {
  fill: color-mix(in srgb, var(--blue) 12%, transparent);
  stroke: var(--blue);
  stroke-width: 1;
  transition: fill var(--t-fast), stroke-width var(--t-fast);
}
.story-session:hover rect.cap { fill: color-mix(in srgb, var(--blue) 22%, transparent); stroke-width: 1.5; }
.story-session text { fill: var(--blue); font-size: 10px; font-family: var(--mono); pointer-events: none; }

.story-commit {
  cursor: pointer;
  transition: opacity var(--t-fast);
}
.story-commit rect {
  transition: filter var(--t-fast), stroke-width var(--t-fast);
  /* 纸面无辉光，commit 用更实的墨色描边补层次；深色下回落到淡边 */
  stroke: var(--border-strong);
  stroke-width: 0.75;
}
.story-commit:hover rect { stroke: var(--text); stroke-width: 1.5; }

.story-ribbon {
  fill: none;
  transition: opacity var(--t-fast), stroke-width var(--t-fast);
  pointer-events: none;
}

.story-decision { cursor: pointer; transition: opacity var(--t-fast); }
.story-decision rect {
  fill: color-mix(in srgb, var(--amber) 16%, transparent);
  stroke: var(--amber);
  stroke-width: 1;
  transition: fill var(--t-fast);
}
.story-decision:hover rect { fill: color-mix(in srgb, var(--amber) 32%, transparent); }
.story-supersede { stroke: var(--amber); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.4; fill: none; }

.story-nowline line { stroke: var(--green); stroke-width: 1; shape-rendering: crispEdges; }
.story-nowline polygon { fill: var(--green); }

.story-tooltip {
  position: absolute; z-index: 40; pointer-events: none;
  max-width: 320px; padding: 7px 11px;
  background: var(--panel-solid); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); box-shadow: var(--shadow);
  font-size: 12px; color: var(--text); opacity: 0;
  transition: opacity var(--t-fast);
}
.story-tooltip.show { opacity: 1; }
.story-tooltip .tt-hash { font-family: var(--mono); font-size: 10.5px; color: var(--green); }
.story-tooltip .tt-sub { color: var(--text-dim); margin-top: 2px; }

.story-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  flex-direction: column; gap: 8px; color: var(--text-faint); text-align: center;
}
.story-empty .big { font-size: 15px; color: var(--text-dim); }
.story-empty .small { font-size: 12.5px; }

.story-legend {
  position: absolute; left: 24px; bottom: 92px; z-index: 20;
  display: flex; gap: 14px; align-items: center;
  padding: 7px 13px; pointer-events: none;
}
.story-legend .lg { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); }
.story-legend .sw { width: 11px; height: 11px; border-radius: 3px; flex-shrink: 0; }

.story-confbar { height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--text) 8%, transparent); overflow: hidden; margin-top: 3px; }
.story-confbar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--green)); border-radius: 3px; }
.drawer-link { color: var(--blue); cursor: pointer; }
.drawer-link:hover { text-decoration: underline; }
.kind-badge {
  display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 10.5px;
  border: 1px solid var(--amber); color: var(--amber); background: color-mix(in srgb, var(--amber) 10%, transparent);
}

/* ── 抽屉内嵌对话摘录 ───────────────────────────────────────────────── */
.excerpt-head {
  display: flex; align-items: center; gap: 7px; margin: 14px 0 8px;
  font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint);
}
.excerpt-head::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.excerpt {
  margin: 0 0 8px; padding: 9px 11px;
  border-left: 2px solid var(--border-strong); border-radius: 0 6px 6px 0;
  background: color-mix(in srgb, var(--text) 3%, transparent);
}
.excerpt.role-user { border-left-color: var(--blue); }
.excerpt.role-assistant { border-left-color: var(--green); }
.excerpt-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.role-pill {
  display: inline-block; padding: 1px 7px; border-radius: 999px;
  font-size: 9px; font-weight: 600; letter-spacing: 0.07em;
}
.role-pill.user { color: var(--blue); border: 1px solid var(--blue); background: color-mix(in srgb, var(--blue) 10%, transparent); }
.role-pill.agent { color: var(--green); border: 1px solid var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
.excerpt-anchor { font-family: var(--mono); font-size: 10px; color: var(--text-faint); }
.excerpt-ts { margin-left: auto; font-size: 10px; color: var(--text-faint); }
.excerpt-text { font-size: 12.5px; line-height: 1.5; color: var(--text-dim); white-space: pre-wrap; word-break: break-word; }

/* ── 电影化：入场 / 回放 / 导览 ───────────────────────────────────────── */

/* 入场前的初始压制态：commit 方块 opacity 0 + 缩小；加 .entered 后过渡到常态。
   stagger 用 transition-delay 实现（render 时按 x 排序设 inline delay）。 */
.story-commit.enter-init {
  opacity: 0 !important;
}
.story-commit.enter-init rect {
  transform: scale(0.3);
  transform-box: fill-box;
  transform-origin: center;
}
.story-commit.enter-go {
  transition: opacity 360ms var(--ease);
}
.story-commit.enter-go rect {
  transition: transform 360ms var(--ease);
  transform: scale(1);
  transform-box: fill-box;
  transform-origin: center;
}

/* 丝带抽出：入场后触发一次（dashoffset 归零）。 */
.story-ribbon.draw-init {
  transition: none;
}
.story-ribbon.draw-go {
  transition: stroke-dashoffset 800ms var(--ease), opacity var(--t-fast);
}

/* 越过播放头的脉冲（一次性 class，animationend 移除）。 */
@keyframes story-pulse {
  0%   { transform: scale(1); }
  45%  { transform: scale(1.6); }
  100% { transform: scale(1); }
}
.story-commit.pulse rect {
  transform-box: fill-box;
  transform-origin: center;
  animation: story-pulse 300ms var(--ease);
}

/* coachmark 导览气泡（glass 小卡 + 指向箭头 + 轻微浮动）。 */
@keyframes story-coach-float {
  0%   { transform: translateY(0); }
  50%  { transform: translateY(-4px); }
  100% { transform: translateY(0); }
}
.story-coachmark {
  position: absolute; z-index: 35; max-width: 220px;
  padding: 9px 13px;
  font-size: 12px; line-height: 1.45; color: var(--text);
  pointer-events: none;
  animation: story-coach-float 2.4s var(--ease) infinite;
  opacity: 0; transition: opacity var(--t-med);
}
.story-coachmark.show { opacity: 1; }
.story-coachmark .cm-arrow {
  position: absolute; left: -7px; top: 18px;
  width: 0; height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 7px solid var(--border-strong);
}
.story-coachmark .cm-arrow::after {
  content: ''; position: absolute; left: 1px; top: -5px;
  width: 0; height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-right: 6px solid var(--panel-solid);
}
`;

export const JS = `
(function () {
  'use strict';

  // ── 安全样式取值（避免 SSR/无 CSS 时 NaN）─────────────────────────
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  var MARGIN_TOP = 70, MARGIN_BOTTOM = 80, MARGIN_X = 24;
  var LANE_H = 22, LANE_GAP = 4, CAP_H = 18;
  var COMMIT_Y_FRAC = 0.62;
  var DECISION_SIZE = 9;

  LORE_VIEWS.push({
    id: 'story',
    label: 'Story',
    subtitleKey: 'story.subtitle',

    mount: function (el, ctx) {
      this.ctx = ctx;
      this.el = el;

      var g = (ctx.payload && ctx.payload.graph) || {};
      var commits = (g.commits || []).filter(function (c) { return c && !isNaN(+new Date(c.authorDate)); });
      var sessions = g.sessions || [];
      var notes = ctx.payload.notes || [];
      var produced = g.produced || [];
      var touches = g.touches || [];

      // 空态
      if (!commits.length) {
        el.innerHTML =
          '<div class="story-empty">' +
          '<div class="big">No commits to tell a story yet</div>' +
          '<div class="small">Run <span class="mono">lore build</span> on a repo with history to populate the timeline.</div>' +
          '</div>';
        return;
      }

      // ── 预聚合 ─────────────────────────────────────────────────────
      // commit -> 触碰文件数
      var touchCount = {};
      for (var i = 0; i < touches.length; i++) {
        var h = touches[i] && touches[i].commitHash;
        if (!h) continue;
        touchCount[h] = (touchCount[h] || 0) + 1;
      }
      // session id -> session
      var sessionById = {};
      for (var s = 0; s < sessions.length; s++) {
        if (sessions[s] && sessions[s].id) sessionById[sessions[s].id] = sessions[s];
      }
      // session -> 其归因 commit 列表（含 confidence）
      var sessionProduced = {};
      // commit -> 归因边（也用 ctx.attributionIndex，但这里建简表给丝带）
      for (var p = 0; p < produced.length; p++) {
        var pe = produced[p];
        if (!pe || !pe.sessionId) continue;
        (sessionProduced[pe.sessionId] = sessionProduced[pe.sessionId] || []).push(pe);
      }
      // commit hash -> commit
      var commitByHash = {};
      for (var ci = 0; ci < commits.length; ci++) commitByHash[commits[ci].hash] = commits[ci];

      var fmt = ctx.fmt;
      var esc = fmt.esc;

      // ── DOM 骨架 ───────────────────────────────────────────────────
      el.innerHTML = '';
      var tooltip = document.createElement('div');
      tooltip.className = 'story-tooltip';
      el.appendChild(tooltip);
      this.tooltip = tooltip;

      // 图例
      var legend = document.createElement('div');
      legend.className = 'story-legend glass';
      legend.innerHTML =
        '<div class="lg"><span class="sw" style="background:var(--blue)"></span>session</div>' +
        '<div class="lg"><span class="sw" style="background:var(--commit-new)"></span>commit</div>' +
        '<div class="lg"><span class="sw" style="background:var(--green);box-shadow:0 0 6px color-mix(in srgb, var(--green) calc(100% * var(--glow-opacity)), transparent)"></span>attributed</div>' +
        '<div class="lg"><span class="sw" style="background:var(--amber);border-radius:2px;transform:rotate(45deg)"></span>decision</div>';
      el.appendChild(legend);

      var svg = d3.select(el).append('svg').attr('class', 'story-svg');
      this.svg = svg;

      // defs：辉光滤镜 + 丝带渐变。抽成方法以便主题切换后重建（重读 token）。
      this.defs = svg.append('defs');
      this.buildDefs();

      // 分层（绘制顺序 = 视觉层级）
      var gAxis = svg.append('g').attr('class', 'story-axis');
      var gContent = svg.append('g').attr('class', 'story-content'); // 受 zoom 变换的 x 由 scale 控制，这里只装元素
      var gRibbons = gContent.append('g').attr('class', 'story-ribbons');
      var gSessions = gContent.append('g').attr('class', 'story-sessions');
      var gCommits = gContent.append('g').attr('class', 'story-commits');
      var gDecisions = gContent.append('g').attr('class', 'story-decisions');
      var gNow = svg.append('g').attr('class', 'story-nowline');

      // ── 时间标尺（domain 固定，range 随尺寸/zoom 变）───────────────
      var tMin = ctx.tMin, tMax = ctx.tMax;
      // 给 domain 两端各留一点呼吸
      var pad = Math.max(1, (tMax - tMin) * 0.02);
      var xBase = d3.scaleTime().domain([new Date(tMin - pad), new Date(tMax + pad)]);
      var x = xBase; // 当前生效 scale（zoom 后被 rescaleX 替换）

      // ── session 泳道贪心装行 ──────────────────────────────────────
      // 先按 startedAt 排序，贪心放入第一个不重叠的行
      var laidSessions = sessions
        .filter(function (ss) { return ss && ss.startedAt && !isNaN(+new Date(ss.startedAt)); })
        .map(function (ss) {
          var st = +new Date(ss.startedAt);
          var en = ss.endedAt ? +new Date(ss.endedAt) : st;
          if (isNaN(en) || en < st) en = st;
          return { s: ss, start: st, end: en };
        })
        .sort(function (a, b) { return a.start - b.start; });

      // 行分配在像素层做（因为最小宽度 24px 影响占位），但缩放会变——
      // 折中：用时间域贪心装行，最小占位按"全幅下 24px 对应的时间跨度"估算。
      function assignLanes(minSpanMs) {
        var laneEnds = []; // 每行最后占用的时间
        for (var k = 0; k < laidSessions.length; k++) {
          var item = laidSessions[k];
          var occEnd = Math.max(item.end, item.start + minSpanMs);
          var placed = -1;
          for (var ln = 0; ln < laneEnds.length; ln++) {
            if (item.start >= laneEnds[ln]) { placed = ln; break; }
          }
          if (placed < 0) { placed = laneEnds.length; laneEnds.push(0); }
          laneEnds[placed] = occEnd;
          item.lane = placed;
        }
        return laneEnds.length;
      }

      this.commits = commits;
      this.touchCount = touchCount;
      this.sessionProduced = sessionProduced;
      this.sessionById = sessionById;
      this.commitByHash = commitByHash;
      this.notes = notes;
      this.laidSessions = laidSessions;
      this.xBase = xBase;
      this.assignLanes = assignLanes;
      this.gAxis = gAxis;
      this.gRibbons = gRibbons;
      this.gSessions = gSessions;
      this.gCommits = gCommits;
      this.gDecisions = gDecisions;
      this.gNow = gNow;
      this.tooltip = tooltip;

      // ── zoom（仅 x，rescaleX）─────────────────────────────────────
      var self = this;
      var zoom = d3.zoom()
        .scaleExtent([1, 64])
        .filter(function (ev) {
          // 允许滚轮缩放 + 拖拽平移；阻止双击放大（避免误触）
          return (!ev.button) && ev.type !== 'dblclick';
        })
        .on('start', function () { svg.classed('grabbing', true); })
        .on('end', function () { svg.classed('grabbing', false); })
        .on('zoom', function (ev) {
          self.transform = ev.transform;
          self.x = ev.transform.rescaleX(self.xBase);
          self.render(false);
        });
      this.zoom = zoom;
      svg.call(zoom);
      this.transform = d3.zoomIdentity;

      this.resize();
      this.render(true);

      // 默认聚焦"有 session 的时间段"——Story 的主角是 session↔commit 关联，
      // 全量 54 天里 session 往往集中在最近几天；老 commit 缩放出去仍可达。
      var starts = (ctx.payload.graph.sessions || [])
        .map(function (s) { return +new Date(s.startedAt); })
        .filter(function (t) { return !isNaN(t); });
      if (starts.length) {
        var focusStart = Math.min.apply(null, starts) - 3 * 86400e3;
        var d0 = this.xBase.domain();
        var full = d0[1] - d0[0];
        var span = Math.max(d0[1] - focusStart, full * 0.02);
        var k = Math.min(64, Math.max(1, full / span));
        if (k > 1.2) {
          var xAt = this.xBase(new Date(+d0[1] - span));
          var t = d3.zoomIdentity.scale(k).translate(-xAt, 0);
          svg.transition().duration(500).call(zoom.transform, t);
        }
      }

      // ── 电影化运行态 ─────────────────────────────────────────────────
      this.playbackActive = false;
      this.lastCutoff = null;
      this.coachShown = false;

      // window 事件监听（回放强化 + 导览）。保存引用以便（理论上）解绑。
      var view = this;
      this._onPlayStart = function () { view.enterPlayback(); };
      this._onPlayEnd = function () { view.exitPlayback(); };
      this._onDemo = function (ev) {
        var hash = ev && ev.detail && ev.detail.commitHash;
        if (hash) view.runDemo(hash);
      };
      this._onTheme = function () { view.onThemeChange(); };
      try {
        window.addEventListener('lore:play-start', this._onPlayStart);
        window.addEventListener('lore:play-end', this._onPlayEnd);
        window.addEventListener('lore:demo', this._onDemo);
        window.addEventListener('lore:theme', this._onTheme);
      } catch (e) {}

      // 入场动画：首次渲染完成后触发一次（commit stagger + 丝带抽出）。
      this.playEntrance();
    },

    // ── 入场动画 ─────────────────────────────────────────────────────
    // commit 方块按 x 排序 stagger（opacity/scale），总长封顶 900ms；
    // 丝带 dashoffset 抽出（800ms）。用 CSS transition + 延迟类切换实现。
    playEntrance: function () {
      if (!this.svg || this._entranceDone) return;
      this._entranceDone = true;
      var self = this, x = this.x;

      // 1) commit 方块：按当前 x 排序，分配 stagger delay（封顶 900ms）。
      var nodes = [];
      this.gCommits.selectAll('g.story-commit').each(function (c) {
        nodes.push({ el: this, px: x(new Date(c.authorDate)) });
      });
      nodes.sort(function (a, b) { return a.px - b.px; });
      var n = nodes.length;
      var maxDelay = 900;
      for (var i = 0; i < n; i++) {
        var node = d3.select(nodes[i].el);
        var delay = n > 1 ? Math.round((i / (n - 1)) * maxDelay) : 0;
        if (delay > maxDelay) delay = maxDelay;
        node.classed('enter-init', true);
        node.style('transition-delay', delay + 'ms');
        node.select('rect').style('transition-delay', delay + 'ms');
      }
      // 强制 reflow 后切到目标态（下一帧），使过渡生效。
      try { void this.gCommits.node().getBoundingClientRect(); } catch (e) {}
      requestAnimationFrame(function () {
        self.gCommits.selectAll('g.story-commit.enter-init')
          .classed('enter-go', true)
          .classed('enter-init', false);
        // 过渡结束后清理 inline delay（避免后续 hover 受影响）。
        setTimeout(function () {
          self.gCommits.selectAll('g.story-commit')
            .classed('enter-go', false)
            .style('transition-delay', null)
            .select('rect').style('transition-delay', null);
        }, maxDelay + 420);
      });

      // 2) 丝带抽出：测每条路径长度，设 dasharray=dashoffset=len，下一帧归零。
      this.gRibbons.selectAll('path.story-ribbon').each(function () {
        var len = 0;
        try { len = this.getTotalLength(); } catch (e) { len = 0; }
        if (!len || !isFinite(len)) return;
        var p = d3.select(this).classed('draw-init', true);
        p.style('stroke-dasharray', len + ' ' + len)
         .style('stroke-dashoffset', len);
      });
      requestAnimationFrame(function () {
        self.gRibbons.selectAll('path.story-ribbon.draw-init')
          .classed('draw-init', false)
          .classed('draw-go', true)
          .style('stroke-dashoffset', 0);
        // 抽出后清理 dash 样式，回到常态（避免 zoom 重算路径时残留）。
        setTimeout(function () {
          self.gRibbons.selectAll('path.story-ribbon')
            .classed('draw-go', false)
            .style('stroke-dasharray', null)
            .style('stroke-dashoffset', null);
        }, 900);
      });
    },

    // ── defs（辉光滤镜 + 丝带渐变）：重读 token 重建，供主题切换调用 ──────
    buildDefs: function () {
      if (!this.defs) return;
      this.defs.selectAll('*').remove();
      // flood-opacity 接 --glow-opacity（纸面=0 自动无辉光）。
      var glowOp = parseFloat(cssVar('--glow-opacity', '0'));
      if (isNaN(glowOp)) glowOp = 0;
      var glow = this.defs.append('filter').attr('id', 'story-glow')
        .attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
      glow.append('feDropShadow')
        .attr('dx', 0).attr('dy', 0).attr('stdDeviation', 1.6)
        .attr('flood-color', cssVar('--green', '#1a7f37')).attr('flood-opacity', glowOp);
      var grad = this.defs.append('linearGradient').attr('id', 'story-ribbon-grad')
        .attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
      grad.append('stop').attr('offset', '0%').attr('stop-color', cssVar('--blue', '#0a5bd3'));
      grad.append('stop').attr('offset', '100%').attr('stop-color', cssVar('--green', '#1a7f37'));
    },

    // 主题切换：重建 defs（渐变/辉光重读 token）+ 整体重绘一次。
    onThemeChange: function () {
      if (!this.svg) return;
      this.buildDefs();
      try { this.render(true); } catch (e) {}
    },

    // 计算当前尺寸并设定 range
    resize: function () {
      if (!this.el) return;
      var w = this.el.clientWidth || 1200;
      var h = this.el.clientHeight || 700;
      this.W = w; this.H = h;
      this.innerLeft = MARGIN_X;
      this.innerRight = w - MARGIN_X;
      this.xBase.range([this.innerLeft, this.innerRight]);
      // 应用现有 zoom 变换
      this.x = (this.transform || d3.zoomIdentity).rescaleX(this.xBase);
      // 最小 session 占位：24px 对应的时间跨度（用 base scale 估算）
      var spanMs = this.xBase.invert(this.innerLeft + 24) - this.xBase.invert(this.innerLeft);
      this.minSpanMs = Math.max(0, spanMs);
      this.laneCount = this.assignLanes(this.minSpanMs);
      this.commitY = MARGIN_TOP + (h - MARGIN_TOP - MARGIN_BOTTOM) * COMMIT_Y_FRAC;
      // session 泳道区：从 MARGIN_TOP 往下排，但不能压到 commit 带
      this.laneTop = MARGIN_TOP + 6;
      this.decisionY = this.commitY + 46;
    },

    onResize: function () {
      if (!this.svg) return;
      this.resize();
      this.render(true);
    },

    // full=true 表示尺寸/数据变化，需要重建元素；false 表示仅 zoom 平移，更新位置
    render: function (full) {
      if (!this.svg) return;
      var ctx = this.ctx, x = this.x, self = this;
      var fmt = ctx.fmt, esc = fmt.esc;

      // 触碰文件数 → 方块边长（4..8）
      var counts = this.commits.map(function (c) { return self.touchCount[c.hash] || 0; });
      var maxTouch = Math.max(1, d3.max(counts) || 1);
      var sizeScale = d3.scaleSqrt().domain([0, maxTouch]).range([4, 8]).clamp(true);

      // ── 轴 ────────────────────────────────────────────────────────
      var axis = d3.axisBottom(x).ticks(Math.max(3, Math.floor(this.W / 130))).tickSizeOuter(0).tickPadding(8);
      this.gAxis
        .attr('transform', 'translate(0,' + (this.H - MARGIN_BOTTOM + 18) + ')')
        .call(axis);
      // 刻度上引一条极淡的网格线（往上到顶）
      this.gAxis.selectAll('.tick line')
        .attr('y1', 0).attr('y2', -(this.H - MARGIN_TOP - MARGIN_BOTTOM + 18))
        .attr('stroke', cssVar('--border', 'rgba(26,29,33,0.12)')).attr('stroke-opacity', 0.5);

      // ── commit 带（带同刻 jitter）─────────────────────────────────
      // 计算每个 commit 的纵向微抖：用 hash 派生稳定偏移
      function jitter(hash) {
        var n = 0;
        for (var i = 0; i < hash.length; i++) n = (n * 31 + hash.charCodeAt(i)) & 0xffff;
        return ((n % 9) - 4); // -4..4 px
      }

      var commitsSel = this.gCommits.selectAll('g.story-commit')
        .data(this.commits, function (c) { return c.hash; });
      if (full) {
        commitsSel.exit().remove();
        var cEnter = commitsSel.enter().append('g').attr('class', 'story-commit');
        cEnter.append('rect');
        commitsSel = cEnter.merge(commitsSel);
        // 事件只绑一次（enter）
        cEnter
          .on('mouseenter', function (ev, c) { self.showTip(ev, c); })
          .on('mousemove', function (ev) { self.moveTip(ev); })
          .on('mouseleave', function () { self.hideTip(); })
          .on('click', function (ev, c) { ev.stopPropagation(); self.openCommit(c); });
      }
      commitsSel.attr('transform', function (c) {
        var px = x(new Date(c.authorDate));
        return 'translate(' + px + ',' + (self.commitY + jitter(c.hash)) + ')';
      });
      commitsSel.select('rect').each(function (c) {
        var sz = sizeScale(self.touchCount[c.hash] || 0);
        var attributed = ctx.attributionIndex.has(c.hash);
        d3.select(this)
          .attr('x', -sz / 2).attr('y', -sz / 2)
          .attr('width', sz).attr('height', sz)
          .attr('rx', Math.min(2.5, sz / 3))
          .attr('fill', ctx.commitColor(+new Date(c.authorDate)))
          .attr('filter', attributed ? 'url(#story-glow)' : null);
      });
      commitsSel.style('opacity', function (c) {
        return ctx.attributionIndex.has(c.hash) ? 1 : 0.35;
      });

      // ── session 胶囊 ──────────────────────────────────────────────
      var sessSel = this.gSessions.selectAll('g.story-session')
        .data(this.laidSessions, function (d) { return d.s.id; });
      if (full) {
        sessSel.exit().remove();
        var sEnter = sessSel.enter().append('g').attr('class', 'story-session');
        sEnter.append('rect').attr('class', 'cap').attr('rx', 6).attr('ry', 6).attr('height', CAP_H);
        sEnter.append('clipPath').attr('id', function (d, i) { return 'sclip-' + cssId(d.s.id); })
          .append('rect').attr('height', CAP_H);
        sEnter.append('text').attr('dy', '0.32em');
        sessSel = sEnter.merge(sessSel);
        sEnter
          .on('mouseenter', function (ev, d) { self.emphasizeSession(d.s.id, true); })
          .on('mouseleave', function (ev, d) { self.emphasizeSession(d.s.id, false); })
          .on('click', function (ev, d) { ev.stopPropagation(); self.openSession(d.s); });
      }
      // 每次 render 按当前像素区间重新贪心分道（缩放后区间变化，固定 lane 会无谓堆叠）
      var laneEnds = [];
      var ordered = [];
      sessSel.each(function (d) { ordered.push(d); });
      ordered.sort(function (a, b) { return a.start - b.start; });
      for (var oi = 0; oi < ordered.length; oi++) {
        var od = ordered[oi];
        var ox0 = x(new Date(od.start));
        var ox1 = Math.max(ox0 + 24, x(new Date(od.end)));
        var lane = 0;
        while (lane < laneEnds.length && laneEnds[lane] > ox0 - 6) lane++;
        laneEnds[lane] = ox1;
        od.lane = lane;
      }
      sessSel.each(function (d) {
        var x0 = x(new Date(d.start));
        var x1 = x(new Date(d.end));
        var w = Math.max(24, x1 - x0);
        var y = self.laneTop + d.lane * (LANE_H + LANE_GAP);
        // 不让胶囊压到 commit 带
        if (y + CAP_H > self.commitY - 14) y = self.commitY - 14 - CAP_H;
        d.px = x0; d.pw = w; d.py = y;
        var node = d3.select(this);
        node.select('rect.cap').attr('x', x0).attr('y', y).attr('width', w);
        node.select('clipPath rect').attr('x', x0).attr('y', y).attr('width', Math.max(0, w - 8));
        var label = (d.s.agent || 'session') + ' ' + String(d.s.id).slice(0, 6);
        node.select('text')
          .attr('x', x0 + 7).attr('y', y + CAP_H / 2)
          .attr('clip-path', 'url(#sclip-' + cssId(d.s.id) + ')')
          .text(w > 40 ? label : '');
      });

      // ── 归因丝带 ──────────────────────────────────────────────────
      // 每条 produced 边一条丝带：从 session 胶囊底中点 → commit
      var ribbons = [];
      for (var si = 0; si < this.laidSessions.length; si++) {
        var item = this.laidSessions[si];
        var edges = this.sessionProduced[item.s.id] || [];
        for (var e = 0; e < edges.length; e++) {
          var pe = edges[e];
          var c = this.commitByHash[pe.commitHash];
          if (!c) continue;
          ribbons.push({ key: item.s.id + '>' + pe.commitHash, sid: item.s.id, edge: pe, src: item, commit: c });
        }
      }
      var ribSel = this.gRibbons.selectAll('path.story-ribbon').data(ribbons, function (r) { return r.key; });
      if (full) ribSel.exit().remove();
      var ribEnter = full ? ribSel.enter().append('path').attr('class', 'story-ribbon') : d3.select(null);
      if (full) ribSel = ribEnter.merge(ribSel);
      var confW = d3.scaleLinear().domain([0, 1]).range([1.5, 6]).clamp(true);
      ribSel.each(function (r) {
        var sx = (r.src.px || 0) + (r.src.pw || 24) / 2;
        var sy = (r.src.py != null ? r.src.py : self.laneTop) + CAP_H;
        var cx = x(new Date(r.commit.authorDate));
        var cy = self.commitY;
        var midY = (sy + cy) / 2;
        var path = 'M' + sx + ',' + sy +
                   ' C' + sx + ',' + midY + ' ' + cx + ',' + midY + ' ' + cx + ',' + cy;
        d3.select(this)
          .attr('d', path)
          .attr('stroke', 'url(#story-ribbon-grad)')
          .attr('stroke-width', confW(r.edge.confidence || 0))
          .attr('stroke-linecap', 'round')
          .style('opacity', 0.45);
      });
      this.ribbonsBySession = {};
      var rb = this.ribbonsBySession;
      ribSel.each(function (r) { (rb[r.sid] = rb[r.sid] || []).push(this); });

      // ── decision 菱形 ─────────────────────────────────────────────
      var decData = this.notes.filter(function (n) { return n && n.validAt && !isNaN(+new Date(n.validAt)); });
      // supersede 链：id -> note
      var noteById = {};
      for (var ni = 0; ni < decData.length; ni++) noteById[decData[ni].id] = decData[ni];

      var decSel = this.gDecisions.selectAll('g.story-decision').data(decData, function (n) { return n.id; });
      if (full) {
        decSel.exit().remove();
        var dEnter = decSel.enter().append('g').attr('class', 'story-decision');
        dEnter.append('rect')
          .attr('x', -DECISION_SIZE / 2).attr('y', -DECISION_SIZE / 2)
          .attr('width', DECISION_SIZE).attr('height', DECISION_SIZE).attr('rx', 1.5);
        decSel = dEnter.merge(decSel);
        dEnter
          .on('mouseenter', function (ev, n) { self.showDecisionTip(ev, n); })
          .on('mousemove', function (ev) { self.moveTip(ev); })
          .on('mouseleave', function () { self.hideTip(); })
          .on('click', function (ev, n) { ev.stopPropagation(); self.openDecision(n, noteById); });
      }
      decSel.attr('transform', function (n) {
        return 'translate(' + x(new Date(n.validAt)) + ',' + self.decisionY + ') rotate(45)';
      });
      decSel.style('opacity', function (n) { return n.invalidAt ? 0.4 : 1; });

      // supersede 连线
      var links = [];
      for (var di = 0; di < decData.length; di++) {
        var n = decData[di];
        if (n.supersededBy && noteById[n.supersededBy]) {
          links.push({ a: n, b: noteById[n.supersededBy] });
        }
      }
      var linkSel = this.gDecisions.selectAll('line.story-supersede').data(links, function (l) { return l.a.id + '>' + l.b.id; });
      if (full) linkSel.exit().remove();
      var linkEnter = full ? linkSel.enter().insert('line', ':first-child').attr('class', 'story-supersede') : d3.select(null);
      if (full) linkSel = linkEnter.merge(linkSel);
      linkSel
        .attr('x1', function (l) { return x(new Date(l.a.validAt)); })
        .attr('y1', self.decisionY)
        .attr('x2', function (l) { return x(new Date(l.b.validAt)); })
        .attr('y2', self.decisionY);

      // ── lane labels ───────────────────────────────────────────────
      this.gSessions.selectAll('text.story-lane-label').remove();
      // 时间轴回放当前态
      this.applyCutoff(ctx.cutoffMs);
    },

    // ── 时间轴回放：cutoff 右侧元素淡出 + 当前时刻竖线 ────────────────
    onTimeline: function (cutoffMs) {
      // 回放态：先 diff 出本次新越过播放头的 commit（脉冲 + 丝带显形），
      // 再交给 applyCutoff 落定稳态透明度（避免两套逻辑打架）。
      if (this.playbackActive) {
        this.pulseCrossed(this.lastCutoff, cutoffMs);
      }
      this.lastCutoff = cutoffMs;
      this.applyCutoff(cutoffMs);
    },

    // ── 进入回放态：所有 commit 先压到 0.07，等待播放头逐个唤醒 ────────
    enterPlayback: function () {
      if (!this.svg) return;
      this.playbackActive = true;
      // 以 shell 当前 cutoff 为基准（play 通常从 0 重启，但防御读取实际值）。
      this.lastCutoff = this.ctx.cutoffMs;
      this.gCommits.selectAll('g.story-commit')
        .interrupt()
        .style('opacity', 0.07);
      this.gRibbons.selectAll('path.story-ribbon')
        .interrupt()
        .style('opacity', 0.07);
    },

    // ── 退出回放态：恢复常态（按当前 cutoff 落定）。 ──────────────────
    exitPlayback: function () {
      if (!this.svg) return;
      this.playbackActive = false;
      this.applyCutoff(this.ctx.cutoffMs);
    },

    // 本次 cutoff 相对上次新越过播放头的 commit：脉冲一次；其归因丝带显形。
    pulseCrossed: function (prevCutoff, cutoffMs) {
      if (!this.svg) return;
      var self = this;
      // prev=null 视为 -∞（开播首帧不回溯全量，避免一次性全脉冲）。
      var lo = (prevCutoff == null) ? -Infinity : +prevCutoff;
      var hi = (cutoffMs == null) ? Infinity : +cutoffMs;
      if (!(hi > lo)) return;
      // 首帧（lo=-Infinity）只把 hi 之前的当作"已在场"，不脉冲历史；
      // 仅当 prev 是有限值、播放头确有推进时才脉冲新越过的。
      if (lo === -Infinity) return;

      this.gCommits.selectAll('g.story-commit').each(function (c) {
        var t = +new Date(c.authorDate);
        if (t > lo && t <= hi) {
          var node = d3.select(this);
          // 越过播放头：从压制态 0.07 显形到常态，并脉冲一次。
          var target = self.ctx.attributionIndex.has(c.hash) ? 1 : 0.35;
          node.interrupt().transition().duration(300).style('opacity', target);
          node.classed('pulse', true);
          var rectEl = node.select('rect').node();
          if (rectEl) {
            var onEnd = function () {
              node.classed('pulse', false);
              rectEl.removeEventListener('animationend', onEnd);
            };
            rectEl.addEventListener('animationend', onEnd);
          } else {
            // 无 rect 兜底：定时移除。
            setTimeout(function () { node.classed('pulse', false); }, 360);
          }
        }
      });

      // 归因丝带：commit 越过时其丝带 0.07→常态（300ms 过渡）。
      this.gRibbons.selectAll('path.story-ribbon').each(function (r) {
        var t = +new Date(r.commit.authorDate);
        if (t > lo && t <= hi) {
          d3.select(this)
            .interrupt()
            .transition().duration(300)
            .style('opacity', 0.45);
        }
      });
    },

    // ── 导览：定位 demo commit、平滑带入视野、开抽屉、贴 coachmark ──────
    runDemo: function (commitHash) {
      if (!this.svg) return;
      var self = this;
      var c = this.commitByHash[commitHash];
      if (!c) return;

      // 1) 若该 commit 在视野外或贴边，用 zoom.transform 平移到视野中部偏左
      //    （右侧给抽屉 ~380px 留白），缩放比例不变；否则原地不动。
      var cx = this.x(new Date(c.authorDate));
      var drawerGutter = 380; // 抽屉占据右侧的大致宽度
      var visibleLeft = this.innerLeft + 40;
      var visibleRight = this.innerRight - drawerGutter;
      var needMove = cx < visibleLeft || cx > visibleRight;

      // 一次性 afterMove：开抽屉 + 贴 coachmark（transition end 与兜底定时只跑一次）。
      var ran = false;
      var afterMove = function () {
        if (ran) return;
        ran = true;
        self.openCommit(c);
        self.showCoachmark(c); // coachmark 用当前（可能已变）x 定位
      };

      if (needMove && this.zoom && this.transform) {
        // 目标：把节点落到可见区中部偏左（~38%），右侧给抽屉留白；缩放比例不变。
        var targetPx = this.innerLeft + (visibleRight - this.innerLeft) * 0.38;
        var k = this.transform.k;
        // 当前 transform: screenX = k * baseX + tx。令 baseX 落到 targetPx 解出 tx。
        var baseX = this.xBase(new Date(c.authorDate));
        var newTx = targetPx - k * baseX;
        var t = d3.zoomIdentity.translate(newTx, 0).scale(k);
        this.svg.transition().duration(600)
          .call(this.zoom.transform, t)
          .on('end', afterMove);
        // 防御：transition 'end' 偶发不触发，兜底定时（afterMove 自带去重）。
        setTimeout(afterMove, 760);
      } else {
        afterMove();
      }
    },

    // coachmark：节点旁的 glass 气泡 + 指向箭头，文案走 LORE_T 防御缺省英文，
    // 点击任意处或 8s 后消失，localStorage 限一次。
    showCoachmark: function (c) {
      if (!this.el) return;
      // localStorage 限一次（读写都防御异常环境）。
      try {
        if (localStorage.getItem('lore.coach.story') === '1') return;
      } catch (e) {}
      if (this.coachShown) return;
      this.coachShown = true;
      try { localStorage.setItem('lore.coach.story', '1'); } catch (e) {}

      // 文案：优先 i18n，缺省英文。
      var text = 'This commit was written with an AI agent — click to see the conversation behind it.';
      try {
        if (typeof window.LORE_T === 'function') {
          var t = window.LORE_T('coachmark.text');
          if (t) text = t;
        }
      } catch (e) {}

      // 计算节点屏幕坐标（el 相对定位）。
      var px = this.x(new Date(c.authorDate));
      var py = this.commitY;
      // 气泡贴在节点右侧偏上一点；若太靠右（接近抽屉），收回左侧。
      var bubbleLeft = px + 16;
      if (bubbleLeft > this.W - 260) bubbleLeft = px - 236;
      var bubbleTop = py - 14;
      if (bubbleTop < this.laneTop) bubbleTop = this.laneTop;

      // 移除旧的（防重复）。
      this.hideCoachmark();

      var cm = document.createElement('div');
      cm.className = 'story-coachmark glass';
      cm.style.left = bubbleLeft + 'px';
      cm.style.top = bubbleTop + 'px';
      cm.innerHTML = '<div class="cm-arrow"></div>' + this.ctx.fmt.esc(text);
      this.el.appendChild(cm);
      this.coachmarkEl = cm;
      // 淡入。
      var self = this;
      requestAnimationFrame(function () { cm.classList.add('show'); });

      // 关闭逻辑：点击任意处或 8s 后。
      var dismiss = function () {
        document.removeEventListener('click', dismiss, true);
        if (self._coachTimer) { clearTimeout(self._coachTimer); self._coachTimer = null; }
        self.hideCoachmark();
      };
      // 延一拍再挂全局点击监听，避免触发 demo 的那次点击立刻关掉。
      setTimeout(function () {
        document.addEventListener('click', dismiss, true);
      }, 50);
      this._coachTimer = setTimeout(dismiss, 8000);
    },

    hideCoachmark: function () {
      if (this.coachmarkEl) {
        var el = this.coachmarkEl;
        this.coachmarkEl = null;
        el.classList.remove('show');
        setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 300);
      }
    },

    applyCutoff: function (cutoffMs) {
      if (!this.svg) return;
      var self = this, x = this.x;
      var future = function (t) { return cutoffMs != null && +new Date(t) > cutoffMs; };
      // 回放态下 commit/丝带的透明度由 pulseCrossed 逐帧增量驱动（脉冲 + 显形），
      // 这里不整片改写 opacity，否则会瞬时盖掉 enterPlayback 的压制与 300ms 显形过渡。
      var pb = this.playbackActive;

      var commitsSel = this.gCommits.selectAll('g.story-commit');
      if (!pb) {
        commitsSel.style('opacity', function (c) {
          if (future(c.authorDate)) return 0.07;
          return self.ctx.attributionIndex.has(c.hash) ? 1 : 0.35;
        });
      }
      // pointer-events 始终按 cutoff 维护（回放态也禁用未来 commit 的命中）。
      commitsSel.style('pointer-events', function (c) { return future(c.authorDate) ? 'none' : null; });

      if (!pb) {
        this.gRibbons.selectAll('path.story-ribbon').style('opacity', function (r) {
          return future(r.commit.authorDate) ? 0.05 : 0.45;
        });
      }

      this.gDecisions.selectAll('g.story-decision').style('opacity', function (n) {
        if (future(n.validAt)) return 0.07;
        return n.invalidAt ? 0.4 : 1;
      });

      this.gSessions.selectAll('g.story-session').style('opacity', function (d) {
        return future(d.start) ? 0.12 : 1;
      });

      // 当前时刻竖线
      var ng = this.gNow;
      ng.selectAll('*').remove();
      if (cutoffMs != null) {
        var px = x(new Date(cutoffMs));
        if (px >= this.innerLeft - 2 && px <= this.innerRight + 2) {
          ng.append('line').attr('x1', px).attr('x2', px)
            .attr('y1', MARGIN_TOP - 4).attr('y2', this.H - MARGIN_BOTTOM + 18);
          ng.append('polygon').attr('points',
            (px - 4) + ',' + (MARGIN_TOP - 4) + ' ' + (px + 4) + ',' + (MARGIN_TOP - 4) + ' ' + px + ',' + (MARGIN_TOP + 2));
        }
      }
    },

    // ── session 强调（hover 胶囊时丝带 + 其 commit 提亮，其余压暗）────
    emphasizeSession: function (sid, on) {
      if (!this.svg) return;
      var self = this;
      var related = {};
      var edges = this.sessionProduced[sid] || [];
      for (var i = 0; i < edges.length; i++) related[edges[i].commitHash] = true;

      this.gRibbons.selectAll('path.story-ribbon').style('opacity', function (r) {
        if (!on) return self._cutoffFutureRibbon(r) ? 0.05 : 0.45;
        return r.sid === sid ? 0.95 : 0.1;
      }).style('stroke-width', function (r) {
        var base = (1.5 + 4.5 * (r.edge.confidence || 0));
        return (on && r.sid === sid) ? base + 1 : base;
      });

      this.gCommits.selectAll('g.story-commit').style('opacity', function (c) {
        if (!on) return self._cutoffFutureCommit(c) ? 0.07 : (self.ctx.attributionIndex.has(c.hash) ? 1 : 0.35);
        return related[c.hash] ? 1 : 0.12;
      });
    },

    _cutoffFutureCommit: function (c) {
      var co = this.ctx.cutoffMs;
      return co != null && +new Date(c.authorDate) > co;
    },
    _cutoffFutureRibbon: function (r) {
      var co = this.ctx.cutoffMs;
      return co != null && +new Date(r.commit.authorDate) > co;
    },

    // ── tooltip ───────────────────────────────────────────────────
    showTip: function (ev, c) {
      var fmt = this.ctx.fmt;
      var sub = String(c.subject || '').slice(0, 40);
      this.tooltip.innerHTML =
        '<div class="tt-hash">' + fmt.esc(fmt.hash(c.hash)) + '</div>' +
        '<div class="tt-sub">' + fmt.esc(sub) + (String(c.subject || '').length > 40 ? '…' : '') + '</div>';
      this.tooltip.classList.add('show');
      this.moveTip(ev);
    },
    showDecisionTip: function (ev, n) {
      var fmt = this.ctx.fmt;
      this.tooltip.innerHTML =
        '<div class="tt-hash" style="color:var(--amber)">' + fmt.esc(n.kind || 'decision') + '</div>' +
        '<div class="tt-sub">' + fmt.esc(String(n.title || '').slice(0, 60)) + '</div>';
      this.tooltip.classList.add('show');
      this.moveTip(ev);
    },
    moveTip: function (ev) {
      var rect = this.el.getBoundingClientRect();
      var px = ev.clientX - rect.left + 14;
      var py = ev.clientY - rect.top + 14;
      // 防溢出右/下边
      var tw = this.tooltip.offsetWidth || 0, th = this.tooltip.offsetHeight || 0;
      if (px + tw > rect.width - 8) px = ev.clientX - rect.left - tw - 14;
      if (py + th > rect.height - 8) py = ev.clientY - rect.top - th - 14;
      this.tooltip.style.left = px + 'px';
      this.tooltip.style.top = py + 'px';
    },
    hideTip: function () { if (this.tooltip) this.tooltip.classList.remove('show'); },

    // ── drawers ───────────────────────────────────────────────────
    openCommit: function (c) {
      var ctx = this.ctx, fmt = ctx.fmt, esc = fmt.esc;
      var attrs = ctx.attributionIndex.get(c.hash) || [];
      var touch = this.touchCount[c.hash] || 0;
      var html = '<h3>' + esc(String(c.subject || '(no subject)')) + '</h3>';
      html += '<div class="row"><span class="k">hash</span><span class="v mono">' + esc(c.hash) + '</span></div>';
      html += '<div class="row"><span class="k">date</span><span class="v">' + esc(fmt.datetime(c.authorDate)) + '</span></div>';
      html += '<div class="row"><span class="k">touches</span><span class="v">' + touch + ' file' + (touch === 1 ? '' : 's') + '</span></div>';
      if (c.isMerge) html += '<div class="row"><span class="k"></span><span class="v"><span class="chip">merge</span></span></div>';
      html += '<div class="sep"></div>';
      if (!attrs.length) {
        html += '<div class="row"><span class="v" style="color:var(--text-faint)">No session attributed to this commit.</span></div>';
      } else {
        html += '<div class="row"><span class="k">attribution</span><span class="v">' + attrs.length + (attrs.length === 1 ? ' session' : ' sessions') + '</span></div>';
        for (var i = 0; i < attrs.length; i++) {
          var a = attrs[i];
          var sess = this.sessionById[a.sessionId];
          var pct = Math.round((a.confidence || 0) * 100);
          html += '<div style="margin:10px 0 4px">';
          html += '<div class="drawer-link" data-session="' + esc(a.sessionId) + '">' +
                  ((sess && sess.agent ? esc(sess.agent) + ' · ' : '')) +
                  '<span class="mono">' + esc(String(a.sessionId).slice(0, 8)) + '</span></div>';
          html += '<div class="story-confbar"><i style="width:' + pct + '%"></i></div>';
          html += '<div class="row" style="margin-top:4px"><span class="k">confidence</span><span class="v">' + pct + '%</span></div>';
          html += '<div class="row"><span class="k">via</span><span class="v">' + esc(a.matchedVia || '—') + '</span></div>';
          html += '<div class="row"><span class="k">lines</span><span class="v">' + (a.matchedLines || 0) + ' matched · ' + (a.fileCount || 0) + ' files</span></div>';
          html += '</div>';
        }
      }
      html += excerptHtml(ctx, c.hash, esc, fmt);
      ctx.drawer.show(html);
      this.wireSessionLinks();
    },

    openSession: function (s) {
      var ctx = this.ctx, fmt = ctx.fmt, esc = fmt.esc, self = this;
      var produced = this.sessionProduced[s.id] || [];
      var html = '<h3>' + esc(s.agent || 'session') + '</h3>';
      html += '<div class="row"><span class="k">id</span><span class="v mono">' + esc(s.id) + '</span></div>';
      html += '<div class="row"><span class="k">started</span><span class="v">' + esc(fmt.datetime(s.startedAt)) + '</span></div>';
      html += '<div class="row"><span class="k">ended</span><span class="v">' + esc(s.endedAt ? fmt.datetime(s.endedAt) : 'open') + '</span></div>';
      if (s.gitBranch) html += '<div class="row"><span class="k">branch</span><span class="v mono">' + esc(s.gitBranch) + '</span></div>';
      var sp = (s.sourcePaths || []).length;
      html += '<div class="row"><span class="k">sources</span><span class="v">' + sp + ' transcript' + (sp === 1 ? '' : 's') + '</span></div>';
      html += '<div class="sep"></div>';
      html += '<div class="row"><span class="k">produced</span><span class="v">' + produced.length + (produced.length === 1 ? ' commit' : ' commits') + '</span></div>';
      if (produced.length) {
        var sorted = produced.slice().sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
        for (var i = 0; i < sorted.length; i++) {
          var pe = sorted[i];
          var c = this.commitByHash[pe.commitHash];
          var subj = c ? String(c.subject || '').slice(0, 38) : '(unknown)';
          var pct = Math.round((pe.confidence || 0) * 100);
          html += '<div class="row" style="margin-top:7px"><span class="v">' +
                  '<span class="drawer-link" data-commit="' + esc(pe.commitHash) + '"><span class="mono">' + esc(fmt.hash(pe.commitHash)) + '</span></span> ' +
                  esc(subj) + ' <span style="color:var(--text-faint)">· ' + pct + '%</span>' +
                  '</span></div>';
        }
      } else {
        html += '<div class="row"><span class="v" style="color:var(--text-faint)">This session edited files but matched no commit.</span></div>';
      }
      ctx.drawer.show(html);
      this.wireCommitLinks();
    },

    openDecision: function (n, noteById) {
      var ctx = this.ctx, fmt = ctx.fmt, esc = fmt.esc;
      var html = '<h3>' + esc(String(n.title || '(untitled)')) + '</h3>';
      html += '<div class="row"><span class="k"></span><span class="v"><span class="kind-badge">' + esc(n.kind || 'decision') + '</span></span></div>';
      html += '<div class="row"><span class="k">valid</span><span class="v">' + esc(fmt.date(n.validAt)) + '</span></div>';
      if (n.invalidAt) html += '<div class="row"><span class="k">invalid</span><span class="v">' + esc(fmt.date(n.invalidAt)) + '</span></div>';
      if (n.body) html += '<div class="quote">' + esc(n.body) + '</div>';
      var files = n.files || [];
      if (files.length) {
        var chips = '';
        for (var i = 0; i < files.length; i++) chips += '<span class="chip" style="margin:2px 3px 0 0">' + esc(files[i]) + '</span>';
        html += '<div class="row" style="margin-top:8px"><span class="k">files</span><span class="v">' + chips + '</span></div>';
      }
      // supersede 链
      if (n.supersededBy && noteById && noteById[n.supersededBy]) {
        html += '<div class="sep"></div>';
        html += '<div class="row"><span class="k">superseded by</span><span class="v">' + esc(noteById[n.supersededBy].title || n.supersededBy) + '</span></div>';
      }
      ctx.drawer.show(html);
    },

    // drawer 内 session 链接 → 打开对应 session
    wireSessionLinks: function () {
      var self = this;
      var links = document.querySelectorAll('#drawer-body [data-session]');
      for (var i = 0; i < links.length; i++) {
        (function (link) {
          link.addEventListener('click', function () {
            var s = self.sessionById[link.getAttribute('data-session')];
            if (s) self.openSession(s);
          });
        })(links[i]);
      }
    },
    wireCommitLinks: function () {
      var self = this;
      var links = document.querySelectorAll('#drawer-body [data-commit]');
      for (var i = 0; i < links.length; i++) {
        (function (link) {
          link.addEventListener('click', function () {
            var c = self.commitByHash[link.getAttribute('data-commit')];
            if (c) self.openCommit(c);
          });
        })(links[i]);
      }
    },
  });

  // 把任意 id 变成合法 CSS/选择器片段
  function cssId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

  // 抽屉内嵌对话摘录：payload.excerpts[commitHash] → HTML 块（无摘录返回空串）
  function excerptHtml(ctx, commitHash, esc, fmt) {
    var ex = ctx.payload && ctx.payload.excerpts;
    var list = ex && ex[commitHash];
    if (!list || !list.length) return '';
    var html = '<div class="excerpt-head">conversation at this commit</div>';
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var isUser = m.role === 'user';
      var pill = isUser ? '<span class="role-pill user">USER</span>' : '<span class="role-pill agent">AGENT</span>';
      var anchor = String(m.sessionId || '').slice(0, 8) + '#' + m.seq;
      var ts = m.ts ? fmt.datetime(m.ts) : '';
      html += '<div class="excerpt role-' + (isUser ? 'user' : 'assistant') + '">' +
        '<div class="excerpt-meta">' + pill +
        '<span class="excerpt-anchor">' + esc(anchor) + '</span>' +
        (ts ? '<span class="excerpt-ts">' + esc(ts) + '</span>' : '') +
        '</div>' +
        '<div class="excerpt-text">' + esc(m.text || '') + '</div>' +
        '</div>';
    }
    return html;
  }
})();
`;
