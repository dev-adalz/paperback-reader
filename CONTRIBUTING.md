# Contributing to Paperback

Thanks for wanting to make Paperback better. This is a small, dependency-light codebase: plain
ES modules, no bundler, no framework. If you can edit a file and reload, you can contribute.

## Ground rules

- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **Never commit a library.** `library/`, `node_modules/`, `.venv/`, `engine/bin/` and `dist/`
  are ignored; don't add EPUB files you don't have the right to distribute.
- Keep the reader **local-first**: no telemetry, no accounts, no cloud calls, and no new
  runtime network access without a very good reason (and never from the renderer).

## Set up

```bash
npm install
npm run app     # desktop app (needs Electron)
npm start       # browser mode at http://localhost:3000
```

For LibGen search/downloads during development:

```bash
python3 -m venv .venv
.venv/bin/pip install -r engine/requirements.txt      # Windows: .venv\Scripts\pip install ...
```

On Linux, if Electron complains about the sandbox:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Where things live

| Area | Files | Notes |
| --- | --- | --- |
| Library UI / import | `js/main.js` | drag & drop, Add EPUB, shelves |
| Reader | `js/reader.js`, `js/turn.js`, `css/book.css` | pagination, highlights, notes, page turns |
| EPUB parsing | `js/epub.js` | sanitises publisher CSS against a whitelist |
| Free books panel | `js/discover.js` | search UI, curated result cards, download state |
| Storage | `js/library.js`, `js/store.js`, `electron/library.js` | folder backend + IndexedDB for reading state |
| Downloads | `electron/download.js`, `electron/main.js` | streaming, redirect host checks, validation |
| Search engine | `engine/libgen.py`, `engine/sources.js` | Python helper + curation/ranking/hosts |

## Coding style

- Vanilla ES modules; no build step. Match the surrounding code style (2-space indent, single
  quotes in JS, semicolons optional where the file already omits them — keep the file's
  existing style).
- No comments unless they explain *why*, not *what*. Keep them short.
- Prefer small pure functions for logic that can be reasoned about without a DOM
  (`js/categorize.js` is the model).
- Don't add dependencies casually. New runtime dependencies need a strong justification.
- Accessibility matters: buttons are `<button>`, dialogs have labels, keyboard paths work.

## Security invariants (please don't break these)

- The renderer must not gain `nodeIntegration` or direct filesystem/network access.
- The preload bridge stays narrow; IPC handlers stay wrapped in the origin check.
- Download URLs are resolved in the main process/Python and must match the approved host
  allowlist, including after redirects. The renderer only ever sends `md5` + title.
- Filenames from the network are sanitised (path separators, length, Windows reserved names).
- The library catalogue is written atomically; keep the serial queue.

## Testing changes

There is no test runner yet; verify manually:

1. `npm run app` with an empty library (`library/` removed or renamed).
2. Import an EPUB by drag & drop and via **Add EPUB**; check the shelf, reader, and notes.
3. Use **Search free books**: a known title should put the real book first; only EPUB cards
   with a Download button should appear.
4. Download one book end to end; watch the progress states and confirm the file lands in
   `library/books/` and opens offline.
5. Test the browser mode (`npm start`) for reading/importing — downloads should be hidden.

For pure logic (ranking, filename sanitising, categoriser), a quick Node one-liner is fine;
PRs that add a small test harness for these are very welcome.

## Pull requests

1. Fork, branch from `main` (`feat/...`, `fix/...`).
2. Keep PRs focused; describe **what** changed and **why**, with screenshots/GIFs for UI work.
3. Note any manual test steps you ran.
4. By submitting, you agree your work is licensed under the project's Apache-2.0 licence.

Release notes: maintainers tag `vX.Y.Z`; `.github/workflows/build.yml` builds the Windows
installer and Linux AppImage and uploads them as artifacts.
