/**
 * Verknüpfter Projektordner (Windows-Desktop, Chrome/Edge — File System Access API).
 * Der Ordner-Handle bleibt in IndexedDB; Öffnen / Sichern starten dort.
 * Gleiches Muster wie Geräte Laufzettel (Einstellungen → Ordner wählen / lösen).
 */
const DB_NAME = 'bauteile-suchen-settings';
const DB_STORE = 'kv';
const FOLDER_KEY = 'projectFolder';

export function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function';
}

/** Windows-PC (nicht iPad/iPhone/Mac/Android). */
export function isWindowsDesktop() {
  const uad = navigator.userAgentData;
  if (uad && typeof uad.platform === 'string' && uad.platform) {
    return /^windows$/i.test(uad.platform) && !uad.mobile;
  }
  const ua = navigator.userAgent || '';
  return /Windows NT/i.test(ua) && !/Mobile|Android|iPhone|iPad/i.test(ua);
}

/** Einstellungen-Button nur am Windows-PC mit Ordner-API (Chrome/Edge). */
export function folderSettingsAvailable() {
  return isWindowsDesktop() && supportsDirectoryPicker();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbOp(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** @returns {Promise<FileSystemDirectoryHandle|null>} */
export async function getLinkedFolder() {
  if (!supportsDirectoryPicker()) return null;
  try {
    const h = await dbOp('readonly', (s) => s.get(FOLDER_KEY));
    return h && h.kind === 'directory' ? h : null;
  } catch (e) {
    console.warn('Ordnerverknüpfung nicht lesbar', e);
    return null;
  }
}

/** Ordner wählen (User-Geste) und dauerhaft speichern. AbortError = abgebrochen. */
export async function pickLinkedFolder() {
  const current = await getLinkedFolder();
  const opts = { id: 'bauteile-suchen-projekte', mode: 'readwrite' };
  let handle;
  try {
    handle = await window.showDirectoryPicker(current ? { ...opts, startIn: current } : { ...opts, startIn: 'documents' });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    handle = await window.showDirectoryPicker(opts); // stale startIn → ohne
  }
  await dbOp('readwrite', (s) => s.put(handle, FOLDER_KEY));
  return handle;
}

export async function clearLinkedFolder() {
  try {
    await dbOp('readwrite', (s) => s.delete(FOLDER_KEY));
  } catch (e) {
    console.warn('Ordnerverknüpfung nicht lösbar', e);
  }
}
