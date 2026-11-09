/* The reading view: paginates a chapter into CSS columns laid over one or two
 * sheets of "paper", and wraps it with Kindle-style chrome. */
import { loadSettings, saveSettings, store } from './store.js';
import { icons } from './icons.js';
import { animateTurn } from './turn.js';

export const FONTS = {
  Literata: { stack: '"Literata", Georgia, serif', scale: 1 },
  'EB Garamond': { stack: '"EB Garamond", Garamond, serif', scale: 1.13 },
  'Crimson Pro': { stack: '"Crimson Pro", Georgia, serif', scale: 1.1 },
  'Libre Baskerville': { stack: '"Libre Baskerville", Baskerville, serif', scale: 0.9 },
  Spectral: { stack: '"Spectral", Georgia, serif', scale: 0.98 },
  Atkinson: { stack: '"Atkinson Hyperlegible", system-ui, sans-serif', scale: 0.96 },
};
const SIZES = [13, 14, 15, 16, 17, 18, 19.5, 21, 23, 26, 30];
const SPACING = [1.32, 1.48, 1.64, 1.85];
const WEIGHTS = [400, 460, 520, 600];
const MARGINS = [0.06, 0.085, 0.11, 0.145];
const STATUS = ['page', 'loc', 'chapter', 'book', 'none'];
const COACH_KEY = 'paperback.readingTips'; // 'off' = the reader chose "Don't show again"
const THEMES = [
  ['paper', 'Paper'], ['white', 'White'], ['sepia', 'Sepia'], ['eink', 'E-ink'], ['night', 'Night'],
];
const HL_COLORS = ['yellow', 'blue', 'pink', 'orange'];
const VP_PAD = 6; // horizontal bleed of the text viewport so italics are not clipped

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

async function waitImages(root, timeout = 2500) {
  const imgs = [...root.querySelectorAll('img')].filter((i) => !i.complete);
  if (!imgs.length) return;
  await Promise.race([Promise.all(imgs.map((i) => i.decode().catch(() => {}))), sleep(timeout)]);
}

function fmtTime(min) {
  if (!isFinite(min)) return '';
  min = Math.max(1, Math.round(min));
  if (min < 60) return `${min} min`;
  const hh = Math.floor(min / 60); const mm = min % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

/* Typographic preparation of a chapter after it is in the DOM. */
function prepareArticle(art) {
  const range = document.createRange();
  const textBefore = (node) => { range.setStart(art, 0); range.setEndBefore(node); return range.toString().trim().length; };
  const isHeading = (n) => n && /^H[1-6]$/.test(n.tagName);
  let opener = null;
  for (const hd of art.querySelectorAll('h1,h2')) {
    const prev = hd.previousElementSibling;
    if (isHeading(prev)) continue;
    if (textBefore(hd) > 0) hd.classList.add('bk-break');
    else if (!opener) opener = hd;
  }
  if (opener) {
    range.setStart(art, 0); range.setEndBefore(opener);
    if (!range.cloneContents().querySelector('img,svg')) opener.classList.add('bk-sink');
  }
  // first paragraph after a heading gets a drop cap + small-caps lead-in
  for (const hd of art.querySelectorAll('h1,h2,h3')) {
    let p = hd.nextElementSibling;
    while (p && (isHeading(p) || (!p.textContent.trim() && !p.querySelector('img')))) p = p.nextElementSibling;
    if (!p || p.tagName !== 'P' || p.textContent.trim().length < 120) continue;
    const firstMeaningful = [...p.childNodes].find((n) => (n.nodeType === 3 && n.data.trim()) || (n.nodeType === 1 && (n.textContent.trim() || n.tagName === 'IMG')));
    if (!firstMeaningful || (firstMeaningful.nodeType === 1 && firstMeaningful.tagName === 'IMG')) continue;
    p.classList.add('bk-first');
  }
  for (const img of art.querySelectorAll('img')) {
    const parent = img.parentElement;
    if (parent && parent !== art && !parent.textContent.trim() && parent.querySelectorAll('img').length === 1) {
      parent.classList.add('bk-fig'); img.classList.add('bk-block-img');
    } else if (parent === art) img.classList.add('bk-block-img');
  }
  art.classList.toggle('bk-solo', !art.textContent.trim() && art.querySelectorAll('img, svg').length === 1);
  for (const m of art.querySelectorAll('[id^="page_"], [data-epub-type~="pagebreak"], [role="doc-pagebreak"], .pagenum')) {
    m.classList.add('bk-pagemark');
    const label = m.getAttribute('title') || m.getAttribute('aria-label') || m.textContent.replace(/[[\]\s]|Pg/g, '') || m.id.replace(/^page_?/, '');
    m.dataset.page = label;
  }
}

export class Reader {
  constructor(root, { onClose }) {
    this.root = root;
    this.onClose = onClose;
    this.settings = loadSettings();
    this.build();
    this.bind();
    this.applySettings(false);
  }

  /* ---------------- DOM ---------------- */
  build() {
    const pageHtml = (slot) => `<div class="page slot${slot}"><div class="edges"></div><div class="paper"></div><div class="head"></div><div class="folio"></div><div class="shade"></div><div class="dogear"></div></div>`;
    this.root.innerHTML = `
      <div class="desk">
        <div class="book">
          <div class="board"></div>
          ${pageHtml(0)}${pageHtml(1)}
          <div class="text-vp"><div class="flow bk-content"><article class="bk-chapter"></article></div></div>
          <div class="ribbon"></div>
          <div class="turn-layer"></div>
          <div class="measure"><div class="flow bk-content"><article class="bk-chapter"></article></div></div>
        </div>
      </div>
      <div class="light-warm"></div><div class="light-dim"></div>
      <div class="mini mini-top"><span class="mini-title"></span><span class="clock"></span><span class="mini-right"></span></div>
      <div class="mini mini-bottom"><button class="status-left" title="Tap to change"></button><span class="status-right"></span></div>
      <button class="edge-hint edge-top" tabindex="-1" aria-label="Show menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg><span>Menu</span><kbd>Space</kbd></button>
      <button class="edge-hint edge-bottom" tabindex="-1" aria-label="Show contents and progress"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg><span>Contents &amp; progress</span></button>
      <div class="coach" hidden role="status" aria-label="Reading shortcuts">
        <div class="coach-title">How to read</div>
        <dl class="coach-list">
          <dt><kbd>←</kbd><kbd>→</kbd></dt><dd>Turn the page <small>or tap the left / right side</small></dd>
          <dt><kbd class="wide">Space</kbd></dt><dd>Show the top &amp; bottom menus <small>or tap the middle</small></dd>
          <dt><kbd>B</kbd></dt><dd>Bookmark this page <small>or tap the top-right corner</small></dd>
          <dt><kbd>F</kbd></dt><dd>Full screen <small>press again (or Esc) to exit</small></dd>
          <dt><span class="coach-sel">Aa</span></dt><dd>Select any phrase to highlight it or add a note</dd>
        </dl>
        <div class="coach-foot"><span>Press <kbd>?</kbd> anytime to see this</span><button class="coach-off">Don’t show again</button></div>
      </div>
      <div class="loading"><div class="spinner"></div><div class="loading-text">Opening book…</div></div>
      <header class="chrome chrome-top">
        <button class="ib act-back" title="Library">${icons.back}<span>Library</span></button>
        <div class="chrome-title"></div>
        <div class="chrome-actions">
          <button class="ib act-aa" title="Display settings (A)">${icons.aa}</button>
          <button class="ib act-toc" title="Contents (T)">${icons.toc}</button>
          <button class="ib act-search" title="Search (/)">${icons.search}</button>
          <button class="ib act-notes" title="Notebook (N)">${icons.notes}</button>
          <button class="ib act-bm" title="Bookmark this page (B)">${icons.bookmark}</button>
          <button class="ib act-full" title="Full screen (F)">${icons.full}</button>
        </div>
      </header>
      <footer class="chrome chrome-bottom">
        <div class="jump-back" hidden></div>
        <div class="scrub-label"></div>
        <input class="scrub" type="range" min="0" max="100" step="1" value="0" aria-label="Reading progress">
        <div class="scrub-meta"><span class="scrub-left"></span><span class="scrub-right"></span></div>
      </footer>
      <aside class="drawer" aria-hidden="true">
        <div class="drawer-head">
          <div class="drawer-book"><div class="drawer-cover"></div><div><div class="drawer-title"></div><div class="drawer-author"></div></div></div>
          <button class="ib drawer-close">${icons.close}</button>
        </div>
        <nav class="tabs"><button data-tab="toc">Contents</button><button data-tab="notes">Notebook</button><button data-tab="search">Search</button></nav>
        <div class="tab-body tab-toc"></div>
        <div class="tab-body tab-notes"></div>
        <div class="tab-body tab-search">
          <form class="search-form"><input type="search" placeholder="Search this book" autocomplete="off"></form>
          <div class="search-results"></div>
        </div>
      </aside>
      <section class="sheet settings" aria-hidden="true"></section>
      <div class="pop selmenu" hidden></div>
      <div class="pop notepop" hidden></div>
      <div class="scrim" hidden></div>
      <div class="toast" hidden></div>`;
    const q = (s) => this.root.querySelector(s);
    this.desk = q('.desk'); this.bookEl = q('.book');
    this.pages = [q('.page.slot0'), q('.page.slot1')];
    this.vp = q('.text-vp'); this.flow = q('.text-vp .flow'); this.article = q('.text-vp article');
    this.turnLayer = q('.turn-layer');
    this.mFlow = q('.measure .flow'); this.mArticle = q('.measure article');
    this.$ = q;
    this.pubStyle = document.getElementById('bk-publisher') || document.head.insertBefore(Object.assign(document.createElement('style'), { id: 'bk-publisher' }), document.head.firstChild);
  }

  bind() {
    const $ = this.$;
    $('.act-back').onclick = () => this.close();
    $('.act-aa').onclick = () => this.toggleSettings();
    $('.act-toc').onclick = () => this.openDrawer('toc');
    $('.act-search').onclick = () => this.openDrawer('search');
    $('.act-notes').onclick = () => this.openDrawer('notes');
    $('.act-bm').onclick = () => this.toggleBookmark();
    $('.act-full').onclick = () => this.toggleFullscreen();
    $('.drawer-close').onclick = () => this.closePanels();
    $('.scrim').onclick = () => this.closePanels();
    this.root.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => this.openDrawer(b.dataset.tab); });
    $('.status-left').onclick = (e) => { e.stopPropagation(); this.settings.status = (this.settings.status + 1) % STATUS.length; saveSettings(this.settings); this.updateStatus(); };
    $('.search-form').onsubmit = (e) => { e.preventDefault(); this.runSearch($('.search-form input').value); };

    // Discoverability: the bars are hidden, so hint at them near the edges (mouse) and on first opens.
    this.root.querySelectorAll('.edge-hint').forEach((h) => { h.onclick = (e) => { e.stopPropagation(); this.setChrome(true); }; });
    $('.coach').onclick = () => this.hideCoach();
    $('.coach-off').onclick = (e) => {
      e.stopPropagation();
      try { localStorage.setItem(COACH_KEY, 'off'); } catch { /* storage blocked */ }
      this.hideCoach();
    };
    const EDGE = 76;
    this.root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const free = this.book && !this.chromeOn && !this.root.querySelector('.drawer.open, .settings.open');
      this.root.classList.toggle('peek-top', !!free && e.clientY < EDGE);
      this.root.classList.toggle('peek-bottom', !!free && e.clientY > innerHeight - EDGE);
    });
    this.root.addEventListener('pointerleave', () => this.root.classList.remove('peek-top', 'peek-bottom'));

    const scrub = $('.scrub');
    scrub.oninput = () => { const t = this.pageToTarget(+scrub.value); $('.scrub-label').textContent = `${this.book.spine[t.spine].title} · Page ${+scrub.value + 1}`; $('.scrub-label').classList.add('show'); };
    scrub.onchange = () => { $('.scrub-label').classList.remove('show'); this.jump(this.pageToTarget(+scrub.value)); };

    // taps, swipes, selection
    let start = null;
    this.desk.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now(), type: e.pointerType }; });
    this.desk.addEventListener('pointermove', (e) => {
      if (!start || start.type === 'mouse' || !this.book) return;
      const dx = e.clientX - start.x; const dy = e.clientY - start.y;
      if (!this.drag) {
        if (this.busy || Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
        if (!['curl', 'slide'].includes(this.settings.turn) || this.chromeOn) return;
        const sel = getSelection(); if (sel && !sel.isCollapsed) return;
        this.drag = this.beginDrag(dx < 0 ? 1 : -1, start.x);
        if (!this.drag) { start = null; return; }
      }
      this.drag.update(e.clientX);
    });
    const endDrag = (e) => { if (this.drag && !this.drag.ending) { this.drag.ending = true; this.drag.end(e.clientX); start = null; return true; } return false; };
    this.desk.addEventListener('pointercancel', endDrag);
    this.desk.addEventListener('pointerup', (e) => {
      if (endDrag(e)) return;
      if (!start) return;
      const dx = e.clientX - start.x; const dy = e.clientY - start.y;
      const dist = Math.hypot(dx, dy);
      const s0 = start; start = null;
      setTimeout(() => this.onPointerUp(e, dx, dy, dist, s0), 0);
    });
    this.desk.addEventListener('contextmenu', (e) => { if (e.target.closest('.flow')) e.preventDefault(); });
    // Rapid clicks to flip pages are double/triple clicks to the browser, which would select a
    // word/paragraph and swallow the turn. Only drag-to-select selects text here.
    this.desk.addEventListener('mousedown', (e) => { if (e.detail > 1 && e.button === 0) e.preventDefault(); });
    document.addEventListener('selectionchange', () => {
      clearTimeout(this.selTimer);
      this.selTimer = setTimeout(() => { if (start == null) this.maybeSelMenu(); }, 350);
    });

    let wheelAcc = 0; let wheelLock = 0;
    this.desk.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Date.now() < wheelLock) return;
      wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(wheelAcc) > 60) { this.turn(wheelAcc > 0 ? 1 : -1); wheelAcc = 0; wheelLock = Date.now() + 420; }
    }, { passive: false });

    this.keyHandler = (e) => {
      if (!this.book || this.root.hidden) return;
      if (e.target.closest?.('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
      const k = e.key;
      const onControl = e.target.closest?.('button, a, select, [role="button"]');
      if (k !== '?' && k !== 'Shift') this.hideCoach(); // any key dismisses the shortcuts card (and still does its job)
      if (['ArrowRight', 'PageDown', 'j'].includes(k)) { e.preventDefault(); this.turn(1); }
      else if (['ArrowLeft', 'PageUp', 'k'].includes(k)) { e.preventDefault(); this.turn(-1); }
      else if (k === ' ' && !onControl) { e.preventDefault(); if (!this.closePanels()) this.setChrome(!this.chromeOn); }
      else if (k === '?') { e.preventDefault(); this.closePanels(); this.setChrome(false); this.showCoach(); }
      else if (k === 'Escape') { if (!this.closePanels()) this.setChrome(false); }
      else if (k === 'm' || (k === 'Enter' && !onControl)) { e.preventDefault(); if (!this.closePanels()) this.setChrome(!this.chromeOn); }
      else if (k === 't') this.openDrawer('toc');
      else if (k === 'n') this.openDrawer('notes');
      else if (k === '/') { e.preventDefault(); this.openDrawer('search'); }
      else if (k === 'a') this.toggleSettings();
      else if (k === 'b') this.toggleBookmark();
      else if (k === 'f') this.toggleFullscreen();
      else if (k === '+' || k === '=') this.set('size', Math.min(SIZES.length - 1, this.settings.size + 1));
      else if (k === '-') this.set('size', Math.max(0, this.settings.size - 1));
    };
    document.addEventListener('keydown', this.keyHandler);

    let rt;
    this.resizeHandler = () => { clearTimeout(rt); rt = setTimeout(() => this.book && this.relayout(), 150); };
    window.addEventListener('resize', this.resizeHandler);
    this.clockTimer = setInterval(() => this.updateClock(), 15000);
    this.updateClock();
  }

  onPointerUp(e, dx, dy, dist, s0) {
    if (!this.book) return;
    if (e.target.closest?.('.edge-hint')) return; // its own click handler opens the menu
    this.hideCoach();
    const sel = getSelection();
    if (sel && !sel.isCollapsed && this.flow.contains(sel.anchorNode)) {
      // A click with a tiny wobble selects a letter or two: that's a tap, not a highlight.
      if (dist < 8 && sel.toString().trim().length < 3) sel.removeAllRanges();
      else { this.maybeSelMenu(); return; }
    }
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2 && Date.now() - s0.t < 800) { this.turn(dx < 0 ? 1 : -1); return; }
    if (dist > 10) return;
    if (this.closePanels()) return;
    if (this.chromeOn) { this.setChrome(false); return; }
    const link = e.target.closest('.bk-link');
    if (link) { this.followLink(link); return; }
    const mark = e.target.closest('mark.bk-hl');
    if (mark) { this.showHighlightMenu(mark.dataset.hl, mark); return; }
    if (e.target.closest('a.bk-ext')) return;
    const W = innerWidth; const H = innerHeight;
    const x = e.clientX / W; const y = e.clientY / H;
    const br = this.bookEl.getBoundingClientRect();
    if (e.clientY - br.top < br.height * 0.1 && br.right - e.clientX < Math.min(90, br.width * 0.15) && e.clientX < br.right && e.clientY > br.top) { this.toggleBookmark(); return; }
    if (y < 0.12 || (x > 0.35 && x < 0.65 && y > 0.3 && y < 0.7)) { this.setChrome(true); return; }
    this.turn(x < 0.3 ? -1 : 1);
  }

  /* ---------------- open / close ---------------- */
  async open(book, meta, state) {
    this.book = book; this.meta = meta;
    this.state = state || { id: meta.id };
    this.state.highlights ||= []; this.state.bookmarks ||= [];
    this.chapter = -1; this.map = null; this.textCache = new Map();
    this.speed = this.state.speed || 1100;
    this.root.hidden = false;
    this.root.classList.add('is-loading');
    this.pubStyle.textContent = book.css;
    this.flow.lang = this.mFlow.lang = book.language;
    this.$('.chrome-title').textContent = book.title;
    this.$('.mini-title').textContent = book.title;
    this.$('.drawer-title').textContent = book.title;
    this.$('.drawer-author').textContent = book.author;
    const cover = this.$('.drawer-cover');
    cover.innerHTML = '';
    if (meta.coverUrl) cover.appendChild(Object.assign(new Image(), { src: meta.coverUrl, alt: '' }));
    this.applySettings(false);
    await this.fontsReady();
    this.computeLayout();
    const pos = this.state.pos || { spine: this.firstReadable(), offset: 0 };
    await this.show({ spine: Math.min(pos.spine, book.spine.length - 1), offset: pos.offset });
    this.root.classList.remove('is-loading');
    this.lastTurn = Date.now();
    this.paginateAll();
    setTimeout(() => { if (this.book === book && !this.chromeOn) this.maybeCoach(); }, 700);
  }

  firstReadable() {
    // start where a reader would: skip cover/title boilerplate is what Kindle does ("Beginning"), but keep cover if it's the only page
    return 0;
  }

  async close() {
    this.closePanels(); this.setChrome(false);
    await this.persist(true);
    this.pagToken = (this.pagToken || 0) + 1;
    this.book?.destroy();
    this.book = null;
    this.article.innerHTML = ''; this.mArticle.innerHTML = '';
    this.root.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.onClose?.();
  }

  async fontsReady() {
    const f = FONTS[this.settings.font] || FONTS.Literata;
    const fam = f.stack.split(',')[0];
    try { await Promise.race([Promise.all([document.fonts.load(`16px ${fam}`), document.fonts.load(`italic 16px ${fam}`), document.fonts.load(`600 16px ${fam}`)]), sleep(2500)]); } catch { /* offline */ }
  }

  /* ---------------- layout ---------------- */
  computeLayout() {
    const S = this.settings;
    const W = innerWidth; const H = innerHeight;
    const landscape = W / H > 1.15;
    const compact = landscape && H < 600; // landscape phones & small tablets: no desk, fill the screen
    const phone = !landscape && W < 720;  // portrait phones: one full-bleed page
    const wantSpread = S.spread !== 'single' && landscape;
    let spread = false; let top = 34; let bottom = 34;
    let pageW; let pageH; let bleed = false;
    if (phone) {
      pageW = W; pageH = H - top - bottom; bleed = true;
    } else if (compact) {
      bleed = true; top = 0; bottom = 0; pageH = H;
      spread = wantSpread && W >= 620;
      pageW = spread ? Math.floor(W / 2) : Math.min(W, Math.max(Math.round(H * 0.95), 560));
    } else {
      spread = wantSpread && W >= 900;
      const availH = H - top - bottom - 28;
      const availW = W - 64;
      const maxW = spread ? Math.floor(availW / 2) : availW;
      pageH = availH;
      pageW = Math.round(pageH * 0.69);
      if (pageW < 440) pageW = Math.round(pageH * 0.8); // squat screens: wider leaves read better
      if (pageW > maxW) pageW = maxW;
      if (pageW < pageH * 0.56) pageH = Math.round(pageW / 0.56);
    }
    const f = FONTS[S.font] || FONTS.Literata;
    const small = phone || compact;
    let fs = SIZES[S.size] * f.scale * (small ? 1 : 1.04);
    const mo = Math.round(Math.max(small ? 18 : 28, Math.min(pageW * MARGINS[S.margins] * (compact ? 0.8 : 1), 110)));
    const mi = spread ? Math.round(mo * (compact ? 0.75 : 0.9) + 6) : mo;
    // keep at least ~45 characters per line so justified text doesn't open rivers
    const minFs = fs * 0.8;
    if (!phone) fs = Math.max(minFs, Math.min(fs, (pageW - mo - mi) / (0.47 * 45)));
    const lh = Math.round(fs * SPACING[S.spacing]);
    let mt = Math.round(compact ? Math.max(pageH * 0.08, 30) : Math.max(pageH * 0.075, 38));
    const mb = Math.round(compact ? Math.max(pageH * 0.085, 30) : Math.max(pageH * 0.08, 40));
    const avail = pageH - mt - mb;
    const textH = Math.floor(avail / lh) * lh;
    mt += Math.round((avail - textH) * 0.45);
    const colW = pageW - mo - mi;
    const gap = mo + mi;
    const cols = spread ? 2 : 1;
    const flowW = cols * colW + (cols - 1) * gap;
    const stride = colW + gap;
    const bookW = pageW * cols;
    const left = Math.round((W - bookW) / 2) + (spread ? 0 : 0);
    const topPx = bleed ? top : Math.round(top + (H - top - bottom - pageH) / 2);
    this.L = { W, H, phone, compact, spread, bleed, pageW, pageH, fs, lh, mo, mi, mt, mb, textH, colW, gap, cols, flowW, stride, bookW, left, top: topPx };
    const b = this.bookEl.style;
    const vars = { 'page-w': pageW, 'page-h': pageH, mo, mi, mt, mb, 'text-h': textH, 'col-w': colW, gap, 'flow-w': flowW, fs, lh, 'book-w': bookW, 'vp-pad': VP_PAD };
    for (const [k, v] of Object.entries(vars)) b.setProperty(`--${k}`, `${v}px`);
    b.setProperty('--cols', cols);
    b.setProperty('--font', f.stack);
    b.setProperty('--fw', WEIGHTS[S.weight ?? 1]);
    b.left = `${left}px`; b.top = `${topPx}px`; b.width = `${bookW}px`; b.height = `${pageH}px`;
    this.root.classList.toggle('spread', spread);
    this.root.classList.toggle('single', !spread);
    this.root.classList.toggle('bleed', bleed);
    this.root.classList.toggle('compact', compact);
    this.sig = [S.font, S.size, S.weight, S.spacing, S.margins, spread, pageW, pageH, S.publisher, S.ornaments].join('|');
  }

  async relayout() {
    const pos = this.pos;
    this.computeLayout();
    await nextFrame();
    if (!this.book) return;
    this.indexText();
    this.measurePages();
    this.page = this.offsetToPage(pos?.offset ?? 0);
    this.applyPage();
    this.paginateAll();
  }

  measurePages(flow = this.flow) {
    const n = Math.max(1, Math.round((flow.scrollWidth + this.L.gap) / this.L.stride));
    if (flow === this.flow) this.pageCount = n;
    return n;
  }

  /* ---------------- chapter rendering ---------------- */
  async loadChapter(i) {
    if (this.chapter === i) return;
    const s = this.book.spine[i];
    this.article.className = `bk-chapter ${s.bodyClass}`;
    this.article.innerHTML = s.html;
    prepareArticle(this.article);
    this.chapter = i;
    this.indexText();
    this.applyHighlights();
    await waitImages(this.article);
    this.measurePages();
    this.pageMarks = null;
  }

  indexText() {
    const nodes = []; let off = 0;
    const w = document.createTreeWalker(this.article, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const len = n.data.length;
      nodes.push({ n, start: off, len, vis: /\S/.test(n.data) && n.parentElement.getClientRects().length > 0 });
      off += len;
    }
    this.tnodes = nodes; this.tvis = nodes.filter((x) => x.vis); this.tlen = off;
  }

  rects(node, a, b) { const r = this.range ||= document.createRange(); r.setStart(node, a); r.setEnd(node, b); return r.getClientRects(); }

  /** chapter text offset of the first character on the current page */
  pageStartOffset() {
    const x = this.flow.getBoundingClientRect().left + this.page * this.L.stride - 2;
    const vis = this.tvis;
    let lo = 0; let hi = vis.length;
    const lastRight = (t) => { const r = this.rects(t.n, 0, t.len); return r.length ? r[r.length - 1].right : -Infinity; };
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lastRight(vis[mid]) > x) hi = mid; else lo = mid + 1; }
    if (lo >= vis.length) return this.tlen;
    const t = vis[lo];
    let a = 0; let b = t.len - 1;
    const right = (c) => { const r = this.rects(t.n, c, c + 1); return r.length ? r[r.length - 1].right : -Infinity; };
    if (right(0) > x) return t.start;
    while (a < b) { const mid = (a + b) >> 1; if (right(mid) > x) b = mid; else a = mid + 1; }
    return t.start + a;
  }

  offsetToPage(off) {
    if (!off || !this.tvis.length) return 0;
    let t = this.tvis.find((x) => x.start + x.len > off);
    if (!t) return this.lastPage();
    const k = Math.max(0, Math.min(t.len - 1, off - t.start));
    let r = this.rects(t.n, k, k + 1)[0];
    if (!r || (!r.width && !r.height)) r = this.rects(t.n, 0, t.len)[0];
    if (!r) return 0;
    const fl = this.flow.getBoundingClientRect().left;
    let col = Math.floor((r.left - fl + 2) / this.L.stride);
    col = Math.max(0, Math.min(this.pageCount - 1, col));
    return this.L.spread ? col - (col % 2) : col;
  }

  lastPage() { const c = this.pageCount - 1; return this.L.spread ? c - (c % 2) : c; }

  offsetOf(node, nodeOffset = 0) {
    const r = document.createRange(); r.setStart(this.article, 0);
    try { r.setEnd(node, nodeOffset); } catch { return 0; }
    return r.toString().length;
  }

  applyPage() {
    this.flow.style.transform = `translateX(${-this.page * this.L.stride}px)`;
    this.updateDecor();
    this.pos = { spine: this.chapter, offset: this.pageStartOffset() };
    this.updateStatus();
    this.persist();
  }

  /* ---------------- navigation ---------------- */
  async show(target, dir = 0) {
    const mode = this.settings.turn;
    const old = dir && mode !== 'none' ? this.snapshot() : null;
    await this.place(target);
    if (old) {
      const neu = this.snapshot();
      const blank = this.blankFace();
      this.anim = animateTurn({ layer: this.turnLayer, mode, dir, spread: this.L.spread, pageW: this.L.pageW, oldFaces: old, newFaces: neu, blank });
      await this.anim.finished;
      this.anim = null;
    }
  }

  async place(target) {
    await this.loadChapter(target.spine);
    let page = 0;
    if (target.page === 'last') page = this.lastPage();
    else if (target.page != null) page = Math.min(target.page, this.lastPage());
    else if (target.frag) {
      const el = this.article.querySelector(`#${CSS.escape(target.frag)}`) || this.article.querySelector(`[name="${CSS.escape(target.frag)}"]`);
      if (el) page = this.offsetToPage(this.offsetOf(el, 0) + (el.textContent.trim() ? 0 : 0));
    } else if (target.offset != null) page = this.offsetToPage(target.offset);
    this.page = page;
    this.applyPage();
    if (target.flash) this.flashRange(target.offset, target.offset + target.flash);
  }

  targetFor(dir) {
    const step = this.L.spread ? 2 : 1;
    if (dir > 0) {
      if (this.page + step < this.pageCount) return { spine: this.chapter, page: this.page + step };
      if (this.chapter < this.book.spine.length - 1) return { spine: this.chapter + 1, page: 0 };
    } else {
      if (this.page - step >= 0) return { spine: this.chapter, page: this.page - step };
      if (this.chapter > 0) return { spine: this.chapter - 1, page: 'last' };
    }
    return null;
  }

  /** finger-driven page curl: the leaf follows the drag, then completes or falls back */
  beginDrag(dir, x0) {
    const target = this.targetFor(dir);
    if (!target) { this.nudge(dir); return null; }
    this.hideSelMenu();
    this.busy = true;
    const from = { spine: this.chapter, page: this.page };
    const width = this.L.spread ? this.L.pageW * 1.4 : this.L.pageW * 0.9;
    const drag = { progress: 0, v: 0, lastX: x0, lastT: performance.now() };
    if (dir > 0) this.trackSpeed();
    const old = this.snapshot();
    const ready = this.place(target).then(() => {
      drag.ctl = animateTurn({ layer: this.turnLayer, mode: this.settings.turn, dir, spread: this.L.spread, pageW: this.L.pageW, oldFaces: old, newFaces: this.snapshot(), blank: this.blankFace(), manual: true });
      drag.ctl.setProgress(drag.progress);
    });
    drag.update = (x) => {
      const now = performance.now();
      drag.v = (x - drag.lastX) / Math.max(1, now - drag.lastT); drag.lastX = x; drag.lastT = now;
      drag.progress = Math.max(0, Math.min(1, (dir > 0 ? x0 - x : x - x0) / width));
      drag.ctl?.setProgress(drag.progress);
    };
    drag.end = async (x) => {
      drag.update(x);
      await ready;
      const flick = dir > 0 ? drag.v < -0.35 : drag.v > 0.35;
      const back = dir > 0 ? drag.v > 0.35 : drag.v < -0.35;
      const commit = !back && (drag.progress > 0.28 || flick);
      if (commit) { await drag.ctl.play(); drag.ctl.cleanup(); } else {
        await drag.ctl.reverse();
        await this.place(from);
        drag.ctl.cleanup();
      }
      this.drag = null; this.busy = false; this.lastTurn = Date.now();
    };
    return drag;
  }

  async turn(dir) {
    if (!this.book) return;
    if (this.busy) { this.queued = dir; this.anim?.finish(); return; }
    this.hideSelMenu();
    const target = this.targetFor(dir);
    if (!target) { this.nudge(dir); return; }
    if (dir > 0) this.trackSpeed();
    this.busy = true;
    try { await this.show(target, dir); } finally { this.busy = false; }
    this.lastTurn = Date.now();
    if (this.queued) { const q = this.queued; this.queued = 0; this.turn(q); }
  }

  trackSpeed() {
    const dt = (Date.now() - (this.lastTurn || Date.now())) / 60000;
    const before = this.pos?.offset ?? 0;
    const chars = this.charsOnScreen?.() ?? 0;
    if (dt > 0.05 && dt < 5 && chars > 200) {
      const sample = chars / dt;
      this.speed = Math.max(300, Math.min(4000, this.speed * 0.8 + sample * 0.2));
      this.state.speed = this.speed;
    }
    return before;
  }

  charsOnScreen() {
    const step = this.L.spread ? 2 : 1;
    if (this.page + step >= this.pageCount) return this.tlen - (this.pos?.offset ?? 0);
    const save = this.page; this.page += step;
    const end = this.pageStartOffset(); this.page = save;
    return end - (this.pos?.offset ?? 0);
  }

  nudge(dir) {
    this.bookEl.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-dir * 6}px)` }, { transform: 'translateX(0)' }], { duration: 220, easing: 'ease-out' });
    if (dir > 0) this.toast('The End');
  }

  async jump(target) {
    if (this.pos) {
      this.backPos = { ...this.pos, label: this.currentPageNumber() };
      const jb = this.$('.jump-back');
      jb.hidden = false;
      jb.innerHTML = `<button>${icons.back}<span>Back to page ${this.backPos.label}</span></button>`;
      jb.firstChild.onclick = (e) => { e.stopPropagation(); const p = this.backPos; jb.hidden = true; this.show({ spine: p.spine, offset: p.offset }); };
    }
    this.closePanels();
    await this.show(target);
  }

  followLink(a) {
    const [path, frag] = a.dataset.target.split('#');
    const spine = this.book.spineIndex[path];
    if (spine == null) return;
    const txt = a.textContent.trim();
    const isNote = /noteref/.test(a.dataset.epubType || '') || a.closest('sup') || /^[[(]?(\d{1,3}|[*†‡§])[\])]?$/.test(txt);
    if (isNote && frag) {
      const t = document.createElement('template');
      t.innerHTML = this.book.spine[spine].html;
      const target = t.content.querySelector(`#${CSS.escape(frag)}`);
      const box = target && (target.closest('aside, li, p, dd, div') || target);
      if (box && box.textContent.trim().length < 2000) {
        box.querySelectorAll('.bk-link').forEach((l) => l.replaceWith(...l.childNodes));
        this.showNotePop(`<div class="fn-body">${box.innerHTML}</div><div class="pop-actions"><button class="go">Go to note</button></div>`, a);
        this.$('.notepop .go').onclick = () => this.jump({ spine, frag });
        return;
      }
    }
    this.jump({ spine, frag });
  }

  pageToTarget(p) {
    const m = this.mapOrEstimate();
    let i = m.starts.findIndex((s, k) => p >= s && p < s + m.counts[k]);
    if (i < 0) i = m.counts.length - 1;
    let page = p - m.starts[i];
    if (this.L.spread) page -= page % 2;
    if (this.map) return { spine: i, page };
    return { spine: i, offset: Math.round(this.book.spine[i].chars * (page / m.counts[i])) };
  }

  /* ---------------- whole-book pagination (background) ---------------- */
  mapOrEstimate() {
    if (this.map && this.map.sig === this.sig) return this.map;
    const L = this.L;
    const cpp = Math.max(300, (L.colW / (L.fs * 0.47)) * (L.textH / L.lh) * 0.93);
    const counts = this.book.spine.map((s, i) => (i === this.chapter ? this.pageCount : Math.max(1, Math.round(s.chars / cpp))));
    return this.buildMap(counts, true);
  }

  buildMap(counts, estimate = false) {
    const starts = []; let acc = 0;
    counts.forEach((c) => { starts.push(acc); acc += this.L.spread ? c + (c % 2) : c; });
    return { counts, starts, total: acc, sig: this.sig, estimate, tocPages: new Map(), printMax: 0 };
  }

  async paginateAll() {
    const token = this.pagToken = (this.pagToken || 0) + 1;
    if (!this.book) return;
    await sleep(300);
    const counts = []; const tocPages = new Map(); let printMax = 0;
    const flat = this.book.flatToc;
    const art = this.mArticle;
    for (let i = 0; i < this.book.spine.length; i++) {
      if (token !== this.pagToken || !this.book) return;
      const s = this.book.spine[i];
      art.className = `bk-chapter ${s.bodyClass}`;
      art.innerHTML = s.html;
      prepareArticle(art);
      await waitImages(art, 1500);
      if (token !== this.pagToken) return;
      counts[i] = this.measurePages(this.mFlow);
      const fl = this.mFlow.getBoundingClientRect().left;
      for (const t of flat) {
        if (t.spine !== i || !t.frag) continue;
        const el = art.querySelector(`#${CSS.escape(t.frag)}`);
        if (el) tocPages.set(t, Math.max(0, Math.floor((el.getBoundingClientRect().left - fl + 2) / this.L.stride)));
      }
      art.querySelectorAll('.bk-pagemark').forEach((m) => { const n = parseInt(m.dataset.page, 10); if (n > printMax) printMax = n; });
      if (i % 3 === 2) await sleep(0);
    }
    art.innerHTML = '';
    const map = this.buildMap(counts);
    for (const [t, col] of tocPages) map.tocPages.set(t, map.starts[t.spine] + col);
    map.printMax = printMax;
    this.map = map;
    this.updateDecor(); this.updateStatus();
    if (this.drawerTab === 'toc') this.renderToc();
  }

  /* ---------------- decoration / status ---------------- */
  currentPageNumber(slot = 0) {
    const m = this.mapOrEstimate();
    return (m.starts[this.chapter] ?? 0) + this.page + slot + 1;
  }

  updateDecor() {
    const m = this.mapOrEstimate();
    const S = this.L.spread;
    const ch = this.book.spine[this.chapter];
    this.pages.forEach((pg, slot) => {
      if (slot === 1 && !S) return;
      const col = this.page + slot;
      const exists = col < this.pageCount;
      const opener = (col === 0 && this.article.querySelector('.bk-sink, h1, h2')) || this.article.classList.contains('bk-solo');
      const head = !exists || opener ? '' : (S && slot === 0 ? this.book.title : (ch.title || this.book.title));
      pg.querySelector('.head').textContent = head;
      pg.querySelector('.folio').textContent = exists && !this.article.classList.contains('bk-solo') ? this.currentPageNumber(slot) : '';
    });
    const frac = Math.min(1, ((m.starts[this.chapter] || 0) + this.page) / Math.max(1, m.total));
    const maxEdge = Math.min(16, Math.max(4, m.total / 30));
    this.bookEl.style.setProperty('--edge-l', `${(S ? 1 + maxEdge * frac : 0).toFixed(1)}px`);
    this.bookEl.style.setProperty('--edge-r', `${(1 + maxEdge * (1 - frac)).toFixed(1)}px`);
    const marked = this.isBookmarked();
    this.pages[S ? 1 : 0].classList.toggle('marked', !!marked);
    this.pages[S ? 0 : 1].classList.remove('marked');
    this.$('.act-bm').innerHTML = marked ? icons.bookmarkFill : icons.bookmark;
    const scrub = this.$('.scrub');
    scrub.max = Math.max(0, m.total - 1);
    scrub.value = (m.starts[this.chapter] || 0) + this.page;
  }

  printPage() {
    if (!this.pageMarks) {
      this.pageMarks = [...this.article.querySelectorAll('.bk-pagemark')].map((m) => ({ off: this.offsetOf(m, 0), label: m.dataset.page }));
    }
    if (!this.pageMarks.length) return null;
    const off = this.pos?.offset ?? 0;
    let label = null;
    for (const pm of this.pageMarks) { if (pm.off <= off + 1) label = pm.label; else break; }
    if (label == null) {
      // look backwards in previous chapters is costly; use first mark minus one
      const first = parseInt(this.pageMarks[0].label, 10);
      label = Number.isFinite(first) ? String(Math.max(1, first - 1)) : this.pageMarks[0].label;
    }
    return label;
  }

  updateStatus() {
    if (!this.book || !this.pos) return;
    const m = this.mapOrEstimate();
    const abs = this.book.spine[this.chapter].start + this.pos.offset;
    const pct = Math.min(100, Math.round((abs / Math.max(1, this.book.totalChars)) * 100));
    const left = this.$('.status-left');
    const mode = STATUS[this.settings.status];
    const ch = this.book.spine[this.chapter];
    let txt = '';
    if (mode === 'page') {
      const pp = this.printPage();
      txt = pp && this.map?.printMax ? `Page ${pp} of ${this.map.printMax}` : `Page ${this.currentPageNumber()} of ${m.total}${m.estimate ? '' : ''}`;
    } else if (mode === 'loc') txt = `Location ${Math.floor(abs / 150) + 1} of ${Math.ceil(this.book.totalChars / 150)}`;
    else if (mode === 'chapter') txt = `${fmtTime((ch.chars - this.pos.offset) / this.speed)} left in chapter`;
    else if (mode === 'book') txt = `${fmtTime((this.book.totalChars - abs) / this.speed)} left in book`;
    left.textContent = txt || ' ';
    this.$('.status-right').textContent = `${pct}%`;
    this.$('.scrub-left').textContent = ch.title || '';
    this.$('.scrub-right').textContent = `Page ${this.currentPageNumber()} of ${m.total} · ${pct}%`;
    this.progress = abs / Math.max(1, this.book.totalChars);
  }

  updateClock() {
    const d = new Date();
    this.$('.clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /* ---------------- snapshots for animations ---------------- */
  snapshot() {
    const faces = [];
    const slots = this.L.spread ? [0, 1] : [0];
    for (const slot of slots) {
      const face = this.pages[slot].cloneNode(true);
      face.classList.add('face');
      const fvp = document.createElement('div');
      fvp.className = `face-text slot${slot}`;
      const fc = this.flow.cloneNode(true);
      fc.style.transform = `translateX(${-(this.page + slot) * this.L.stride}px)`;
      fc.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      fvp.appendChild(fc);
      face.insertBefore(fvp, face.querySelector('.shade'));
      faces.push(face);
    }
    return faces;
  }

  blankFace() {
    const face = this.pages[0].cloneNode(true);
    face.classList.add('face', 'blank-face');
    face.querySelector('.head').textContent = ''; face.querySelector('.folio').textContent = '';
    return face;
  }

  /* ---------------- settings ---------------- */
  set(key, value) {
    this.settings[key] = value;
    saveSettings(this.settings);
    this.applySettings(true, key);
    this.renderSettings();
  }

  async applySettings(relayout = true, key) {
    const S = this.settings;
    const r = this.root;
    THEMES.forEach(([t]) => r.classList.toggle(`theme-${t}`, S.theme === t));
    document.documentElement.dataset.readerTheme = S.theme;
    r.classList.toggle('no-texture', !S.texture);
    r.classList.toggle('no-ornaments', !S.ornaments);
    r.classList.toggle('align-left', S.align === 'left');
    r.classList.toggle('no-hyphens', !S.hyphens);
    this.pubStyle.disabled = !S.publisher;
    if (this.pubStyle.sheet) this.pubStyle.sheet.disabled = !S.publisher;
    r.style.setProperty('--warmth', S.warmth);
    r.style.setProperty('--dim', (1 - S.light).toFixed(2));
    if (relayout && this.book && !['theme', 'warmth', 'light', 'texture', 'turn'].includes(key)) {
      if (key === 'font') await this.fontsReady();
      await this.relayout();
    }
  }

  toggleSettings() {
    const sh = this.$('.settings');
    const open = !sh.classList.contains('open');
    this.closePanels();
    if (open) { this.renderSettings(); sh.classList.add('open'); sh.setAttribute('aria-hidden', 'false'); this.$('.scrim').hidden = false; this.$('.scrim').classList.add('light'); }
  }

  renderSettings() {
    const S = this.settings;
    const sh = this.$('.settings');
    const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, label, extra = '']) => `<button data-v="${v}" class="${String(S[key]) === String(v) ? 'on' : ''}" ${extra}>${label}</button>`).join('')}</div>`;
    const lines = (n) => `<span class="lines">${Array.from({ length: 3 }, () => `<i style="margin:${n}px 0"></i>`).join('')}</span>`;
    const marg = (n) => `<span class="marg" style="padding:0 ${n}px"><i></i><i></i><i></i></span>`;
    sh.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="sheet-tabs"><span>Display</span></div>
      <div class="set-row"><label>Font</label>
        <div class="fonts">${Object.keys(FONTS).map((f) => `<button data-font="${f}" class="${S.font === f ? 'on' : ''}" style="font-family:${FONTS[f].stack.replace(/"/g, "'")}"><b>Aa</b><span>${f}</span></button>`).join('')}</div></div>
      <div class="set-row"><label>Size</label>
        <div class="size"><button class="sz-dn" style="font-size:13px">A</button>
          <div class="dots">${SIZES.map((_, i) => `<i class="${i <= S.size ? 'on' : ''}" data-i="${i}"></i>`).join('')}</div>
          <button class="sz-up" style="font-size:24px">A</button></div></div>
      <div class="set-row"><label>Boldness</label>${seg('weight', WEIGHTS.map((w, i) => [i, `<span style="font-family:${(FONTS[S.font] || FONTS.Literata).stack.replace(/"/g, "'")};font-weight:${w};font-size:17px">Aa</span>`]))}</div>
      <div class="set-row two">
        <div><label>Spacing</label>${seg('spacing', [[0, lines(1)], [1, lines(2)], [2, lines(3)], [3, lines(4)]])}</div>
        <div><label>Margins</label>${seg('margins', [[0, marg(2)], [1, marg(5)], [2, marg(8)], [3, marg(11)]])}</div>
      </div>
      <div class="set-row two">
        <div><label>Alignment</label>${seg('align', [['justify', 'Justified'], ['left', 'Left']])}</div>
        <div><label>Layout</label>${seg('spread', [['auto', 'Two pages'], ['single', 'One page']])}</div>
      </div>
      <div class="set-row"><label>Theme</label>
        <div class="themes">${THEMES.map(([t, n]) => `<button data-theme="${t}" class="sw sw-${t} ${S.theme === t ? 'on' : ''}"><span>Aa</span><em>${n}</em></button>`).join('')}</div></div>
      <div class="set-row"><label>Page turn</label>${seg('turn', [['curl', 'Page curl'], ['slide', 'Slide'], ['eink', 'E‑ink'], ['none', 'Instant']])}</div>
      <div class="set-row"><label>Front light</label>
        <div class="slider-row">${icons.sun}<input type="range" class="r-light" min="0.35" max="1" step="0.01" value="${S.light}"></div>
        <label>Warmth</label>
        <div class="slider-row"><span class="warm-cool">☾</span><input type="range" class="r-warm" min="0" max="1" step="0.01" value="${S.warmth}"><span class="warm-hot">☀</span></div></div>
      <div class="set-row toggles">
        ${[['texture', 'Paper texture'], ['ornaments', 'Drop caps & ornaments'], ['hyphens', 'Hyphenation'], ['publisher', 'Publisher styles']].map(([k, n]) => `<label class="tog"><input type="checkbox" data-k="${k}" ${S[k] ? 'checked' : ''}><span></span>${n}</label>`).join('')}
      </div>`;
    sh.querySelectorAll('[data-font]').forEach((b) => { b.onclick = () => this.set('font', b.dataset.font); });
    sh.querySelector('.sz-dn').onclick = () => this.set('size', Math.max(0, S.size - 1));
    sh.querySelector('.sz-up').onclick = () => this.set('size', Math.min(SIZES.length - 1, S.size + 1));
    sh.querySelectorAll('.dots i').forEach((d) => { d.onclick = () => this.set('size', +d.dataset.i); });
    sh.querySelectorAll('.seg').forEach((sg) => sg.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { const v = b.dataset.v; this.set(sg.dataset.key, /^\d+$/.test(v) ? +v : v); };
    }));
    sh.querySelectorAll('[data-theme]').forEach((b) => { b.onclick = () => this.set('theme', b.dataset.theme); });
    sh.querySelector('.r-light').oninput = (e) => { S.light = +e.target.value; this.applySettings(false); saveSettings(S); };
    sh.querySelector('.r-warm').oninput = (e) => { S.warmth = +e.target.value; this.applySettings(false); saveSettings(S); };
    sh.querySelectorAll('.tog input').forEach((c) => { c.onchange = () => this.set(c.dataset.k, c.checked); });
  }

  /* ---------------- chrome / panels ---------------- */
  setChrome(on) {
    this.chromeOn = on;
    this.root.classList.toggle('chrome-on', on);
    this.root.classList.remove('peek-top', 'peek-bottom');
    if (on) {
      this.updateStatus();
      this.hideCoach();
    }
  }

  /** Every time a book opens: the shortcuts card plus both edge hints, gone after a few
   *  seconds or the first tap/key — unless the reader chose "Don't show again". */
  maybeCoach() {
    try { if (localStorage.getItem(COACH_KEY) === 'off') return; } catch { /* storage blocked: show it */ }
    this.showCoach(9000);
  }

  /** The shortcuts card (also on "?"). `ms` = auto-hide after; 0 = stay until a tap or key. */
  showCoach(ms = 0) {
    const coach = this.$('.coach');
    coach.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('coaching'));
    clearTimeout(this.coachTimer);
    if (ms) this.coachTimer = setTimeout(() => this.hideCoach(), ms);
  }

  hideCoach() {
    clearTimeout(this.coachTimer);
    if (!this.root.classList.contains('coaching')) return;
    this.root.classList.remove('coaching');
    setTimeout(() => { if (!this.root.classList.contains('coaching')) this.$('.coach').hidden = true; }, 300);
  }

  closePanels() {
    let closed = false;
    const sh = this.$('.settings');
    if (sh.classList.contains('open')) { sh.classList.remove('open'); sh.setAttribute('aria-hidden', 'true'); closed = true; }
    const dr = this.$('.drawer');
    if (dr.classList.contains('open')) { dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true'); this.drawerTab = null; closed = true; }
    if (!this.$('.selmenu').hidden || !this.$('.notepop').hidden) { this.hideSelMenu(); this.$('.notepop').hidden = true; closed = true; }
    this.$('.scrim').hidden = true; this.$('.scrim').classList.remove('light');
    return closed;
  }

  openDrawer(tab) {
    const dr = this.$('.drawer');
    this.$('.settings').classList.remove('open');
    this.hideSelMenu();
    this.drawerTab = tab;
    dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
    this.$('.scrim').hidden = false;
    this.root.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    this.root.querySelectorAll('.tab-body').forEach((b) => { b.hidden = !b.classList.contains(`tab-${tab}`); });
    if (tab === 'toc') this.renderToc();
    if (tab === 'notes') this.renderNotes();
    if (tab === 'search') setTimeout(() => this.$('.search-form input').focus(), 50);
  }

  renderToc() {
    const m = this.mapOrEstimate();
    const box = this.$('.tab-toc');
    const items = this.book.flatToc.length ? this.book.flatToc : this.book.spine.map((s, i) => ({ label: s.title || `Section ${i + 1}`, spine: i, frag: '', depth: 0 }));
    let current = null;
    for (const t of items) { if (t.spine >= 0 && t.spine <= this.chapter) current = t; }
    box.innerHTML = `<ol class="toc">${items.map((t, i) => {
      const pg = t.spine < 0 ? '' : (m.tocPages?.get(t) ?? m.starts[t.spine]) + 1;
      return `<li class="d${Math.min(t.depth, 3)} ${t === current ? 'cur' : ''}" data-i="${i}"><span class="lbl">${esc(t.label)}</span><span class="pg">${pg}</span></li>`;
    }).join('')}</ol>`;
    box.querySelectorAll('li').forEach((li) => {
      li.onclick = () => { const t = items[+li.dataset.i]; if (t.spine >= 0) this.jump({ spine: t.spine, frag: t.frag }); };
    });
    box.querySelector('.cur')?.scrollIntoView({ block: 'center' });
  }

  renderNotes() {
    const box = this.$('.tab-notes');
    const hls = [...this.state.highlights].sort((a, b) => a.spine - b.spine || a.start - b.start);
    const bms = [...this.state.bookmarks].sort((a, b) => a.spine - b.spine || a.offset - b.offset);
    if (!hls.length && !bms.length) {
      box.innerHTML = '<div class="empty"><p>Your notebook is empty.</p><p class="hint">Select text to highlight it or add a note. Tap the top‑right corner of a page to bookmark it.</p></div>';
      return;
    }
    const pct = (spine, off) => Math.round(((this.book.spine[spine].start + off) / this.book.totalChars) * 100);
    box.innerHTML = `
      ${bms.length ? `<h4>Bookmarks</h4><ul class="nb">${bms.map((b) => `<li data-bm="${b.id}"><div class="nb-meta">${icons.bookmarkFill}<span>${esc(this.book.spine[b.spine].title)} · ${pct(b.spine, b.offset)}%</span><button class="del" title="Remove">${icons.trash}</button></div><div class="nb-text">${esc(b.snippet)}</div></li>`).join('')}</ul>` : ''}
      ${hls.length ? `<h4>Highlights & notes</h4><ul class="nb">${hls.map((x) => `<li data-hl="${x.id}"><div class="nb-meta"><i class="chip c-${x.color}"></i><span>${esc(this.book.spine[x.spine].title)} · ${pct(x.spine, x.start)}%</span><button class="del" title="Delete">${icons.trash}</button></div><blockquote class="nb-text">${esc(x.text)}</blockquote>${x.note ? `<div class="nb-note">${icons.note}<span>${esc(x.note)}</span></div>` : ''}</li>`).join('')}</ul>` : ''}`;
    box.querySelectorAll('li[data-hl]').forEach((li) => {
      const x = this.state.highlights.find((y) => y.id === li.dataset.hl);
      li.onclick = (e) => { if (e.target.closest('.del')) { this.removeHighlight(x.id); this.renderNotes(); return; } this.jump({ spine: x.spine, offset: x.start }); };
    });
    box.querySelectorAll('li[data-bm]').forEach((li) => {
      const b = this.state.bookmarks.find((y) => y.id === li.dataset.bm);
      li.onclick = (e) => { if (e.target.closest('.del')) { this.state.bookmarks = this.state.bookmarks.filter((y) => y !== b); this.persist(); this.updateDecor(); this.renderNotes(); return; } this.jump({ spine: b.spine, offset: b.offset }); };
    });
  }

  /* ---------------- search ---------------- */
  chapterText(i) {
    if (!this.textCache.has(i)) {
      const t = document.createElement('template'); t.innerHTML = this.book.spine[i].html;
      this.textCache.set(i, t.content.textContent);
    }
    return this.textCache.get(i);
  }

  async runSearch(q) {
    q = q.trim();
    const box = this.$('.search-results');
    if (q.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="empty">Searching…</div>';
    await nextFrame();
    const ql = q.toLowerCase(); const results = [];
    for (let i = 0; i < this.book.spine.length && results.length < 300; i++) {
      const txt = this.chapterText(i); const low = txt.toLowerCase();
      for (let k = low.indexOf(ql); k >= 0 && results.length < 300; k = low.indexOf(ql, k + ql.length)) {
        const a = Math.max(0, k - 50); const b = Math.min(txt.length, k + ql.length + 70);
        results.push({ spine: i, offset: k, snippet: [txt.slice(a, k), txt.slice(k, k + ql.length), txt.slice(k + ql.length, b)] });
      }
    }
    if (!results.length) { box.innerHTML = `<div class="empty">No results for “${esc(q)}”.</div>`; return; }
    let lastSpine = -1;
    box.innerHTML = `<div class="res-count">${results.length}${results.length >= 300 ? '+' : ''} results</div>` + results.map((r, i) => {
      const head = r.spine !== lastSpine ? `<h4>${esc(this.book.spine[r.spine].title)}</h4>` : '';
      lastSpine = r.spine;
      const [pre, hit, post] = r.snippet.map((s) => esc(s.replace(/\s+/g, ' ')));
      return `${head}<button class="res" data-i="${i}">…${pre}<mark>${hit}</mark>${post}…</button>`;
    }).join('');
    box.querySelectorAll('.res').forEach((b) => { b.onclick = () => { const r = results[+b.dataset.i]; this.jump({ spine: r.spine, offset: r.offset, flash: ql.length }); }; });
  }

  flashRange(start, end) {
    const marks = this.wrapOffsets(start, end, () => Object.assign(document.createElement('mark'), { className: 'bk-flash' }));
    this.indexText();
    setTimeout(() => {
      marks.forEach((m) => m.replaceWith(...m.childNodes));
      this.article.normalize(); this.indexText();
    }, 2200);
  }

  /* ---------------- highlights ---------------- */
  wrapOffsets(start, end, make) {
    const out = [];
    for (const t of [...this.tnodes]) {
      if (t.start + t.len <= start || t.start >= end) continue;
      if (!t.vis && !/\S/.test(t.n.data)) continue;
      const p = t.n.parentElement;
      if (p && /^(TABLE|TBODY|THEAD|TR|UL|OL|DL|svg)$/i.test(p.tagName)) continue;
      const s = Math.max(start, t.start) - t.start; const e = Math.min(end, t.start + t.len) - t.start;
      let node = t.n;
      if (e < node.data.length) node.splitText(e);
      if (s > 0) node = node.splitText(s);
      const m = make(); node.parentNode.insertBefore(m, node); m.appendChild(node); out.push(m);
    }
    return out;
  }

  applyHighlights() {
    const list = this.state.highlights.filter((x) => x.spine === this.chapter);
    for (const x of list) {
      this.wrapOffsets(x.start, x.end, () => {
        const m = document.createElement('mark');
        m.className = `bk-hl c-${x.color}${x.note ? ' has-note' : ''}`; m.dataset.hl = x.id; return m;
      });
      this.indexText();
    }
  }

  redrawHighlights() {
    this.article.querySelectorAll('mark.bk-hl').forEach((m) => m.replaceWith(...m.childNodes));
    this.article.normalize();
    this.indexText();
    this.applyHighlights();
  }

  selectionOffsets() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!this.article.contains(r.commonAncestorContainer)) return null;
    const start = this.offsetOf(r.startContainer, r.startOffset);
    const end = this.offsetOf(r.endContainer, r.endOffset);
    const text = r.toString().trim();
    if (!text || end <= start) return null;
    return { start, end, text, rect: r.getBoundingClientRect() };
  }

  maybeSelMenu() {
    const s = this.selectionOffsets();
    if (!s) { if (!this.hlMenuOpen) this.hideSelMenu(); return; }
    this.pendingSel = s;
    const single = /^[\p{L}'’-]+$/u.test(s.text);
    this.showMenu(s.rect, `
      <div class="hl-row">${HL_COLORS.map((c) => `<button class="hlc c-${c}" data-c="${c}" title="Highlight ${c}"></button>`).join('')}</div>
      <div class="menu-row">
        <button data-a="note">${icons.note}<span>Note</span></button>
        <button data-a="copy">${icons.copy}<span>Copy</span></button>
        ${single ? `<button data-a="define">${icons.book}<span>Define</span></button>` : ''}
        <button data-a="search">${icons.search}<span>Search</span></button>
      </div>`, (a, c) => {
      if (c) { this.addHighlight(s, c); return; }
      if (a === 'note') { const x = this.addHighlight(s, 'yellow'); this.editNote(x); }
      if (a === 'copy') { navigator.clipboard?.writeText(s.text); this.toast('Copied'); this.hideSelMenu(); getSelection().removeAllRanges(); }
      if (a === 'define') this.define(s.text, s.rect);
      if (a === 'search') { getSelection().removeAllRanges(); this.openDrawer('search'); this.$('.search-form input').value = s.text; this.runSearch(s.text); }
    });
  }

  showMenu(rect, html, onAction) {
    const menu = this.$('.selmenu');
    menu.innerHTML = html; menu.hidden = false;
    const mw = menu.offsetWidth; const mh = menu.offsetHeight;
    let x = rect.left + rect.width / 2 - mw / 2; let y = rect.top - mh - 12;
    let below = false;
    if (y < 40) { y = rect.bottom + 12; below = true; }
    x = Math.max(8, Math.min(innerWidth - mw - 8, x));
    menu.style.left = `${x}px`; menu.style.top = `${y}px`;
    menu.classList.toggle('below', below);
    menu.querySelectorAll('button').forEach((b) => {
      b.onpointerdown = (e) => e.preventDefault();
      b.onclick = (e) => { e.stopPropagation(); onAction(b.dataset.a, b.dataset.c); };
    });
  }

  hideSelMenu() { this.$('.selmenu').hidden = true; this.hlMenuOpen = false; }

  addHighlight(s, color) {
    const x = { id: uid(), spine: this.chapter, start: s.start, end: s.end, color, text: s.text, note: '', created: Date.now() };
    // merge with overlapping highlights
    const overl = this.state.highlights.filter((y) => y.spine === x.spine && y.start < x.end && y.end > x.start);
    for (const y of overl) { x.start = Math.min(x.start, y.start); x.end = Math.max(x.end, y.end); x.note ||= y.note; }
    if (overl.length) x.text = this.chapterText(x.spine).slice(x.start, x.end).trim();
    this.state.highlights = this.state.highlights.filter((y) => !overl.includes(y)).concat(x);
    getSelection().removeAllRanges();
    this.hideSelMenu();
    this.redrawHighlights();
    this.persist();
    return x;
  }

  removeHighlight(id) {
    this.state.highlights = this.state.highlights.filter((y) => y.id !== id);
    this.redrawHighlights(); this.persist(); this.hideSelMenu();
  }

  showHighlightMenu(id, mark) {
    const x = this.state.highlights.find((y) => y.id === id);
    if (!x) return;
    this.hlMenuOpen = true;
    const rect = mark.getBoundingClientRect();
    this.showMenu(rect, `
      <div class="hl-row">${HL_COLORS.map((c) => `<button class="hlc c-${c} ${c === x.color ? 'on' : ''}" data-c="${c}"></button>`).join('')}</div>
      ${x.note ? `<div class="menu-note">${esc(x.note)}</div>` : ''}
      <div class="menu-row">
        <button data-a="note">${icons.note}<span>${x.note ? 'Edit note' : 'Note'}</span></button>
        <button data-a="copy">${icons.copy}<span>Copy</span></button>
        <button data-a="del">${icons.trash}<span>Delete</span></button>
      </div>`, (a, c) => {
      if (c) { x.color = c; this.redrawHighlights(); this.persist(); this.hideSelMenu(); }
      if (a === 'note') this.editNote(x);
      if (a === 'copy') { navigator.clipboard?.writeText(x.text); this.toast('Copied'); this.hideSelMenu(); }
      if (a === 'del') this.removeHighlight(x.id);
    });
  }

  editNote(x) {
    this.hideSelMenu();
    const mark = this.article.querySelector(`mark[data-hl="${x.id}"]`);
    this.showNotePop(`<div class="note-edit"><div class="note-quote">${esc(x.text.slice(0, 160))}${x.text.length > 160 ? '…' : ''}</div>
      <textarea rows="4" placeholder="Add a note…">${esc(x.note || '')}</textarea>
      <div class="pop-actions"><button class="cancel">Cancel</button><button class="save primary">Save</button></div></div>`, mark);
    const pop = this.$('.notepop');
    const ta = pop.querySelector('textarea'); ta.focus();
    pop.querySelector('.cancel').onclick = () => { pop.hidden = true; };
    pop.querySelector('.save').onclick = () => { x.note = ta.value.trim(); this.redrawHighlights(); this.persist(); pop.hidden = true; this.toast(x.note ? 'Note saved' : 'Note removed'); };
  }

  showNotePop(html, anchor) {
    const pop = this.$('.notepop');
    pop.innerHTML = html; pop.hidden = false;
    const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3, width: 0 };
    const pw = pop.offsetWidth; const ph = pop.offsetHeight;
    let x = r.left + r.width / 2 - pw / 2; let y = r.bottom + 10;
    if (y + ph > innerHeight - 10) y = Math.max(10, r.top - ph - 10);
    pop.style.left = `${Math.max(10, Math.min(innerWidth - pw - 10, x))}px`; pop.style.top = `${y}px`;
  }

  async define(word, rect) {
    word = word.replace(/[’']s$/, '').toLowerCase();
    getSelection().removeAllRanges(); this.hideSelMenu();
    const anchor = { getBoundingClientRect: () => rect };
    this.showNotePop(`<div class="dict"><div class="dict-word">${esc(word)}</div><div class="dict-body">Looking up…</div></div>`, anchor);
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (!res.ok) throw new Error('nf');
      const data = await res.json();
      const e = data[0];
      const phon = e.phonetic || e.phonetics?.find((p) => p.text)?.text || '';
      const body = e.meanings.slice(0, 3).map((m) => `<div class="dict-pos">${esc(m.partOfSpeech)}</div><ol>${m.definitions.slice(0, 2).map((d) => `<li>${esc(d.definition)}${d.example ? `<div class="dict-ex">“${esc(d.example)}”</div>` : ''}</li>`).join('')}</ol>`).join('');
      this.showNotePop(`<div class="dict"><div class="dict-word">${esc(e.word)} <span class="dict-phon">${esc(phon)}</span></div><div class="dict-body">${body}</div>
        <div class="pop-actions"><a href="https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(word)}" target="_blank" rel="noopener">Wikipedia ↗</a></div></div>`, anchor);
    } catch {
      this.$('.notepop .dict-body').innerHTML = 'No definition found (dictionary needs an internet connection).';
    }
  }

  /* ---------------- bookmarks ---------------- */
  visibleRange() {
    const start = this.pos?.offset ?? 0;
    const step = this.L.spread ? 2 : 1;
    let end = this.tlen;
    if (this.page + step < this.pageCount) { const sv = this.page; this.page += step; end = this.pageStartOffset(); this.page = sv; }
    return [start, end];
  }

  isBookmarked() {
    if (!this.state?.bookmarks?.length || !this.tnodes) return null;
    const list = this.state.bookmarks.filter((b) => b.spine === this.chapter);
    if (!list.length) return null;
    const [a, b] = this.visibleRange();
    return list.find((x) => x.offset >= a && (x.offset < b || (b === this.tlen && x.offset <= b))) || null;
  }

  toggleBookmark() {
    const ex = this.isBookmarked();
    if (ex) { this.state.bookmarks = this.state.bookmarks.filter((b) => b !== ex); this.toast('Bookmark removed'); } else {
      const txt = this.chapterText(this.chapter);
      const off = this.pos.offset;
      this.state.bookmarks.push({ id: uid(), spine: this.chapter, offset: off, snippet: txt.slice(off, off + 140).replace(/\s+/g, ' ').trim() + '…', created: Date.now() });
      this.toast('Page bookmarked');
    }
    this.updateDecor(); this.persist();
  }

  /* ---------------- misc ---------------- */
  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  toast(msg) {
    const t = this.$('.toast');
    t.textContent = msg; t.hidden = false; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(this.toastT); this.toastT = setTimeout(() => { t.hidden = true; }, 1800);
  }

  persist(now = false) {
    clearTimeout(this.persistT);
    const go = async () => {
      if (!this.state || !this.meta) return;
      this.state.pos = this.pos; this.state.updated = Date.now();
      await store.putState(this.state);
      this.meta.progress = this.progress || 0; this.meta.lastOpened = Date.now();
      const { coverUrl, ...meta } = this.meta;
      await store.putBook(meta);
    };
    if (now) return go();
    this.persistT = setTimeout(go, 500);
    return null;
  }
}
