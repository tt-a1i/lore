/**
 * view-decisions.ts — 决策卡片流
 * CSS columns 瀑布布局，搜索过滤，双时间 supersede 链，onTimeline 折叠。
 */

export const CSS = `
/* ── Decisions view ─────────────────────────────────────── */
#view-decisions {
  overflow-y: auto;
  overflow-x: hidden;
  padding: 70px 20px 76px 20px;
}

#dec-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  padding: 0 0 14px 0;
  background: transparent;
}

#dec-search {
  width: 100%;
  max-width: 480px;
  background: rgba(240,246,252,0.05);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  padding: 7px 14px;
  outline: none;
  transition: border-color var(--t-fast), background var(--t-fast);
}
#dec-search::placeholder { color: var(--text-faint); }
#dec-search:focus {
  border-color: var(--border-strong);
  background: rgba(240,246,252,0.08);
}

#dec-columns {
  columns: 300px;
  column-gap: 14px;
}

/* ── card ── */
.dec-card {
  break-inside: avoid;
  display: block;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: var(--shadow);
  padding: 14px;
  margin-bottom: 14px;
  cursor: pointer;
  position: relative;
  transition:
    opacity var(--t-fast),
    border-color var(--t-fast),
    box-shadow var(--t-fast),
    max-height 280ms var(--ease);
  overflow: hidden;
  max-height: 600px;
}
.dec-card:hover {
  border-color: var(--border-strong);
  box-shadow: 0 12px 40px rgba(0,0,0,0.55);
}
.dec-card.future {
  opacity: 0.07;
  pointer-events: none;
  max-height: 0 !important;
  padding-top: 0;
  padding-bottom: 0;
  margin-bottom: 0;
  border-width: 0;
}

/* superseded */
.dec-card.superseded {
  opacity: 0.45;
}
.dec-card.superseded .dec-title {
  text-decoration: line-through;
  text-decoration-color: var(--text-faint);
}

/* card stagger entry animation */
@keyframes decCardIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dec-card-enter {
  animation: decCardIn 280ms var(--ease) both;
}

/* flash highlight */
@keyframes decFlash {
  0%   { box-shadow: 0 0 0 3px var(--green); }
  50%  { box-shadow: 0 0 0 6px rgba(86,211,100,0.15); }
  100% { box-shadow: var(--shadow); }
}
.dec-card.flash { animation: decFlash 0.45s ease forwards; }

/* kind badge */
.dec-kind {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  margin-bottom: 8px;
  border: 1px solid transparent;
}
.dec-kind.decision   { color: var(--green); border-color: rgba(86,211,100,0.25); background: rgba(86,211,100,0.08); }
.dec-kind.constraint { color: var(--blue);  border-color: rgba(88,166,255,0.25); background: rgba(88,166,255,0.08); }
.dec-kind.rejected   { color: var(--danger); border-color: rgba(248,81,73,0.25); background: rgba(248,81,73,0.08); }
.dec-kind-dot { width: 6px; height: 6px; border-radius: 50%; }
.decision .dec-kind-dot  { background: var(--green); }
.constraint .dec-kind-dot { background: var(--blue); }
.rejected .dec-kind-dot  { background: var(--danger); }

/* superseded corner badge */
.dec-superseded-badge {
  position: absolute;
  top: 10px; right: 10px;
  font-size: 10px;
  color: var(--text-faint);
  background: rgba(240,246,252,0.06);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  letter-spacing: 0.03em;
}

/* title */
.dec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 6px;
  line-height: 1.4;
  padding-right: 60px;
}

/* body */
.dec-body {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
  margin-bottom: 10px;
}

/* file chips */
.dec-files {
  display: flex; flex-wrap: wrap; gap: 5px;
  margin-bottom: 10px;
}
.dec-file-chip {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
  background: rgba(240,246,252,0.04);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 7px;
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dec-file-more {
  font-size: 10.5px;
  color: var(--text-faint);
  align-self: center;
}

/* footer */
.dec-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 2px;
}
.dec-session-id { font-family: var(--mono); font-size: 10.5px; }

/* superseded-by link */
.dec-sup-link {
  font-size: 11px;
  color: var(--blue);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* empty state */
#dec-empty {
  display: none;
  padding: 80px 0;
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 2;
}
#dec-empty.show { display: block; }
#dec-empty code {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--green);
  background: rgba(86,211,100,0.08);
  padding: 2px 8px;
  border-radius: 5px;
}
`;

export const JS = `
(function() {

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }

  function kindClass(kind) {
    if (kind === 'decision') return 'decision';
    if (kind === 'constraint') return 'constraint';
    return 'rejected';
  }

  function kindLabel(kind) {
    if (kind === 'decision') return 'decision';
    if (kind === 'constraint') return 'constraint';
    return 'rejected approach';
  }

  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }

  window.LORE_VIEWS.push({
    id: 'decisions',
    label: 'Decisions',
    subtitleKey: 'decisions.subtitle',

    _ctx: null,
    _query: '',
    _notes: [],

    mount: function(el, ctx) {
      var self = this;
      self._ctx = ctx;
      self._notes = ctx.payload.notes || [];

      // toolbar
      var toolbar = document.createElement('div');
      toolbar.id = 'dec-toolbar';
      toolbar.innerHTML = '<input id="dec-search" type="search" placeholder="Search decisions, constraints, rejected approaches…" autocomplete="off">';
      el.appendChild(toolbar);

      // columns container
      var cols = document.createElement('div');
      cols.id = 'dec-columns';
      el.appendChild(cols);

      // empty state
      var emptyEl = document.createElement('div');
      emptyEl.id = 'dec-empty';
      emptyEl.innerHTML =
        'No decisions distilled yet.<br>' +
        'Run <code>lore distill --repo &lt;path&gt;</code> to extract them.';
      el.appendChild(emptyEl);

      // search handler
      var searchEl = document.getElementById('dec-search');
      if (searchEl) {
        searchEl.addEventListener('input', function() {
          self._query = searchEl.value.toLowerCase();
          self._renderCards();
        });
      }

      self._renderCards();
    },

    onTimeline: function(cutoffMs) {
      // apply future-fade without full re-render
      var self = this;
      var cards = document.querySelectorAll('.dec-card');
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var validAt = card.getAttribute('data-valid-at');
        if (!validAt) continue;
        var ts = +new Date(validAt);
        if (cutoffMs != null && !isNaN(ts) && ts > cutoffMs) {
          card.classList.add('future');
        } else {
          card.classList.remove('future');
        }
      }
    },

    _visible: function(note) {
      var q = this._query;
      if (!q) return true;
      var haystack = (note.title || '') + ' ' + (note.body || '') + ' ' + (note.files || []).join(' ');
      return haystack.toLowerCase().indexOf(q) !== -1;
    },

    _renderCards: function() {
      var self = this;
      var ctx = self._ctx;
      var notes = self._notes;
      var cols = document.getElementById('dec-columns');
      var emptyEl = document.getElementById('dec-empty');
      if (!cols) return;

      var visible = notes.filter(function(n) { return self._visible(n); });

      if (visible.length === 0) {
        cols.innerHTML = '';
        if (emptyEl) emptyEl.classList.add('show');
        return;
      }
      if (emptyEl) emptyEl.classList.remove('show');

      var html = '';
      for (var i = 0; i < visible.length; i++) {
        html += self._cardHtml(visible[i]);
      }
      cols.innerHTML = html;

      // stagger entry animation: each card fades up, delay 40ms each, capped at 400ms
      var allCards = cols.querySelectorAll('.dec-card');
      for (var si = 0; si < allCards.length; si++) {
        var delay = Math.min(si * 40, 400);
        allCards[si].classList.add('dec-card-enter');
        allCards[si].style.animationDelay = delay + 'ms';
      }

      // attach click handlers
      var cards = cols.querySelectorAll('.dec-card');
      for (var j = 0; j < cards.length; j++) {
        (function(cardEl) {
          var noteId = cardEl.getAttribute('data-id');
          var note = self._noteById(noteId);
          if (!note) return;

          cardEl.addEventListener('click', function(ev) {
            // don't trigger if clicking superseded-by link
            if (ev.target && ev.target.classList && ev.target.classList.contains('dec-sup-link')) return;
            self._openDrawer(note);
          });

          // superseded-by link
          var supLink = cardEl.querySelector('.dec-sup-link');
          if (supLink) {
            supLink.addEventListener('click', function(ev) {
              ev.stopPropagation();
              var targetId = supLink.getAttribute('data-target');
              self._scrollToCard(targetId);
            });
          }
        })(cards[j]);
      }

      // apply timeline state
      self.onTimeline(ctx.cutoffMs);
    },

    _cardHtml: function(note) {
      var klass = kindClass(note.kind);
      var isSup = !!note.invalidAt;
      var cardClasses = 'dec-card' + (isSup ? ' superseded' : '');

      var kindHtml =
        '<div class="dec-kind ' + klass + '">' +
          '<span class="dec-kind-dot"></span>' +
          esc(kindLabel(note.kind)) +
        '</div>';

      var supBadge = isSup
        ? '<div class="dec-superseded-badge">superseded</div>'
        : '';

      var titleHtml = '<div class="dec-title">' + esc(note.title || '') + '</div>';
      var bodyHtml  = '<div class="dec-body">'  + esc(note.body  || '') + '</div>';

      var filesHtml = '';
      var files = note.files || [];
      if (files.length > 0) {
        filesHtml += '<div class="dec-files">';
        var shown = Math.min(files.length, 3);
        for (var fi = 0; fi < shown; fi++) {
          var fname = files[fi].split('/').pop() || files[fi];
          filesHtml += '<span class="dec-file-chip" title="' + esc(files[fi]) + '">' + esc(fname) + '</span>';
        }
        if (files.length > 3) {
          filesHtml += '<span class="dec-file-more">+' + (files.length - 3) + '</span>';
        }
        filesHtml += '</div>';
      }

      var sessionPart = note.sessionId
        ? '<span class="dec-session-id">' + esc(note.sessionId.slice(0, 8)) + '</span>'
        : '';
      var datePart = note.validAt
        ? '<span>' + esc(fmtDate(note.validAt)) + '</span>'
        : '';
      var supByPart = '';
      if (note.supersededBy) {
        supByPart = '<span class="dec-sup-link" data-target="' + esc(note.supersededBy) + '">→ ' + esc(note.supersededBy.slice(0,16)) + '</span>';
      }

      var footerHtml =
        '<div class="dec-footer">' +
          sessionPart +
          (sessionPart && datePart ? '<span style="opacity:0.3">·</span>' : '') +
          datePart +
          (supByPart ? '<span style="margin-left:auto">' + supByPart + '</span>' : '') +
        '</div>';

      return '<div class="' + cardClasses + '" data-id="' + esc(note.id) + '" data-valid-at="' + esc(note.validAt || '') + '">' +
        kindHtml +
        supBadge +
        titleHtml +
        bodyHtml +
        filesHtml +
        footerHtml +
        '</div>';
    },

    _noteById: function(id) {
      var notes = this._notes;
      for (var i = 0; i < notes.length; i++) {
        if (notes[i].id === id) return notes[i];
      }
      return null;
    },

    _scrollToCard: function(noteId) {
      var safeId = noteId ? noteId.replace(/["\\\\]/g, '\\\\$&') : '';
      var el = document.querySelector('.dec-card[data-id="' + safeId + '"]');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // flash twice
      el.classList.remove('flash');
      // force reflow
      void el.offsetWidth;
      el.classList.add('flash');
      var self = this;
      setTimeout(function() {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        setTimeout(function() { el.classList.remove('flash'); }, 500);
      }, 500);
    },

    _openDrawer: function(note) {
      var ctx = this._ctx;
      var self = this;
      var klass = kindClass(note.kind);

      var html = '';
      html += '<h3 style="padding-right:30px">' + esc(note.title || '(no title)') + '</h3>';
      html += '<div style="margin-bottom:10px">' +
        '<span class="dec-kind ' + klass + '" style="font-size:11px">' +
          '<span class="dec-kind-dot"></span>' + esc(kindLabel(note.kind)) +
        '</span>' +
        (note.invalidAt ? ' <span style="font-size:11px;color:var(--text-faint);margin-left:6px">superseded ' + esc(fmtDate(note.invalidAt)) + '</span>' : '') +
        '</div>';

      if (note.body) {
        html += '<div class="quote">' + esc(note.body) + '</div>';
      }

      // files
      var files = note.files || [];
      if (files.length > 0) {
        html += '<div class="sep"></div>';
        html += '<div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Affected files</div>';
        for (var fi = 0; fi < files.length; fi++) {
          html += '<div class="row"><span class="v mono" style="color:var(--text-dim)">' + esc(files[fi]) + '</span></div>';
        }
      }

      // anchors
      var anchors = note.anchors || [];
      if (anchors.length > 0) {
        html += '<div class="sep"></div>';
        html += '<div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Source anchors</div>';
        for (var ai = 0; ai < anchors.length; ai++) {
          var a = anchors[ai];
          html += '<div class="row">' +
            '<span class="chip mono" style="font-size:10.5px;color:var(--blue)">' + esc(a.sessionId ? a.sessionId.slice(0,8) : '?') + '</span>' +
            '<span class="v" style="color:var(--text-faint);font-size:11px">seq ' + (a.seq || 0) + '</span>' +
            '</div>';
        }
      }

      // supersede chain
      if (note.supersededBy) {
        html += '<div class="sep"></div>';
        html += '<div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Superseded by</div>';
        var sup = self._noteById(note.supersededBy);
        if (sup) {
          html += '<div class="row"><span class="v dec-scroll-link" data-scroll-id="' + esc(note.supersededBy) +
            '" style="cursor:pointer;color:var(--blue);text-decoration:underline;text-underline-offset:2px">' +
            esc(sup.title || note.supersededBy) + '</span></div>';
        } else {
          html += '<div class="row"><span class="v mono" style="color:var(--text-faint)">' + esc(note.supersededBy) + '</span></div>';
        }
      }

      // upstream: notes that supersede THIS note
      var upstream = self._notes.filter(function(n) { return n.supersededBy === note.id; });
      if (upstream.length > 0) {
        html += '<div class="sep"></div>';
        html += '<div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Supersedes</div>';
        for (var ui = 0; ui < upstream.length; ui++) {
          var up = upstream[ui];
          html += '<div class="row"><span class="v" style="color:var(--text-dim);font-size:12px">' + esc(up.title || up.id) + '</span></div>';
        }
      }

      html += '<div class="sep"></div>';
      html += '<div class="row"><span class="k">session</span><span class="v mono" style="color:var(--blue)">' + esc(note.sessionId ? note.sessionId.slice(0,8) : '—') + '</span></div>';
      html += '<div class="row"><span class="k">valid at</span><span class="v">' + esc(fmtDate(note.validAt)) + '</span></div>';
      if (note.invalidAt) {
        html += '<div class="row"><span class="k">invalid at</span><span class="v" style="color:var(--danger)">' + esc(fmtDate(note.invalidAt)) + '</span></div>';
      }

      ctx.drawer.show(html);
      // attach scroll-to links inside drawer
      var drawerBody = document.getElementById('drawer-body');
      if (drawerBody) {
        var scrollLinks = drawerBody.querySelectorAll('.dec-scroll-link');
        for (var si = 0; si < scrollLinks.length; si++) {
          (function(link) {
            link.addEventListener('click', function(ev) {
              ev.stopPropagation();
              var targetId = link.getAttribute('data-scroll-id');
              if (targetId) self._scrollToCard(targetId);
            });
          })(scrollLinks[si]);
        }
      }
    },
  });

})();
`;
