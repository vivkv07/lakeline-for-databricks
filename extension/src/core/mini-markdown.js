/*
 * A small, safe Markdown subset for Genie answer text (ui/sidepanel.js).
 *
 * parse(text) returns a plain block tree (no DOM); render(doc, textOrTree) builds a
 * DocumentFragment with createElement/createTextNode only. Nothing is ever parsed as HTML:
 * `<script>` and friends stay visible text, a small set of entities (&amp; &lt; &#39; ...) is
 * decoded into text, and links are kept only for https:// URLs without credentials (rendered
 * with rel="noopener noreferrer" target="_blank"); any other link or image is shown as its
 * source text.
 *
 * Supported: paragraphs (single newlines become line breaks), headings (# \u2192 h3, ## \u2192 h4,
 * ### and deeper \u2192 h5), **bold**, *italic*, `inline code`, fenced code blocks, ordered and
 * unordered lists (one nested level; deeper indentation is flattened into that level),
 * blockquotes (two levels), GFM tables with alignment, horizontal rules, autolinks.
 *
 * Bounds: input is capped (LIMITS.input), list items, table rows and columns, nesting depth and
 * total blocks are capped, and delimiter scans remember failed searches so hostile input stays
 * linear-ish. Underscore emphasis needs word boundaries, so snake_case names stay intact.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const LIMITS = Object.freeze({ input: 20000, blocks: 400, quoteDepth: 2, inlineDepth: 5, listItems: 200, tableRows: 200, tableCols: 20, link: 2048 });

  const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', ndash: '\u2013', hellip: '\u2026', middot: '\u00B7', copy: '\u00A9', reg: '\u00AE', trade: '\u2122', times: '\u00D7', deg: '\u00B0', euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2' });
  const PUNCT = /[!-/:-@[-`{-~]/;
  const WORD = /[\p{L}\p{N}]/u;

  /* ---------------------------------------------------------------- links */

  /** The normalized URL when `raw` is an https:// URL without credentials, else null. */
  function safeHref(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > LIMITS.link) return null;
    if (!/^https:\/\//i.test(raw) || /[\s<>"'`\\\u0000-\u001F\u007F]/.test(raw)) return null;
    let u;
    try {
      u = new URL(raw);
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.href;
  }

  /* ---------------------------------------------------------------- inline */

  function pushText(out, text) {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text') last.text += text;
    else out.push({ type: 'text', text });
  }

  function decodeEntity(s, i) {
    const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/.exec(s.slice(i, i + 12));
    if (!m) return null;
    const body = m[1];
    let ch = null;
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Control characters, surrogates and out-of-range code points become U+FFFD.
      ch = !Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? '\uFFFD' : String.fromCodePoint(cp);
    } else if (Object.prototype.hasOwnProperty.call(ENTITIES, body)) {
      ch = ENTITIES[body];
    }
    return ch === null ? null : { text: ch, end: i + m[0].length };
  }

  /** Index of the matching `]` for the `[` at i (nested brackets allowed), or -1. */
  function closeBracket(s, i) {
    let depth = 0;
    // Link labels are short; a bounded scan keeps nested or unclosed brackets cheap.
    for (let j = i, stop = Math.min(s.length, i + 1000); j < stop; j++) {
      const c = s[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) return j;
      else if (c === '\n' && s[j + 1] === '\n') return -1;
    }
    return -1;
  }

  /** `[label](dest)` starting at i \u2192 {label, dest, end} or null. Dest has no spaces; an optional "title" is ignored. */
  function linkAt(s, i) {
    const close = closeBracket(s, i);
    if (close < 0 || s[close + 1] !== '(') return null;
    const m = /^\(\s*<?([^\s<>()]*)>?(?:\s+"[^"\n]{0,200}")?\s*\)/.exec(s.slice(close + 1, close + 1 + LIMITS.link + 220));
    if (!m) return null;
    return { label: s.slice(i + 1, close), dest: m[1], end: close + 1 + m[0].length };
  }

  /** Is the delimiter run s[i, i+n) able to open (left-flanking) / close (right-flanking)? */
  function flanking(s, i, n, ch) {
    const before = i > 0 ? s[i - 1] : ' ';
    const after = i + n < s.length ? s[i + n] : ' ';
    const ws = (c) => /\s/.test(c);
    const opens = !ws(after) && (ch === '*' || !WORD.test(before));
    const closes = !ws(before) && (ch === '*' || !WORD.test(after));
    return { opens, closes };
  }

  function parseInline(s, depth, noLinks) {
    const out = [];
    let buf = '';
    const flush = () => {
      pushText(out, buf);
      buf = '';
    };
    const noCloser = new Map(); // delimiter \u2192 position after which no closer exists
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '\n') {
        flush();
        out.push({ type: 'br' });
        i++;
        continue;
      }
      if (c === '`') {
        let n = 1;
        while (s[i + n] === '`') n++;
        const run = '`'.repeat(n);
        const key = 'code' + n;
        let end = -1;
        if (!(noCloser.has(key) && noCloser.get(key) <= i)) {
          for (let j = s.indexOf(run, i + n); j >= 0; j = s.indexOf(run, j + 1)) {
            let k = j + n;
            if (s[j - 1] === '`') continue;
            if (s[k] === '`') {
              while (s[k] === '`') k++;
              j = k - 1;
              continue;
            }
            end = j;
            break;
          }
          if (end < 0) noCloser.set(key, i);
        }
        if (end < 0) {
          buf += run;
          i += n;
          continue;
        }
        flush();
        let code = s.slice(i + n, end).replace(/\n/g, ' ');
        if (code.length > 1 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
        i = end + n;
        continue;
      }
      if (c === '&') {
        const e = decodeEntity(s, i);
        if (e) {
          buf += e.text;
          i = e.end;
          continue;
        }
      }
      if ((c === '*' || c === '_') && depth < LIMITS.inlineDepth) {
        let n = 1;
        while (s[i + n] === c) n++;
        const take = Math.min(n, 3);
        const run = c.repeat(take);
        const f = flanking(s, i, n, c);
        const key = c + take;
        let close = -1;
        if (f.opens && !(noCloser.has(key) && noCloser.get(key) <= i)) {
          for (let j = s.indexOf(run, i + n); j >= 0; j = s.indexOf(run, j + 1)) {
            if (s[j - 1] === c) continue; // inside a longer run: only run starts can close
            let m = take;
            while (s[j + m] === c) m++;
            if (j > i + n && flanking(s, j, m, c).closes) {
              close = j;
              break;
            }
          }
          if (close < 0) noCloser.set(key, i);
        }
        if (close < 0) {
          buf += c.repeat(n);
          i += n;
          continue;
        }
        flush();
        if (n > take) buf += c.repeat(n - take);
        const start = i + n;
        const inner = parseInline(s.slice(start, close), depth + 1, noLinks);
        flush();
        if (take === 3) out.push({ type: 'strong', children: [{ type: 'em', children: inner }] });
        else out.push({ type: take === 2 ? 'strong' : 'em', children: inner });
        i = close + take;
        continue;
      }
      if (c === '!' && s[i + 1] === '[') {
        // Images are never loaded: the whole construct stays literal text.
        const l = linkAt(s, i + 1);
        if (l) {
          buf += s.slice(i, l.end);
          i = l.end;
          continue;
        }
      }
      if (c === '[' && !noLinks) {
        const l = noCloser.has('[') && noCloser.get('[') <= i ? null : linkAt(s, i);
        if (!l && closeBracket(s, i) < 0) noCloser.set('[', i);
        if (l) {
          const href = safeHref(l.dest);
          if (href && l.label.trim()) {
            flush();
            out.push({ type: 'link', href, children: parseInline(l.label, depth + 1, true) });
          } else {
            buf += s.slice(i, l.end);
          }
          i = l.end;
          continue;
        }
      }
      if (c === '<') {
        const m = /^<(https:\/\/[^\s<>]{1,2048})>/i.exec(s.slice(i, i + 2060));
        const href = m && !noLinks ? safeHref(m[1]) : null;
        if (href) {
          flush();
          out.push({ type: 'link', href, children: [{ type: 'text', text: m[1] }] });
          i += m[0].length;
          continue;
        }
      }
      if ((c === 'h' || c === 'H') && !noLinks && (i === 0 || !WORD.test(s[i - 1])) && /^https:\/\//i.test(s.slice(i, i + 8))) {
        const m = /^https:\/\/[^\s<>"'`]{1,2040}/i.exec(s.slice(i, i + 2048));
        if (m) {
          let url = m[0];
          // Trailing punctuation belongs to the sentence; a ")" only when unbalanced.
          for (;;) {
            const last = url[url.length - 1];
            if (/[.,;:!?*_~'"]/.test(last)) url = url.slice(0, -1);
            else if (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
            else break;
          }
          const href = safeHref(url);
          if (href) {
            flush();
            out.push({ type: 'link', href, children: [{ type: 'text', text: url }] });
            i += url.length;
            continue;
          }
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  /* ---------------------------------------------------------------- blocks */

  // Every pattern here is linear on long lines (no overlapping quantifiers); the block helpers
  // below do the fiddly parts (trailing #s, fence info strings) with plain string operations.
  const RE = Object.freeze({
    blank: /^\s*$/,
    fenceOpen: /^ {0,3}(`{3,}|~{3,})/,
    headingOpen: /^ {0,3}(#{1,6})(?=[ \t]|$)/,
    hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
    quote: /^ {0,3}> ?/,
    item: /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/,
    delimRow: /^\|?:?-+:?(?:\|:?-+:?)*\|?$/,
  });

  /** Opening code fence \u2192 {ch, len, lang} or null. A backtick fence's info string has no backticks. */
  function fenceOf(line) {
    const m = RE.fenceOpen.exec(line);
    if (!m) return null;
    const info = line.slice(m[0].length).trim();
    if (m[1][0] === '`' && info.includes('`')) return null;
    const lang = /^[A-Za-z0-9_+.#-]{1,30}/.exec(info);
    return { ch: m[1][0], len: m[1].length, lang: lang ? lang[0] : null };
  }

  /** ATX heading \u2192 {level, text} or null; a closing run of #s (after a space) is dropped. */
  function headingOf(line) {
    const m = RE.headingOpen.exec(line);
    if (!m) return null;
    let text = line.slice(m[0].length).trim();
    let k = text.length;
    while (k > 0 && text[k - 1] === '#') k--;
    if (k < text.length && (k === 0 || text[k - 1] === ' ' || text[k - 1] === '\t')) text = text.slice(0, k).trim();
    return { level: m[1].length, text };
  }

  const isHr = (line) => line.length <= 300 && RE.hr.test(line);
  const isDelimRow = (line) => line.length <= 2000 && RE.delimRow.test(line.replace(/[ \t]+/g, ''));

  function isFenceClose(line, ch, len) {
    const t = line.replace(/^ {0,3}/, '');
    let n = 0;
    while (t[n] === ch) n++;
    return n >= len && /^\s*$/.test(t.slice(n));
  }

  function splitRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const cells = [];
    let cur = '';
    let code = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '\\' && t[i + 1] === '|') {
        cur += '|';
        i++;
      } else if (c === '`') {
        code = !code;
        cur += c;
      } else if (c === '|' && !code) {
        cells.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function isTableStart(lines, i) {
    const head = lines[i];
    const delim = lines[i + 1];
    if (head === undefined || delim === undefined || !head.includes('|') || !isDelimRow(delim)) return false;
    if (!delim.includes('|') && !head.trim().startsWith('|')) return false;
    return splitRow(head).length === splitRow(delim).length;
  }

  function itemOf(line) {
    const m = RE.item.exec(line);
    if (!m) return null;
    if (isHr(line)) return null;
    const ordered = /\d/.test(m[2]);
    return { indent: m[1].length, ordered, start: ordered ? parseInt(m[2], 10) : null, text: m[3] || '', width: m[1].length + m[2].length + 1 };
  }

  /** Lines that end a paragraph: another block starting. */
  function interrupts(lines, i) {
    const line = lines[i];
    if (fenceOf(line) || headingOf(line) || isHr(line) || RE.quote.test(line)) return true;
    const it = itemOf(line);
    if (it && it.text.trim() && it.indent <= 3 && (!it.ordered || it.start === 1)) return true;
    return isTableStart(lines, i);
  }

  function parseList(lines, i, first) {
    const list = { type: 'list', ordered: first.ordered, start: first.ordered ? first.start : null, items: [] };
    const base = first.indent;
    let cur = null;
    let lastLevel = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (RE.blank.test(line)) {
        // A blank line keeps the list going only when another item (or an indented line) follows.
        let j = i + 1;
        while (j < lines.length && RE.blank.test(lines[j])) j++;
        if (j >= lines.length) return { node: list, next: j };
        const nx = itemOf(lines[j]);
        const indentNext = /^ */.exec(lines[j])[0].length;
        if ((nx && nx.indent >= base && (nx.indent > base + 1 || nx.ordered === list.ordered)) || (!nx && indentNext > base + 1 && cur)) {
          i = j;
          continue;
        }
        return { node: list, next: j };
      }
      const it = itemOf(line);
      if (it && it.indent <= base + 1) {
        if (it.ordered !== list.ordered) break;
        if (list.items.length >= LIMITS.listItems) {
          i++;
          continue;
        }
        cur = { children: parseInline(it.text, 0), sub: null };
        list.items.push(cur);
        lastLevel = 0;
        i++;
        continue;
      }
      if (it && it.indent > base + 1 && cur) {
        // Any deeper indentation joins the single nested level.
        if (!cur.sub) cur.sub = { type: 'list', ordered: it.ordered, start: it.ordered ? it.start : null, items: [] };
        if (cur.sub.items.length < LIMITS.listItems) cur.sub.items.push({ children: parseInline(it.text, 0), sub: null });
        lastLevel = 1;
        i++;
        continue;
      }
      if (!cur) break;
      if (!it && (/^\s/.test(line) || !interrupts(lines, i))) {
        // Continuation of the current item (indented or lazy).
        const target = lastLevel === 1 && cur.sub ? cur.sub.items[cur.sub.items.length - 1] : cur;
        if (target) target.children = target.children.concat([{ type: 'br' }], parseInline(line.trim(), 0));
        i++;
        continue;
      }
      break;
    }
    return { node: list, next: i };
  }

  function parseBlocks(lines, depth, budget) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (budget.n <= 0) break;
      const line = lines[i];
      if (RE.blank.test(line)) {
        i++;
        continue;
      }
      budget.n--;
      const fence = fenceOf(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !isFenceClose(lines[i], fence.ch, fence.len)) body.push(lines[i++]);
        i++;
        out.push({ type: 'code', lang: fence.lang, text: body.join('\n') });
        continue;
      }
      const hd = headingOf(line);
      if (hd) {
        out.push({ type: 'heading', level: Math.min(5, hd.level + 2), children: parseInline(hd.text, 0) });
        i++;
        continue;
      }
      if (isHr(line)) {
        out.push({ type: 'hr' });
        i++;
        continue;
      }
      if (RE.quote.test(line)) {
        const inner = [];
        while (i < lines.length && RE.quote.test(lines[i])) inner.push(lines[i++].replace(RE.quote, ''));
        if (depth + 1 < LIMITS.quoteDepth) out.push({ type: 'quote', children: parseBlocks(inner, depth + 1, budget) });
        else out.push({ type: 'quote', children: [{ type: 'paragraph', children: parseInline(inner.join('\n'), 0) }] });
        continue;
      }
      if (isTableStart(lines, i)) {
        const head = splitRow(lines[i]).slice(0, LIMITS.tableCols);
        const align = splitRow(lines[i + 1])
          .slice(0, LIMITS.tableCols)
          .map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null));
        const rows = [];
        i += 2;
        while (i < lines.length && !RE.blank.test(lines[i]) && lines[i].includes('|') && !RE.quote.test(lines[i]) && !fenceOf(lines[i])) {
          if (rows.length < LIMITS.tableRows) {
            const cells = splitRow(lines[i]).slice(0, head.length);
            while (cells.length < head.length) cells.push('');
            rows.push(cells.map((c) => parseInline(c, 0)));
          }
          i++;
        }
        out.push({ type: 'table', align, head: head.map((c) => parseInline(c, 0)), rows });
        continue;
      }
      const it = itemOf(line);
      if (it) {
        const r = parseList(lines, i, it);
        out.push(r.node);
        i = Math.max(r.next, i + 1);
        continue;
      }
      const para = [line.trim()];
      i++;
      while (i < lines.length && !RE.blank.test(lines[i]) && !interrupts(lines, i)) para.push(lines[i++].trim());
      out.push({ type: 'paragraph', children: parseInline(para.join('\n'), 0) });
    }
    return out;
  }

  /**
   * @param {string} input
   * @returns {{blocks: object[], truncated: boolean}}
   */
  function parse(input) {
    let text = typeof input === 'string' ? input : '';
    const truncated = text.length > LIMITS.input;
    if (truncated) text = text.slice(0, LIMITS.input);
    text = text
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    const blocks = parseBlocks(text.split('\n'), 0, { n: LIMITS.blocks });
    if (truncated) blocks.push({ type: 'paragraph', children: [{ type: 'text', text: '(Answer shortened.)' }] });
    return { blocks, truncated };
  }

  /* ---------------------------------------------------------------- render */

  function inline(doc, nodes, parent) {
    for (const n of nodes) {
      if (n.type === 'text') parent.appendChild(doc.createTextNode(n.text));
      else if (n.type === 'br') parent.appendChild(doc.createElement('br'));
      else if (n.type === 'code') {
        const el = doc.createElement('code');
        el.textContent = n.text;
        parent.appendChild(el);
      } else if (n.type === 'strong' || n.type === 'em') {
        const el = doc.createElement(n.type);
        inline(doc, n.children, el);
        parent.appendChild(el);
      } else if (n.type === 'link') {
        const href = safeHref(n.href);
        if (!href) {
          inline(doc, n.children, parent);
          continue;
        }
        const a = doc.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        inline(doc, n.children, a);
        parent.appendChild(a);
      }
    }
    return parent;
  }

  function listEl(doc, node) {
    const el = doc.createElement(node.ordered ? 'ol' : 'ul');
    if (node.ordered && Number.isInteger(node.start) && node.start !== 1 && node.start >= 0) el.setAttribute('start', String(node.start));
    for (const it of node.items) {
      const li = doc.createElement('li');
      inline(doc, it.children, li);
      if (it.sub) li.appendChild(listEl(doc, it.sub));
      el.appendChild(li);
    }
    return el;
  }

  function block(doc, b) {
    switch (b.type) {
      case 'paragraph':
        return inline(doc, b.children, doc.createElement('p'));
      case 'heading':
        return inline(doc, b.children, doc.createElement('h' + Math.max(3, Math.min(5, b.level))));
      case 'hr':
        return doc.createElement('hr');
      case 'code': {
        const pre = doc.createElement('pre');
        pre.setAttribute('tabindex', '0');
        const code = doc.createElement('code');
        code.textContent = b.text;
        pre.appendChild(code);
        return pre;
      }
      case 'quote': {
        const q = doc.createElement('blockquote');
        for (const c of b.children) q.appendChild(block(doc, c));
        return q;
      }
      case 'list':
        return listEl(doc, b);
      case 'table': {
        const wrap = doc.createElement('div');
        wrap.className = 'md-table';
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('tabindex', '0');
        wrap.setAttribute('aria-label', 'Table in the answer');
        const table = doc.createElement('table');
        const thead = doc.createElement('thead');
        const tr = doc.createElement('tr');
        const alignOf = (i) => (b.align[i] === 'center' || b.align[i] === 'right' || b.align[i] === 'left' ? b.align[i] : null);
        b.head.forEach((cell, i) => {
          const th = doc.createElement('th');
          th.setAttribute('scope', 'col');
          if (alignOf(i)) th.style.textAlign = alignOf(i);
          tr.appendChild(inline(doc, cell, th));
        });
        thead.appendChild(tr);
        const tbody = doc.createElement('tbody');
        for (const row of b.rows) {
          const r = doc.createElement('tr');
          row.forEach((cell, i) => {
            const td = doc.createElement('td');
            if (alignOf(i)) td.style.textAlign = alignOf(i);
            r.appendChild(inline(doc, cell, td));
          });
          tbody.appendChild(r);
        }
        table.append(thead, tbody);
        wrap.appendChild(table);
        return wrap;
      }
      default:
        return doc.createTextNode('');
    }
  }

  /**
   * @param {Document} doc
   * @param {string|{blocks}} input Markdown text or a parse() result
   * @returns {DocumentFragment}
   */
  function render(doc, input) {
    const tree = typeof input === 'string' || input === null || input === undefined ? parse(input || '') : input;
    const frag = doc.createDocumentFragment();
    for (const b of tree.blocks || []) frag.appendChild(block(doc, b));
    return frag;
  }

  /** Plain text of a parse() result (headings and items on their own lines). */
  function toText(input) {
    const tree = typeof input === 'string' ? parse(input) : input;
    const flat = (nodes) => nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : n.type === 'br' ? '\n' : n.children ? flat(n.children) : '')).join('');
    const lines = [];
    const walk = (blocks) => {
      for (const b of blocks) {
        if (b.type === 'paragraph' || b.type === 'heading') lines.push(flat(b.children));
        else if (b.type === 'code') lines.push(b.text);
        else if (b.type === 'quote') walk(b.children);
        else if (b.type === 'list') for (const it of b.items) {
          lines.push(flat(it.children));
          if (it.sub) for (const s of it.sub.items) lines.push(flat(s.children));
        }
        else if (b.type === 'table') for (const r of [b.head].concat(b.rows)) lines.push(r.map(flat).join('\t'));
      }
    };
    walk(tree.blocks || []);
    return lines.join('\n');
  }

  const api = Object.freeze({ LIMITS, parse, render, toText, safeHref, parseInline: (s) => parseInline(String(s || ''), 0) });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).miniMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
