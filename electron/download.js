// Download manager (Electron main process).
//
// Downloads an EPUB from a resolved, approved source URL into a temporary
// file, validates it, then returns the raw bytes to the renderer so they
// enter the normal import pipeline (parseEpub → Library.add). The renderer
// never sees filesystem paths and can only reach explicitly approved hosts.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { isApprovedHost, sanitizeFilename } from '../engine/sources.js';

const DEFAULTS = {
  maxRedirects: 5,
  // connect (per-request) and per-request idle timeouts in ms
  connectTimeout: 20_000,
  idleTimeout: 30_000,
  // hard ceiling for the whole job: ~2 min for MB-scale EPUBs at slow speeds
  overallTimeout: 10 * 60 * 1000,
  // 200 MB configured maximum EPUB size
  maxSize: 200 * 1024 * 1024,
  // progress reporting throttle in ms
  progressInterval: 100,
  protocols: ['https:', 'http:'],
};

const STATUS = {
  resolving: 'resolving',
  connecting: 'connecting',
  downloading: 'downloading',
  validating: 'validating',
  importing: 'importing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export class DownloadError extends Error {}

class DownloadManager {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    // Host checks come from engine/sources.js; override only in tests.
    this.isHostAllowed = options.isHostAllowed || isApprovedHost;
    this.jobs = new Map(); // downloadId -> job
  }

  /** Abort an active download (no-op if it already finished). Never throws. */
  cancel(downloadId) {
    const job = this.jobs.get(String(downloadId));
    if (!job) return false;
    job.cancelled = true;
    try { job.abort?.(new DownloadError('Download cancelled')); } catch { /* ignore */ }
    return true;
  }

  /**
   * request: { md5, title, extension }   (renderer-supplied, already checked)
   * handlers.resolve: async (request) => { url, filename, headers, ... }
   * handlers.onProgress: (event { downloadId, status, received, total, percentage }) => void
   * handlers.tempDir: where the .part file is written
   * Resolves to { success:true, bytes, filename, size } or { success:false, error }.
   */
  download(request, { resolve, onProgress, tempDir } = {}) {
    const id = `dl-${crypto.randomBytes(8).toString('hex')}`;
    const options = this.options;
    const job = { cancelled: false, received: 0, total: 0, abort: null };
    this.jobs.set(id, job);

    const emit = (extra = {}) => {
      onProgress?.({ downloadId: id, ...extra });
    };
    const statusEvent = (status) => {
      const { received, total } = job;
      emit({
        status, received, total,
        percentage: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
      });
    };

    let tempPath = null;

    const cleanupFile = async () => { if (tempPath) await fsp.rm(tempPath, { force: true }).catch(() => {}); };
    const failure = async (error) => {
      job.abort = null;
      await cleanupFile();
      const cancelled = job.cancelled;
      const message = cancelled ? 'Download cancelled' : String(error?.message || error || 'Download failed');
      statusEvent(cancelled ? STATUS.cancelled : STATUS.failed);
      return cancelled ? { success: false, cancelled: true, downloadId: id, error: message } : { success: false, downloadId: id, error: message };
    };

    return (async () => {
      try {
        /* 1. resolve an authorized source */
        statusEvent(STATUS.resolving);
        const source = await resolve(request);
        if (!source || typeof source !== 'object') throw new DownloadError('Failed to resolve the download source');

        /* 2. validate the source before touching the network */
        const target = this.#validatedTarget(source);
        const filename = sanitizeFilename(target.filename || request?.title, 'epub');
        if (target.expectedSize > options.maxSize) {
          throw new DownloadError(`The file is larger than the ${fmtSize(options.maxSize)} EPUB limit`);
        }

        tempPath = path.join(tempDir || os.tmpdir(), `${id}.part`);
        await fsp.mkdir(path.dirname(tempPath), { recursive: true });
        await fsp.rm(tempPath, { force: true });

        /* 3. fetch with redirect re-validation */
        statusEvent(STATUS.connecting);
        const { res, total } = await this.#connect(target.url, target.headers || {}, job);
        if (job.cancelled) {
          try { res.destroy(new DownloadError('Download cancelled')); } catch { /* ignore */ }
          throw new DownloadError('Download cancelled');
        }
        job.total = total;

        /* 4. stream to the temp file (never straight into books/) */
        statusEvent(STATUS.downloading);
        job.abort = (err) => { try { res.destroy(err || new DownloadError('Download cancelled')); } catch { /* ignore */ } };
        await this.#saveAtomically(res, tempPath, job, statusEvent);

        /* 5. validate ZIP + EPUB structure */
        statusEvent(STATUS.validating);
        const size = await this.#validateEpub(tempPath);
        if (size > options.maxSize) {
          throw new DownloadError(`The file is larger than the ${fmtSize(options.maxSize)} EPUB limit`);
        }

        /* 6. hand the bytes to the renderer's import pipeline, then clean up */
        const bytes = new Uint8Array(await fsp.readFile(tempPath));
        statusEvent(STATUS.importing);
        await cleanupFile();
        job.abort = null;
        statusEvent(STATUS.completed);
        return { success: true, downloadId: id, filename, size, bytes };
      } catch (error) {
        return failure(error);
      } finally {
        this.jobs.delete(id);
      }
    })();
  }

  #validatedTarget(source) {
    const { protocols } = this.options;
    if (typeof source.url !== 'string') throw new DownloadError('The download URL is missing');
    let url;
    try { url = new URL(source.url); } catch {
      throw new DownloadError('The resolved download URL is not valid');
    }
    if (!protocols.includes(url.protocol)) {
      throw new DownloadError(`Unsupported protocol: ${url.protocol}`);
    }
    if (!this.isHostAllowed(url.hostname)) {
      throw new DownloadError('The download host is not approved');
    }
    return { ...source, url, expectedSize: Number(source.expectedSize) > 0 ? Number(source.expectedSize) : 0 };
  }

  #validateEpub(tempPath) {
    return (async () => {
      const handle = await fsp.open(tempPath, 'r');
      try {
        const { size } = await handle.stat();
        // ZIP local file header: 30-byte fixed part, then name/extra.
        const HEAD = 256;
        const TAIL = 65 * 1024;
        if (size < 100) {
          throw new DownloadError('The downloaded file is too small to be an EPUB');
        }
        const head = Buffer.alloc(HEAD);
        const TAIL_BUFFER = Buffer.alloc(TAIL);
        await handle.read(head, 0, HEAD, 0);

        if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
          throw new DownloadError('The download is not a ZIP archive (EPUB)');
        }

        const nameLength = head.readUInt16LE(26);
        const extraLength = head.readUInt16LE(28);
        if (nameLength === 0 || 30 + nameLength + extraLength > HEAD) {
          throw new DownloadError('The download ZIP has an unexpected first entry');
        }
        const entryName = head.subarray(30, 30 + nameLength).toString('latin1');
        if (entryName !== 'mimetype') {
          throw new DownloadError('The download is a ZIP file, but not an EPUB (no mimetype entry first)');
        }
        const dataOffset = 30 + nameLength + extraLength;
        const mime = head.subarray(dataOffset, dataOffset + 'application/epub+zip'.length).toString('ascii');
        if (mime !== 'application/epub+zip') {
          throw new DownloadError('The download is a ZIP file, but declares a different content type');
        }

        // End-of-central-directory record catches truncated downloads.
        const tailStart = Math.max(0, size - TAIL_BUFFER.length);
        const ran = await handle.read(TAIL_BUFFER, 0, TAIL_BUFFER.length, tailStart);
        const tail = TAIL_BUFFER.subarray(0, ran.bytesRead);
        let eocdFound = false;
        for (let i = tail.length - 22; i >= 0; i--) {
          if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
            eocdFound = true; break;
          }
        }
        if (!eocdFound) {
          throw new DownloadError('The download was cut short (incomplete ZIP)');
        }

        return size;
      } finally {
        await handle.close();
      }
    })();
  }

  #saveAtomically(res, tempPath, job, statusEvent) {
    const options = this.options;
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastProgressAt = 0;
      const out = fs.createWriteStream(tempPath);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(wholeTimer);
        out.destroy();
        res.destroy();
        const message = error?.message === 'aborted' ? 'Connection interrupted' : (error?.message || 'Download failed');
        reject(error instanceof DownloadError ? error : new DownloadError(message));
      };
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(wholeTimer);
        out.end();
        resolve();
      };

      const wholeTimer = setTimeout(() => fail(new DownloadError('Download timed out')), options.overallTimeout);

      out.on('error', (err) => fail(err));
      res.on('error', (err) => fail(err));
      res.on('end', () => { out.end(); });
      res.on('close', () => { if (!out.writableEnded && !settled) fail(new DownloadError('Connection interrupted')); });
      out.on('finish', () => done());

      res.on('data', (chunk) => {
        if (settled) return;
        if (job.cancelled) return fail(new DownloadError('Download cancelled'));
        job.received += chunk.length;
        if (job.total > 0 && job.received > job.total) job.total = job.received; // header said smaller
        if (job.received > options.maxSize) {
          return fail(new DownloadError(`The file is larger than the ${fmtSize(options.maxSize)} EPUB limit`));
        }
        if (!out.write(chunk)) {
          res.pause();
          out.once('drain', () => { if (!settled) res.resume(); });
        }
        const now = Date.now();
        if (now - lastProgressAt >= options.progressInterval) {
          lastProgressAt = now;
          statusEvent(STATUS.downloading);
        }
      });
    });
  }

  #connect(initialURL, headers, job) {
    const options = this.options;
    const requestHeaders = {
      Accept: 'application/epub+zip, application/zip, */*',
      ...headers,
    };
    if (typeof requestHeaders.Authorization !== 'undefined') delete requestHeaders.Authorization;
    let currentURL = initialURL;
    let redirects = 0;

    return new Promise((resolveResponse, rejectResponse) => {
      let settled = false;
      const fail = (error, res) => {
        if (settled) return;
        settled = true;
        try { res?.destroy?.(); } catch { /* ignore */ }
        rejectResponse(error instanceof DownloadError ? error : new DownloadError(error?.message || 'Connection failed'));
      };

      const attempt = () => {
        if (job.cancelled) return fail(new DownloadError('Download cancelled'));
        let url;
        try { url = new URL(currentURL); } catch {
          return fail(new DownloadError('The download URL is not valid'));
        }
        if (!options.protocols.includes(url.protocol)) {
          return fail(new DownloadError(`Unsupported protocol during a redirect: ${url.protocol}`));
        }
        // Every hop re-checks the shared security settings (redirect + host).
        if (!this.isHostAllowed(url.hostname)) {
          return fail(new DownloadError('A redirect went to an unapproved host'));
        }

        const mod = url.protocol === 'https:' ? https : http;
        const req = mod.get(url.href, { headers: requestHeaders, timeout: options.connectTimeout }, (res) => {
          req.setTimeout(options.idleTimeout, () => req.destroy(new DownloadError('Connection timed out')));
          const code = res.statusCode || 0;

          if ([301, 302, 303, 307, 308].includes(code)) {
            const location = res.headers.location;
            res.resume();
            if (++redirects > options.maxRedirects) {
              return fail(new DownloadError('Too many redirects'), null);
            }
            if (!location) {
              return fail(new DownloadError(`HTTP ${code} redirect without a target`), null);
            }
            try {
              const next = new URL(location, url.href);
              if (next.protocol !== 'https:' && next.protocol !== 'http:') {
                return fail(new DownloadError(`Unsupported redirect protocol: ${next.protocol}`), null);
              }
              if (!this.isHostAllowed(next.hostname)) {
                return fail(new DownloadError('A redirect went to an unapproved host'), null);
              }
              currentURL = next.href;
              attempt();
            } catch {
              fail(new DownloadError('A redirect target was not valid'), null);
            }
            return;
          }
          if (code >= 400) {
            res.resume();
            return fail(new DownloadError(`Download failed: HTTP ${code}`), res);
          }
          if (code !== 200) {
            res.resume();
            return fail(new DownloadError(`Unexpected HTTP ${code}`), res);
          }

          const length = Number(res.headers['content-length']) || 0;
          if (length > options.maxSize) {
            res.resume();
            return fail(new DownloadError(`The file is larger than the ${fmtSize(options.maxSize)} EPUB limit`), res);
          }
          resolveResponse({ res, total: length });
        });

        req.on('timeout', () => req.destroy(new DownloadError('Connection timed out')));
        req.on('error', (err) => fail(err));
      };

      attempt();
    });
  }
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${bytes} B`;
}

export const defaultTempDir = () => path.join(os.tmpdir(), 'paperback-downloads');

export { DownloadManager };
