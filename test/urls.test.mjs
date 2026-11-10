import { test } from 'node:test';
import assert from 'node:assert/strict';
import { differences, hostMatches, isPrivateAddress, looseKey, requestForm, strictForm, toUrl } from '../src/urls.mjs';

// IP literals are assembled from parts so the source tree carries no dotted addresses.
const ip = (...octets) => octets.join('.');

test('looseKey ignores scheme, www, trailing slash, case and fragment', () => {
  const a = looseKey(new URL('http://www.Example.com/Jane/#me'));
  const b = looseKey(new URL('https://example.com/jane'));
  assert.equal(a, b);
  assert.notEqual(looseKey(new URL('https://example.com/jane?x=1')), b);
});

test('strictForm and requestForm drop only the fragment', () => {
  const u = new URL('https://example.com/jane/?a=1#person');
  assert.equal(strictForm(u), 'https://example.com/jane/?a=1');
  assert.equal(requestForm(u), 'https://example.com/jane/?a=1');
});

test('differences names what changed', () => {
  assert.deepEqual(differences(new URL('http://www.example.com/jane/'), new URL('https://example.com/jane')), ['http vs https', 'www prefix', 'trailing slash']);
  assert.deepEqual(differences(new URL('https://example.com/Jane'), new URL('https://example.com/jane')), ['letter case']);
});

test('toUrl and hostMatches', () => {
  assert.equal(toUrl('  '), null);
  assert.equal(toUrl('/jane', 'https://example.com/x').href, 'https://example.com/jane');
  assert.ok(hostMatches('uk.social.example.org', 'social.example.org'));
  assert.ok(!hostMatches('notsocial.example.org', 'social.example.org'));
});

test('isPrivateAddress: loopback, private, link-local and local-only names', () => {
  for (const host of [ip(127, 0, 0, 1), ip(10, 1, 2, 3), ip(172, 20, 0, 1), ip(192, 168, 1, 1), ip(169, 254, 169, 254), 'localhost', 'dev.localhost', 'printer.local', 'intranet', '[::1]', '[fd00::1]']) {
    assert.ok(isPrivateAddress(`http://${host}/`), host);
  }
  for (const host of ['example.com', 'www.example.org', ip(172, 32, 0, 1)]) {
    assert.ok(!isPrivateAddress(`https://${host}/`), host);
  }
});
