// Shared test helpers: a stubbed fetch that serves the fixture snapshot, so the
// network path and the --no-network path are tested against the same data.
// Every fixture uses example.com and example.org only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const SNAPSHOT = join(FIXTURES, 'snapshot');
export const SET_FILE = join(FIXTURES, 'set.txt');

export const PAGES = [
  'https://alpha.example.com/jane',
  'https://beta.example.org/jane',
  'https://gamma.example.com/people/jane',
  'https://delta.example.org/jane',
];
export const PROFILES = ['https://code.example.org/jane', 'https://social.example.com/in/jane', 'https://photos.example.org/jane'];

export function fixtureRoutes() {
  return JSON.parse(readFileSync(join(SNAPSHOT, 'index.json'), 'utf8')).responses;
}

export function page(name) {
  return readFileSync(join(FIXTURES, 'pages', name), 'utf8');
}

/**
 * A fetch stand-in. `routes` maps URL to { status, location, file | body, error }.
 * Unknown URLs fail like a DNS miss. Records every call with its options.
 */
export function stubFetch(routes, { base = SNAPSHOT } = {}) {
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push({ url, init });
    const entry = routes[url];
    if (!entry || entry.error) {
      if (entry?.error === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      const err = new TypeError('fetch failed');
      err.cause = { code: entry?.error ?? 'ENOTFOUND' };
      throw err;
    }
    const headers = new Headers();
    if (entry.location) headers.set('location', entry.location);
    const body = entry.file ? readFileSync(join(base, entry.file), 'utf8') : entry.body ?? '';
    if (entry.file || entry.body) headers.set('content-type', entry.contentType ?? 'text/html; charset=utf-8');
    const status = entry.status ?? 200;
    if (status >= 200 && status <= 599 && ![204, 205, 304].includes(status)) return new Response(body, { status, headers });
    // Response refuses statuses outside 200-599, such as LinkedIn's 999.
    return { status, headers, body: null, text: async () => body };
  }
  return { fetch, calls };
}

/** A sleep that records the waits instead of waiting. */
export function fakeClock() {
  let t = 0;
  const waits = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A writable that keeps what is written. */
export function sink({ isTTY = false } = {}) {
  let text = '';
  return {
    isTTY,
    write(s) {
      text += s;
      return true;
    },
    get text() {
      return text;
    },
  };
}

export function checksOf(report, filter = {}) {
  return report.findings
    .filter((f) => (filter.page === undefined || f.page === filter.page) && (filter.severity === undefined || f.severity === filter.severity))
    .map((f) => f.check);
}
