/* lore 官网 — 行为脚本：双语切换 / 滚动渐入 / 终端打字动画 / 复制 */
(function () {
  'use strict';

  /* ── 语言切换（持久化）───────────────────────── */
  var LANG_KEY = 'lore-site-lang';
  var root = document.documentElement;
  var zhBtn = document.getElementById('lang-zh');
  var enBtn = document.getElementById('lang-en');

  function setLang(lang) {
    root.setAttribute('data-lang', lang);
    root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    zhBtn.classList.toggle('active', lang === 'zh');
    enBtn.classList.toggle('active', lang === 'en');
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
  }
  zhBtn.addEventListener('click', function () { setLang('zh'); });
  enBtn.addEventListener('click', function () { setLang('en'); });
  try {
    var saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'zh') setLang(saved);
  } catch (e) {}

  /* ── 复制安装命令 ─────────────────────────────── */
  function wireCopy(btnId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var cmd = 'npx lore scan --repo .';
      var done = function () {
        btn.classList.add('copied');
        var prev = btn.innerHTML;
        btn.textContent = '✓';
        setTimeout(function () { btn.classList.remove('copied'); btn.innerHTML = prev; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(done, done);
      } else { done(); }
    });
  }
  wireCopy('copy-btn');
  wireCopy('copy-btn-2');

  /* ── 滚动渐入（不依赖 IntersectionObserver，预览环境不可靠）── */
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var pending = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  function checkReveals() {
    if (!pending.length) return;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    pending = pending.filter(function (el) {
      var top = el.getBoundingClientRect().top;
      if (top < vh * 0.92) { el.classList.add('in'); return false; }
      return true;
    });
  }
  if (reduced) {
    pending.forEach(function (el) { el.classList.add('in'); });
    pending = [];
  } else {
    window.addEventListener('scroll', checkReveals, { passive: true });
    window.addEventListener('resize', checkReveals);
    checkReveals();
    setTimeout(checkReveals, 120);
  }

  /* ── 终端打字动画 ─────────────────────────────── */
  var body = document.getElementById('terminal-body');
  var CMD = 'lore why src/server/upload-store.ts:42';
  var OUT = [
    '<span class="t-arrow">→</span> commit <span class="t-sha">1737b319</span> <span class="t-dim">"Add workspace upload evidence API"</span>',
    '<span class="t-arrow">→</span> session <span class="t-sha">13caa43d</span> <span class="t-dim">(2026-06-11, Claude Code)</span>',
    '   <span class="t-role">User:</span> "可以，全部修复吧 …"',
    '   <span class="t-role">Agent:</span> <span class="t-dim">开始编辑 workspace-upload-store.ts（异步 IO、</span>',
    '   <span class="t-dim">两阶段删除、启动清扫…）</span>',
    '',
    '<span class="t-prompt">$</span> <span class="t-caret"></span>'
  ];

  function renderFinal() {
    var html = '<div class="t-line"><span class="t-prompt">$</span> <span class="t-cmd">' + CMD + '</span></div>';
    OUT.forEach(function (line) {
      html += '<div class="t-line t-out show">' + (line || '&nbsp;') + '</div>';
    });
    body.innerHTML = html;
  }

  var playing = false;
  function play() {
    if (root.getAttribute('data-motion') === 'off' || reduced) { renderFinal(); return; }
    if (playing) return;
    playing = true;
    body.innerHTML = '';
    var cmdLine = document.createElement('div');
    cmdLine.className = 't-line';
    cmdLine.innerHTML = '<span class="t-prompt">$</span> <span class="t-cmd"></span><span class="t-caret"></span>';
    body.appendChild(cmdLine);
    var cmdSpan = cmdLine.querySelector('.t-cmd');
    var caret = cmdLine.querySelector('.t-caret');
    var i = 0;

    function typeChar() {
      if (i < CMD.length) {
        cmdSpan.textContent = CMD.slice(0, ++i);
        setTimeout(typeChar, 24 + Math.random() * 40);
      } else {
        setTimeout(function () { caret.remove(); showOut(0); }, 380);
      }
    }
    function showOut(j) {
      if (j >= OUT.length) { playing = false; return; }
      var div = document.createElement('div');
      div.className = 't-line t-out';
      div.innerHTML = OUT[j] || '&nbsp;';
      body.appendChild(div);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { div.classList.add('show'); });
      });
      setTimeout(function () { showOut(j + 1); }, j < 2 ? 300 : 170);
    }
    typeChar();
  }

  document.getElementById('replay-btn').addEventListener('click', function () {
    playing = false;
    play();
  });
  window.__loreRenderFinal = renderFinal;

  /* 首次进入视口时播放（同样用滚动位置检测） */
  if (reduced) {
    renderFinal();
  } else {
    var terminalEl = document.getElementById('terminal');
    var played = false;
    function checkTerminal() {
      if (played) return;
      var rect = terminalEl.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      if (rect.top < vh * 0.92 && rect.bottom > 0) {
        played = true;
        window.removeEventListener('scroll', checkTerminal);
        setTimeout(play, 350);
      }
    }
    window.addEventListener('scroll', checkTerminal, { passive: true });
    checkTerminal();
    setTimeout(checkTerminal, 150);
  }
  /* ── 首屏 Story 背板：会话泳道 → commit 轴的归因缎带（产品母题）── */
  (function buildStoryMini() {
    var svg = document.getElementById('story-svg');
    if (!svg) return;
    var NS = 'http://www.w3.org/2000/svg';
    function el(name, attrs, text) {
      var e = document.createElementNS(NS, name);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (text) e.textContent = text;
      svg.appendChild(e);
      return e;
    }

    /* 会话泳道（跨时间段的 session 条） */
    var bars = [
      { x: 36,  w: 240, y: 34,  label: 'claude-code · 13caa43d' },
      { x: 180, w: 250, y: 98,  label: 'codex · a91f02d' },
      { x: 350, w: 254, y: 162, label: 'claude-code · 77d3b1e' }
    ];
    bars.forEach(function (b) {
      el('rect', { x: b.x, y: b.y, width: b.w, height: 19, rx: 9.5, 'class': 'sv-bar' });
      el('text', { x: b.x + 14, y: b.y + 13.5, 'class': 'sv-bar-label' }, b.label);
    });

    /* 归因缎带：柔和宽带 + （绿色）细芯线，宽度≈置信度 */
    var AXIS_Y = 258;
    var ribbons = [
      { sx: 60,  sy: 53,  cx: 80,  w: 5 },
      { sx: 130, sy: 53,  cx: 200, w: 7, g: 1 },
      { sx: 230, sy: 53,  cx: 150, w: 4 },
      { sx: 210, sy: 117, cx: 260, w: 5 },
      { sx: 290, sy: 117, cx: 320, w: 8, g: 1 },
      { sx: 400, sy: 117, cx: 380, w: 4 },
      { sx: 385, sy: 181, cx: 440, w: 5 },
      { sx: 470, sy: 181, cx: 560, w: 7, g: 1 },
      { sx: 560, sy: 181, cx: 500, w: 4 }
    ];
    var animated = [];
    ribbons.forEach(function (r) {
      var d = 'M ' + r.sx + ' ' + r.sy +
              ' C ' + r.sx + ' ' + (r.sy + 58) + ', ' + r.cx + ' ' + (AXIS_Y - 64) + ', ' + r.cx + ' ' + (AXIS_Y - 7);
      animated.push(el('path', { d: d, 'stroke-width': r.w, 'class': 'sv-band' + (r.g ? ' green' : '') }));
      animated.push(el('path', { d: d, 'class': 'sv-core' + (r.g ? ' green' : '') }));
    });

    /* commit 轴 + 圆点（半径≈改动规模） */
    el('line', { x1: 36, y1: AXIS_Y, x2: 612, y2: AXIS_Y, 'class': 'sv-axis' });
    [
      { x: 80, r: 3 }, { x: 150, r: 5 }, { x: 200, r: 4, g: 1 }, { x: 260, r: 3 },
      { x: 320, r: 6, g: 1 }, { x: 380, r: 4 }, { x: 440, r: 5 }, { x: 500, r: 4 },
      { x: 560, r: 6, g: 1 }, { x: 600, r: 3 }
    ].forEach(function (c) {
      el('circle', { cx: c.x, cy: AXIS_Y, r: c.r, 'class': 'sv-commit' + (c.g ? ' green' : '') });
    });

    /* 决策菱形（挂在会话条上） */
    [{ x: 252, y: 43.5 }, { x: 520, y: 171.5 }].forEach(function (d) {
      el('path', {
        d: 'M ' + d.x + ' ' + (d.y - 5) + ' L ' + (d.x + 5) + ' ' + d.y +
           ' L ' + d.x + ' ' + (d.y + 5) + ' L ' + (d.x - 5) + ' ' + d.y + ' Z',
        'class': 'sv-diamond'
      });
    });

    /* 时间刻度 */
    [['may 02', 60], ['may 24', 300], ['jun 11', 540]].forEach(function (t) {
      el('text', { x: t[1], y: 290, 'class': 'sv-date' }, t[0]);
    });

    /* 缎带描线进场（动效开启时） */
    if (!reduced && root.getAttribute('data-motion') !== 'off') {
      animated.forEach(function (p, i) {
        var len = p.getTotalLength();
        p.style.strokeDasharray = len;
        p.style.strokeDashoffset = len;
        p.style.transition = 'stroke-dashoffset 800ms cubic-bezier(0.22,1,0.36,1) ' + (260 + i * 70) + 'ms';
      });
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          animated.forEach(function (p) { p.style.strokeDashoffset = '0'; });
        });
      });
    }
  })();
})();
