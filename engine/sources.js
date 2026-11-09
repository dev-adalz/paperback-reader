
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PYTHON_SCRIPT = path.join(__dirname, "libgen.py");

/* Python 3 + libgen-api-enhanced power LibGen search and downloads. The
 * interpreter is discovered per-platform (the library is not bundled):
 *   1. PAPERBACK_PYTHON env var (any interpreter or absolute path)
 *   2. the project's .venv
 *   3. python3 / python on macOS & Linux, the py launcher / python on Windows
 * The first candidate that exists and starts is used. */
const PYTHON_HINT =
  "LibGen search and downloads need Python 3 with the libgen-api-enhanced package " +
  "(see README → \"LibGen search & downloads\").";

function pythonCandidates() {
  const isWin = process.platform === "win32";
  const venv = path.join(PROJECT_ROOT, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  const list = [];
  if (process.env.PAPERBACK_PYTHON) list.push({ cmd: process.env.PAPERBACK_PYTHON, args: [] });
  list.push({ cmd: venv, args: [] });
  if (isWin) {
    list.push({ cmd: "py", args: ["-3"] }, { cmd: "python", args: [] });
  } else {
    list.push({ cmd: "python3", args: [] }, { cmd: "python", args: [] });
  }
  return list;
}

const VALID_MODES = ["default", "title", "author"];

const VALID_TOPICS = [
  "libgen",
  "fiction",
  "comics",
  "articles",
  "magazines",
  "fiction_rus",
  "standards"
];

function normalizeBook(book) {
  /* A result only ships when it has an approved downloadable source:
   * no pirated-host mirrors, no EPUBs without a usable download path. */
  const mirrors = Array.isArray(book.mirrors)
    ? book.mirrors
        .map(mirror => String(mirror || "").trim())
        .filter(mirror => {
          try {
            const parsed = new URL(mirror);
            return /^https?:$/.test(parsed.protocol) && isApprovedHost(parsed.hostname);
          } catch {
            return false;
          }
        })
        .slice(0, 4)
    : [];

  return {
    id: String(book.id || ""),
    source: "libgen",
    title: String(book.title || "Untitled"),
    author: String(book.author || "Unknown author"),
    publisher: String(book.publisher || ""),
    year: String(book.year || ""),
    language: String(book.language || ""),
    pages: String(book.pages || ""),
    size: String(book.size || ""),
    extension: String(book.extension || "").toLowerCase(),
    md5: String(book.md5 || ""),
    date_added: String(book.date_added || ""),
    date_last_modified: String(book.date_last_modified || ""),
    ...(mirrors.length ? { mirrors } : null)
  };
}

/* Curation: user-typed name/author should surface the book itself, so rank
 * results by how well title+author match the query tokens. */
function relevance(book, tokens) {
  if (!tokens.length) return 0;
  const title = book.title.toLowerCase();
  const author = book.author.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 2;
    if (author.includes(token)) score += 1;
  }
  if (tokens.every(token => title.includes(token))) score += 2;
  if (tokens.every(token => author.includes(token)) && tokens.length >= 2) score += 1;
  /* A short title is usually the book itself, not a collected omnibus. */
  if (title.length <= 60) score += 1;
  return score;
}

/* Hosts the EPUB downloader is allowed to contact. Every resolved download
 * URL (including redirect targets) must match one of these. libgen.li
 * redirects get.php to its book CDN (cdn*.booksdl.lc), so that suffix is
 * approved too. */
export const APPROVED_HOSTS = ["libgen.li", "libgen.is", "libgen.rs"];
export const APPROVED_HOST_SUFFIXES = [".libgen.li", ".libgen.is", ".libgen.rs", ".booksdl.lc"];

/* Must stay identical to libgen_api_enhanced.constants.DEFAULT_HEADERS: the
 * download keys the mirror issues are UA/session-bound, so the actual file
 * request has to come from the same client identity that resolved them. */
export const PYTHON_LIB_USER_AGENT = "libgen-api-enhanced/1.4 (+https://github.com/onurhanak/libgen-api-enhanced)";

export function isApprovedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (APPROVED_HOSTS.includes(host)) return true;
  return APPROVED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/* Server-derived filenames are never trusted: strip path/separator
 * characters, cap the length, force the wanted extension, and avoid names
 * Windows can't create (reserved devices, trailing dots/spaces). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function sanitizeFilename(name, extension) {
  const ext = String(extension || "epub").toLowerCase();
  let base = String(name || "book")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .replace(/[. ]+$/, "");
  if (WINDOWS_RESERVED.test(base)) base = `${base} book`;
  while (base.toLowerCase().endsWith(`.${ext}`)) {
    base = base.slice(0, -(ext.length + 1)).trim().replace(/[. ]+$/, "");
  }
  return `${base || "book"}.${ext}`;
}

/* Source adapter: turn a libgen search result into a validated direct
 * EPUB download for the Electron download manager. */
export function approvedMirrors(request = {}) {
  return (Array.isArray(request.mirrors) ? request.mirrors : [])
    .filter(mirror => typeof mirror === "string")
    .map(mirror => mirror.trim())
    .filter(Boolean)
    .slice(0, 4)
    .filter(mirror => {
      try {
        const parsed = new URL(mirror);
        if (!/^https?:$/.test(parsed.protocol)) return false;
        return isApprovedHost(parsed.hostname);
      } catch {
        return false;
      }
    });
}

export async function resolveDownload(request = {}) {
  const md5 = String(request.md5 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    throw new Error("Invalid download reference (bad md5)");
  }

  const extension = String(request.extension || "").trim().toLowerCase();
  if (extension !== "epub") {
    throw new Error("Only EPUB books can be downloaded");
  }

  /* One mirror per attempt, in order; the caller retries on failure. */
  const mirrors = approvedMirrors(request);
  if (!mirrors.length) {
    throw new Error("No approved mirror found for this book");
  }

  const response = await runPython({ action: "resolve", md5, mirrors });

  const url = String(response?.url || "");
  if (!url) {
    throw new Error("Could not resolve a direct download link");
  }

  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("The resolved download URL is not valid");
  }
  if (!isApprovedHost(parsed.hostname)) {
    throw new Error("The resolved download host is not approved");
  }

  return {
    url,
    filename: sanitizeFilename(String(request.title || ""), "epub"),
    headers: { "User-Agent": PYTHON_LIB_USER_AGENT },
    expectedSize: null,
    source: "libgen"
  };
}

/* Run libgen.py once with the first working Python interpreter. */
async function runPython(payload) {
  let missing = null;
  for (const candidate of pythonCandidates()) {
    try {
      return await runWithPython(candidate, payload);
    } catch (error) {
      if (error && error.code === "ENOENT") { missing = error; continue; } // no such binary: try the next
      throw error;
    }
  }
  const error = new Error(PYTHON_HINT);
  error.cause = missing;
  throw error;
}

function runWithPython({ cmd, args }, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      cmd,
      [...args, PYTHON_SCRIPT],
      {
        cwd: PROJECT_ROOT,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");

      if (!settled) {
        settled = true;
        reject(new Error("LibGen request timed out."));
      }
    }, 45000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", chunk => {
      stdout += chunk;

      if (stdout.length > 10 * 1024 * 1024) {
        child.kill("SIGTERM");
        reject(new Error("LibGen returned too much data."));
      }
    });

    child.stderr.on("data", chunk => {
      stderr += chunk;
    });

    child.on("error", error => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("close", code => {
      clearTimeout(timeout);

      if (settled) return;
      settled = true;

      if (code !== 0) {
        if (/No module named ['"]?libgen_api_enhanced/.test(stderr)) {
          return reject(new Error(`${PYTHON_HINT} (the interpreter used was "${cmd}")`));
        }
        return reject(
          new Error(stderr.trim() || `Python exited with code ${code}`)
        );
      }

      try {
        const result = JSON.parse(stdout);

        if (result.error) {
          return reject(new Error(result.error));
        }

        resolve(result);
      } catch {
        reject(
          new Error("Could not parse LibGen response: " + stdout.slice(0, 300))
        );
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function search(query, options = {}) {
  const q = String(query || "").trim();

  if (!q) {
    return {
      results: [],
      errors: [],
      page: 1,
      total: 0
    };
  }

  const mode = VALID_MODES.includes(options.mode)
    ? options.mode
    : "default";

  const requestedTopics = Array.isArray(options.topics)
    ? options.topics
    : ["libgen"];

  const topics = requestedTopics.filter(topic =>
    VALID_TOPICS.includes(topic)
  );

  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);

  const response = await runPython({
    query: q,
    mode,
    page,
    topics: topics.length ? topics : ["libgen"]
  });

  /* Belt and braces with the engine filter: EPUB + md5 + approved source,
   * deduped by md5 (same book shows up in several rows), ranked by how
   * directly the result matches the typed title/author. */
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set();
  const filtered = (response.results || [])
    .map(normalizeBook)
    .filter(book =>
      book.extension === "epub" &&
      /^[\dA-Fa-f]{32}$/.test(book.md5) &&
      Array.isArray(book.mirrors) && book.mirrors.length)
    .filter(book => {
      const key = book.md5.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const ranked = filtered
    .map((book, index) => ({ book, index, score: relevance(book, tokens) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.book);

  return {
    results: ranked,
    errors: [],
    page: response.page || page,
    total: response.total ?? null
  };
}

// Search and metadata are supported.
// Downloading is intentionally not implemented as an unrestricted
// LibGen mirror downloader.
export async function download() {
  throw new Error(
    "Direct LibGen downloads are not supported. " +
    "Use an authorized source for the book file."
  );
}
