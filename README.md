# person-entity-check

[![CI](https://github.com/TicketWaveHQ/person-entity-check/actions/workflows/ci.yml/badge.svg)](https://github.com/TicketWaveHQ/person-entity-check/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/Licence-MIT-blue.svg)](LICENSE)

A small command-line tool that checks whether one person's profile pages agree
with each other. Give it the pages that describe you (your page on each of your
sites) and your third-party profiles (GitHub, LinkedIn, Instagram). It reads the
JSON-LD `Person` on each page and reports:

- where the `name` and `alternateName` values differ between pages;
- which of the other pages and profiles each page leaves out of its `sameAs`;
- `sameAs` entries that are not in the set you gave;
- every `sameAs` target's HTTP status with redirects followed, flagging 404 and
  410, redirects to another host, and links that point at a fragment;
- whether each Person `url` is the page's canonical.

It is a Node.js command with no dependencies. It requests each URL once,
politely, and has a `--no-network` mode that replays saved responses, so it can
run in CI without touching anyone's site.

**Who it is for:** anyone with a profile page on several sites (founders,
consultants, authors, speakers), and the people who look after the structured
data on those sites. It was written after these failures on a real set of
profile pages: a GitHub username change and an Instagram handle change that
left dead links on several sites; a listed page that returned 404; different
`name` forms on different sites; and a Person `url` that pointed at a fragment
instead of the page.

## Contents

- [60-second start](#60-second-start)
- [The set: pages and profiles](#the-set-pages-and-profiles)
- [What it checks](#what-it-checks)
- [Login walls: unverifiable is not dead](#login-walls-unverifiable-is-not-dead)
- [Output reference](#output-reference)
- [Running it in CI](#running-it-in-ci)
- [How it fetches](#how-it-fetches)
- [Limits](#limits)
- [Worked example: a real audit, 10 November 2026](#worked-example-a-real-audit-10-november-2026)
- [Why Node.js and not Python](#why-nodejs-and-not-python)
- [Using it from code](#using-it-from-code)
- [Development](#development)
- [Licence](#licence)

## 60-second start

You need Node.js 20 or later. There is nothing to install.

```sh
git clone https://github.com/TicketWaveHQ/person-entity-check.git
cd person-entity-check

# Try it on the bundled fixtures first: no network, example.com and .org data only.
node bin/person-entity-check.mjs --no-network \
  --snapshot test/fixtures/snapshot --file test/fixtures/set.txt

# Then on your own pages and profiles.
node bin/person-entity-check.mjs \
  https://example.com/jane https://example.org/about/jane \
  --profile https://github.com/jane \
  --profile https://www.linkedin.com/in/jane/
```

The first command prints a report with most kinds of finding in it (the full
output is in [`examples/fixture-report.txt`](examples/fixture-report.txt)). The
second makes a handful of requests, one second apart, and prints the same report
for your pages. Add `--json` for machine-readable output.

Once the repository is public you can also install the command globally with
`npm install -g github:TicketWaveHQ/person-entity-check`.

## The set: pages and profiles

The tool checks a **set**: everything that should point at everything else.

- A **page** is a page you control that carries JSON-LD. It is fetched, its
  Person is read, and all the checks run on it. URLs given as arguments are
  pages.
- A **profile** is a third-party profile (GitHub, LinkedIn, Instagram and so
  on). It is not read for JSON-LD, but every page's `sameAs` should list it and
  its status is checked. Give profiles with `--profile <url>`.

For more than a few URLs, keep the set in a file and pass `--file`:

```text
# Jane Example's pages and profiles
https://example.com/jane
page https://example.org/about/jane
profile https://github.com/jane
profile https://www.linkedin.com/in/jane/
```

A bare URL or `page <url>` is a page, `profile <url>` is a profile, and `#`
starts a comment (at the start of a line or after a space, so a `#` inside a URL
is kept). Entries that are the same page apart from scheme, `www.`, a trailing
slash or letter case are merged and checked once.

## What it checks

Every finding has a level. **error** means something is broken, **warn** means
something needs a human decision, **note** is information. By default the exit
code is 1 when there is at least one error; see `--fail-on` below.

### Each page

| Check | Level | Meaning |
| --- | --- | --- |
| `page-fetch` | error | The page could not be fetched, returned a non-2xx status, or returned no HTML. |
| `page-redirect` | warn or note | The page redirects. A note when only the scheme, `www.`, trailing slash or case changes; a warning otherwise (give the final address instead). |
| `page-truncated` | note | The page is over 5 MB; only the start was read. |
| `jsonld-invalid` | error | A `<script type="application/ld+json">` block is not valid JSON. The other blocks are still read. |
| `person-missing` | error | No JSON-LD, or no `Person` node in it. |
| `mainentity-unresolved` | warn | `ProfilePage.mainEntity` refers to an `@id` that is not defined on the page. |
| `mainentity-not-person` | warn | `ProfilePage.mainEntity` is something other than a Person. |
| `person-ambiguous` | warn | Several Person nodes and no `ProfilePage.mainEntity` naming one. |
| `canonical-missing` | note | No `<link rel="canonical">`; the Person `url` is compared with the fetched address instead. |
| `canonical-multiple` | warn | More than one canonical link; the first is used. |
| `canonical-elsewhere` | warn | The canonical is not the address that was fetched. |
| `url-missing` | warn | The Person has no `url`. |
| `url-invalid` | warn | The Person `url` is not a web address. |
| `url-multiple` | note | The Person has several `url` values; the first is checked. |
| `url-fragment` | warn | The Person `url` points at a fragment (`.../jane#person`). `url` should be the page; the fragment form belongs in `@id`. |
| `url-not-canonical` | warn | The Person `url` differs from the canonical, either slightly (the difference is named, such as "trailing slash") or entirely. |

**How the Person is found.** JSON-LD is read from every
`application/ld+json` script on the page, including `@graph`, top-level arrays
and nested nodes. Nodes that share an `@id` are merged, across blocks too, and
relative `@id` values are resolved against the page. The Person the page is
about is, in order: the Person that a `ProfilePage` names as `mainEntity`
(inline or by `@id`); the Person whose `url` or `@id` is this page; the only
Person on the page; otherwise the first Person with `sameAs`, with a
`person-ambiguous` warning. `@type` may be `Person`, `schema:Person` or
`https://schema.org/Person`, alone or in an array.

### Names across pages

| Check | Level | Meaning |
| --- | --- | --- |
| `name-missing` | error | The Person has no `name`. |
| `name-multiple` | note | `name` has several values; the first is compared. |
| `name-mismatch` | warn | The page's `name` differs from the form most pages use. Whitespace is normalised first; a difference only in letter case is called out. |
| `alternate-name-gap` | note | A name form used on another page appears in neither this page's `name` nor its `alternateName`. |

### Each page's sameAs

| Check | Level | Meaning |
| --- | --- | --- |
| `sameas-missing` | warn | Lists the members of the set that this page's `sameAs` leaves out. |
| `sameas-unlisted` | warn | A `sameAs` entry is not in the set. Add it to the set if it is this person, or remove it. It is still status-checked. |
| `sameas-fragment` | warn | A `sameAs` entry points at a fragment; list the page itself. |
| `sameas-invalid` | warn | A `sameAs` entry is not a web address. |
| `sameas-variant` | note | An entry matches a set member but in a different form (http instead of https, `www.`, trailing slash, case). |
| `sameas-duplicate` | note | The same page is listed twice. |
| `sameas-self` | note | The page lists itself. |

A `sameAs` entry counts as listing a set member when it matches the member's
address, the address it finally loaded from, or its canonical, ignoring scheme,
`www.`, trailing slash, letter case and fragment.

### Each sameAs target

Every distinct `sameAs` URL across all pages, and every profile, is requested
once with redirects followed. The result is one of:

| Result | Finding | Level | Rule |
| --- | --- | --- | --- |
| ok | none | | 2xx at the same page. |
| ok (redirected) | `sameas-redirect` | note | 2xx after a redirect that only changed scheme, `www.`, trailing slash or case. |
| dead | `sameas-dead` | error | 404 or 410 (after any redirects), or the host name does not resolve. When a set member on the same host is missing from the same page, the message says the profile may have been renamed. |
| moved host | `sameas-moved-host` | error | Redirects to a different host. If the new address is in the set, the message says to list it directly; a redirect to another host's home page is called out as a likely removed page or a domain that changed hands. |
| moved | `sameas-moved` | warn | Redirects to a different page on the same host (a redirect to the home page is called out). |
| unverifiable | `sameas-unverifiable` | note | 401, 403, 429 or 999; a redirect to a login page; or a 200 from a login-walled host. See below. |
| server error | `sameas-server-error` | warn | 5xx. Often temporary; run again later. |
| http error | `sameas-http-error` | warn | Any other non-2xx status, or a 3xx without a `Location` header. |
| unreachable | `sameas-unreachable` | warn | Timeout, refused connection, TLS failure or similar. |
| not checked | `sameas-not-checked` | note | `--pages-only`, missing from the snapshot in `--no-network` mode, or a local or private address (never requested). |

## Login walls: unverifiable is not dead

Some social sites block or login-wall automated requests. LinkedIn answers with
the non-standard status **999**; Instagram serves logged-out visitors a login
page, often with a 200 status. A tool that called those "dead" would be wrong,
and one that called that 200 "ok" would be claiming more than it knows. So they
are reported as **unverifiable**, as notes, and do not fail the run. Check them
by hand in a browser.

By default these hosts and their subdomains are treated as login-walled, which
means a 200 from them is unverifiable rather than ok: `linkedin.com`,
`instagram.com`, `facebook.com`, `threads.net`, `threads.com`, `x.com`,
`twitter.com`, `tiktok.com`. Add more with `--walled-host <host>`. A 404 or 410
from one of these hosts is still reported as dead, because that is an explicit
answer. Statuses 401, 403, 429 and 999 from any host, and any redirect to a
login path (`/login`, `/signin`, `/accounts/login`, `/authwall` and similar),
are unverifiable too.

## Output reference

### Text (the default)

Plain text, no colour, so it pastes cleanly into an issue or a CI log. The
sections, in order:

1. **Header**: tool and version, `network` or `no-network`, the number of
   requests made (or snapshot lookups), and the time.
2. **Set**: every member with its number. Numbers in square brackets, like
   `[3]`, refer to these throughout.
3. **Pages**: HTTP status chain, how the Person was found, its `name`, the `url`
   check (`ok`, `fragment`, `not canonical`, `missing`, `invalid`) and how many
   `sameAs` entries it has.
4. **Names**: every name form and the pages that use it as `name` or as
   `alternateName`.
5. **sameAs coverage**: a matrix. Rows are pages, columns are set members;
   `yes` means the row's `sameAs` lists that member, `NO` means it does not,
   `-` is the page itself.
6. **sameAs targets**: result, status chain (`301 > 404`), target, its set
   number if it has one, and the pages that list it. A redirected target has a
   second line with `-> final address`.
7. **Findings**: level, page, check id and message, errors first.
8. **Result** line with the counts and the exit code.

### JSON (`--json`)

```text
schemaVersion  1
tool           { name, version }
generatedAt    ISO 8601 time
mode           "network" or "no-network"
requests       requests made (in no-network mode, snapshot lookups)
set[]          { index, kind: "page" | "profile", url }
pages[]        { index, url, status, finalUrl, chain[], error, canonical,
                 jsonldBlocks, personCount,
                 person: { via, id, name, names[], alternateNames[], url,
                           sameAs[], hasSameAs } | null,
                 coverage[]: { index, state: "self" | "listed" | "missing" } }
names[]        { name, asName[], asAlternateName[], onPages[] }
targets[]      { url, member, listedBy[], listedAs[], result, status,
                 finalUrl, chain[], note }
findings[]     { severity: "error" | "warn" | "note", check, message,
                 page?, target?, pages?, missing? }
summary        { errors, warnings, notes, failOn, exitCode }
```

`chain[]` entries are `{ url, status, error? }`, one per hop. `result` is one of
`ok`, `dead`, `moved-host`, `moved`, `unverifiable`, `server-error`,
`http-error`, `unreachable` and `not-checked`. A full example is in
[`examples/2026-11-10-report.json`](examples/2026-11-10-report.json).
`schemaVersion` will change if a field is removed or changes meaning.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No findings at or above the `--fail-on` level. |
| 1 | At least one finding at or above the `--fail-on` level. |
| 2 | Usage or input error (bad option, unreadable file, an address that is not http or https). |

`--fail-on error` is the default. `--fail-on warn` also fails on warnings, for a
strict CI gate; `--fail-on never` always exits 0 and leaves the judgement to
whoever reads the report.

### All options

```text
<page-url>...            pages you control that carry JSON-LD
-p, --profile <url>      a third-party profile every page should list; repeatable
-f, --file <path>        read the set from a file; repeatable
    --json               JSON instead of tables
    --fail-on <level>    error (default), warn or never
-q, --quiet              no progress lines on stderr
    --timeout <ms>       per request (default 10000)
    --delay <ms>         pause between requests (default 1000)
    --max-redirects <n>  hops to follow (default 10)
    --pages-only         fetch the pages but not the sameAs targets
    --walled-host <host> treat this host as login-walled too; repeatable
    --user-agent <ua>    replace the default User-Agent
    --save <dir>         save every response for later offline runs
    --no-network         make no requests; read responses from:
    --snapshot <dir>     a directory written by --save, or by hand
    --html <url>=<file>  serve a local file as the HTML for <url>; repeatable
-h, --help, -V, --version
```

Progress lines go to stderr only when stderr is a terminal, so they never mix
with `--json` output or CI logs.

## Running it in CI

Tests in CI should not depend on other people's servers, so there are two ways
to run with no network at all.

**Replay a saved run.** Run once by hand with `--save`, commit the directory,
and replay it in CI:

```sh
node bin/person-entity-check.mjs --file people.txt --save snapshot/   # by hand, once
node bin/person-entity-check.mjs --file people.txt --no-network --snapshot snapshot/   # in CI
```

`--save` writes `index.json` (every response: status, `Location`, content type)
and the HTML of the pages you listed. Bodies of third-party targets are not
saved. You can also write `index.json` by hand; this is the format, and
[`test/fixtures/snapshot/index.json`](test/fixtures/snapshot/index.json) is a
complete example:

```json
{
  "responses": {
    "https://example.com/jane": { "status": 200, "file": "jane.html" },
    "https://example.com/old": { "status": 301, "location": "https://example.org/" },
    "https://example.org/": { "status": 200 },
    "https://example.com/slow": { "error": "timeout" }
  }
}
```

`status` defaults to 200, and `file` is relative to the snapshot directory.

**Check a build before it ships.** In the CI of one site, point `--html` at the
build output, so its JSON-LD is checked before it is deployed:

```sh
node bin/person-entity-check.mjs \
  --html https://example.com/jane=dist/jane/index.html \
  https://example.com/jane \
  --profile https://example.org/about/jane \
  --profile https://github.com/jane
```

The other sites' pages are given as profiles here: the page's `sameAs` must
still list them, but they are not fetched. Every page in the set needs either an
`--html` file or a snapshot entry, or it is reported as not fetched.

`--snapshot` and `--html` imply `--no-network`. Targets that are not in the
snapshot are reported as not checked, never as dead. Pages you list may also be
local (`http://localhost:4321/jane`, for a preview server); local and private
addresses are only ever refused for `sameAs` targets.

A minimal GitHub Actions job:

```yaml
jobs:
  people:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: git clone --depth 1 https://github.com/TicketWaveHQ/person-entity-check.git /tmp/pec
      - run: node /tmp/pec/bin/person-entity-check.mjs --no-network --snapshot snapshot/ --file people.txt
```

## How it fetches

- **One request per URL per run.** Every hop of every redirect chain is cached
  by URL, so a URL is requested at most once even when several links redirect
  through it, and a `sameAs` link to the exact address of one of your pages
  reuses the page's own fetch.
- **Sequential and spaced.** One request at a time, with `--delay` (default
  1 second) between them.
- **Timeout.** `--timeout` (default 10 seconds) per request, body included.
- **GET only**, with redirects followed by hand so each hop's status is
  recorded (up to `--max-redirects`, with loop detection).
- **A descriptive User-Agent**:
  `person-entity-check/0.1.0 (+https://github.com/TicketWaveHQ/person-entity-check)`,
  plus `Accept-Language: en-GB`. Replace it with `--user-agent` if you need to,
  but keep it honest.
- **Bodies are read only for your pages**, up to 5 MB. Target bodies are
  discarded unread.
- **No cookies, no JavaScript.** Pages are read as served.
- **Local and private addresses are never requested for `sameAs` targets**:
  `localhost`, `.local`, `.internal`, `.home.arpa`, single-label hosts, and
  loopback, private and link-local IP literals, including when a public URL
  redirects to one.
- **Error messages are reduced to short codes** (`timeout`, `ENOTFOUND`,
  `ECONNREFUSED`), so reports carry no resolved addresses.

It does not fetch `robots.txt`: it only requests addresses you gave it and the
`sameAs` links your own pages publish, which is closer to a person clicking each
link once than to a crawler.

## Limits

- **JSON-LD only.** Microdata and RDFa are not read, and nor is JSON-LD that a
  script adds after the page loads: the tool reads the HTML as served.
- **No full HTML parser.** Script and link tags are found with a scanner that
  skips HTML comments. That is enough for well-formed pages; badly broken markup
  could hide a block.
- **One Person per page**: the one the page is about, chosen as described above.
- **"Another host" means another host name**, ignoring `www.`. A redirect from
  `blog.example.com` to `example.com` counts as another host; there is no public
  suffix list.
- **Names are compared exactly** after whitespace normalisation. There is no
  fuzzy matching, so `Jane Example` and `Jane R. Example` are different forms,
  which is usually what you want to know.
- **A 200 says the address works, not that it is you.** Target pages are not
  read, so a profile handle now owned by someone else returns 200 like any
  other.
- **One moment in time.** Timeouts and 5xx are warnings because they are often
  temporary; run again before acting on them.
- **Login walls.** Results from the hosts above are unverifiable by design.
- **Private address detection works on the address as written.** A public name
  that resolves to a private address is not detected.

## Worked example: a real audit, 10 November 2026

This is a real run against Jordan Gilbert's profile pages on six sites, made
once on 10 November 2026 while preparing this release. The live run was given
the six pages and saved what it fetched:

```sh
node bin/person-entity-check.mjs --save .smoke/snapshot \
  https://ticketwavehq.com/jordan https://veryseoly.com/jordan \
  https://dacros.com/jordan https://www.jortech.co.uk/jordan \
  https://custodiance.com/jordan https://citorah.com/author
```

Its header was
`person-entity-check 0.1.0 | network | 9 requests | 2026-11-10T21:28:23.422Z`:
six pages and the three profiles they link to, one request each. Because the
profiles were not declared, it also warned 18 times (three per page) that the
GitHub, LinkedIn and Instagram links were not in the set.

The output below is the same saved responses replayed with the profiles added
to the set ([`examples/2026-11-10-set.txt`](examples/2026-11-10-set.txt)), which
made no further requests:

```sh
node bin/person-entity-check.mjs --no-network --snapshot .smoke/snapshot \
  --file examples/2026-11-10-set.txt
```

```text
person-entity-check 0.1.0 | no-network | 9 snapshot lookups | 2026-11-10T21:32:24.197Z

Set
  [1]  page     https://ticketwavehq.com/jordan
  [2]  page     https://veryseoly.com/jordan
  [3]  page     https://dacros.com/jordan
  [4]  page     https://www.jortech.co.uk/jordan
  [5]  page     https://custodiance.com/jordan
  [6]  page     https://citorah.com/author
  [7]  profile  https://github.com/eu-jordangilbert
  [8]  profile  https://www.linkedin.com/in/eu-jordangilbert/
  [9]  profile  https://www.instagram.com/jorzior/

Pages
  #    HTTP  Person found by         name                  url  sameAs
  [1]  200   ProfilePage.mainEntity  Jordan Lewis Gilbert  ok   8
  [2]  200   ProfilePage.mainEntity  Jordan Lewis Gilbert  ok   8
  [3]  200   ProfilePage.mainEntity  Jordan Lewis Gilbert  ok   8
  [4]  200   ProfilePage.mainEntity  Jordan Lewis Gilbert  ok   8
  [5]  200   ProfilePage.mainEntity  Jordan Gilbert        ok   8
  [6]  200   ProfilePage.mainEntity  Jordan Gilbert        ok   8

Names
  "Jordan Lewis Gilbert"  name on [1], [2], [3], [4]
  "Jordan Gilbert"        name on [5], [6]; alternateName on [1], [2], [3], [4]

sameAs coverage (row: the page; column: the set member its sameAs should list)
       [1]  [2]  [3]  [4]  [5]  [6]  [7]  [8]  [9]
  [1]  -    yes  yes  yes  yes  yes  yes  yes  yes
  [2]  yes  -    yes  yes  yes  yes  yes  yes  yes
  [3]  yes  yes  -    yes  yes  yes  yes  yes  yes
  [4]  yes  yes  yes  -    yes  yes  yes  yes  yes
  [5]  yes  yes  yes  yes  -    yes  yes  yes  yes
  [6]  yes  yes  yes  yes  yes  -    yes  yes  yes

sameAs targets
  result        HTTP  target                                         set  listed by
  ok            200   https://ticketwavehq.com/jordan                [1]  [2], [3], [4], [5], [6]
  ok            200   https://veryseoly.com/jordan                   [2]  [1], [3], [4], [5], [6]
  ok            200   https://dacros.com/jordan                      [3]  [1], [2], [4], [5], [6]
  ok            200   https://www.jortech.co.uk/jordan               [4]  [1], [2], [3], [5], [6]
  ok            200   https://custodiance.com/jordan                 [5]  [1], [2], [3], [4], [6]
  ok            200   https://citorah.com/author                     [6]  [1], [2], [3], [4], [5]
  ok            200   https://github.com/eu-jordangilbert            [7]  [1], [2], [3], [4], [5], [6]
  unverifiable  999   https://www.linkedin.com/in/eu-jordangilbert/  [8]  [1], [2], [3], [4], [5], [6]
  unverifiable  200   https://www.instagram.com/jorzior/             [9]  [1], [2], [3], [4], [5], [6]

Findings
  WARN  [5]  name-mismatch        name is "Jordan Gilbert"; [1], [2], [3], [4] use "Jordan Lewis Gilbert"
  WARN  [6]  name-mismatch        name is "Jordan Gilbert"; [1], [2], [3], [4] use "Jordan Lewis Gilbert"
  NOTE  -    sameas-unverifiable  https://www.linkedin.com/in/eu-jordangilbert/ returns HTTP 999: the site refuses automated requests; listed by [1], [2], [3], [4], [5], [6]
  NOTE  -    sameas-unverifiable  https://www.instagram.com/jorzior/ returns HTTP 200, but www.instagram.com shows logged-out visitors a login page or an app shell, so a 200 does not prove the profile exists; listed by [1], [2], [3], [4], [5], [6]
  NOTE  [5]  alternate-name-gap   gives neither name nor alternateName as "Jordan Lewis Gilbert" (on [1], [2], [3], [4])
  NOTE  [6]  alternate-name-gap   gives neither name nor alternateName as "Jordan Lewis Gilbert" (on [1], [2], [3], [4])

Result: 0 errors, 2 warnings, 4 notes. Exit 0 (--fail-on error).
```

What it found:

- **Linking is complete.** All six pages load, each names its Person through
  `ProfilePage.mainEntity`, each Person `url` matches the page's canonical, and
  every page's `sameAs` lists the other five pages and all three profiles. None
  of the links that could be checked is dead or redirected.
- **Two name forms.** Four pages give `name` as "Jordan Lewis Gilbert" and list
  "Jordan Gilbert" as `alternateName`. The custodiance.com and citorah.com pages
  give `name` as "Jordan Gilbert" and have no `alternateName`. The fix is to
  make those two match the other four, or at least to add "Jordan Lewis
  Gilbert" to their `alternateName`.
- **Two links cannot be verified automatically.** LinkedIn answered 999 and
  Instagram answered 200, which from Instagram does not show whether the handle
  exists. Both need checking by hand in a browser.

The JSON form of the same report is in
[`examples/2026-11-10-report.json`](examples/2026-11-10-report.json). The saved
HTML is not committed.

## Why Node.js and not Python

Both could do this with their standard libraries. Node.js needed less code for
the parts that matter here:

- **Redirects one hop at a time.** Node's global `fetch` with
  `redirect: 'manual'` returns each 3xx response with its `Location` header.
  The tool follows the chain itself, records every status, and caches every hop
  by URL, which is how it keeps to one request per URL. Python's `urllib`
  follows redirects on its own unless you replace its redirect handler.
- **Everything else is built in**: `AbortSignal.timeout` for timeouts that also
  cover the body, `node:util` `parseArgs` for options, `node:test` for the
  tests, and native JSON.
- **It fits where it is used.** Static-site and front-end build pipelines
  usually have Node.js already, so in their CI it adds nothing to install.

Node.js 20 or later is required: the tool relies on the global `fetch`,
`AbortSignal.timeout`, `parseArgs` and `node --test`, all available without
flags from that version. CI runs the tests on Node.js 20, 22 and 24.

## Using it from code

```js
import { checkEntities, createFetcher, networkTransport, renderText } from 'person-entity-check';

const fetcher = createFetcher({ transport: networkTransport(), delayMs: 1000 });
const report = await checkEntities({
  pages: ['https://example.com/jane', 'https://example.org/about/jane'],
  profiles: ['https://github.com/jane'],
  fetcher,
});
process.stdout.write(renderText(report));
```

`networkTransport({ fetchImpl })` takes any function with the `fetch`
signature, which is how the tests stub the network. `snapshotTransport` and
`loadSnapshot` give the `--no-network` behaviour, and `extractPage(html, url)`
gives the parsed Person, canonical and JSON-LD errors for one page.

## Development

```sh
node --test        # or: npm test
```

The tests are offline: a stubbed `fetch` and the fixture snapshot serve the same
responses, so the network path and the `--no-network` path are checked against
the same data. Fixtures use `example.com` and `example.org` only.

```text
bin/person-entity-check.mjs   the command
src/cli.mjs                   options, set files, exit codes
src/fetcher.mjs               transports, redirects, cache, delay, --save
src/extract.mjs               JSON-LD, Person selection, canonical
src/check.mjs                 the checks and the report object
src/report.mjs                the text tables
src/urls.mjs                  URL comparison and the private-address guard
test/                         node:test suites and fixtures
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for security issues,
[SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE). Copyright TicketWave HQ Ltd.

---

Maintained by [TicketWave HQ](https://ticketwavehq.com), a UK company (Companies House 17143167).
