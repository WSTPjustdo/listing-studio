const DATABASE = "listing-studio-browser-drafts";
const STORE = "guided";
const VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本机草稿存储。"));
  });
}

export async function readGuidedDraft<T>(key: string): Promise<T | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error || new Error("无法读取本机草稿。"));
    });
  } finally {
    database.close();
  }
}

export async function writeGuidedDraft<T>(key: string, value: T): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("无法保存本机草稿。"));
      transaction.onabort = () => reject(transaction.error || new Error("本机草稿保存已中断。"));
    });
  } finally {
    database.close();
  }
}

export async function removeGuidedDraft(key: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("无法清除本机草稿。"));
      transaction.onabort = () => reject(transaction.error || new Error("本机草稿清除已中断。"));
    });
  } finally {
    database.close();
  }
}
