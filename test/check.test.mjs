import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSet, checkEntities, classifyTarget, DEFAULT_WALLED_HOSTS, InputError } from '../src/check.mjs';
import { createFetcher, loadSnapshot, networkTransport, snapshotTransport } from '../src/fetcher.mjs';
import { checksOf, fakeClock, fixtureRoutes, PAGES, PROFILES, SNAPSHOT, stubFetch } from './helpers.mjs';

async function runFixture(options = {}, routes = fixtureRoutes()) {
  const stub = stubFetch(routes);
  const clock = fakeClock();
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stub.fetch }), sleep: clock.sleep, now: clock.now });
  const report = await checkEntities({ pages: PAGES, profiles: PROFILES, fetcher, ...options });
  return { report, stub, clock };
}

function finding(report, check, page) {
  return report.findings.find((f) => f.check === check && (page === undefined || f.page === page));
}

function target(report, url) {
  return report.targets.find((t) => t.url === url);
}

test('one request per URL across the whole run, all spaced by the delay', async () => {
  const { report, stub, clock } = await runFixture();
  const urls = stub.calls.map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length, 'no URL requested twice');
  assert.equal(urls.length, Object.keys(fixtureRoutes()).length, 'every fixture response used exactly once');
  assert.equal(report.requests, urls.length);
  assert.equal(clock.waits.length, urls.length - 1);
  assert.deepEqual(urls.slice(0, 4), PAGES, 'pages are fetched first, in order');
});

test('the network path and the snapshot path give the same findings', async () => {
  const { report: live } = await runFixture();
  const fetcher = createFetcher({ transport: snapshotTransport(await loadSnapshot(SNAPSHOT)) });
  const offline = await checkEntities({ pages: PAGES, profiles: PROFILES, fetcher });
  assert.deepEqual(
    offline.findings.map((f) => f.message),
    live.findings.map((f) => f.message),
  );
  assert.equal(offline.mode, 'no-network');
  assert.equal(live.mode, 'network');
});

test('names: mismatch against the majority, and alternateName gaps', async () => {
  const { report } = await runFixture();
  const mismatch = finding(report, 'name-mismatch', 3);
  assert.equal(mismatch.severity, 'warn');
  assert.match(mismatch.message, /"J\. Example".*\[1\], \[2\] use "Jane Example"/);
  const gap = finding(report, 'alternate-name-gap', 2);
  assert.equal(gap.severity, 'note');
  assert.match(gap.message, /"J\. Example"/);
  assert.equal(finding(report, 'alternate-name-gap', 1), undefined, 'page 1 lists both forms');
  assert.deepEqual(
    report.names.map((n) => [n.name, n.asName, n.asAlternateName]),
    [
      ['Jane Example', [1, 2], [3]],
      ['J. Example', [3], [1]],
    ],
  );
});

test('name that differs only in letter case says so; a missing name is an error', async () => {
  const routes = {
    'https://example.com/a': { body: '<script type="application/ld+json">{"@type":"Person","name":"Jane Example","url":"https://example.com/a"}</script>' },
    'https://example.com/b': { body: '<script type="application/ld+json">{"@type":"Person","name":"Jane Example","url":"https://example.com/b"}</script>' },
    'https://example.org/c': { body: '<script type="application/ld+json">{"@type":"Person","name":"jane example","url":"https://example.org/c"}</script>' },
    'https://example.org/d': { body: '<script type="application/ld+json">{"@type":"Person","url":"https://example.org/d"}</script>' },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: Object.keys(routes), fetcher, checkTargets: false });
  assert.match(finding(report, 'name-mismatch', 3).message, /differs only in letter case/);
  assert.equal(finding(report, 'name-missing', 4).severity, 'error');
});

test('sameAs coverage: which other set members each page leaves out', async () => {
  const { report } = await runFixture();
  const m1 = finding(report, 'sameas-missing', 1);
  assert.deepEqual(m1.missing, ['https://delta.example.org/jane', 'https://code.example.org/jane']);
  assert.deepEqual(finding(report, 'sameas-missing', 2).missing, ['https://gamma.example.com/people/jane', 'https://delta.example.org/jane']);
  assert.equal(finding(report, 'sameas-missing', 3), undefined, 'page 3 lists everyone');
  assert.deepEqual(
    report.pages[0].coverage.map((c) => c.state),
    ['self', 'listed', 'listed', 'missing', 'missing', 'listed', 'listed'],
  );
});

test('a page with no sameAs at all is told what to list', async () => {
  const routes = {
    'https://example.com/a': { body: '<script type="application/ld+json">{"@type":"Person","name":"Jane Example"}</script>' },
    'https://example.org/b': { body: '<script type="application/ld+json">{"@type":"Person","name":"Jane Example","sameAs":"https://example.com/a"}</script>' },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: Object.keys(routes), fetcher });
  assert.match(finding(report, 'sameas-missing', 1).message, /^the Person has no sameAs; it should list \[2\]/);
  assert.equal(finding(report, 'sameas-missing', 2), undefined);
});

test('sameAs entries outside the set are warned about, and still checked', async () => {
  const { report } = await runFixture();
  const unlisted = report.findings.filter((f) => f.check === 'sameas-unlisted').map((f) => [f.page, f.severity]);
  assert.deepEqual(unlisted, [
    [1, 'warn'],
    [2, 'warn'],
    [2, 'warn'],
    [3, 'warn'],
    [3, 'warn'],
  ]);
  assert.equal(target(report, 'https://elsewhere.example.org/jane').result, 'ok');
});

test('404 and 410 targets are dead (errors), with a rename hint when a same-host member is missing', async () => {
  const { report } = await runFixture();
  const dead = report.findings.filter((f) => f.check === 'sameas-dead');
  assert.deepEqual(dead.map((f) => [f.target, f.severity]), [
    ['https://code.example.org/jane-old', 'error'],
    ['https://gone.example.org/jane', 'error'],
  ]);
  assert.match(dead[0].message, /returns HTTP 404; listed by \[1\]\. \[5\] https:\/\/code\.example\.org\/jane is on the same host and missing from \[1\], so the profile may have been renamed/);
  assert.match(dead[1].message, /HTTP 410/);
});

test('a redirect to another host is an error; to another path on the same host, a warning', async () => {
  const { report } = await runFixture();
  const host = finding(report, 'sameas-moved-host');
  assert.equal(host.severity, 'error');
  assert.equal(host.target, 'https://old.example.org/jane');
  assert.match(host.message, /another host's home page: https:\/\/another\.example\.com\/, which usually means the page was removed/);
  const moved = finding(report, 'sameas-moved');
  assert.equal(moved.severity, 'warn');
  assert.match(moved.message, /redirects to the home page: https:\/\/beta\.example\.org\//);
});

test('a moved target that lands on a set member says to list that member', async () => {
  const routes = {
    'https://example.com/a': {
      body: '<script type="application/ld+json">{"@type":"Person","name":"J","sameAs":["https://old.example.org/b"]}</script>',
    },
    'https://example.org/b': { body: '<script type="application/ld+json">{"@type":"Person","name":"J","sameAs":["https://example.com/a"]}</script>' },
    'https://old.example.org/b': { status: 301, location: 'https://example.org/b' },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: ['https://example.com/a', 'https://example.org/b'], fetcher });
  assert.match(finding(report, 'sameas-moved-host').message, /that is \[2\] in the set, so list it directly/);
});

test('a trivial redirect (http to https) is only a note; the variant form is noted on the page', async () => {
  const { report } = await runFixture();
  const r = finding(report, 'sameas-redirect');
  assert.equal(r.severity, 'note');
  assert.match(r.message, /http vs https/);
  assert.match(finding(report, 'sameas-variant', 3).message, /http:\/\/alpha\.example\.com\/jane for \[1\]/);
});

test('fragments in sameAs and in url are warned about', async () => {
  const { report } = await runFixture();
  assert.match(finding(report, 'sameas-fragment', 2).message, /alpha\.example\.com\/jane#me points at a fragment/);
  const f = finding(report, 'url-fragment', 2);
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /should be the page \(https:\/\/beta\.example\.org\/jane\)/);
  assert.equal(finding(report, 'url-not-canonical', 2), undefined, 'apart from the fragment it matches the canonical');
});

test('url against canonical, and a canonical that is not the fetched address', async () => {
  const { report } = await runFixture();
  assert.match(finding(report, 'url-not-canonical', 3).message, /differs from the canonical .*\(trailing slash\)/);
  assert.match(finding(report, 'canonical-elsewhere', 3).message, /trailing slash/);
  assert.equal(finding(report, 'canonical-missing', 4).severity, 'note');
  assert.deepEqual(checksOf(report, { page: 1 }).filter((c) => c.startsWith('url-') || c.startsWith('canonical')), []);
});

test('a url for a different page entirely, and a missing url', async () => {
  const routes = {
    'https://example.com/a': {
      body: '<link rel="canonical" href="https://example.com/a"><script type="application/ld+json">{"@type":"Person","name":"J","url":"https://example.com/about"}</script>',
    },
    'https://example.org/b': { body: '<script type="application/ld+json">{"@type":"Person","name":"J"}</script>' },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: Object.keys(routes), fetcher, checkTargets: false });
  assert.match(finding(report, 'url-not-canonical', 1).message, /is not this page; the canonical is https:\/\/example\.com\/a/);
  assert.match(finding(report, 'url-missing', 2).message, /it should be https:\/\/example\.org\/b/);
});

test('login walls and refusals are unverifiable notes, never dead', async () => {
  const { report } = await runFixture();
  assert.equal(target(report, 'https://social.example.com/in/jane').result, 'unverifiable');
  assert.equal(target(report, 'https://photos.example.org/jane').result, 'unverifiable');
  const notes = report.findings.filter((f) => f.check === 'sameas-unverifiable');
  assert.equal(notes.length, 2);
  assert.ok(notes.every((f) => f.severity === 'note'));
});

test('a 200 from a walled host is unverifiable; --walled-host adds hosts', async () => {
  const routes = {
    'https://example.com/a': { body: '<script type="application/ld+json">{"@type":"Person","name":"J","sameAs":["https://m.social.example.org/jane"]}</script>' },
    'https://m.social.example.org/jane': { status: 200, body: 'Log in to see this profile' },
  };
  const run = async (walledHosts) => {
    const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
    return checkEntities({ pages: ['https://example.com/a'], fetcher, walledHosts });
  };
  assert.equal((await run(DEFAULT_WALLED_HOSTS)).targets[0].result, 'ok');
  assert.equal((await run([...DEFAULT_WALLED_HOSTS, 'social.example.org'])).targets[0].result, 'unverifiable');
});

test('the default walled hosts include LinkedIn and Instagram', () => {
  assert.ok(DEFAULT_WALLED_HOSTS.includes('linkedin.com'));
  assert.ok(DEFAULT_WALLED_HOSTS.includes('instagram.com'));
});

test('classifyTarget covers every outcome', () => {
  const one = (status, url = 'https://example.com/jane') => ({ chain: [{ url, status }], finalUrl: url, status });
  const hop = (start, end, status = 200) => ({ chain: [{ url: start, status: 301 }, { url: end, status }], finalUrl: end, status });
  const c = (start, res) => classifyTarget(start, res).result;
  const u = 'https://example.com/jane';
  assert.equal(c(u, one(200)), 'ok');
  assert.equal(c(u, one(404)), 'dead');
  assert.equal(c(u, one(410)), 'dead');
  assert.equal(c(u, { chain: [{ url: u, error: 'ENOTFOUND' }], finalUrl: u, error: 'ENOTFOUND' }), 'dead');
  assert.equal(c(u, { chain: [{ url: u, error: 'timeout' }], finalUrl: u, error: 'timeout' }), 'unreachable');
  assert.equal(c(u, { chain: [{ url: u, error: 'not in snapshot' }], finalUrl: u, error: 'not in snapshot' }), 'not-checked');
  for (const s of [401, 403, 429, 999]) assert.equal(c(u, one(s)), 'unverifiable', `HTTP ${s}`);
  assert.equal(c(u, one(503)), 'server-error');
  assert.equal(c(u, one(400)), 'http-error');
  assert.equal(c(u, one(300)), 'http-error', 'a 3xx with no Location');
  assert.equal(c(u, hop(u, 'https://example.org/jane')), 'moved-host');
  assert.equal(c(u, hop(u, 'https://example.com/janet')), 'moved');
  assert.equal(c(u, hop(u, 'https://www.example.com/jane/')), 'ok');
  assert.equal(c(u, hop(u, 'https://example.org/jane', 404)), 'dead', 'dead after a redirect is dead');
  assert.equal(c(u, hop(u, 'https://example.com/accounts/login/?next=jane')), 'unverifiable');
  assert.equal(c(u, hop(u, 'https://example.com/authwall?trk=x', 200)), 'unverifiable');
  assert.equal(classifyTarget('https://www.linkedin.com/in/jane', one(200, 'https://www.linkedin.com/in/jane')).result, 'unverifiable');
});

test('page problems: fetch failure, HTTP error, redirect, no JSON-LD, no Person', async () => {
  const routes = {
    'https://a.example.com/jane': { error: 'timeout' },
    'https://b.example.com/jane': { status: 404 },
    'https://c.example.com/jane': { status: 301, location: 'https://c.example.com/people/jane' },
    'https://c.example.com/people/jane': { body: '<script type="application/ld+json">{"@type":"Person","name":"J"}</script>' },
    'https://d.example.com/jane': { status: 301, location: 'https://www.d.example.com/jane' },
    'https://www.d.example.com/jane': { body: '<p>no structured data</p>' },
    'https://e.example.com/jane': { body: '<script type="application/ld+json">{"@type":"Organization","name":"Example Ltd"}</script>' },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const pages = ['https://a.example.com/jane', 'https://b.example.com/jane', 'https://c.example.com/jane', 'https://d.example.com/jane', 'https://e.example.com/jane'];
  const report = await checkEntities({ pages, fetcher, checkTargets: false });
  assert.match(finding(report, 'page-fetch', 1).message, /could not be fetched \(timeout\)/);
  assert.match(finding(report, 'page-fetch', 2).message, /returns HTTP 404/);
  assert.equal(finding(report, 'page-redirect', 3).severity, 'warn');
  assert.equal(finding(report, 'page-redirect', 4).severity, 'note', 'adding www is trivial');
  assert.equal(finding(report, 'person-missing', 4).message, 'no JSON-LD on the page');
  assert.match(finding(report, 'person-missing', 5).message, /no Person node in 1 JSON-LD block/);
  assert.equal(report.summary.exitCode, 1);
});

test('ProfilePage problems are warnings', async () => {
  const routes = {
    'https://example.com/a': {
      body:
        '<script type="application/ld+json">{"@type":"ProfilePage","mainEntity":{"@id":"#nobody"}}</script>' +
        '<script type="application/ld+json">[{"@type":"Person","name":"J","url":"https://example.com/x"},{"@type":"Person","name":"K","url":"https://example.com/y"}]</script>' +
        '<link rel="canonical" href="https://example.com/a"><link rel="canonical" href="https://example.com/b">',
    },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: ['https://example.com/a'], fetcher, checkTargets: false });
  assert.deepEqual(
    checksOf(report, { severity: 'warn' }).filter((c) => ['mainentity-unresolved', 'person-ambiguous', 'canonical-multiple'].includes(c)).sort(),
    ['canonical-multiple', 'mainentity-unresolved', 'person-ambiguous'],
  );
});

test('sameAs housekeeping: invalid, duplicate and self entries', async () => {
  const routes = {
    'https://example.com/a': {
      body:
        '<script type="application/ld+json">{"@type":"Person","name":"J","sameAs":["mailto:j@example.com","https://example.org/b","https://www.example.org/b/","https://example.com/a"]}</script>',
    },
    'https://example.org/b': { body: '<script type="application/ld+json">{"@type":"Person","name":"J","sameAs":["https://example.com/a"]}</script>' },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: Object.keys(routes), fetcher });
  const checks = checksOf(report, { page: 1 });
  assert.ok(checks.includes('sameas-invalid'));
  assert.ok(checks.includes('sameas-duplicate'));
  assert.ok(checks.includes('sameas-self'));
  assert.ok(!checks.includes('sameas-missing'));
});

test('--fail-on sets the exit code', async () => {
  for (const [failOn, expected] of [
    ['error', 1],
    ['warn', 1],
    ['never', 0],
  ]) {
    const { report } = await runFixture({ failOn });
    assert.equal(report.summary.exitCode, expected, failOn);
  }
  const clean = {
    'https://example.com/a': { body: '<link rel="canonical" href="https://example.com/a"><script type="application/ld+json">{"@type":"Person","name":"J","url":"https://example.com/a","sameAs":["https://example.org/b"]}</script>' },
    'https://example.org/b': { body: '<link rel="canonical" href="https://example.org/b"><script type="application/ld+json">{"@type":"Person","name":"J","url":"https://example.org/b","sameAs":["https://example.com/a"]}</script>' },
  };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(clean).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: Object.keys(clean), fetcher, failOn: 'warn' });
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.exitCode, 0);
});

test('--pages-only requests no targets beyond the pages', async () => {
  const { report, stub } = await runFixture({ checkTargets: false });
  assert.deepEqual(stub.calls.map((c) => c.url), PAGES);
  assert.equal(target(report, 'https://code.example.org/jane-old').result, 'not-checked');
  assert.equal(target(report, 'https://beta.example.org/jane').result, 'ok', 'a listed page is known from its own fetch');
  assert.match(finding(report, 'sameas-not-checked').message, /not requested/);
});

test('the set: duplicates collapse, bad input is an InputError', () => {
  const { members, duplicates } = buildSet(['https://example.com/a', 'http://www.example.com/a/'], ['https://example.org/p']);
  assert.equal(members.length, 2);
  assert.equal(duplicates.length, 1);
  assert.throws(() => buildSet(['ftp://example.com/a']), InputError);
  assert.throws(() => buildSet(['not a url']), InputError);
});

test('sameAs links to local or private addresses are never requested, even through a redirect', async () => {
  const metadata = `http://${[169, 254, 169, 254].join('.')}/latest`;
  const routes = {
    'https://example.com/a': {
      body: `<script type="application/ld+json">{"@type":"Person","name":"J","sameAs":["http://localhost:8080/admin","https://example.org/hop"]}</script>`,
    },
    'https://example.org/hop': { status: 302, location: metadata },
  };
  const stub = stubFetch(routes);
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stub.fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: ['https://example.com/a'], fetcher });
  assert.deepEqual(stub.calls.map((c) => c.url), ['https://example.com/a', 'https://example.org/hop']);
  assert.ok(report.targets.every((t) => t.result === 'not-checked'));
  assert.match(finding(report, 'sameas-not-checked').message, /local or private address/);
});

test('pages you list may be local, for checking a build before it ships', async () => {
  const routes = { 'http://localhost:4321/jane': { body: '<script type="application/ld+json">{"@type":"Person","name":"J"}</script>' } };
  const fetcher = createFetcher({ transport: networkTransport({ fetchImpl: stubFetch(routes).fetch }), delayMs: 0 });
  const report = await checkEntities({ pages: ['http://localhost:4321/jane'], fetcher });
  assert.equal(report.pages[0].person.name, 'J');
});
