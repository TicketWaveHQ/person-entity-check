// Polite fetching.
//
// A transport makes exactly one request for one URL and does not follow
// redirects. The fetcher on top of it follows redirects hop by hop, so every
// status in the chain is recorded, and caches every hop by URL, so no URL is
// requested twice in a run even when two listed links redirect through the
// same address. Requests are serialised and spaced by `delayMs`.
//
// Two transports: the network one (global fetch, or a stub in tests) and the
// snapshot one, which replays saved responses for --no-network runs.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { VERSION } from './version.mjs';
import { isPrivateAddress, isWeb, toUrl } from './urls.mjs';

export const DEFAULT_USER_AGENT = `person-entity-check/${VERSION} (+https://github.com/TicketWaveHQ/person-entity-check)`;
export const DEFAULTS = Object.freeze({ timeoutMs: 10000, delayMs: 1000, maxRedirects: 10, maxBytes: 5 * 1024 * 1024 });

/** Reduce a fetch failure to a short code. Messages are not used: they can carry addresses. */
export function errorCode(err) {
  if (!err) return 'network error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const code = err.cause?.code ?? err.code;
  return typeof code === 'string' && code ? code : 'network error';
}

function charsetOf(contentType) {
  const m = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType || '');
  return m ? m[1].trim() : 'utf-8';
}

async function readBody(res, maxBytes, contentType) {
  let decoder;
  try {
    decoder = new TextDecoder(charsetOf(contentType));
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = typeof res.text === 'function' ? await res.text() : '';
    return text.length > maxBytes ? { body: text.slice(0, maxBytes), truncated: true } : { body: text, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
    if (size + chunk.byteLength > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  return { body: decoder.decode(Buffer.concat(chunks)), truncated };
}

async function discard(res) {
  try {
    await res.body?.cancel?.();
  } catch {
    // nothing to do: the body is not needed
  }
}

export function networkTransport({
  fetchImpl = globalThis.fetch,
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = DEFAULTS.timeoutMs,
  maxBytes = DEFAULTS.maxBytes,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch available: Node 20 or later is required');
  return {
    network: true,
    async request(url, { wantBody = false } = {}) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': userAgent,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-language': 'en-GB,en;q=0.8',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { url, error: errorCode(err) };
      }
      const status = res.status;
      const location = res.headers?.get?.('location') ?? null;
      const contentType = res.headers?.get?.('content-type') ?? null;
      if (wantBody && status >= 200 && status < 300) {
        try {
          const { body, truncated } = await readBody(res, maxBytes, contentType);
          return { url, status, location, contentType, body, truncated };
        } catch (err) {
          return { url, status, location, contentType, error: errorCode(err) };
        }
      }
      await discard(res);
      return { url, status, location, contentType, body: null, truncated: false };
    },
  };
}

function keyOf(url) {
  const u = toUrl(url);
  if (!u) return url;
  u.hash = '';
  return u.href;
}

/**
 * Load a snapshot directory written by --save, or a hand-written one. index.json:
 *   { "responses": { "<url>": { "status": 200, "file": "page.html" },
 *                    "<url>": { "status": 301, "location": "<url>" },
 *                    "<url>": { "error": "timeout" } } }
 * `status` defaults to 200 when `file` is given. File paths are relative to the directory.
 */
export async function loadSnapshot(dir) {
  const indexPath = join(dir, 'index.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read snapshot ${indexPath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
  }
  const responses = new Map();
  for (const [url, entry] of Object.entries(parsed.responses ?? {})) {
    const file = entry.file ? (isAbsolute(entry.file) ? entry.file : join(dir, entry.file)) : null;
    responses.set(keyOf(url), { ...entry, file });
  }
  return { dir, responses };
}

/** Add `--html URL=FILE` pairs to a snapshot (or start one). Files are relative to the working directory. */
export function addHtmlFiles(snapshot, pairs) {
  const out = snapshot ?? { dir: null, responses: new Map() };
  for (const { url, file } of pairs) out.responses.set(keyOf(url), { status: 200, file: resolvePath(file) });
  return out;
}

export function snapshotTransport(snapshot) {
  return {
    network: false,
    async request(url) {
      const entry = snapshot.responses.get(keyOf(url));
      if (!entry) return { url, error: 'not in snapshot' };
      if (entry.error) return { url, status: entry.status ?? null, error: entry.error };
      const status = entry.status ?? 200;
      let body = null;
      if (entry.file) {
        try {
          body = await readFile(entry.file, 'utf8');
        } catch (err) {
          return { url, status, error: `snapshot file unreadable (${err.code || 'error'})` };
        }
      }
      return {
        url,
        status,
        location: entry.location ?? null,
        contentType: entry.contentType ?? (entry.file ? 'text/html' : null),
        body,
        truncated: false,
      };
    },
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFetcher({
  transport,
  delayMs = DEFAULTS.delayMs,
  maxRedirects = DEFAULTS.maxRedirects,
  sleep = defaultSleep,
  now = () => Date.now(),
  onRequest = null,
} = {}) {
  if (!transport) throw new Error('createFetcher needs a transport');
  const cache = new Map();
  const log = [];
  let queue = Promise.resolve();
  let lastAt = null;
  let requests = 0;

  function single(url, wantBody) {
    if (cache.has(url)) return cache.get(url);
    const job = queue.then(async () => {
      if (transport.network && lastAt !== null) {
        const wait = lastAt + delayMs - now();
        if (wait > 0) await sleep(wait);
      }
      requests += 1;
      if (onRequest) onRequest(url, requests);
      const raw = await transport.request(url, { wantBody });
      lastAt = now();
      log.push({ ...raw, wantBody });
      return raw;
    });
    queue = job.catch(() => {});
    cache.set(url, job);
    return job;
  }

  /**
   * Follow redirects from `start`. Each hop goes through the cache. Unless
   * `allowPrivate` is set (the CLI sets it for the pages you list), a hop to a
   * loopback, private or local-only address that has not already been fetched
   * is not requested.
   */
  async function resolve(start, { wantBody = false, allowPrivate = false } = {}) {
    const chain = [];
    const seen = new Set();
    let url = keyOf(start);
    for (let hops = 0; ; hops += 1) {
      if (seen.has(url)) return { chain, finalUrl: url, status: null, error: 'redirect loop' };
      seen.add(url);
      if (!allowPrivate && !cache.has(url) && isPrivateAddress(url)) {
        chain.push({ url, status: null, error: 'private address' });
        return { chain, finalUrl: url, status: null, error: 'private address' };
      }
      const raw = await single(url, wantBody);
      chain.push({ url, status: raw.status ?? null, ...(raw.error ? { error: raw.error } : {}) });
      if (raw.error) return { chain, finalUrl: url, status: raw.status ?? null, error: raw.error };
      const isRedirect = raw.status >= 300 && raw.status < 400 && raw.location;
      if (!isRedirect) {
        return {
          chain,
          finalUrl: url,
          status: raw.status,
          contentType: raw.contentType ?? null,
          body: raw.body ?? null,
          truncated: Boolean(raw.truncated),
        };
      }
      const next = toUrl(raw.location, url);
      if (!next) return { chain, finalUrl: url, status: raw.status, error: 'unreadable Location header' };
      if (!isWeb(next)) return { chain, finalUrl: next.href, status: raw.status, error: 'redirect to a non-web address' };
      if (hops + 1 > maxRedirects) return { chain, finalUrl: url, status: raw.status, error: 'too many redirects' };
      url = keyOf(next.href);
    }
  }

  async function save(dir) {
    await mkdir(dir, { recursive: true });
    const responses = {};
    for (const raw of log) {
      const entry = {};
      if (raw.status !== undefined && raw.status !== null) entry.status = raw.status;
      if (raw.location) entry.location = raw.location;
      if (raw.contentType) entry.contentType = raw.contentType;
      if (raw.error) entry.error = raw.error;
      if (raw.body !== null && raw.body !== undefined && raw.wantBody) {
        const u = toUrl(raw.url);
        const stem = u ? `${u.hostname}${u.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) : 'page';
        const hash = createHash('sha256').update(raw.url).digest('hex').slice(0, 8);
        entry.file = `${stem}-${hash}.html`;
        await mkdir(dirname(join(dir, entry.file)), { recursive: true });
        await writeFile(join(dir, entry.file), raw.body);
      }
      responses[raw.url] = entry;
    }
    const index = { savedBy: `person-entity-check ${VERSION}`, savedAt: new Date().toISOString(), responses };
    await writeFile(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    return Object.keys(responses).length;
  }

  return {
    resolve,
    save,
    /** True when `url` has already been requested in this run. */
    has(url) {
      return cache.has(keyOf(url));
    },
    get requests() {
      return requests;
    },
    get network() {
      return transport.network;
    },
  };
}
