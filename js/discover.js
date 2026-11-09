import { icons } from './icons.js';

const TOPICS = [
  ['libgen', 'Everything'],
  ['fiction', 'Fiction'],
  ['comics', 'Comics'],
  ['articles', 'Articles'],
  ['magazines', 'Magazines'],
  ['fiction_rus', 'Fiction (RU)'],
  ['standards', 'Standards']
];

const MODES = [
  ['default', 'All fields'],
  ['title', 'Title'],
  ['author', 'Author']
];

const PICKS = [
  ['Meditations', 'Marcus Aurelius'],
  ['The Art of War', 'Sun Tzu'],
  ['Pride and Prejudice', 'Jane Austen'],
  ['The Brothers Karamazov', 'Fyodor Dostoevsky'],
  ['1984', 'George Orwell'],
  ['The Republic', 'Plato']
];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const hue = s => [...String(s || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

export function initDiscover({ onBook, hasBook }) {
  const bridge = window.paperback || null;
  const canDownload = !!(bridge?.download && bridge?.onDownloadProgress);
  const panel = document.createElement('section');
  panel.className = 'discover';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Search LibGen');

  panel.innerHTML = `
    <div class="dc-sheet">
      <header class="dc-head">
        <div class="dc-title-wrap">
          <h2>Discover EPUBs</h2>
          <p class="dc-sub">Search by title or author — only curated EPUBs with a working source are shown. Download adds the book straight to your library.</p>
        </div>
        <button class="dc-close" type="button" aria-label="Close (Esc)" title="Close (Esc)">${icons.close}</button>
      </header>

      <form class="dc-search" role="search">
        ${icons.search}
        <input
          type="search"
          name="q"
          placeholder="Title, author, ISBN…"
          autocomplete="off"
          enterkeyhint="search"
          aria-label="Search query"
        >
        <button type="button" class="dc-clear" hidden aria-label="Clear search">${icons.close}</button>
        <button type="submit" class="dc-submit" disabled>Search</button>
      </form>

      <div class="dc-controls">
        <div class="dc-control">
          <span class="dc-control-label">Search in</span>
          <div class="dc-seg" role="tablist">
            ${MODES.map(([v, label]) => `
              <button type="button" role="tab" data-mode="${v}" class="${v === 'default' ? 'on' : ''}">${label}</button>
            `).join('')}
          </div>
        </div>

        <div class="dc-control dc-control-topics">
          <span class="dc-control-label">Collections</span>
          <div class="dc-chips">
            ${TOPICS.map(([v, label], i) => `
              <button type="button" class="dc-chip ${i === 0 ? 'on' : ''}" data-topic="${v}">${label}</button>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="dc-picks">
        <span class="dc-picks-label">Try</span>
        ${PICKS.map(([title, author]) => `
          <button type="button" class="dc-pick" data-q="${esc(title + ' ' + author)}">
            <span class="dc-pick-title">${esc(title)}</span>
            <span class="dc-pick-author">${esc(author)}</span>
          </button>
        `).join('')}
      </div>

      <div class="dc-status" role="status" aria-live="polite"></div>

      <div class="dc-results" aria-live="polite"></div>

      <nav class="dc-pagination" hidden aria-label="Results pages">
        <button type="button" class="dc-prev">← Prev</button>
        <span class="dc-page">Page 1</span>
        <button type="button" class="dc-next">Next →</button>
      </nav>
    </div>
  `;

  document.body.append(panel);

  const form = panel.querySelector('.dc-search');
  const input = form.elements.q;
  const clearBtn = panel.querySelector('.dc-clear');
  const submitBtn = panel.querySelector('.dc-submit');
  const status = panel.querySelector('.dc-status');
  const results = panel.querySelector('.dc-results');
  const pagination = panel.querySelector('.dc-pagination');
  const pageLabel = panel.querySelector('.dc-page');
  const prevButton = panel.querySelector('.dc-prev');
  const nextButton = panel.querySelector('.dc-next');

  const imported = new Set();
  let page = 1;
  let currentQuery = '';
  let sequence = 0;
  let hasNext = false;
  let activeDownload = null; // { key, button } while one download is running

  /* ---------- open / close ---------- */
  const open = () => {
    panel.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      panel.classList.add('open');
      input.focus();
    });
  };

  const close = () => {
    panel.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => { if (!panel.classList.contains('open')) panel.hidden = true; }, 180);
  };

  panel.querySelector('.dc-close').onclick = close;
  panel.addEventListener('click', e => { if (e.target === panel) close(); });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  /* ---------- search bar ---------- */
  const syncSubmit = () => {
    const has = input.value.trim().length > 0;
    submitBtn.disabled = !has;
    clearBtn.hidden = !has;
  };

  input.addEventListener('input', syncSubmit);
  clearBtn.onclick = () => { input.value = ''; syncSubmit(); input.focus(); };

  /* ---------- mode segmented control ---------- */
  panel.querySelectorAll('[data-mode]').forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b === btn));
    };
  });
  const getMode = () =>
    panel.querySelector('[data-mode].on')?.dataset.mode || 'default';

  /* ---------- topic pills ---------- */
  panel.querySelectorAll('[data-topic]').forEach(btn => {
    btn.onclick = () => {
      btn.classList.toggle('on');
      // "Everything" is exclusive; if any specific topic is on, turn it off
      const all = panel.querySelector('[data-topic="libgen"]');
      const anySpecific = [...panel.querySelectorAll('[data-topic].on')]
        .some(b => b.dataset.topic !== 'libgen');
      if (anySpecific && all.classList.contains('on')) all.classList.remove('on');
      if (!panel.querySelector('[data-topic].on')) all.classList.add('on');
    };
  });
  const getTopics = () =>
    [...panel.querySelectorAll('[data-topic].on')].map(b => b.dataset.topic);

  /* ---------- quick picks ---------- */
  panel.querySelectorAll('[data-q]').forEach(btn => {
    btn.onclick = () => {
      input.value = btn.dataset.q;
      syncSubmit();
      page = 1;
      run();
    };
  });

  /* ---------- form ---------- */
  form.onsubmit = e => { e.preventDefault(); page = 1; run(); };
  prevButton.onclick = () => { if (page > 1) { page--; run(); } };
  nextButton.onclick = () => { if (hasNext) { page++; run(); } };

  /* ---------- run ---------- */
  async function run() {
    const query = input.value.trim();
    if (!query) { status.textContent = ''; return; }

    currentQuery = query;
    const mySeq = ++sequence;
    const topics = getTopics();

    status.innerHTML = `<span class="dc-spinner" aria-hidden="true"></span> Searching LibGen…`;
    results.innerHTML = skeletons(6);
    pagination.hidden = true;

    const params = new URLSearchParams({
      q: query,
      mode: getMode(),
      page: String(page),
      topics: topics.join(',')
    });

    try {
      const response = await fetch(`/api/search?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mySeq !== sequence) return;

      const books = data.results || [];
      hasNext = books.length >= 24;

      // mark anything already in the library
      if (hasBook) {
        await Promise.all(books.map(async b => {
          if (await hasBook(b.id)) imported.add(`libgen:${b.id}`);
        }));
      }

      if (!books.length) {
        status.innerHTML = `<span class="dc-icon-empty" aria-hidden="true">${icons.book}</span> No results for “${esc(query)}”. Try a different spelling or collection.`;
        results.innerHTML = '';
        pagination.hidden = true;
        return;
      }

      status.innerHTML = `<strong>${books.length}${hasNext ? '+' : ''}</strong> results for “${esc(query)}” <span class="dc-dot">·</span> page ${page}`;
      results.innerHTML = books.map(card).join('');
      wireCards();

      pageLabel.textContent = `Page ${page}`;
      prevButton.disabled = page <= 1;
      nextButton.disabled = !hasNext;
      pagination.hidden = false;

    } catch (error) {
      if (mySeq !== sequence) return;
      status.innerHTML = `<span class="dc-err" aria-hidden="true">!</span> ${esc(error.message)}`;
      results.innerHTML = '';
      pagination.hidden = true;
    }
  }

  /* ---------- card ---------- */
  function card(book) {
    const key = `libgen:${book.id}`;
    const isImported = imported.has(key);

    const meta = [
      book.year && { k: 'year', v: book.year },
      book.language && { k: 'lang', v: book.language.toUpperCase() },
      book.size && { k: 'size', v: book.size }
    ].filter(Boolean);

    const actions = isImported
      ? `<button type="button" class="dc-get dc-download is-done" disabled>
           <span class="dc-get-check">✓</span> In library
         </button>`
      : `<button type="button" class="dc-get dc-download"
           data-id="${esc(book.id)}"
           data-title="${esc(book.title)}"
           data-md5="${esc(book.md5)}"
           data-mirrors="${esc(JSON.stringify(book.mirrors || []))}"
           title="Download EPUB from the authorized source">
           <span class="dc-get-icon">${icons.download || '↓'}</span> Download
           <span class="dc-bar" hidden></span>
         </button>`;

    return `
      <article class="dc-card${isImported ? ' is-imported' : ''}" data-id="${esc(book.id)}">
        <div class="dc-cover" style="--h:${hue(book.title)}">
          <div class="gen-cover">
            <div class="gc-title">${esc(book.title)}</div>
            <div class="gc-rule"></div>
            <div class="gc-author">${esc(book.author)}</div>
          </div>
          <div class="vol-spine"></div>
        </div>

        <div class="dc-info">
          <h3 class="dc-title" title="${esc(book.title)}">${esc(book.title)}</h3>
          <p class="dc-author" title="${esc(book.author)}">${esc(book.author)}</p>

          <div class="dc-meta-chips">
            ${meta.map(m => `<span class="dc-chip-meta dc-chip-${m.k}">${esc(m.v)}</span>`).join('')}
            <span class="dc-chip-meta dc-chip-fmt">epub</span>
            ${book.md5 ? `<button type="button" class="dc-copy" data-md5="${esc(book.md5)}" title="Copy MD5">${icons.copy || '⧉'}</button>` : ''}
          </div>

          <div class="dc-actions">${actions}</div>
        </div>
      </article>
    `;
  }

  /* ---------- downloads (authorized source, Electron only) ---------- */
  const progressLabel = (status, percentage) => {
    switch (status) {
      case 'resolving': return 'Resolving…';
      case 'connecting': return 'Connecting…';
      case 'downloading': return percentage != null ? `${percentage}%` : 'Downloading…';
      case 'validating': return 'Validating…';
      case 'importing': return 'Importing…';
      default: return 'Downloading…';
    }
  };

  // The download state lives on the button itself: spinner + percent label +
  // a thin progress bar, so cards never need to re-render during a download.
  function setProgress(button, status, percentage) {
    const label = esc(progressLabel(status, percentage));
    button.classList.add('is-busy');
    button.disabled = true;
    button.innerHTML = `
      <span class="dc-spinner" aria-hidden="true"></span>
      <span class="dc-get-label">${label}</span>
      <span class="dc-bar"${percentage != null ? ` style="width:${Math.max(2, Math.min(100, percentage))}%"` : ' hidden'}></span>`;
  }

  if (canDownload) {
    // Progress updates are routed to the single download that is in flight.
    bridge.onDownloadProgress(({ status, percentage }) => {
      const active = activeDownload;
      if (!active) return;
      // completed/failed/cancelled are handled by the invoke result
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return;
      setProgress(active.button, status, percentage);
    });
  }

  async function startDownload(button) {
    if (activeDownload || (canDownload && !bridge.download)) return;
    const key = `libgen:${button.dataset.id}`;
    activeDownload = { key, button };

    const original = button.innerHTML;
    setProgress(button, 'resolving');

    try {
      const result = await bridge.download({
        md5: button.dataset.md5 || '',
        title: button.dataset.title || '',
        extension: 'epub',
        mirrors: JSON.parse(button.dataset.mirrors || '[]'),
      });
      if (!result?.success) throw new Error(result?.error || 'Download failed');

      const file = new File([result.bytes], result.filename, { type: 'application/epub+zip' });
      await onBook(file);

      imported.add(key);
      button.classList.remove('is-busy');
      button.classList.add('is-done');
      button.innerHTML = `<span class="dc-get-check">✓</span> In library`;
      button.disabled = true;
      button.closest('.dc-card')?.classList.add('is-imported');
      status.innerHTML = `<strong>${esc(result.filename)}</strong> added to your library.`;
    } catch (error) {
      console.warn('[discover] download failed:', error);
      button.classList.remove('is-busy');
      button.disabled = false;
      button.innerHTML = original;
      status.textContent = `Download failed: ${error.message}`;
    } finally {
      activeDownload = null;
    }
  }

  /* ---------- wire buttons in cards ---------- */
  function wireCards() {
    results.querySelectorAll('.dc-download:not(.is-done)').forEach(button => {
      button.onclick = () => startDownload(button);
    });

    results.querySelectorAll('.dc-copy').forEach(button => {
      button.onclick = async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.md5);
          button.classList.add('is-copied');
          setTimeout(() => button.classList.remove('is-copied'), 1500);
        } catch {
          status.textContent = 'Could not copy MD5 to clipboard.';
        }
      };
    });
  }

  /* ---------- skeleton loading ---------- */
  function skeletons(n) {
    return Array.from({ length: n }, () => `
      <article class="dc-card dc-skeleton" aria-hidden="true">
        <div class="dc-cover"></div>
        <div class="dc-info">
          <div class="sk-line sk-title"></div>
          <div class="sk-line sk-author"></div>
          <div class="sk-chips">
            <span class="sk-chip"></span><span class="sk-chip"></span><span class="sk-chip"></span>
          </div>
          <div class="sk-line sk-btn"></div>
        </div>
      </article>
    `).join('');
  }

  return { open, close };
}