import {plainPaste, validName, documentText, noteBlocks, blockText} from './core.js';
import {createEditor, renderMarkdown} from './vendor/editor.js';
import {mergeDocuments} from './collaboration.js';
const $ = s => document.querySelector(s);
let state = {notes: [], folders: [], vaultName: '', permission: 'none', autoReturn: true};
let opened = [], active = '', selectedFolder = '', expanded = new Set(['']), dialogMode = 'create', noticeTimer;
const clientId = crypto.randomUUID();
const drafts = new Map(), writing = new Set(), localDocs = new Map(), aliases = new Map();
const saves = new Map(), incomingNotes = new Map(), deferredReplies = new Map();
const flushedDocs = new Map();
const resolveId = id => { while (aliases.has(id)) id = aliases.get(id); return id; };
let sequence = 0, refreshing = false, scanning = false, editorBase = null;
let appliedFingerprint = '';
let treeFingerprint = '', tabsFingerprint = '', sharedRevision = '', revisionChecking = false, statusTimer;
const embedded = new URL(location.href).searchParams.get('surface') === 'embedded' && parent !== window;
let hostVisible = !embedded, readingIntent = false, readingSelected = false, readingTimer, readingRevision = 0;
const quoteAnchors = new Map();
let panelPort, windowId, surface = 'tab', previewMode = false, activeBlockId = '', renderedNote = '', outlineMode = false;
let answerOutline = null, outlineDepth = 1, outlineKey = '';
export const blockEditors = new Map();
const blockCards = new Map(), imageCache = new Map(), imageLoads = new Map();
const previewCards = new Map();let previewNote='';
let importingImages = 0;
const pendingImageBlocks = new Set();
let discardingEmpty = false;
const defaults = {text:'#f3f6fc', image:'#fff5e8', quote:'#f1edfb'};
const labels = {text:'文字', image:'图片', quote:'GPT 引用', empty:'新框'};
let formattingEditor = null;
const api = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '插件正在重新加载，请重新打开笔记'); return result; };
const noteFor = id => state.notes.find(n => n.id === id);
const copyDocument = note => ({rev:note.rev || 0,blocks:structuredClone(noteBlocks(note)),quotes:structuredClone(note.quotes || [])});
const sameDocument = (left,right) => JSON.stringify(left.blocks)===JSON.stringify(right.blocks) && JSON.stringify(left.quotes)===JSON.stringify(right.quotes);
const composingNote = id => id===active && [...blockEditors.values()].some(editor=>editor.view.composing);
function localDoc(note) {
  if (!localDocs.has(note.id)) { const base=copyDocument(note);localDocs.set(note.id,{blocks:structuredClone(base.blocks),quotes:structuredClone(base.quotes),base}); }
  return localDocs.get(note.id);
}
function visibleBlocks(note) { return localDoc(note).blocks; }
function visibleQuotes(note) { return localDoc(note).quotes; }
function visibleText(note) { return blockText(visibleBlocks(note)); }
function focusedEditor() { return blockEditors.get(activeBlockId) || blockEditors.values().next().value; }
export const bodyEditor = {
  get view() { return focusedEditor()?.view; },
  getText: () => noteFor(active) ? visibleText(noteFor(active)) : '',
  setText: text => {
    const note = noteFor(active); if (!note) return;
    const doc = localDoc(note), first = doc.blocks.find(b => b.type === 'text' || b.type === 'empty');
    const block = first || {id:crypto.randomUUID(),type:'text',text:''}; block.text = text; block.type = text ? 'text' : 'empty';
    doc.blocks = doc.blocks.filter(b => (b.type !== 'text' && b.type !== 'empty') || b.id === block.id);
    if (!first) doc.blocks.unshift(block); activeBlockId = block.id; renderBlocks();
  },
  focus: () => focusedEditor()?.focus(), format: kind => focusedEditor()?.format(kind),
  refreshQuotes: () => renderBlocks()
};
function publishTarget() {
  const note = noteFor(active);
  let anchor={blockId:activeBlockId};
  const index=note ? visibleBlocks(note).findIndex(block=>block.id===activeBlockId) : -1;
  if(index>=0 && emptyBlock(visibleBlocks(note)[index])){const blocks=visibleBlocks(note);anchor={blockId:activeBlockId,empty:true,index,previousId:blocks[index-1]?.id || '',nextId:blocks[index+1]?.id || ''};quoteAnchors.set(active,anchor);}
  else if(!activeBlockId && quoteAnchors.has(active))anchor=quoteAnchors.get(active);
  try { panelPort?.postMessage({anchor,id:note?.id || '', title:note?.title || '', windowId, surface, visible:!outlineMode && (embedded ? hostVisible && !document.hidden : surface === 'sidepanel' || !document.hidden)}); } catch {}
}
function connectPanel() {
  panelPort = chrome.runtime.connect({name:'yueji-notes'});
  panelPort.onMessage.addListener(message => {
    if (message.type === 'SURFACE_MODE') { setSurface(message.mode, message.outline); return; }
    if (message.type === 'ANSWER_OUTLINE_CHANGED') { updateOutline(message.outline); return; }
    if (message.type !== 'QUOTE_INSERTED') return;
    quoteAnchors.delete(message.noteId);readingIntent=false;readingSelected=false;
    apply(message.state, true);
    if (active === message.noteId) { activeBlockId = message.insertion?.blockId || activeBlockId; editorBase = {id:active,rev:noteFor(active).rev}; publishTarget(); }
  });
  panelPort.onDisconnect.addListener(() => { panelPort = null; setTimeout(connectPanel,1200); }); publishTarget();
}
Promise.all([chrome.windows.getCurrent(),chrome.tabs.getCurrent()]).then(async ([currentWindow,tab]) => { windowId = embedded ? Number(new URL(location.href).searchParams.get('windowId')) || currentWindow.id : currentWindow.id; surface = embedded ? 'embedded' : tab ? 'tab' : 'sidepanel'; connectPanel(); try { const result = await api({type:'GET_ANSWER_OUTLINE',windowId}); setSurface(result.mode || 'notes',result.outline); } catch {} });
window.addEventListener('message',event=>{
  if(!embedded || event.source!==parent || !['https://chatgpt.com','https://chat.openai.com'].includes(event.origin))return;
  if(event.data?.type==='HOST_VIEW'){
    if(Number.isInteger(event.data.windowId))windowId=event.data.windowId;
    hostVisible=!!event.data.visible;
    if(event.data.mode && outlineMode!==(event.data.mode==='outline'))setSurface(event.data.mode);
    if(!hostVisible && active){readingIntent=false;readingSelected=false;discardEmptyBlocks(active);}
    publishTarget();return;
  }
  if(event.data?.type==='HOST_IMAGE_DRAG_ERROR')notice(String(event.data.message || '图片暂时无法拖入，请重新拖动'));
  if(event.data?.type==='HOST_READING_POINTER'){if(event.data.revision<readingRevision)return;readingRevision=event.data.revision;clearTimeout(readingTimer);readingIntent=true;readingSelected=false;publishTarget();}
  if(event.data?.type==='HOST_READING_SELECTION'){
    if(event.data.revision<readingRevision)return;readingRevision=event.data.revision;
    readingSelected=!!event.data.selected;readingIntent=false;
    if(!readingSelected){clearTimeout(readingTimer);readingTimer=setTimeout(()=>{if(active && !readingIntent && !readingSelected)discardEmptyBlocks(active);},80);}
  }
});
$('#close-panel').hidden=!embedded;
$('#close-panel').onclick=()=>{if(active)discardEmptyBlocks(active);flushPendingSaves();parent.postMessage({type:'READER_PANEL_CLOSE'},'*');};
if(embedded)parent.postMessage({type:'READER_PANEL_READY'},'*');
setInterval(publishTarget,20000);
function notice(text) { $('#notice').textContent=text; $('#notice').hidden=false; clearTimeout(noticeTimer); noticeTimer=setTimeout(() => $('#notice').hidden=true,2200); }
function remember() { chrome.storage.local.set({panelState:{opened,active,selectedFolder,expanded:[...expanded]}}).catch(() => {}); }
function apply(next, force = false) {
  if ((next.version || 0) < (state.version || 0)) return;
  const fingerprint=JSON.stringify(next);
  if(!force && fingerprint===appliedFingerprint)return;
  appliedFingerprint=fingerprint;
  state = next;
  const pending=[];
  for (const note of state.notes) {
    const doc=localDoc(note),canonical=copyDocument(note);
    if(canonical.rev<doc.base.rev || (canonical.rev===doc.base.rev && sameDocument(canonical,doc.base)))continue;
    if(saves.has(note.id) || composingNote(note.id)){
      const previous=incomingNotes.get(note.id);if(!previous || canonical.rev>=previous.rev)incomingNotes.set(note.id,canonical);
      continue;
    }
    const dirty=!sameDocument(doc,doc.base),merged=dirty?mergeDocuments(doc.base,doc,canonical):canonical;
    doc.blocks=merged.blocks;doc.quotes=merged.quotes;doc.base=structuredClone(canonical);incomingNotes.delete(note.id);
    if(note.id===active)editorBase={id:active,rev:canonical.rev};
    if(dirty && !sameDocument(doc,canonical)){
      const seq=++sequence;
      drafts.set(note.id,{blocks:structuredClone(doc.blocks),quotes:structuredClone(doc.quotes),text:blockText(doc.blocks),seq});
      writing.add(note.id);pending.push(note.id);
    }else {drafts.delete(note.id);writing.delete(note.id);}
  }
  renderTree(); renderTabs(); renderBlocks(); renderStatus(); publishTarget();
  $('#vault-label').textContent=state.vaultName || '本地草稿'; $('#vault-label').title=state.vaultName || '尚未选择电脑文件夹';
  for(const id of pending)pumpSave(id);
}
function compositionEnded(noteId=active){
  const id=resolveId(noteId);if(!id || composingNote(id))return;
  const deferred=deferredReplies.get(id);
  if(deferred){deferredReplies.delete(id);deferred();return;}
  if(incomingNotes.has(id))apply(state,true);
  pumpSave(id);
}
function cardColor(block) { return block.color || (state.blockColors || defaults)[block.type === 'empty' ? 'text' : block.type] || defaults.text; }
function setCardColor(card,block) {
  const type=block.type==='empty'?'text':block.type;
  let hex=cardColor(block);
  const darkTheme=document.documentElement.dataset.theme==='dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  if(darkTheme && !block.color && hex===defaults[type])hex={text:'#29303b',image:'#383025',quote:'#332c40'}[type];
  card.style.backgroundColor=hex;
  const rgb=hex.replace('#','').match(/.{2}/g)?.map(v=>parseInt(v,16)) || [243,246,252];
  const linear=rgb.map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:Math.pow((channel+.055)/1.055,2.4);});
  const luminance=linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;
  const dark=1.05/(luminance+.05)>(luminance+.05)/.05;
  card.style.setProperty('--card-ink',dark?'#ffffff':'#000000'); card.style.setProperty('--muted',dark?'#eeeeee':'#555555');
  card.style.setProperty('--ink',dark?'#ffffff':'#000000');
  card.style.setProperty('--surface',dark?'rgba(0,0,0,.16)':'rgba(255,255,255,.45)');card.style.setProperty('--line',dark?'#ffffff35':'#00000020');card.style.setProperty('--hover',dark?'#ffffff18':'#0000000c');
  const readable=value=>{
    const channels=value.slice(1).match(/.{2}/g).map(part=>parseInt(part,16));
    for(let step=0;step<=10;step++){
      const mixed=channels.map(channel=>Math.round(channel+(dark?255-channel:-channel)*step/10));
      const linear=mixed.map(value=>{const c=value/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);}),l=linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;
      if((Math.max(l,luminance)+.05)/(Math.min(l,luminance)+.05)>=4.5)return '#'+mixed.map(v=>v.toString(16).padStart(2,'0')).join('');
    }
    return dark?'#ffffff':'#000000';
  };
  card.style.setProperty('--code',readable(dark?'#dda1af':'#ab4963'));card.style.setProperty('--syntax',readable(dark?'#b4a1d9':'#7956b5'));card.style.setProperty('--string',readable(dark?'#9ec79c':'#48834e'));card.style.setProperty('--muted',readable(dark?'#eeeeee':'#555555'));
}
function mergeInsertedQuotes(doc,incoming,known) {
  const added=(incoming.blocks || []).filter(b=>b.type==='quote' && !known.has(b.id) && !doc.blocks.some(local=>local.id===b.id));
  for(const block of added){const incomingIndex=incoming.blocks.findIndex(b=>b.id===block.id),before=incoming.blocks.slice(0,incomingIndex).reverse().find(b=>doc.blocks.some(local=>local.id===b.id));const at=before?doc.blocks.findIndex(b=>b.id===before.id)+1:0;doc.blocks.splice(at,0,structuredClone(block));const quote=incoming.quotes?.find(q=>q.id===block.quoteId);if(quote && !doc.quotes.some(q=>q.id===quote.id))doc.quotes.push(structuredClone(quote));}
}
async function imageURL(block) {
  const key=block.imageId || block.src;
  if (!key) throw new Error('图片没有可用的文件路径');
  if (imageCache.has(key)) return imageCache.get(key);
  if (!imageLoads.has(key)) imageLoads.set(key,api({type:'GET_IMAGE',imageId:block.imageId,src:block.src}).then(result=>{imageCache.set(key,result.dataURL);return result.dataURL;}).finally(()=>imageLoads.delete(key)));
  return imageLoads.get(key);
}
function paintImage(container,block) {
  if (container.dataset.imageKey === (block.imageId || block.src)) return;
  container.dataset.imageKey=block.imageId || block.src || ''; container.replaceChildren();
  const img=document.createElement('img'); img.alt=block.alt || '笔记图片'; img.className='block-image'; img.draggable=true;img.tabIndex=0;img.setAttribute('aria-label','打开图片预览，或拖入聊天作为图片文件'); container.append(img);
  let dragEnded=0;
  const openImage=()=>{
    if(Date.now()-dragEnded<350)return;
    if(embedded)parent.postMessage({type:'READER_IMAGE',imageId:block.imageId,src:block.src,alt:block.alt || '',theme:document.documentElement.dataset.theme || ''},'*');
    else api({type:'OPEN_IMAGE',imageId:block.imageId,src:block.src,alt:block.alt || '',theme:document.documentElement.dataset.theme || '',windowId}).catch(error=>notice(error.message));
  };
  img.onclick=openImage;img.onkeydown=event=>{if(event.key==='Enter' || event.key===' '){event.preventDefault();openImage();}};
  img.ondragstart=event=>{
    if(!event.isTrusted){event.preventDefault();return;}
    const dataURL=img.src,match=dataURL.match(/^data:(image\/(?:png|jpeg|gif|webp|bmp|avif));base64,(.*)$/);
    if(!match || !event.dataTransfer){event.preventDefault();return;}
    const extension={png:'png',jpeg:'jpg',gif:'gif',webp:'webp',bmp:'bmp',avif:'avif'}[match[1].split('/')[1]];
    const bytes=Uint8Array.from(atob(match[2]),character=>character.charCodeAt(0));
    event.dataTransfer.clearData();event.dataTransfer.items.clear();
    event.dataTransfer.items.add(new File([bytes],'笔记图片.'+extension,{type:match[1]}));event.dataTransfer.effectAllowed='copy';
    const token=crypto.randomUUID();event.dataTransfer.setData('application/x-gpt-reader-image',token);
    api({type:'ARM_IMAGE_DRAG',token,imageId:block.imageId,src:block.src,windowId,dataURL}).then(()=>{if(embedded)parent.postMessage({type:'READER_IMAGE_DRAG_START',token},'*');}).catch(error=>notice(error.message));
  };
  img.ondragend=()=>{dragEnded=Date.now();};
  imageURL(block).then(url=>{if(img.isConnected) img.src=url;}).catch(error=>{if(img.isConnected){const hint=document.createElement('p');hint.className='image-error';hint.textContent='图片暂时无法读取：'+error.message;container.replaceChildren(hint);}});
}
function selectBlock(id) { activeBlockId=id; formattingEditor=blockEditors.get(id) || null; const note=noteFor(active);if(note && visibleBlocks(note).find(b=>b.id===id)?.type!=='empty')quoteAnchors.delete(active);publishTarget(); }
function emptyBlock(block) { return (block.type==='empty' || block.type==='text') && !String(block.text || '').trim(); }
function removableEmpty(block) { return emptyBlock(block) && !pendingImageBlocks.has(block.id); }
function discardEmptyBlocks(id,keepId='') {
  if(discardingEmpty)return;
  const note=noteFor(resolveId(id));if(!note)return;
  const doc=localDoc(note),retained=doc.blocks.filter(block=>block.id===keepId || !removableEmpty(block));
  if(retained.length===doc.blocks.length)return;
  const keepEditor=blockEditors.get(keepId),restoreFocus=note.id===active && keepEditor?.view.hasFocus;
  discardingEmpty=true;
  try {
    doc.blocks=retained;
    if(note.id===active && !retained.some(block=>block.id===activeBlockId)){activeBlockId='';formattingEditor=null;}
    saveDoc(note.id);
    if(restoreFocus && !keepEditor.view.hasFocus)keepEditor.focus();
  } finally { discardingEmpty=false; }
}
function addBlock(index) {
  const note=noteFor(active);if(!note)return;
  const doc=localDoc(note),removedBefore=doc.blocks.slice(0,index).filter(removableEmpty).length;
  doc.blocks=doc.blocks.filter(block=>!removableEmpty(block));index-=removedBefore;
  const block={id:crypto.randomUUID(),type:'empty',text:''};doc.blocks.splice(index,0,block);
  activeBlockId=block.id;renderBlocks();saveInput();blockEditors.get(block.id)?.focus();
}
async function insertImages(files,afterId) {
  const note=noteFor(active);if(!note)return;
  const noteId=note.id;
  const placeholderId=afterId;pendingImageBlocks.add(placeholderId);
  importingImages++;
  try {
  for (const file of files) {
    try {
      if(file.size>20*1024*1024)throw new Error('图片不能超过 20 MB');
      const dataURL=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
      const result=await api({type:'STORE_IMAGE',dataURL,noteId:resolveId(noteId),afterBlockId:afterId,clientId});
      const doc=localDoc(noteFor(resolveId(noteId)) || note),at=doc.blocks.findIndex(b=>b.id===afterId);
      const block={id:result.blockId || crypto.randomUUID(),type:'image',imageId:result.imageId,src:result.src,alt:''};
      imageCache.set(block.imageId,dataURL);
      if(!doc.blocks.some(existing=>existing.id===block.id)){
        if(at>=0 && doc.blocks[at].type==='empty' && !doc.blocks[at].text) doc.blocks.splice(at,1,block);
        else doc.blocks.splice(at<0?doc.blocks.length:at+1,0,block);
      }
      const keepSelected=activeBlockId===afterId;afterId=block.id;
      if(result.state)apply(result.state);
      if(active===resolveId(noteId)){if(keepSelected)activeBlockId=block.id;renderBlocks();saveInput();if(keepSelected)selectBlock(block.id);}
      else saveDoc(resolveId(noteId));
    } catch(error){notice(error.message);}
  }
  } finally { pendingImageBlocks.delete(placeholderId);importingImages--;if(active!==resolveId(noteId) || !document.hasFocus())discardEmptyBlocks(noteId); }
}
function makeCard(block,note,preview=false) {
  const card=document.createElement('article'); card.className='note-block'+(block.type==='quote'?' quote-card':''); card.dataset.blockId=block.id;card.dataset.blockType=block.type;if(block.quoteId)card.dataset.quoteId=block.quoteId;
  const content=document.createElement('div');content.className='block-content';card.append(content);
  if(preview){updateCard(card,block,note,true);return card;}
  card.addEventListener('focusin',()=>selectBlock(block.id));card.addEventListener('pointerdown',()=>selectBlock(block.id));
  const tools=document.createElement('div');tools.className='block-tools';
  const palette=document.createElement('label');palette.className='block-color-label';palette.title='修改这个框的颜色';palette.setAttribute('aria-label','修改这个框的颜色');palette.textContent='◌';
  const color=document.createElement('input');color.type='color';color.className='block-color';color.setAttribute('aria-label','修改这个框的颜色');
  color.oninput=()=>{const current=visibleBlocks(noteFor(active)).find(b=>b.id===block.id);if(!current)return;current.color=color.value;setCardColor(card,current);saveInput();};palette.append(color);tools.append(palette);
  const remove=document.createElement('button');remove.className='block-remove';remove.textContent='×';remove.title='移除这个框';remove.setAttribute('aria-label','移除这个框');
  remove.onclick=()=>{const current=noteFor(active),doc=localDoc(current),index=doc.blocks.findIndex(b=>b.id===block.id);if(index<0)return;const [removed]=doc.blocks.splice(index,1);saveInput();renderBlocks();offerUndo(current.id,removed,index);};tools.append(remove);card.append(tools);
  card.addEventListener('paste',event=>{if(event.target.closest('.cm-editor'))return;const files=Array.from(event.clipboardData?.items || []).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();insertImages(files,block.id);}});
  updateCard(card,block,note);return card;
}
function offerUndo(id,block,index) {
  const noticeEl=$('#notice');noticeEl.textContent='已移除这个框 ';const undo=document.createElement('button');undo.textContent='撤销';
  undo.onclick=()=>{const note=noteFor(resolveId(id));if(!note)return;localDoc(note).blocks.splice(Math.min(index,visibleBlocks(note).length),0,block);saveDoc(note.id);renderBlocks();noticeEl.hidden=true;};noticeEl.append(undo);noticeEl.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>noticeEl.hidden=true,10000);
}
function updateCard(card,block,note,preview=false) {
  card.dataset.blockType=block.type;card.classList.toggle('quote-card',block.type==='quote');setCardColor(card,block);
  if(block.type==='image' && !preview)card.tabIndex=0;
  const content=card.querySelector('.block-content'),quote=block.type==='quote'?visibleQuotes(note).find(q=>q.id===block.quoteId):null;
  const color=card.querySelector('.block-color');if(color)color.value=cardColor(block);
  if(block.type==='image')paintImage(content,block);
  else if(preview)content.innerHTML=renderMarkdown(quote?.text ?? block.text ?? '');
  else {
    let editor=blockEditors.get(block.id);
    if(!editor){
      editor=createEditor(content,value=>{
        const current=noteFor(active),doc=localDoc(current),b=doc.blocks.find(item=>item.id===block.id);if(!b)return;
        if(b.type==='quote'){const q=doc.quotes.find(item=>item.id===b.quoteId);if(q)q.text=value;}
        else {b.text=value;b.type=value.length?'text':'empty';}
        selectBlock(block.id);saveInput();
      },plainPaste,{onSelection:()=>publishTarget(),onCompositionEnd:()=>compositionEnded(note.id),onImages:files=>insertImages(files,block.id),placeholder:block.type==='quote'?'编辑这段引用…':'输入 Markdown，或 ⌘V 粘贴图片…',label:block.type==='quote'?'编辑 GPT 引用':'Markdown 文字框'});
      blockEditors.set(block.id,editor);
      editor.view.dom.addEventListener('focusin',()=>selectBlock(block.id));
    }
    editor.setText(quote?.text ?? block.text ?? '');
  }
  let meta=card.querySelector('.quote-meta');
  if(quote){
    if(!meta){meta=document.createElement('div');meta.className='quote-meta';const label=document.createElement('span');label.className='quote-source';const back=document.createElement('button');back.className='quote-jump';back.textContent='↵';back.title='返回原文';back.setAttribute('aria-label','返回摘录原文');meta.append(label,back);card.append(meta);}
    meta.querySelector('.quote-source').textContent=quote.source.role==='user'?'我的提问':'ChatGPT';
    meta.querySelector('.quote-jump').onclick=()=>api({type:'JUMP_SOURCE',source:quote.source,windowId}).catch(error=>notice(error.message));
  }else meta?.remove();
}
function renderBlocks() {
  const note=noteFor(active),parent=$('#block-editor');
  if(renderedNote!==active){const previous=renderedNote;for(const editor of blockEditors.values())editor.view.destroy();blockEditors.clear();blockCards.clear();parent.replaceChildren();renderedNote=active;formattingEditor=null;if(previous)setTimeout(()=>compositionEnded(previous),0);}
  if(!note){parent.replaceChildren();return;}
  const blocks=visibleBlocks(note),ids=new Set(blocks.map(b=>b.id));
  if(!ids.has(activeBlockId)){activeBlockId='';formattingEditor=null;}
  for(const [id,card] of blockCards)if(!ids.has(id)){blockEditors.get(id)?.view.destroy();blockEditors.delete(id);card.remove();blockCards.delete(id);}
  const oldInserts=[...parent.querySelectorAll(':scope > .block-insert')],nodes=[];
  for(let index=0;index<=blocks.length;index++){
    const add=oldInserts[index] || document.createElement('button');add.className='block-insert';add.textContent='+';add.dataset.index=index;add.title='在这里新建一个框';add.setAttribute('aria-label',index===0?'在最上面新建一个框':index===blocks.length?'在最下面新建一个框':'在两个框之间新建一个框');add.onclick=()=>addBlock(index);nodes.push(add);
    if(index<blocks.length){const block=blocks[index];if(!blockCards.has(block.id))blockCards.set(block.id,makeCard(block,note));const card=blockCards.get(block.id);updateCard(card,block,note);nodes.push(card);}
  }
  for(let index=0;index<nodes.length;index++)if(parent.children[index]!==nodes[index])parent.insertBefore(nodes[index],parent.children[index] || null);
  while(parent.children.length>nodes.length)parent.lastElementChild.remove();
  renderPreview();
}
function renderPreview() {
  if(!previewMode)return;
  const note=noteFor(active),preview=$('#markdown-preview');if(!note)return;
  if(previewNote!==active){previewCards.clear();preview.replaceChildren();previewNote=active;}
  const selected=new Set([...$('#preview-filters').querySelectorAll('input:checked')].map(input=>input.dataset.filter));
  const nodes=[];
  for(const block of visibleBlocks(note))if(selected.has(block.type)){
    const key=JSON.stringify([block,block.type==='quote'?visibleQuotes(note).find(q=>q.id===block.quoteId):null,state.blockColors,document.documentElement.dataset.theme,matchMedia('(prefers-color-scheme: dark)').matches]);
    let entry=previewCards.get(block.id);
    if(!entry){entry={card:makeCard(block,note,true),key};previewCards.set(block.id,entry);}
    else if(entry.key!==key){updateCard(entry.card,block,note,true);entry.key=key;}
    nodes.push(entry.card);
  }
  if(!nodes.length){const message=preview.querySelector('.preview-empty') || document.createElement('p');message.className='preview-empty';message.textContent='没有符合当前筛选的内容';nodes.push(message);}
  for(let index=0;index<nodes.length;index++)if(preview.children[index]!==nodes[index])preview.insertBefore(nodes[index],preview.children[index] || null);
  while(preview.children.length>nodes.length)preview.lastElementChild.remove();
  const retained=new Set(visibleBlocks(note).map(block=>block.id));for(const id of previewCards.keys())if(!retained.has(id))previewCards.delete(id);
}
function sizeEditor() { for(const editor of blockEditors.values())editor.view.requestMeasure();renderPreview(); }
function setSurface(mode,outline) {
  outlineMode=mode==='outline';document.body.classList.toggle('outline-mode',outlineMode);$('#answer-outline-page').hidden=!outlineMode;
  if(embedded)parent.postMessage({type:'READER_PANEL_MODE',mode:outlineMode?'outline':'notes'},'*');
  setTree(false);$('#settings-dialog').close();if(outline !== undefined)updateOutline(outline);publishTarget();
  if(!outlineMode)sizeEditor();
}
function updateOutline(outline) {
  const key=(outline?.url || '')+':'+(outline?.messageId || outline?.messageIndex || '');
  if(key!==outlineKey){outlineDepth=1;outlineKey=key;}
  answerOutline=outline;renderAnswerOutline();
}
function renderAnswerOutline() {
  const outline=answerOutline,levels=$('#outline-levels'),headings=$('#answer-headings');levels.replaceChildren();headings.replaceChildren();
  $('#outline-answer-title').textContent=outline?.title===outline?.headings?.[0]?.text?'':outline?.title || '';
  const max=outline?.maxLevel || 0;outlineDepth=Math.min(outlineDepth,max || 1);
  const numbers=['一','二','三','四','五','六'];
  for(let level=1;level<=max;level++){
    const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.level=level;input.checked=level<=outlineDepth;
    const entries=(outline.headings || []).filter(item=>item.level===level),bodyOnly=entries.length && entries.every(item=>item.kind==='text');
    input.onchange=()=>{outlineDepth=input.checked?level:level-1;renderAnswerOutline();};label.append(input,document.createTextNode(bodyOnly?'正文':(numbers[level-1] || level)+'级'));levels.append(label);
  }
  for(const heading of outline?.headings || [])if(heading.level<=outlineDepth){
    const button=document.createElement('button');button.className='answer-heading';button.dataset.level=heading.level;button.dataset.kind=heading.kind || 'heading';button.textContent=heading.text;button.title=heading.text;button.style.paddingLeft=(8+Math.min(heading.level-1,8)*12)+'px';
    button.onclick=()=>api({type:'JUMP_SOURCE',source:heading.source,windowId}).catch(error=>notice(error.message));headings.append(button);
  }
  if(!headings.children.length){const empty=document.createElement('p');empty.className='outline-empty';empty.textContent=max?'选择要显示的层级':'当前回答还没有可列出的内容。滚动到其他回答后，这里会自动更新。';headings.append(empty);}
}
$('#outline-back-notes').onclick=()=>{setSurface('notes');api({type:'OPEN_NOTES',windowId}).catch(()=>{});};
function renderTree() {
  const tree = $('#tree');
  const query = $('#search').value.trim().toLowerCase();
  const notes = state.notes.filter(n => !query || (n.title + '\n' + visibleText(n) + '\n' + (n.quotes || []).map(q => q.text).join('\n')).toLowerCase().includes(query));
  const fingerprint=JSON.stringify([state.vaultName,state.folders,[...expanded],selectedFolder,active,query,notes.map(n=>[n.id,n.title,n.folder])]);
  if(fingerprint===treeFingerprint)return;treeFingerprint=fingerprint;const scrollTop=tree.scrollTop;tree.replaceChildren();
  const row = (text, glyph, depth, selected, action, title = text) => {
    const button = document.createElement('button'); button.className = 'tree-row' + (selected ? ' selected' : ''); button.style.paddingLeft = 7 + depth * 14 + 'px'; button.title = title;
    const icon = document.createElement('span'); icon.className = 'glyph'; icon.textContent = glyph;
    const label = document.createElement('span'); label.textContent = text; button.append(icon, label); button.onclick = action; tree.append(button); return button;
  };
  if (query) {
    for (const n of notes) row(n.title, '▤', 0, n.id === active, () => openNote(n.id), [n.folder, n.title].filter(Boolean).join('/'));
  } else {
    row(state.vaultName || '全部笔记', expanded.has('') ? '▾' : '▸', 0, selectedFolder === '', () => { selectedFolder = ''; if (expanded.has('')) expanded.delete(''); else expanded.add(''); renderTree(); remember(); });
    function branch(folder, depth) {
      const children = state.folders.filter(f => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '') === folder).sort((a, b) => a.localeCompare(b, 'zh-CN'));
      for (const path of children) {
        const button = row(path.split('/').at(-1), expanded.has(path) ? '▾' : '▸', depth, selectedFolder === path, () => { selectedFolder = path; if (expanded.has(path)) expanded.delete(path); else expanded.add(path); renderTree(); remember(); }, path);
        button.setAttribute('aria-expanded', String(expanded.has(path)));
        if (expanded.has(path)) branch(path, depth + 1);
      }
      for (const n of notes.filter(n => n.folder === folder).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))) row(n.title, '▤', depth, n.id === active, () => openNote(n.id));
    }
    if (expanded.has('')) branch('', 1);
  }
  if (query && !notes.length) { const empty = document.createElement('p'); empty.className = 'tree-empty'; empty.textContent = '没有找到笔记'; tree.append(empty); }
  tree.scrollTop=scrollTop;
}
function renderTabs() {
  const tabs = $('#tabs');
  opened = opened.filter(id => noteFor(id));
  const fingerprint=JSON.stringify([active,state.vaultName,opened.map(id=>[id,noteFor(id).title,noteFor(id).folder])]);
  if(fingerprint===tabsFingerprint)return;tabsFingerprint=fingerprint;const scrollLeft=tabs.scrollLeft;tabs.dataset.count=String(opened.length);tabs.replaceChildren();
  for (const id of opened) {
    const note = noteFor(id); const tab = document.createElement('div'); tab.className = 'tab' + (id === active ? ' active' : '');
    const label = document.createElement('button'); label.className = 'tab-label'; label.textContent = note.title; label.title = [note.folder, note.title].filter(Boolean).join('/'); label.setAttribute('role', 'tab'); label.setAttribute('aria-selected', String(id === active)); label.onclick = () => openNote(id);
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.title = '关闭标签（笔记仍会保留）'; close.setAttribute('aria-label', '关闭 ' + note.title); close.onclick = () => closeNote(id);
    tab.append(label, close); tabs.append(tab);
  }
  const note = noteFor(active); $('#welcome').hidden = !!note; $('#document').hidden = !note;
  if (note) { $('#note-title').textContent = note.title; $('#breadcrumb').textContent = note.folder || state.vaultName || '本地草稿'; $('#rename').title='重命名或移动笔记：'+[note.folder,note.title].filter(Boolean).join('/'); }
  tabs.scrollLeft=scrollLeft;
}
function renderStatus() {
  const note=noteFor(active),status=$('#save-status'),busy=writing.has(active);$('#export-note').disabled=!note;
  clearTimeout(statusTimer);
  if(busy){statusTimer=setTimeout(()=>{if(writing.has(active))status.textContent='正在保存…';},600);return;}
  const text=!note?(state.vaultName?'笔记库 · '+state.vaultName:'关闭标签页后，笔记仍会保留'):note.synced?'已保存到电脑':'已保存本地备份 · 待写入文件夹';
  status.textContent=text;status.title=busy?text:note?.syncError || text;status.classList.toggle('warning',!!note&&!note.synced&&!busy);
  $('#count').textContent=note?visibleBlocks(note).filter(b=>b.type!=='empty').length+' 个框':'';
}
function openNote(id) {
  const note=noteFor(id);if(!note)return;if(!opened.includes(id))opened.push(id);
  if(active){quoteAnchors.delete(active);discardEmptyBlocks(active);}
  active=id;activeBlockId='';selectedFolder=note.folder;setTree(false);expanded.add('');let parent=note.folder;
  while(parent){expanded.add(parent);parent=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):'';}
  renderTree();renderTabs();renderBlocks();renderStatus();remember();editorBase={id,rev:note.rev};sizeEditor();publishTarget();
  requestAnimationFrame(()=>document.querySelector('.tab.active')?.scrollIntoView({block:'nearest',inline:'nearest'}));
}
function closeNote(id) {
  discardEmptyBlocks(id);
  const index=opened.indexOf(id);opened=opened.filter(n=>n!==id);
  if(active===id){active=opened[Math.min(index,opened.length-1)] || '';if(active)openNote(active);}
  renderTree();renderTabs();renderStatus();remember();renderBlocks();publishTarget();
}
async function refreshState(){if(refreshing)return;refreshing=true;try{apply((await api({type:'LIST'})).state);}catch(error){notice(error.message);}finally{refreshing=false;}}
async function scanFiles(){if(scanning)return;scanning=true;try{apply((await api({type:'SCAN'})).state);}catch{}finally{scanning=false;}}
setInterval(scanFiles,2000);window.addEventListener('focus',scanFiles);
async function checkSharedRevision(){
  if(!state.shared || document.hidden || (embedded && !hostVisible) || revisionChecking)return;
  revisionChecking=true;
  try { const result=await api({type:'VAULT_REVISION'}),key=JSON.stringify([result.shared,result.connected,result.revision]);if(key!==sharedRevision){sharedRevision=key;await refreshState();} }
  catch(error){if(!$('#notice').hidden)return;notice(error.message);}
  finally {revisionChecking=false;}
}
setInterval(checkSharedRevision,200);
function saveInput(){if(active)saveDoc(active);}
function saveDoc(id){
  id=resolveId(id);
  const note=noteFor(id);if(!note)return;const doc=localDoc(note),seq=++sequence;
  flushedDocs.delete(id);
  const snapshot={blocks:structuredClone(doc.blocks),quotes:structuredClone(doc.quotes),text:blockText(doc.blocks),seq};
  drafts.set(id,snapshot);writing.add(id);renderStatus();renderBlocks();
  pumpSave(id);
}
function remapPreservedFrames(snapshot,doc,canonical,conflicts){
  const restore=[];
  for(const id of conflicts || []){
    const before=snapshot.blocks.find(block=>block.id===id),local=doc.blocks.find(block=>block.id===id);if(!before || !local)continue;
    const text=(block,quotes)=>block.type==='quote'?quotes.find(quote=>quote.id===block.quoteId)?.text:block.text;
    const source=(block,quotes)=>block.type==='quote'?JSON.stringify(quotes.find(quote=>quote.id===block.quoteId)?.source):'';
    const preserved=canonical.blocks.find(block=>!snapshot.blocks.some(item=>item.id===block.id) && block.type===before.type && block.color===before.color && (before.type==='quote' || ['text','empty'].includes(before.type)) && text(block,canonical.quotes)===text(before,snapshot.quotes) && source(block,canonical.quotes)===source(before,snapshot.quotes));
    if(!preserved)continue;
    const editor=id===activeBlockId?blockEditors.get(id):null;if(editor?.view.hasFocus)restore.push({id:preserved.id,selection:editor.view.state.selection.main});
    before.id=preserved.id;local.id=preserved.id;
    if(before.type==='quote'){
      const oldId=before.quoteId;before.quoteId=preserved.quoteId;local.quoteId=preserved.quoteId;
      const original=snapshot.quotes.find(quote=>quote.id===oldId),edited=doc.quotes.find(quote=>quote.id===oldId);
      if(original)original.id=preserved.quoteId;if(edited)edited.id=preserved.quoteId;
    }
    if(activeBlockId===id)activeBlockId=preserved.id;
  }
  return restore;
}
function pumpSave(id){
  id=resolveId(id);if(saves.has(id) || composingNote(id))return;
  const note=noteFor(id),doc=note && localDoc(note),snapshot=drafts.get(id);if(!doc || !snapshot)return;
  const request=structuredClone(snapshot),base=structuredClone(doc.base),seq=request.seq;
  saves.set(id,{request,base});writing.add(id);
  api({type:'SAVE',id,rev:base.rev,base,blocks:request.blocks,quotes:request.quotes,text:request.text,clientId,sequence:seq}).then(result=>{
    const finish=()=>{
    let currentId=resolveId(id);
    if(result.noteId && result.noteId!==currentId){
      const previous=currentId;aliases.set(previous,result.noteId);const draft=drafts.get(previous);
      if(draft){drafts.set(result.noteId,draft);drafts.delete(previous);}if(localDocs.has(previous)){localDocs.set(result.noteId,localDocs.get(previous));localDocs.delete(previous);}
      if(incomingNotes.has(previous)){incomingNotes.set(result.noteId,incomingNotes.get(previous));incomingNotes.delete(previous);}
      if(writing.has(previous)){writing.add(result.noteId);writing.delete(previous);}opened=opened.map(openId=>openId===previous?result.noteId:openId);if(active===previous)active=result.noteId;
      currentId=result.noteId;if(result.conflict)notice('另一窗口也编辑了这篇笔记，已为你的修改保留冲突副本。');remember();
    }
    const returned=result.state.notes.find(n=>n.id===currentId),current=localDocs.get(currentId);
    let restore=[];
    if(returned && current){
      let canonical=copyDocument(returned);const pending=incomingNotes.get(currentId);
      if(pending && pending.rev>canonical.rev)canonical=pending;
      if(current.base.rev>canonical.rev)canonical=current.base;
      restore=remapPreservedFrames(request,current,canonical,result.mergeConflicts);
      const merged=sameDocument(request,current)?canonical:mergeDocuments(request,current,canonical);
      current.blocks=merged.blocks;current.quotes=merged.quotes;current.base=structuredClone(canonical);incomingNotes.delete(currentId);
      if(sameDocument(current,canonical)){drafts.delete(currentId);writing.delete(currentId);}
      else {
        const latest=drafts.get(currentId),nextSeq=latest?.seq>seq?latest.seq:++sequence;
        drafts.set(currentId,{blocks:structuredClone(current.blocks),quotes:structuredClone(current.quotes),text:blockText(current.blocks),seq:nextSeq});
      }
      if(active===currentId)editorBase={id:currentId,rev:canonical.rev};
    }else if(drafts.get(currentId)?.seq===seq){drafts.delete(currentId);writing.delete(currentId);}
    saves.delete(id);saves.delete(currentId);
    apply(result.state);renderBlocks();renderStatus();
    for(const caret of restore){const editor=blockEditors.get(caret.id);if(editor){const length=editor.view.state.doc.length;editor.view.dispatch({selection:{anchor:Math.min(caret.selection.anchor,length),head:Math.min(caret.selection.head,length)}});editor.focus();formattingEditor=editor;}}
    if(result.mergeConflicts?.length)notice('同时修改的内容已完整保留。');
    pumpSave(currentId);
    };
    const currentId=resolveId(id);if(composingNote(currentId))deferredReplies.set(currentId,finish);else finish();
  }).catch(error=>{const currentId=resolveId(id);saves.delete(id);saves.delete(currentId);writing.delete(currentId);renderStatus();$('#save-status').textContent='保存失败 · 请导出备份';$('#save-status').classList.add('warning');notice(error.message);});
}
function flushPendingSaves(){
  for(const [id,doc] of localDocs){
    if(!noteFor(id))continue;
    const running=saves.get(id),base=running?{rev:running.base.rev,blocks:running.request.blocks,quotes:running.request.quotes}:doc.base;
    if(sameDocument(doc,base))continue;
    const fingerprint=JSON.stringify({blocks:doc.blocks,quotes:doc.quotes});if(flushedDocs.get(id)===fingerprint)continue;
    flushedDocs.set(id,fingerprint);
    const message={type:'SAVE',id,rev:base.rev,base:structuredClone(base),blocks:structuredClone(doc.blocks),quotes:structuredClone(doc.quotes),text:blockText(doc.blocks),clientId,sequence:++sequence};
    if(running)message.rebase=true;
    try{chrome.runtime.sendMessage(message).catch(()=>{});}catch{}
  }
}
function setMode(preview){
  if(active)discardEmptyBlocks(active);
  previewMode=preview;$('#block-editor').hidden=preview;$('#preview-surface').hidden=!preview;
  $('#edit-mode').classList.toggle('active',!preview);$('#preview-mode').classList.toggle('active',preview);$('.format-tools').hidden=preview;
  $('#preview-filters').hidden=!preview;
  if(preview)for(const checkbox of $('#preview-filters').querySelectorAll('input'))checkbox.checked=true;
  renderPreview();
}
for(const checkbox of $('#preview-filters').querySelectorAll('input'))checkbox.onchange=renderPreview;
$('#edit-mode').onclick = () => setMode(false); $('#preview-mode').onclick = () => setMode(true);
for (const button of document.querySelectorAll('[data-format]')) {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.onclick = () => { (formattingEditor || focusedEditor())?.format(button.dataset.format); $('#format-more').open = false; };
}
const formatDescriptions = {
  underline: '下划线：为选中文字添加下划线', image: '图片链接：用图片网址插入图片',
  heading: '标题：将当前行设为标题（#）', bold: '粗体：加重选中的文字（**文字**）',
  italic: '斜体：倾斜选中的文字（*文字*）', quote: '引用：将当前行设为引用（>）',
  bullet: '列表：添加项目符号（-）', link: '链接：插入文字与网址', strike: '删除线：划去选中的文字',
  ordered: '编号列表：按 1、2、3 排列', task: '待办事项：插入可勾选的任务', code: '行内代码：标记短代码',
  fence: '代码块：插入多行代码', table: '表格：插入 Markdown 表格', math: '数学公式：插入 LaTeX 公式', rule: '分隔线：分开两段内容'
};
const formatTip = document.createElement('div'); formatTip.className = 'format-tip'; formatTip.id = 'format-tip'; formatTip.setAttribute('role', 'tooltip'); formatTip.hidden = true; document.body.append(formatTip);
for (const button of document.querySelectorAll('[data-format]')) {
  const description = formatDescriptions[button.dataset.format] || '更多格式：删除线、待办、代码、表格和公式';
  button.removeAttribute('title'); button.setAttribute('aria-label', description); button.setAttribute('aria-describedby', 'format-tip');
  const show = () => {
    formatTip.textContent = description; formatTip.hidden = false;
    const r = button.getBoundingClientRect();
    formatTip.style.left = Math.max(6, Math.min(r.left, innerWidth - formatTip.offsetWidth - 6)) + 'px';
    formatTip.style.top = Math.min(r.bottom + 7, innerHeight - formatTip.offsetHeight - 6) + 'px';
  };
  button.addEventListener('mouseenter', show); button.addEventListener('focus', show);
  for (const type of ['mouseleave', 'blur', 'click']) button.addEventListener(type, () => formatTip.hidden = true);
}
function nameDialog(mode) {
  dialogMode = mode; const note = noteFor(active);
  if (mode === 'rename' && !note) return;
  if (writing.size) { notice('正在保存，请稍后再试'); return; }
  $('#dialog-title').textContent = mode === 'folder' ? '新建文件夹' : mode === 'rename' ? '重命名 / 移动笔记' : '新建笔记';
  $('#name-input').value = mode === 'rename' ? note.title : '';
  $('#name-input').placeholder = mode === 'folder' ? '例如：阅读摘录' : '例如：今天想到的事';
  const select = $('#folder-select'); select.replaceChildren();
  for (const folder of ['', ...state.folders.sort((a, b) => a.localeCompare(b, 'zh-CN'))]) {
    const option = document.createElement('option'); option.value = folder; option.textContent = folder || '笔记库根目录'; select.append(option);
  }
  select.value = mode === 'rename' ? note.folder : selectedFolder; $('#dialog-error').textContent = ''; $('#name-dialog').showModal(); $('#name-input').focus();
}
$('#name-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); $('#dialog-submit').disabled = true;
  try {
    const name = validName($('#name-input').value), folder = $('#folder-select').value;
    const message = dialogMode === 'folder' ? {type: 'FOLDER', name, parent: folder} : dialogMode === 'rename' ? {type: 'RENAME', id: active, rev: noteFor(active).rev, title: name, folder} : {type: 'CREATE', title: name, folder};
    const result = await api(message); apply(result.state); $('#name-dialog').close();
    if (result.noteId) openNote(result.noteId);
    else { selectedFolder = [folder, name].filter(Boolean).join('/'); expanded.add(''); expanded.add(folder); expanded.add(selectedFolder); renderTree(); remember(); }
  } catch (e) { $('#dialog-error').textContent = e.message; } finally { $('#dialog-submit').disabled = false; }
});
$('#name-form button[value="cancel"]').onclick=()=>$('#name-dialog').close();
$('#name-input').addEventListener('keydown',event=>{
  if(event.key!=='Enter' || event.isComposing || event.keyCode===229)return;
  event.preventDefault();if(!$('#dialog-submit').disabled)$('#name-form').requestSubmit($('#dialog-submit'));
});
$('#new-note').onclick = $('#welcome-new').onclick = () => nameDialog('create');
$('#new-folder').onclick = () => nameDialog('folder'); $('#rename').onclick = () => nameDialog('rename');
$('#export-note').onclick = async () => {
  const note=noteFor(active);if(!note)return;
  try {
    const blocks=structuredClone(visibleBlocks(note));
    for(const block of blocks)if(block.type==='image')block.src=await imageURL(block);
    const blob=new Blob([documentText({...note,blocks,quotes:visibleQuotes(note)})],{type:'text/markdown;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=note.title+'.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch(error){notice(error.message);}
};
$('#search').oninput = renderTree;
function setTree(open) { $('#library').hidden = !open; $('#toggle-tree').setAttribute('aria-expanded', String(open)); }
$('#toggle-tree').onclick = () => { setTree(true); scanFiles(); };
document.addEventListener('pointerdown', event => { if (!event.target.closest('#library,#toggle-tree,#new-folder')) setTree(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') {setTree(false);if(embedded)parent.postMessage({type:'READER_IMAGE_CLOSE'},'*');} });
function hoverMenu(trigger, panel, open, close) {
  let timer;
  const show = () => { clearTimeout(timer); open(); };
  const hide = () => { clearTimeout(timer); timer = setTimeout(close, 100); };
  for (const element of [trigger, panel]) { element.addEventListener('mouseenter', show); element.addEventListener('mouseleave', hide); }
  trigger.addEventListener('focus', show);
  panel.addEventListener('focusout', () => { if (!panel.contains(document.activeElement)) hide(); });
}
hoverMenu($('#toggle-tree'), $('#library'), () => { setTree(true); scanFiles(); }, () => setTree(false));
hoverMenu($('#format-more summary'), $('.format-menu'), () => $('#format-more').open = true, () => $('#format-more').open = false);
$('#format-more summary').onclick = event => { event.preventDefault(); $('#format-more').open = true; };
const setup = () => api({type: 'OPEN_SETUP'}).catch(e => notice(e.message));
$('#setup').onclick = $('#authorize').onclick = setup;
$('#later').onclick = () => { $('#setup-card').hidden = true; chrome.storage.local.set({setupDismissed: true}); };
function openSettings() { $('#auto-return').checked = state.autoReturn; for(const input of document.querySelectorAll('[data-type-color]'))input.value=(state.blockColors || defaults)[input.dataset.typeColor] || defaults[input.dataset.typeColor]; $('#folder-status').textContent = state.vaultName ? state.vaultName + (state.permission === 'granted' ? ' · 已连接' : (state.storageMode === 'native' ? ' · 文件组件未连接' : ' · 需要重新授权')) : '尚未设置电脑文件夹'; if (!$('#settings-dialog').open) { const r = $('#settings').getBoundingClientRect(); $('#settings-dialog').style.top = r.bottom + 4 + 'px'; $('#settings-dialog').show(); } }
$('#settings').onclick = openSettings;
hoverMenu($('#settings'), $('#settings-dialog'), openSettings, () => $('#settings-dialog').close());
$('#settings-close').onclick = () => $('#settings-dialog').close();
$('#auto-return').onchange = async () => { try { const result = await api({type: 'SETTINGS', autoReturn: $('#auto-return').checked}); apply(result.state); } catch (e) { notice(e.message); } };
for (const [selector, type, success] of [['#sync', 'SYNC', '已完成保存重试，请查看笔记底部状态'], ['#refresh', 'REFRESH', '已读取文件夹更新；如有冲突，已保留副本']]) {
  $(selector).onclick = async () => {
    $(selector).disabled = true;
    try { const result = await api({type}); apply(result.state);  notice(success); }
    catch (e) { notice(e.message); } finally { $(selector).disabled = false; }
  };
}
$('#export').onclick = async () => {
  try {
    const result=await api({type:'BACKUP'});
    const notes=result.state.notes.map(n=>{const doc=localDocs.get(n.id);return doc?{...n,blocks:doc.blocks,quotes:doc.quotes,text:blockText(doc.blocks)}:n;});
    const blob=new Blob([JSON.stringify({format:'gpt-reader-backup-v2',exported:new Date().toISOString(),folders:result.state.folders,blockColors:result.state.blockColors,notes,assets:result.assets || []},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='GPT阅读助手备份-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch(error){notice(error.message);}
};
chrome.runtime.onMessage.addListener(message => { if (message.type === 'VAULT_CHANGED') setTimeout(refreshState, 80); });
chrome.storage.onChanged.addListener(changes => { if (changes.setupDismissed?.newValue) $('#setup-card').hidden = true; if (changes.pageTheme?.newValue) {document.documentElement.dataset.theme = changes.pageTheme.newValue;renderBlocks();} });
document.addEventListener('visibilitychange', () => { publishTarget(); if (!document.hidden) { refreshState(); scanFiles(); } });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (active) saveInput(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); nameDialog('create'); }
});
try {
  const settings = await chrome.storage.local.get(['panelState', 'setupDismissed', 'pageTheme']);
  if (settings.pageTheme) document.documentElement.dataset.theme = settings.pageTheme;
  const saved = settings.panelState || {}; opened = saved.opened || []; active = saved.active || ''; selectedFolder = saved.selectedFolder || ''; expanded = new Set(saved.expanded || ['']);
  const result = await api({type: 'SCAN'}); apply(result.state);
  $('#setup-card').hidden = !!state.vaultName || !!settings.setupDismissed;
  if (noteFor(active)) openNote(active); else if (opened.length) openNote(opened[0]);
} catch (e) { notice(e.message); $('#save-status').textContent = '笔记库打开失败'; }

for(const input of document.querySelectorAll('[data-type-color]'))input.oninput=async()=>{try{const blockColors={...(state.blockColors || defaults),[input.dataset.typeColor]:input.value};apply((await api({type:'SETTINGS',blockColors})).state);}catch(error){notice(error.message);}};
document.addEventListener('pointerover',event=>{
  const trigger=event.target.closest('button[title],label[title],button[data-hint],label[data-hint]');if(!trigger)return;
  if(trigger.title){trigger.dataset.hint=trigger.title;if(!trigger.getAttribute('aria-label'))trigger.setAttribute('aria-label',trigger.title);trigger.removeAttribute('title');}
  formatTip.textContent=trigger.dataset.hint;formatTip.hidden=false;const r=trigger.getBoundingClientRect();
  formatTip.style.left=Math.max(6,Math.min(r.left,innerWidth-formatTip.offsetWidth-6))+'px';formatTip.style.top=Math.min(r.bottom+5,innerHeight-formatTip.offsetHeight-6)+'px';
});
document.addEventListener('pointerout',event=>{const trigger=event.target.closest('[data-hint]');if(trigger && !trigger.contains(event.relatedTarget))formatTip.hidden=true;});
document.addEventListener('pointerdown',()=>formatTip.hidden=true);
window.addEventListener('beforeunload',event=>{if(importingImages){event.preventDefault();event.returnValue='';}});
window.addEventListener('beforeunload',flushPendingSaves);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>renderBlocks());
document.addEventListener('click',event=>{
  if(!active || event.target.closest('.format-tools'))return;
  const keepId=event.target.closest('.block-insert')?activeBlockId:event.target.closest('#block-editor .note-block')?.dataset.blockId || '';
  if(!keepId){quoteAnchors.delete(active);readingIntent=false;readingSelected=false;}
  discardEmptyBlocks(active,keepId);
});
window.addEventListener('blur',()=>{clearTimeout(readingTimer);readingTimer=setTimeout(()=>{if(active && !readingIntent && !readingSelected && !document.activeElement?.closest('.block-color'))discardEmptyBlocks(active);},100);});
window.addEventListener('pagehide',()=>{if(active)discardEmptyBlocks(active);flushPendingSaves();});
