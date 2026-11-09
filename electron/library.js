// Library on disk (main process):
//
//   <libraryDir>/
//   ├── books/          the EPUB files themselves
//   └── metadata.json   generated catalogue (no binary data, no covers)
//
// Every catalogue change goes through one serial queue and is written
// atomically (temp file → rename), so scans, imports and removals can't
// overwrite each other. EPUB metadata is parsed in the renderer with the
// reader's own parseEpub(); this module only stores what it is given.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeFilename } from '../engine/sources.js';

const CATALOG = 'metadata.json';
const CATEGORIES = 'categories.json';
const EMPTY = () => ({ version: 1, books: [], ignored: [] });

export class Library {
  constructor(dir, { trash } = {}) {
    this.dir = dir;
    this.booksDir = path.join(dir, 'books');
    this.trash = trash || ((p) => fsp.unlink(p));
    this.queue = Promise.resolve();
    this.watcher = null;
  }

  /* ---------- plumbing ---------- */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async ensure() {
    await fsp.mkdir(this.booksDir, { recursive: true });
    return this.dir;
  }

  async readCatalog() {
    const file = path.join(this.dir, CATALOG);
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return EMPTY();
      throw e;
    }
    try {
      const j = JSON.parse(text);
      return { version: 1, books: Array.isArray(j.books) ? j.books : [], ignored: Array.isArray(j.ignored) ? j.ignored : [] };
    } catch {
      // Corrupted catalogue: keep a copy for the user, rebuild from the files.
      await fsp.copyFile(file, path.join(this.dir, `${CATALOG}.corrupt-${Date.now()}`)).catch(() => {});
      return EMPTY();
    }
  }

  async writeCatalog(cat) {
    const file = path.join(this.dir, CATALOG);
    const tmp = `${file}.tmp-${process.pid}`;
    const books = [...cat.books].sort((a, b) => a.title.localeCompare(b.title));
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, books, ignored: cat.ignored }, null, 2) + '\n');
    await fsp.rename(tmp, file);
  }

  bookPath(filename) {
    const name = String(filename || '');
    if (path.basename(name) !== name || !/\.epub$/i.test(name)) throw new Error('Invalid book filename');
    return path.join(this.booksDir, name);
  }

  static hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

  static hashFile(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }

  /* ---------- operations ---------- */

  /** Compare books/ against the catalogue. Known files are matched by size+mtime
   *  first and by SHA-256 only when those changed. Returns files that still
   *  need parsing; the renderer parses them and calls upsert()/ignore(). */
  scan() {
    return this.serial(async () => {
      await this.ensure();
      const cat = await this.readCatalog();
      const byFile = new Map(cat.books.map((b) => [b.filename, b]));
      const byId = new Map(cat.books.map((b) => [b.id, b]));
      const ignoredByFile = new Map(cat.ignored.map((x) => [x.filename, x]));
      const dirents = await fsp.readdir(this.booksDir, { withFileTypes: true });
      const names = dirents.filter((d) => d.isFile() && /\.epub$/i.test(d.name)).map((d) => d.name).sort();

      const books = [];
      const ignored = [];
      const pending = [];
      const seen = new Set();
      for (const filename of names) {
        let st;
        try { st = await fsp.stat(path.join(this.booksDir, filename)); } catch { continue; } // vanished mid-scan
        const fileSize = st.size;
        const lastModified = Math.round(st.mtimeMs);
        const known = byFile.get(filename);
        if (known && known.fileSize === fileSize && known.lastModified === lastModified && !seen.has(known.id)) {
          books.push(known); seen.add(known.id); continue;
        }
        const ig = ignoredByFile.get(filename);
        if (ig && ig.fileSize === fileSize && ig.lastModified === lastModified) { ignored.push(ig); continue; }

        const id = await Library.hashFile(path.join(this.booksDir, filename));
        if (seen.has(id)) { ignored.push({ filename, fileSize, lastModified, reason: 'Duplicate of a book already in the library' }); continue; }
        seen.add(id);
        const prev = byId.get(id);
        if (prev) { books.push({ ...prev, filename, fileSize, lastModified }); continue; } // renamed / touched, same content
        pending.push({ id, filename, fileSize, lastModified });
      }
      const removed = cat.books.filter((b) => !seen.has(b.id)).map((b) => b.title);
      await this.writeCatalog({ books, ignored });
      return { books, pending, removed, ignored };
    });
  }

  /** Add or replace a catalogue entry for a file already in books/. */
  upsert(entry) {
    return this.serial(async () => {
      const clean = sanitize(entry);
      await fsp.access(this.bookPath(clean.filename));
      const cat = await this.readCatalog();
      const old = cat.books.find((b) => b.id === clean.id);
      cat.books = cat.books.filter((b) => b.id !== clean.id && b.filename !== clean.filename);
      cat.books.push({ ...clean, dateAdded: old?.dateAdded || clean.dateAdded || new Date().toISOString() });
      cat.ignored = cat.ignored.filter((x) => x.filename !== clean.filename);
      await this.writeCatalog(cat);
      return cat.books.at(-1);
    });
  }

  /** Remember a file that couldn't be used so it isn't re-parsed until it changes. */
  ignore({ filename, fileSize, lastModified, reason }) {
    return this.serial(async () => {
      this.bookPath(filename);
      const cat = await this.readCatalog();
      cat.ignored = cat.ignored.filter((x) => x.filename !== filename);
      cat.ignored.push({ filename, fileSize, lastModified, reason: String(reason || 'Unreadable EPUB').slice(0, 300) });
      await this.writeCatalog(cat);
    });
  }

  /** Copy an EPUB into books/ and catalogue it in one step. Duplicates are detected by content hash. */
  add({ name, bytes, meta }) {
    return this.serial(async () => {
      await this.ensure();
      const buf = Buffer.from(bytes);
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('Not an EPUB (not a ZIP archive)');
      const id = Library.hash(buf);
      const cat = await this.readCatalog();
      const existing = cat.books.find((b) => b.id === id);
      if (existing) return { entry: existing, added: false };

      const filename = await this.freeName(name);
      const dest = path.join(this.booksDir, filename);
      const tmp = path.join(this.dir, `.incoming-${id.slice(0, 16)}.part`); // outside books/ so the watcher ignores it
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
      const st = await fsp.stat(dest);
      const entry = sanitize({ ...meta, id, filename, fileSize: st.size, lastModified: Math.round(st.mtimeMs), dateAdded: new Date().toISOString() });
      cat.books.push(entry);
      cat.ignored = cat.ignored.filter((x) => x.filename !== filename);
      await this.writeCatalog(cat);
      return { entry, added: true };
    });
  }

  async freeName(name) {
    const base = sanitizeFilename(String(name || 'book'), 'epub').slice(0, -'.epub'.length) || 'book';
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? `${base}.epub` : `${base} (${i}).epub`;
      try { await fsp.access(path.join(this.booksDir, candidate)); } catch { return candidate; }
    }
  }

  async read(filename) {
    return new Uint8Array(await fsp.readFile(this.bookPath(filename)));
  }

  /** Remove a book: the file goes to the system trash, the entry leaves the catalogue. */
  remove(id) {
    return this.serial(async () => {
      const cat = await this.readCatalog();
      const entry = cat.books.find((b) => b.id === id);
      if (!entry) return false;
      await this.trash(this.bookPath(entry.filename)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      cat.books = cat.books.filter((b) => b.id !== id);
      await this.writeCatalog(cat);
      return true;
    });
  }

  /* ---------- categories ----------
   * <libraryDir>/categories.json = { version, books: { <id>: "Category" }, order: ["Category", …] }
   * Kept apart from metadata.json (which is regenerated from the EPUBs) and keyed
   * by content id, so categories survive renames, rescans and re-indexing. */
  async readCategories() {
    const file = path.join(this.dir, CATEGORIES);
    let text;
    const empty = () => ({ books: {}, order: [], checked: [] });
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return empty();
      throw e;
    }
    try {
      const j = JSON.parse(text);
      const books = j && typeof j.books === 'object' && !Array.isArray(j.books) ? j.books : {};
      return { books, order: Array.isArray(j.order) ? j.order.map(String) : [], checked: Array.isArray(j.checked) ? j.checked.map(String) : [] };
    } catch {
      await fsp.copyFile(file, path.join(this.dir, `${CATEGORIES}.corrupt-${Date.now()}`)).catch(() => {});
      return empty();
    }
  }

  categories() { return this.serial(() => this.readCategories()); }

  /** Set (or with an empty name, clear) one book's category. Either way the book
   *  counts as "asked", so the new-book prompt doesn't come back for it. */
  setCategory(id, name) {
    return this.serial(async () => {
      if (!/^[0-9a-f]{64}$/.test(String(id))) throw new Error('Invalid book id');
      const c = await this.readCategories();
      const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (n) { c.books[id] = n; if (!c.order.includes(n)) c.order.push(n); } else delete c.books[id];
      if (!c.checked.includes(id)) c.checked.push(id);
      const file = path.join(this.dir, CATEGORIES);
      const tmp = `${file}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, ...c }, null, 2) + '\n');
      await fsp.rename(tmp, file);
      return c;
    });
  }

  /* ---------- watcher ---------- */

  /** Watch books/ for files added, replaced or deleted outside the app. Calls
   *  onChange once things settle: a file still being copied (size changing)
   *  is waited for before the change is reported. */
  watch(onChange) {
    this.unwatch();
    let timer = null;
    let lastSig = '';
    const signature = async () => {
      const names = (await fsp.readdir(this.booksDir).catch(() => [])).filter((n) => /\.epub$/i.test(n)).sort();
      const parts = await Promise.all(names.map(async (n) => {
        const st = await fsp.stat(path.join(this.booksDir, n)).catch(() => null);
        return st ? `${n}:${st.size}:${Math.round(st.mtimeMs)}` : '';
      }));
      return parts.join('|');
    };
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const sig = await signature();
        if (sig !== lastSig) { lastSig = sig; settle(); return; } // still changing: check again shortly
        onChange();
      }, 1200);
    };
    signature().then((s) => { lastSig = s; });
    try {
      this.watcher = fs.watch(this.booksDir, { persistent: false }, (_ev, name) => {
        if (name && !/\.epub$/i.test(String(name))) return;
        settle();
      });
      this.watcher.on('error', () => this.unwatch());
    } catch { this.watcher = null; }
    return !!this.watcher;
  }

  unwatch() {
    this.watcher?.close();
    this.watcher = null;
  }
}

/* Only known, small, plain fields from the renderer go into metadata.json. */
const STR = { title: 500, author: 500, language: 40, publisher: 300, published: 60, description: 4000, isbn: 20, coverPath: 500, coverType: 60, filename: 300, id: 64, dateAdded: 40 };
function sanitize(e) {
  const out = {};
  for (const [k, max] of Object.entries(STR)) if (e[k] != null) out[k] = String(e[k]).slice(0, max);
  out.authors = Array.isArray(e.authors) ? e.authors.slice(0, 20).map((a) => String(a).slice(0, 200)) : [];
  out.subjects = Array.isArray(e.subjects) ? e.subjects.slice(0, 20).map((s) => String(s).slice(0, 120)) : [];
  out.fileSize = Number(e.fileSize) || 0;
  out.lastModified = Number(e.lastModified) || 0;
  if (!/^[0-9a-f]{64}$/.test(out.id || '')) throw new Error('Invalid book id');
  if (!out.title) out.title = 'Untitled';
  return out;
}
