import { parseEpub } from './epub.js';
import { store } from './store.js';
import { Reader } from './reader.js';
import { icons } from './icons.js';
import { initDiscover } from './discover.js';
import { library, addBookToLibrary, isDesktop } from './library.js';
import { buildModel, suggestCategory } from './categorize.js';

const lib = document.getElementById('library');
const readerRoot = document.getElementById('reader');
const shelf = lib.querySelector('.shelf');
const fileInput = document.getElementById('file');
const status = lib.querySelector('.lib-status');
const heroText = lib.querySelector('.lib-hero p');

const reader = new Reader(readerRoot, {
  onClose: () => { lib.hidden = false; history.replaceState(null, '', location.pathname); refresh(); },
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hue = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const genCover = (b) => `<div class="gen-cover"><div class="gc-title">${esc(b.title)}</div><div class="gc-rule"></div><div class="gc-author">${esc(b.author)}</div></div>`;

let entries = [];

/* ---------- shelf: search, categories, sort ---------- */
const UNCAT = 'Uncategorized';
const VIEW_KEY = 'paperback.libview';
const view = { q: '', cat: 'all', sort: 'recent' };
try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); if (v.cat) view.cat = v.cat; if (v.sort) view.sort = v.sort; } catch { /* storage blocked */ }
const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ cat: view.cat, sort: view.sort })); } catch { /* storage blocked */ } };
let cats = { books: {}, order: [], checked: [] };
const coverCache = new Map(); // id -> url ('' = none), so redraws while typing don't flicker
const catOf = (b) => cats.books[b.id] || UNCAT;
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const ico = {
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12.2V4.8c0-.7.6-1.3 1.3-1.3h7.4l8.3 8.3a1.3 1.3 0 0 1 0 1.8l-7.4 7.4a1.3 1.3 0 0 1-1.8 0z"/><circle cx="8.2" cy="8.2" r="1.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5A8 8 0 0 0 5.6 7M4 4v4h4M4 12.5A8 8 0 0 0 18.4 17M20 20v-4h-4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 6.5c0-.8.7-1.5 1.5-1.5h4.4l2 2.2H19c.8 0 1.5.7 1.5 1.5v9.3c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

// Search lives in the header so it's always in reach; chips + sort sit above the shelf.
const searchBox = document.createElement('label');
searchBox.className = 'lib-search';
searchBox.innerHTML = `${icons.search}
  <input type="search" placeholder="Search your library" aria-label="Search titles, authors, categories and descriptions" autocomplete="off" spellcheck="false">
  <kbd>/</kbd>`;
lib.querySelector('.lib-actions').before(searchBox);

const tools = document.createElement('section');
tools.className = 'lib-tools';
tools.innerHTML = `
  <div class="lib-cats" role="group" aria-label="Filter by category"></div>
  <label class="lib-sort-wrap"><span>Sort</span>
    <select class="lib-sort" aria-label="Sort books">
      <option value="recent">Recently read</option>
      <option value="added">Recently added</option>
      <option value="title">Title</option>
      <option value="author">Author</option>
      <option value="progress">Progress</option>
    </select>
  </label>`;
lib.querySelector('.lib-hero').after(tools);
const continueRow = document.createElement('section');
continueRow.className = 'lib-continue';
continueRow.hidden = true;
lib.querySelector('.lib-hero').after(continueRow);
const searchInput = searchBox.querySelector('input');
const sortSel = tools.querySelector('.lib-sort');
const catBar = tools.querySelector('.lib-cats');
sortSel.value = view.sort;
let typing;
searchInput.oninput = () => { clearTimeout(typing); typing = setTimeout(() => { view.q = searchInput.value; renderShelf(); }, 80); };
searchInput.onkeydown = (e) => { if (e.key === 'Escape') { searchInput.value = ''; view.q = ''; renderShelf(); searchInput.blur(); } };
sortSel.onchange = () => { view.sort = sortSel.value; saveView(); renderShelf(); };
catBar.onclick = (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  view.cat = b.dataset.cat; saveView(); renderShelf();
};
document.addEventListener('keydown', (e) => {
  if (lib.hidden || e.key !== '/' || e.target.closest('input, textarea, select, [contenteditable]')) return;
  e.preventDefault(); searchInput.focus(); searchInput.select();
});

/** Category names in display order: saved order first, then any others A–Z, Uncategorized last. */
function categoryList() {
  const used = new Set(entries.map(catOf));
  const list = cats.order.filter((c) => used.has(c));
  for (const c of [...used].sort((a, b) => a.localeCompare(b))) if (!list.includes(c) && c !== UNCAT) list.push(c);
  if (used.has(UNCAT)) list.push(UNCAT);
  return list;
}

/** All query words must match somewhere; title hits rank above author, category, then description. */
function score(b, words) {
  const t = fold(b.title); const a = fold(b.author); const c = fold(catOf(b)); const d = fold(b.description);
  let s = 0;
  for (const w of words) {
    if (t.startsWith(w)) s += 8; else if (t.includes(w)) s += 5;
    else if (a.includes(w)) s += 4;
    else if (c.includes(w)) s += 3;
    else if (d.includes(w)) s += 1;
    else return 0;
  }
  return s;
}

const sorters = {
  recent: (a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added),
  added: (a, b) => b.added - a.added,
  title: (a, b) => a.title.localeCompare(b.title),
  author: (a, b) => (a.author || '').localeCompare(b.author || '') || a.title.localeCompare(b.title),
  progress: (a, b) => (b.progress || 0) - (a.progress || 0) || sorters.recent(a, b),
};

const WEEK = 7 * 864e5;
const coverHtml = (b) => { const url = coverCache.get(b.id); return url ? `<img src="${esc(url)}" alt="" loading="lazy">` : genCover(b); };
const isFresh = (b) => !b.progress && b.added && Date.now() - b.added < WEEK;
const pct = (b) => Math.round((b.progress || 0) * 100);

/** One book. `showCat`: print the shelf name (flat views only; in grouped view the heading says it). */
const card = (b, showCat = false) => {
  const p = pct(b);
  const meta = p >= 99 ? '<span class="done">Finished</span>' : p ? `<span>${p}%</span>` : '';
  return `
    <article class="vol" data-id="${esc(b.id)}" tabindex="0" title="${esc(b.description ? b.description.slice(0, 300) : b.title)}">
      <div class="vol-cover" style="--h:${hue(b.title)}">
        ${coverHtml(b)}
        <div class="vol-spine"></div>
        ${p && p < 99 ? '<div class="vol-ribbon"></div>' : ''}
        ${isFresh(b) ? '<div class="vol-new" title="Added this week" aria-label="New"></div>' : ''}
        <div class="vol-actions">
          <button class="vol-cat" title="Move to another shelf" aria-label="Change category">${ico.tag}</button>
          <button class="vol-del" title="Remove from library" aria-label="Remove from library">${icons.trash}</button>
        </div>
      </div>
      <div class="vol-info">
        <div class="vol-title">${esc(b.title)}</div>
        <div class="vol-author">${esc(b.author || 'Unknown author')}</div>
        ${p && p < 99 ? `<div class="vol-progress"><i style="width:${p}%"></i></div>` : ''}
        ${meta || showCat ? `<div class="vol-meta">${showCat ? `<span class="vol-shelf">${esc(catOf(b))}</span>` : ''}${meta}</div>` : ''}
      </div>
    </article>`;
};

/** "Continue reading": started, not finished, most recent first. */
function renderContinue(show) {
  const reading = show ? entries.filter((b) => b.progress > 0 && pct(b) < 99).sort(sorters.recent).slice(0, 4) : [];
  continueRow.hidden = !reading.length;
  continueRow.innerHTML = reading.length ? `
    <h2 class="sec-title">Continue reading</h2>
    <div class="cont-row">${reading.map((b) => `
      <button class="cont" data-id="${esc(b.id)}">
        <span class="cont-cover" style="--h:${hue(b.title)}">${coverHtml(b)}</span>
        <span class="cont-body">
          <span class="cont-title">${esc(b.title)}</span>
          <span class="cont-author">${esc(b.author || '')}</span>
          <span class="cont-bar"><i style="width:${pct(b)}%"></i></span>
          <span class="cont-meta">${pct(b)}% · Resume ${ico.arrow}</span>
        </span>
      </button>`).join('')}</div>` : '';
  continueRow.querySelectorAll('.cont').forEach((c) => { c.onclick = () => openBook(c.dataset.id); });
}

/** Hero subtitle: a quiet summary (folder problems take over this line instead). */
function renderStats() {
  if (isDesktop && (folderInfo.error || !folderInfo.dir)) return;
  const reading = entries.filter((b) => b.progress > 0 && pct(b) < 99).length;
  const done = entries.filter((b) => pct(b) >= 99).length;
  const shelves = categoryList().filter((c) => c !== UNCAT).length;
  const bits = [`${entries.length} book${entries.length === 1 ? '' : 's'}`];
  if (shelves) bits.push(`${shelves} shelves`);
  if (reading) bits.push(`${reading} in progress`);
  if (done) bits.push(`${done} finished`);
  heroText.innerHTML = bits.map((s) => `<span>${s}</span>`).join('');
}

/** Reload the catalogue and categories, then draw. */
async function renderLibrary() {
  [entries, cats] = await Promise.all([library.entries(), library.categories().catch(() => ({ books: {}, order: [], checked: [] }))]);
  cats.checked ||= [];
  lib.classList.toggle('empty', !entries.length);
  renderShelf();
  promptNewBooks(); // not awaited: the shelf stays usable behind the dialog
}

/** Every category you can pick: shelves in use, then remembered ones (never "Uncategorized"). */
function allCategoryNames() {
  const names = categoryList().filter((c) => c !== UNCAT);
  for (const c of cats.order) if (!names.includes(c)) names.push(c);
  return names;
}

/** Draw the shelf from what's already loaded (cheap: runs on every keystroke). */
function renderShelf() {
  const list = categoryList();
  if (view.cat !== 'all' && !list.includes(view.cat)) view.cat = 'all';
  const count = (c) => entries.filter((b) => catOf(b) === c).length;
  catBar.innerHTML = [`<button data-cat="all" class="${view.cat === 'all' ? 'on' : ''}">All <span>${entries.length}</span></button>`]
    .concat(list.map((c) => `<button data-cat="${esc(c)}" class="${view.cat === c ? 'on' : ''}">${esc(c)} <span>${count(c)}</span></button>`)).join('');

  const words = fold(view.q).split(/\s+/).filter(Boolean);
  let books = entries.filter((b) => view.cat === 'all' || catOf(b) === view.cat);
  if (words.length) {
    const scored = books.map((b) => [b, score(b, words)]).filter(([, s]) => s > 0);
    // While searching, "Recently read" means "best match first"; any other sort is honoured.
    scored.sort((x, y) => (view.sort === 'recent' ? y[1] - x[1] : 0) || sorters[view.sort](x[0], y[0]));
    books = scored.map(([b]) => b);
  } else books.sort(sorters[view.sort]);

  const grouped = !words.length && view.cat === 'all' && list.length > 1;
  shelf.classList.toggle('grouped', grouped);
  renderContinue(!words.length && view.cat === 'all');
  renderStats();
  if (!books.length) {
    shelf.innerHTML = words.length
      ? `<div class="shelf-none"><div class="sn-mark">❦</div><p>Nothing matches “${esc(view.q.trim())}”${view.cat !== 'all' ? ` on ${esc(view.cat)}` : ''}.</p>
         ${view.cat !== 'all' ? '<button class="link-btn" data-act="all">Search all shelves</button>' : '<button class="link-btn" data-act="clear">Clear search</button>'}</div>`
      : '<div class="shelf-none"><div class="sn-mark">❦</div><p>This shelf is empty.</p></div>';
    shelf.querySelector('[data-act="all"]')?.addEventListener('click', () => { view.cat = 'all'; saveView(); renderShelf(); });
    shelf.querySelector('[data-act="clear"]')?.addEventListener('click', () => { searchInput.value = ''; view.q = ''; renderShelf(); });
  } else if (grouped) {
    shelf.innerHTML = list.map((c) => {
      const inCat = books.filter((b) => catOf(b) === c);
      return `<section class="shelf-group">
        <header class="sg-head"><h2 class="sec-title">${esc(c)}</h2><span class="sg-count">${inCat.length}</span>
          <button class="sg-all" data-cat="${esc(c)}">View shelf ${ico.arrow}</button></header>
        <div class="shelf-grid">${inCat.map((b) => card(b)).join('')}</div></section>`;
    }).join('');
    shelf.querySelectorAll('.sg-all').forEach((b) => { b.onclick = () => { view.cat = b.dataset.cat; saveView(); renderShelf(); lib.scrollTo?.({ top: 0, behavior: 'smooth' }); }; });
  } else {
    const head = words.length
      ? `${books.length} result${books.length === 1 ? '' : 's'} for “${esc(view.q.trim())}”`
      : view.cat !== 'all' ? esc(view.cat) : 'All books';
    shelf.innerHTML = `<header class="sg-head"><h2 class="sec-title">${head}</h2>${!words.length ? `<span class="sg-count">${books.length}</span>` : ''}</header>
      <div class="shelf-grid">${books.map((b) => card(b, view.cat === 'all')).join('')}</div>`;
  }

  shelf.querySelectorAll('.vol').forEach((v) => {
    v.onclick = (e) => {
      if (e.target.closest('.vol-del')) { removeBook(v.dataset.id); return; }
      if (e.target.closest('.vol-cat')) { e.stopPropagation(); categoryMenu(v.dataset.id, e.target.closest('.vol-cat')); return; }
      openBook(v.dataset.id, v);
    };
    v.onkeydown = (e) => { if (e.key === 'Enter' && e.target === v) openBook(v.dataset.id, v); };
  });
  // Covers are read straight out of each EPUB, after the shelf is on screen.
  const shown = new Map([...books, ...entries.filter((b) => continueRow.querySelector(`[data-id="${CSS.escape(b.id)}"]`))].map((b) => [b.id, b]));
  for (const b of shown.values()) {
    if (coverCache.has(b.id)) continue;
    library.cover(b).then((url) => {
      coverCache.set(b.id, url || '');
      if (!url) return;
      for (const gen of lib.querySelectorAll(`[data-id="${CSS.escape(b.id)}"] .gen-cover`)) {
        gen.replaceWith(Object.assign(new Image(), { src: url, alt: '' }));
      }
    });
  }
}

/* ---------- per-book category picker ---------- */
let openMenu = null;
function closeCategoryMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('pointerdown', (e) => { if (openMenu && !e.target.closest('.cat-menu')) closeCategoryMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { closeCategoryMenu(); e.stopPropagation(); } }, true);

function categoryMenu(id, anchor) {
  closeCategoryMenu();
  const b = entries.find((x) => x.id === id);
  if (!b) return;
  const current = catOf(b);
  const names = allCategoryNames();
  const menu = document.createElement('div');
  menu.className = 'cat-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="cat-menu-title">Move “${esc(b.title)}” to</div>
    <div class="cat-menu-list">
      ${names.map((c) => `<button role="menuitemradio" aria-checked="${c === current}" data-name="${esc(c)}">${esc(c)}</button>`).join('')}
      <button role="menuitemradio" aria-checked="${current === UNCAT}" data-name="">${UNCAT}</button>
    </div>
    <form class="cat-menu-new"><input placeholder="New category…" maxlength="60" aria-label="New category name"><button>Add</button></form>`;
  document.body.appendChild(menu);
  openMenu = menu;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth; const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - mw - 8, r.left))}px`;
  menu.style.top = `${r.bottom + 6 + mh > innerHeight - 8 ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  const apply = async (name) => {
    closeCategoryMenu();
    try {
      cats = await library.setCategory(id, name);
      renderShelf();
    } catch (err) { status.textContent = `Couldn’t change category: ${err.message}`; }
  };
  menu.querySelectorAll('[data-name]').forEach((btn) => { btn.onclick = () => apply(btn.dataset.name); });
  menu.querySelector('form').onsubmit = (e) => { e.preventDefault(); const v = menu.querySelector('input').value.trim(); if (v) apply(v); };
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')).focus();
}

/* ---------- new-book prompt: every book that arrives gets asked for a shelf ----------
 * "New" = no category and never asked (categories.json → checked). Choosing a
 * shelf or "Leave uncategorized" both count as answered; "Ask me later" only
 * defers until the next launch. The categorizer's best guess is pre-selected. */
const later = new Set();
let prompting = null;
let closePrompt = null;

function promptNewBooks() {
  if (prompting) return prompting;
  const due = () => entries.filter((b) => !cats.books[b.id] && !cats.checked.includes(b.id) && !later.has(b.id));
  if (lib.hidden || !due().length) return Promise.resolve();
  prompting = (async () => {
    const queue = due().sort((a, b) => b.added - a.added);
    for (let i = 0; i < queue.length; i++) {
      const b = queue[i];
      if (lib.hidden) break;
      if (cats.books[b.id] || cats.checked.includes(b.id)) continue;
      const names = allCategoryNames();
      const model = buildModel(entries, (x) => cats.books[x.id] || null, names); // rebuilt each time: learns from your last pick
      const guess = suggestCategory(model, b);
      const answer = await askCategory(b, names, guess, i + 1, queue.length);
      if (answer === 'interrupted') break;                                // a book is opening: ask again on return
      if (answer === 'later') { queue.slice(i).forEach((x) => later.add(x.id)); break; }
      try { cats = await library.setCategory(b.id, answer); cats.checked ||= []; } catch (err) { status.textContent = `Couldn’t save category: ${err.message}`; }
      renderShelf();
    }
  })().finally(() => { prompting = null; });
  return prompting;
}

/** Resolves with a category name, '' (leave uncategorized), 'later' or 'interrupted'. */
function askCategory(b, names, guess, n, total) {
  return new Promise((resolve) => {
    const dlg = document.createElement('div');
    dlg.className = 'cat-prompt';
    dlg.innerHTML = `
      <div class="cp-card" role="dialog" aria-modal="true" aria-labelledby="cp-title">
        <div class="cp-head">
          <div class="cp-cover" style="--h:${hue(b.title)}">${coverCache.get(b.id) ? `<img src="${esc(coverCache.get(b.id))}" alt="">` : genCover(b)}</div>
          <div class="cp-meta">
            <div class="cp-kicker">New book${total > 1 ? ` · ${n} of ${total}` : ''}</div>
            <h2 id="cp-title">${esc(b.title)}</h2>
            <div class="cp-author">${esc(b.author || '')}</div>
          </div>
        </div>
        <p class="cp-q">Which shelf does it go on?</p>
        <div class="cp-options">
          ${names.map((c, k) => `<button data-name="${esc(c)}" class="${c === guess.category ? 'sug' : ''}">${k < 9 ? `<kbd>${k + 1}</kbd>` : ''}<span>${esc(c)}</span>${c === guess.category ? `<em>${guess.reason === 'author' ? 'Same author' : 'Suggested'}</em>` : ''}</button>`).join('')}
        </div>
        <form class="cp-new"><input placeholder="Or create a new category…" maxlength="60" aria-label="New category name"><button>Create</button></form>
        <div class="cp-foot">
          <button class="cp-skip" data-act="skip">Leave uncategorized</button>
          <button class="cp-later" data-act="later">Ask me later <kbd>Esc</kbd></button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    if (!coverCache.has(b.id)) {
      library.cover(b).then((url) => {
        coverCache.set(b.id, url || '');
        const gen = url && dlg.querySelector('.cp-cover .gen-cover');
        if (gen) gen.replaceWith(Object.assign(new Image(), { src: url, alt: '' }));
      });
    }
    const prevFocus = document.activeElement;
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      closePrompt = null;
      dlg.classList.add('closing');
      setTimeout(() => dlg.remove(), 160);
      prevFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      const typing = e.target.closest('input');
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('later'); return; }
      if (!typing && /^[1-9]$/.test(e.key) && names[+e.key - 1]) { e.preventDefault(); e.stopPropagation(); done(names[+e.key - 1]); return; }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...dlg.querySelectorAll('button, input')];
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
      e.stopPropagation(); // the library's own shortcuts ("/") wait until the dialog closes
    };
    document.addEventListener('keydown', onKey, true);
    closePrompt = () => done('interrupted');
    dlg.querySelectorAll('[data-name]').forEach((btn) => { btn.onclick = () => done(btn.dataset.name); });
    dlg.querySelector('[data-act="skip"]').onclick = () => done('');
    dlg.querySelector('[data-act="later"]').onclick = () => done('later');
    dlg.querySelector('form').onsubmit = (e) => { e.preventDefault(); const v = dlg.querySelector('input').value.replace(/\s+/g, ' ').trim(); if (v) done(v); };
    (dlg.querySelector('.sug') || dlg.querySelector('[data-name]') || dlg.querySelector('input')).focus();
  });
}

async function removeBook(id) {
  const b = entries.find((x) => x.id === id);
  if (!b) return;
  const where = isDesktop ? '\n\nThe EPUB file will be moved to the trash.' : '';
  if (!window.confirm(`Remove “${b.title}” from your library?${where}`)) return;
  try {
    await library.remove(id);
  } catch (err) {
    status.textContent = `Couldn’t remove “${b.title}”: ${err.message}`;
  }
  renderLibrary();
}

/* ---------- import: every source goes through addBookToLibrary() ---------- */
async function importFiles(files, { open = true } = {}) {
  let ok = 0;
  let lastId = null;
  for (const f of files) {
    status.textContent = `Adding ${f.name}…`;
    try {
      const { id, added } = await addBookToLibrary(f);
      ok++;
      lastId = id;
      status.textContent = added ? '' : `“${f.name}” is already in your library`;
    } catch (err) {
      console.error(err);
      status.textContent = `Couldn’t add ${f.name}: ${err.message}`;
    }
  }
  await renderLibrary();
  if (files.length === 1 && open && lastId) { await promptNewBooks(); openBook(lastId); } // shelf first, then read
  return ok;
}

/* ---------- reading ---------- */
let busy = false;
async function openBook(id, fromEl) {
  if (busy) return;
  closePrompt?.(); // asked again when you come back to the library
  busy = true;
  try {
    if (fromEl) {
      fromEl.classList.add('opening');
      await new Promise((r) => setTimeout(r, 380));
    }
    const meta = entries.find((b) => b.id === id);
    if (!meta) throw new Error('Book not found');
    const data = await library.open(id);
    const book = await parseEpub(data);
    const state = await store.getState(id);
    const coverUrl = await library.cover(meta);
    lib.hidden = true;
    fromEl?.classList.remove('opening');
    history.replaceState(null, '', `#book=${id}`);
    await reader.open(book, { ...meta, coverUrl }, state);
  } catch (err) {
    console.error(err);
    lib.hidden = false;
    status.textContent = `Couldn’t open book: ${err.message}`;
  } finally { busy = false; fromEl?.classList.remove('opening'); }
}

async function loadSample(path) {
  status.textContent = 'Fetching sample…';
  const res = await fetch(path);
  if (!res.ok) { status.textContent = 'Sample not found'; return; }
  const blob = await res.blob();
  importFiles([new File([blob], path.split('/').pop(), { type: 'application/epub+zip' })]);
}

/* ---------- library folder (desktop) ---------- */
let folderInfo = { dir: '', error: '' };

/** Scan the folder, index anything new, then redraw. Safe to call any time. */
async function refresh() {
  if (isDesktop && (folderInfo.error || !folderInfo.dir)) { showFolderState(); return; }
  try {
    const r = await library.sync((msg) => { status.textContent = msg; });
    const notes = [];
    if (r.added) notes.push(`Added ${r.added} new book${r.added > 1 ? 's' : ''} from the folder`);
    if (r.removed?.length) notes.push(`${r.removed.length} removed`);
    if (r.failed?.length) notes.push(`Couldn’t read ${r.failed.join(', ')}`);
    status.textContent = notes.join(' · ');
  } catch (err) {
    console.error(err);
    status.textContent = `Library scan failed: ${err.message}`;
  }
  if (!lib.hidden) await renderLibrary();
}

function showFolderState() {
  if (!isDesktop) return;
  if (folderInfo.error || !folderInfo.dir) {
    heroText.innerHTML = `${esc(folderInfo.error || 'No library folder selected.')} <button class="link-btn" data-act="choose">Choose a library folder</button>`;
  } else {
    // The path lives on the folder button's tooltip; the hero line shows library stats.
    lib.querySelector('.hb-folder')?.setAttribute('title', `Library folder: ${folderInfo.booksDir}\nClick to open · Shift-click to choose another folder`);
    renderStats();
  }
  heroText.querySelector('[data-act="choose"]')?.addEventListener('click', chooseFolder);
  heroText.querySelector('[data-act="reveal"]')?.addEventListener('click', () => library.reveal());
}

async function chooseFolder() {
  folderInfo = await library.chooseFolder();
  showFolderState();
  await refresh();
}

/* ---------- wire up ---------- */
const discover = initDiscover({
  onBook: async (file) => { if (!(await importFiles([file], { open: false }))) throw new Error('the EPUB could not be added'); },
});
// Empty state: the "free books" path only makes sense in the desktop app,
// where the downloader can write into the library folder.
document.querySelector('.empty-discover')?.addEventListener('click', discover.open);
if (!isDesktop) document.querySelector('.empty-discover')?.remove();
const freeBtn = document.createElement('button');
freeBtn.className = 'free-btn';
freeBtn.innerHTML = `${icons.book}<span>Free books</span>`;
freeBtn.onclick = discover.open;
lib.querySelector('.add-btn').before(freeBtn);
lib.querySelector('.add-btn').onclick = () => fileInput.click();
lib.querySelector('.add-btn').innerHTML = `${icons.plus}<span>Add EPUB</span>`;
fileInput.onchange = () => { importFiles([...fileInput.files]); fileInput.value = ''; };
lib.querySelectorAll('[data-sample]').forEach((b) => { b.onclick = () => loadSample(b.dataset.sample); });

if (isDesktop) {
  const folderBtn = document.createElement('button');
  folderBtn.className = 'head-icon hb-folder';
  folderBtn.title = 'Library folder';
  folderBtn.setAttribute('aria-label', 'Library folder');
  folderBtn.innerHTML = ico.folder;
  // Click opens the folder; Shift-click (or no folder yet) picks another one.
  folderBtn.onclick = (e) => (e.shiftKey || folderInfo.error || !folderInfo.dir ? chooseFolder() : library.reveal());
  const rescanBtn = document.createElement('button');
  rescanBtn.className = 'head-icon';
  rescanBtn.title = 'Rescan the library folder';
  rescanBtn.setAttribute('aria-label', 'Rescan the library folder');
  rescanBtn.innerHTML = ico.refresh;
  rescanBtn.onclick = async () => { rescanBtn.classList.add('spin'); try { await refresh(); } finally { setTimeout(() => rescanBtn.classList.remove('spin'), 400); } };
  freeBtn.before(rescanBtn, folderBtn);

  // The main process watches books/ and pings us when files change on disk.
  library.onChange(() => refresh());
  // Belt and braces: also rescan when the window regains focus (cheap: size/mtime check).
  let focusT;
  window.addEventListener('focus', () => { clearTimeout(focusT); focusT = setTimeout(refresh, 300); });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) { if (!readerRoot.hidden) reader.close(); importFiles(files); }
});

/* ---------- start ---------- */
if (isDesktop) { folderInfo = await library.info(); showFolderState(); }
await refresh(); // scans the folder (desktop) and renders the shelf
const m = location.hash.match(/book=([0-9a-f]+)/);
if (m) openBook(m[1]);
