/**
 * view-graph.ts — 力导向探索视图（产品级重画版）。
 *
 * 数据/物理逻辑从旧版 cc5d5c4 移植，视觉完全重画：
 *   - 曲线边：PRODUCED 渐变宽度，TOUCHES 极细，EDITED 虚线
 *   - session 节点：蓝实心 + 外 halo 环；hover 时环放大
 *   - commit：ctx.commitColor 圆角方块
 *   - file：--gray-node 小圆
 *   - decision：--amber 菱形，invalidAt 时半透明
 *   - focus 交互：hover 高亮一阶邻域，其余压暗 0.15
 *   - 开关 chips：Show all files / Show unlinked commits
 *   - onTimeline：淡出而非重建，松手 300ms 后重跑仿真
 */

export const CSS = `
#view-graph {
  position: relative;
  overflow: hidden;
}

#vg-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

/* 控制 chip 覆盖层 */
#vg-controls {
  position: absolute;
  top: 74px;
  left: 24px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 图例 */
#vg-legend {
  position: absolute;
  bottom: 80px;
  left: 24px;
  z-index: 10;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.vg-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-faint);
}
.vg-legend-dot {
  width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
}
.vg-legend-diamond {
  width: 9px; height: 9px;
  background: var(--amber);
  transform: rotate(45deg);
  flex-shrink: 0;
}
.vg-legend-rect {
  width: 10px; height: 10px;
  border-radius: 2px;
  background: var(--green);
  flex-shrink: 0;
}
.vg-legend-line {
  width: 18px; height: 2px;
  background: var(--blue);
  flex-shrink: 0;
}

/* 空态 */
#vg-empty {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 13px;
  letter-spacing: 0.04em;
  pointer-events: none;
}
#vg-empty.visible { display: flex; }

/* SVG 节点交互样式（选中描边） */
.vg-node-selected .vg-node-shape {
  stroke: var(--green) !important;
  stroke-width: 2.5px !important;
}
`;

export const JS = `
(function() {
  // ── 常量 ──────────────────────────────────────────────────────────────────
  var MANY_FILES = 300;
  var LABEL_HIDE_SCALE = 1.1;  // 缩放低于此值时隐藏 commit/file 标签
  var TIMELINE_DEBOUNCE_MS = 300;

  // ── 状态 ──────────────────────────────────────────────────────────────────
  var _el = null;
  var _ctx = null;
  var _svg = null;
  var _zoomG = null;
  var _linkLayer = null;
  var _nodeLayer = null;
  var _zoomBehavior = null;
  var _simulation = null;
  var _hasAutoFitted = false;
  var _showAllFiles = false;
  var _showIsolated = false;
  var _currentCutoff = null;  // null = 全量
  var _timelineTimer = null;
  var _selectedId = null;
  var _width = 900;
  var _height = 600;
  // 当前渲染的 nodes/links（供 onTimeline 用）
  var _nodes = [];
  var _links = [];
  // 用于 onTimeline 淡出（d3 selection 缓存）
  var _nodeSel = null;
  var _linkSel = null;

  // ── 工具 ──────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }

  // 从 CSS 变量读取实际色值（在 SVG 里无法直接用 var()，需要 getComputedStyle）
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ── 渐变 defs ────────────────────────────────────────────────────────────
  function ensureDefs(svg) {
    var defs = svg.select('defs');
    if (defs.empty()) defs = svg.append('defs');

    // PRODUCED 边渐变：blue → green
    var grad = defs.append('linearGradient')
      .attr('id', 'vg-grad-produced')
      .attr('gradientUnits', 'userSpaceOnUse');
    grad.append('stop').attr('offset', '0%').attr('stop-color', cssVar('--blue'));
    grad.append('stop').attr('offset', '100%').attr('stop-color', cssVar('--green'));

    // halo glow filter for selected node
    var filter = defs.append('filter').attr('id', 'vg-glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
    var merge = filter.append('feMerge');
    merge.append('feMergeNode').attr('in', 'blur');
    merge.append('feMergeNode').attr('in', 'SourceGraphic');
  }

  // ── zoomToFit（5-95 分位，冷却后一次性）──────────────────────────────────
  function zoomToFit(nodes) {
    if (!nodes.length || !_svg || !_zoomBehavior) return;
    var xs = nodes.map(function(n) { return n.x; }).sort(function(a,b){return a-b;});
    var ys = nodes.map(function(n) { return n.y; }).sort(function(a,b){return a-b;});
    function q(arr, p) {
      return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];
    }
    var x0 = q(xs, 0.05), x1 = q(xs, 0.95), y0 = q(ys, 0.05), y1 = q(ys, 0.95);
    var pad = 80;
    var rangeX = x1 - x0 + pad * 2;
    var rangeY = y1 - y0 + pad * 2;
    if (rangeX <= 0 || rangeY <= 0) return;
    var k = Math.min(2.5, 0.95 * Math.min(_width / rangeX, _height / rangeY));
    var tx = _width / 2 - k * (x0 + x1) / 2;
    var ty = _height / 2 - k * (y0 + y1) / 2;
    _svg.transition().duration(500).call(
      _zoomBehavior.transform,
      d3.zoomIdentity.translate(tx, ty).scale(k)
    );
  }

  // ── 曲线路径生成 ──────────────────────────────────────────────────────────
  function curvePath(d) {
    var sx = d.source.x || 0, sy = d.source.y || 0;
    var tx = d.target.x || 0, ty = d.target.y || 0;
    var mx = (sx + tx) / 2;
    var my = (sy + ty) / 2;
    // 法线方向弯曲（轻微，避免重叠边难以区分）
    var dx = tx - sx, dy = ty - sy;
    var len = Math.sqrt(dx*dx + dy*dy) || 1;
    // 曲率：弧高 = 距离 * 0.12，最大 40px
    var bend = Math.min(40, len * 0.12);
    var nx = -dy / len * bend;
    var ny = dx / len * bend;
    return 'M' + sx + ',' + sy + ' Q' + (mx + nx) + ',' + (my + ny) + ' ' + tx + ',' + ty;
  }

  // ── 详情抽屉内容生成 ──────────────────────────────────────────────────────
  function row(k, v) {
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  }

  function sessionHtml(d, ctx) {
    var s = d.data;
    var startStr = s.startedAt ? s.startedAt.slice(0, 16).replace('T', ' ') : '—';
    var endStr = s.endedAt ? s.endedAt.slice(0, 16).replace('T', ' ') : 'ongoing';
    var sourceCount = (s.sourcePaths || []).length;
    var prods = ctx.attributionIndex.get(s.id) || [];
    var prodRows = prods.map(function(p) {
      return '<div class="row"><span class="k">commit</span><span class="v mono">' +
        esc(p.commitHash.slice(0, 8)) + '</span></div>' +
        '<div class="row"><span class="k">confidence</span><span class="v">' +
        p.confidence.toFixed(3) + '</span></div>';
    }).join('<div class="sep"></div>');
    return '<h3>Session</h3>' +
      row('id', '<span class="mono">' + esc(s.id.slice(0, 20)) + '</span>') +
      row('agent', esc(s.agent)) +
      row('started', esc(startStr)) +
      row('ended', esc(endStr)) +
      row('branch', esc(s.gitBranch || '—')) +
      row('cwd', s.cwd ? esc('…' + s.cwd.slice(-32)) : '—') +
      row('sources', esc(String(sourceCount)) + ' file(s)') +
      (prods.length ? '<div class="sep"></div><h3>Attributions (' + prods.length + ')</h3>' + prodRows : '');
  }

  function commitHtml(d, ctx) {
    var c = d.data;
    var dateStr = c.authorDate ? c.authorDate.slice(0, 10) : '—';
    var g = ctx.payload.graph;
    var prods = g.produced.filter(function(p) { return p.commitHash === c.hash; });
    var attrRows = prods.map(function(p) {
      var tier = p.confidence >= 0.8 ? 'strong' : 'weak';
      return row('session', '<span class="mono">' + esc(p.sessionId.slice(0, 16)) + '</span>') +
        row('confidence', esc(p.confidence.toFixed(3)) + ' <span style="color:var(--text-faint)">(' + esc(tier) + ')</span>') +
        row('via', esc(p.matchedVia)) +
        row('files', esc(String(p.fileCount)));
    }).join('<div class="sep"></div>');
    return '<h3>Commit</h3>' +
      row('hash', '<span class="mono">' + esc(c.hash.slice(0, 12)) + '</span>') +
      row('subject', esc(c.subject)) +
      row('date', esc(dateStr)) +
      row('merge', c.isMerge ? 'yes' : 'no') +
      (prods.length ? '<div class="sep"></div><h3>Attributions (' + prods.length + ')</h3>' + attrRows : '');
  }

  function fileHtml(d, ctx) {
    var f = d.data;
    var g = ctx.payload.graph;
    var commitCount = g.touches.filter(function(t) { return t.filePath === f.path; }).length;
    var sessCount = g.edited.filter(function(e) { return e.filePath === f.path; }).length;
    var parts = f.path.split('/');
    var name = parts[parts.length - 1] || f.path;
    return '<h3>File</h3>' +
      row('name', esc(name)) +
      row('path', '<span class="mono" style="font-size:11px">' + esc(f.path) + '</span>') +
      row('commits', esc(String(commitCount))) +
      row('sessions', esc(String(sessCount)));
  }

  function decisionHtml(d) {
    var n = d.data;
    var isSuperseded = n.invalidAt !== null;
    var validAt = n.validAt ? n.validAt.slice(0, 10) : '—';
    var kindColor = {'decision':'var(--amber)','constraint':'var(--blue)','rejected-approach':'var(--danger)'}[n.kind] || 'var(--text-dim)';
    return '<h3>Decision</h3>' +
      row('kind', '<span style="color:' + kindColor + '">' + esc(n.kind) + '</span>') +
      row('title', esc(n.title)) +
      (isSuperseded ? row('status', '<span style="color:var(--text-faint);font-style:italic">superseded ' + esc(n.invalidAt ? n.invalidAt.slice(0, 10) : '') + '</span>') : row('valid from', esc(validAt))) +
      '<div class="sep"></div>' +
      '<div class="quote">' + esc(n.body) + '</div>' +
      (n.files && n.files.length ? '<div class="sep"></div>' + row('files', n.files.map(function(fp) {
        var nm = fp.split('/').slice(-1)[0];
        return '<span class="mono" style="display:inline-block;margin:2px 4px 2px 0;padding:1px 6px;border:1px solid var(--border);border-radius:4px;font-size:11px">' + esc(nm) + '</span>';
      }).join('')) : '');
  }

  // ── 构建图数据集 ──────────────────────────────────────────────────────────
  function buildGraphData() {
    var ctx = _ctx;
    var g = ctx.payload.graph;
    var notes = ctx.payload.notes || [];

    // 可见 commit hash 集合
    var visibleCommitHashes = new Set();
    for (var ci = 0; ci < g.commits.length; ci++) {
      var c = g.commits[ci];
      if (!c) continue;
      if (_currentCutoff === null) {
        visibleCommitHashes.add(c.hash);
      } else {
        var cTime = +new Date(c.authorDate);
        if (!isNaN(cTime) && cTime <= _currentCutoff) visibleCommitHashes.add(c.hash);
      }
    }

    // 归因文件集合（文件密度过滤用）
    var attributedFileSet = new Set();
    var producedCommitSet = new Set();
    for (var pi = 0; pi < g.produced.length; pi++) {
      var p = g.produced[pi];
      if (p && visibleCommitHashes.has(p.commitHash)) producedCommitSet.add(p.commitHash);
    }
    for (var ti = 0; ti < g.touches.length; ti++) {
      var t = g.touches[ti];
      if (t && producedCommitSet.has(t.commitHash)) attributedFileSet.add(t.filePath);
    }

    // 活跃文件路径集
    var activeFilePaths = new Set();
    if (_showAllFiles || g.files.length <= MANY_FILES) {
      for (var fi = 0; fi < g.files.length; fi++) {
        var fNode = g.files[fi];
        if (fNode) activeFilePaths.add(fNode.path);
      }
    } else {
      attributedFileSet.forEach(function(p) { activeFilePaths.add(p); });
    }

    // 节点 map
    var nodeMap = new Map();

    for (var si = 0; si < g.sessions.length; si++) {
      var s = g.sessions[si];
      if (!s) continue;
      nodeMap.set('ses:' + s.id, { id: 'ses:' + s.id, type: 'session', data: s });
    }
    for (var ci2 = 0; ci2 < g.commits.length; ci2++) {
      var cm = g.commits[ci2];
      if (!cm || !visibleCommitHashes.has(cm.hash)) continue;
      nodeMap.set('cmt:' + cm.hash, { id: 'cmt:' + cm.hash, type: 'commit', data: cm });
    }
    for (var fi2 = 0; fi2 < g.files.length; fi2++) {
      var fn2 = g.files[fi2];
      if (!fn2 || !activeFilePaths.has(fn2.path)) continue;
      nodeMap.set('fil:' + fn2.path, { id: 'fil:' + fn2.path, type: 'file', data: fn2 });
    }
    for (var ni = 0; ni < notes.length; ni++) {
      var note = notes[ni];
      if (!note || !nodeMap.has('ses:' + note.sessionId)) continue;
      nodeMap.set('dec:' + note.id, { id: 'dec:' + note.id, type: 'decision', data: note });
    }

    // 边
    var links = [];
    for (var pi2 = 0; pi2 < g.produced.length; pi2++) {
      var prod = g.produced[pi2];
      if (!prod) continue;
      var src = nodeMap.get('ses:' + prod.sessionId);
      var tgt = nodeMap.get('cmt:' + prod.commitHash);
      if (src && tgt) links.push({ type: 'produced', source: src, target: tgt, data: prod });
    }
    for (var ti2 = 0; ti2 < g.touches.length; ti2++) {
      var tch = g.touches[ti2];
      if (!tch) continue;
      var tsrc = nodeMap.get('cmt:' + tch.commitHash);
      var ttgt = nodeMap.get('fil:' + tch.filePath);
      if (tsrc && ttgt) links.push({ type: 'touches', source: tsrc, target: ttgt, data: tch });
    }
    for (var ei = 0; ei < g.edited.length; ei++) {
      var ed = g.edited[ei];
      if (!ed) continue;
      var esrc = nodeMap.get('ses:' + ed.sessionId);
      var etgt = nodeMap.get('fil:' + ed.filePath);
      if (esrc && etgt) links.push({ type: 'edited', source: esrc, target: etgt, data: ed });
    }
    for (var ni2 = 0; ni2 < notes.length; ni2++) {
      var dn = notes[ni2];
      if (!dn) continue;
      var dsrc = nodeMap.get('ses:' + dn.sessionId);
      var dtgt = nodeMap.get('dec:' + dn.id);
      if (dsrc && dtgt) links.push({ type: 'decision', source: dsrc, target: dtgt, data: dn });
    }

    // 过滤孤立节点
    if (!_showIsolated) {
      var connected = new Set();
      for (var li = 0; li < links.length; li++) {
        var lk = links[li];
        if (lk) { connected.add(lk.source.id); connected.add(lk.target.id); }
      }
      nodeMap.forEach(function(node, id) {
        if (!connected.has(id) && node.type !== 'session') nodeMap.delete(id);
      });
      // 清理指向已删除节点的边
      links = links.filter(function(lk) {
        return lk && nodeMap.has(lk.source.id) && nodeMap.has(lk.target.id);
      });
    }

    return { nodes: Array.from(nodeMap.values()), links: links };
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  function rebuildGraph() {
    if (!_svg || !_ctx) return;

    var result = buildGraphData();
    var nodes = result.nodes;
    var links = result.links;

    // 保留旧位置（避免重跑时所有节点瞬移到中心）
    var posCache = new Map();
    if (_nodes) {
      for (var i = 0; i < _nodes.length; i++) {
        var old = _nodes[i];
        if (old && old.id != null) posCache.set(old.id, { x: old.x, y: old.y });
      }
    }
    for (var ni = 0; ni < nodes.length; ni++) {
      var n = nodes[ni];
      if (!n) continue;
      var cached = posCache.get(n.id);
      if (cached) { n.x = cached.x; n.y = cached.y; }
    }

    _nodes = nodes;
    _links = links;
    _hasAutoFitted = false;

    // 停旧仿真
    if (_simulation) _simulation.stop();

    _linkLayer.selectAll('*').remove();
    _nodeLayer.selectAll('*').remove();

    var emptyEl = document.getElementById('vg-empty');

    if (!nodes.length) {
      if (emptyEl) emptyEl.classList.add('visible');
      return;
    }
    if (emptyEl) emptyEl.classList.remove('visible');

    // ── 更新渐变（重建后重新读取 CSS 变量值）──────────────────────────────
    var defs = _svg.select('defs');
    defs.select('#vg-grad-produced').remove();
    var grad = defs.append('linearGradient')
      .attr('id', 'vg-grad-produced')
      .attr('gradientUnits', 'userSpaceOnUse');
    grad.append('stop').attr('offset', '0%').attr('stop-color', cssVar('--blue'));
    grad.append('stop').attr('offset', '100%').attr('stop-color', cssVar('--green'));

    // ── 边 ──────────────────────────────────────────────────────────────────
    var linkSel = _linkLayer.selectAll('path.vg-link')
      .data(links, function(d) { return d.type + '|' + d.source.id + '|' + d.target.id; })
      .join('path')
      .attr('class', function(d) { return 'vg-link vg-link-' + d.type; })
      .attr('fill', 'none')
      .attr('stroke', function(d) {
        if (d.type === 'produced') return 'url(#vg-grad-produced)';
        if (d.type === 'touches') return cssVar('--border-strong');
        if (d.type === 'edited') return cssVar('--gray-node');
        return cssVar('--amber');  // decision
      })
      .attr('stroke-opacity', function(d) {
        if (d.type === 'produced') return 0.75;
        if (d.type === 'touches') return 0.35;
        if (d.type === 'edited') return 0.5;
        return 0.45;
      })
      .attr('stroke-width', function(d) {
        if (d.type === 'produced') {
          var conf = (d.data && d.data.confidence) ? d.data.confidence : 0.5;
          return Math.max(1, conf * 4.5);
        }
        return 1;
      })
      .attr('stroke-dasharray', function(d) {
        if (d.type === 'edited') return '4 3';
        if (d.type === 'decision') return '3 3';
        return null;
      })
      .style('pointer-events', 'none');

    _linkSel = linkSel;

    // ── 节点 ──────────────────────────────────────────────────────────────────
    var nodeSel = _nodeLayer.selectAll('g.vg-node')
      .data(nodes, function(d) { return d.id; })
      .join('g')
      .attr('class', function(d) { return 'vg-node vg-node-' + d.type; })
      .style('cursor', 'pointer')
      .call(
        d3.drag()
          .on('start', function(event, d) {
            if (!event.active) _simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', function(event, d) { d.fx = event.x; d.fy = event.y; })
          .on('end', function(event, d) {
            if (!event.active) _simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          })
      )
      .on('mouseenter', function(event, d) {
        // focus 交互：一阶邻域高亮，其余压暗
        var neighbors = new Set([d.id]);
        for (var li = 0; li < _links.length; li++) {
          var lk = _links[li];
          if (!lk) continue;
          if (lk.source.id === d.id) neighbors.add(lk.target.id);
          if (lk.target.id === d.id) neighbors.add(lk.source.id);
        }
        nodeSel.style('opacity', function(n) { return neighbors.has(n.id) ? 1 : 0.15; });
        linkSel.style('opacity', function(lk) {
          if (!lk) return 0;
          return (lk.source.id === d.id || lk.target.id === d.id) ? 1 : 0.06;
        });
        // halo 放大
        d3.select(this).select('.vg-halo').transition().duration(160).attr('r', 20);
      })
      .on('mouseleave', function() {
        // 仅在未选中时恢复
        if (!_selectedId) {
          nodeSel.style('opacity', 1);
          linkSel.style('opacity', null);
        }
        d3.select(this).select('.vg-halo').transition().duration(160).attr('r', 16);
      })
      .on('click', function(event, d) {
        event.stopPropagation();
        _selectedId = d.id;

        // focus 交互：选中时保持邻域高亮
        var neighbors = new Set([d.id]);
        for (var li = 0; li < _links.length; li++) {
          var lk = _links[li];
          if (!lk) continue;
          if (lk.source.id === d.id) neighbors.add(lk.target.id);
          if (lk.target.id === d.id) neighbors.add(lk.source.id);
        }
        nodeSel.style('opacity', function(n) { return neighbors.has(n.id) ? 1 : 0.15; });
        linkSel.style('opacity', function(lk) {
          if (!lk) return 0;
          return (lk.source.id === d.id || lk.target.id === d.id) ? 1 : 0.06;
        });

        // 选中描边
        nodeSel.classed('vg-node-selected', function(n) { return n.id === d.id; });

        // 详情
        if (d.type === 'session') _ctx.drawer.show(sessionHtml(d, _ctx));
        else if (d.type === 'commit') _ctx.drawer.show(commitHtml(d, _ctx));
        else if (d.type === 'file') _ctx.drawer.show(fileHtml(d, _ctx));
        else if (d.type === 'decision') _ctx.drawer.show(decisionHtml(d));
      });

    // 背景点击取消选中
    _svg.on('click.vg-deselect', function() {
      _selectedId = null;
      nodeSel.style('opacity', 1).classed('vg-node-selected', false);
      linkSel.style('opacity', null);
      _ctx.drawer.hide();
    });

    // ── 节点形状 ──────────────────────────────────────────────────────────────
    // Session：蓝实心圆 + halo 外环
    var sessionNodes = nodeSel.filter(function(d) { return d.type === 'session'; });
    sessionNodes.append('circle')
      .attr('class', 'vg-halo')
      .attr('r', 16)
      .attr('fill', 'none')
      .attr('stroke', cssVar('--blue'))
      .attr('stroke-opacity', 0.28)
      .attr('stroke-width', 2)
      .style('transition', 'r 160ms cubic-bezier(0.22,1,0.36,1)');
    sessionNodes.append('circle')
      .attr('class', 'vg-node-shape')
      .attr('r', 10)
      .attr('fill', cssVar('--blue'))
      .attr('stroke', cssVar('--blue'))
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', 1.5);

    // Commit：ctx.commitColor 圆角方块
    var commitNodes = nodeSel.filter(function(d) { return d.type === 'commit'; });
    commitNodes.append('rect')
      .attr('class', 'vg-node-shape')
      .attr('x', -8).attr('y', -8).attr('width', 16).attr('height', 16)
      .attr('rx', 3).attr('ry', 3)
      .attr('fill', function(d) {
        var dateMs = +new Date(d.data.authorDate);
        return isNaN(dateMs) ? cssVar('--commit-new') : _ctx.commitColor(dateMs);
      })
      .attr('stroke', 'none');

    // File：--gray-node 小圆（3px 描边风格）
    var fileNodes = nodeSel.filter(function(d) { return d.type === 'file'; });
    fileNodes.append('circle')
      .attr('class', 'vg-node-shape')
      .attr('r', 4)
      .attr('fill', cssVar('--gray-node'))
      .attr('fill-opacity', 0.7)
      .attr('stroke', cssVar('--border-strong'))
      .attr('stroke-width', 1.5);

    // Decision：--amber 菱形
    var decisionNodes = nodeSel.filter(function(d) { return d.type === 'decision'; });
    decisionNodes.append('polygon')
      .attr('class', 'vg-node-shape')
      .attr('points', '0,-10 10,0 0,10 -10,0')
      .attr('fill', cssVar('--amber'))
      .attr('fill-opacity', function(d) { return d.data.invalidAt ? 0.4 : 0.9; })
      .attr('stroke', cssVar('--amber'))
      .attr('stroke-opacity', function(d) { return d.data.invalidAt ? 0.3 : 0.6; })
      .attr('stroke-width', 1);

    // ── 标签（缩放级别控制）──────────────────────────────────────────────────
    // Session 标签：始终显示
    sessionNodes.append('text')
      .attr('class', 'vg-label vg-label-session')
      .attr('dy', 24)
      .attr('text-anchor', 'middle')
      .attr('fill', cssVar('--text-dim'))
      .attr('font-size', '9')
      .attr('font-family', 'ui-monospace, "SF Mono", Menlo, monospace')
      .attr('pointer-events', 'none')
      .attr('user-select', 'none')
      .text(function(d) { return d.data.id.slice(0, 8); });

    // Commit 标签：由 zoom 层级控制
    commitNodes.append('text')
      .attr('class', 'vg-label vg-label-commit')
      .attr('dy', 19)
      .attr('text-anchor', 'middle')
      .attr('fill', cssVar('--text-faint'))
      .attr('font-size', '8')
      .attr('font-family', 'ui-monospace, "SF Mono", Menlo, monospace')
      .attr('pointer-events', 'none')
      .attr('user-select', 'none')
      .text(function(d) { return d.data.hash.slice(0, 7); });

    _nodeSel = nodeSel;

    // ── 力仿真 ────────────────────────────────────────────────────────────────
    _simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links)
        .id(function(d) { return d.id; })
        .distance(function(d) {
          if (d.type === 'produced') return 110;
          if (d.type === 'touches') return 65;
          if (d.type === 'edited') return 95;
          return 55;
        })
        .strength(function(d) {
          if (d.type === 'produced') return 0.55;
          if (d.type === 'touches') return 0.25;
          return 0.3;
        })
      )
      .force('charge', d3.forceManyBody().strength(function(d) {
        if (d.type === 'session') return -160;
        if (d.type === 'commit') return -80;
        if (d.type === 'file') return -25;
        return -40;
      }))
      .force('center', d3.forceCenter(_width / 2, _height / 2).strength(0.08))
      .force('collision', d3.forceCollide().radius(function(d) {
        if (d.type === 'session') return 20;
        if (d.type === 'commit') return 14;
        if (d.type === 'file') return 8;
        return 14;
      }))
      .on('tick', function() {
        // 曲线边
        if (_linkSel) {
          _linkSel.attr('d', function(d) {
            // 更新渐变端点（让渐变跟着边走）
            if (d.type === 'produced') {
              var gradEl = document.getElementById('vg-grad-produced');
              if (gradEl && d.source && d.target) {
                gradEl.setAttribute('x1', String(d.source.x || 0));
                gradEl.setAttribute('y1', String(d.source.y || 0));
                gradEl.setAttribute('x2', String(d.target.x || 0));
                gradEl.setAttribute('y2', String(d.target.y || 0));
              }
            }
            return curvePath(d);
          });
        }
        if (_nodeSel) _nodeSel.attr('transform', function(d) { return 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')'; });
        if (!_hasAutoFitted && _simulation && _simulation.alpha() < 0.1) {
          _hasAutoFitted = true;
          zoomToFit(_nodes);
        }
      })
      .on('end', function() {
        if (!_hasAutoFitted) { _hasAutoFitted = true; zoomToFit(_nodes); }
      });
  }

  // ── onTimeline 实现（淡出未来节点，松手后防抖重建）────────────────────────
  function applyTimeline(cutoffMs) {
    _currentCutoff = cutoffMs;

    if (_nodeSel && _linkSel && _nodes.length) {
      // 即时淡出：不重建 DOM，只改 opacity
      var g = _ctx.payload.graph;
      var visibleHashes = new Set();
      for (var ci = 0; ci < g.commits.length; ci++) {
        var cm = g.commits[ci];
        if (!cm) continue;
        if (cutoffMs === null) { visibleHashes.add(cm.hash); continue; }
        var cTime = +new Date(cm.authorDate);
        if (!isNaN(cTime) && cTime <= cutoffMs) visibleHashes.add(cm.hash);
      }
      _nodeSel.style('opacity', function(d) {
        if (cutoffMs === null) return 1;
        if (d.type === 'commit') return visibleHashes.has(d.data.hash) ? 1 : 0.07;
        if (d.type === 'file') return 1;  // 文件不随时间淡出
        return 1;
      }).style('pointer-events', function(d) {
        if (cutoffMs !== null && d.type === 'commit' && !visibleHashes.has(d.data.hash)) return 'none';
        return null;
      });
      _linkSel.style('opacity', function(d) {
        if (cutoffMs === null) return null;
        if (d.type === 'produced') {
          var tgt = d.target;
          if (tgt && tgt.type === 'commit' && !visibleHashes.has(tgt.data.hash)) return 0.06;
        }
        if (d.type === 'touches') {
          var src = d.source;
          if (src && src.type === 'commit' && !visibleHashes.has(src.data.hash)) return 0.06;
        }
        return null;
      });
    }

    // 防抖：松手 TIMELINE_DEBOUNCE_MS 后重跑仿真
    if (_timelineTimer) clearTimeout(_timelineTimer);
    _timelineTimer = setTimeout(function() {
      _timelineTimer = null;
      rebuildGraph();
    }, TIMELINE_DEBOUNCE_MS);
  }

  // ── mount ─────────────────────────────────────────────────────────────────
  function mount(el, ctx) {
    _el = el;
    _ctx = ctx;
    var g = ctx.payload.graph;

    // 顶层控制
    var controls = document.createElement('div');
    controls.id = 'vg-controls';
    el.appendChild(controls);

    // Show all files（仅 >300 时出现）
    if (g.files.length > MANY_FILES) {
      var fileBtn = document.createElement('button');
      fileBtn.className = 'btn';
      fileBtn.textContent = 'Show all files';
      fileBtn.addEventListener('click', function() {
        _showAllFiles = !_showAllFiles;
        fileBtn.classList.toggle('active', _showAllFiles);
        fileBtn.textContent = _showAllFiles ? 'Hide extra files' : 'Show all files';
        _hasAutoFitted = false;
        rebuildGraph();
      });
      controls.appendChild(fileBtn);
    }

    // Show unlinked commits
    var isolatedBtn = document.createElement('button');
    isolatedBtn.className = 'btn';
    isolatedBtn.textContent = 'Show unlinked commits';
    isolatedBtn.addEventListener('click', function() {
      _showIsolated = !_showIsolated;
      isolatedBtn.classList.toggle('active', _showIsolated);
      isolatedBtn.textContent = _showIsolated ? 'Hide unlinked commits' : 'Show unlinked commits';
      _hasAutoFitted = false;
      rebuildGraph();
    });
    controls.appendChild(isolatedBtn);

    // 图例
    var legendEl = document.createElement('div');
    legendEl.id = 'vg-legend';
    legendEl.className = 'glass';
    legendEl.innerHTML =
      '<div class="vg-legend-item"><span class="vg-legend-dot" style="background:var(--blue)"></span>Session</div>' +
      '<div class="vg-legend-item"><span class="vg-legend-rect"></span>Commit (color = age)</div>' +
      '<div class="vg-legend-item"><span class="vg-legend-dot" style="background:var(--gray-node)"></span>File</div>' +
      '<div class="vg-legend-item"><span class="vg-legend-diamond"></span>Decision</div>' +
      '<div class="vg-legend-item"><span class="vg-legend-line"></span>PRODUCED (width = confidence)</div>';
    el.appendChild(legendEl);

    // 空态
    var emptyEl = document.createElement('div');
    emptyEl.id = 'vg-empty';
    emptyEl.textContent = 'no graph data available';
    el.appendChild(emptyEl);

    // SVG
    var svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.id = 'vg-canvas';
    el.appendChild(svgEl);

    _svg = d3.select(svgEl);
    _width = el.clientWidth || 900;
    _height = el.clientHeight || 600;

    ensureDefs(_svg);

    // zoom
    _zoomG = _svg.append('g').attr('class', 'vg-zoom-layer');
    _zoomBehavior = d3.zoom()
      .scaleExtent([0.04, 8])
      .on('zoom', function(e) {
        _zoomG.attr('transform', e.transform);
        // commit/file 标签降噪
        var k = e.transform.k;
        _zoomG.selectAll('.vg-label-commit, .vg-label-file')
          .style('display', k <= LABEL_HIDE_SCALE ? 'none' : null);
      });
    _svg.call(_zoomBehavior);
    _zoomG.selectAll('.vg-label-commit, .vg-label-file').style('display', 'none');

    _linkLayer = _zoomG.append('g').attr('class', 'vg-links');
    _nodeLayer = _zoomG.append('g').attr('class', 'vg-nodes');

    _currentCutoff = ctx.cutoffMs;
    rebuildGraph();
  }

  function onTimeline(cutoffMs) {
    applyTimeline(cutoffMs);
  }

  function onResize() {
    if (!_el || !_svg) return;
    _width = _el.clientWidth || 900;
    _height = _el.clientHeight || 600;
    if (_simulation) {
      _simulation.force('center', d3.forceCenter(_width / 2, _height / 2).strength(0.08));
    }
  }

  function onShow() {
    // 进入视图时若 canvas 尺寸已就绪但仿真未运行，kickstart
    if (_el && !_simulation && _nodes.length === 0) rebuildGraph();
    onResize();
  }

  window.LORE_VIEWS.push({
    id: 'graph',
    label: 'Graph',
    mount: mount,
    onTimeline: onTimeline,
    onResize: onResize,
    onShow: onShow,
  });
})();
`;
