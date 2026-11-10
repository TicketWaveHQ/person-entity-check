import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { main, parseCli, parseSetFile } from '../src/cli.mjs';
import { VERSION } from '../src/version.mjs';
import { FIXTURES, ROOT, SET_FILE, SNAPSHOT, fixtureRoutes, sink, stubFetch } from './helpers.mjs';

const run = promisify(execFile);
const BIN = join(ROOT, 'bin', 'person-entity-check.mjs');

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test('version matches package.json', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal((await cli(['--version'])).stdout.trim(), pkg.version);
});

test('--help exits 0 and documents every option', async () => {
  const { code, stdout } = await cli(['--help']);
  assert.equal(code, 0);
  for (const flag of ['--file', '--profile', '--json', '--fail-on', '--timeout', '--delay', '--no-network', '--snapshot', '--html', '--save', '--pages-only', '--walled-host', '--user-agent']) {
    assert.ok(stdout.includes(flag), flag);
  }
});

test('offline run from the snapshot: tables on stdout, exit 1 on errors', async () => {
  const { code, stdout } = await cli(['--no-network', '--snapshot', SNAPSHOT, '--file', SET_FILE]);
  assert.equal(code, 1);
  for (const heading of ['Set', 'Pages', 'Names', 'sameAs coverage', 'sameAs targets', 'Findings']) {
    assert.match(stdout, new RegExp(`^${heading}`, 'm'), heading);
  }
  assert.match(stdout, /^ {2}\[1\] {2}page {5}https:\/\/alpha\.example\.com\/jane$/m);
  assert.match(stdout, /^ {2}\[7\] {2}profile {2}https:\/\/photos\.example\.org\/jane$/m);
  assert.match(stdout, /ERROR +- +sameas-dead +https:\/\/code\.example\.org\/jane-old returns HTTP 404/);
  assert.match(stdout, /Result: 5 errors, 13 warnings, 7 notes\. Exit 1 \(--fail-on error\)\./);
  assert.doesNotMatch(stdout, /\u2014/, 'no em-dashes in output');
});

test('--json prints a parseable report with the documented keys', async () => {
  const { code, stdout } = await cli(['--no-network', '--snapshot', SNAPSHOT, '--file', SET_FILE, '--json']);
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'generatedAt', 'mode', 'requests', 'set', 'pages', 'names', 'targets', 'findings', 'summary']);
  assert.equal(report.set.length, 7);
  assert.deepEqual(report.summary, { errors: 5, warnings: 13, notes: 7, failOn: 'error', exitCode: 1 });
  for (const f of report.findings) assert.ok(['error', 'warn', 'note'].includes(f.severity));
});

test('--fail-on never exits 0 with the same findings', async () => {
  const { code } = await cli(['--no-network', '--snapshot', SNAPSHOT, '--file', SET_FILE, '--fail-on', 'never']);
  assert.equal(code, 0);
});

test('--html serves a local file for a page', async () => {
  const { code, stdout } = await cli([
    '--html',
    `https://alpha.example.com/jane=${join(FIXTURES, 'pages', 'alpha.html')}`,
    'https://alpha.example.com/jane',
    '--json',
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'no-network');
  assert.equal(report.pages[0].person.name, 'Jane Example');
  assert.equal(report.targets.filter((t) => t.result === 'not-checked').length, report.targets.length);
  assert.equal(code, 0, 'only notes and warnings');
});

test('usage errors exit 2 with a message on stderr', async () => {
  const cases = [
    [[], /at least one page/],
    [['--bogus'], /Unknown option/],
    [['--fail-on', 'sometimes', 'https://example.com/'], /--fail-on must be/],
    [['--timeout', 'soon', 'https://example.com/'], /--timeout needs a whole number/],
    [['--no-network', 'https://example.com/'], /--no-network needs --snapshot/],
    [['--snapshot', SNAPSHOT, '--save', 'out', 'https://example.com/'], /cannot be used with --no-network/],
    [['--snapshot', join(FIXTURES, 'nowhere'), 'https://example.com/'], /Cannot read snapshot/],
    [['--file', join(FIXTURES, 'nowhere.txt')], /file not found/],
    [['--no-network', '--snapshot', SNAPSHOT, 'ftp://example.com/'], /Not a web address/],
    [['--html', 'https://example.com/', 'https://example.com/'], /--html needs <url>=<file>/],
  ];
  for (const [args, pattern] of cases) {
    const { code, stderr } = await cli(args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, pattern, args.join(' '));
  }
});

test('main() with a stubbed fetch: live mode, progress only on a terminal, --save', async () => {
  const stub = stubFetch(fixtureRoutes());
  const out = sink();
  const err = sink({ isTTY: true });
  const code = await main(['--file', SET_FILE, '--delay', '0', '--json'], { stdout: out, stderr: err, fetchImpl: stub.fetch });
  assert.equal(code, 1);
  const report = JSON.parse(out.text);
  assert.equal(report.mode, 'network');
  assert.equal(report.requests, stub.calls.length);
  assert.match(err.text, /page 1\/4 https:\/\/alpha\.example\.com\/jane/);
  const quiet = sink({ isTTY: true });
  await main(['--file', SET_FILE, '--delay', '0', '--quiet'], { stdout: sink(), stderr: quiet, fetchImpl: stubFetch(fixtureRoutes()).fetch });
  assert.equal(quiet.text, '');
});

test('parseSetFile: bare URLs are pages, comments and blank lines are skipped, fragments survive', () => {
  const set = parseSetFile('# heading\nhttps://example.com/a\n\nPAGE https://example.com/b  # note\nprofile https://example.org/p#x\n');
  assert.deepEqual(set, { pages: ['https://example.com/a', 'https://example.com/b'], profiles: ['https://example.org/p#x'] });
  assert.throws(() => parseSetFile('two words here'), /line 1/);
});

test('parseCli: defaults and --walled-host adds to the built-in list', () => {
  const o = parseCli(['https://example.com/', '--walled-host', 'social.example.org']);
  assert.equal(o.timeoutMs, 10000);
  assert.equal(o.delayMs, 1000);
  assert.equal(o.failOn, 'error');
  assert.ok(o.walledHosts.includes('linkedin.com'));
  assert.ok(o.walledHosts.includes('social.example.org'));
  assert.equal(o.offline, false);
  assert.equal(parseCli(['--snapshot', 'x', 'https://example.com/']).offline, true);
});
