/**
 * intro —— 全屏开场 hero overlay：陌生人 10 秒入戏 + 电影感。
 *
 * 目标：让从没听过 lore 的人一眼明白"这是讲对话↔commit 因果的"，
 * 并被一句话 + 动态数字勾住，然后一键进入电影化回放。
 *
 * 协议（与 shell.ts 约定）：
 *   - 文案全走 window.LORE_T(key)（shell 持字典，按 navigator.language 选 zh/en）。
 *     LORE_T 不存在时降级英文兜底（防御式：overlay 不能因此白屏）。
 *   - shell 提供 window.LORE_INTRO = { open(opts), close() }；boot 决定是否首屏调用。
 *     opts = { sessions, commits, decisions, onWatch, onSkip }
 *       onWatch()  -> shell 启动电影化播放（淡出后调用）
 *       onSkip()   -> shell 直接派发 lore:demo（关 overlay 后调用）
 *   - localStorage 'lore-intro-seen' 记忆是否看过。
 *
 * 注意：本文件导出的 JS 处于 TS 模板字符串内，禁用反引号与 ${}，一律字符串拼接。
 */

export const INTRO_CSS = `
#intro-overlay {
  position: absolute; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  /* --bg 不透明打底 + 微弱径向光晕（绿，极淡；纸面上几乎不可见，深色下有呼吸感）*/
  background:
    radial-gradient(900px 600px at 50% 38%, color-mix(in srgb, var(--green) 7%, transparent) 0%, color-mix(in srgb, var(--bg) 0%, transparent) 60%),
    var(--bg);
  opacity: 0;
  transition: opacity 400ms var(--ease);
  pointer-events: none;
}
#intro-overlay.in { opacity: 1; pointer-events: auto; }
#intro-overlay.out { opacity: 0; pointer-events: none; }

.intro-stage {
  max-width: 680px; width: calc(100vw - 48px);
  padding: 0 24px; text-align: center;
  transform: translateY(8px);
  transition: transform 520ms var(--ease);
}
#intro-overlay.in .intro-stage { transform: translateY(0); }

.intro-eyebrow {
  font-family: var(--mono);
  font-size: 12px; font-weight: 600;
  letter-spacing: 0.42em; text-indent: 0.42em;
  color: var(--green); text-transform: uppercase;
  margin-bottom: 20px;
  opacity: 0.92;
}

.intro-headline {
  font-family: var(--serif);
  font-size: 34px; line-height: 1.2; font-weight: 600;
  color: var(--text);
  letter-spacing: 0.005em;
  font-feature-settings: "liga", "kern";
  margin-bottom: 18px;
  text-wrap: balance;
}

.intro-sub {
  font-size: 14.5px; line-height: 1.62;
  color: var(--text-dim);
  max-width: 560px; margin: 0 auto 30px;
  text-wrap: balance;
}
.intro-sub b.num {
  color: var(--text); font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-family: var(--mono); font-size: 0.95em;
}
.intro-sub .lit {
  color: var(--green); font-weight: 600;
}

.intro-cta { display: flex; gap: 12px; align-items: center; justify-content: center; }

.intro-watch {
  appearance: none; cursor: pointer;
  font: inherit; font-size: 13.5px; font-weight: 600;
  color: var(--green);
  padding: 11px 26px; border-radius: 999px;
  background: color-mix(in srgb, var(--green) 6%, transparent);
  border: 1px solid var(--green);
  /* 纸面 --glow-opacity=0 → 辉光自动消失，只留深绿描边；深色态维持微辉光 */
  box-shadow: 0 0 22px color-mix(in srgb, var(--green) calc(20% * var(--glow-opacity)), transparent);
  transition: all var(--t-fast);
}
.intro-watch:hover {
  background: color-mix(in srgb, var(--green) 12%, transparent);
  box-shadow:
    0 0 0 4px color-mix(in srgb, var(--green) calc(14% * var(--glow-opacity)), transparent),
    0 0 30px color-mix(in srgb, var(--green) calc(32% * var(--glow-opacity)), transparent);
  transform: translateY(-1px);
}
.intro-watch:active { transform: translateY(0); }

.intro-skip {
  appearance: none; cursor: pointer;
  font: inherit; font-size: 12.5px;
  color: var(--text-faint);
  padding: 11px 16px; border-radius: 999px;
  background: transparent; border: 1px solid transparent;
  transition: all var(--t-fast);
}
.intro-skip:hover { color: var(--text-dim); border-color: var(--border); }

.intro-keys {
  margin-top: 34px;
  font-size: 11px; color: var(--text-faint);
  letter-spacing: 0.02em;
}
.intro-keys kbd {
  font-family: var(--mono); font-size: 10.5px;
  color: var(--text-dim);
  padding: 1px 6px; margin: 0 2px;
  border: 1px solid var(--border); border-radius: 4px;
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
.intro-keys .sepdot { margin: 0 8px; opacity: 0.5; }
`;

/**
 * 导出 JS：定义 window.LORE_INTRO（open/close），不自动启动——由 shell.boot 决定。
 * 字符串拼接版本（模板串内禁 ${} 与反引号）。
 */
export const INTRO_JS = `
(function () {
  'use strict';

  // 防御式文案取值：LORE_T 不存在或抛错时用内置英文兜底。
  function T(key, fallback) {
    try {
      if (typeof window.LORE_T === 'function') {
        var v = window.LORE_T(key);
        if (v != null && v !== key && v !== '') return v;
      }
    } catch (e) {}
    return fallback != null ? fallback : key;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  // count-up：800ms easeOut，requestAnimationFrame。target 为整数。
  function countUp(elList, targets, done) {
    var start = null;
    var dur = 800;
    function ease(t) { return 1 - Math.pow(1 - t, 3); } // easeOutCubic
    function frame(ts) {
      if (start == null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var k = ease(p);
      for (var i = 0; i < elList.length; i++) {
        if (!elList[i]) continue;
        elList[i].textContent = String(Math.round(targets[i] * k));
      }
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        for (var j = 0; j < elList.length; j++) {
          if (elList[j]) elList[j].textContent = String(targets[j]);
        }
        if (done) done();
      }
    }
    requestAnimationFrame(frame);
  }

  // 把副句模板里的 {sessions} / {commits} 替换成带 <b class="num"> 的占位 span，
  // 这样可以对数字单独做 count-up。返回 { html, mapping }。
  function buildSubHtml(tmpl, sessions, commits) {
    // 先转义模板（避免文案里意外的 HTML），再把占位标记替换为 span。
    var safe = esc(String(tmpl == null ? '' : tmpl));
    // 高亮"发光"一类词不强求；只保证数字占位被替换。
    safe = safe.replace('{sessions}', '<b class="num" data-num="sessions">0</b>');
    safe = safe.replace('{commits}', '<b class="num" data-num="commits">0</b>');
    return safe;
  }

  var overlay = null;
  var lastWatch = null, lastSkip = null;

  function buildOverlay(opts) {
    var sessions = Math.max(0, opts && opts.sessions ? opts.sessions : 0);
    // {commits} 必须是"有归因的 commit 数"——用全量 commit 数会把
    // "AI 塑造了 726 个 commit"说成谎。attributed 缺失时才退回全量。
    var commits = Math.max(0, (opts && (opts.attributed || opts.commits)) || 0);

    var el = document.createElement('div');
    el.id = 'intro-overlay';

    var subTmpl = T('intro.sub', 'In this repo, {sessions} conversations with AI agents shaped {commits} commits. Every glowing commit remembers the conversation that made it.');
    var subHtml = buildSubHtml(subTmpl, sessions, commits);

    var keysTmpl = T('intro.keys', '<kbd>1</kbd>–<kbd>4</kbd> views <span class="sepdot">·</span> <kbd>Space</kbd> play <span class="sepdot">·</span> <kbd>Esc</kbd> close');

    el.innerHTML =
      '<div class="intro-stage">' +
        '<div class="intro-eyebrow">LORE</div>' +
        '<div class="intro-headline display">' + esc(T('intro.headline', 'Software is made between commits.')) + '</div>' +
        '<div class="intro-sub">' + subHtml + '</div>' +
        '<div class="intro-cta">' +
          '<button class="intro-watch" type="button">' + esc(T('intro.watch', 'Watch the story')) + '</button>' +
          '<button class="intro-skip" type="button">' + esc(T('intro.skip', 'Skip')) + '</button>' +
        '</div>' +
        '<div class="intro-keys">' + keysTmpl + '</div>' +
      '</div>';

    document.getElementById('app').appendChild(el);

    // count-up 数字
    var sEl = el.querySelector('[data-num="sessions"]');
    var cEl = el.querySelector('[data-num="commits"]');
    // 进入动画后再启动 count-up（让 transform/opacity 先生效）。
    requestAnimationFrame(function () {
      el.classList.add('in');
      requestAnimationFrame(function () {
        countUp([sEl, cEl], [sessions, commits]);
      });
    });

    var watchBtn = el.querySelector('.intro-watch');
    var skipBtn = el.querySelector('.intro-skip');

    watchBtn.addEventListener('click', function () {
      markSeen();
      fadeOut(function () {
        if (typeof lastWatch === 'function') { try { lastWatch(); } catch (e) {} }
      });
    });
    skipBtn.addEventListener('click', function () {
      markSeen();
      fadeOut(function () {
        if (typeof lastSkip === 'function') { try { lastSkip(); } catch (e) {} }
      });
    });

    return el;
  }

  function markSeen() {
    try { localStorage.setItem('lore-intro-seen', '1'); } catch (e) {}
  }

  function fadeOut(after) {
    if (!overlay) { if (after) after(); return; }
    overlay.classList.remove('in');
    overlay.classList.add('out');
    var node = overlay;
    var done = false;
    function finish() {
      if (done) return; done = true;
      if (node && node.parentNode) node.parentNode.removeChild(node);
      if (overlay === node) overlay = null;
      if (after) { try { after(); } catch (e) {} }
    }
    node.addEventListener('transitionend', finish);
    setTimeout(finish, 480); // transitionend 兜底
  }

  window.LORE_INTRO = {
    seen: function () {
      try { return localStorage.getItem('lore-intro-seen') === '1'; } catch (e) { return false; }
    },
    open: function (opts) {
      if (overlay) return; // 已打开则忽略
      lastWatch = opts && opts.onWatch;
      lastSkip = opts && opts.onSkip;
      overlay = buildOverlay(opts || {});
    },
    close: function () { fadeOut(null); },
  };
})();
`;
