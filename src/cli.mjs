// Command-line entry point. `main` takes its streams and fetch as arguments so
// the tests can drive it without a terminal or a network.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkEntities, DEFAULT_WALLED_HOSTS, InputError } from './check.mjs';
import {
  addHtmlFiles,
  createFetcher,
  DEFAULT_USER_AGENT,
  DEFAULTS,
  loadSnapshot,
  networkTransport,
  snapshotTransport,
} from './fetcher.mjs';
import { renderText } from './report.mjs';
import { VERSION } from './version.mjs';

export class UsageError extends Error {}

export const HELP = `person-entity-check ${VERSION}

Check that one person's profile pages agree: the JSON-LD Person on each page,
its name and alternateName, which of the other pages its sameAs lists, whether
each sameAs link still works, and whether its url is the page's canonical.

Usage
  person-entity-check [options] <page-url>...
  person-entity-check --file urls.txt
  person-entity-check --no-network --snapshot saved/ --file urls.txt

The set
  <page-url>...          pages you control that carry JSON-LD (checked fully)
  -p, --profile <url>    a third-party profile (GitHub, LinkedIn, Instagram...)
                         that every page's sameAs should list; repeatable
  -f, --file <path>      read the set from a file: one URL per line, a bare URL
                         or "page <url>" is a page, "profile <url>" is a
                         profile, "#" starts a comment; repeatable

Output
      --json             print the report as JSON instead of tables
      --fail-on <level>  exit 1 when there is a finding at this level or above:
                         error (default), warn, or never
  -q, --quiet            no progress lines on stderr

Requests (one GET per URL per run, sequential, redirects followed by hand)
      --timeout <ms>     per request (default ${DEFAULTS.timeoutMs})
      --delay <ms>       pause between requests (default ${DEFAULTS.delayMs})
      --max-redirects <n>  hops to follow before giving up (default ${DEFAULTS.maxRedirects})
      --pages-only       fetch the pages but not the sameAs targets
      --walled-host <host>  also treat this host as login-walled (results are
                         "unverifiable", not "ok"); repeatable. Built in:
                         ${DEFAULT_WALLED_HOSTS.join(', ')}
      --user-agent <ua>  replace the default User-Agent:
                         ${DEFAULT_USER_AGENT}
      --save <dir>       write every response to <dir> for later offline runs

Offline (for CI)
      --no-network       make no requests; read responses from:
      --snapshot <dir>   a directory written by --save (or by hand; see README)
      --html <url>=<file>  serve <file> as the HTML for <url>; repeatable
                         (--snapshot and --html imply --no-network)

  -h, --help             show this help
  -V, --version          show the version

Exit codes: 0 no failing findings, 1 failing findings, 2 usage or input error.
`;

/** Parse a set file: bare URL or "page <url>" is a page, "profile <url>" is a profile. */
export function parseSetFile(text, name = 'file') {
  const pages = [];
  const profiles = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.replace(/(^|\s)#.*$/, '').trim();
    if (!s) return;
    const m = /^(page|profile)\s+(\S+)$/i.exec(s);
    if (m) (m[1].toLowerCase() === 'page' ? pages : profiles).push(m[2]);
    else if (/^\S+$/.test(s)) pages.push(s);
    else throw new UsageError(`${name} line ${i + 1}: expected a URL, "page <url>" or "profile <url>"`);
  });
  return { pages, profiles };
}

function nonNegativeInt(value, flag) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} needs a whole number, got "${value}"`);
  return Number(value);
}

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        file: { type: 'string', short: 'f', multiple: true },
        profile: { type: 'string', short: 'p', multiple: true },
        json: { type: 'boolean' },
        'fail-on': { type: 'string' },
        quiet: { type: 'boolean', short: 'q' },
        timeout: { type: 'string' },
        delay: { type: 'string' },
        'max-redirects': { type: 'string' },
        'pages-only': { type: 'boolean' },
        'walled-host': { type: 'string', multiple: true },
        'user-agent': { type: 'string' },
        save: { type: 'string' },
        'no-network': { type: 'boolean' },
        snapshot: { type: 'string' },
        html: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const v = parsed.values;
  const failOn = v['fail-on'] ?? 'error';
  if (!['error', 'warn', 'never'].includes(failOn)) throw new UsageError(`--fail-on must be error, warn or never, got "${failOn}"`);
  const html = (v.html ?? []).map((pair) => {
    const at = pair.lastIndexOf('=');
    if (at <= 0 || at === pair.length - 1) throw new UsageError(`--html needs <url>=<file>, got "${pair}"`);
    return { url: pair.slice(0, at), file: pair.slice(at + 1) };
  });
  const offline = Boolean(v['no-network'] || v.snapshot || html.length);
  if (offline && !v.snapshot && !html.length) throw new UsageError('--no-network needs --snapshot <dir> or --html <url>=<file>');
  if (offline && v.save) throw new UsageError('--save records live responses, so it cannot be used with --no-network');
  const userAgent = v['user-agent'] ?? DEFAULT_USER_AGENT;
  if (!userAgent.trim()) throw new UsageError('--user-agent cannot be empty');
  return {
    help: Boolean(v.help),
    version: Boolean(v.version),
    pages: parsed.positionals,
    profiles: v.profile ?? [],
    files: v.file ?? [],
    json: Boolean(v.json),
    failOn,
    quiet: Boolean(v.quiet),
    timeoutMs: nonNegativeInt(v.timeout, '--timeout') ?? DEFAULTS.timeoutMs,
    delayMs: nonNegativeInt(v.delay, '--delay') ?? DEFAULTS.delayMs,
    maxRedirects: nonNegativeInt(v['max-redirects'], '--max-redirects') ?? DEFAULTS.maxRedirects,
    pagesOnly: Boolean(v['pages-only']),
    walledHosts: [...DEFAULT_WALLED_HOSTS, ...(v['walled-host'] ?? [])],
    userAgent,
    save: v.save ?? null,
    offline,
    snapshot: v.snapshot ?? null,
    html,
  };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch, sleep } = {}) {
  let opts;
  try {
    opts = parseCli(argv);
    if (opts.help) {
      stdout.write(HELP);
      return 0;
    }
    if (opts.version) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    const pages = [...opts.pages];
    const profiles = [...opts.profiles];
    for (const f of opts.files) {
      let text;
      try {
        text = await readFile(f, 'utf8');
      } catch (err) {
        throw new UsageError(`Cannot read ${f}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
      }
      const set = parseSetFile(text, f);
      pages.push(...set.pages);
      profiles.push(...set.profiles);
    }
    if (!pages.length) throw new UsageError('Give at least one page URL (or --file). See --help.');

    let transport;
    if (opts.offline) {
      let snapshot = null;
      if (opts.snapshot) {
        try {
          snapshot = await loadSnapshot(opts.snapshot);
        } catch (err) {
          throw new UsageError(err.message);
        }
      }
      transport = snapshotTransport(addHtmlFiles(snapshot, opts.html));
    } else {
      transport = networkTransport({ fetchImpl, userAgent: opts.userAgent, timeoutMs: opts.timeoutMs });
    }
    const progress = !opts.quiet && stderr.isTTY;
    const fetcher = createFetcher({ transport, delayMs: opts.delayMs, maxRedirects: opts.maxRedirects, ...(sleep ? { sleep } : {}) });

    let report;
    try {
      report = await checkEntities({
        pages,
        profiles,
        fetcher,
        walledHosts: opts.walledHosts,
        checkTargets: !opts.pagesOnly,
        failOn: opts.failOn,
        onProgress: progress ? (e) => stderr.write(`\r\x1b[K${e.phase} ${e.n}/${e.total} ${e.url}`) : null,
      });
    } catch (err) {
      if (err instanceof InputError) throw new UsageError(err.message);
      throw err;
    } finally {
      if (progress) stderr.write('\r\x1b[K');
    }
    if (opts.save) {
      const saved = await fetcher.save(opts.save);
      if (!opts.quiet) stderr.write(`Saved ${saved} responses to ${opts.save}\n`);
    }
    stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
    return report.summary.exitCode;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`person-entity-check: ${err.message}\n`);
      return 2;
    }
    stderr.write(`person-entity-check: unexpected error: ${err && err.stack ? err.stack : err}\n`);
    return 2;
  }
}
