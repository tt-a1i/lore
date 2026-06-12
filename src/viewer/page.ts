/**
 * page.ts — single-file HTML export for `lore serve`.
 *
 * D3 v7 via CDN; graceful degradation when offline.
 * Contains full force-directed graph with:
 *   - Session (circle/brand), Commit (rect/time-depth), File (small circle/grey)
 *   - Decision nodes (diamond) from notes, hung on Sessions
 *   - PRODUCED edges (width ∝ confidence), TOUCHES (thin), EDITED (dashed)
 *   - Click → right-side detail panel
 *   - Bottom timeline slider (commit time range), play button
 *   - File node density toggle (>300 files: only show attributed ones)
 *   - Zoom, pan, drag
 */

export function buildPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lore — graph viewer</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #0d1117; color: #c9d1d9; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px; }

  #app { display: flex; flex-direction: column; height: 100vh; }

  #toolbar {
    display: flex; align-items: center; gap: 12px; padding: 6px 14px;
    background: #161b22; border-bottom: 1px solid #30363d; flex-shrink: 0;
  }
  #toolbar h1 { margin: 0; font-size: 15px; font-weight: 600; color: #e6edf3; }
  #toolbar .tag { background: #21262d; border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #8b949e; }

  #main { display: flex; flex: 1; min-height: 0; }

  #graph-area { flex: 1; position: relative; overflow: hidden; }
  svg#graph { width: 100%; height: 100%; display: block; }

  /* nodes */
  .node-session circle { fill: #388bfd; stroke: #58a6ff; stroke-width: 1.5; cursor: pointer; transition: opacity .2s; }
  .node-session circle:hover { fill: #58a6ff; }
  .node-commit rect { fill: #3fb950; stroke: #56d364; stroke-width: 1; cursor: pointer; transition: opacity .2s; }
  .node-commit rect:hover { fill: #56d364; }
  .node-file circle { fill: #555; stroke: #888; stroke-width: 1; cursor: pointer; }
  .node-file circle:hover { fill: #888; }
  .node-decision polygon { fill: #d2a679; stroke: #f0b27a; stroke-width: 1.5; cursor: pointer; }
  .node-decision polygon:hover { fill: #f0b27a; }

  /* 缩小视图时隐藏 commit/file 标签，只留 session 标签做地标 */
  .zoom-layer.zoomed-out .node-commit .node-label,
  .zoom-layer.zoomed-out .node-file .node-label { display: none; }
  #legend {
    position: absolute; left: 12px; bottom: 56px; z-index: 5;
    background: #161b22cc; border: 1px solid #30363d; border-radius: 8px;
    padding: 8px 12px; font-size: 11px; color: #8b949e; line-height: 20px;
    backdrop-filter: blur(4px);
  }
  #legend .sw { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; }
  .node-label {
    fill: #c9d1d9; font-size: 9px; pointer-events: none; user-select: none;
    text-shadow: 0 1px 2px #0008;
  }

  /* edges */
  .link-produced { stroke: #388bfd; stroke-opacity: .7; }
  .link-touches { stroke: #3fb950; stroke-opacity: .4; stroke-width: 1; }
  .link-edited { stroke: #8b949e; stroke-opacity: .5; stroke-dasharray: 4 3; stroke-width: 1; }
  .link-decision { stroke: #d2a679; stroke-opacity: .4; stroke-dasharray: 3 3; stroke-width: 1; }
  .link-faded { opacity: 0.08 !important; }

  /* detail panel */
  #detail {
    width: 300px; flex-shrink: 0; background: #161b22; border-left: 1px solid #30363d;
    overflow-y: auto; padding: 14px; transition: width .2s;
  }
  #detail.empty { display: flex; align-items: center; justify-content: center; color: #555; font-size: 12px; }
  #detail h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #e6edf3; }
  #detail .row { margin: 4px 0; line-height: 1.5; word-break: break-all; }
  #detail .label { color: #8b949e; font-size: 11px; display: inline-block; width: 90px; }
  #detail .val { color: #c9d1d9; }
  #detail .badge {
    display: inline-block; background: #21262d; border: 1px solid #30363d;
    border-radius: 3px; padding: 1px 5px; font-size: 10px; margin: 2px;
  }
  #detail .attr-item { border-top: 1px solid #21262d; padding-top: 6px; margin-top: 6px; }
  #detail .superseded { opacity: 0.5; font-style: italic; }

  /* timeline */
  #timeline {
    background: #161b22; border-top: 1px solid #30363d; padding: 8px 14px;
    display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  }
  #timeline label { color: #8b949e; font-size: 11px; white-space: nowrap; }
  #time-slider { flex: 1; accent-color: #388bfd; cursor: pointer; }
  #time-display { color: #c9d1d9; font-size: 11px; white-space: nowrap; min-width: 160px; }
  #play-btn {
    background: #21262d; border: 1px solid #30363d; border-radius: 4px;
    color: #c9d1d9; cursor: pointer; padding: 3px 10px; font-size: 11px;
  }
  #play-btn:hover { background: #30363d; }

  #isolated-toggle {
    background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
    border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  #isolated-toggle:hover { background: #30363d; }
  #isolated-toggle.active { border-color: #388bfd; color: #388bfd; }
  #file-toggle {
    background: #21262d; border: 1px solid #30363d; border-radius: 4px;
    color: #8b949e; cursor: pointer; padding: 3px 10px; font-size: 11px;
  }
  #file-toggle:hover { background: #30363d; }
  #file-toggle.active { border-color: #388bfd; color: #388bfd; }

  #cdn-error {
    display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    background: #2d1b18; border: 1px solid #f85149; border-radius: 6px;
    padding: 16px 24px; text-align: center; color: #f85149; max-width: 400px;
  }

  #loading {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    color: #8b949e; font-size: 14px;
  }
</style>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <h1>lore</h1>
    <span class="tag" id="repo-tag">loading…</span>
    <span class="tag" id="stats-tag"></span>
    <span style="flex:1"></span>
    <button id="file-toggle">Show all files</button>
    <button id="isolated-toggle">Show unlinked commits</button>
  </div>
  <div id="main">
    <div id="graph-area">
      <div id="cdn-error">
        <strong>D3 CDN unavailable.</strong><br>
        Check your internet connection or serve D3 locally.
      </div>
      <div id="loading">Loading graph…</div>
      <svg id="graph"></svg>
      <div id="legend">
        <div><span class="sw" style="background:#58a6ff;border-radius:50%"></span>Session</div>
        <div><span class="sw" style="background:#56d364;border-radius:2px"></span>Commit（颜色越深越早）</div>
        <div><span class="sw" style="background:#8b949e;border-radius:50%;width:7px;height:7px"></span>File</div>
        <div><span class="sw" style="background:#d29922;transform:rotate(45deg)"></span>Decision（半透明=已被推翻）</div>
        <div><span class="sw" style="background:none;border-top:2px solid #58a6ff;height:0;vertical-align:3px"></span>PRODUCED（粗细∝置信度）</div>
      </div>
    </div>
    <div id="detail" class="empty">Click a node to inspect it</div>
  </div>
  <div id="timeline">
    <label>Timeline:</label>
    <input type="range" id="time-slider" min="0" max="100" value="100" step="1">
    <span id="time-display">—</span>
    <button id="play-btn">▶ Play</button>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/d3@7" crossorigin="anonymous" onerror="showCdnError()"></script>
<script>
function showCdnError() {
  document.getElementById('cdn-error').style.display = 'block';
  document.getElementById('loading').style.display = 'none';
}

// ── Data fetching ─────────────────────────────────────────────────────────────
async function fetchPayload() {
  const res = await fetch('/api/payload');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  let payload;
  try {
    payload = await fetchPayload();
  } catch (e) {
    document.getElementById('loading').textContent = 'Error loading payload: ' + e.message;
    return;
  }
  if (typeof d3 === 'undefined') { showCdnError(); return; }
  document.getElementById('loading').style.display = 'none';
  initGraph(payload);
});

function initGraph(payload) {
  const graph = payload.graph;
  const notes = payload.notes || [];
  const repo = payload.repo || '';
  const timeRange = payload.timeRange;

  // ── Stats ────────────────────────────────────────────────────────────────────
  document.getElementById('repo-tag').textContent = repo.split('/').slice(-1)[0] || repo;
  document.getElementById('stats-tag').textContent =
    'S:' + graph.sessions.length + ' C:' + graph.commits.length + ' F:' + graph.files.length;

  // ── Commit time index ─────────────────────────────────────────────────────────
  const commitDateMap = new Map(); // hash → Date
  for (const c of graph.commits) commitDateMap.set(c.hash, new Date(c.authorDate));

  const allDates = graph.commits.map(c => new Date(c.authorDate)).filter(d => !isNaN(d));
  const minDate = allDates.length ? new Date(Math.min(...allDates)) : null;
  const maxDate = allDates.length ? new Date(Math.max(...allDates)) : null;

  // ── File density toggle ───────────────────────────────────────────────────────
  const MANY_FILES = 300;
  let showAllFiles = graph.files.length <= MANY_FILES;
  const fileToggleBtn = document.getElementById('file-toggle');
  if (graph.files.length <= MANY_FILES) {
    fileToggleBtn.style.display = 'none';
  } else {
    fileToggleBtn.classList.toggle('active', showAllFiles);
    fileToggleBtn.addEventListener('click', () => {
      showAllFiles = !showAllFiles;
      fileToggleBtn.classList.toggle('active', showAllFiles);
      fileToggleBtn.textContent = showAllFiles ? 'Hide extra files' : 'Show all files';
      rebuildGraph();
    });
  }

  // ── Isolated-node toggle（默认隐藏无边孤点）───────────────────────────────────
  let showIsolated = false;
  const isolatedToggleBtn = document.getElementById('isolated-toggle');
  isolatedToggleBtn.addEventListener('click', () => {
    showIsolated = !showIsolated;
    isolatedToggleBtn.classList.toggle('active', showIsolated);
    isolatedToggleBtn.textContent = showIsolated ? 'Hide unlinked commits' : 'Show unlinked commits';
    hasAutoFitted = false; // 重新自适应
    rebuildGraph();
  });

  // Attributed file paths (touched by a commit that has a PRODUCED edge)
  const attributedFileSet = new Set();
  const producedCommitSet = new Set(graph.produced.map(p => p.commitHash));
  for (const t of graph.touches) {
    if (producedCommitSet.has(t.commitHash)) attributedFileSet.add(t.filePath);
  }

  // ── SVG setup ─────────────────────────────────────────────────────────────────
  const svg = d3.select('#graph');
  const width = svg.node().clientWidth || 900;
  const height = svg.node().clientHeight || 600;

  const zoomG = svg.append('g').attr('class', 'zoom-layer');
  // 标签降噪：缩放级别低于阈值时隐藏 commit 标签（726 个 hash 全显是噪音）。
  const zoomBehavior = d3.zoom().scaleExtent([0.05, 5]).on('zoom', e => {
    zoomG.attr('transform', e.transform);
    zoomG.classed('zoomed-out', e.transform.k <= 1.1);
  });
  svg.call(zoomBehavior);
  zoomG.classed('zoomed-out', true);

  /**
   * 布局稳定后把图缩放平移到视口内。
   * 用 5–95 分位边界而非 min/max：没有可见边的孤立节点会被斥力甩到极远处，
   * min/max 会让主簇缩成一个点。
   */
  function zoomToFit(nodes) {
    if (!nodes.length) return;
    const xs = nodes.map(n => n.x).sort((a, b) => a - b);
    const ys = nodes.map(n => n.y).sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];
    const x0 = q(xs, 0.05), x1 = q(xs, 0.95), y0 = q(ys, 0.05), y1 = q(ys, 0.95);
    const pad = 60;
    const k = Math.min(2.5, 0.95 * Math.min(width / (x1 - x0 + pad * 2), height / (y1 - y0 + pad * 2)));
    const tx = width / 2 - k * (x0 + x1) / 2;
    const ty = height / 2 - k * (y0 + y1) / 2;
    svg.transition().duration(450).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }

  const linkLayer = zoomG.append('g').attr('class', 'links');
  const nodeLayer = zoomG.append('g').attr('class', 'nodes');

  // ── Detail panel ──────────────────────────────────────────────────────────────
  const detail = document.getElementById('detail');
  let selectedId = null;

  function showDetail(html) {
    detail.classList.remove('empty');
    detail.innerHTML = html;
  }
  function clearDetail() {
    detail.classList.add('empty');
    detail.innerHTML = 'Click a node to inspect it';
    selectedId = null;
  }

  function row(label, val) {
    return '<div class="row"><span class="label">' + label + '</span><span class="val">' + val + '</span></div>';
  }

  function sessionDetail(d) {
    const s = d.data;
    const sourceCount = (s.sourcePaths || []).length;
    const startStr = s.startedAt ? s.startedAt.slice(0, 16).replace('T', ' ') : '—';
    const endStr = s.endedAt ? s.endedAt.slice(0, 16).replace('T', ' ') : 'ongoing';
    return '<h2>Session</h2>' +
      row('id', s.id.slice(0, 20) + (s.id.length > 20 ? '…' : '')) +
      row('agent', s.agent) +
      row('started', startStr) +
      row('ended', endStr) +
      row('branch', s.gitBranch || '—') +
      row('cwd', s.cwd ? '…' + s.cwd.slice(-30) : '—') +
      row('sources', sourceCount + ' file(s)');
  }

  function commitDetail(d) {
    const c = d.data;
    const dateStr = c.authorDate ? c.authorDate.slice(0, 10) : '—';
    const prods = graph.produced.filter(p => p.commitHash === c.hash);
    let attrHtml = '';
    for (const p of prods) {
      const tier = p.confidence >= 0.8 ? 'strong' : 'weak';
      attrHtml += '<div class="attr-item">' +
        row('session', p.sessionId.slice(0, 16) + '…') +
        row('confidence', p.confidence.toFixed(3) + ' (' + tier + ')') +
        row('via', p.matchedVia) +
        '</div>';
    }
    return '<h2>Commit</h2>' +
      row('hash', c.hash.slice(0, 12)) +
      row('subject', c.subject) +
      row('date', dateStr) +
      row('merge', c.isMerge ? 'yes' : 'no') +
      (attrHtml ? '<div style="margin-top:8px;font-size:11px;color:#8b949e">Attributions</div>' + attrHtml : '');
  }

  function fileDetail(d) {
    const f = d.data;
    const commitCount = graph.touches.filter(t => t.filePath === f.path).length;
    return '<h2>File</h2>' +
      row('path', f.path) +
      row('commits', commitCount);
  }

  function decisionDetail(d) {
    const n = d.data;
    const isSuperseded = n.invalidAt !== null;
    return '<h2>Decision</h2>' +
      (isSuperseded ? '<div class="superseded">Superseded ' + n.invalidAt.slice(0, 10) + '</div>' : '') +
      row('kind', n.kind) +
      '<div class="row"><span class="label">title</span><span class="val">' + n.title + '</span></div>' +
      '<div class="row" style="margin-top:6px"><span style="color:#8b949e;font-size:11px">body</span></div>' +
      '<div style="color:#c9d1d9;font-size:11px;margin-top:4px;line-height:1.5">' + n.body + '</div>' +
      (n.files.length ? '<div class="row" style="margin-top:6px">' + n.files.map(f => '<span class="badge">' + f.split('/').slice(-1)[0] + '</span>').join('') + '</div>' : '');
  }

  // ── Build node/edge sets based on current time cursor ────────────────────────
  let currentCutoff = maxDate; // null = no filter

  function getVisibleCommitHashes() {
    if (!currentCutoff) return new Set(graph.commits.map(c => c.hash));
    const s = new Set();
    for (const c of graph.commits) {
      if (commitDateMap.get(c.hash) <= currentCutoff) s.add(c.hash);
    }
    return s;
  }

  // ── Force simulation ──────────────────────────────────────────────────────────
  let simulation = null;

  function rebuildGraph() {
    // Clear old elements
    linkLayer.selectAll('*').remove();
    nodeLayer.selectAll('*').remove();
    if (simulation) simulation.stop();

    const visibleCommitHashes = getVisibleCommitHashes();

    // Filter files by density toggle
    const activeFilePaths = new Set();
    if (showAllFiles) {
      graph.files.forEach(f => activeFilePaths.add(f.path));
    } else {
      attributedFileSet.forEach(p => activeFilePaths.add(p));
    }

    // Build node list
    const nodeMap = new Map(); // id → node obj

    // Sessions — always visible
    for (const s of graph.sessions) {
      const n = { id: 'ses:' + s.id, type: 'session', data: s };
      nodeMap.set(n.id, n);
    }

    // Commits — visible if in time window
    for (const c of graph.commits) {
      if (!visibleCommitHashes.has(c.hash)) continue;
      const n = { id: 'cmt:' + c.hash, type: 'commit', data: c };
      nodeMap.set(n.id, n);
    }

    // Files — conditionally shown
    for (const f of graph.files) {
      if (!activeFilePaths.has(f.path)) continue;
      const n = { id: 'fil:' + f.path, type: 'file', data: f };
      nodeMap.set(n.id, n);
    }

    // Decision nodes from notes — hung off session nodes
    for (const note of notes) {
      const sesKey = 'ses:' + note.sessionId;
      if (!nodeMap.has(sesKey)) continue; // session not visible
      const n = { id: 'dec:' + note.id, type: 'decision', data: note };
      nodeMap.set(n.id, n);
    }

    // Build edge list
    const links = [];

    // PRODUCED edges
    for (const p of graph.produced) {
      const src = nodeMap.get('ses:' + p.sessionId);
      const tgt = nodeMap.get('cmt:' + p.commitHash);
      if (src && tgt) {
        links.push({ type: 'produced', source: src, target: tgt, data: p });
      }
    }

    // TOUCHES edges
    for (const t of graph.touches) {
      const src = nodeMap.get('cmt:' + t.commitHash);
      const tgt = nodeMap.get('fil:' + t.filePath);
      if (src && tgt) {
        links.push({ type: 'touches', source: src, target: tgt, data: t });
      }
    }

    // EDITED edges (Session → File)
    for (const e of graph.edited) {
      const src = nodeMap.get('ses:' + e.sessionId);
      const tgt = nodeMap.get('fil:' + e.filePath);
      if (src && tgt) {
        links.push({ type: 'edited', source: src, target: tgt, data: e });
      }
    }

    // Decision → Session links (dashed anchor)
    for (const note of notes) {
      const src = nodeMap.get('ses:' + note.sessionId);
      const tgt = nodeMap.get('dec:' + note.id);
      if (src && tgt) {
        links.push({ type: 'decision', source: src, target: tgt, data: note });
      }
    }

    // 默认只看"有故事"的子图：无任何边的孤立节点（多为未归因 commit）
    // 会被斥力推成星环噪音。showIsolated 开关收纳它们。
    if (!showIsolated) {
      const connected = new Set();
      for (const l of links) { connected.add(l.source.id); connected.add(l.target.id); }
      for (const [id, n] of nodeMap) {
        if (!connected.has(id) && n.type !== 'session') nodeMap.delete(id);
      }
      for (let i = links.length - 1; i >= 0; i--) {
        const l = links[i];
        if (!nodeMap.has(l.source.id) || !nodeMap.has(l.target.id)) links.splice(i, 1);
      }
    }

    const nodes = Array.from(nodeMap.values());

    // ── Commit color by time ───────────────────────────────────────────────────
    const dateExtent = d3.extent(
      Array.from(visibleCommitHashes),
      h => commitDateMap.get(h)
    );
    const timeColor = (dateExtent[0] && dateExtent[1])
      ? d3.scaleTime().domain(dateExtent).range(['#1f4a28', '#56d364'])
      : () => '#3fb950';

    // ── Render edges ─────────────────────────────────────────────────────────────
    const linkSel = linkLayer.selectAll('line.link')
      .data(links)
      .join('line')
      .attr('class', d => 'link link-' + d.type)
      .attr('stroke-width', d => {
        if (d.type === 'produced') return Math.max(1, d.data.confidence * 5);
        return 1;
      });

    // ── Render nodes ──────────────────────────────────────────────────────────────
    const nodeSel = nodeLayer.selectAll('g.node')
      .data(nodes, d => d.id)
      .join('g')
      .attr('class', d => 'node node-' + d.type)
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
      )
      .on('click', (event, d) => {
        event.stopPropagation();
        selectedId = d.id;
        // Fade unconnected nodes
        const connected = new Set([d.id]);
        links.forEach(l => {
          if (l.source.id === d.id) connected.add(l.target.id);
          if (l.target.id === d.id) connected.add(l.source.id);
        });
        nodeSel.classed('link-faded', n => !connected.has(n.id));
        linkSel.classed('link-faded', l => l.source.id !== d.id && l.target.id !== d.id);

        if (d.type === 'session') showDetail(sessionDetail(d));
        else if (d.type === 'commit') showDetail(commitDetail(d));
        else if (d.type === 'file') showDetail(fileDetail(d));
        else if (d.type === 'decision') showDetail(decisionDetail(d));
      });

    svg.on('click', () => {
      nodeSel.classed('link-faded', false);
      linkSel.classed('link-faded', false);
      clearDetail();
    });

    // Shapes per type
    nodeSel.filter(d => d.type === 'session')
      .append('circle').attr('r', 12);

    nodeSel.filter(d => d.type === 'commit')
      .append('rect')
      .attr('x', -9).attr('y', -9).attr('width', 18).attr('height', 18)
      .attr('rx', 2)
      .style('fill', d => timeColor(commitDateMap.get(d.data.hash)));

    nodeSel.filter(d => d.type === 'file')
      .append('circle').attr('r', 5);

    // Decision: diamond polygon
    nodeSel.filter(d => d.type === 'decision')
      .append('polygon')
      .attr('points', '0,-11 11,0 0,11 -11,0')
      .style('opacity', d => d.data.invalidAt ? 0.45 : 1);

    // Labels for sessions and commits
    nodeSel.filter(d => d.type === 'session' || d.type === 'commit')
      .append('text')
      .attr('class', 'node-label')
      .attr('dy', d => d.type === 'session' ? 22 : 20)
      .attr('text-anchor', 'middle')
      .text(d => {
        if (d.type === 'session') return d.data.id.slice(0, 8);
        if (d.type === 'commit') return d.data.hash.slice(0, 7);
        return '';
      });

    // ── Force simulation ──────────────────────────────────────────────────────
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id)
        .distance(d => {
          if (d.type === 'produced') return 100;
          if (d.type === 'touches') return 70;
          if (d.type === 'edited') return 90;
          return 60; // decision
        })
        .strength(d => d.type === 'produced' ? 0.6 : 0.3)
      )
      .force('charge', d3.forceManyBody().strength(d => {
        if (d.type === 'file') return -30;
        if (d.type === 'decision') return -40;
        return -120;
      }))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(d => {
        if (d.type === 'session') return 18;
        if (d.type === 'commit') return 14;
        return 10;
      }))
      .on('tick', () => {
        linkSel
          .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        nodeSel.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
        // 力仿真冷却后再自适应视口（早了节点还在漂移，fit 完就跑偏）。一次性。
        if (!hasAutoFitted && simulation.alpha() < 0.1) {
          hasAutoFitted = true;
          zoomToFit(nodes);
        }
      });
  }

  let hasAutoFitted = false;

  // ── Initial build ─────────────────────────────────────────────────────────────
  rebuildGraph();

  // ── Timeline slider ──────────────────────────────────────────────────────────
  const slider = document.getElementById('time-slider');
  const timeDisplay = document.getElementById('time-display');
  const playBtn = document.getElementById('play-btn');

  function formatDate(d) {
    if (!d) return '—';
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }

  function updateTimeline(val) {
    if (!minDate || !maxDate || minDate.getTime() === maxDate.getTime()) {
      timeDisplay.textContent = minDate ? formatDate(minDate) : '—';
      currentCutoff = maxDate;
      return;
    }
    const t = minDate.getTime() + (maxDate.getTime() - minDate.getTime()) * (val / 100);
    currentCutoff = new Date(t);
    timeDisplay.textContent = formatDate(currentCutoff);
    rebuildGraph();
  }

  if (minDate && maxDate) {
    timeDisplay.textContent = formatDate(maxDate);
    slider.addEventListener('input', e => updateTimeline(+e.target.value));
  } else {
    timeDisplay.textContent = '(no commits)';
    slider.disabled = true;
  }

  // ── Play button ───────────────────────────────────────────────────────────────
  let playTimer = null;
  playBtn.addEventListener('click', () => {
    if (playTimer !== null) {
      clearInterval(playTimer);
      playTimer = null;
      playBtn.textContent = '▶ Play';
      return;
    }
    // Start from beginning if at end
    if (+slider.value >= 100) slider.value = 0;
    playBtn.textContent = '⏸ Pause';
    playTimer = setInterval(() => {
      const v = +slider.value + 2;
      if (v >= 100) {
        slider.value = 100;
        updateTimeline(100);
        clearInterval(playTimer);
        playTimer = null;
        playBtn.textContent = '▶ Play';
      } else {
        slider.value = v;
        updateTimeline(v);
      }
    }, 100);
  });
}
</script>
</body>
</html>`;
}
