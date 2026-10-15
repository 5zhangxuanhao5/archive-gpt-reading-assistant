import {nativeRequest} from './native-transport.js';
import {documentText, migrateNote, uniqueTitle} from './core.js';

let connection;
export async function db() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('yueji-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}
async function localGet(key) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('data', 'readonly').objectStore('data').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function localPut(key, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('data', 'readwrite');
    tx.objectStore('data').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('本地保存中断'));
  });
}

async function localEntries() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('data', 'readonly'), entries = [];
    const request = tx.objectStore('data').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (sharedKey(cursor.key)) entries.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    tx.oncomplete = () => resolve(entries); tx.onerror = () => reject(tx.error);
  });
}
async function removeLocal(keys) {
  if (!keys.length) return;
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('data', 'readwrite');
    for (const key of keys) tx.objectStore('data').delete(key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('旧缓存迁移未完成'));
  });
}
const sharedKey = key => typeof key === 'string' && (key === 'state' || key.startsWith('asset:') || key.startsWith('outline:') || key.startsWith('reading:'));
const CHUNK = 256 * 1024;
const MAX_CACHE_VALUE = 256 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeStatus = null, lastProbe = 0, established = false, metadataLoaded = false;
let metadataPending = null, statusPending = null, lastProbeError = null;
let localNativeMode, localRootPresent = false;
let lockToken = null, transactionDepth = 0, migrated = false, modeNeedsProbe = false;
let acquiring = null, migrating = null;
const activeOperations = new Set();
let transactionQueue = Promise.resolve();

function unavailable(cause) {
  const error = new Error('共享笔记组件暂时无法连接，请重试；现有笔记仍保存在电脑的共享笔记库中。');
  error.name = 'SharedStoreUnavailableError'; error.cause = cause; return error;
}
async function probe(force = false) {
  if (!metadataLoaded) {
    if (!metadataPending) metadataPending = Promise.all([localGet('sharedCache'), localGet('nativeMode'), localGet('root')]).then(([shared, mode, root]) => {
      established = !!shared; localNativeMode = mode; localRootPresent = !!root; metadataLoaded = true;
    }).finally(() => { metadataPending = null; });
    await metadataPending;
  }
  // A deliberately selected browser file handle remains a supported fallback.
  // This flag belongs to this browser; it must never disable the other browser.
  if (localNativeMode === false && localRootPresent) {
    activeStatus = null; return null;
  }
  // A whole note operation already refreshed STATUS before locking. Its file
  // and cache helpers can reuse that snapshot instead of probing for every key.
  if (!force && transactionDepth && activeStatus) return activeStatus;
  if (!force && lastProbe && Date.now() - lastProbe < 500) {
    if (lastProbeError && established) throw unavailable(lastProbeError);
    return activeStatus;
  }
  if (statusPending) return statusPending;
  statusPending = readStatus();
  try { return await statusPending; } finally { statusPending = null; }
}
async function readStatus() {
  try {
    const status = await nativeRequest({op: 'STATUS'});
    lastProbe = Date.now(); lastProbeError = null;
    // The cache remains usable when its folder is moved or its configuration
    // needs repair. Only a missing host can make the shared cache unavailable.
    if (status.cacheProtocol === 1 && (status.connected || established || status.cacheRevision > 0)) { activeStatus = status; return status; }
    activeStatus = null;
    if (established) throw unavailable();
    return null;
  } catch (error) {
    activeStatus = null; lastProbe = Date.now(); lastProbeError = error;
    if (established) throw error.name === 'SharedStoreUnavailableError' ? error : unavailable(error);
    return null;
  }
}

export async function sharedStatus() { return probe(); }

// Poll only a revision, without locking, copying notes or reading image data.
// Older hosts expose the global revision; newer ones expose the notes key's
// revision so an unrelated history-cache update cannot trigger a notes refresh.
export async function cacheRevision() {
  const status = await probe(true);
  if (status) return {shared: true, revision: status.stateRevision ?? status.cacheRevision ?? 0, connected: !!status.connected};
  return {shared: false, revision: (await localGet('state'))?.version || 0};
}

function base64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(''));
}
function serialize(value) {
  return new TextEncoder().encode(JSON.stringify(value, (key, next) => {
    if (next instanceof Uint8Array) return {$gptReaderBytes: base64(next)};
    if (next instanceof ArrayBuffer) return {$gptReaderBytes: base64(new Uint8Array(next))};
    return next;
  }));
}
function deserialize(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes), (key, value) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.$gptReaderBytes === 'string') {
      return Uint8Array.from(atob(value.$gptReaderBytes), char => char.charCodeAt(0));
    }
    return value;
  });
}
async function cacheGet(key) {
  let snapshot, offset = 0, bytes;
  try {
    do {
      const result = await nativeRequest({op: 'CACHE_GET', key, offset, ...(snapshot ? {snapshot} : {})});
      if (!result.found) return undefined;
      snapshot = result.snapshot;
      if (!bytes) {
        if (!Number.isInteger(result.size) || result.size < 0 || result.size > MAX_CACHE_VALUE) throw new Error('共享缓存大小无效');
        bytes = new Uint8Array(result.size);
      }
      const part = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
      if (result.next !== offset + part.length || result.next > bytes.length || (part.length === 0 && offset < bytes.length)) throw new Error('共享缓存读取不完整');
      bytes.set(part, offset); offset = result.next;
    } while (offset < bytes.length);
    return deserialize(bytes);
  } finally {
    if (snapshot) await nativeRequest({op: 'CACHE_READ_RELEASE', snapshot}).catch(() => {});
  }
}
async function cachePut(key, value) {
  const bytes = serialize(value);
  if (bytes.length > MAX_CACHE_VALUE) throw new Error('共享缓存内容过大，单项最多 256 MB');
  if (bytes.length <= CHUNK) return nativeRequest({op: 'CACHE_PUT', key, data: base64(bytes)});
  let upload;
  try {
    upload = (await nativeRequest({op: 'CACHE_WRITE_BEGIN', key, size: bytes.length})).upload;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK));
      const result = await nativeRequest({op: 'CACHE_WRITE_CHUNK', upload, offset, data: base64(part)});
      if (result.next !== offset + part.length) throw new Error('共享缓存写入不完整');
    }
    const result = await nativeRequest({op: 'CACHE_WRITE_COMMIT', upload}); upload = null; return result;
  } finally {
    if (upload) await nativeRequest({op: 'CACHE_WRITE_ABORT', upload}).catch(() => {});
  }
}
async function acquire() {
  if (lockToken) return;
  if (acquiring) return acquiring;
  acquiring = acquireLock();
  try { await acquiring; } finally { acquiring = null; }
}
async function acquireLock() {
  const token = crypto.randomUUID(), start = Date.now();
  do {
    const result = await nativeRequest({op: 'CACHE_LOCK', token});
    if (result.acquired) { lockToken = token; return; }
    if (Date.now() - start > 30000) {
      const error = new Error('另一个浏览器正在保存笔记，请稍后重试。'); error.name = 'SharedStoreBusyError'; throw error;
    }
    await sleep(80 + Math.random() * 80);
  } while (true);
}
async function release() {
  const token = lockToken; lockToken = null;
  if (token) await nativeRequest({op: 'CACHE_UNLOCK', token}).catch(() => {});
}
function comparable(note) {
  const copy = migrateNote(structuredClone(note));
  return JSON.stringify([copy.folder || '', copy.title || '', documentText(copy)]);
}
function contentOnly(note) {
  const copy = migrateNote(structuredClone(note));
  return JSON.stringify([copy.folder || '', documentText(copy)]);
}
function mergeState(existing, imported) {
  if (!imported) return existing;
  if (!existing) return structuredClone(imported);
  const result = structuredClone(existing);
  result.notes ||= []; result.folders ||= [];
  const ids = new Map(result.notes.map(note => [note.id, note]));
  for (const original of imported.notes || []) {
    const note = structuredClone(original), previous = ids.get(note.id);
    if (!previous) { result.notes.push(note); ids.set(note.id, note); continue; }
    if (comparable(previous) === comparable(note)) continue;
    if (result.notes.some(candidate => candidate.cacheImportOf === note.id && contentOnly(candidate) === contentOnly(note))) continue;
    // Never let an old private cache overwrite edits already made in the other
    // browser. Preserve genuinely different content as a separate editable note.
    note.cacheImportOf = note.id; note.id = crypto.randomUUID();
    note.title = uniqueTitle(result.notes, note.folder || '', String(note.title || '笔记').slice(0, 75) + '（浏览器导入）');
    delete note.diskPath; delete note.diskText; delete note.retired;
    delete note.lastClient; delete note.lastSequence;
    note.rev = 0; result.notes.push(note); ids.set(note.id, note);
  }
  result.folders = [...new Set([...result.folders, ...(imported.folders || [])])];
  result.version = Math.max(existing.version || 0, imported.version || 0) + 1;
  return result;
}
function equalAsset(a, b) {
  if (a.mime !== b.mime || !(a.bytes instanceof Uint8Array) || !(b.bytes instanceof Uint8Array) || a.bytes.length !== b.bytes.length) return false;
  return a.bytes.every((byte, index) => byte === b.bytes[index]);
}
async function migrateLocal() {
  if (migrated) return;
  if (migrating) return migrating;
  migrating = performMigration();
  try { await migrating; } finally { migrating = null; }
}
async function performMigration() {
  const entries = await localEntries(), remapped = new Map();
  // Images are migrated first so notes never point to a missing migrated asset.
  for (const [key, original] of entries.filter(([key]) => key.startsWith('asset:'))) {
    const existing = await cacheGet(key);
    if (!existing) { await cachePut(key, original); continue; }
    if (equalAsset(existing, original)) continue;
    const imageId = crypto.randomUUID(), asset = structuredClone(original);
    const oldImageId = asset.imageId; asset.imageId = imageId;
    asset.src = String(asset.src).replace(oldImageId, imageId);
    remapped.set(oldImageId, {imageId, src: asset.src, oldSrc: original.src});
    await cachePut('asset:' + imageId, asset);
  }
  const localState = entries.find(([key]) => key === 'state')?.[1];
  if (localState) {
    const imported = structuredClone(localState);
    for (const note of imported.notes || []) {
      for (const block of note.blocks || []) {
        const replacement = remapped.get(block.imageId);
        if (replacement) { block.imageId = replacement.imageId; block.src = replacement.src; }
      }
      for (const replacement of remapped.values()) if (typeof note.text === 'string') note.text = note.text.split(replacement.oldSrc).join(replacement.src);
    }
    await cachePut('state', mergeState(await cacheGet('state'), imported));
  }
  for (const [key, value] of entries.filter(([key]) => key.startsWith('outline:'))) {
    const existing = await cacheGet(key);
    const complete = item => !!item?.complete;
    if (!existing || (complete(value) && !complete(existing)) || (complete(value) === complete(existing) && (value.updated || 0) > (existing.updated || 0))) await cachePut(key, value);
  }
  for (const [key,value] of entries.filter(([key])=>key.startsWith('reading:'))) {
    const existing=await cacheGet(key);
    if(!existing || (value?.at || 0)>(existing.at || 0))await cachePut(key,value);
  }
  // Set the offline guard before removing old copies. A failed migration leaves
  // the original keys intact for retry; no unrelated preferences or handles go.
  await localPut('sharedCache', {protocol: 1}); established = true;
  await removeLocal(entries.map(([key]) => key));
  migrated = true;
}

async function ensureActive() {
  if (modeNeedsProbe) { await probe(true); modeNeedsProbe = false; }
  if (activeStatus) { await acquire(); await migrateLocal(); }
  return !!activeStatus;
}
async function runShared(fn) {
  await probe(true); transactionDepth++;
  try { await ensureActive(); return await fn(); }
  catch (error) {
    if (error.name === 'SharedStoreUnavailableError' || error.name === 'SharedStoreBusyError') throw error;
    if (/native messaging|native host|本地文件组件未连接|Specified native messaging host|Access to the specified native/i.test(error.message)) throw unavailable(error);
    throw error;
  } finally {
    // History reads can arrive while a note operation holds this same worker's
    // port. Let their already-started cache requests finish before unlocking.
    while (activeOperations.size) await Promise.allSettled([...activeOperations]);
    transactionDepth--; await release();
  }
}
export function withSharedStore(fn) {
  // The service worker wraps whole read/modify/write operations. Standalone
  // callers use the same gate; neither browser can read a state and overwrite a
  // concurrent save from the other between loading and committing it.
  const task = transactionQueue.then(() => runShared(fn), () => runShared(fn));
  transactionQueue = task.catch(() => {}); return task;
}
export async function get(key) {
  if (key === 'root' || key === 'pendingRoot' || !sharedKey(key) && key !== 'nativeMode' && key !== 'nativeName') return localGet(key);
  if (key === 'nativeMode' || key === 'nativeName') {
    const status = await probe();
    if (status) return key === 'nativeMode' ? true : status.name;
    return localGet(key);
  }
  if (transactionDepth) return access(() => cacheGet(key), () => localGet(key));
  return withSharedStore(() => activeStatus ? cacheGet(key) : localGet(key));
}
export async function put(key, value) {
  if (key === 'nativeMode') {
    await localPut(key, !!value); localNativeMode = !!value;
    activeStatus = null; lastProbe = 0; lastProbeError = null; migrated = false; modeNeedsProbe = true;
    return;
  }
  if (key === 'nativeName') { return; } // The native configuration is authoritative.
  if (!sharedKey(key)) {
    await localPut(key, value);
    if (key === 'root') { localRootPresent = !!value; activeStatus = null; lastProbe = 0; modeNeedsProbe = true; }
    return;
  }
  if (transactionDepth) return access(() => cachePut(key, value), () => localPut(key, value));
  return withSharedStore(() => activeStatus ? cachePut(key, value) : localPut(key, value));
}
function access(native, local) {
  const task = ensureActive().then(active => active ? native() : local());
  activeOperations.add(task);
  task.then(() => activeOperations.delete(task), () => activeOperations.delete(task));
  return task;
}
