// db.js — real IndexedDB persistence layer. No backend, no localStorage.
// Every namespace's data lives in the browser's own IndexedDB instance.

const DB_NAME = 'jobber';
const DB_VERSION = 2;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('identities')) {
        const s = db.createObjectStore('identities', { keyPath: 'identityId' });
        s.createIndex('namespace', 'namespace', { unique: false });
      }
      if (!db.objectStoreNames.contains('profiles')) {
        db.createObjectStore('profiles', { keyPath: 'identityId' });
      }
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'messageId' });
        s.createIndex('room', 'room', { unique: false });
      }
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'conversationId' });
      }
      if (!db.objectStoreNames.contains('research_projects')) {
        db.createObjectStore('research_projects', { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains('research_artifacts')) {
        const s = db.createObjectStore('research_artifacts', { keyPath: 'artifactId' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('blocklist')) {
        db.createObjectStore('blocklist', { keyPath: 'compoundId' });
      }
      if (!db.objectStoreNames.contains('credibility_events')) {
        // See credibility.js. `rowId` (not the DAG event's own content-hash
        // `id`) is the primary key — two different subjects could, in
        // principle, produce the same content-hash id from an identical
        // payload, so the row key embeds subjectKey too.
        const s = db.createObjectStore('credibility_events', { keyPath: 'rowId' });
        s.createIndex('subjectKey', 'subjectKey', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function put(storeName, value) {
  const s = await store(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const r = s.put(value);
    r.onsuccess = () => resolve(value);
    r.onerror = () => reject(r.error);
  });
}

export async function get(storeName, key) {
  const s = await store(storeName);
  return new Promise((resolve, reject) => {
    const r = s.get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export async function getAll(storeName, indexName, indexValue) {
  const s = await store(storeName);
  const source = indexName ? s.index(indexName) : s;
  return new Promise((resolve, reject) => {
    const r = indexName !== undefined ? source.getAll(indexValue) : source.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

export async function del(storeName, key) {
  const s = await store(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const r = s.delete(key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function count(storeName) {
  const s = await store(storeName);
  return new Promise((resolve, reject) => {
    const r = s.count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Rough local footprint estimate, shown in the status bar.
export async function estimateUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage } = await navigator.storage.estimate();
    return usage || 0;
  }
  return 0;
}
