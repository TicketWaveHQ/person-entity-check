// Programmatic API. The CLI (src/cli.mjs) is a thin layer over these.
export { checkEntities, classifyTarget, buildSet, DEFAULT_WALLED_HOSTS, REFUSED_STATUSES, InputError } from './check.mjs';
export { extractPage, scanHtml, buildGraph, selectPerson } from './extract.mjs';
export { createFetcher, networkTransport, snapshotTransport, loadSnapshot, addHtmlFiles, DEFAULT_USER_AGENT, DEFAULTS } from './fetcher.mjs';
export { renderText } from './report.mjs';
export { main, parseCli, parseSetFile } from './cli.mjs';
export { VERSION } from './version.mjs';
