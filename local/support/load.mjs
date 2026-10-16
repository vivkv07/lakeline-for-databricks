// Test helper: load the extension's shared classic/CommonJS modules from ESM tests.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const load = (rel) => require('../../extension/src/' + rel);

/** In-memory stand-in for chrome.storage.{local,session}. */
export function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      if (key == null) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
    async remove(key) { for (const k of [].concat(key)) delete data[k]; },
  };
}
