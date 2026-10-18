import {validName,uniqueTitle,migrateNote,normalizeBlocks,blockText,documentText,jumpURL} from './core.js';
import {prepareImage} from './media.js';

function folder(value) {
  if(typeof value!=='string'||value.length>2000)throw Error('备份文件夹格式无效');
  const parts=value.split('/');
  if(value&&parts.length>20)throw Error('文件夹层级过多');
  return value?parts.map(validName).join('/'):'';
}
// Validate everything before writing. Imports add copies; existing notes,
// assets, settings and the optional folder binding are never overwritten.
export function prepareBackupImport(input,current) {
  if(!input||input.format!=='gpt-reader-backup-v2'||!Array.isArray(input.notes)||input.notes.length>2000||!Array.isArray(input.assets)||input.assets.length>10000||!Array.isArray(input.folders)||input.folders.length>10000)throw Error('不是支持的 GPT阅读助手备份（v2）');
  const state=structuredClone(current),assets=[],mapping=new Map();let bytes=0;
  for(const original of input.assets) {
    if(typeof original?.imageId!=='string'||!original.imageId||mapping.has(original.imageId))throw Error('备份图片标识重复或无效');
    const asset=prepareImage(original.dataURL,original.alt);
    bytes+=asset.bytes.length;if(bytes>48*1024*1024)throw Error('备份图片总量超过 48 MB，请分批导入');
    assets.push(asset);mapping.set(original.imageId,asset);
  }
  const folders=new Set(state.folders);let firstId='';
  function addFolder(value){const path=folder(value);if(path){const parts=path.split('/');for(let i=1;i<=parts.length;i++)folders.add(parts.slice(0,i).join('/'));}return path;}
  for(const value of input.folders)addFolder(value);
  for(const original of input.notes) {
    if(!original||typeof original!=='object'||!Array.isArray(original.quotes)||original.quotes.length>10000)throw Error('备份笔记格式无效');
    const quoteIds=new Set();
    const quotes=original.quotes.map(q=>{
      if(typeof q?.id!=='string'||!/^\w[\w-]{0,99}$/.test(q.id)||quoteIds.has(q.id)||typeof q.text!=='string'||q.text.length>100000)throw Error('备份引用无效');
      quoteIds.add(q.id);jumpURL(q.source);
      return {id:q.id,text:q.text,source:structuredClone(q.source),created:Number.isFinite(q.created)?q.created:Date.now()};
    });
    const migrated=migrateNote({text:original.text,blocks:original.blocks,quotes,quoteLayout:original.quoteLayout});
    const blocks=normalizeBlocks(migrated.blocks,quotes);
    for(const block of blocks) {
      block.id=crypto.randomUUID();
      if(block.type==='image') {
        const asset=mapping.get(block.imageId);if(!asset)throw Error('备份中缺少笔记所需的图片，原数据未改动');
        block.imageId=asset.imageId;block.src=asset.src;
      }
    }
    const path=addFolder(original.folder||''),title=uniqueTitle(state.notes,path,validName(original.title));
    const note={id:crypto.randomUUID(),title,folder:path,blocks,quotes,quoteLayout:'inline',text:blockText(blocks),rev:1,updated:Date.now()};
    if(documentText(note).length>8*1024*1024)throw Error('单篇笔记超过 8 MB');
    firstId ||= note.id;state.notes.push(note);
  }
  state.folders=[...folders];state.version=(state.version||0)+1;
  return {state,assets,count:input.notes.length,firstId};
}
