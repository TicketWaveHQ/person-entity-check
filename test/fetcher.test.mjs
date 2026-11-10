import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addHtmlFiles,
  createFetcher,
  DEFAULT_USER_AGENT,
  errorCode,
  loadSnapshot,
  networkTransport,
  snapshotTransport,
} from '../src/fetcher.mjs';
import { fakeClock, FIXTURES, SNAPSHOT, stubFetch } from './helpers.mjs';

function net(routes, opts = {}) {
  const stub = stubFetch(routes);
  const clock = fakeClock();
  const fetcher = createFetcher({
    transport: networkTransport({ fetchImpl: stub.fetch, ...opts.transport }),
    sleep: clock.sleep,
    now: clock.now,
    delayMs: 500,
    ...opts.fetcher,
  });
  return { stub, clock, fetcher };
}

test('follows redirects by hand and records every hop', async () => {
  const { fetcher } = net({
    'https://example.com/a': { status: 301, location: '/b' },
    'https://example.com/b': { status: 308, location: 'https://example.org/c' },
    'https://example.org/c': { status: 200, body: '<p>c</p>' },
  });
  const res = await fetcher.resolve('https://example.com/a', { wantBody: true });
  assert.deepEqual(
    res.chain.map((h) => [h.url, h.status]),
    [
      ['https://example.com/a', 301],
      ['https://example.com/b', 308],
      ['https://example.org/c', 200],
    ],
  );
  assert.equal(res.finalUrl, 'https://example.org/c');
  assert.equal(res.body, '<p>c</p>');
});

test('never requests a URL twice, even through shared redirect hops', async () => {
  const { fetcher, stub } = net({
    'https://example.com/one': { status: 301, location: 'https://example.com/shared' },
    'https://example.com/two': { status: 301, location: 'https://example.com/shared' },
    'https://example.com/shared': { status: 200, body: 'x' },
  });
  await fetcher.resolve('https://example.com/one');
  await fetcher.resolve('https://example.com/two');
  await fetcher.resolve('https://example.com/one#fragment');
  await fetcher.resolve('https://example.com/shared');
  const urls = stub.calls.map((c) => c.url);
  assert.deepEqual(urls, ['https://example.com/one', 'https://example.com/shared', 'https://example.com/two']);
  assert.equal(fetcher.requests, 3);
  assert.equal(fetcher.has('https://example.com/two'), true);
});

test('sends GET with redirect manual, a descriptive User-Agent and a timeout signal', async () => {
  const { fetcher, stub } = net({ 'https://example.com/': { status: 200, body: '' } });
  await fetcher.resolve('https://example.com/');
  const { init } = stub.calls[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers['user-agent'], DEFAULT_USER_AGENT);
  assert.match(DEFAULT_USER_AGENT, /^person-entity-check\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/TicketWaveHQ\/person-entity-check\)$/);
  assert.ok(init.signal instanceof AbortSignal);
});

test('spaces requests by the delay and does not wait before the first', async () => {
  const { fetcher, clock } = net({
    'https://example.com/1': { status: 200 },
    'https://example.com/2': { status: 200 },
    'https://example.com/3': { status: 200 },
  });
  await fetcher.resolve('https://example.com/1');
  await fetcher.resolve('https://example.com/2');
  clock.advance(200);
  await fetcher.resolve('https://example.com/3');
  assert.deepEqual(clock.waits, [500, 300]);
});

test('requests are serialised even when started together', async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return new Response('', { status: 200 });
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl }), delayMs: 0 });
  await Promise.all(['a', 'b', 'c'].map((p) => fetcher.resolve(`https://example.com/${p}`)));
  assert.equal(peak, 1);
});

test('timeouts, DNS failures and other errors become short codes without addresses', async () => {
  const { fetcher } = net({
    'https://slow.example.com/': { error: 'timeout' },
    'https://refused.example.com/': { error: 'ECONNREFUSED' },
  });
  assert.equal((await fetcher.resolve('https://slow.example.com/')).error, 'timeout');
  assert.equal((await fetcher.resolve('https://refused.example.com/')).error, 'ECONNREFUSED');
  assert.equal((await fetcher.resolve('https://missing.example.com/')).error, 'ENOTFOUND');
  assert.equal(errorCode(new Error('connect ECONNREFUSED somewhere')), 'network error');
});

test('a real timeout aborts the request', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl, timeoutMs: 20 }), delayMs: 0 });
  assert.equal((await fetcher.resolve('https://example.com/')).error, 'timeout');
});

test('redirect loops and long chains stop', async () => {
  const { fetcher } = net(
    {
      'https://example.com/a': { status: 302, location: '/b' },
      'https://example.com/b': { status: 302, location: '/a' },
      'https://example.com/c1': { status: 302, location: '/c2' },
      'https://example.com/c2': { status: 302, location: '/c3' },
      'https://example.com/c3': { status: 302, location: '/c4' },
    },
    { fetcher: { maxRedirects: 2 } },
  );
  assert.equal((await fetcher.resolve('https://example.com/a')).error, 'redirect loop');
  assert.equal((await fetcher.resolve('https://example.com/c1')).error, 'too many redirects');
});

test('a redirect to a non-web address stops', async () => {
  const { fetcher } = net({ 'https://example.com/mail': { status: 302, location: 'mailto:jane@example.com' } });
  assert.equal((await fetcher.resolve('https://example.com/mail')).error, 'redirect to a non-web address');
});

test('bodies are read only when asked for, and capped', async () => {
  const big = 'x'.repeat(5000);
  const { fetcher } = net(
    {
      'https://example.com/page': { status: 200, body: big },
      'https://example.com/target': { status: 200, body: big },
    },
    { transport: { maxBytes: 1000 } },
  );
  const p = await fetcher.resolve('https://example.com/page', { wantBody: true });
  assert.equal(p.body.length, 1000);
  assert.equal(p.truncated, true);
  const t = await fetcher.resolve('https://example.com/target');
  assert.equal(t.body, null);
});

test('status 999 (outside what Response allows) still comes through', async () => {
  const { fetcher } = net({ 'https://social.example.com/in/jane': { status: 999 } });
  assert.equal((await fetcher.resolve('https://social.example.com/in/jane')).status, 999);
});

test('snapshot transport replays the fixture, including redirects; no waiting', async () => {
  const snap = await loadSnapshot(SNAPSHOT);
  const clock = fakeClock();
  const fetcher = createFetcher({ transport: snapshotTransport(snap), sleep: clock.sleep, now: clock.now });
  const res = await fetcher.resolve('https://old.example.org/jane');
  assert.deepEqual(res.chain.map((h) => h.status), [301, 200]);
  const pageRes = await fetcher.resolve('https://alpha.example.com/jane', { wantBody: true });
  assert.match(pageRes.body, /Jane Example/);
  assert.equal((await fetcher.resolve('https://unknown.example.com/')).error, 'not in snapshot');
  assert.deepEqual(clock.waits, []);
  assert.equal(fetcher.network, false);
});

test('a missing snapshot directory is a clear error', async () => {
  await assert.rejects(loadSnapshot(join(FIXTURES, 'no-such-dir')), /Cannot read snapshot .*file not found/);
});

test('--html pairs serve a file as a 200', async () => {
  const snap = addHtmlFiles(null, [{ url: 'https://example.com/jane', file: join(FIXTURES, 'pages', 'plain.html') }]);
  const fetcher = createFetcher({ transport: snapshotTransport(snap) });
  const res = await fetcher.resolve('https://example.com/jane', { wantBody: true });
  assert.equal(res.status, 200);
  assert.match(res.body, /An example page/);
});

test('save writes a snapshot that replays the same responses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pec-'));
  try {
    const { fetcher } = net({
      'https://example.com/jane': { status: 200, body: '<title>Jane</title>' },
      'https://example.com/old': { status: 301, location: 'https://example.org/' },
      'https://example.org/': { status: 200, body: 'not saved: not a page' },
      'https://example.com/gone': { status: 404 },
    });
    await fetcher.resolve('https://example.com/jane', { wantBody: true });
    await fetcher.resolve('https://example.com/old');
    await fetcher.resolve('https://example.com/gone');
    assert.equal(await fetcher.save(dir), 4);
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    assert.equal(index.responses['https://example.com/old'].location, 'https://example.org/');
    assert.equal(index.responses['https://example.org/'].file, undefined, 'only page bodies are saved');
    const replay = createFetcher({ transport: snapshotTransport(await loadSnapshot(dir)) });
    assert.equal((await replay.resolve('https://example.com/jane', { wantBody: true })).body, '<title>Jane</title>');
    assert.deepEqual((await replay.resolve('https://example.com/old')).chain.map((h) => h.status), [301, 200]);
    assert.equal((await replay.resolve('https://example.com/gone')).status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
