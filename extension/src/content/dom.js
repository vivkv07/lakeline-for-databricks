/*
 * Content-script DOM utilities: safe element construction (text only, never innerHTML), an
 * ancestor-aware visibility check, ownership tests for mutation filtering, and a bounded
 * scheduler so continuous DOM mutation can't postpone work forever.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const OWN = '[data-dcc]';

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
   * Bounded throttle. `fn` runs after a short quiet period (`quiet`), at most once per
   * `minInterval`, and never later than `maxWait` after the first unserved request, even under
   * a continuous stream of requests. Runs never overlap: a request that arrives while `fn` is
   * running schedules exactly one follow-up run. A throwing or rejecting `fn` is reported to
   * `onError` and never stops the scheduler.
   *
   * Timers and the clock are injectable for deterministic tests.
   */
  function createScheduler(fn, opts = {}) {
    const minInterval = opts.minInterval === undefined ? 200 : opts.minInterval;
    const maxWait = opts.maxWait === undefined ? 1000 : opts.maxWait;
    const quiet = opts.quiet === undefined ? 50 : opts.quiet;
    const setTimer = opts.setTimer || ((f, ms) => setTimeout(f, ms));
    const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
    const now = opts.now || (() => Date.now());
    const onError = opts.onError || null;

    let timer = null;
    let firstRequest = null; // time of the oldest request not yet served by a run
    let lastRun = -Infinity;
    let running = false;
    let again = false;
    let stopped = false;
    let runs = 0;

    function arm() {
      const t = now();
      if (firstRequest === null) firstRequest = t;
      const dueByInterval = Math.max(0, minInterval - (t - lastRun));
      const dueByMaxWait = Math.max(0, maxWait - (t - firstRequest));
      const delay = Math.min(Math.max(dueByInterval, quiet), dueByMaxWait);
      if (timer !== null) clearTimer(timer);
      timer = setTimer(onTimer, delay);
    }

    function onTimer() {
      timer = null;
      run();
    }

    async function run() {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      firstRequest = null;
      running = true;
      again = false;
      lastRun = now();
      runs++;
      try {
        await fn();
      } catch (e) {
        if (onError) {
          try {
            onError(e);
          } catch (_) {
            /* never let the reporter break scheduling */
          }
        }
      } finally {
        running = false;
        if (again && !stopped) {
          again = false;
          arm();
        }
      }
    }

    function request() {
      if (stopped) return;
      if (running) {
        // Served by one follow-up run when the current run ends; the maxWait clock starts now.
        if (firstRequest === null) firstRequest = now();
        again = true;
        return;
      }
      arm();
    }

    function cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      firstRequest = null;
      again = false;
    }

    function stop() {
      stopped = true;
      cancel();
    }

    return {
      request,
      cancel,
      stop,
      /** Run now (cancelling any pending timer); returns the run's promise. */
      flush: run,
      stats: () => ({ runs, running, pending: timer !== null || again, stopped }),
    };
  }

  /**
   * Visible = connected, rendered (no `display:none` on it or any ancestor, no `hidden`
   * ancestor) and not `visibility:hidden`. Uses the native, layout-aware checkVisibility() where
   * available; elements with `display: contents` have no box of their own, so they fall back to
   * the ancestor walk.
   */
  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    const win = el.ownerDocument && el.ownerDocument.defaultView;
    if (!win || typeof win.getComputedStyle !== 'function') return true;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true;
        if (win.getComputedStyle(el).display !== 'contents') return false;
      } catch (_) {
        /* fall through to the portable check */
      }
    }
    const own = win.getComputedStyle(el);
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const st = n === el ? own : win.getComputedStyle(n);
      if (st.display === 'none') return false;
    }
    return true;
  }

  /** True for an element we created (marked `data-dcc`) or anything inside one. */
  function isOwnNode(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(el && el.closest && el.closest(OWN));
  }

  /**
   * True when a MutationRecord was caused only by our own nodes: a change inside a `data-dcc`
   * subtree, or a childList change whose added and removed nodes are all `data-dcc` elements.
   * Used so the extension's own writes never feed its observer.
   */
  function isOwnMutation(m) {
    if (!m) return true;
    if (isOwnNode(m.target)) return true;
    if (m.type !== 'childList') return false;
    if (!m.addedNodes.length && !m.removedNodes.length) return true;
    for (const n of m.addedNodes) if (!(n.nodeType === 1 && n.hasAttribute('data-dcc'))) return false;
    for (const n of m.removedNodes) if (!(n.nodeType === 1 && n.hasAttribute('data-dcc'))) return false;
    return true;
  }

  const api = Object.freeze({ OWN, h, createScheduler, isVisible, isOwnNode, isOwnMutation });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).dom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
