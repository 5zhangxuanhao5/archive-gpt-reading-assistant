import {get, put} from './db.js';
import {rootHandle} from './folder-files.js';
const MAX_IMAGE = 20 * 1024 * 1024;
const synced = new Map();
export function resetImageSync() { synced.clear(); }
const types = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif'};
const ASSET_PATH = /^\.gpt-reader-assets\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(png|jpg|gif|webp|bmp|avif)$/i;
const typeForExtension = extension => Object.keys(types).find(type => types[type] === extension);
function validateImage(bytes, mime) {
  const first = String.fromCharCode(...bytes.subarray(0, 32));
  const valid = mime === 'image/png' ? bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b) :
    mime === 'image/jpeg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    mime === 'image/gif' ? bytes.length >= 13 && /^GIF8[79]a/.test(first) :
    mime === 'image/webp' ? bytes.length >= 16 && first.startsWith('RIFF') && first.slice(8,12) === 'WEBP' :
    mime === 'image/bmp' ? bytes.length >= 26 && first.startsWith('BM') :
    mime === 'image/avif' ? bytes.length >= 16 && first.slice(4,8) === 'ftyp' && /avif|avis/.test(first) : false;
  if (!valid) throw new Error('图片内容无效；支持 PNG、JPEG、GIF、WebP、BMP、AVIF');
}
function decodeDataURL(dataURL) {
  if (typeof dataURL !== 'string' || dataURL.length > Math.ceil(MAX_IMAGE / 3) * 4 + 100) throw new Error('每张图片不能超过 20 MB');
  const match = dataURL.match(/^data:(image\/(?:png|jpeg|gif|webp|bmp|avif));base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match) throw new Error('请选择常用图片文件；不支持 SVG 或网页代码');
  let bytes;
  try { bytes = Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0)); } catch { throw new Error('图片数据无效'); }
  if (!bytes.length || bytes.length > MAX_IMAGE) throw new Error('每张图片不能超过 20 MB');
  const mime = match[1].toLowerCase(); validateImage(bytes, mime); return {bytes, mime};
}
function base64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(''));
}
function assetReference(imageId, src) {
  const match = typeof src === 'string' && src.match(ASSET_PATH);
  if (match && imageId && imageId !== match[1]) throw new Error('图片标识与文件路径不一致');
  if (src && !match) throw new Error('图片路径无效');
  if (!imageId && match) imageId = match[1];
  if (typeof imageId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(imageId)) throw new Error('图片标识无效');
  return {imageId, src, match};
}
async function fileAt(root, src, create = false) {
  const dir = await root.getDirectoryHandle('.gpt-reader-assets', {create});
  return dir.getFileHandle(src.split('/').at(-1), {create});
}
async function readAsset(reference) {
  const {imageId, src, match} = reference; if (!src) throw new Error('图片文件路径缺失');
  const root = await rootHandle(); if (!root || await root.queryPermission({mode:'readwrite'}) !== 'granted') throw new Error('图片尚未在浏览器中备份，请连接原笔记文件夹');
  let bytes;
  const file = await (await fileAt(root,src)).getFile(); if (file.size > MAX_IMAGE) throw new Error('每张图片不能超过 20 MB'); bytes = new Uint8Array(await file.arrayBuffer());
  const mime = typeForExtension(match[2].toLowerCase()); validateImage(bytes,mime);
  const asset = {imageId,src,mime,bytes}; await put('asset:'+imageId,asset); return asset;
}
export async function imageAsset(imageId, src) {
  const reference=assetReference(imageId,src); const cached=await get('asset:'+reference.imageId);
  if (cached && (!src || cached.src === src)) return cached;
  return readAsset(reference);
}
export function prepareImage(dataURL, alt) {
  const {bytes,mime}=decodeDataURL(dataURL); const imageId=crypto.randomUUID(); const src='.gpt-reader-assets/'+imageId+'.'+types[mime];
  return {imageId,src,mime,bytes,alt:String(alt||'').slice(0,1000)};
}
export async function storeImage(dataURL, alt) { const asset=prepareImage(dataURL,alt); await put('asset:'+asset.imageId,asset); return {imageId:asset.imageId,src:asset.src}; }
export async function getImage(imageId,src) {
  const asset=await imageAsset(imageId,src); return {dataURL:'data:'+asset.mime+';base64,'+base64(asset.bytes)};
}
export async function syncImages(note) {
  const images=(note.blocks||[]).filter(block=>block.type==='image'); if (!images.length) return;
  const root=await rootHandle(); if (!root) throw new Error('尚未设置文件夹；已保存在浏览器本地');
  for (const block of images) {
    assetReference(block.imageId,block.src);
    let current;
    try { current = await (await fileAt(root,block.src)).getFile(); }
    catch (error) { if (error.name!=='NotFoundError') throw error; }
    const stamp=current ? current.lastModified+':'+current.size : '';
    if (stamp && synced.get(block.imageId)===stamp) continue;
    const asset=await imageAsset(block.imageId,block.src);
      if (current) {
        const existing=new Uint8Array(await current.arrayBuffer());
        if (existing.length!==asset.bytes.length || existing.some((byte,i)=>byte!==asset.bytes[i])) throw new Error('图片文件已被其他软件修改，已保留浏览器备份');
      } else {
        const file=await fileAt(root,asset.src,true); const writable=await file.createWritable();
        try { await writable.write(asset.bytes); await writable.close(); } catch (error) { await writable.abort().catch(()=>{}); throw error; }
        current=await file.getFile();
      }
    synced.set(block.imageId,current.lastModified+':'+current.size);
  }
}
export async function backupAssets(notes) {
  const seen=new Set(), assets=[];
  for (const note of notes) for (const block of note.blocks||[]) if (block.type==='image' && !seen.has(block.imageId)) {
    seen.add(block.imageId); const result=await getImage(block.imageId,block.src); assets.push({imageId:block.imageId,src:block.src,...result});
  }
  return assets;
}
export function validateImageBlocks(blocks) {
  for (const block of blocks) if (block.type==='image') assetReference(block.imageId,block.src);
}
