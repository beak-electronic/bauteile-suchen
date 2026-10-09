/**
 * Geschützte Projekt-ZIPs (WebCrypto only).
 *
 * Outer file stays a normal ZIP:
 *   bauteile-suchen.json  — unencrypted manifest (format, KDF params, salt, IVs, key check; NO part data)
 *   projekt.enc           — AES-256-GCM ciphertext of the complete inner project ZIP
 *                           (projekt.json, Plan PDF/Bild, Pick&Place-Varianten, Stücklisten …)
 *
 * Keys:
 *   master   = PBKDF2-SHA256(code, app-wide salt, 600k) → 256 bit → imported as NON-extractable HKDF key.
 *              Only this CryptoKey is kept on the device (IndexedDB). The code itself is never stored.
 *   file key = HKDF-SHA256(master, random 16-byte salt per file, info) → AES-256-GCM (non-extractable).
 *   Each file gets a fresh salt; payload and key check each use their own random 12-byte IV.
 */

export const MANIFEST_NAME = 'bauteile-suchen.json';
export const PAYLOAD_NAME = 'projekt.enc';
export const CODE_MIN_LENGTH = 6;
export const CODE_MAX_LENGTH = 10;
/** @deprecated use CODE_MAX_LENGTH — kept for any external readers */
export const CODE_LENGTH = CODE_MAX_LENGTH;

const FORMAT = 'bauteile-suchen-encrypted';
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 600000;
/** Fixed app-wide PBKDF2 salt (public by design; per-file randomness comes from the HKDF salt). */
const MASTER_SALT_LABEL = 'bauteile-suchen/master-key/v1';
const HKDF_INFO = 'bauteile-suchen/file-key/v1';
const CHECK_PLAINTEXT = 'bauteile-suchen key check v1';

const DB_NAME = 'bauteile-suchen-keys';
const DB_STORE = 'keys';
const DB_KEY = 'master-v1';

const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(String(str || ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function rand(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Letters (incl. äöüÄÖÜß) + digits, 6–10 chars, case-sensitive. NFC-normalized. */
export function isValidCode(code) {
  const s = String(code || '').normalize('NFC');
  return /^[A-Za-z0-9äöüÄÖÜß]{6,10}$/u.test(s);
}

/** Strip illegal chars and clamp length (NFC). */
export function sanitizeCodeInput(raw) {
  return String(raw || '')
    .normalize('NFC')
    .replace(/[^A-Za-z0-9äöüÄÖÜß]/gu, '')
    .slice(0, CODE_MAX_LENGTH);
}

// ---------------------------------------------------------------- IndexedDB
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

/** @returns {Promise<CryptoKey|null>} stored non-extractable master key (or null) */
export async function getStoredMasterKey() {
  try {
    const k = await dbOp('readonly', (s) => s.get(DB_KEY));
    return k instanceof CryptoKey ? k : null;
  } catch (e) {
    console.warn('Schlüsselspeicher nicht lesbar', e);
    return null;
  }
}
export async function storeMasterKey(key) {
  await dbOp('readwrite', (s) => s.put(key, DB_KEY));
}
export async function forgetMasterKey() {
  await dbOp('readwrite', (s) => s.delete(DB_KEY));
}

// ---------------------------------------------------------------- KDF
/** Code → non-extractable HKDF master key. Raw bits only live briefly in memory. */
export async function deriveMasterKey(code) {
  if (!isValidCode(code)) throw new Error('Ungültiger Code');
  const normalized = String(code).normalize('NFC');
  const pw = await crypto.subtle.importKey('raw', enc.encode(normalized), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(MASTER_SALT_LABEL), iterations: PBKDF2_ITERATIONS },
    pw,
    256,
  );
  const master = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  new Uint8Array(bits).fill(0);
  return master;
}

function fileKey(master, salt) {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(HKDF_INFO) },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------- ZIP format
/** @param {import('jszip')} zip loaded outer zip */
export async function readEncryptedManifest(zip) {
  const f = zip.file(MANIFEST_NAME);
  if (!f) return null;
  let m;
  try {
    m = JSON.parse(await f.async('string'));
  } catch {
    return null;
  }
  if (!m || m.format !== FORMAT || m.encrypted !== true) return null;
  if (m.formatVersion > FORMAT_VERSION) throw new Error('Projektdatei stammt aus einer neueren App-Version');
  return m;
}

/** true if `master` opens this file (checks the encrypted verifier only — fast). */
export async function verifyMasterKey(master, manifest) {
  if (!master || !manifest) return false;
  try {
    const key = await fileKey(master, unb64(manifest.kdf.salt));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(manifest.check.iv) },
      key,
      unb64(manifest.check.data),
    );
    return new TextDecoder().decode(pt) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * Wrap the plain inner project ZIP into an encrypted outer ZIP.
 * @param {Blob} innerZip @param {CryptoKey} master @returns {Promise<Blob>}
 */
export async function encryptProjectZip(innerZip, master) {
  const JSZip = globalThis.JSZip;
  const salt = rand(16);
  const key = await fileKey(master, salt);
  const checkIv = rand(12);
  const payloadIv = rand(12);
  const check = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: checkIv }, key, enc.encode(CHECK_PLAINTEXT));
  const plain = new Uint8Array(await innerZip.arrayBuffer());
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: payloadIv, additionalData: enc.encode(FORMAT + ':' + FORMAT_VERSION) },
    key,
    plain,
  );
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    app: 'Bauteile Suchen',
    encrypted: true,
    cipher: 'AES-256-GCM',
    kdf: {
      master: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: 'app-wide:v1' },
      file: { name: 'HKDF-SHA256', info: HKDF_INFO },
      salt: b64(salt),
    },
    check: { iv: b64(checkIv), data: b64(check) },
    payload: { file: PAYLOAD_NAME, iv: b64(payloadIv), aad: FORMAT + ':' + FORMAT_VERSION },
    files: [PAYLOAD_NAME],
  };
  const zip = new JSZip();
  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  // Ciphertext does not compress — STORE keeps saving fast on iPad.
  zip.file(PAYLOAD_NAME, new Uint8Array(cipher), { compression: 'STORE' });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
}

/** @returns {Promise<Uint8Array>} decrypted inner ZIP bytes */
export async function decryptProjectZip(zip, manifest, master) {
  const f = zip.file(manifest.payload?.file || PAYLOAD_NAME);
  if (!f) throw new Error('Verschlüsselte Projektdaten fehlen in der ZIP');
  const key = await fileKey(master, unb64(manifest.kdf.salt));
  const data = await f.async('uint8array');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(manifest.payload.iv), additionalData: enc.encode(manifest.payload.aad || '') },
    key,
    data,
  );
  return new Uint8Array(pt);
}
