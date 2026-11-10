// The checks. Input: the set (pages you control, plus third-party profiles),
// and a fetcher. Output: one report object, rendered as a table or as JSON.

import { extractPage } from './extract.mjs';
import { bareHost, differences, hostMatches, isWeb, looseKey, requestForm, strictForm, toUrl } from './urls.mjs';
import { VERSION } from './version.mjs';

/** Hosts whose logged-out responses do not show whether a profile exists. */
export const DEFAULT_WALLED_HOSTS = Object.freeze([
  'linkedin.com',
  'instagram.com',
  'facebook.com',
  'threads.net',
  'threads.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
]);

/** Statuses that mean "the site refused an automated request", not "the page is gone". 999 is LinkedIn's. */
export const REFUSED_STATUSES = Object.freeze([401, 403, 429, 999]);

const LOGIN_PATH = /\/(?:accounts\/|uas\/)?(?:login|log-in|signin|sign-in|authwall)(?:[/?#.]|$)/i;

/** Bad input (not a web address, no pages): the CLI turns it into exit code 2. */
export class InputError extends Error {}

export const SEVERITY_RANK = Object.freeze({ error: 3, warn: 2, note: 1 });
const FAIL_THRESHOLD = Object.freeze({ error: 3, warn: 2, never: Infinity });

const TARGET_FINDING = Object.freeze({
  dead: ['error', 'sameas-dead'],
  'moved-host': ['error', 'sameas-moved-host'],
  moved: ['warn', 'sameas-moved'],
  'server-error': ['warn', 'sameas-server-error'],
  'http-error': ['warn', 'sameas-http-error'],
  unreachable: ['warn', 'sameas-unreachable'],
  unverifiable: ['note', 'sameas-unverifiable'],
});

function pageList(indexes) {
  const list = [...indexes].sort((a, b) => a - b).map((i) => `[${i}]`);
  return list.join(', ');
}

/**
 * Decide what a sameAs target's response means.
 * Returns { result, note } where result is one of:
 * ok, dead, moved-host, moved, server-error, http-error, unreachable, unverifiable, not-checked.
 */
export function classifyTarget(start, res, { walledHosts = DEFAULT_WALLED_HOSTS } = {}) {
  const startUrl = new URL(start);
  const hops = res.chain ?? [];
  const login = hops.slice(1).find((h) => {
    const u = toUrl(h.url);
    return u && LOGIN_PATH.test(u.pathname);
  });
  if (login) return { result: 'unverifiable', note: `redirects to a login page (${login.url})` };
  if (res.error === 'not in snapshot') return { result: 'not-checked', note: 'not in the snapshot' };
  if (res.error === 'private address') {
    const where = hops.length > 1 ? `redirects to ${res.finalUrl}, ` : '';
    return { result: 'not-checked', note: `${where}a local or private address, so it was not requested` };
  }
  if (res.error === 'ENOTFOUND') return { result: 'dead', note: 'the host name does not resolve (ENOTFOUND)' };
  if (res.error) return { result: 'unreachable', note: `request failed (${res.error})` };

  const s = res.status;
  const final = new URL(res.finalUrl);
  const via = hops.length > 1 ? `redirects to ${res.finalUrl}, which ` : '';
  if (REFUSED_STATUSES.includes(s)) {
    return { result: 'unverifiable', note: `${via}returns HTTP ${s}: the site refuses automated requests` };
  }
  if (s === 404 || s === 410) return { result: 'dead', note: `${via}returns HTTP ${s}` };
  if (s >= 500) return { result: 'server-error', note: `${via}returns HTTP ${s}` };
  if (s >= 300 && s < 400) return { result: 'http-error', note: `${via}returns HTTP ${s} with no Location header` };
  if (s < 200 || s >= 300) return { result: 'http-error', note: `${via}returns HTTP ${s}` };
  const home = final.pathname === '/' && !final.search && startUrl.pathname !== '/';
  if (bareHost(final) !== bareHost(startUrl)) {
    const what = home ? "another host's home page" : 'another host';
    return { result: 'moved-host', note: `redirects to ${what}: ${res.finalUrl}`, home };
  }
  if (looseKey(final) !== looseKey(startUrl)) {
    return { result: 'moved', note: `redirects to ${home ? 'the home page: ' : ''}${res.finalUrl}`, home };
  }
  if (walledHosts.some((d) => hostMatches(final.hostname, d))) {
    return {
      result: 'unverifiable',
      note: `returns HTTP ${s}, but ${final.hostname} shows logged-out visitors a login page or an app shell, so a 200 does not prove the profile exists`,
    };
  }
  if (hops.length > 1) {
    return { result: 'ok', note: `redirects to ${res.finalUrl} (${differences(startUrl, final).join(', ')})`, redirected: true };
  }
  return { result: 'ok', note: `HTTP ${s}` };
}

/**
 * Normalise and de-duplicate the set. Returns members in order, pages first.
 * Throws an InputError for an address that is not http(s).
 */
export function buildSet(pages, profiles = []) {
  const members = [];
  const duplicates = [];
  const byKey = new Map();
  for (const [kind, list] of [
    ['page', pages],
    ['profile', profiles],
  ]) {
    for (const raw of list) {
      const u = toUrl(raw);
      if (!isWeb(u)) throw new InputError(`Not a web address: ${raw}`);
      const key = looseKey(u);
      if (byKey.has(key)) {
        duplicates.push({ url: raw, sameAs: byKey.get(key).index });
        continue;
      }
      const member = { index: members.length + 1, kind, url: requestForm(u), given: raw, keys: new Set([key]), finalUrl: null };
      members.push(member);
      byKey.set(key, member);
    }
  }
  return { members, duplicates };
}

export async function checkEntities({
  pages,
  profiles = [],
  fetcher,
  walledHosts = DEFAULT_WALLED_HOSTS,
  checkTargets = true,
  failOn = 'error',
  onProgress = null,
}) {
  if (!fetcher) throw new Error('checkEntities needs a fetcher');
  if (!(failOn in FAIL_THRESHOLD)) throw new InputError(`failOn must be one of ${Object.keys(FAIL_THRESHOLD).join(', ')}`);
  const { members, duplicates } = buildSet(pages, profiles);
  const pageMembers = members.filter((m) => m.kind === 'page');
  if (pageMembers.length === 0) throw new InputError('Give at least one page to check');

  const findings = [];
  const add = (severity, check, message, extra = {}) => findings.push({ severity, check, ...extra, message });
  const memberFor = (u) => members.find((m) => m.keys.has(looseKey(u))) ?? null;

  for (const d of duplicates) {
    add('note', 'set-duplicate', `${d.url} is the same page as [${d.sameAs}]; it was checked once`);
  }

  // 1. Fetch and read every page.
  const pageResults = [];
  let n = 0;
  for (const m of pageMembers) {
    n += 1;
    if (onProgress) onProgress({ phase: 'page', n, total: pageMembers.length, url: m.url });
    const res = await fetcher.resolve(m.url, { wantBody: true, allowPrivate: true });
    const page = {
      index: m.index,
      url: m.url,
      status: res.status ?? null,
      finalUrl: res.finalUrl,
      chain: res.chain,
      error: res.error ?? null,
      canonical: null,
      jsonldBlocks: 0,
      personCount: 0,
      person: null,
      coverage: [],
    };
    pageResults.push(page);
    const fetched = toUrl(res.finalUrl);
    const at = { page: m.index };

    if (res.error) {
      add('error', 'page-fetch', `${m.url} could not be fetched (${res.error})`, at);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const via = res.chain.length > 1 ? ` after redirecting to ${res.finalUrl}` : '';
      add('error', 'page-fetch', `${m.url} returns HTTP ${res.status}${via}`, at);
      continue;
    }
    // Only a page that loaded lends its final address to the set, so a sameAs
    // link to where it now lives counts as listing it.
    m.finalUrl = res.finalUrl;
    m.keys.add(looseKey(fetched));
    if (res.chain.length > 1) {
      const a = new URL(m.url);
      if (looseKey(a) === looseKey(fetched)) {
        add('note', 'page-redirect', `${m.url} redirects to ${res.finalUrl} (${differences(a, fetched).join(', ')})`, at);
      } else {
        add('warn', 'page-redirect', `${m.url} redirects to ${res.finalUrl}; give the final address instead`, at);
      }
    }
    if (typeof res.body !== 'string') {
      add('error', 'page-fetch', `${m.url} returned no HTML to read`, at);
      continue;
    }
    if (res.truncated) add('note', 'page-truncated', `${m.url} is larger than the read limit; only the start was read`, at);

    const ex = extractPage(res.body, res.finalUrl);
    page.canonical = ex.canonical;
    page.jsonldBlocks = ex.jsonld.blocks;
    page.personCount = ex.personCount;
    for (const e of ex.jsonld.errors) {
      add('error', 'jsonld-invalid', `JSON-LD block ${e.block} is not valid JSON (${e.error})`, at);
    }
    if (ex.canonicals > 1) add('warn', 'canonical-multiple', `the page has ${ex.canonicals} canonical links; the first is used`, at);
    for (const note of ex.notes) {
      if (note.kind === 'mainentity-unresolved') {
        add('warn', 'mainentity-unresolved', `ProfilePage.mainEntity refers to ${note.ref}, which is not defined on the page`, at);
      } else if (note.kind === 'mainentity-not-person') {
        add('warn', 'mainentity-not-person', `ProfilePage.mainEntity ${note.ref} is a ${note.types.join('/') || 'node without @type'}, not a Person`, at);
      } else if (note.kind === 'person-ambiguous') {
        add('warn', 'person-ambiguous', `${note.count} Person nodes and no ProfilePage.mainEntity naming one; the first with sameAs was checked`, at);
      }
    }
    if (ex.canonical) {
      const c = new URL(ex.canonical);
      m.keys.add(looseKey(c));
      if (strictForm(c) !== strictForm(fetched)) {
        const how = looseKey(c) === looseKey(fetched) ? ` (${differences(fetched, c).join(', ')})` : '; give the canonical address instead';
        add('warn', 'canonical-elsewhere', `the canonical is ${ex.canonical}, not the fetched address ${res.finalUrl}${how}`, at);
      }
    } else {
      add('note', 'canonical-missing', 'no <link rel="canonical">; the Person url was compared with the fetched address', at);
    }
    if (!ex.person) {
      const why = ex.jsonld.blocks === 0 ? 'no JSON-LD on the page' : `no Person node in ${ex.jsonld.blocks} JSON-LD block(s)`;
      add('error', 'person-missing', why, at);
      continue;
    }
    const p = ex.person;
    page.person = {
      via: p.via,
      id: p.id,
      name: p.names[0] ?? null,
      names: p.names,
      alternateNames: p.alternateNames,
      url: p.url[0] ?? null,
      sameAs: p.sameAs,
      hasSameAs: p.hasSameAs,
    };

    // url against the canonical (or the fetched address when there is none).
    const reference = ex.canonical ?? res.finalUrl;
    const refLabel = ex.canonical ? 'the canonical' : 'the fetched address';
    if (p.url.length === 0) {
      add('warn', 'url-missing', `the Person has no url; it should be ${reference}`, at);
    } else {
      if (p.url.length > 1) add('note', 'url-multiple', `the Person has ${p.url.length} url values; the first is checked`, at);
      const u = toUrl(p.url[0], res.finalUrl);
      if (!isWeb(u)) {
        add('warn', 'url-invalid', `the Person url "${p.url[0]}" is not a web address`, at);
      } else {
        if (u.hash) {
          add('warn', 'url-fragment', `the Person url ${u.href} points at a fragment; url should be the page (${requestForm(u)}), and the fragment form belongs in @id`, at);
        }
        const r = new URL(reference);
        if (strictForm(u) !== strictForm(r)) {
          const same = looseKey(u) === looseKey(r);
          const detail = same ? ` (${differences(u, r).join(', ')})` : '';
          const what = same ? `differs from ${refLabel} ${reference}${detail}` : `is not this page; ${refLabel} is ${reference}`;
          add('warn', 'url-not-canonical', `the Person url ${requestForm(u)} ${what}`, at);
        }
      }
    }
  }

  // 2. Names across pages.
  const withPerson = pageResults.filter((p) => p.person);
  const forms = new Map();
  for (const p of withPerson) {
    if (!p.person.name) {
      add('error', 'name-missing', 'the Person has no name', { page: p.index });
      continue;
    }
    if (p.person.names.length > 1) {
      add('note', 'name-multiple', `name has ${p.person.names.length} values; the first ("${p.person.name}") is compared`, { page: p.index });
    }
    if (!forms.has(p.person.name)) forms.set(p.person.name, []);
    forms.get(p.person.name).push(p.index);
  }
  let majority = null;
  for (const [name, idx] of forms) if (!majority || idx.length > forms.get(majority).length) majority = name;
  if (forms.size > 1) {
    for (const p of withPerson) {
      const name = p.person.name;
      if (!name || name === majority) continue;
      const caseOnly = name.toLowerCase() === majority.toLowerCase() ? ', which differs only in letter case' : '';
      const others = forms.get(majority);
      const verb = others.length === 1 ? 'uses' : 'use';
      add('warn', 'name-mismatch', `name is "${name}"; ${pageList(others)} ${verb} "${majority}"${caseOnly}`, { page: p.index });
    }
  }
  const allForms = new Map();
  for (const p of withPerson) {
    for (const f of [...p.person.names, ...p.person.alternateNames]) {
      if (!allForms.has(f)) allForms.set(f, new Set());
      allForms.get(f).add(p.index);
    }
  }
  if (withPerson.length > 1) {
    for (const p of withPerson) {
      const own = new Set([...p.person.names, ...p.person.alternateNames]);
      const absent = [...allForms.keys()].filter((f) => !own.has(f));
      if (absent.length) {
        const list = absent.map((f) => `"${f}" (on ${pageList(allForms.get(f))})`).join(', ');
        add('note', 'alternate-name-gap', `gives neither name nor alternateName as ${list}`, { page: p.index });
      }
    }
  }
  const names = [...allForms].map(([name, idx]) => ({
    name,
    asName: forms.get(name) ?? [],
    asAlternateName: withPerson.filter((p) => p.person.alternateNames.includes(name)).map((p) => p.index),
    onPages: [...idx].sort((a, b) => a - b),
  }));

  // 3. sameAs coverage, per page.
  const targets = new Map();
  const targetFor = (url) => {
    if (!targets.has(url)) targets.set(url, { url, listedBy: new Set(), member: null, listedAs: new Set() });
    return targets.get(url);
  };
  for (const p of withPerson) {
    const at = { page: p.index };
    const present = new Set();
    const seen = new Map();
    for (const raw of p.person.sameAs) {
      const u = toUrl(raw, p.finalUrl);
      if (!isWeb(u)) {
        add('warn', 'sameas-invalid', `sameAs entry "${raw}" is not a web address`, at);
        continue;
      }
      const key = looseKey(u);
      if (seen.has(key)) {
        add('note', 'sameas-duplicate', `sameAs lists ${u.href} more than once (also as ${seen.get(key)})`, at);
        continue;
      }
      seen.set(key, u.href);
      if (u.hash) add('warn', 'sameas-fragment', `sameAs entry ${u.href} points at a fragment; list the page (${requestForm(u)})`, at);
      const member = memberFor(u);
      if (member && member.index === p.index) {
        add('note', 'sameas-self', `sameAs lists the page itself (${u.href}); sameAs is for the other pages`, at);
        continue;
      }
      const t = targetFor(requestForm(u));
      t.listedBy.add(p.index);
      t.listedAs.add(u.href);
      if (member) {
        present.add(member.index);
        t.member = member.index;
        const forms2 = [member.url, member.finalUrl].filter(Boolean).map((s) => strictForm(new URL(s)));
        if (!forms2.includes(strictForm(u))) {
          const base = new URL(member.finalUrl ?? member.url);
          add('note', 'sameas-variant', `sameAs lists ${requestForm(u)} for [${member.index}] ${base.href} (${differences(u, base).join(', ')})`, at);
        }
      } else {
        add('warn', 'sameas-unlisted', `sameAs lists ${requestForm(u)}, which is not in the set; add it to the set if it is this person, or remove it`, at);
      }
    }
    p.coverage = members.map((m) => ({ index: m.index, state: m.index === p.index ? 'self' : present.has(m.index) ? 'listed' : 'missing' }));
    const missing = members.filter((m) => m.index !== p.index && !present.has(m.index));
    if (missing.length) {
      const lead = p.person.hasSameAs ? 'sameAs does not list' : 'the Person has no sameAs; it should list';
      add('warn', 'sameas-missing', `${lead} ${missing.map((m) => `[${m.index}] ${m.url}`).join(', ')}`, {
        ...at,
        missing: missing.map((m) => m.url),
      });
    }
  }
  for (const m of members.filter((x) => x.kind === 'profile')) {
    const t = targetFor(m.url);
    t.member = m.index;
  }

  // 4. Every distinct sameAs target and profile: status, redirects, login walls.
  // Set members first, in set order; then everything else in the order the pages listed it.
  const targetList = [...targets.values()].sort((a, b) => (a.member ?? Infinity) - (b.member ?? Infinity));
  let skipped = 0;
  n = 0;
  for (const t of targetList) {
    n += 1;
    if (!checkTargets && !fetcher.has(t.url)) {
      Object.assign(t, { result: 'not-checked', note: 'not requested (--pages-only)', status: null, finalUrl: null, chain: [] });
      skipped += 1;
      continue;
    }
    if (onProgress) onProgress({ phase: 'target', n, total: targetList.length, url: t.url });
    const res = await fetcher.resolve(t.url);
    const c = classifyTarget(t.url, res, { walledHosts });
    let note = c.note;
    let hint = '';
    if (c.result === 'moved-host' || c.result === 'moved') {
      const into = memberFor(new URL(res.finalUrl));
      if (into && into.index !== t.member) note += `; that is [${into.index}] in the set, so list it directly`;
      else if (into) note += `; that is where [${into.index}] now lives, so list the final address`;
      else if (c.home) note += ', which usually means the page was removed or the address changed hands; remove the link or point it at the current page';
      else note += '; if that is still this person, list the new address, otherwise remove the link';
    }
    if ((c.result === 'dead' || c.result === 'moved' || c.result === 'moved-host') && !t.member) {
      // A dead or moved link beside a set member on the same host that the page does not list: often a rename.
      const host = bareHost(new URL(t.url));
      const hints = new Map();
      for (const i of t.listedBy) {
        const page = pageResults.find((x) => x.index === i);
        for (const cell of page?.coverage ?? []) {
          const m = members[cell.index - 1];
          if (cell.state !== 'missing' || bareHost(new URL(m.url)) !== host) continue;
          if (!hints.has(m.index)) hints.set(m.index, new Set());
          hints.get(m.index).add(i);
        }
      }
      for (const [i, on] of hints) {
        hint += `. [${i}] ${members[i - 1].url} is on the same host and missing from ${pageList(on)}, so the profile may have been renamed`;
      }
    }
    Object.assign(t, { result: c.result, note, status: res.status ?? null, finalUrl: res.finalUrl ?? null, chain: res.chain ?? [] });
    if (c.result === 'not-checked') {
      skipped += 1;
      continue;
    }
    const listed = t.listedBy.size ? `; listed by ${pageList(t.listedBy)}` : '; in the set, but no page lists it';
    if (c.result === 'ok' && c.redirected) {
      add('note', 'sameas-redirect', `${t.url} ${note}${listed}`, { target: t.url, pages: [...t.listedBy].sort((a, b) => a - b) });
      continue;
    }
    const kind = TARGET_FINDING[c.result];
    if (kind) add(kind[0], kind[1], `${t.url} ${note}${listed}${hint}`, { target: t.url, pages: [...t.listedBy].sort((a, b) => a - b) });
  }
  if (skipped) {
    const reasons = [...new Set(targetList.filter((t) => t.result === 'not-checked').map((t) => t.note))];
    add('note', 'sameas-not-checked', `${skipped} sameAs target(s) not checked: ${reasons.join('; ')}`);
  }

  // 5. Summary and exit code.
  const sorted = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[b.f.severity] - SEVERITY_RANK[a.f.severity] || (a.f.page ?? 0) - (b.f.page ?? 0) || a.i - b.i)
    .map(({ f }) => f);
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const failing = findings.filter((f) => SEVERITY_RANK[f.severity] >= FAIL_THRESHOLD[failOn]).length;
  return {
    schemaVersion: 1,
    tool: { name: 'person-entity-check', version: VERSION },
    generatedAt: new Date().toISOString(),
    mode: fetcher.network ? 'network' : 'no-network',
    requests: fetcher.requests,
    set: members.map(({ index, kind, url }) => ({ index, kind, url })),
    pages: pageResults,
    names,
    targets: targetList.map((t) => ({
      url: t.url,
      member: t.member,
      listedBy: [...t.listedBy].sort((a, b) => a - b),
      listedAs: [...t.listedAs],
      result: t.result,
      status: t.status,
      finalUrl: t.finalUrl,
      chain: t.chain,
      note: t.note,
    })),
    findings: sorted,
    summary: { errors: count('error'), warnings: count('warn'), notes: count('note'), failOn, exitCode: failing > 0 ? 1 : 0 },
  };
}
