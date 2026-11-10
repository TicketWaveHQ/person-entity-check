// URL helpers. Every comparison in the tool goes through one of three forms:
//
//   requestForm  what is sent over the wire: the URL without its fragment.
//   strictForm   scheme, host, path and query: used where the exact form matters
//                (Person url against the canonical).
//   looseKey     host without "www.", path without a trailing slash, lower case,
//                no scheme, no fragment: used to decide "is this the same page?"
//                when matching sameAs entries against the pages you listed.

/** Parse a string into a URL, resolving it against `base`. Returns null if it is not a URL. */
export function toUrl(value, base) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  try {
    return base ? new URL(s, base) : new URL(s);
  } catch {
    return null;
  }
}

export function isWeb(u) {
  return Boolean(u) && (u.protocol === 'http:' || u.protocol === 'https:');
}

export function requestForm(u) {
  const c = new URL(u.href);
  c.hash = '';
  return c.href;
}

export function strictForm(u) {
  return `${u.origin}${u.pathname}${u.search}`;
}

export function bareHost(u) {
  return u.host.toLowerCase().replace(/^www\./, '');
}

function trimSlash(path) {
  return path.replace(/\/+$/, '') || '/';
}

export function looseKey(u) {
  return `${bareHost(u)}${trimSlash(u.pathname)}${u.search}`.toLowerCase();
}

/**
 * Explain why two URLs that share a looseKey are not identical, in words.
 * Returns an empty array when the strict forms match.
 */
export function differences(a, b) {
  const out = [];
  if (a.protocol !== b.protocol) out.push(`${a.protocol.slice(0, -1)} vs ${b.protocol.slice(0, -1)}`);
  if (a.host.toLowerCase() !== b.host.toLowerCase() && bareHost(a) === bareHost(b)) out.push('www prefix');
  if (a.pathname !== b.pathname) {
    const ta = trimSlash(a.pathname);
    const tb = trimSlash(b.pathname);
    if (ta === tb) out.push('trailing slash');
    else if (ta.toLowerCase() === tb.toLowerCase()) out.push('letter case');
    else out.push('different path');
  }
  if (a.search !== b.search) out.push('different query');
  return out;
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatches(host, domain) {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
  return h === d || h.endsWith(`.${d}`);
}

/**
 * True for addresses a sameAs link should never make the tool request:
 * loopback, private and link-local IP literals, and local-only names
 * (localhost, .local, .internal, .home.arpa, single-label hosts).
 * A public name that resolves to a private address is not detected.
 */
export function isPrivateAddress(input) {
  const u = typeof input === 'string' ? toUrl(input) : input;
  if (!u) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:');
  }
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (parts.length === 1) return true;
  return ['localhost', 'local', 'internal', 'home.arpa'].some((d) => hostMatches(host, d));
}
