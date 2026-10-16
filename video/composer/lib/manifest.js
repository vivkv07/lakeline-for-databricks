// Capture manifests: loading, normalization and fuzzy lookup.
//
// Real captures live in dist/video/captures/<scene>/<theme>/<state>.png (served at /captures/)
// with one manifest.json per scene folder and an optional index.json at the root. For every scene
// whose real manifest is missing, unreadable, marked as a placeholder, or references an image that
// fails to load, the composer falls back to placeholder/manifests.json and the stage shows a loud
// PLACEHOLDER watermark, so a placeholder frame can never ship unnoticed.
//
// Accepted manifest shape (tolerant; aliases in brackets):
//   { scene, placeholder?, deviceScaleFactor?, viewport?, theme?,
//     states: [ { id [name|state|key], file [path|image|src], theme, kind [surface|type|target],
//                 viewport {width,height} [w,h | [w,h]], deviceScaleFactor [dsf|scale],
//                 description, scrollY?,
//                 boxes [bboxes|regions|elements|rects]: { name: {x,y,width,height} } or
//                        [ {name|id|key, x,y,width,height | rect|bbox|box:{...}} ],
//                 texts [text|labels|values|numbers]: { key: "exact UI text" } or [ {key, text|value} ] } ]
//       (states may also be an object keyed by id),
//     boxes?, texts?   (manifest-level, either flat or keyed by state id),
//     notification? { title, message, context? } }
// Box formats: {x,y,width,height} | {x,y,w,h} | {left,top,width,height} | {left,top,right,bottom}
// | [x,y,w,h]. All in CSS px of the state's own viewport (page, popup, panel or monitor).

export const SCENES = {
  3: { key: 'connect', words: ['connect', 'popup', 'onboard'] },
  4: { key: 'banner', words: ['banner', 'period', 'cost-banner'] },
  5: { key: 'runs', words: ['runs', 'run-costs', 'run'] },
  6: { key: 'queries', words: ['queries', 'query', 'sizing', 'warehouse'] },
  7: { key: 'explorer', words: ['explorer'] },
  8: { key: 'theme', words: ['theme', 'flip', 'dark'] },
  9: { key: 'genie', words: ['genie', 'ask', 'panel', 'side-panel'] },
  10: { key: 'monitor', words: ['monitor', 'notification'] },
  11: { key: 'colors', words: ['colors', 'color', 'workspace-colors'] },
};

/* ------------------------------------------------------------------ tokens */

export function tokens(s) {
  return String(s == null ? '' : s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z]{2,})/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Score how well a key (tokenized) matches a hint like "connect-button" or "7d". A full match
 * (every hint token present) scores high; partial overlap scores 1 per token and only counts when
 * partial matching is allowed (non-strict lookups).
 */
function hintScore(hay, hint, partial) {
  const ht = tokens(hint);
  if (!ht.length) return 0;
  const hit = ht.filter((x) => hay.includes(x)).length;
  let s = 0;
  if (hit === ht.length) {
    s += 4 * ht.length;
    if (ht.join(' ') === hay.join(' ')) s += 6;
  } else if (partial && hit) s += hit;
  return s;
}

function scoreHints(hay, hints, not, partial = true) {
  let s = 0;
  for (let i = 0; i < hints.length; i++) {
    const v = hintScore(hay, hints[i], partial);
    if (v) s += v * (1 + (hints.length - i) * 0.08); // earlier hints weigh a little more
  }
  for (const n of not || []) {
    const nt = tokens(n);
    if (nt.length && nt.every((x) => hay.includes(x))) s -= 100;
  }
  return s;
}

/* ------------------------------------------------------------ normalizing */

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

export function normBox(b) {
  if (!b) return null;
  if (Array.isArray(b) && b.length >= 4) return mk(b[0], b[1], b[2], b[3]);
  if (typeof b !== 'object') return null;
  const inner = b.rect || b.bbox || b.box || b.bounds || b.boundingBox;
  if (inner && inner !== b) return normBox(inner);
  const x = num(b.x != null ? b.x : b.left);
  const y = num(b.y != null ? b.y : b.top);
  let w = num(b.width != null ? b.width : b.w);
  let h = num(b.height != null ? b.height : b.h);
  if (w == null && num(b.right) != null && x != null) w = num(b.right) - x;
  if (h == null && num(b.bottom) != null && y != null) h = num(b.bottom) - y;
  return mk(x, y, w, h);
  function mk(x, y, w, h) {
    [x, y, w, h] = [num(x), num(y), num(w), num(h)];
    if ([x, y, w, h].some((v) => v == null) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }
}

function normBoxes(src) {
  const out = {};
  if (!src) return out;
  if (Array.isArray(src)) {
    src.forEach((b, i) => {
      const k = (b && (b.name || b.id || b.key || b.label || b.role)) || 'box' + i;
      const nb = normBox(b);
      if (nb) out[k] = Object.assign(nb, b && b.state ? { state: b.state } : {});
    });
  } else if (typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) {
      const nb = normBox(v);
      if (nb) out[k] = Object.assign(nb, v && v.state ? { state: v.state } : {});
    }
  }
  return out;
}

function textOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return textOf(v.text != null ? v.text : v.value != null ? v.value : v.label);
  return null;
}

/**
 * Flatten texts to { key: string }. Nested objects and arrays become dotted keys, e.g.
 * spikeRun.badge, options.4.preview, badges.nightly_sales_etl, notes.0.
 */
function normTexts(src) {
  const out = {};
  const walk = (v, key, depth) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number') { if (key) out[key] = String(v); return; }
    if (depth > 4) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (x && typeof x === 'object' && !Array.isArray(x) && (x.key || x.name || x.id) && (x.text != null || x.value != null)) {
          walk(x.text != null ? x.text : x.value, (key ? key + '.' : '') + (x.key || x.name || x.id), depth + 1);
        } else walk(x, (key ? key + '.' : '') + i, depth + 1);
      });
      return;
    }
    if (typeof v === 'object') {
      if (key && (v.text != null || v.value != null) && Object.keys(v).length <= 3) { walk(v.text != null ? v.text : v.value, key, depth + 1); return; }
      for (const [k, x] of Object.entries(v)) walk(x, key ? key + '.' + k : k, depth + 1);
    }
  };
  walk(src, '', 0);
  return out;
}

function kindOf(s, raw) {
  const explicit = raw.kind || raw.surface || raw.type || raw.target || raw.view;
  const hay = tokens([explicit, s.id, s.file].join(' '));
  if (hay.includes('notification')) return 'notification';
  if (hay.includes('popup')) return 'popup';
  if (hay.includes('monitor')) return 'monitor';
  if (hay.includes('sidepanel') || hay.includes('panel') || (hay.includes('side') && hay.includes('panel'))) return 'panel';
  if (explicit) {
    const e = tokens(explicit);
    if (e.includes('page') || e.includes('workspace') || e.includes('tab')) return 'page';
  }
  const w = s.vw;
  if (w === 360) return 'popup';
  if (w === 420) return 'panel';
  if (w === 380) return 'monitor';
  return 'page';
}

/** Resolve a state's image URL against the captures root and the manifest's own folder. */
function resolveFile(file, dirUrl, rootUrl) {
  if (!file) return null;
  const f = String(file).replace(/\\/g, '/');
  if (/^(https?:)?\//.test(f) && !f.includes('dist/video/captures/')) return f;
  const ix = f.indexOf('dist/video/captures/');
  if (ix >= 0) return rootUrl + f.slice(ix + 'dist/video/captures/'.length);
  if (f.startsWith('captures/')) return rootUrl + f.slice('captures/'.length);
  const dirName = dirUrl.replace(rootUrl, '').replace(/\/$/, '');
  if (dirName && f.startsWith(dirName + '/')) return rootUrl + f;
  return dirUrl + f.replace(/^\.\//, '');
}

export function normalize(raw, { dirUrl, rootUrl, scene, placeholder = false }) {
  const m = {
    scene,
    id: raw.scene || raw.id || raw.name || String(scene),
    placeholder: placeholder || raw.placeholder === true,
    states: [],
    boxes: {},
    texts: normTexts(raw.texts || raw.text || raw.labels || raw.values || raw.numbers),
    notification: null,
    raw,
  };
  const mBoxesRaw = raw.boxes || raw.bboxes || raw.regions || raw.elements || raw.rects;
  const dsf0 = num(raw.deviceScaleFactor || raw.dpr || raw.dsf || raw.scale) || 2;
  const vp0 = raw.viewport;
  let list = raw.states || raw.shots || raw.captures || raw.images || [];
  if (!Array.isArray(list)) list = Object.entries(list).map(([k, v]) => Object.assign({ id: k }, typeof v === 'string' ? { file: v } : v));
  list.forEach((r, i) => {
    if (typeof r === 'string') r = { file: r };
    const id = r.id || r.name || r.state || r.key || (r.file || r.path || '').split('/').pop().replace(/\.\w+$/, '') || 'state' + i;
    const vp = r.viewport || r.size || vp0 || null;
    let vw = null, vh = null;
    if (Array.isArray(vp)) [vw, vh] = vp.map(num);
    else if (vp) [vw, vh] = [num(vp.width != null ? vp.width : vp.w), num(vp.height != null ? vp.height : vp.h)];
    if (vw == null && num(r.width) != null) [vw, vh] = [num(r.width), num(r.height)];
    const s = {
      id: String(id),
      index: i,
      file: r.file || r.path || r.image || r.src || r.png,
      url: null,
      theme: (r.theme || raw.theme || '').toLowerCase() || null,
      vw, vh,
      dsf: num(r.deviceScaleFactor || r.dpr || r.dsf || r.scale) || dsf0,
      description: r.description || r.desc || r.caption || '',
      scrollY: num(r.scrollY) || 0,
      boxes: normBoxes(r.boxes || r.bboxes || r.regions || r.elements || r.rects),
      texts: normTexts(r.texts || r.text || r.labels || r.values || r.numbers),
      raw: r,
    };
    s.url = resolveFile(s.file, dirUrl, rootUrl);
    s.kind = kindOf(s, r);
    if (!s.theme) {
      const t = tokens(s.file + ' ' + s.id);
      s.theme = t.includes('dark') ? 'dark' : t.includes('light') ? 'light' : null;
    }
    // Match on the state id (weighted) plus kind, description and, for real captures, the file
    // name. Placeholder file names are arbitrary, so they are left out.
    const base = m.placeholder ? '' : (s.file || '').split('/').pop().replace(/\.\w+$/, '');
    s.idHay = tokens(s.id);
    s.hay = tokens([s.id, base, s.kind, s.description].join(' '));
    m.states.push(s);
  });
  // Manifest-level boxes: keyed by state id ({stateId: {name: box}}), flat with a state field, or shared.
  if (mBoxesRaw && typeof mBoxesRaw === 'object' && !Array.isArray(mBoxesRaw)) {
    for (const [k, v] of Object.entries(mBoxesRaw)) {
      const st = m.states.find((s) => s.id === k);
      if (st && v && typeof v === 'object' && !normBox(v)) Object.assign(st.boxes, normBoxes(v));
    }
  }
  const flat = normBoxes(mBoxesRaw);
  for (const [k, b] of Object.entries(flat)) {
    const st = b.state && m.states.find((s) => s.id === b.state);
    if (st) st.boxes[k] = b;
    else m.boxes[k] = b;
  }
  // Manifest-level texts keyed by state id.
  for (const s of m.states) {
    for (const [k, v] of Object.entries(m.texts)) {
      if (k.startsWith(s.id + '.')) s.texts[k.slice(s.id.length + 1)] = v;
    }
  }
  const n = raw.notification || raw.notify || (raw.extra && raw.extra.notification);
  if (n && typeof n === 'object') m.notification = { title: textOf(n.title), message: textOf(n.message || n.body), context: textOf(n.context || n.contextMessage) };
  return m;
}

/* ------------------------------------------------------------------ lookup */

/**
 * Find the best matching state. spec: { kind, theme, hints:[...], not:[...], index }.
 * Falls back to the index-th state of the requested kind/theme (warning recorded), then to any state.
 */
export function findState(m, spec, warn) {
  if (!m) return null;
  const { kind, theme, hints = [], not = [], index = 0, strict = false, exclude = [] } = spec;
  let pool = m.states.filter((s) => (!kind || s.kind === kind || (Array.isArray(kind) && kind.includes(s.kind))) && !exclude.includes(s));
  if (theme) {
    const th = pool.filter((s) => s.theme === theme);
    if (th.length) pool = th;
  }
  let best = null, bestScore = 0;
  for (const s of pool) {
    // Negative hints apply to the id only; descriptions are free text and may mention anything.
    const v = scoreHints(s.idHay, hints, not, !strict) * 2 + scoreHints(s.hay, hints, [], !strict);
    if (v > bestScore) { best = s; bestScore = v; }
  }
  if (best) return best;
  if (strict) return null;
  const fb = pool[Math.min(index, pool.length - 1)] || null;
  if (warn && hints.length) warn(`scene ${m.scene}: no state matched [${hints.join(', ')}] (kind ${kind || 'any'}); using ${fb ? fb.id : 'none'}`);
  return fb;
}

/** Find a bounding box on a state (then manifest-level shared boxes) by name hints. */
export function findBox(m, state, hints, not, warn) {
  const cands = [];
  // Boxes must lie within the state's captured viewport (a few px of tolerance).
  const inside = (b) => !state || !state.vw || !state.vh || (b.x >= -4 && b.y >= -4 && b.x + b.w <= state.vw + 4 && b.y + b.h <= state.vh + 4);
  if (state) for (const [k, b] of Object.entries(state.boxes)) {
    if (inside(b)) cands.push([k, b]);
    else if (warn && !state.badBoxWarned) { state.badBoxWarned = true; warn(`scene ${m ? m.scene : '?'}: box ${k} on ${state.id} lies outside the ${state.vw}×${state.vh} viewport; ignored`); }
  }
  if (m) for (const [k, b] of Object.entries(m.boxes)) cands.push([k, b]);
  let best = null, bestScore = 0;
  for (const [k, b] of cands) {
    const v = scoreHints(tokens(k), hints, not, false); // full hint matches only
    if (v > bestScore) { best = b; bestScore = v; }
  }
  if (!best && warn) warn(`scene ${m ? m.scene : '?'}: no box matched [${hints.join(', ')}] on ${state ? state.id : 'n/a'}`);
  return best;
}

/** Find the exact UI text for a caption number by key hints (state first, then manifest). */
export function findText(m, state, hints, not, warn) {
  const cands = [];
  if (state) for (const [k, v] of Object.entries(state.texts)) cands.push([k, v]);
  if (m) for (const [k, v] of Object.entries(m.texts)) cands.push([k, v]);
  let best = null, bestScore = 0;
  for (const [k, v] of cands) {
    if (v == null || v === '') continue;
    const sc = scoreHints(tokens(k), hints, not, false); // full hint matches only
    if (sc > bestScore) { best = v; bestScore = sc; }
  }
  if (best == null && warn) warn(`scene ${m ? m.scene : '?'}: no text matched [${hints.join(', ')}] on ${state ? state.id : 'n/a'}; caption detail omitted`);
  return best;
}

/* ----------------------------------------------------------------- loading */

async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

/**
 * Index entries as [{ name, urls: [manifest urls] }]. Accepts scenes as an array or an object, each
 * with a single manifest path or per-theme manifests ({ themes: { light: { manifest }, ... } }).
 */
function indexEntries(index) {
  const out = [];
  const clean = (rel) => '/captures/' + String(rel).replace(/^\.?\/*/, '').replace(/^dist\/video\/captures\//, '');
  const add = (name, rels) => {
    if (!name) return;
    const urls = rels.filter(Boolean).map(clean);
    if (!urls.length) urls.push(clean(String(name).replace(/\/$/, '') + '/manifest.json'));
    out.push({ name: String(name), urls });
  };
  const fromObj = (name, v) => {
    if (typeof v === 'string') return add(name, [v.endsWith('.json') ? v : null]);
    if (!v || typeof v !== 'object') return add(name, []);
    const rels = [];
    if (v.manifest || v.path || v.file) rels.push(v.manifest || v.path || v.file);
    if (v.themes && typeof v.themes === 'object') for (const t of Object.values(v.themes)) if (t && (t.manifest || t.path)) rels.push(t.manifest || t.path);
    if (Array.isArray(v.manifests)) rels.push(...v.manifests);
    add(name || v.id || v.scene || v.name || v.dir || (rels[0] ? String(rels[0]).split('/')[0] : null), rels);
  };
  const sc = index.scenes || index.manifests || index.entries || index;
  if (Array.isArray(sc)) {
    for (const e of sc) {
      if (typeof e === 'string') add(e.split('/')[0], [e.endsWith('.json') ? e : null]);
      else fromObj(e && (e.id || e.scene || e.name || e.dir || e.folder), e);
    }
  } else if (sc && typeof sc === 'object') {
    for (const [k, v] of Object.entries(sc)) fromObj(k, v);
  }
  return out;
}

/** Pick the capture folder for storyboard scene n: leading number first, then keywords. */
function matchEntry(entries, n) {
  const byNum = entries.find((e) => {
    const mm = /(\d+)/.exec(e.name);
    return mm && Number(mm[1]) === n;
  });
  if (byNum) return byNum;
  const def = SCENES[n];
  let best = null, bestScore = 0;
  for (const e of entries) {
    const v = scoreHints(tokens(e.name), def.words, []);
    if (v > bestScore) { best = e; bestScore = v; }
  }
  return best;
}

export async function loadAll() {
  const result = { scenes: {}, placeholders: [], warnings: [], sources: {}, indexFound: false };
  const warn = (w) => result.warnings.push(w);
  const index = await fetchJson('/captures/index.json');
  let entries = [];
  if (index) {
    result.indexFound = true;
    entries = indexEntries(index);
  }
  if (!entries.length) {
    const scan = await fetchJson('/__scan');
    if (Array.isArray(scan)) {
      const by = new Map();
      for (const p of scan) {
        const k = p.split('/')[0];
        if (!by.has(k)) by.set(k, []);
        by.get(k).push('/captures/' + p);
      }
      entries = [...by].map(([name, urls]) => ({ name, urls }));
    }
  }
  const ph = (await fetchJson('placeholder/manifests.json')) || {};
  for (const n of Object.keys(SCENES).map(Number)) {
    const entry = matchEntry(entries, n);
    let m = null;
    if (entry) {
      const parts = [];
      for (const url of entry.urls) {
        const raw = await fetchJson(url);
        if (!raw) { warn(`scene ${n}: could not read ${url}`); continue; }
        const part = normalize(raw, { dirUrl: url.replace(/[^/]*$/, ''), rootUrl: '/captures/', scene: n, placeholder: !!(index && index.placeholder === true) });
        if (part.states.length) parts.push(part);
        else warn(`scene ${n}: ${url} has no states`);
      }
      if (parts.length) {
        m = parts[0];
        for (const p of parts.slice(1)) {
          m.states.push(...p.states);
          Object.assign(m.boxes, p.boxes);
          for (const [k, v] of Object.entries(p.texts)) if (!(k in m.texts)) m.texts[k] = v;
          m.notification = m.notification || p.notification;
          m.placeholder = m.placeholder || p.placeholder;
        }
        m.states.forEach((st, i) => { st.index = i; });
        result.sources[n] = entry.urls.join(' + ');
      }
    }
    if (!m) {
      const raw = ph[String(n)];
      m = raw ? normalize(raw, { dirUrl: '/ph-img/', rootUrl: '/ph-img/', scene: n, placeholder: true }) : { scene: n, placeholder: true, states: [], boxes: {}, texts: {} };
      result.sources[n] = 'placeholder';
    }
    result.scenes[n] = m;
  }
  /** Replace a scene with its placeholder (used when a real capture image fails to load). */
  result.fallback = (n) => {
    const raw = ph[String(n)];
    const m = raw ? normalize(raw, { dirUrl: '/ph-img/', rootUrl: '/ph-img/', scene: n, placeholder: true }) : { scene: n, placeholder: true, states: [], boxes: {}, texts: {} };
    result.scenes[n] = m;
    result.sources[n] = 'placeholder (fallback)';
    return m;
  };
  return result;
}

/** Load every image of a manifest; any failure marks the manifest as broken. */
export async function loadImages(m) {
  const failures = [];
  await Promise.all(m.states.map(async (s) => {
    if (!s.url) { failures.push(s.id + ' (no file)'); return; }
    const img = new Image();
    img.decoding = 'sync';
    img.src = s.url;
    try {
      await img.decode();
      s.img = img;
      s.nw = img.naturalWidth;
      s.nh = img.naturalHeight;
      if (!s.vw) s.vw = s.nw / s.dsf;
      if (!s.vh) s.vh = s.nh / s.dsf;
      // A captured viewport is never taller than its image; scroll offsets stay within the image.
      s.vh = Math.min(s.vh, s.nh / s.dsf);
    } catch (_) {
      failures.push(s.id + ' (' + s.url + ')');
    }
  }));
  return failures;
}
