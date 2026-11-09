// Paperback desktop app (Electron main process).
//
//   npm run app
//
// - Serves the existing web app from paperback://app/ (a fixed origin, so the
//   reader's saved positions/highlights in IndexedDB survive restarts).
// - Owns the on-disk library (electron/library.js) and exposes it to the page
//   through a narrow preload API (electron/preload.cjs).
// - Watches library/books/ and tells the page to rescan when EPUBs are added,
//   replaced or deleted from outside the app.
// - Starts the existing server.js on a private port and forwards /api/* to it,
//   so the page's API calls keep working unchanged.

import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, screen } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Library } from './library.js';
import { DownloadManager } from './download.js';
import { resolveDownload, approvedMirrors } from '../engine/sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'paperback://app';

protocol.registerSchemesAsPrivileged([
  { scheme: 'paperback', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

let win = null;
let library = null;
let libraryError = '';
let apiPort = 0;

/* ---------- settings (library folder location) ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
async function loadSettings() {
  try { return JSON.parse(await fsp.readFile(settingsFile(), 'utf8')); } catch { return {}; }
}
async function saveSettings(s) {
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(s, null, 2));
}
const defaultLibraryDir = () => (app.isPackaged ? path.join(app.getPath('documents'), 'Paperback Library') : path.join(ROOT, 'library'));

async function openLibrary(dir) {
  library?.unwatch();
  library = null;
  libraryError = '';
  const lib = new Library(dir, { trash: (p) => shell.trashItem(p) });
  try {
    await lib.ensure();
  } catch (err) {
    libraryError = `Can't open ${dir}: ${err.message}`;
    return;
  }
  library = lib;
  library.watch(() => win?.webContents.send('lib:changed'));
}
const info = () => ({ dir: library?.dir || '', booksDir: library?.booksDir || '', watching: !!library?.watcher, error: libraryError });
const need = () => {
  if (!library) throw new Error(libraryError || 'No library folder selected');
  return library;
};

/* ---------- existing HTTP API, on a private port ---------- */
async function startApi() {
  process.env.PORT = '0';
  const { default: server } = await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
  if (!server?.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  apiPort = server.address().port;
}

/* ---------- paperback:// protocol: static files + /api proxy ---------- */
function registerProtocol() {
  protocol.handle('paperback', async (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      if (!apiPort) return Response.json({ error: 'The local API server is not running' }, { status: 503 });
      return net.fetch(`http://127.0.0.1:${apiPort}${url.pathname}${url.search}`, { method: req.method, headers: req.headers });
    }
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(ROOT, `.${p}`);
    if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      await fsp.access(file);
      return await net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/* ---------- downloads (main process owns network + filesystem) ---------- */
const DOWNLOADS_TEMP_DIR = path.join(os.tmpdir(), 'paperback-downloads');
const downloads = new DownloadManager({ tempDir: DOWNLOADS_TEMP_DIR });

/** The renderer only ever speaks books: md5 + title. It cannot hand us URLs. */
function downloadRequest(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid download request');
  const md5 = String(payload.md5 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(md5)) throw new Error('This book has no valid download reference');
  const extension = String(payload.extension || '').trim().toLowerCase();
  if (extension !== 'epub') throw new Error('Only EPUB books can be downloaded here');
  return {
    md5,
    extension,
    title: String(payload.title || '').slice(0, 300),
    mirrors: Array.isArray(payload.mirrors)
      ? payload.mirrors.filter((m) => typeof m === 'string').slice(0, 4)
      : [],
  };
}

/* ---------- IPC (only from our own page) ---------- */
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame?.url.startsWith(`${ORIGIN}/`)) throw new Error('Blocked');
    return fn(...args);
  });
}
function registerIpc() {
  handle('lib:info', () => info());
  handle('lib:choose', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose your library folder',
      buttonLabel: 'Use this folder',
      defaultPath: library?.dir || defaultLibraryDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return info();
    await openLibrary(r.filePaths[0]);
    if (library) await saveSettings({ ...(await loadSettings()), libraryDir: library.dir });
    return info();
  });
  handle('lib:scan', () => need().scan());
  handle('lib:add', (payload) => need().add(payload));
  handle('lib:upsert', (entry) => need().upsert(entry));
  handle('lib:ignore', (item) => need().ignore(item));
  handle('lib:read', (filename) => need().read(filename));
  handle('lib:remove', (id) => need().remove(id));
  handle('lib:reveal', () => shell.openPath(need().booksDir));
  handle('lib:categories', () => need().categories());
  handle('lib:setCategory', (id, name) => need().setCategory(id, name));
  handle('book:download', (payload) => {
    const request = downloadRequest(payload);
    const mirrors = approvedMirrors(request);
    if (!mirrors.length) throw new Error('No approved mirror found for this book');
    // One resolution + download per mirror, in order: keys are session-bound
    // and short-lived, and a mirror's CDN may not carry the file, so retry
    // with the next approved mirror until one works.
    const progress = (data) => win?.webContents.send('book:download-progress', data);
    let last = null;
    return (async () => {
      for (const mirror of mirrors) {
        const result = await downloads.download(
          { ...request, mirrors: [mirror] },
          { resolve: resolveDownload, tempDir: DOWNLOADS_TEMP_DIR, onProgress: progress },
        );
        if (result.success || result.cancelled) return result;
        // Not recoverable on other mirrors (file itself too big).
        if (/larger than/.test(result.error || '')) {
          last = result; break;
        }
        last = result;
      }
      return last;
    })();
  });
  handle('book:download:cancel', (downloadId) => downloads.cancel(String(downloadId ?? '')));
}

/* ---------- window size & placement ----------
 * Size to the screen the app opens on (a fixed 1280×860 is taller than a 768px laptop
 * screen, so the window manager shoved it half off-screen). Remember the last size and
 * position, but only reuse them if they still sit on a connected display. */
const DEFAULT_W = 1280;
const DEFAULT_H = 860;

function fitBounds(b, wa) {
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  return {
    width, height,
    x: Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height),
  };
}

function initialBounds(saved) {
  if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) {
    const d = screen.getDisplayMatching(saved);
    const wa = d.workArea;
    const overlapW = Math.min(saved.x + saved.width, wa.x + wa.width) - Math.max(saved.x, wa.x);
    const overlapH = Math.min(saved.y + saved.height, wa.y + wa.height) - Math.max(saved.y, wa.y);
    if (overlapW > 120 && overlapH > 120) return { ...fitBounds(saved, wa), maximized: !!saved.maximized };
  }
  // First launch (or that monitor is gone): open on the screen under the mouse, centred.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  // Small laptop screens: fill the usable area (set directly; some WMs ignore an early maximize).
  if (wa.height < 800) return { ...wa, maximized: false };
  const width = Math.min(DEFAULT_W, Math.round(wa.width * 0.92));
  const height = Math.min(DEFAULT_H, Math.round(wa.height * 0.92));
  return {
    width, height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    maximized: false,
  };
}

let saveBoundsTimer = null;
let lastBounds = null;
function rememberBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  lastBounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => persistBounds(), 600);
}
async function persistBounds() {
  if (lastBounds) await saveSettings({ ...(await loadSettings()), window: lastBounds }).catch(() => {});
}
/** On close the app may quit before an async write lands, so write synchronously. */
function persistBoundsNow() {
  rememberBounds();
  clearTimeout(saveBoundsTimer);
  if (!lastBounds) return;
  try {
    const file = settingsFile();
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...s, window: lastBounds }, null, 2));
  } catch { /* not worth failing a quit over */ }
}

/** A monitor was unplugged or rearranged: pull the window back onto a screen. */
function keepOnScreen() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const fitted = fitBounds(b, wa);
  if (fitted.x !== b.x || fitted.y !== b.y || fitted.width !== b.width || fitted.height !== b.height) win.setBounds(fitted);
}

/* ---------- window ---------- */
function createWindow(saved) {
  const bounds = initialBounds(saved);
  win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    minWidth: 420, minHeight: 480, show: false,
    backgroundColor: '#24211e', title: 'Paperback', autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.png'), // window/taskbar icon on Linux & Windows (packaged builds embed their own)
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  // External links (e.g. "details" pages) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
  // Show only once placed, so it never flashes at the wrong size.
  // (maximize after show: X11 window managers ignore a maximize on an unmapped window)
  win.once('ready-to-show', () => { win.show(); if (bounds.maximized) win.maximize(); });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberBounds);
  win.on('close', persistBoundsNow);
  win.loadURL(`${ORIGIN}/index.html`);


}

// One instance per profile: two processes sharing IndexedDB and the library
// watcher can corrupt reading positions/highlights. A second launch just
// focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return;
  registerProtocol();
  registerIpc();
  await startApi().catch((err) => console.error('[api] not started:', err.message));
  // Leftovers from a download interrupted by a restart are never valid books.
  await fsp.rm(DOWNLOADS_TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  const settings = await loadSettings();
  await openLibrary(settings.libraryDir || defaultLibraryDir());
  createWindow(settings.window);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(lastBounds); });
  // Monitor unplugged / resolution changed: keep the window reachable.
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
});

app.on('window-all-closed', () => {
  library?.unwatch();
  if (process.platform !== 'darwin') app.quit();
});
