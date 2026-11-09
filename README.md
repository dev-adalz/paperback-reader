# Paperback

**A local-first EPUB reader that feels like a printed book — with free-book search built in.**

Paperback is a desktop EPUB reader (Windows · Linux, plus a browser dev mode). It keeps your
books, reading positions, highlights and notes on your own device, and fills your shelves in
two ways: **import your own EPUB files**, or **search LibGen inside the app and download an
EPUB straight into your library**. No account, no cloud, no tracking.

```
Search LibGen  →  Download EPUB  →  lands in your library  →  read offline forever
```

---

## Features

### Search & download free books (desktop)
- **Built-in LibGen search** in the *Free books* panel — search everything, or restrict to
  title/author; filter by collection (fiction, comics, articles, magazines, standards).
- **EPUB-only, curated results.** PDFs and rows with no working source are filtered out
  before they reach the UI; duplicates are removed; results are **ranked by how well the
  title/author match what you typed**, so the actual book comes first.
- **One-click download, straight into your library** — no downloads folder detour, no manual
  importing. The new book appears on the shelf and opens immediately.
- **Live progress** on the button: resolving link → connecting → % downloaded → validating →
  importing → *✓ In library*.
- **Careful downloader, not a browser hack:**
  - the direct link is resolved by the `libgen-api-enhanced` library (server-rendered
    session-bound keys stay in Python, not in JavaScript);
  - only an **allowlist of LibGen / book-CDN hosts** can be contacted, re-checked on **every
    redirect hop**;
  - a download must be an **EPUB** (ZIP + `mimetype` + end-of-central-directory checks), capped
    at 200 MB, with timeouts, cancel support, and temp files cleaned up;
  - if a mirror is stale or the CDN doesn't carry the file, the app **retries the next
    approved mirror** automatically.
- One download at a time, cancellable, with the copy-MD5 chip for power users.

### Bring your own books
- **Drag & drop** one or many `.epub` files anywhere on the window.
- **Add EPUB** file picker (multi-select).
- **A real library folder** — choose any folder (default: `Documents/Paperback Library` on
  installed builds). Paperback **watches `books/`** and indexes files you copy in from your
  file manager, phone sync, Calibre, etc. Replace a file and the catalogue updates; delete one
  and it leaves the shelf.
- **Duplicate-safe** by content hash (SHA-256): importing the same book twice doesn't double
  it. Broken files are skipped and remembered so they don't slow every scan.
- **Open the folder** in your file manager with one click; change it with Shift-click.
- Two **public-domain sample classics** are included for a zero-setup first run.

### Reading experience
- **Two-page spreads** on wide screens: hardcover board, spine-gutter shadow, page-curvature
  lighting, satin ribbon marker, and stacked page edges whose thickness shows how much you've
  read vs. what's left.
- **Paper**: warm fibre/grain texture; text and illustrations are multiplied onto the paper so
  ink and engravings look printed, not pasted.
- **Print typography**: justified text with hyphenation, oldstyle numerals, ligatures,
  indented paragraphs without gaps, baseline-snapped page heights, widows/orphans control,
  chapters start on a new page with a sunk opening, drop cap + small-caps lead-in, ❧ ornament
  under chapter titles, ⁂ for scene breaks, running heads and folios.
- **Page turns**: 3D page curl (drag it with a finger on touch screens), slide, e-ink
  (black/white refresh flash with ghosting), or instant.
- **Display sheet**: 6 bundled fonts (SIL OFL, bundled so it typesets offline), 11 sizes,
  line spacing, margins, alignment, 1 or 2 pages, themes (Paper, White, Sepia, E-ink, Night),
  front-light brightness + warmth.
- **Kindle-style conveniences**: tap zones, real print page numbers when the EPUB has them,
  cycling status line (page / location / time left in chapter / time left in book), adaptive
  reading speed, progress scrubber with "Back to page N", table of contents with page numbers,
  full-text search, highlights in 4 colours, notes, a notebook, dictionary lookup, footnote
  pop-ups, bookmarks, and reading positions that survive font/size/screen changes.
- **Keys**: `←/→`, `Space`, `PgUp/PgDn` turn · `T` contents · `/` search · `N` notebook ·
  `A` display · `B` bookmark · `F` full screen · `+/-` size · `Esc` close.

### Shelves that sort themselves
- **Offline auto-categorisation**: another book by the same author, a small learned
  tf–idf model over title/publisher-subjects/description, and a few seed keywords. No AI
  service, no network — it only guesses when one shelf clearly wins, otherwise the book stays
  Uncategorized.
- Custom shelves, per-shelf views, reading progress, "in progress" and "finished" counts.
- Library search, sort modes, and a "continue reading" row.

### Local-first, by architecture
- Books and metadata live in **your** library folder; positions, highlights and notes live in
  the app's local storage. Nothing is uploaded.
- The renderer **cannot** reach the network or filesystem directly: the Electron window is
  sandboxed with context isolation, and a narrow preload bridge exposes only library and
  download calls.
- The renderer never sees or supplies URLs — it speaks `md5` + title, and the main process
  resolves, validates and fetches. IPC is origin-checked.
- A single-instance lock prevents two copies of the app from corrupting the same library.
- Library catalogue writes are serialised and atomic (temp file → rename).

### Platform support
- **Windows** — NSIS installer (x64): per-user install, choose your install folder, desktop
  and Start-menu shortcuts.
- **Linux** — AppImage (x64): download, `chmod +x`, run. A from-source desktop-entry installer
  (`scripts/install-linux.sh`) is included for launcher integration.
- **Browser dev mode** — `npm start` serves the reader at `http://localhost:3000` with
  IndexedDB storage (reading/importing; downloads are desktop-only).

---

## Install

### Windows (installer)
1. Download `Paperback-<version>-Setup.exe` from the **Releases** page (or build it yourself,
   see below).
2. Run it. You can pick the install directory; the app installs per-user (no admin needed).
   The installer is **unsigned**, so Windows SmartScreen may ask: *More info → Run anyway*.
3. Launch **Paperback** from the Start menu or desktop.

> The Windows installer is built on Windows or in CI (`.github/workflows/build.yml`).
> Cross-building it from Linux works when a **32-bit Wine prefix** is available
> (`WINEPREFIX=~/.wine32 WINEARCH=win32 npx electron-builder --win nsis`).

### Linux (AppImage)
```bash
chmod +x Paperback-<version>-x86_64.AppImage
./Paperback-<version>-x86_64.AppImage
```

Optional desktop integration from a source checkout:

```bash
./scripts/install-linux.sh          # adds Paperback to your app menu
./scripts/install-linux.sh --remove # removes it (your books are untouched)
```

### Python for LibGen search & downloads
Search and download use [`libgen-api-enhanced`](https://github.com/onurhanak/libgen-api-enhanced)
through a small Python helper (`engine/libgen.py`). **Everything else works without Python** —
you just need it for the *Free books* panel.

Pick one:

**A. A virtual environment inside the project (recommended for source installs)**
```bash
# Linux / macOS
python3 -m venv .venv
.venv/bin/pip install -r engine/requirements.txt

# Windows (PowerShell)
py -3 -m venv .venv
.venv\Scripts\pip install -r engine\requirements.txt
```
Paperback automatically uses `.venv` when it exists.

**B. Your system Python**
```bash
# Linux / macOS
python3 -m pip install libgen-api-enhanced   # add --user if needed
# Windows
py -3 -m pip install libgen-api-enhanced
```

**C. Any interpreter, anywhere** — point Paperback at it:
```bash
PAPERBACK_PYTHON=/path/to/python        # Linux / macOS
set PAPERBACK_PYTHON=C:\Python312\python.exe   # Windows (cmd)
```
`python3`/`python`/`py -3` on `PATH` are also discovered automatically. If Python is missing,
the panel tells you so instead of failing silently.

> **Note for installed builds:** the AppImage/installer don't bundle Python (it would add
> ~50 MB). Install `libgen-api-enhanced` for your system Python once and the app finds it.

---

## Use it

1. **First run** — the empty library offers *Search free books* and two public-domain
   classics. Click **Search free books**, type a title or author, press Enter.
2. Pick an **EPUB** result and press **Download**. Watch the button progress
   (`Resolving… → 0% … 100% → Importing… → ✓ In library`) and open the book from the shelf.
3. **Or import your own:** drag `.epub` files onto the window, or use **Add EPUB**.
4. Reading progress, highlights, notes and bookmarks are remembered per book, locally.

### Where are my books?
- Installed builds: `Documents/Paperback Library/` (`books/` + `metadata.json`).
- Source builds: the project's `library/` folder.
- Change it: **Shift-click the folder icon** in the library header, or click it when no folder
  is set. Copy EPUBs into `<your folder>/books/` from anywhere — Paperback notices.

### Keyboard shortcuts
`←/→`, `Space`, `PgUp/PgDn` turn pages · `T` contents · `/` search · `N` notebook · `A`
display settings · `B` bookmark · `F` full screen · `+/-` text size · `Esc` close.

---

## Run from source

Requirements: **Node.js 20+** and **npm**. Python 3.9+ only for LibGen search/downloads.

```bash
git clone <your-repo-url> paperback
cd paperback
npm install

npm run app     # desktop app (Electron)
npm start       # browser mode at http://localhost:3000
npm run dev     # browser mode with auto-restart
```

On some Linux distributions Electron's sandbox helper needs a one-time fix:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

(Linux users who install via `scripts/install-linux.sh` get a `--no-sandbox` fallback hint
instead.)

---

## Build installers

```bash
npm run dist:linux   # → dist/Paperback-<version>-x86_64.AppImage
npm run dist:win     # → dist/Paperback-<version>-Setup.exe   (run on Windows)
npm run dist:dir     # unpacked app for quick testing
```

- Windows installers are best built **on Windows**; cross-building from Linux may work but
  needs Wine for icon/version stamping.
- A GitHub Actions workflow (`.github/workflows/build.yml`) builds both artifacts on every
  `v*` tag and uploads them, so you don't need a Windows machine to release.
- The app is packaged with `asar` disabled so the local API server and Python helper can be
  read/spawned from the install directory.

---

## Project layout

```
index.html            the library + reader shell
css/app.css           library & UI · css/book.css print typography · css/fonts.css bundled fonts
js/main.js            library UI, import pipeline, shelf
js/reader.js          pagination (CSS columns), navigation, highlights, notes, drawers
js/epub.js            EPUB parser + CSS sanitiser (scopes publisher CSS to a whitelist)
js/discover.js        Free books panel: search, curation UI, download buttons
js/library.js         one library API: desktop folder backend / browser IndexedDB backend
js/store.js           IndexedDB: positions, highlights, notes, progress
js/categorize.js      offline auto-categorisation (pure functions)
js/turn.js            page-turn animations
electron/main.js      window, paperback:// protocol, IPC, library folder, download orchestration
electron/library.js   on-disk catalogue, atomic writes, watcher
electron/download.js  streaming downloader, redirect host revalidation, EPUB validation
electron/preload.cjs  the narrow (and only) bridge between page and app
engine/libgen.py      search + direct-link resolution via libgen-api-enhanced
engine/sources.js     result curation/ranking, allowed hosts, Python launcher, source adapter
server.js             the tiny static + /api/search server used by both modes
samples/              two public-domain EPUBs for the first-run experience
scripts/install-linux.sh   desktop-entry installer
build/                app icons for the installer/AppImage
```

---

## Legal & privacy

- Paperback **does not host or distribute any books**. It is a reader, an importer, and a
  search client for LibGen, a third-party site.
- LibGen indexes both public-domain works and copyrighted material. Downloading copyrighted
  material without permission may be illegal where you live. **You are responsible for what
  you search for and download.** Prefer public-domain and author-free works.
- Search queries leave your machine **only when you use the Free books panel** — they go to
  LibGen. Reading, importing and your library never touch the network.
- No analytics, no accounts, no telemetry.

---

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first
issues: new themes, better EPUB edge cases, accessibility, translations, tests for the
categoriser and the downloader.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE). Bundled fonts are SIL Open Font License; the two
sample books are public domain (Project Gutenberg). LibGen integration relies on
[libgen-api-enhanced](https://github.com/onurhanak/libgen-api-enhanced) (MIT). Full third-party
attribution is in [NOTICE](NOTICE).
