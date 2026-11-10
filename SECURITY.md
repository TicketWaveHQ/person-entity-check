# Security policy

## Reporting a vulnerability

If you find a security issue in this tool, please report it privately by email
to [hello@ticketwavehq.com](mailto:hello@ticketwavehq.com) rather than opening a
public issue. TicketWave HQ's disclosure policy is at
[ticketwavehq.com/security](https://ticketwavehq.com/security).

Please include:

- what the issue is and the impact you think it has;
- steps to reproduce, or a minimal proof of concept;
- the Node.js version and operating system, if they matter;
- whether you have told anyone else.

## What happens next

How reports are acknowledged, assessed and disclosed is set out in the
disclosure policy at [ticketwavehq.com/security](https://ticketwavehq.com/security),
which applies to this repository.

## Scope

The tool fetches web pages, parses HTML and JSON-LD from them, and then
requests the `sameAs` links those pages publish. Things we would treat as
security issues include:

- a way for a page's content to make the tool request something it should not,
  such as a local or private address (the tool refuses these for `sameAs`
  targets and their redirects; see "How it fetches" in the README);
- a way for a page or a snapshot to crash the tool, hang it beyond its timeouts,
  or make it use unbounded memory;
- report output that leaks something it should not, such as resolved IP
  addresses or the content of files other than the pages being checked.

Out of scope:

- How third-party sites respond to automated requests.
- Snapshots you did not create. A snapshot's `index.json` names files to read;
  treat a snapshot from someone else like code from someone else.
- The `--user-agent` option. Setting a misleading User-Agent is the operator's
  choice and responsibility.
