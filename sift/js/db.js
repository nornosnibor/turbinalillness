// Tiny promise wrapper around IndexedDB. Everything stays in this browser.
//
// Stores:
//   photos    – metadata + Jev answers (small; loaded into memory at start)
//   thumbs    – small JPEG previews, keyed by photo id
//   originals – the untouched files you imported, keyed by photo id
//   albums    – manual albums
//   kv        – settings, custom tags, usage counters

const DB_NAME = 'sift';
const DB_VERSION = 1;
const STORES = ['photos', 'thumbs', 'originals', 'albums', 'kv'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, name === 'kv' || name === 'thumbs' || name === 'originals' ? undefined : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}


async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  putMany: (store, values) => tx(store, 'readwrite', (s) => { for (const v of values) s.put(v); }),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  delMany: (store, keys) => tx(store, 'readwrite', (s) => { for (const k of keys) s.delete(k); }),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  async estimate() {
    if (!navigator.storage?.estimate) return null;
    return navigator.storage.estimate();
  },
  async persist() {
    try { return await navigator.storage?.persist?.(); } catch { return false; }
  },
};

