import { state, action } from "../fried.js";

// Tiny, zero-dependency IndexedDB wrapper for background persistence
const idb = {
  db: null,
  init(dbName, stores) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        stores.forEach(s => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
        });
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  },
  write(store, items) {
    if (!this.db) return;
    const tx = this.db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    items.forEach(i => os.put(i));
  },
  remove(store, id) {
    if (!this.db) return;
    const tx = this.db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
  },
  readAll(store) {
    return new Promise((resolve) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
    });
  },
  clear(store) {
    if (!this.db) return;
    const tx = this.db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
  }
};

/**
 * Creates a POES fast, memory-first reactive database.
 * Reads are synchronous O(1). Writes update memory instantly, trigger UI render, 
 * and flush to native IndexedDB asynchronously in the background.
 */
export function createDatabase(name, collections = []) {
  const dbState = {};
  let readyPromise = null;

  const init = async () => {
    if (!readyPromise) {
      readyPromise = idb.init(name, collections).then(async () => {
        for (const col of collections) {
          const data = await idb.readAll(col);
          dbState[col].value = data; // Populates state and triggers UI render automatically
        }
      });
    }
    return readyPromise;
  };

  collections.forEach(col => {
    const s = state([]);
    dbState[col] = {
      get value() { return s.value; },
      set value(val) { s.value = val; }, // For manual overwrites if needed
      
      insert: action(`db.${col}.insert`, (item) => {
        if (!item.id) item.id = Math.random().toString(36).slice(2);
        s.value = [...s.value, item];
        idb.write(col, [item]); // Async background flush
        return item;
      }),
      
      update: action(`db.${col}.update`, (id, changes) => {
        let updatedItem;
        s.value = s.value.map(item => {
          if (item.id === id) {
            updatedItem = { ...item, ...changes };
            return updatedItem;
          }
          return item;
        });
        if (updatedItem) idb.write(col, [updatedItem]);
      }),
      
      remove: action(`db.${col}.remove`, (id) => {
        s.value = s.value.filter(item => item.id !== id);
        idb.remove(col, id);
      }),
      
      bulkInsert: action(`db.${col}.bulkInsert`, (items) => {
        items.forEach(i => { if (!i.id) i.id = Math.random().toString(36).slice(2); });
        s.value = [...s.value, ...items];
        idb.write(col, items);
      }),

      clear: action(`db.${col}.clear`, () => {
        s.value = [];
        idb.clear(col);
      })
    };
  });

  return {
    init,
    collections: dbState
  };
}
