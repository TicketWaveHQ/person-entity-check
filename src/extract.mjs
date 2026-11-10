// Pull JSON-LD, Person nodes and the canonical link out of an HTML string.
//
// No HTML parser: the tool is zero-dependency, so it scans for <script> and
// <link> tags with a regular expression that also consumes HTML comments, so a
// commented-out block is never read. That is enough for JSON-LD, which is plain
// text inside a script element, and for a canonical <link>.

import { looseKey, toUrl } from './urls.mjs';

// At each position the comment branch is tried first, so a <script> inside a
// comment is swallowed by the comment, and a "<!--" inside a script's JSON is
// swallowed by the script.
const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)|<link\b([^>]*)>/gi;
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function parseAttributes(s) {
  const attrs = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function stripWrappers(text) {
  return text
    .trim()
    .replace(/^(?:\/\/\s*)?<!\[CDATA\[/, '')
    .replace(/(?:\/\/\s*)?\]\]>$/, '')
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .trim();
}

/**
 * Scan the HTML once. Returns the JSON-LD blocks (parsed or with an error) and
 * every canonical href in document order.
 */
export function scanHtml(html) {
  const blocks = [];
  const canonicals = [];
  for (const m of html.matchAll(TOKEN_RE)) {
    if (m[0].startsWith('<!--')) continue;
    if (m[3] !== undefined) {
      const attrs = parseAttributes(m[3]);
      const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
      if (rel.includes('canonical') && attrs.href) canonicals.push(attrs.href.trim());
      continue;
    }
    const attrs = parseAttributes(m[1] || '');
    const type = (attrs.type || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/ld+json') continue;
    const index = blocks.length + 1;
    const text = stripWrappers(m[2] || '');
    if (!text) {
      blocks.push({ index, error: 'empty block' });
      continue;
    }
    try {
      blocks.push({ index, data: JSON.parse(text) });
    } catch (err) {
      blocks.push({ index, error: String(err.message || err).split('\n')[0] });
    }
  }
  return { blocks, canonicals };
}

export function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

const SCHEMA_PREFIX = /^(?:https?:\/\/schema\.org\/|schema:)/i;

export function typesOf(node) {
  return asArray(node && node['@type'])
    .filter((t) => typeof t === 'string')
    .map((t) => t.replace(SCHEMA_PREFIX, ''));
}

export function hasType(node, type) {
  return typesOf(node).includes(type);
}

/** Strings from a JSON-LD text value: "x", {"@value": "x"}, or an array of either. */
export function textsOf(v) {
  const out = [];
  for (const item of asArray(v)) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof item['@value'] === 'string') out.push(item['@value']);
  }
  return out;
}

/** Strings from a JSON-LD URL value: "x", {"@id": "x"}, {"url": "x"}, or an array of those. */
export function urlsOf(v) {
  const out = [];
  for (const item of asArray(v)) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      if (typeof item['@id'] === 'string') out.push(item['@id']);
      else if (typeof item.url === 'string') out.push(item.url);
      else if (typeof item['@value'] === 'string') out.push(item['@value']);
    }
  }
  return out;
}

function isReferenceOnly(obj) {
  return Object.keys(obj).every((k) => k === '@id' || k === '@type');
}

function collect(value, out, depth) {
  if (depth > 64) return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value['@type'] !== undefined || value['@id'] !== undefined) out.push(value);
  for (const [k, v] of Object.entries(value)) {
    if (k === '@context') continue;
    if (v && typeof v === 'object') collect(v, out, depth + 1);
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function merge(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (!(k in into)) {
      into[k] = v;
      continue;
    }
    if (k === '@id' || sameValue(into[k], v)) continue;
    const merged = [...asArray(into[k])];
    for (const item of asArray(v)) if (!merged.some((m) => sameValue(m, item))) merged.push(item);
    into[k] = merged;
  }
  return into;
}

function idOf(node, base) {
  const id = node && node['@id'];
  if (typeof id !== 'string' || !id.trim()) return null;
  const u = toUrl(id, base);
  return u ? u.href : id.trim();
}

/**
 * Build the node graph for one page. Nodes that share an @id (across blocks
 * too) are merged; a node that carries only @id and @type is a reference.
 */
export function buildGraph(blocks, base) {
  const raw = [];
  for (const b of blocks) if (b.data !== undefined) collect(b.data, raw, 0);
  const byId = new Map();
  const anonymous = [];
  for (const node of raw) {
    const id = idOf(node, base);
    if (!id) {
      if (node['@type'] !== undefined) anonymous.push(node);
      continue;
    }
    const entry = byId.get(id);
    if (!entry) byId.set(id, { node: merge({}, node), defined: !isReferenceOnly(node) });
    else {
      merge(entry.node, node);
      if (!isReferenceOnly(node)) entry.defined = true;
    }
  }
  const nodes = [...anonymous, ...[...byId.values()].map((e) => e.node)];
  const resolve = (v) => {
    if (typeof v === 'string') {
      const key = toUrl(v, base)?.href ?? v;
      return byId.has(key) ? { node: byId.get(key).node, resolved: byId.get(key).defined } : { node: null, resolved: false, ref: v };
    }
    if (!v || typeof v !== 'object') return { node: null, resolved: false };
    const id = idOf(v, base);
    if (id && byId.has(id)) {
      const entry = byId.get(id);
      return { node: entry.node, resolved: entry.defined, ref: v['@id'] };
    }
    return { node: v, resolved: !isReferenceOnly(v), ref: v['@id'] };
  };
  return { nodes, byId, resolve };
}

function pageKeys(pageUrl, canonical) {
  const keys = new Set();
  for (const s of [pageUrl, canonical]) {
    const u = toUrl(s);
    if (u) keys.add(looseKey(u));
  }
  return keys;
}

/**
 * Choose the Person the page is about.
 *   1. the Person a ProfilePage names as mainEntity (inline or by @id)
 *   2. a Person whose url or @id is this page
 *   3. the only Person on the page
 *   4. otherwise the first Person that has sameAs (flagged as ambiguous)
 */
export function selectPerson(graph, pageUrl, canonical) {
  const persons = graph.nodes.filter((n) => hasType(n, 'Person') && !isReferenceOnly(n));
  const notes = [];
  for (const pp of graph.nodes.filter((n) => hasType(n, 'ProfilePage'))) {
    for (const me of asArray(pp.mainEntity)) {
      const r = graph.resolve(me);
      const ref = r.ref ?? (typeof me === 'string' ? me : JSON.stringify(me));
      if (!r.node || !r.resolved) notes.push({ kind: 'mainentity-unresolved', ref });
      else if (hasType(r.node, 'Person')) return { person: r.node, via: 'ProfilePage.mainEntity', persons, notes };
      else notes.push({ kind: 'mainentity-not-person', ref, types: typesOf(r.node) });
    }
  }
  if (persons.length === 0) return { person: null, via: null, persons, notes };
  const keys = pageKeys(pageUrl, canonical);
  const matching = persons.filter((p) =>
    [...urlsOf(p.url), ...(typeof p['@id'] === 'string' ? [p['@id']] : [])].some((s) => {
      const u = toUrl(s, pageUrl);
      return u && keys.has(looseKey(u));
    }),
  );
  if (matching.length === 1) return { person: matching[0], via: 'url matches the page', persons, notes };
  if (persons.length === 1) return { person: persons[0], via: 'only Person on the page', persons, notes };
  const pool = matching.length > 1 ? matching : persons;
  const pick = pool.find((p) => p.sameAs !== undefined) ?? pool[0];
  notes.push({ kind: 'person-ambiguous', count: persons.length });
  return { person: pick, via: 'first of several Persons', persons, notes };
}

function cleanText(s) {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Everything the checks need from one page's HTML. */
export function extractPage(html, pageUrl) {
  const { blocks, canonicals } = scanHtml(html);
  const canonicalHref = canonicals[0] ?? null;
  const canonicalUrl = canonicalHref ? toUrl(canonicalHref, pageUrl) : null;
  const canonical = canonicalUrl ? canonicalUrl.href : null;
  const graph = buildGraph(blocks, pageUrl);
  const chosen = selectPerson(graph, pageUrl, canonical);
  const p = chosen.person;
  const person = p
    ? {
        via: chosen.via,
        id: idOf(p, pageUrl),
        types: typesOf(p),
        names: textsOf(p.name).map(cleanText).filter(Boolean),
        alternateNames: textsOf(p.alternateName).map(cleanText).filter(Boolean),
        url: urlsOf(p.url),
        sameAs: urlsOf(p.sameAs),
        hasSameAs: p.sameAs !== undefined,
      }
    : null;
  return {
    jsonld: {
      blocks: blocks.length,
      errors: blocks.filter((b) => b.error).map((b) => ({ block: b.index, error: b.error })),
    },
    canonical,
    canonicals: canonicals.length,
    personCount: chosen.persons.length,
    person,
    notes: chosen.notes,
  };
}
