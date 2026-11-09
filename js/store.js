/* Tiny IndexedDB wrapper: books (metadata + cover), files (the EPUB bytes),
 * state (reading position, highlights, notes, bookmarks). */
const DB_NAME = 'paperback-reader';
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('state', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}
export const store = {
  listBooks: () => tx('books', 'readonly', (s) => s.getAll()),
  getBook: (id) => tx('books', 'readonly', (s) => s.get(id)),
  putBook: (b) => tx('books', 'readwrite', (s) => s.put(b)),
  getFile: (id) => tx('files', 'readonly', (s) => s.get(id)),
  putFile: (id, blob) => tx('files', 'readwrite', (s) => s.put({ id, blob })),
  getState: (id) => tx('state', 'readonly', (s) => s.get(id)),
  putState: (st) => tx('state', 'readwrite', (s) => s.put(st)),
  async deleteBook(id) {
    await tx('books', 'readwrite', (s) => s.delete(id));
    await tx('files', 'readwrite', (s) => s.delete(id));
    await tx('state', 'readwrite', (s) => s.delete(id));
  },
};

const SETTINGS_KEY = 'paperback-settings';
export const DEFAULT_SETTINGS = {
  font: 'Literata', size: 5, weight: 1, spacing: 1, margins: 1, align: 'justify',
  theme: 'paper', turn: 'curl', spread: 'auto', warmth: 0.15, light: 1,
  texture: true, publisher: true, ornaments: true, hyphens: true, status: 0,
};
export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
