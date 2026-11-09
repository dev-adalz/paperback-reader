/* The library: one API for the shelf, whichever storage backs it.
 *
 *  Desktop (Electron, window.paperback present)
 *    EPUBs live in <library>/books/, the catalogue in <library>/metadata.json.
 *    Metadata comes from the reader's own parseEpub(); covers are read out of
 *    the EPUB on demand and never stored separately.
 *  Browser (npm start in a normal browser)
 *    Falls back to the original IndexedDB storage.
 *
 *  Reading position / highlights / progress always stay in IndexedDB (store.js),
 *  keyed by book id.
 */
import { parseEpub, bookId, bookMetadata, readCover } from './epub.js';
import { store } from './store.js';

const api = window.paperback;
export const isDesktop = !!api;

/* ---------- shared helpers ---------- */
const coverUrls = new Map(); // id -> object URL (this session only)

async function readValidEpub(file) {
  if (!/\.epub$/i.test(file.name) && file.type !== 'application/epub+zip') throw new Error(`${file.name} is not an EPUB`);
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (buf.byteLength < 100 || b[0] !== 0x50 || b[1] !== 0x4b) throw new Error(`${file.name} is not a valid EPUB (not a ZIP archive)`);
  return buf;
}

/** Parse with the reader's own parser and keep only catalogue fields. Throws for broken EPUBs. */
async function extractMetadata(data) {
  const book = await parseEpub(data);
  try { return bookMetadata(book); } finally { book.destroy(); }
}

function setCoverUrl(id, blob) {
  if (coverUrls.has(id)) URL.revokeObjectURL(coverUrls.get(id));
  const url = blob ? URL.createObjectURL(blob) : '';
  coverUrls.set(id, url);
  return url;
}

/** Revoke cover URLs for books no longer on the shelf. */
function pruneCovers(ids) {
  for (const [id, url] of coverUrls) {
    if (!ids.has(id)) { if (url) URL.revokeObjectURL(url); coverUrls.delete(id); }
  }
}

/* ---------- desktop backend: folder on disk ---------- */
function desktopBackend() {
  let catalog = [];
  let running = null;
  let again = false;

  /** Scan books/, index new or changed files with parseEpub(), drop deleted ones. */
  async function syncOnce(onStatus) {
    const { books, pending, removed, ignored } = await api.scan();
    catalog = books;
    const failed = [];
    for (const [i, p] of pending.entries()) {
      onStatus?.(`Indexing ${p.filename}${pending.length > 1 ? ` (${i + 1}/${pending.length})` : ''}…`);
      try {
        const bytes = await api.read(p.filename);
        const meta = await extractMetadata(bytes);
        const entry = await api.upsert({ ...meta, ...p, dateAdded: new Date().toISOString() });
        catalog = catalog.filter((b) => b.id !== entry.id).concat(entry);
      } catch (err) {
        console.warn('[library] skipped', p.filename, err);
        failed.push(p.filename);
        await api.ignore({ ...p, reason: err.message }).catch(() => {});
      }
    }
    return { added: pending.length - failed.length, removed, failed, ignored };
  }

  return {
    info: () => api.info(),
    chooseFolder: () => api.chooseFolder(),
    reveal: () => api.reveal(),
    categories: () => api.categories(),
    setCategory: (id, name) => api.setCategory(id, name),
    onChange: (cb) => api.onChange(cb),

    /** Serialised: a sync requested while one runs is folded into one more pass. */
    sync(onStatus) {
      if (running) { again = true; return running; }
      running = (async () => {
        let result;
        do { again = false; result = await syncOnce(onStatus); } while (again);
        return result;
      })().finally(() => { running = null; });
      return running;
    },

    async entries() {
      const state = new Map((await store.listBooks()).map((b) => [b.id, b]));
      pruneCovers(new Set(catalog.map((b) => b.id)));
      return catalog.map((e) => ({
        ...e,
        author: e.author || (e.authors || []).join(', '),
        added: Date.parse(e.dateAdded) || e.lastModified || 0,
        progress: state.get(e.id)?.progress || 0,
        lastOpened: state.get(e.id)?.lastOpened || 0,
      }));
    },

    async add(file) {
      const buf = await readValidEpub(file);
      const meta = await extractMetadata(buf); // validates before anything is written
      const { entry, added } = await api.add({ name: file.name, bytes: new Uint8Array(buf), meta });
      if (added) catalog = catalog.filter((b) => b.id !== entry.id).concat(entry);
      return { id: entry.id, added };
    },

    async open(id) {
      const entry = catalog.find((b) => b.id === id);
      if (!entry) throw new Error('Book not found in the library folder');
      return api.read(entry.filename);
    },

    async cover(entry) {
      if (coverUrls.has(entry.id)) return coverUrls.get(entry.id);
      if (!entry.coverPath) return setCoverUrl(entry.id, null);
      try {
        const bytes = await api.read(entry.filename);
        return setCoverUrl(entry.id, await readCover(bytes, entry.coverPath, entry.coverType));
      } catch { return setCoverUrl(entry.id, null); }
    },

    async remove(id) {
      await api.remove(id);
      catalog = catalog.filter((b) => b.id !== id);
      await store.deleteBook(id); // reading position, highlights, progress
    },
  };
}

/* ---------- browser backend: original IndexedDB storage ---------- */
function browserBackend() {
  return {
    info: async () => ({ dir: '', error: '' }),
    sync: async () => ({ added: 0, removed: [], failed: [], ignored: [] }),
    onChange: () => () => {},
    async entries() {
      const books = await store.listBooks();
      pruneCovers(new Set(books.map((b) => b.id)));
      return books;
    },
    async add(file) {
      const buf = await readValidEpub(file);
      const id = await bookId(buf);
      if (await store.getBook(id)) return { id, added: false };
      const book = await parseEpub(buf);
      try {
        await store.putFile(id, new Blob([buf], { type: 'application/epub+zip' }));
        await store.putBook({ id, ...bookMetadata(book), cover: book.coverBlob, added: Date.now(), progress: 0, size: buf.byteLength });
      } finally { book.destroy(); }
      return { id, added: true };
    },
    async open(id) {
      const file = await store.getFile(id);
      if (!file) throw new Error('Book not found');
      return file.blob.arrayBuffer();
    },
    async cover(entry) {
      if (coverUrls.has(entry.id)) return coverUrls.get(entry.id);
      return setCoverUrl(entry.id, entry.cover || null);
    },
    remove: (id) => store.deleteBook(id),
    // No library folder in the browser: categories are a per-browser convenience.
    async categories() {
      try { const c = JSON.parse(localStorage.getItem(CAT_KEY) || 'null'); if (c?.books) return { books: c.books, order: c.order || [], checked: c.checked || [] }; } catch { /* storage blocked */ }
      return { books: {}, order: [], checked: [] };
    },
    async setCategory(id, name) {
      const c = await this.categories();
      const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (n) { c.books[id] = n; if (!c.order.includes(n)) c.order.push(n); } else delete c.books[id];
      if (!c.checked.includes(id)) c.checked.push(id);
      try { localStorage.setItem(CAT_KEY, JSON.stringify(c)); } catch { /* storage blocked */ }
      return c;
    },
  };
}
const CAT_KEY = 'paperback.categories';

export const library = isDesktop ? desktopBackend() : browserBackend();

/** The one import pipeline for every source (file picker, drag & drop,
 *  samples, downloads): validate → parse → copy into the library → catalogue. */
export const addBookToLibrary = (file) => library.add(file);
