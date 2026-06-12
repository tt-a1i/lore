/**
 * view-story —— "叙事账本"（Narrative Ledger）：GitHub commit feed 的强化版。
 *
 * 旧版是 D3 水平散点时间轴，与本仓数据形态（54 天 commit、session 集中在最后
 * 2 天）天然不匹配——大片空白时间轴+挤成一团的散点。改为时间倒序的 HTML 列表：
 *   - 顶部概览条：N/M commits 带对话出处 + 进度条
 *   - 主体分组流（最新在上）：
 *       A. session 组：组头（agent + id + 日期 + N commits 徽标）+ 归因 commit 行，
 *          有摘录的行内联可展开对话块
 *       B. 无归因 commit：按自然日聚合成可折叠条，默认折叠
 *   - 时间轴回放（onTimeline cutoff）：未来行变暗禁点；播放时跟随滚动 + 显形闪光
 *   - 导览（lore:demo commitHash）：滚动居中、展开摘录、高亮环、一次性 coachmark 条
 *
 * 协议：导出 CSS / JS 字符串；JS 内 IIFE + LORE_VIEWS.push 注册。
 * 注意：JS 处于 TS 模板字符串内，禁用反引号与 dollar-brace，一律字符串拼接；
 * 颜色全走 var()/color-mix；所有数据经 esc 转义；交互用容器级事件委托。
 * 纯 DOM 构建，不再依赖 D3。
 */

export const CSS = `
#view-story { background: transparent; }

.ledger-scroll {
  position: absolute; inset: 0;
  padding: 84px 24px 90px;
  overflow-y: auto;
  overflow-x: hidden;
}
.ledger-col {
  max-width: 880px;
  margin: 0 auto;
}

/* ── 概览条 ─────────────────────────────────────────────────────────── */
.ledger-overview {
  padding: 14px 16px;
  margin-bottom: 18px;
}
.ledger-overview .ov-line {
  font-size: 13px; color: var(--text-dim);
  display: flex; align-items: baseline; gap: 7px;
}
.ledger-overview .ov-line b { color: var(--text); font-weight: 600; font-size: 14px; }
.ledger-bar {
  height: 6px; border-radius: 999px; margin-top: 10px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  overflow: hidden;
}
.ledger-bar > i {
  display: block; height: 100%; border-radius: 999px;
  background: var(--green);
  transition: width var(--t-med);
}

/* ── 组（session 组 / 日期折叠条）公共 ───────────────────────────────── */
.ledger-group { margin-bottom: 16px; }

.session-head {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--panel);
  cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast);
}
.session-head:hover { border-color: var(--border-strong); background: var(--bg); }
.session-head .sh-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--blue); flex-shrink: 0; }
.session-head .sh-agent { font-weight: 600; font-size: 13px; color: var(--text); }
.session-head .sh-id { font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
.session-head .sh-date { font-size: 12px; color: var(--text-dim); }
.session-head .sh-spacer { flex: 1; }
.session-head .sh-count {
  flex-shrink: 0;
  padding: 2px 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text-dim); font-size: 11.5px; white-space: nowrap;
}

.session-body { padding-left: 2px; }

/* ── commit 行 ─────────────────────────────────────────────────────── */
.commit-row {
  position: relative;
  padding: 9px 12px 9px 16px;
  border-left: 3px solid var(--green);
  cursor: pointer;
  transition: background var(--t-fast), opacity var(--t-med);
}
.commit-row:hover { background: var(--bg); }
.commit-row.dim-track { border-left-color: var(--border); cursor: pointer; }
.commit-row .cr-subject {
  font-size: 14px; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.commit-row .cr-meta {
  margin-top: 3px;
  font-size: 11.5px; color: var(--text-faint);
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
}
.commit-row .cr-meta .cr-hash { font-family: var(--mono); color: var(--text-dim); }
.commit-row .cr-meta .cr-sep { color: var(--border-strong); }

/* future（回放未来态）：变淡禁点，但保留高度避免跳动 */
.commit-row.future { opacity: 0.15; pointer-events: none; }

/* 显形闪光（从 future 变亮时） */
@keyframes ledger-reveal {
  0%   { background: color-mix(in srgb, var(--green) 7%, transparent); }
  100% { background: transparent; }
}
.commit-row.reveal { animation: ledger-reveal 240ms var(--ease); }

/* demo 高亮环（2 秒内描边淡出） */
@keyframes ledger-ring {
  0%   { box-shadow: inset 0 0 0 2px var(--green-soft); }
  100% { box-shadow: inset 0 0 0 2px transparent; }
}
.commit-row.demo-ring { animation: ledger-ring 2s var(--ease); }

/* ── 内联摘录块 ─────────────────────────────────────────────────────── */
.row-excerpts {
  margin: 2px 0 6px 16px;
  padding: 2px 0 2px 11px;
  border-left: 2px solid var(--border-strong);
  cursor: pointer;
}
.row-excerpts .rx-item { margin: 6px 0; }
.row-excerpts .rx-meta { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
.rx-pill {
  display: inline-block; padding: 1px 7px; border-radius: 999px;
  font-size: 9px; font-weight: 600; letter-spacing: 0.07em;
}
.rx-pill.user { color: var(--blue); border: 1px solid var(--blue); background: color-mix(in srgb, var(--blue) 10%, transparent); }
.rx-pill.agent { color: var(--green); border: 1px solid var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
.rx-anchor { font-family: var(--mono); font-size: 10px; color: var(--text-faint); }
.row-excerpts .rx-text {
  font-size: 12.5px; line-height: 1.5; color: var(--text-dim);
  white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
.row-excerpts.expanded .rx-text { -webkit-line-clamp: unset; }
.row-excerpts .rx-toggle {
  margin-top: 4px; font-size: 10.5px; color: var(--blue);
  letter-spacing: 0.02em;
}

/* ── 无对话日期折叠条 ───────────────────────────────────────────────── */
.day-bar {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--panel);
  color: var(--text-dim); font-size: 12.5px;
  cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast);
}
.day-bar:hover { border-color: var(--border-strong); background: var(--bg); }
.day-bar .db-date { font-weight: 600; color: var(--text); }
.day-bar .db-sep { color: var(--border-strong); }
.day-bar .db-spacer { flex: 1; }
.day-bar .db-chevron {
  flex-shrink: 0; color: var(--text-faint); font-size: 11px;
  transition: transform var(--t-fast);
}
.day-bar.open .db-chevron { transform: rotate(90deg); }
.day-body { display: none; padding: 2px 0 4px; }
.day-body.open { display: block; }
.day-body .commit-row { border-left-color: var(--border); }

/* ── 一次性 coachmark 条 ────────────────────────────────────────────── */
.ledger-coachmark {
  display: flex; align-items: center; gap: 10px;
  margin: 0 0 10px 0;
  padding: 9px 13px;
  border: 1px solid var(--green-soft); border-radius: var(--radius);
  background: color-mix(in srgb, var(--green) 7%, transparent);
  font-size: 12.5px; color: var(--text);
  transition: opacity var(--t-med);
}
.ledger-coachmark .cm-text { flex: 1; line-height: 1.45; }
.ledger-coachmark .cm-close {
  flex-shrink: 0; cursor: pointer; color: var(--text-faint);
  font-size: 13px; line-height: 1; padding: 2px 4px;
}
.ledger-coachmark .cm-close:hover { color: var(--text); }

/* ── 空态（保留旧文案）─────────────────────────────────────────────── */
.story-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  flex-direction: column; gap: 8px; color: var(--text-faint); text-align: center;
}
.story-empty .big { font-size: 15px; color: var(--text-dim); }
.story-empty .small { font-size: 12.5px; }

/* ── 抽屉内复用（confbar / 链接 / 抽屉摘录）─────────────────────────── */
.story-confbar { height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--text) 8%, transparent); overflow: hidden; margin-top: 3px; }
.story-confbar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--green)); border-radius: 3px; }
.drawer-link { color: var(--blue); cursor: pointer; }
.drawer-link:hover { text-decoration: underline; }

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
`;

export const JS = `
(function () {
  'use strict';

  // i18n：优先 LORE_T，缺键英文兜底。
  function T(key, fallback) {
    try {
      if (typeof window.LORE_T === 'function') {
        var v = window.LORE_T(key);
        if (v && v !== key) return v;
      }
    } catch (e) {}
    return fallback;
  }

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
      var produced = g.produced || [];
      var touches = g.touches || [];

      // 空态（保留旧文案）。
      if (!commits.length) {
        el.innerHTML =
          '<div class="story-empty">' +
          '<div class="big">No commits to tell a story yet</div>' +
          '<div class="small">Run <span class="mono">lore build</span> on a repo with history to populate the timeline.</div>' +
          '</div>';
        return;
      }

      // ── 预聚合 ─────────────────────────────────────────────────────
      var commitByHash = {};
      for (var ci = 0; ci < commits.length; ci++) commitByHash[commits[ci].hash] = commits[ci];
      this.commitByHash = commitByHash;

      // commit -> 触碰文件数
      var touchCount = {};
      for (var ti = 0; ti < touches.length; ti++) {
        var th = touches[ti] && touches[ti].commitHash;
        if (!th) continue;
        touchCount[th] = (touchCount[th] || 0) + 1;
      }
      this.touchCount = touchCount;

      // session id -> session
      var sessionById = {};
      for (var si = 0; si < sessions.length; si++) {
        if (sessions[si] && sessions[si].id) sessionById[sessions[si].id] = sessions[si];
      }
      this.sessionById = sessionById;

      // session -> 其归因 produced 边（含 confidence/via）
      var sessionProduced = {};
      for (var pi = 0; pi < produced.length; pi++) {
        var pe = produced[pi];
        if (!pe || !pe.sessionId) continue;
        (sessionProduced[pe.sessionId] = sessionProduced[pe.sessionId] || []).push(pe);
      }
      this.sessionProduced = sessionProduced;

      // 已被归因的 commit hash 集合（用于挑出无对话 commit）。
      var attributedHashes = {};
      for (var ai = 0; ai < produced.length; ai++) {
        if (produced[ai] && produced[ai].commitHash) attributedHashes[produced[ai].commitHash] = true;
      }

      // ── 构建分组：session 组 + 无对话日期组，统一按"组内最新 commit 时间"倒序 ──
      var groups = [];

      // A. session 组——仅含有 PRODUCED 归因（且 commit 存在）的 session。
      for (var sid in sessionProduced) {
        if (!Object.prototype.hasOwnProperty.call(sessionProduced, sid)) continue;
        var edges = sessionProduced[sid];
        var rows = [];
        var latest = -Infinity;
        for (var ei = 0; ei < edges.length; ei++) {
          var ed = edges[ei];
          var c = commitByHash[ed.commitHash];
          if (!c) continue;
          var t = +new Date(c.authorDate);
          if (isNaN(t)) continue;
          rows.push({ commit: c, edge: ed, t: t });
          if (t > latest) latest = t;
        }
        if (!rows.length) continue;
        rows.sort(function (a, b) { return b.t - a.t; }); // 组内时间倒序
        groups.push({ kind: 'session', sid: sid, session: sessionById[sid] || null, rows: rows, t: latest });
      }

      // B. 无对话 commit——按自然日（YYYY-MM-DD）聚合。
      var dayMap = {};
      for (var di = 0; di < commits.length; di++) {
        var cm = commits[di];
        if (attributedHashes[cm.hash]) continue;
        var tt = +new Date(cm.authorDate);
        if (isNaN(tt)) continue;
        var day = new Date(cm.authorDate).toISOString().slice(0, 10);
        var bucket = dayMap[day] || (dayMap[day] = { kind: 'day', day: day, rows: [], t: -Infinity });
        bucket.rows.push({ commit: cm, t: tt });
        if (tt > bucket.t) bucket.t = tt;
      }
      for (var dk in dayMap) {
        if (!Object.prototype.hasOwnProperty.call(dayMap, dk)) continue;
        var bk = dayMap[dk];
        bk.rows.sort(function (a, b) { return b.t - a.t; });
        groups.push(bk);
      }

      // 组整体按最新 commit 时间倒序（最新在上）。
      groups.sort(function (a, b) { return b.t - a.t; });
      this.groups = groups;

      // ── 构建 DOM（一次性 innerHTML + 字符串拼接）─────────────────────
      var esc = ctx.fmt.esc;
      var fmt = ctx.fmt;

      var attributedCount = ctx.attributionIndex ? ctx.attributionIndex.size : Object.keys(attributedHashes).length;
      var total = commits.length;
      var frac = total > 0 ? attributedCount / total : 0;
      var pct = Math.round(frac * 100);

      var covTmpl = T('story.coverage', '{a} of {c} commits have conversation provenance');
      var covText = String(covTmpl).replace('{a}', String(attributedCount)).replace('{c}', String(total));

      var html = '';
      html += '<div class="ledger-scroll" id="ledger-scroll"><div class="ledger-col" id="ledger-col">';

      // 概览条
      html += '<div class="ledger-overview glass">' +
        '<div class="ov-line"><b>' + esc(covText) + '</b></div>' +
        '<div class="ledger-bar"><i style="width:' + pct + '%"></i></div>' +
        '</div>';

      var noConvoText = T('story.noconvo', 'no conversation recorded');

      // 分组流
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi];
        if (grp.kind === 'session') {
          html += this.renderSessionGroup(grp, esc, fmt, noConvoText);
        } else {
          html += this.renderDayGroup(grp, esc, fmt, noConvoText);
        }
      }

      html += '</div></div>';
      el.innerHTML = html;

      this.scrollEl = el.querySelector('#ledger-scroll');
      this.colEl = el.querySelector('#ledger-col');

      // ── 容器级事件委托（一个 click listener 管全部交互）────────────
      var view = this;
      this._onClick = function (ev) { view.handleClick(ev); };
      el.addEventListener('click', this._onClick);

      // ── 回放/导览运行态 ─────────────────────────────────────────────
      this.playbackActive = false;
      this._lastFollowAt = 0;

      this._onPlayStart = function () { view.playbackActive = true; };
      this._onPlayEnd = function () { view.playbackActive = false; };
      this._onDemo = function (e) {
        var hash = e && e.detail && e.detail.commitHash;
        if (hash) view.runDemo(hash);
      };
      try {
        window.addEventListener('lore:play-start', this._onPlayStart);
        window.addEventListener('lore:play-end', this._onPlayEnd);
        window.addEventListener('lore:demo', this._onDemo);
      } catch (e) {}

      // 应用初始 cutoff（通常 null = 全亮）。
      this.applyCutoff(ctx.cutoffMs);
    },

    // ── session 组 HTML ─────────────────────────────────────────────
    renderSessionGroup: function (grp, esc, fmt, noConvoText) {
      var s = grp.session;
      var agent = (s && s.agent) ? s.agent : 'session';
      var idShort = String(grp.sid).slice(0, 8);
      var dateStr = grp.rows.length ? fmt.date(grp.rows[0].commit.authorDate) : '';
      var n = grp.rows.length;
      var countLabel = n + (n === 1 ? ' commit' : ' commits');

      var html = '<div class="ledger-group" data-group="session">';
      html += '<div class="session-head" data-session="' + esc(grp.sid) + '">' +
        '<span class="sh-dot"></span>' +
        '<span class="sh-agent">' + esc(agent) + '</span>' +
        '<span class="sh-id">' + esc(idShort) + '</span>' +
        '<span class="sh-date">' + esc(dateStr) + '</span>' +
        '<span class="sh-spacer"></span>' +
        '<span class="sh-count">' + esc(countLabel) + '</span>' +
        '</div>';
      html += '<div class="session-body">';
      for (var i = 0; i < grp.rows.length; i++) {
        html += this.renderCommitRow(grp.rows[i].commit, grp.rows[i].edge, esc, fmt, false);
      }
      html += '</div></div>';
      return html;
    },

    // ── 单条 commit 行（+ 可选内联摘录）─────────────────────────────
    // dimTrack=true 时左轨灰色（无对话 commit）。
    renderCommitRow: function (c, edge, esc, fmt, dimTrack) {
      var subject = String(c.subject || '(no subject)');
      var hash7 = String(c.hash).slice(0, 7);
      var dateStr = fmt.datetime(c.authorDate);

      var meta = '<span class="cr-hash">' + esc(hash7) + '</span>' +
        '<span class="cr-sep">·</span><span>' + esc(dateStr) + '</span>';
      if (edge) {
        var conf = Math.round((edge.confidence || 0) * 100);
        meta += '<span class="cr-sep">·</span><span>' + conf + '%</span>' +
          '<span class="cr-sep">·</span><span>' + esc(edge.matchedVia || '—') + '</span>';
      }

      var rowCls = 'commit-row' + (dimTrack ? ' dim-track' : '');
      var html = '<div class="' + rowCls + '" data-commit="' + esc(c.hash) + '">' +
        '<div class="cr-subject">' + esc(subject) + '</div>' +
        '<div class="cr-meta">' + meta + '</div>' +
        '</div>';

      // 内联摘录块（仅当 payload.excerpts 有该 commit）。
      html += this.renderInlineExcerpts(c.hash, esc, fmt);
      return html;
    },

    renderInlineExcerpts: function (hash, esc, fmt) {
      var ex = this.ctx.payload && this.ctx.payload.excerpts;
      var list = ex && ex[hash];
      if (!list || !list.length) return '';
      var html = '<div class="row-excerpts" data-excerpts="' + esc(hash) + '">';
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        var isUser = m.role === 'user';
        var pill = isUser
          ? '<span class="rx-pill user">USER</span>'
          : '<span class="rx-pill agent">AGENT</span>';
        var anchor = String(m.sessionId || '').slice(0, 8) + '#' + m.seq;
        html += '<div class="rx-item">' +
          '<div class="rx-meta">' + pill + '<span class="rx-anchor">' + esc(anchor) + '</span></div>' +
          '<div class="rx-text">' + esc(m.text || '') + '</div>' +
          '</div>';
      }
      html += '<div class="rx-toggle">expand ▾</div>';
      html += '</div>';
      return html;
    },

    // ── 无对话日期折叠条 HTML（默认折叠）────────────────────────────
    renderDayGroup: function (grp, esc, fmt, noConvoText) {
      var n = grp.rows.length;
      var countLabel = n + (n === 1 ? ' commit' : ' commits');
      var html = '<div class="ledger-group" data-group="day">';
      html += '<div class="day-bar" data-day-toggle="1">' +
        '<span class="db-date">' + esc(grp.day) + '</span>' +
        '<span class="db-sep">·</span><span>' + esc(countLabel) + '</span>' +
        '<span class="db-sep">·</span><span>' + esc(noConvoText) + '</span>' +
        '<span class="db-spacer"></span>' +
        '<span class="db-chevron">▸</span>' +
        '</div>';
      html += '<div class="day-body">';
      for (var i = 0; i < grp.rows.length; i++) {
        html += this.renderCommitRow(grp.rows[i].commit, null, esc, fmt, true);
      }
      html += '</div></div>';
      return html;
    },

    // ── 事件委托：组头/日期条/摘录/commit 行/coachmark 关闭 ──────────
    handleClick: function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      // coachmark 关闭按钮
      var cmClose = t.closest('.cm-close');
      if (cmClose) {
        var cm = cmClose.closest('.ledger-coachmark');
        if (cm && cm.parentNode) cm.parentNode.removeChild(cm);
        return;
      }

      // 日期折叠条：展开/收起
      var dayBar = t.closest('.day-bar');
      if (dayBar) {
        dayBar.classList.toggle('open');
        var body = dayBar.parentNode ? dayBar.parentNode.querySelector('.day-body') : null;
        if (body) body.classList.toggle('open');
        return;
      }

      // 摘录块：点击展开/收起（不冒泡到 commit 行）。
      var rx = t.closest('.row-excerpts');
      if (rx) {
        ev.stopPropagation();
        var expanded = rx.classList.toggle('expanded');
        var tog = rx.querySelector('.rx-toggle');
        if (tog) tog.textContent = expanded ? 'collapse ▴' : 'expand ▾';
        return;
      }

      // session 组头：开 session 详情。
      var head = t.closest('.session-head');
      if (head) {
        var sid = head.getAttribute('data-session');
        var s = this.sessionById[sid];
        if (s) this.openSession(s);
        return;
      }

      // commit 行：开 commit 详情。
      var row = t.closest('.commit-row');
      if (row) {
        var c = this.commitByHash[row.getAttribute('data-commit')];
        if (c) this.openCommit(c);
        return;
      }
    },

    // ── onShow / onResize（流式布局，无需重排）──────────────────────
    onShow: function () {},
    onResize: function () {},

    // ── 时间轴回放：cutoff 右侧（更新）的行变 future ─────────────────
    onTimeline: function (cutoffMs) {
      this.applyCutoff(cutoffMs);
    },

    applyCutoff: function (cutoffMs) {
      if (!this.el) return;
      var rows = this.el.querySelectorAll('.commit-row');
      var self = this;
      var newestVisible = null;
      var newestT = -Infinity;

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var c = this.commitByHash[row.getAttribute('data-commit')];
        if (!c) continue;
        var t = +new Date(c.authorDate);
        var isFuture = (cutoffMs != null) && (t > cutoffMs);
        var wasFuture = row.classList.contains('future');

        if (isFuture) {
          row.classList.add('future');
        } else {
          row.classList.remove('future');
          // 从 future 变亮：加 240ms 背景闪过渡（一次性）。
          if (wasFuture) {
            (function (r) {
              r.classList.remove('reveal');
              // 强制重排让动画可重触发。
              void r.offsetWidth;
              r.classList.add('reveal');
              setTimeout(function () { r.classList.remove('reveal'); }, 280);
            })(row);
          }
          if (t > newestT) { newestT = t; newestVisible = row; }
        }
      }

      // 播放中：把"最新的非 future 行"滚动跟进（节流 300ms）。
      if (this.playbackActive && newestVisible) {
        var now = Date.now();
        if (now - this._lastFollowAt >= 300) {
          this._lastFollowAt = now;
          try { newestVisible.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
        }
      }
    },

    // ── 导览：滚动到该 commit 行、展开摘录、高亮环、贴一次性 coachmark ──
    runDemo: function (commitHash) {
      if (!this.el) return;
      var self = this;
      var row = this.el.querySelector('.commit-row[data-commit="' + cssAttr(commitHash) + '"]');
      if (!row) return;

      // 若该行在折叠的日期组里，先展开。
      var dayBody = row.closest('.day-body');
      if (dayBody && !dayBody.classList.contains('open')) {
        dayBody.classList.add('open');
        var bar = dayBody.parentNode ? dayBody.parentNode.querySelector('.day-bar') : null;
        if (bar) bar.classList.add('open');
      }

      // 滚动居中。
      try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}

      // 展开其内联摘录（紧跟该行的 .row-excerpts）。
      var rx = row.nextElementSibling;
      if (rx && rx.classList && rx.classList.contains('row-excerpts')) {
        rx.classList.add('expanded');
        var tog = rx.querySelector('.rx-toggle');
        if (tog) tog.textContent = 'collapse ▴';
      }

      // 2 秒高亮环（一次性）。
      row.classList.remove('demo-ring');
      void row.offsetWidth;
      row.classList.add('demo-ring');
      setTimeout(function () { row.classList.remove('demo-ring'); }, 2100);

      // 一次性 coachmark 条（localStorage 限一次），插在该行所属组上方。
      this.showCoachmark(row);
    },

    showCoachmark: function (row) {
      if (!this.colEl) return;
      try {
        if (localStorage.getItem('lore.coach.story') === '1') return;
      } catch (e) {}
      try { localStorage.setItem('lore.coach.story', '1'); } catch (e) {}

      // 已存在则不重复。
      if (this.colEl.querySelector('.ledger-coachmark')) return;

      var text = T('coachmark.text', 'This commit was written with an AI agent — click any row to read the conversation behind it.');
      var esc = this.ctx.fmt.esc;

      var group = row.closest('.ledger-group');
      var cm = document.createElement('div');
      cm.className = 'ledger-coachmark';
      cm.innerHTML = '<span class="cm-text">' + esc(text) + '</span><span class="cm-close">✕</span>';
      if (group && group.parentNode) {
        group.parentNode.insertBefore(cm, group);
      } else {
        this.colEl.insertBefore(cm, this.colEl.firstChild);
      }
    },

    // ── 抽屉：commit 详情（结构沿用旧实现）──────────────────────────
    openCommit: function (c) {
      var ctx = this.ctx, fmt = ctx.fmt, esc = fmt.esc;
      var attrs = (ctx.attributionIndex && ctx.attributionIndex.get(c.hash)) || [];
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
      var ctx = this.ctx, fmt = ctx.fmt, esc = fmt.esc;
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

    // drawer 内链接：session / commit 互跳。
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

  // 把任意 hash 变成合法属性选择器值（双引号包裹，转义反斜杠与双引号）。
  function cssAttr(s) { return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"'); }

  // 抽屉内嵌对话摘录：payload.excerpts[commitHash] → HTML 块（无摘录返回空串）。
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
