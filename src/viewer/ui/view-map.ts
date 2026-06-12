/**
 * view-map.ts — 仓库地图（treemap）
 * "哪片代码有 AI 记忆、哪片是黑洞"
 *
 * 设计：d3.treemap squarify，填色=归因覆盖度（灰→绿），
 * 右上角切换 commit数/改动行数，onTimeline 动态重布局。
 */

export const CSS = `
/* ── Map view ───────────────────────────────────────────── */

/* cell entry animation — applied once per render pass */
@keyframes map-cell-in {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
.map-cell-enter {
  animation: map-cell-in 300ms var(--ease) both;
}

/* glass legend bar bottom-left */
#map-legend {
  position: absolute;
  bottom: 80px;
  left: 20px;
  z-index: 10;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: none;
}
.map-legend-label {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}
.map-legend-ramp {
  width: 80px;
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--gray-node) 30%, transparent),
    color-mix(in srgb, var(--green) 65%, transparent));
  flex-shrink: 0;
}
.map-legend-ticks {
  display: flex;
  justify-content: space-between;
  width: 80px;
  flex-shrink: 0;
  position: relative;
}
.map-legend-tick {
  font-size: 10px;
  color: var(--text-faint);
}

#view-map {
  overflow: hidden;
  position: relative;
}

#map-svg {
  display: block;
  width: 100%;
  height: 100%;
}

/* toolbar chip row */
#map-toolbar {
  position: absolute;
  top: 70px;
  right: 20px;
  z-index: 10;
  display: flex;
  gap: 6px;
  align-items: center;
}

.map-cell {
  cursor: pointer;
  transition: opacity var(--t-fast);
}
.map-cell rect {
  transition: stroke var(--t-fast), stroke-width var(--t-fast);
}
.map-cell:hover rect {
  stroke: var(--green) !important;
  stroke-width: 1.5px !important;
}
.map-cell text {
  pointer-events: none;
  user-select: none;
}

/* tooltip */
#map-tooltip {
  position: absolute;
  z-index: 40;
  pointer-events: none;
  background: var(--panel-solid);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: 11.5px;
  color: var(--text);
  max-width: 280px;
  box-shadow: var(--shadow);
  opacity: 0;
  transition: opacity var(--t-fast);
  line-height: 1.6;
}
#map-tooltip.visible { opacity: 1; }
#map-tooltip .tip-path { color: var(--text-faint); font-family: var(--mono); font-size: 11px; margin-bottom: 3px; word-break: break-all; }
#map-tooltip .tip-row { color: var(--text-dim); }
#map-tooltip .tip-cov  { color: var(--green); font-weight: 600; }

/* empty state */
#map-empty {
  display: none;
  position: absolute;
  inset: 0;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  color: var(--text-faint);
  font-size: 13px;
}
#map-empty.show { display: flex; }
`;

export const JS = `
(function () {
  // ─── constants ───────────────────────────────────────────────
  var PAD_TOP = 64;   // topbar height + margin
  var PAD_BOT = 62;   // timebar height + margin
  var PAD_SIDE = 0;
  var CELL_PAD = 2;
  var TRANS_MS = 280;
  var MIN_LABEL_AREA = 2400;     // px2 threshold to show filename
  var MIN_DIR_LABEL_AREA = 12000; // px2 threshold to show dir name

  // 覆盖度填色：0 = 近透明灰（--gray-node），1 = 较实的绿（--green）。
  // 走 color-mix 阶梯（现代浏览器支持把 color-mix 字符串当 SVG fill），
  // 因此自动跟随主题（token 切换无需重算）。
  //   hue:   --gray-node → --green 按 frac 插值
  //   alpha: 0.15 → 0.60 按 frac 插值（再与 transparent 混出整体不透明度）
  function covColor(frac) {
    var t = Math.max(0, Math.min(1, frac));
    var huePct = Math.round(t * 100);                 // 0..100 → green 占比
    var alphaPct = Math.round((0.15 + (0.60 - 0.15) * t) * 100); // 15..60
    var hue = 'color-mix(in srgb, var(--green) ' + huePct + '%, var(--gray-node))';
    return 'color-mix(in srgb, ' + hue + ' ' + alphaPct + '%, transparent)';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }

  // ─── build tree from flat touches ───────────────────────────
  function buildHierarchy(touches, attributionIndex, cutoffMs, metric) {
    // metric: 'commits' | 'lines'
    // touches: TouchesEdgeData[]
    // build map: filePath -> { commits: Set<hash>, lines: number, attributedCommits: Set<hash> }
    var fileMap = {};
    for (var i = 0; i < touches.length; i++) {
      var t = touches[i];
      if (!t || !t.filePath || !t.commitHash) continue;
      // filter by cutoff
      // We don't have commit date directly in touches, so we filter at caller
      var fp = t.filePath;
      if (!fileMap[fp]) fileMap[fp] = { commits: {}, lines: 0, attributedCommits: {} };
      fileMap[fp].commits[t.commitHash] = true;
      fileMap[fp].lines += (t.addedLines || 0);
      if (attributionIndex.has(t.commitHash)) {
        fileMap[fp].attributedCommits[t.commitHash] = true;
      }
    }

    // build nested object tree
    var root = { name: '', children: {}, _isDir: true };
    var fileEntries = Object.keys(fileMap);
    if (fileEntries.length === 0) return null;

    for (var fi = 0; fi < fileEntries.length; fi++) {
      var fp2 = fileEntries[fi];
      var parts = fp2.split('/');
      var node = root;
      for (var pi = 0; pi < parts.length - 1; pi++) {
        var part = parts[pi];
        if (!node.children[part]) node.children[part] = { name: part, children: {}, _isDir: true };
        node = node.children[part];
      }
      var fname = parts[parts.length - 1];
      var fm = fileMap[fp2];
      var commitCount = Object.keys(fm.commits).length;
      var attrCount = Object.keys(fm.attributedCommits).length;
      var value = metric === 'lines' ? Math.max(1, fm.lines) : Math.max(1, commitCount);
      node.children[fname] = {
        name: fname,
        fullPath: fp2,
        commitCount: commitCount,
        attrCount: attrCount,
        lines: fm.lines,
        value: value,
        _isDir: false
      };
    }

    // convert to d3 hierarchy format
    function toD3(node, name) {
      if (!node._isDir) return node;
      var ch = Object.keys(node.children).map(function(k) { return toD3(node.children[k], k); });
      return { name: name || '', children: ch, _isDir: true };
    }

    return toD3(root, '');
  }

  // ─── main mount ──────────────────────────────────────────────
  window.LORE_VIEWS.push({
    id: 'map',
    label: 'Map',
    subtitleKey: 'map.subtitle',

    _metric: 'commits',
    _ctx: null,
    _svg: null,
    _tooltip: null,
    _w: 0,
    _h: 0,
    _commitsByHash: null,

    mount: function(el, ctx) {
      var self = this;
      self._ctx = ctx;

      // ── pre-build commit date index ──────────────────────────
      var cByHash = {};
      var commits = ctx.payload.graph.commits || [];
      for (var ci = 0; ci < commits.length; ci++) {
        cByHash[commits[ci].hash] = commits[ci];
      }
      self._commitsByHash = cByHash;

      // ── toolbar ──────────────────────────────────────────────
      var toolbar = document.createElement('div');
      toolbar.id = 'map-toolbar';

      var btnCommits = document.createElement('button');
      btnCommits.className = 'btn active';
      btnCommits.textContent = 'commit count';
      btnCommits.id = 'map-btn-commits';

      var btnLines = document.createElement('button');
      btnLines.className = 'btn';
      btnLines.textContent = 'lines changed';
      btnLines.id = 'map-btn-lines';

      toolbar.appendChild(btnCommits);
      toolbar.appendChild(btnLines);
      el.appendChild(toolbar);

      btnCommits.addEventListener('click', function() {
        self._metric = 'commits';
        btnCommits.classList.add('active');
        btnLines.classList.remove('active');
        self._render();
      });
      btnLines.addEventListener('click', function() {
        self._metric = 'lines';
        btnLines.classList.add('active');
        btnCommits.classList.remove('active');
        self._render();
      });

      // ── empty state ──────────────────────────────────────────
      var empty = document.createElement('div');
      empty.id = 'map-empty';
      empty.innerHTML = '<span style="font-size:13px;color:var(--text-faint)">No file touch data available yet.</span>';
      el.appendChild(empty);

      // ── tooltip ──────────────────────────────────────────────
      var tip = document.createElement('div');
      tip.id = 'map-tooltip';
      el.appendChild(tip);
      self._tooltip = tip;

      // ── SVG ──────────────────────────────────────────────────
      var svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgEl.id = 'map-svg';
      el.appendChild(svgEl);
      self._svg = d3.select(svgEl);

      // ── legend bar (bottom-left glass strip) ─────────────────
      var legendEl = document.createElement('div');
      legendEl.id = 'map-legend';
      legendEl.className = 'glass';
      var legendLabel = (typeof window.LORE_T === 'function')
        ? window.LORE_T('map.legend')
        : 'AI memory coverage';
      legendEl.innerHTML =
        '<span class="map-legend-tick">0%</span>' +
        '<div>' +
          '<div class="map-legend-ramp"></div>' +
        '</div>' +
        '<span class="map-legend-tick">100%</span>' +
        '<span class="map-legend-label">' + legendLabel + '</span>';
      el.appendChild(legendEl);

      // 主题切换：covColor 走 color-mix（跟随 token 自动重算），重绘一次以稳妥。
      try {
        window.addEventListener('lore:theme', function () { self._render(); });
      } catch (e) {}

      self._render();
    },

    onTimeline: function(cutoffMs) {
      this._render();
    },

    onResize: function() {
      this._render();
    },

    _filteredTouches: function() {
      var ctx = this._ctx;
      var touches = (ctx.payload.graph.touches || []);
      var cutoffMs = ctx.cutoffMs;
      if (cutoffMs == null) return touches;
      var cByHash = this._commitsByHash;
      return touches.filter(function(t) {
        if (!t || !t.commitHash) return false;
        var c = cByHash[t.commitHash];
        if (!c) return false;
        var ts = +new Date(c.authorDate);
        return !isNaN(ts) && ts <= cutoffMs;
      });
    },

    _render: function() {
      var self = this;
      var ctx = self._ctx;
      if (!ctx) return;

      var el = document.getElementById('view-map');
      if (!el) return;
      var rect = el.getBoundingClientRect();
      var W = rect.width  || window.innerWidth;
      var H = rect.height || window.innerHeight;
      self._w = W;
      self._h = H;

      var touches = self._filteredTouches();
      var hier = buildHierarchy(touches, ctx.attributionIndex, ctx.cutoffMs, self._metric);

      var emptyEl = document.getElementById('map-empty');
      if (!hier || !hier.children || hier.children.length === 0) {
        if (emptyEl) emptyEl.classList.add('show');
        self._svg.selectAll('*').remove();
        return;
      }
      if (emptyEl) emptyEl.classList.remove('show');

      // layout
      var usableTop    = PAD_TOP;
      var usableBottom = H - PAD_BOT;
      var usableLeft   = PAD_SIDE;
      var usableRight  = W - PAD_SIDE;
      var usableW = usableRight - usableLeft;
      var usableH = usableBottom - usableTop;

      var root = d3.hierarchy(hier)
        .sum(function(d) { return d.value || 0; })
        .sort(function(a, b) { return (b.value || 0) - (a.value || 0); });

      var treemap = d3.treemap()
        .tile(d3.treemapSquarify)
        .size([usableW, usableH])
        .paddingInner(CELL_PAD)
        .paddingTop(function(d) { return d.depth === 1 ? 18 : CELL_PAD; })
        .paddingOuter(CELL_PAD)
        .round(true);

      treemap(root);

      self._svg
        .attr('width', W)
        .attr('height', H)
        .attr('viewBox', '0 0 ' + W + ' ' + H);

      // translate all coords by usable offset
      var leaves = root.leaves();
      var dirNodes = root.descendants().filter(function(d) {
        return d.children && d.children.length > 0 && d.depth >= 1;
      });

      var tip = self._tooltip;

      // ── bind leave cells ────────────────────────────────────
      var cellSel = self._svg.selectAll('g.map-cell')
        .data(leaves, function(d) { return d.data.fullPath || d.data.name; });

      // EXIT
      cellSel.exit().remove();

      // ENTER
      var cellEnter = cellSel.enter().append('g')
        .attr('class', 'map-cell')
        .on('mousemove', function(event, d) {
          var fp = d.data.fullPath || d.data.name;
          var cc = d.data.commitCount || 0;
          var ac = d.data.attrCount   || 0;
          var cov = cc > 0 ? Math.round(ac / cc * 100) : 0;
          var lines = d.data.lines || 0;
          tip.innerHTML =
            '<div class="tip-path">' + esc(fp) + '</div>' +
            '<div class="tip-row">commits touched: <strong>' + cc + '</strong></div>' +
            '<div class="tip-row">lines changed: <strong>' + lines + '</strong></div>' +
            '<div class="tip-row">attribution coverage: <span class="tip-cov">' + cov + '%</span></div>';
          tip.classList.add('visible');
          var tx = event.offsetX + 14;
          var ty = event.offsetY + 14;
          if (tx + 290 > W) tx = event.offsetX - 290;
          if (ty + 120 > H) ty = event.offsetY - 120;
          tip.style.left = tx + 'px';
          tip.style.top  = ty + 'px';
        })
        .on('mouseleave', function() {
          tip.classList.remove('visible');
        })
        .on('click', function(event, d) {
          event.stopPropagation();
          self._openDrawer(d);
        });

      // apply entry animation to newly-created cells (one-shot)
      cellEnter.classed('map-cell-enter', true);

      cellEnter.append('rect');
      cellEnter.append('text').attr('class', 'cell-label');

      // MERGE
      var cellMerge = cellEnter.merge(cellSel);

      cellMerge.transition().duration(TRANS_MS)
        .attr('transform', function(d) {
          return 'translate(' + (usableLeft + d.x0) + ',' + (usableTop + d.y0) + ')';
        });

      cellMerge.select('rect')
        .transition().duration(TRANS_MS)
        .attr('width',  function(d) { return Math.max(0, d.x1 - d.x0); })
        .attr('height', function(d) { return Math.max(0, d.y1 - d.y0); })
        .attr('rx', 3).attr('ry', 3)
        .attr('fill', function(d) {
          var cc = d.data.commitCount || 0;
          var ac = d.data.attrCount   || 0;
          var frac = cc > 0 ? ac / cc : 0;
          return covColor(frac);
        })
        .attr('stroke', 'var(--border)')
        .attr('stroke-width', 0.5);

      cellMerge.select('text.cell-label')
        .each(function(d) {
          var cellW = d.x1 - d.x0;
          var cellH = d.y1 - d.y0;
          var area = cellW * cellH;
          var el2 = d3.select(this);
          if (area >= MIN_LABEL_AREA) {
            el2.attr('x', 5)
               .attr('y', 13)
               .attr('font-size', '11px')
               .attr('fill', 'var(--text-dim)')
               .attr('clip-path', null)
               .text(d.data.name || '');
          } else {
            el2.text('');
          }
        });

      // ── bind directory labels ────────────────────────────────
      var dirSel = self._svg.selectAll('text.map-dir-label')
        .data(dirNodes, function(d) { return d.data.name + '-' + d.depth; });

      dirSel.exit().remove();

      var dirEnter = dirSel.enter().append('text')
        .attr('class', 'map-dir-label')
        .attr('font-size', '11px')
        .attr('fill', 'var(--text-faint)')
        .attr('pointer-events', 'none');

      dirEnter.merge(dirSel)
        .transition().duration(TRANS_MS)
        .attr('x', function(d) { return usableLeft + d.x0 + 4; })
        .attr('y', function(d) { return usableTop  + d.y0 + 12; })
        .text(function(d) {
          var w = d.x1 - d.x0;
          var h = d.y1 - d.y0;
          if (w * h >= MIN_DIR_LABEL_AREA) return d.data.name || '';
          return '';
        });
    },

    _openDrawer: function(d) {
      var ctx = this._ctx;
      var fp = d.data.fullPath || d.data.name;
      var cc  = d.data.commitCount || 0;
      var ac  = d.data.attrCount   || 0;
      var cov = cc > 0 ? Math.round(ac / cc * 100) : 0;
      var lines = d.data.lines || 0;

      // collect touching commits (time-desc)
      var cByHash = this._commitsByHash;
      var touches = this._filteredTouches();
      var relevantTouches = touches.filter(function(t) { return t && t.filePath === fp; });
      // deduplicate by commitHash
      var seenHashes = {};
      var uniqTouches = [];
      for (var i = 0; i < relevantTouches.length; i++) {
        var h = relevantTouches[i].commitHash;
        if (!seenHashes[h]) { seenHashes[h] = true; uniqTouches.push(relevantTouches[i]); }
      }
      // sort by date desc
      uniqTouches.sort(function(a, b) {
        var da = cByHash[a.commitHash] ? +new Date(cByHash[a.commitHash].authorDate) : 0;
        var db = cByHash[b.commitHash] ? +new Date(cByHash[b.commitHash].authorDate) : 0;
        return db - da;
      });

      // sessions that edited this file
      var edited = (ctx.payload.graph.edited || []).filter(function(e) { return e && e.filePath === fp; });

      var html = '';
      html += '<h3 style="font-family:var(--mono);font-size:12px;word-break:break-all">' + esc(fp) + '</h3>';
      html += '<div class="sep"></div>';
      html += '<div class="row"><span class="k">commits</span><span class="v">' + cc + '</span></div>';
      html += '<div class="row"><span class="k">lines changed</span><span class="v">' + lines + '</span></div>';
      html += '<div class="row"><span class="k">attribution</span><span class="v" style="color:var(--green)">' + cov + '%</span></div>';

      if (uniqTouches.length > 0) {
        html += '<div class="sep"></div>';
        html += '<div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Touching commits</div>';
        var limit = Math.min(uniqTouches.length, 30);
        for (var i = 0; i < limit; i++) {
          var t2 = uniqTouches[i];
          var c2 = cByHash[t2.commitHash];
          var subject = c2 ? c2.subject : '(unknown)';
          var dateStr = c2 ? ctx.fmt.date(c2.authorDate) : '';
          var hasAttr = ctx.attributionIndex.has(t2.commitHash);
          var dot = hasAttr
            ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);margin-right:5px;flex-shrink:0"></span>'
            : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--border-strong);margin-right:5px;flex-shrink:0"></span>';
          html += '<div class="row" style="align-items:flex-start">' +
            dot +
            '<span class="v" style="flex:1">' +
              '<span class="mono" style="color:var(--text-faint)">' + esc(ctx.fmt.hash(t2.commitHash)) + '</span>' +
              ' <span style="color:var(--text-dim)">' + esc(subject) + '</span>' +
              (dateStr ? ' <span style="color:var(--text-faint);font-size:11px">' + esc(dateStr) + '</span>' : '') +
            '</span>' +
            '</div>';
        }
        if (uniqTouches.length > limit) {
          html += '<div style="color:var(--text-faint);font-size:11px;margin-top:4px">+ ' + (uniqTouches.length - limit) + ' more</div>';
        }
      }

      if (edited.length > 0) {
        html += '<div class="sep"></div>';
        html += '<div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Editing sessions</div>';
        for (var j = 0; j < edited.length; j++) {
          var e2 = edited[j];
          html += '<div class="row">' +
            '<span class="k mono" style="color:var(--blue)">' + esc(e2.sessionId ? e2.sessionId.slice(0,8) : '?') + '</span>' +
            '<span class="v">' +
              (e2.editCount || 0) + ' edits' +
              (e2.firstTs ? ' · ' + ctx.fmt.date(e2.firstTs) : '') +
            '</span>' +
            '</div>';
        }
      }

      ctx.drawer.show(html);
    },
  });
})();
`;
