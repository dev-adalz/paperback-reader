
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { search } from "./engine/sources.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".epub": "application/epub+zip"
};

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method !== "GET") {
      return json(res, 405, { error: "Method not allowed" });
    }

    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q") || "";

      const topics = url.searchParams.getAll("topics")
        .flatMap(value => value.split(","))
        .filter(Boolean);

      const options = {
        mode: url.searchParams.get("mode") || "default",
        page: url.searchParams.get("page") || "1",
        topics: topics.length ? topics : ["libgen"]
      };

      if (!query.trim()) {
        return json(res, 400, { error: "Search query is required" });
      }

      const result = await search(query, options);
      return json(res, 200, result);
    }
    if (url.pathname === "/api/download") {
  return json(res, 501, {
    error: "LibGen downloads are not enabled. Use an authorized source for the EPUB file."
  });
}
    if (url.pathname === "/api/health") {
      return json(res, 200, { status: "ok", engine: "libgen" });
    }

    if (url.pathname === "/favicon.ico") {
  res.writeHead(204);
  return res.end();
}

    const requested = decodeURIComponent(url.pathname);
    const relative = requested === "/" ? "index.html" : requested.slice(1);
    const filePath = path.resolve(ROOT, relative);

    if (!filePath.startsWith(ROOT + path.sep)) {
      return json(res, 403, { error: "Forbidden" });
    }

    const content = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();

    res.writeHead(200, {
      "Content-Type": MIME[extension] || "application/octet-stream"
    });

    res.end(content);

  } catch (error) {
    console.error("[Server]", error);

    if (error.code === "ENOENT") {
      return json(res, 404, { error: "Not found" });
    }

    json(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Reader running at http://localhost:${server.address().port}`);
});

// The desktop app (electron/main.js) imports this module with PORT=0 and
// forwards paperback://app/api/* to whatever port was assigned.
export default server;
