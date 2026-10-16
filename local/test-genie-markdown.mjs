// Safe Markdown subset for Genie answers (src/core/mini-markdown.js). The parser tests are pure
// Node; the rendering tests build real DOM nodes in jsdom (SIMULATED browser DOM) and spy on
// every HTML-parsing entry point to prove none is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { load } from './support/load.mjs';

const md = load('core/mini-markdown.js');

function dom() {
  const d = new JSDOM('<!doctype html><body></body>');
  const w = d.window;
  const calls = [];
  for (const [proto, prop] of [[w.Element.prototype, 'innerHTML'], [w.Element.prototype, 'outerHTML'], [w.ShadowRoot.prototype, 'innerHTML']]) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc) continue;
    Object.defineProperty(proto, prop, { configurable: true, get: desc.get, set(v) { calls.push(prop); return desc.set.call(this, v); } });
  }
  const iah = w.Element.prototype.insertAdjacentHTML;
  w.Element.prototype.insertAdjacentHTML = function (...a) { calls.push('insertAdjacentHTML'); return iah.apply(this, a); };
  const ccf = w.Range.prototype.createContextualFragment;
  w.Range.prototype.createContextualFragment = function (...a) { calls.push('createContextualFragment'); return ccf.apply(this, a); };
  const dw = w.document.write;
  w.document.write = function (...a) { calls.push('document.write'); return dw.apply(this, a); };
  return { w, doc: w.document, calls };
}

function renderTo(text) {
  const e = dom();
  const box = e.doc.createElement('div');
  box.appendChild(md.render(e.doc, text));
  e.doc.body.appendChild(box);
  return Object.assign(e, { box });
}

const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H3', 'H4', 'H5', 'HR', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'start', 'tabindex', 'class', 'role', 'aria-label', 'scope', 'style']);

function assertSafeTree(box) {
  for (const el of box.querySelectorAll('*')) {
    assert.ok(ALLOWED_TAGS.has(el.tagName), 'unexpected element ' + el.tagName);
    for (const a of el.getAttributeNames()) assert.ok(ALLOWED_ATTRS.has(a), 'unexpected attribute ' + a + ' on ' + el.tagName);
    if (el.tagName === 'A') {
      assert.match(el.getAttribute('href'), /^https:\/\//);
      assert.equal(el.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(el.getAttribute('target'), '_blank');
    }
    if (el.hasAttribute('style')) assert.match(el.getAttribute('style'), /^text-align: (left|center|right);$/);
  }
}

test('parse: paragraphs, line breaks, headings h3 to h5, emphasis, inline code, snake_case kept', () => {
  const { blocks } = md.parse('# Title\n## Sub ##\n### Third\n###### Deep\n#hashtag is text\n\nLine one\nline two with **bold**, *italic*, __also bold__, _em_ and `code`.\nrevenue_usd and change_pct stay intact; a*b*c is emphasis.');
  assert.deepEqual(blocks.slice(0, 4).map((b) => [b.type, b.level]), [['heading', 3], ['heading', 4], ['heading', 5], ['heading', 5]]);
  assert.equal(blocks[1].children[0].text, 'Sub', 'closing #s dropped');
  assert.equal(blocks[4].type, 'paragraph');
  assert.equal(blocks[4].children[0].text, '#hashtag is text');
  const p = blocks[5].children;
  assert.deepEqual(p.map((n) => n.type), ['text', 'br', 'text', 'strong', 'text', 'em', 'text', 'strong', 'text', 'em', 'text', 'code', 'text', 'br', 'text', 'em', 'text']);
  assert.equal(p.find((n) => n.type === 'code').text, 'code');
  assert.equal(p[14].text, 'revenue_usd and change_pct stay intact; a', 'underscores inside words are not emphasis');
});

test('parse: lists (ordered start, one nested level, deeper flattened), blockquotes (two levels), fenced code, hr, GFM tables', () => {
  const { blocks } = md.parse('3. three\n4. four\n   - nested a\n        - deeper b\n            - deepest c\n5. five\ncontinued lazily\n\n- x\n- y\n\n> quote\n> > inner\n> > > third\n\n```sql\nSELECT * FROM t WHERE a < 1\n<script>x</script>\n```\n\n---\n\n| Region | Revenue |\n|:--|--:|\n| EMEA | **412** |\n| a \\| b | `x|y` |\n| short |');
  const [ol, ul, quote, code, hr, table] = blocks;
  assert.equal(ol.type, 'list');
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.equal(ol.items.length, 3);
  assert.deepEqual(ol.items[1].sub.items.map((i) => i.children[0].text), ['nested a', 'deeper b', 'deepest c'], 'deeper levels join the one nested level');
  assert.ok(ol.items[1].sub.items.every((i) => i.sub === null));
  assert.deepEqual(ol.items[2].children.map((n) => n.type), ['text', 'br', 'text'], 'lazy continuation joins the item');
  assert.equal(ul.ordered, false);
  assert.equal(quote.type, 'quote');
  assert.equal(quote.children[1].type, 'quote');
  assert.ok(quote.children[1].children.every((c) => c.type !== 'quote'), 'a third level is flattened');
  assert.deepEqual([code.type, code.lang, code.text], ['code', 'sql', 'SELECT * FROM t WHERE a < 1\n<script>x</script>']);
  assert.equal(hr.type, 'hr');
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[1][0][0].text, 'a | b', 'escaped pipe stays in the cell');
  assert.equal(table.rows[1][1][0].text, 'x|y', 'pipes inside code spans do not split cells');
  assert.equal(table.rows[2].length, 2, 'short rows are padded');
});

test('links: only https:// without credentials; everything else stays literal text', () => {
  const ok = md.parseInline('[docs](https://docs.databricks.com/a?b=1#c) <https://x.example/y> see https://foo.example/z). and (https://bar.example/q)');
  const links = ok.filter((n) => n.type === 'link');
  assert.deepEqual(links.map((l) => l.href), ['https://docs.databricks.com/a?b=1#c', 'https://x.example/y', 'https://foo.example/z', 'https://bar.example/q']);
  const text = (nodes) => nodes.map((n) => (n.type === 'text' ? n.text : n.children ? text(n.children) : '')).join('');
  for (const bad of ['[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)', '[x](http://plain.example)', '[x](vbscript:msgbox)', '[x](//evil.example)', '[x](https://user:pw@evil.example)', '[x](https:evil.example)', '[x](https://)', '![img](https://img.example/a.png)', '[x](file:///etc/passwd)']) {
    const nodes = md.parseInline(bad);
    assert.ok(!nodes.some((n) => n.type === 'link'), bad + ' must not become a link');
    assert.equal(text(nodes), bad, bad + ' stays as its source text');
  }
  assert.equal(md.safeHref('https://a.example/x y'), null);
  assert.equal(md.safeHref('https://a.example/"onmouseover=alert(1)'), null);
  assert.equal(md.safeHref(' https://a.example'), null);
  assert.equal(md.safeHref('https://a.example/' + 'x'.repeat(3000)), null);
  // No nested links: the inner one is plain text.
  const nested = md.parseInline('[a [b](https://b.example)](https://a.example)');
  assert.equal(nested.filter((n) => n.type === 'link').length <= 1, true);
});

test('entities decode to text only; HTML is never parsed', () => {
  const nodes = md.parseInline('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s&#39; &#x41; &#0; &#x110000; &#xD800; &bogus; &amp');
  assert.deepEqual(nodes, [{ type: 'text', text: '<script>alert(1)</script> & "q" \'s\' A � � � &bogus; &amp' }]);
});

test('render (jsdom, simulated): DOM nodes only, no HTML parsing APIs, hostile input shown as text', () => {
  const hostile = [
    '<script>window.__pwned = 1</script>',
    '<img src=x onerror="window.__pwned=2">',
    '**<b onmouseover=alert(1)>bold</b>**',
    '[click](javascript:window.__pwned=3) [ok](https://ok.example/path)',
    '&lt;iframe src=&quot;javascript:alert(1)&quot;&gt;',
    '| a | b |\n|---|:-:|\n| <svg onload=alert(1)> | [x](data:text/html,hi) |',
    '```\n</code></pre><script>alert(1)</script>\n```',
    '> <style>body{display:none}</style>',
    '- <a href="javascript:alert(1)">x</a>\n  - nested <em>em</em>',
  ].join('\n\n');
  const e = renderTo(hostile);
  assert.deepEqual(e.calls, [], 'no innerHTML/outerHTML/insertAdjacentHTML/createContextualFragment/document.write');
  assertSafeTree(e.box);
  assert.equal(e.box.querySelectorAll('script, img, iframe, svg, style, b').length, 0);
  assert.equal(e.w.__pwned, undefined);
  const links = [...e.box.querySelectorAll('a')];
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://ok.example/path']);
  assert.match(e.box.textContent, /<script>window\.__pwned = 1<\/script>/);
  assert.match(e.box.textContent, /<iframe src="javascript:alert\(1\)">/);
  assert.match(e.box.querySelector('pre code').textContent, /<\/code><\/pre><script>/);
  assert.equal(e.box.querySelector('td').textContent, '<svg onload=alert(1)>');
  assert.equal(e.box.querySelectorAll('th')[1].style.textAlign, 'center');
});

test('render (jsdom, simulated): structure of a typical Genie answer', () => {
  const e = renderTo('**DEMO answer.** Revenue was **$1.24M**.\n\n- **EMEA** grew\n- APAC `orders`\n  - nested\n\n1. one\n2. two\n\n### Notes\nSee [the docs](https://docs.example/x).');
  assertSafeTree(e.box);
  assert.deepEqual([...e.box.children].map((c) => c.tagName), ['P', 'UL', 'OL', 'H5', 'P'], '### maps to h5 (# → h3, ## → h4)');
  assert.equal(e.box.querySelectorAll('strong').length, 3);
  assert.equal(e.box.querySelectorAll('ul ul li').length, 1);
  assert.equal(e.box.querySelector('a').textContent, 'the docs');
  assert.equal(md.toText('**A** b\n\n- c\n- d'), 'A b\nc\nd');
});

test('hostile sizes: deep nesting, long delimiter runs and huge input stay bounded and fast', () => {
  const cases = {
    deepList: Array.from({ length: 2000 }, (_, i) => ' '.repeat(Math.min(i, 400)) + '- item ' + i).join('\n'),
    deepQuote: '>'.repeat(5000) + ' deep',
    stars: '*'.repeat(20000),
    underscores: '_a'.repeat(10000),
    backticks: '`'.repeat(5000) + 'x' + '``a'.repeat(4000),
    brackets: '['.repeat(10000) + 'x' + ']'.repeat(10000),
    openers: '**a '.repeat(5000),
    emphasisNest: '*'.repeat(50) + 'x' + '*'.repeat(50),
    spaces: '# ' + ' '.repeat(19000) + 'x',
    fence: '```' + ' '.repeat(19000) + '`',
    table: '|' + 'a|'.repeat(300) + '\n|' + '-|'.repeat(300) + '\n|' + 'x|'.repeat(300),
    entities: '&amp;'.repeat(4000),
    links: '[a](https://x.example/)'.repeat(800),
    control: 'a\u0000b\u0007c\u001Fd\u007Fe',
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    const tree = md.parse(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, name + ' took ' + ms.toFixed(0) + ' ms');
    const e = renderTo(tree);
    assert.deepEqual(e.calls, [], name);
    assertSafeTree(e.box);
    if (name === 'deepList') assert.ok(!e.box.querySelector('ul ul ul'), 'lists nest one level at most');
    if (name === 'deepQuote') assert.ok(!e.box.querySelector('blockquote blockquote blockquote'), 'quotes nest two levels at most');
    if (name === 'table') assert.equal(e.box.querySelectorAll('th').length, md.LIMITS.tableCols);
    if (name === 'emphasisNest') assert.ok(e.box.querySelectorAll('em em em em em em em').length === 0);
    if (name === 'control') assert.equal(e.box.textContent, 'abcde');
  }
  const huge = md.parse('word '.repeat(10000));
  assert.equal(huge.truncated, true);
  assert.equal(huge.blocks.at(-1).children[0].text, '(Answer shortened.)');
  assert.ok(md.toText(huge).length <= md.LIMITS.input + 40);
});
