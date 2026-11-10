import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, decodeEntities, extractPage, scanHtml, textsOf, urlsOf } from '../src/extract.mjs';
import { page } from './helpers.mjs';

const ld = (obj, type = 'application/ld+json') => `<script type="${type}">${JSON.stringify(obj)}</script>`;

test('@graph: ProfilePage.mainEntity resolves a Person by @id', () => {
  const ex = extractPage(page('alpha.html'), 'https://alpha.example.com/jane');
  assert.equal(ex.person.via, 'ProfilePage.mainEntity');
  assert.equal(ex.person.names[0], 'Jane Example');
  assert.deepEqual(ex.person.alternateNames, ['J. Example']);
  assert.equal(ex.person.sameAs.length, 5);
  assert.equal(ex.canonical, 'https://alpha.example.com/jane');
});

test('Person in a separate block from the ProfilePage, referenced by a relative @id', () => {
  const ex = extractPage(page('beta.html'), 'https://beta.example.org/jane');
  assert.equal(ex.person.via, 'ProfilePage.mainEntity');
  assert.equal(ex.person.id, 'https://beta.example.org/jane#person');
  assert.equal(ex.jsonld.blocks, 2, 'a type with a charset parameter still counts as JSON-LD');
  assert.equal(ex.canonical, 'https://beta.example.org/jane', 'relative canonical, href before rel');
});

test('top-level array, schema: prefix, Person chosen by url, commented-out block ignored', () => {
  const ex = extractPage(page('gamma.html'), 'https://gamma.example.com/people/jane');
  assert.equal(ex.personCount, 2, 'the Person inside an HTML comment is not read');
  assert.equal(ex.person.via, 'url matches the page');
  assert.equal(ex.person.names[0], 'J. Example');
  assert.deepEqual(ex.notes, []);
});

test('invalid JSON is reported per block and the other blocks are still read', () => {
  const ex = extractPage(page('delta.html'), 'https://delta.example.org/jane');
  assert.equal(ex.jsonld.blocks, 2);
  assert.equal(ex.jsonld.errors.length, 1);
  assert.equal(ex.jsonld.errors[0].block, 1);
  assert.equal(ex.person, null);
  assert.equal(ex.canonical, null);
});

test('inline mainEntity object', () => {
  const html = ld({ '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: 'Jane Example', sameAs: 'https://example.org/jane' } });
  const ex = extractPage(html, 'https://example.com/jane');
  assert.equal(ex.person.via, 'ProfilePage.mainEntity');
  assert.deepEqual(ex.person.sameAs, ['https://example.org/jane'], 'a single sameAs string becomes a list');
});

test('mainEntity that points at nothing is noted, and the only Person is used instead', () => {
  const html =
    ld({ '@type': 'ProfilePage', mainEntity: { '@id': 'https://example.com/jane#missing' } }) +
    ld({ '@type': 'Person', '@id': 'https://example.com/jane#person', name: 'Jane Example' });
  const ex = extractPage(html, 'https://example.com/jane');
  assert.equal(ex.notes[0].kind, 'mainentity-unresolved');
  assert.equal(ex.person.via, 'url matches the page');
});

test('mainEntity given as a bare @id string', () => {
  const html =
    ld({ '@type': 'ProfilePage', mainEntity: 'https://example.com/jane#person' }) +
    ld({ '@type': 'Person', '@id': 'https://example.com/jane#person', name: 'Jane Example' });
  assert.equal(extractPage(html, 'https://example.com/jane').person.via, 'ProfilePage.mainEntity');
});

test('mainEntity that is not a Person is noted', () => {
  const html = ld({ '@type': 'ProfilePage', mainEntity: { '@id': '#org', '@type': 'Organization', name: 'Example Ltd' } });
  const ex = extractPage(html, 'https://example.com/jane');
  assert.equal(ex.notes[0].kind, 'mainentity-not-person');
  assert.equal(ex.person, null);
});

test('several Persons and no ProfilePage: ambiguous, the first with sameAs wins', () => {
  const html = ld([
    { '@type': 'Person', name: 'Sam Sample', url: 'https://example.com/sam' },
    { '@type': 'Person', name: 'Jane Example', url: 'https://example.com/team', sameAs: ['https://example.org/jane'] },
  ]);
  const ex = extractPage(html, 'https://example.com/team-page');
  assert.equal(ex.notes[0].kind, 'person-ambiguous');
  assert.equal(ex.person.names[0], 'Jane Example');
});

test('nodes sharing an @id across blocks are merged; reference-only nodes are not Persons', () => {
  const html =
    ld({ '@type': 'Article', author: { '@id': 'https://example.com/jane#person', '@type': 'Person' } }) +
    ld({ '@type': 'Person', '@id': 'https://example.com/jane#person', name: 'Jane Example' }) +
    ld({ '@id': 'https://example.com/jane#person', sameAs: ['https://example.org/jane'] });
  const ex = extractPage(html, 'https://example.com/elsewhere');
  assert.equal(ex.personCount, 1);
  assert.equal(ex.person.names[0], 'Jane Example');
  assert.deepEqual(ex.person.sameAs, ['https://example.org/jane']);
});

test('types: full schema.org IRI and arrays', () => {
  const html = ld({ '@type': ['https://schema.org/Person', 'Thing'], name: 'Jane Example' });
  assert.deepEqual(extractPage(html, 'https://example.com/').person.types, ['Person', 'Thing']);
});

test('script wrappers, upper-case type, CDATA and HTML comment inside the script', () => {
  const html =
    `<SCRIPT TYPE="Application/LD+JSON">//<![CDATA[\n${JSON.stringify({ '@type': 'Person', name: 'A' })}\n//]]></SCRIPT>` +
    `<script type='application/ld+json'><!-- ${JSON.stringify({ '@type': 'Person', name: 'B' })} --></script>` +
    `<script type="text/javascript">var x = {"@type": "Person"};</script>`;
  const { blocks } = scanHtml(html);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.data));
});

test('empty block is an error, not a crash', () => {
  const { blocks } = scanHtml('<script type="application/ld+json">  </script>');
  assert.equal(blocks[0].error, 'empty block');
});

test('canonical: rel with several tokens, entities in href, first one wins', () => {
  const html =
    '<link data-x="1" rel="Canonical Alternate" href="https://example.com/jane?a=1&amp;b=2">' +
    '<link rel="canonical" href="https://example.com/other">';
  const { canonicals } = scanHtml(html);
  assert.deepEqual(canonicals, ['https://example.com/jane?a=1&b=2', 'https://example.com/other']);
  assert.equal(extractPage(html, 'https://example.com/jane').canonicals, 2);
});

test('name values: @value objects, whitespace collapsed; sameAs objects with @id or url', () => {
  assert.deepEqual(textsOf([{ '@value': 'Jane Example' }, 'J. Example', 7]), ['Jane Example', 'J. Example']);
  assert.deepEqual(urlsOf([{ '@id': 'https://example.org/a' }, { url: 'https://example.org/b' }, 'https://example.org/c']), [
    'https://example.org/a',
    'https://example.org/b',
    'https://example.org/c',
  ]);
  const ex = extractPage(ld({ '@type': 'Person', name: '  Jane \n Example ' }), 'https://example.com/');
  assert.equal(ex.person.names[0], 'Jane Example');
});

test('decodeEntities handles named, decimal and hex references', () => {
  assert.equal(decodeEntities('&amp;&lt;&#39;&#x41;&unknown;'), "&<'A&unknown;");
});

test('buildGraph resolves string and object references', () => {
  const g = buildGraph([{ data: { '@graph': [{ '@type': 'Person', '@id': '#p', name: 'Jane Example' }] } }], 'https://example.com/jane');
  assert.equal(g.resolve('#p').node.name, 'Jane Example');
  assert.equal(g.resolve({ '@id': 'https://example.com/jane#p' }).resolved, true);
  assert.equal(g.resolve('#nope').node, null);
});
