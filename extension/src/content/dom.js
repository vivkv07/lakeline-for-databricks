/*
 * Content-script DOM utilities: safe element construction (text only, never innerHTML) and a
 * bounded scheduler so continuous DOM mutation can't postpone work forever.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  /** h('div', {class:'x', onclick: fn, 'aria-label': 'y'}, [children|text]) */
  function h(doc, tag, attrs, children) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    }
    return el;
  }

  /**
   * Bounded throttle: run `fn` at most once per `minInterval`, and never later than `maxWait`
   * after the first unserved request, even under a continuous stream of requests.
   */
  function createScheduler(fn, { minInterval = 200, maxWait = 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
    let timer = null;
    let firstRequest = null;
    let lastRun = 0;
    let running = false;
    let again = false;

    async function fire() {
      timer = null;
      firstRequest = null;
      if (running) {
        again = true;
        return;
      }
      running = true;
      lastRun = now();
      try {
        await fn();
      } finally {
        running = false;
        if (again) {
          again = false;
          request();
        }
      }
    }

    function request() {
      const t = now();
      if (firstRequest === null) firstRequest = t;
      const sinceRun = t - lastRun;
      const dueByInterval = Math.max(0, minInterval - sinceRun);
      const dueByMaxWait = Math.max(0, maxWait - (t - firstRequest));
      const delay = Math.min(Math.max(dueByInterval, 50), dueByMaxWait);
      if (timer !== null) clearTimer(timer);
      timer = setTimer(fire, delay);
    }

    function cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      firstRequest = null;
    }

    return { request, cancel, flush: fire };
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const win = el.ownerDocument.defaultView;
    const style = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  }

  const api = Object.freeze({ h, createScheduler, isVisible });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).dom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
