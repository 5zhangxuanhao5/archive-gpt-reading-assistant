import {get, put, withSharedStore, sharedStatus, cacheRevision} from './db.js';
import {mergeDocuments} from './collaboration.js';
import {validName, notePath, samePath, uniqueTitle, documentText, parseDocument, jumpURL, plainPaste, quoteMarker, migrateNote, insertionPoint, noteBlocks, blockText, normalizeBlocks, DEFAULT_BLOCK_COLORS} from './core.js';
import {rootHandle} from './folder-files.js';
import {prepareBackupImport} from './backup.js';
import {putMany} from './db.js';
import {handleHistoryMessage} from './history-index.js';
import {storeImage, getImage, syncImages, backupAssets, validateImageBlocks, resetImageSync} from './media.js';

const initial = () => ({notes: [], folders: [], vaultName: '', storageMode: 'local', autoReturn: true, blockColors: {...DEFAULT_BLOCK_COLORS}});
let queue = Promise.resolve();
const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
const load = async () => {
  const state = (await get('state')) || initial();
  let migrated = !state.blockColors || state.notes.some(n => !Array.isArray(n.blocks) || n.quoteLayout !== 'inline');
  state.blockColors = {...DEFAULT_BLOCK_COLORS, ...state.blockColors}; state.notes.forEach(migrateNote);
  if (state.storageMode === 'native') { state.storageMode = 'local'; state.vaultName = ''; migrated = true; }
  if (migrated) await put('state', state);
  if (cachedAutoReturn !== state.autoReturn) { cachedAutoReturn = state.autoReturn; await chrome.storage.local.set({autoReturn:state.autoReturn}); }
  return state;
};
const persist = state => put('state', state);
let cachedAutoReturn;
const notify = () => chrome.runtime.sendMessage({type: 'VAULT_CHANGED'}).catch(() => {});
async function view(state) {
  const root = await rootHandle();
  const permission = root ? await root.queryPermission({mode: 'readwrite'}) : 'none';
  const {targets, ...publicState} = state;
  return {...publicState, shared:false, savedLocally:true, permission, notes: state.notes.map(({diskText, retired, lastClient, lastSequence, clientSequences, quoteInsertions, imageInsertions, ...n}) => ({...n, synced: n.diskPath === notePath(n) && diskText === documentText(n) && !n.syncError}))};
}
async function fileAt(root, path, create = false) {
  const parts = path.split('/');
  let folder = root;
  for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, {create});
  return {folder, file: await folder.getFileHandle(parts.at(-1), {create}), name: parts.at(-1)};
}
async function readAt(root, path) {
  try { return await (await fileAt(root, path)).file.getFile().then(file => file.text()); }
  catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}
async function syncNote(state, note) {
  const root = await rootHandle();
  if (!root) { delete note.syncError; return; }
  try {
    if (await root.queryPermission({mode: 'readwrite'}) !== 'granted') throw new Error('文件夹需要重新授权；笔记已保存到此浏览器');
    const path = notePath(note);
    await syncImages(note);
    const content = documentText(note);
    const current = await readAt(root, path);
    const expected = note.diskPath && samePath(note.diskPath, path) ? note.diskText : null;
    if (current !== null && current !== expected && current !== content) throw new Error('电脑中的同名文件已被修改。请先“读取文件夹更新”，或重命名这篇笔记以保留两份。');
    if (current !== content) {
      const {file} = await fileAt(root, path, true);
      const writable = await file.createWritable();
      try { await writable.write(content); await writable.close(); }
      catch (e) { await writable.abort().catch(() => {}); throw e; }
    }
    if (note.diskPath && !samePath(note.diskPath, path)) (note.retired ||= []).push({path: note.diskPath, text: note.diskText});
    note.diskPath = path; note.diskText = content; delete note.diskStamp;
    const pending = [];
    for (const old of note.retired || []) {
      if (samePath(old.path, path)) continue;
      try {
        const previous = await readAt(root, old.path);
        if (previous === old.text) { const {folder, name} = await fileAt(root, old.path); await folder.removeEntry(name); }
        else if (previous !== null) pending.push(old);
      } catch { pending.push(old); }
    }
    note.retired = pending;
    note.syncError = pending.length ? '新位置已保存；旧文件有外部改动，已保留旧文件' : '';
  } catch (e) { note.syncError = e.message || '文件保存失败；本地备份已保存'; }
}
function makeNote(state, title = '未命名笔记', folder = '', text = '') {
  return migrateNote({id: crypto.randomUUID(), title: uniqueTitle(state.notes, folder, validName(title)), folder, text, rev: 1, updated: Date.now(), syncError: '', quoteLayout: 'inline'});
}
async function importedDocument(text) {
  const parsed = parseDocument(text);
  for (const block of parsed.blocks) if (block.type === 'image' && block.src.startsWith('data:')) Object.assign(block, await storeImage(block.src, block.alt));
  parsed.text = blockText(parsed.blocks);
  return parsed;
}
async function importFiles(state, root, prefix = '', options = {}) {
  for await (const [name, handle] of root.entries()) {
    if (name.startsWith('.')) continue;
    const path = [prefix, name].filter(Boolean).join('/');
    if (handle.kind === 'directory') {
      if (!state.folders.some(folder => samePath(folder, path))) { state.folders.push(path); options.changed = true; }
      await importFiles(state, handle, path, options);
    } else if (/\.md$/i.test(name)) {
      const file = await handle.getFile();
      if (file.size > 8 * 1024 * 1024) throw new Error('文件超过 8 MB：' + path + '。请移出笔记文件夹后重试。');
      const existing = state.notes.find(n => n.diskPath && samePath(n.diskPath, path));
      const stamp = file.lastModified ? String(file.lastModified) + ':' + file.size : '';
      if (!options.force && stamp && existing?.diskStamp === stamp) continue;
      const text = await file.text();
      if (existing) { if (existing.diskStamp !== stamp) options.metadata = true; existing.diskStamp = stamp; }
      if (existing) {
        if (text === existing.diskText) continue;
        options.changed = true;
        if (documentText(existing) === existing.diskText) {
          Object.assign(existing, await importedDocument(text)); existing.diskText = text; existing.rev++; existing.updated = Date.now(); existing.syncError = '';
          delete existing.lastClient; delete existing.lastSequence;
        } else {
          // Preserve unsynced browser edits before accepting a changed disk file.
          const copy = makeNote(state, existing.title + '（本地保留）', existing.folder, existing.text);
          copy.quotes = structuredClone(existing.quotes || []); copy.blocks = structuredClone(existing.blocks || []);
          state.notes.push(copy);
          Object.assign(existing, await importedDocument(text)); existing.diskText = text; existing.rev++; existing.updated = Date.now(); existing.syncError = '';
          delete existing.lastClient; delete existing.lastSequence;
        }
      } else {
        const title = validName(name.replace(/\.md$/i, ''));
        const local = state.notes.find(n => !n.diskPath && samePath(notePath(n), path));
        if (local) { local.title = uniqueTitle(state.notes, local.folder, local.title + '（本地保留）'); local.rev++; }
        const parsed = await importedDocument(text);
        const note = makeNote(state, title, prefix, parsed.text); Object.assign(note, parsed);
        note.diskPath = path; note.diskText = text; note.diskStamp = stamp;
        state.notes.push(note); options.changed = true;
      }
    }
  }
}
async function execute(message) {
  const state = await load();
  let affected, insertion, imageResult, mergeConflicts = [];
  switch (message.type) {
    case 'LIST': return {state: await view(state)};
    case 'CREATE': {
      const folder = message.folder || '';
      if (folder && !state.folders.includes(folder)) throw new Error('文件夹不存在');
      affected = makeNote(state, message.title || '未命名笔记', folder);
      state.notes.push(affected); break;
    }
    case 'SAVE': {
      const client = typeof message.clientId === 'string' ? message.clientId.slice(0, 80) : '';
      const targetKey = client + ':' + message.id;
      const mappedId = state.targets?.[targetKey] || message.id;
      const note = state.notes.find(n => n.id === mappedId);
      if (!note || (!Array.isArray(message.blocks) && typeof message.text !== 'string')) throw new Error('笔记不存在');
      if (client && message.sequence && message.sequence <= (note.clientSequences?.[client] || 0)) return {state:await view(state),noteId:note.id,conflict:note.id!==message.id};
      if (Array.isArray(message.quotes) && (message.quotes.length > 10000 || new Set(message.quotes.map(q => q?.id)).size !== message.quotes.length)) throw new Error('引用格式无效，不能使用重复标识');
      let quotes = Array.isArray(message.quotes) ? message.quotes.map(input => {
        if (!input || typeof input.id !== 'string' || !/^[\w-]{1,100}$/.test(input.id) || typeof input.text !== 'string' || input.text.length > 100000) throw new Error('引用内容格式无效');
        const previous = note.quotes?.find(q => q.id === input.id);
        const quote = previous ? {...previous, text: input.text} : {id:input.id,text:input.text,source:input.source,created:input.created||Date.now()};
        jumpURL(quote.source); return quote;
      }) : structuredClone(note.quotes || []);
      let blocks;
      if (Array.isArray(message.blocks)) blocks = normalizeBlocks(message.blocks, quotes);
      else blocks = message.text === note.text ? structuredClone(note.blocks) : noteBlocks({text:message.text,quotes,quoteLayout:'inline'});
      let collaborative = false;
      if ((note.rev !== message.rev || message.rebase === true) && Array.isArray(message.base?.blocks) && Array.isArray(message.base?.quotes) && message.base.rev === message.rev) {
        const baseQuotes = message.base.quotes;
        if (baseQuotes.length > 10000 || new Set(baseQuotes.map(q => q?.id)).size !== baseQuotes.length || new Set(message.base.blocks.map(b => b?.id)).size !== message.base.blocks.length) throw new Error('协同编辑的原始标识无效');
        for (const quote of baseQuotes) { if (typeof quote.id !== 'string' || typeof quote.text !== 'string' || quote.text.length > 100000) throw new Error('协同编辑的原始引用无效'); jumpURL(quote.source); }
        const base = {blocks:normalizeBlocks(message.base.blocks,baseQuotes),quotes:baseQuotes};
        if (documentText(base).length > 8 * 1024 * 1024) throw new Error('协同编辑的原始笔记超过大小限制');
        const merged = mergeDocuments(base,{blocks,quotes},{blocks:note.blocks,quotes:note.quotes || []});
        quotes = merged.quotes; blocks = normalizeBlocks(merged.blocks,quotes); mergeConflicts = merged.conflicts; collaborative = true;
      }
      // A selection arrives through a different tab. Preserve it if an already queued
      // editor save was captured before that insertion reached the panel.
      const preserved = [];
      const additions=[...(note.quoteInsertions || []).map(event=>({...event,type:'quote'})),...(note.imageInsertions || []).map(event=>({...event,type:'image'}))].sort((a,b)=>a.rev-b.rev);
      for (const event of additions) if (event.rev > message.rev) {
        const present=event.type==='quote' ? blocks.some(b=>b.type==='quote' && b.quoteId===event.quoteId) : blocks.some(b=>b.type==='image' && b.imageId===event.imageId);
        if (present) continue;
        const serverBlock=note.blocks.find(b=>b.id===event.blockId); if (!serverBlock || serverBlock.type!==event.type) continue;
        if (event.type==='quote') {
          const quote=note.quotes.find(q=>q.id===event.quoteId); if (!quote) continue;
          if (!quotes.some(q=>q.id===quote.id)) quotes.push(structuredClone(quote));
        }
        const replaced=event.replacedBlockId ? blocks.findIndex(b=>b.id===event.replacedBlockId) : -1;
        if (replaced>=0 && blocks[replaced].type==='empty' && !blocks[replaced].text) blocks.splice(replaced,1,structuredClone(serverBlock));
        else {
          const after=replaced>=0 ? replaced : blocks.findIndex(b=>b.id===event.afterBlockId);
          blocks.splice(after>=0 ? after+1 : blocks.length,0,structuredClone(serverBlock));
        }
        preserved.push(event.quoteId || event.imageId);
      }
      blocks = normalizeBlocks(blocks,quotes); validateImageBlocks(blocks);
      if (quotes.some(quote => quote.text.length > 100000)) throw new Error('合并后的单条引用超过 10 万字，请拆分引用后重试');
      const text = Array.isArray(message.blocks) || preserved.length ? blockText(blocks) : message.text;
      if (text.length > 8 * 1024 * 1024 || documentText({blocks,quotes,folder:note.folder}).length > 8 * 1024 * 1024) throw new Error('单篇笔记不能超过 8 MB，图片独立保存');
      const differs = Array.isArray(message.blocks) ? documentText({blocks,quotes,folder:note.folder}) !== documentText(note) : (message.text !== note.text || JSON.stringify(quotes) !== JSON.stringify(note.quotes || []));
      const insertionRevs=new Set([...(note.quoteInsertions||[]),...(note.imageInsertions||[])].map(event=>event.rev));
      let onlyInsertions=Number.isInteger(message.rev) && message.rev<note.rev && note.rev-message.rev<=2048;
      if (onlyInsertions) for (let rev=message.rev+1;rev<=note.rev;rev++) if (!insertionRevs.has(rev)) { onlyInsertions=false; break; }
      if (note.rev !== message.rev && differs && !onlyInsertions && !collaborative && (!client || note.lastClient !== client)) {
        affected = makeNote(state, note.title + '（冲突副本）', note.folder, text);
        affected.quotes = quotes; affected.blocks = blocks;
        state.notes.push(affected); (state.targets ||= {})[targetKey] = affected.id;
      } else {
        affected = note;
        if (!client || note.lastClient !== client || message.sequence > (note.lastSequence || 0)) {
          note.text = text; note.blocks = blocks; note.quotes = quotes; note.rev++; note.updated = Date.now();
        }
      }
      affected.lastClient = client; affected.lastSequence = message.sequence || 0;
      if (client && message.sequence) { (affected.clientSequences ||= {})[client] = message.sequence; if (Object.keys(affected.clientSequences).length > 256) delete affected.clientSequences[Object.keys(affected.clientSequences)[0]]; }
      break;
    }
    case 'INSERT_QUOTE': {
      affected = state.notes.find(n => n.id === message.id);
      if (!affected) throw new Error('请先在笔记面板打开一篇笔记');
      const text = plainPaste(String(message.quote?.text || ''));
      if (!text || text.length > 100000) throw new Error('摘录不能为空，单次摘录请少于 10 万字');
      const source = message.quote.source;
      jumpURL(source);
      const id = crypto.randomUUID();
      (affected.quotes ||= []).push({id, text, source, created: Date.now()});
      const offset = insertionPoint(affected.text, message.anchor);
      const block = {id:crypto.randomUUID(), type:'quote', quoteId:id};
      let position = affected.blocks.length;
      let replacedBlockId = '';
      if (message.anchor?.blockId) {
        const selected = affected.blocks.findIndex(b => b.id === message.anchor.blockId);
        position = selected >= 0 ? selected + 1 : affected.blocks.length;
        if (selected >= 0 && ['empty','text'].includes(affected.blocks[selected].type) && !String(affected.blocks[selected].text || '').trim()) {
          position = selected; replacedBlockId = affected.blocks[selected].id; block.id = replacedBlockId;
        } else if (selected < 0 && message.anchor.empty) {
          const next = affected.blocks.findIndex(b => b.id === message.anchor.nextId),previous = affected.blocks.findIndex(b => b.id === message.anchor.previousId);
          position = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(Math.max(Number(message.anchor.index) || 0,0),affected.blocks.length);
          if (/^[\w-]{1,100}$/.test(message.anchor.blockId)) block.id = message.anchor.blockId;
        }
      } else if (Number.isInteger(message.anchor?.cursor)) {
        // Translate the old continuous editor's cursor without reclassifying image frames.
        let start=0;
        for (let index=0; index<affected.blocks.length; index++) {
          const current=affected.blocks[index], content=blockText([current]), end=start+content.length;
          if (offset<=end) {
            position=index+1;
            if (current.type==='text' && offset>start && offset<end) {
              const split=offset-start;
              const trailing={...current,id:crypto.randomUUID(),text:current.text.slice(split)};
              current.text=current.text.slice(0,split);
              affected.blocks.splice(index+1,0,trailing);
            } else if (offset<=start) position=index;
            break;
          }
          start=end+2;
        }
      }
      const afterBlockId=affected.blocks[position-1]?.id || '';
      affected.blocks.splice(position,replacedBlockId ? 1 : 0,block); affected.text=blockText(affected.blocks);
      affected.rev++;
      (affected.quoteInsertions ||= []).push({quoteId:id,blockId:block.id,afterBlockId,replacedBlockId,rev:affected.rev});
      affected.quoteInsertions=affected.quoteInsertions.slice(-1024);
      insertion={quoteId:id,blockId:block.id,offset,cursor:offset+quoteMarker(id).length+4};
      if (documentText(affected).length > 8 * 1024 * 1024) throw new Error('这篇笔记已超过 8 MB，请新建笔记继续摘录');
      affected.updated = Date.now(); break;
    }
    case 'REMOVE_QUOTE': {
      affected = state.notes.find(n => n.id === message.id);
      if (!affected) throw new Error('笔记不存在');
      affected.quotes = (affected.quotes || []).filter(q => q.id !== message.quoteId);
      affected.blocks = affected.blocks.filter(block => block.type !== 'quote' || block.quoteId !== message.quoteId); affected.text = blockText(affected.blocks); affected.rev++; break;
    }
    case 'UPDATE_QUOTE': {
      affected = state.notes.find(n => n.id === message.id);
      const quote = affected?.quotes?.find(q => q.id === message.quoteId);
      if (!quote || typeof message.text !== 'string') throw new Error('摘录不存在');
      if (message.text.length > 100000) throw new Error('单条摘录请少于 10 万字');
      quote.text = message.text; affected.rev++; affected.updated = Date.now(); break;
    }
    case 'RENAME': {
      affected = state.notes.find(n => n.id === message.id);
      if (!affected || affected.rev !== message.rev) throw new Error('笔记已在另一窗口更新，请刷新后重试');
      const title = validName(message.title), folder = message.folder || '';
      if (folder && !state.folders.includes(folder)) throw new Error('文件夹不存在');
      const path = notePath({title, folder});
      if (state.notes.some(n => n.id !== affected.id && samePath(notePath(n), path))) throw new Error('文件夹中已有同名笔记');
      affected.title = title; affected.folder = folder; affected.rev++; affected.updated = Date.now(); break;
    }
    case 'FOLDER': {
      const parent = message.parent || '';
      if (parent && !state.folders.includes(parent)) throw new Error('父文件夹不存在');
      const path = [parent, validName(message.name)].filter(Boolean).join('/');
      if (state.folders.some(f => samePath(f, path))) throw new Error('已有同名文件夹');
      state.folders.push(path);
      await persist(state);
      const root = await rootHandle();
      if (root && await root.queryPermission({mode: 'readwrite'}) === 'granted') {
        let directory = root;
        for (const part of path.split('/')) directory = await directory.getDirectoryHandle(part, {create: true});
      }
      break;
    }
    case 'CONNECT': {
      resetImageSync();
      const root = await get('pendingRoot') || await get('root');
      if (!root) throw new Error('请先选择文件夹');
      const previous = await get('root');
      if (!previous || !await previous.isSameEntry(root)) {
        for (const note of state.notes) { delete note.diskPath; delete note.diskText; delete note.retired; }
      }
      await put('root', root); await put('pendingRoot', null);
      state.storageMode = 'browser';
      state.vaultName = root.name;
      state.version = (state.version || 0) + 1; await persist(state);
      await importFiles(state, root);
      break;
    }
    case 'DISCONNECT_FOLDER': {
      await put('root', null); resetImageSync(); state.storageMode = 'local'; state.vaultName = '';
      for (const note of state.notes) { delete note.diskPath; delete note.diskText; delete note.retired; delete note.syncError; }
      break;
    }
    case 'IMPORT_BACKUP': {
      const imported = prepareBackupImport(message.backup, state);
      await putMany([['state', imported.state], ...imported.assets.map(a=>['asset:'+a.imageId,a])]);
      notify();
      return {state:await view(imported.state), importedCount:imported.count, noteId:imported.firstId};
    }
    case 'REFRESH': {
      const root = await rootHandle();
      if (!root || await root.queryPermission({mode: 'readwrite'}) !== 'granted') throw new Error('请先授权文件夹');
      await importFiles(state, root, '', {force: true}); break;
    }
    case 'SCAN': {
      const root = await rootHandle();
      if (!root || await root.queryPermission({mode: 'readwrite'}) !== 'granted') return {state: await view(state)};
      const options = {}; await importFiles(state, root, '', options);
      if (options.changed) { state.version = (state.version || 0) + 1; await persist(state); notify(); } else if (options.metadata) await persist(state);
      return {state: await view(state)};
    }
    case 'SYNC': break;
    case 'STORE_IMAGE': {
      if (!message.noteId) return storeImage(message.dataURL,message.alt);
      const client=typeof message.clientId==='string' ? message.clientId.slice(0,80) : '';
      const mappedId=state.targets?.[client+':'+message.noteId] || message.noteId;
      affected=state.notes.find(note=>note.id===mappedId);
      if (!affected) throw new Error('笔记不存在');
      const asset=await storeImage(message.dataURL,message.alt);
      const block={id:crypto.randomUUID(),type:'image',...asset,alt:String(message.alt||'').slice(0,1000)};
      const selected=affected.blocks.findIndex(item=>item.id===message.afterBlockId);
      let position=selected>=0 ? selected+1 : affected.blocks.length, replacedBlockId='';
      if (selected>=0 && affected.blocks[selected].type==='empty' && !affected.blocks[selected].text) {
        position=selected; replacedBlockId=affected.blocks[selected].id;
      }
      const afterBlockId=affected.blocks[position-1]?.id || '';
      affected.blocks.splice(position,replacedBlockId ? 1 : 0,block);
      affected.text=blockText(affected.blocks); affected.rev++; affected.updated=Date.now();
      (affected.imageInsertions ||= []).push({imageId:asset.imageId,blockId:block.id,afterBlockId,replacedBlockId,rev:affected.rev});
      affected.imageInsertions=affected.imageInsertions.slice(-1024);
      imageResult={...asset,blockId:block.id};
      break;
    }
    case 'GET_IMAGE': return getImage(message.imageId,message.src);
    case 'BACKUP': return {state:await view(state), assets:await backupAssets(state.notes)};
    case 'SETTINGS': {
      if (typeof message.autoReturn === 'boolean') { state.autoReturn = message.autoReturn; await chrome.storage.local.set({autoReturn:state.autoReturn}); }
      if (message.blockColors && typeof message.blockColors === 'object') for (const type of ['text','image','quote']) {
        const value = message.blockColors[type];
        if (value !== undefined) { if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('框颜色格式无效'); state.blockColors[type] = value.toLowerCase(); }
      }
      break;
    }
    default: throw new Error('不支持的操作');
  }
  // Commit the shared local backup before attempting any physical file operation.
  state.version = (state.version || 0) + 1;
  await persist(state);
  if (affected) await syncNote(state, affected);
  if (['CONNECT', 'SYNC', 'REFRESH'].includes(message.type)) {
    const root = await rootHandle();
    if (root && await root.queryPermission({mode: 'readwrite'}) === 'granted') {
      for (const path of state.folders) {
        let dir = root;
        for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part, {create: true});
      }
    }
    for (const note of state.notes) await syncNote(state, note);
  }
  await persist(state); notify();
  return {state: await view(state), noteId: affected?.id, insertion, ...imageResult, mergeConflicts, conflict: message.type === 'SAVE' && affected?.id !== message.id};
}
const transaction = message => withSharedStore(() => execute(message));

async function openInline(tab,mode='notes') {
  await chrome.tabs.sendMessage(tab.id,{type:'OPEN_INLINE_NOTES',mode,windowId:tab.windowId,readerTabId:tab.id});

}
chrome.action.onClicked.addListener(tab=>{
  if(/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) {
    setSurfaceMode(tab.windowId,'notes',tab.id).then(()=>openInline(tab)).catch(()=>chrome.tabs.create({url:chrome.runtime.getURL('notes.html')}));
  } else chrome.tabs.create({url:chrome.runtime.getURL('notes.html')});
});
const panels = new Map(), readers = new Map(), sidepanelOpen = new Map();
const imageDrags = new Map();
const dragLifetime = 120000, dragByteLimit = 80 * 1024 * 1024;
const dragUUID = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
function dragData(dataURL, src) {
  const match = typeof dataURL === 'string' && dataURL.match(/^data:(image\/(?:png|jpeg|gif|webp|bmp|avif));base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match || dataURL.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 + 100 || match[2].length % 4) throw new Error('图片拖动数据无效');
  const bytes = Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  if (!bytes || bytes > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
  const mime = match[1].toLowerCase(), extension = {png:'image/png',jpg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',avif:'image/avif'}[src.split('.').at(-1).toLowerCase()];
  const head = Uint8Array.from(atob(match[2].slice(0,48)),character=>character.charCodeAt(0)), first = String.fromCharCode(...head);
  const valid = mime === 'image/png' ? bytes >= 24 && [137,80,78,71,13,10,26,10].every((byte,index)=>head[index]===byte) :
    mime === 'image/jpeg' ? bytes >= 4 && head[0] === 255 && head[1] === 216 && head[2] === 255 :
    mime === 'image/gif' ? bytes >= 13 && /^GIF8[79]a/.test(first) :
    mime === 'image/webp' ? bytes >= 16 && first.startsWith('RIFF') && first.slice(8,12) === 'WEBP' :
    mime === 'image/bmp' ? bytes >= 26 && first.startsWith('BM') :
    mime === 'image/avif' ? bytes >= 16 && first.slice(4,8) === 'ftyp' && /avif|avis/.test(first) : false;
  if (!valid || mime !== extension) throw new Error('图片内容与格式不一致');
  return bytes;
}
function pruneImageDrags(retain) {
  const now = Date.now();
  for (const [token,entry] of imageDrags) if (entry.expires < now) imageDrags.delete(token);
  let bytes = [...imageDrags.values()].reduce((sum,entry)=>sum+(entry.bytes || 0),0);
  while (imageDrags.size > 4 || bytes > dragByteLimit) {
    const candidate = [...imageDrags.keys()].find(token=>token!==retain);
    if (!candidate) break;
    bytes -= imageDrags.get(candidate).bytes || 0; imageDrags.delete(candidate);
  }
}
const answerOutlines = new Map(), outlineModes = new Map(), readerModes = new Map(), outlineRequests = new Map();
const outlineReady = chrome.storage.session.get(['answerOutlineTabs','answerOutlineModes','answerReaderModes']).then(data => {
  for (const [key,value] of Object.entries(data.answerOutlineTabs || {})) answerOutlines.set(Number(key),value);
  for (const [key,value] of Object.entries(data.answerOutlineModes || {})) outlineModes.set(Number(key),value);
  for (const [key,value] of Object.entries(data.answerReaderModes || {})) readerModes.set(Number(key),value);
}).catch(() => {});
function persistOutlines() {
  return chrome.storage.session.set({answerOutlineTabs:Object.fromEntries(answerOutlines),answerOutlineModes:Object.fromEntries(outlineModes),answerReaderModes:Object.fromEntries(readerModes)}).catch(() => {});
}
function outlineBroadcast(windowId, message, tabId, active = true) {
  for (const panel of panels.values()) if (panel.windowId === windowId && (panel.surface === 'embedded' ? panel.readerTabId === tabId : active)) try { panel.port.postMessage({...message,readerTabId:tabId}); } catch {}
}
function validOutline(input, expectedUrl) {
  if (!input || typeof input.url !== 'string' || !Array.isArray(input.headings)) throw new Error('目录数据无效');
  const url = new URL(input.url); url.hash='';
  if (url.protocol !== 'https:' || !['chatgpt.com','chat.openai.com'].includes(url.hostname)) throw new Error('目录来源无效');
  if (expectedUrl) { const actual=new URL(expectedUrl); actual.hash=''; if (actual.href!==url.href) throw new Error('目录来自已离开的对话'); }
  if (input.headings.length > 2000) throw new Error('目录层级过多');
  const headings=input.headings.map(heading => {
    if (!heading || typeof heading.id !== 'string' || typeof heading.text !== 'string' || !Number.isInteger(heading.level) || heading.level < 1 || heading.level > 24) throw new Error('目录条目无效');
    jumpURL(heading.source);
    if (heading.source.url.split('#')[0]!==url.href) throw new Error('目录条目来源无效');
    return {id:heading.id.slice(0,300),text:heading.text.slice(0,2000),level:heading.level,kind:['heading','list','text'].includes(heading.kind) ? heading.kind : 'heading',htmlLevel:heading.htmlLevel,source:heading.source};
  });
  return {url:url.href,messageId:String(input.messageId||'').slice(0,300),messageIndex:input.messageIndex,title:String(input.title||'').slice(0,500),headings,maxLevel:headings.reduce((max,h)=>Math.max(max,h.level),0)};
}
const outlineURL = value => { try { const url=new URL(value);url.hash='';return url.href; } catch { return ''; } };
async function acceptOutline(tabId, input, ticket) {
  await outlineReady;
  const tab=await chrome.tabs.get(tabId),outline=validOutline(input,tab.url);
  if(outlineRequests.get(tabId)!==ticket)return null;
  const previous=answerOutlines.get(tabId);
  answerOutlines.set(tabId,{windowId:tab.windowId,outline});
  if(JSON.stringify(previous?.outline)!==JSON.stringify(outline) || previous?.windowId!==tab.windowId){
    persistOutlines();
    // Each embedded reader owns its outline, even while another tab is active.
    for(const panel of panels.values())if(panel.surface==='embedded' && panel.readerTabId===tabId)panel.windowId=tab.windowId;
    if(tab.active)outlineBroadcast(tab.windowId,{type:'ANSWER_OUTLINE_CHANGED',outline},tabId);
    else for(const panel of panels.values())if(panel.surface==='embedded' && panel.readerTabId===tabId)try{panel.port.postMessage({type:'ANSWER_OUTLINE_CHANGED',readerTabId:tabId,outline});}catch{}
  }
  return {tab,outline};
}
async function refreshOutline(tabId) {
  const ticket=(outlineRequests.get(tabId)||0)+1;outlineRequests.set(tabId,ticket);
  try {
    const result=await chrome.tabs.sendMessage(tabId,{type:'REQUEST_ANSWER_OUTLINE'});
    if(result?.ok && result.outline)await acceptOutline(tabId,result.outline,ticket);
  } catch {}
}
async function currentOutline(windowId, readerTabId) {
  await outlineReady;
  const tab=Number.isInteger(readerTabId) ? await chrome.tabs.get(readerTabId).catch(()=>null) : (await chrome.tabs.query({windowId,active:true}))[0];
  const mode=Number.isInteger(readerTabId) ? readerModes.get(readerTabId) || 'notes' : outlineModes.get(windowId)?.mode || 'notes';
  const stored=tab && answerOutlines.get(tab.id);
  const outline=stored && tab && stored.windowId===tab.windowId && outlineURL(stored.outline?.url)===outlineURL(tab.url) ? stored.outline : null;
  if(tab)refreshOutline(tab.id);
  return {mode,outline,readerTabId:tab?.id};
}
async function setSurfaceMode(windowId, mode, tabId, outline) {
  await outlineReady; outlineModes.set(windowId,{mode,tabId});if(Number.isInteger(tabId))readerModes.set(tabId,mode);await persistOutlines();
  outlineBroadcast(windowId,{type:'SURFACE_MODE',mode,...(outline?{outline}: {})},tabId);
}

function targetFor(windowId) { return [...panels.values()].filter(p => p.visible && (p.surface !== 'sidepanel' || sidepanelOpen.get(p.windowId) !== false) && p.id && p.windowId === windowId).sort((a, b) => b.at - a.at)[0]; }
function broadcastTarget(windowId) {
  const panel = targetFor(windowId);
  for (const [tabId, reader] of readers) if (reader.windowId === windowId) chrome.tabs.sendMessage(tabId, {type: 'NOTE_TARGET', target: panel ? {id: panel.id, title: panel.title} : null}).catch(() => readers.delete(tabId));
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'yueji-notes' || !port.sender?.url?.startsWith(chrome.runtime.getURL('notes.html'))) return;
  port.onMessage.addListener(data => {
    const previous = panels.get(port);
    panels.set(port, {id: data.id || '', title: String(data.title || ''), windowId: data.windowId, port, anchor: data.anchor, readerTabId:port.sender.tab?.id ?? data.readerTabId, surface: ['sidepanel','embedded'].includes(data.surface) ? data.surface : 'tab', visible: !!data.visible, at: Date.now()});
    if (previous && previous.windowId !== data.windowId) broadcastTarget(previous.windowId);
    broadcastTarget(data.windowId);
  });
  port.onDisconnect.addListener(() => { const panel = panels.get(port); panels.delete(port); if (panel) broadcastTarget(panel.windowId); });
});
chrome.sidePanel?.onOpened?.addListener(info => { if (info.path === 'notes.html') { sidepanelOpen.set(info.windowId, true); broadcastTarget(info.windowId); } });
chrome.sidePanel?.onClosed?.addListener(info => { sidepanelOpen.set(info.windowId, false); broadcastTarget(info.windowId); });
chrome.tabs.onRemoved.addListener(tabId => { readers.delete(tabId);answerOutlines.delete(tabId);readerModes.delete(tabId);outlineRequests.delete(tabId);persistOutlines(); });
chrome.tabs.onAttached.addListener((tabId,info)=>{
  if(readers.has(tabId))readers.get(tabId).windowId=info.newWindowId;
  if(answerOutlines.has(tabId))answerOutlines.get(tabId).windowId=info.newWindowId;
  for(const panel of panels.values())if(panel.readerTabId===tabId)panel.windowId=info.newWindowId;
  chrome.tabs.sendMessage(tabId,{type:'INLINE_CONTEXT',windowId:info.newWindowId,readerTabId:tabId}).catch(()=>{});refreshOutline(tabId);persistOutlines();
});
async function activateOutline(windowId,tabId) {
  const result=await currentOutline(windowId,tabId);
  const tab=await chrome.tabs.get(tabId).catch(()=>null);
  outlineBroadcast(windowId,{type:'ANSWER_OUTLINE_CHANGED',outline:result.outline},tabId,!!tab?.active);
}
chrome.tabs.onActivated.addListener(info=>{activateOutline(info.windowId,info.tabId).catch(()=>{});});
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(!change.url && change.status!=='complete')return;
  if(change.url){answerOutlines.delete(tabId);outlineRequests.set(tabId,(outlineRequests.get(tabId)||0)+1);persistOutlines();outlineBroadcast(tab.windowId,{type:'ANSWER_OUTLINE_CHANGED',outline:null},tabId,tab.active);}
  refreshOutline(tabId);
});
chrome.windows.onFocusChanged.addListener(windowId=>{if(windowId<0)return;chrome.tabs.query({windowId,active:true}).then(tabs=>tabs[0] && activateOutline(windowId,tabs[0].id)).catch(()=>{});});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (['READING_POSITION_GET','READING_POSITION_SET'].includes(message.type) && sender.tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) {
    (async()=>{
      const tab=await chrome.tabs.get(sender.tab.id);
      const url=new URL(message.url),actual=new URL(tab.url || sender.tab.url || sender.url);
      if(url.origin!==actual.origin || url.pathname.replace(/\/$/,'')!==actual.pathname.replace(/\/$/,'') || !/^\/c\/[^/]+\/?$/.test(url.pathname))throw new Error('定位来自已离开的聊天');
      const chat=url.origin+url.pathname.replace(/\/$/,''),key='reading:'+chat;
      return serial(()=>withSharedStore(async()=>{
        const previous=await get(key);
        if(message.type==='READING_POSITION_GET')return {position:previous || null};
        const input=message.position;
        if(!input || input.chat!==chat || !['user','assistant'].includes(input.role))throw new Error('定位无效');
        const position={chat,role:input.role};
        for(const [name,limit] of Object.entries({messageId:300,messageText:180,leafTag:20,leafText:800,prefix:32,suffix:48})){
          if(typeof input[name]!=='string' || input[name].length>limit)throw new Error('定位文本无效');position[name]=input[name];
        }
        for(const name of ['messageIndex','leafIndex','offset','viewportY','leafY','relativeY','scrollTop','edgeProgress','progress','at']){
          if(!Number.isFinite(input[name]) || Math.abs(input[name])>1e15)throw new Error('定位坐标无效');position[name]=input[name];
        }
        if(!Number.isInteger(position.offset) || position.offset<0 || position.at<=0)throw new Error('定位无效');
        if(!previous || previous.at<=position.at)await put(key,position);
        return {position:previous?.at>position.at?previous:position};
      }));
    })().then(result=>reply({ok:true,...result})).catch(error=>reply({error:error.message}));return true;
  }
  if (handleHistoryMessage(message, sender, reply)) return true;
  if (message.type === 'PAGE_THEME' && sender.tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) {
    if (['light', 'dark'].includes(message.theme)) chrome.storage.local.set({pageTheme: message.theme}); return;
  }
  if (message.type==='OPEN_NOTES' && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    const windowId=Number.isInteger(message.windowId) ? message.windowId : sender.tab?.windowId;
    if (!Number.isInteger(windowId)) { reply({error:'窗口无效'}); return; }
    setSurfaceMode(windowId,'notes',sender.tab?.id).then(()=>reply({ok:true})).catch(error=>reply({error:error.message}));
    return true;
  }
  if (message.type === 'OPEN_NOTES' && sender.tab) {
    const opening = setSurfaceMode(sender.tab.windowId,'notes',sender.tab.id).then(()=>openInline(sender.tab));
    opening.then(() => reply({ok: true})).catch(e => reply({error:e.message}));
    return true;
  }
  if (['ANSWER_OUTLINE','OPEN_ANSWER_OUTLINE'].includes(message.type) && sender.tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) {
    const ticket=(outlineRequests.get(sender.tab.id)||0)+1;outlineRequests.set(sender.tab.id,ticket);
    (async () => {
      let accepted=await acceptOutline(sender.tab.id,message.outline,ticket);
      if (message.type==='OPEN_ANSWER_OUTLINE') {
        // A simultaneous focus refresh must not swallow an explicit button click.
        if(!accepted){const tab=await chrome.tabs.get(sender.tab.id);accepted={tab,outline:validOutline(message.outline,tab.url)};}
        await setSurfaceMode(accepted.tab.windowId,'outline',accepted.tab.id,accepted.outline);await openInline(accepted.tab,'outline');
      }
      reply({ok:true});
    })().catch(error=>reply({error:error.message}));
    return true;
  }
  if (message.type==='GET_ANSWER_OUTLINE' && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    const windowId=Number.isInteger(message.windowId) ? message.windowId : sender.tab?.windowId;
    if (!Number.isInteger(windowId)) { reply({error:'窗口无效'}); return; }
    currentOutline(windowId,message.embedded ? sender.tab?.id ?? message.readerTabId : undefined).then(result=>reply({ok:true,...result})).catch(error=>reply({error:error.message})); return true;
  }
  if (['REGISTER_READER', 'GET_NOTE_TARGET', 'INSERT_SELECTED_QUOTE'].includes(message.type) && sender.tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) {
    let pageUrl;
    try { pageUrl = new URL(message.pageUrl || sender.url); if (pageUrl.origin !== new URL(sender.url).origin) throw new Error('来源无效'); }
    catch { reply({error: '来源无效'}); return; }
    pageUrl.hash = '';
    readers.set(sender.tab.id, {windowId: sender.tab.windowId, url: pageUrl.href});
    const target = targetFor(sender.tab.windowId);
    if (message.type !== 'INSERT_SELECTED_QUOTE') { reply({ok: true, target: target ? {id: target.id, title: target.title} : null}); return; }
    if (!target) { reply({error: '请先打开笔记面板并选择一篇笔记'}); return; }
    const quote = message.quote;
    if (typeof quote?.source?.url !== 'string' || quote.source.url.split('#')[0] !== pageUrl.href) { reply({error: '摘录来源无效'}); return; }
    serial(() => transaction({type: 'INSERT_QUOTE', id: target.id, quote, anchor: target.anchor})).then(result => { try { target.port.postMessage({type: 'QUOTE_INSERTED', ...result}); } catch {} reply({ok: true, title: target.title, ...result}); }).catch(e => reply({error: e.message}));
    return true;
  }
  if (message.type === 'JUMP_SOURCE' && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    try {
      const url = jumpURL(message.source);
      const match = [...readers].find(([, reader]) => reader.url === message.source.url.split('#')[0] && reader.windowId === message.windowId);
      (async () => {
        if (match) {
          try { await chrome.tabs.update(match[0], {active: true}); await chrome.tabs.sendMessage(match[0], {type: 'JUMP_TO_SOURCE', source: message.source}); return; } catch { readers.delete(match[0]); }
        }
        await chrome.tabs.create({url, windowId: message.windowId});
      })().then(() => reply({ok: true})).catch(e => reply({error: e.message}));
    } catch (e) { reply({error: e.message}); }
    return true;
  }
  if (message.type === 'OPEN_SETUP' && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    chrome.tabs.create({url: chrome.runtime.getURL('setup.html')}).then(() => reply({ok: true})); return true;
  }
  if (message.type === 'ARM_IMAGE_DRAG' && sender.url?.startsWith(chrome.runtime.getURL('notes.html'))) {
    try {
      const windowId = sender.tab?.windowId ?? message.windowId;
      const src = String(message.src || '');
      const reference = src.match(/^\.gpt-reader-assets\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(png|jpg|gif|webp|bmp|avif)$/i);
      if (!dragUUID(message.token) || !dragUUID(message.imageId) || !reference || reference[1] !== message.imageId || !Number.isInteger(windowId) || (Number.isInteger(message.windowId) && message.windowId !== windowId)) throw new Error('图片拖动来源无效');
      const dataURL = message.dataURL;
      const bytes = dataURL === undefined ? 0 : dragData(dataURL,src);
      const token = message.token;
      imageDrags.set(token,{imageId:message.imageId,src,windowId,dataURL,bytes,expires:Date.now()+dragLifetime});
      setTimeout(()=>{if((imageDrags.get(token)?.expires || Infinity)<=Date.now())imageDrags.delete(token);},dragLifetime+20);
      pruneImageDrags(token); reply({ok:true});
    } catch (error) { reply({error:error.message}); }
    return true;
  }
  if (message.type === 'FETCH_IMAGE_DRAG' && sender.tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) {
    pruneImageDrags();
    const entry = imageDrags.get(message.token);
    if (!dragUUID(message.token) || !entry || entry.windowId !== sender.tab.windowId) { reply({error:'图片拖动已结束，请重新拖动'}); return; }
    if (message.release) { imageDrags.delete(message.token); reply({ok:true}); return; }
    if (entry.dataURL) { reply({ok:true,dataURL:entry.dataURL}); return; }
    if (!entry.pending) entry.pending = serial(()=>withSharedStore(()=>getImage(entry.imageId,entry.src))).then(result=>{
      entry.bytes = dragData(result.dataURL,entry.src); entry.dataURL = result.dataURL; pruneImageDrags(message.token); return result;
    }).catch(error=>{entry.pending=null;throw error;});
    entry.pending.then(result=>reply({ok:true,dataURL:result.dataURL})).catch(error=>reply({error:error.message})); return true;
  }
  if(message.type==='GET_IMAGE' && sender.url?.startsWith(chrome.runtime.getURL('image-view.html'))){
    serial(()=>transaction(message)).then(result=>reply({ok:true,...result})).catch(error=>reply({error:error.message}));return true;
  }
  if(sender.url?.startsWith(chrome.runtime.getURL('image-view.html')))return;
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if(message.type==='OPEN_IMAGE'){
    chrome.tabs.query({windowId:message.windowId,active:true}).then(async tabs=>{
      if(!tabs[0])throw new Error('请在聊天页面打开笔记');
      await openInline(tabs[0]);
      await chrome.tabs.sendMessage(tabs[0].id,{...message,type:'OPEN_INLINE_IMAGE'});
      reply({ok:true});
    }).catch(error=>reply({error:error.message}));return true;
  }
  if(message.type==='VAULT_REVISION'){cacheRevision().then(result=>reply({ok:true,...result})).catch(error=>reply({error:error.message}));return true;}
  if (!['LIST', 'CREATE', 'SAVE', 'RENAME', 'FOLDER', 'CONNECT', 'DISCONNECT_FOLDER', 'IMPORT_BACKUP', 'REFRESH', 'SCAN', 'SYNC', 'SETTINGS', 'REMOVE_QUOTE', 'UPDATE_QUOTE', 'STORE_IMAGE', 'GET_IMAGE', 'BACKUP'].includes(message.type)) return;
  serial(() => transaction(message)).then(result => reply({ok: true, ...result})).catch(e => reply({error: e.message}));
  return true;
});
