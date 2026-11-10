# Contributing

Issues and pull requests are welcome. A few notes save round trips.

## Scope

The tool checks that one person's profile pages agree: the JSON-LD Person, its
names, its `sameAs` links and its `url`. Ideas that fit that job are in scope.
A general link checker, a crawler or an SEO auditor is not; those are better as
separate tools.

## Ground rules

- **No dependencies.** The tool runs on Node.js 20 or later with nothing
  installed. Use the standard library (`node:*` modules and web globals such as
  `fetch`).
- **Tests stay offline.** Use the stubbed `fetch` in `test/helpers.mjs` or the
  fixture snapshot. Never make a real request from a test. Fixture data uses
  `example.com` and `example.org` only, never a real person's or company's site.
- **Every new check needs a test** that shows it firing, and its level (error,
  warn or note) and meaning go in the tables in `README.md`.
- **Be polite to other people's servers.** Keep to one request per URL per
  run. If you need a real response for a test, write it into a fixture by hand
  rather than recording someone's site.
- **Errors are for breakage.** A finding is an error only when something is
  clearly broken (a 404, a redirect to another host, no Person). Anything that
  needs a human decision is a warning; information is a note.
- **Copy.** UK English. No em-dashes in docs or output; use a comma, a colon or
  a hyphen. Do not state anything in docs or messages that the tool cannot show.

## Making a change

```sh
node --test
node bin/person-entity-check.mjs --no-network --snapshot test/fixtures/snapshot --file test/fixtures/set.txt
```

Add an entry under an `Unreleased` heading in `CHANGELOG.md`. Contributions are
accepted under the [MIT licence](LICENSE), the same as the rest of the project.

## Security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
