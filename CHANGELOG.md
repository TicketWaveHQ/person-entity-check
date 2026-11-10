# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-10

First release.

### Added

- The `person-entity-check` command: Node.js 20 or later, no dependencies.
- The set: pages (fully checked) and profiles (`--profile`), from arguments or
  a set file (`--file`).
- JSON-LD extraction: `@graph`, top-level arrays, nested nodes, nodes merged by
  `@id` across blocks, relative `@id` values, and the Person chosen through
  `ProfilePage.mainEntity`, a matching `url` or `@id`, or as the only Person.
- Checks for names (`name-mismatch`, `alternate-name-gap`), sameAs coverage
  (`sameas-missing`, `sameas-unlisted`, `sameas-fragment` and others), sameAs
  targets (dead, moved to another host, moved on the same host, unverifiable,
  unreachable), and `url` against the canonical.
- Login-walled hosts (LinkedIn, Instagram and others) reported as
  unverifiable, never as dead; `--walled-host` to add more.
- Polite fetching: one GET per URL per run with every redirect hop cached,
  sequential requests with `--delay`, `--timeout`, a descriptive User-Agent,
  and no requests to local or private addresses from sameAs links.
- Text tables and `--json` output; exit codes 0, 1 and 2 with `--fail-on`.
- Offline runs for CI: `--save`, `--no-network --snapshot` and `--html`.
- Offline tests with fixture HTML (example.com and example.org only) and a
  stubbed `fetch`, run in CI on Node.js 20, 22 and 24.

[0.1.0]: https://github.com/TicketWaveHQ/person-entity-check/releases/tag/v0.1.0
