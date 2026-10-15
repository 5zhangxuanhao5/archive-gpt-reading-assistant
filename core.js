export function plainPaste(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim() !== '').join('\n');
}
export function validName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name.length > 100 || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])([.]|$)/i.test(name)) {
    throw new Error('名称不能为空，也不能包含 / \\ : * ? " < > |，请用 100 字以内的名称。');
  }
  return name;
}
export function notePath(note) { return [note.folder, note.title + '.md'].filter(Boolean).join('/'); }
export function samePath(a, b) { return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase(); }
export function uniqueTitle(notes, folder, title) {
  let candidate = title, i = 2;
  while (notes.some(n => samePath(notePath(n), [folder, candidate + '.md'].filter(Boolean).join('/')))) candidate = title + ' ' + i++;
  return candidate;
}
export const DEFAULT_BLOCK_COLORS = Object.freeze({text: '#f3f6fc', image: '#fff5e8', quote: '#f1edfb'});
export const quoteMarker = id => '<!-- gpt-reader-quote:' + id + ' -->';
const excerptDivider = '\n\n<!-- yueji-excerpts:v1 -->\n\n';
const newId = () => crypto.randomUUID();
const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const color = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
export function normalizeBlocks(blocks, quotes = []) {
  if (!Array.isArray(blocks) || blocks.length > 10000) throw new Error('笔记框格式无效，单篇最多 1 万个框');
  const ids = new Set(); const quoteIds = new Set(quotes.map(q => q.id));
  return blocks.map(input => {
    if (!input || !['text', 'empty', 'image', 'quote'].includes(input.type)) throw new Error('笔记框类型无效');
    const id = validId(input.id) && !ids.has(input.id) ? input.id : newId(); ids.add(id);
    const result = {id, type: input.type}; const override = color(input.color); if (override) result.color = override;
    if (input.type === 'text' || input.type === 'empty') { result.text = String(input.text || ''); result.type = result.text ? 'text' : 'empty'; }
    if (input.type === 'quote') {
      if (!validId(input.quoteId) || !quoteIds.has(input.quoteId)) throw new Error('引用框缺少原文信息');
      result.quoteId = input.quoteId;
    }
    if (input.type === 'image') {
      if (!validId(input.imageId) || typeof input.src !== 'string') throw new Error('图片框缺少图片信息');
      result.imageId = input.imageId; result.src = input.src; result.alt = String(input.alt || '').slice(0, 1000);
    }
    return result;
  });
}
function legacyBlocks(text, quotes) {
  const result = []; const quoteIds = new Set((quotes || []).map(q => q.id)); let start = 0;
  for (const match of String(text || '').matchAll(/^<!-- gpt-reader-quote:([\w-]+) -->$/gm)) {
    if (!quoteIds.has(match[1])) continue;
    const before = text.slice(start, match.index); if (before.trim()) result.push({id: newId(), type: 'text', text: before});
    result.push({id: newId(), type: 'quote', quoteId: match[1]}); start = match.index + match[0].length;
  }
  const last = String(text || '').slice(start); if (last.trim()) result.push({id: newId(), type: 'text', text: last});
  return result;
}
export function migrateNote(note) {
  note.text = String(note.text || ''); note.quotes ||= [];
  if (note.quoteLayout !== 'inline') {
    const missing = note.quotes.filter(q => !note.text.includes(quoteMarker(q.id)));
    if (missing.length) note.text += (note.text ? '\n\n' : '') + missing.map(q => quoteMarker(q.id)).join('\n\n') + '\n\n';
    note.quoteLayout = 'inline';
  }
  if (!Array.isArray(note.blocks)) note.blocks = legacyBlocks(note.text, note.quotes);
  return note;
}
export function noteBlocks(note) { return migrateNote(note).blocks; }
function imageMarkdown(block, folder = '') {
  const prefix = block.src.startsWith('data:') ? '' : '../'.repeat(folder.split('/').filter(Boolean).length);
  const alt = String(block.alt || '').replace(/[\\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return '![' + alt + '](' + prefix + block.src + ')';
}
export function blockText(blocks) {
  return (blocks || []).map(block => block.type === 'quote' ? quoteMarker(block.quoteId) : block.type === 'image' ? imageMarkdown(block) : String(block.text || '')).join('\n\n');
}
function quoteMarkdown(quote) {
  const {text, ...metadata} = quote;
  const quoted = text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n');
  return '<!-- yueji-quote:' + encodeURIComponent(JSON.stringify(metadata)) + ' -->\n' + quoted + '\n\n[↵ 返回原文](' + jumpURL(quote.source) + ')\n<!-- /yueji-quote -->';
}
export function documentText(note) {
  if (Array.isArray(note.blocks)) {
    const quotes = new Map((note.quotes || []).map(q => [q.id, q]));
    return note.blocks.map(block => {
      const metadata = {id: block.id, type: block.type};
      if (block.color) metadata.color = block.color;
      if (block.type === 'quote') metadata.quoteId = block.quoteId;
      if (block.type === 'image') { metadata.imageId = block.imageId; metadata.src = block.src.startsWith('data:') ? '' : block.src; metadata.alt = block.alt || ''; }
      const content = block.type === 'quote' ? (quotes.has(block.quoteId) ? quoteMarkdown(quotes.get(block.quoteId)) : quoteMarker(block.quoteId)) : block.type === 'image' ? imageMarkdown(block, note.folder) : String(block.text || '');
      return '<!-- gpt-reader-block:' + encodeURIComponent(JSON.stringify(metadata)) + ' -->\n' + content + '\n<!-- /gpt-reader-block:' + block.id + ' -->';
    }).join('\n\n') + (note.blocks.length ? '\n' : '');
  }
  if (note.quoteLayout !== 'inline') {
    if (!note.quotes?.length) return note.text;
    return note.text + excerptDivider + note.quotes.map(quoteMarkdown).join('\n\n') + '\n';
  }
  const quotes = new Map((note.quotes || []).map(q => [q.id, q]));
  return note.text.replace(/^<!-- gpt-reader-quote:([\w-]+) -->$/gm, (marker, id) => quotes.has(id) ? quoteMarkdown(quotes.get(id)) : marker);
}
export function parseDocument(text) {
  const quotes = []; const legacy = text.includes(excerptDivider);
  const body = text.replace(excerptDivider, '\n\n').replace(/<!-- yueji-quote:(.*?) -->\n([\s\S]*?)\n\n\[↵ 返回原文\]\([^\n]*\)\n<!-- \/yueji-quote -->/g, (block, encoded, content) => {
    try {
      const quote = JSON.parse(decodeURIComponent(encoded)); quote.text = content.replace(/^> ?/gm, '');
      if (!validId(quote.id) || !quote.source?.url) return block;
      jumpURL(quote.source); if (quotes.some(existing => existing.id === quote.id)) quote.id = newId(); quotes.push(quote); return quoteMarker(quote.id);
    } catch { return block; }
  });
  const blocks = []; let start = 0; let recognized = false;
  for (const match of body.matchAll(/<!-- gpt-reader-block:([^\n]*?) -->\n([\s\S]*?)\n<!-- \/gpt-reader-block:([\w-]+) -->/g)) {
    try {
      const metadata = JSON.parse(decodeURIComponent(match[1]));
      if (metadata.id !== match[3]) continue;
      const candidate = {...metadata};
      if (candidate.type === 'text' || candidate.type === 'empty') candidate.text = match[2];
      if (candidate.type === 'quote') { const marker=match[2].trim().match(/^<!-- gpt-reader-quote:([\w-]+) -->$/); if (marker) candidate.quoteId=marker[1]; }
      if (candidate.type === 'image' && !candidate.src) { const embedded = match[2].match(/^!\[[\s\S]*?\]\((data:image\/[^\n]+)\)$/); if (embedded) candidate.src = embedded[1]; }
      const normalized = normalizeBlocks([candidate], quotes)[0];
      const before = body.slice(start, match.index); if (before.trim()) blocks.push(...legacyBlocks(before, quotes));
      blocks.push(normalized); recognized = true; start = match.index + match[0].length;
    } catch { /* Unrecognized metadata remains literal Markdown, preserving the file. */ }
  }
  if (recognized) {
    const after = body.slice(start); if (after.trim()) blocks.push(...legacyBlocks(after, quotes));
    return {text: blockText(blocks), blocks: normalizeBlocks(blocks, quotes), quotes, quoteLayout: 'inline'};
  }
  const plain = legacy && quotes.length ? body.trimEnd() + '\n\n' : body;
  return {text: plain, blocks: legacyBlocks(plain, quotes), quotes, quoteLayout: 'inline'};
}
export function insertionPoint(text, anchor) {
  let cursor = Number.isInteger(anchor?.cursor) ? Math.max(0, Math.min(anchor.cursor, text.length)) : text.length;
  if (anchor?.before && text.slice(Math.max(0, cursor - anchor.before.length), cursor) !== anchor.before) {
    const candidates = []; let start = 0, found;
    while ((found = text.indexOf(anchor.before, start)) >= 0) { const end = found + anchor.before.length; if (!anchor.after || text.slice(end, end + anchor.after.length) === anchor.after) candidates.push(end); start = found + 1; }
    cursor = candidates.length ? candidates.sort((a,b) => Math.abs(a-cursor)-Math.abs(b-cursor))[0] : text.length;
  }
  const end = text.indexOf('\n', cursor); return end < 0 ? text.length : end;
}
export function jumpURL(source) {
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) throw new Error('原文必须来自 ChatGPT 网页');
  url.hash = 'yueji=' + encodeURIComponent(JSON.stringify({messageId: source.messageId || '', role: source.role, messageIndex: source.messageIndex, text: source.text?.slice(0, 180) || '', ...(source.headingId ? {headingId:String(source.headingId).slice(0,300)} : {}), ...(Number.isInteger(source.headingIndex) && source.headingIndex >= 0 ? {headingIndex:source.headingIndex} : {}), ...(source.outlineId ? {outlineId:String(source.outlineId).slice(0,300)} : {}), ...(Number.isInteger(source.outlineIndex) && source.outlineIndex >= 0 && source.outlineIndex < 2000 ? {outlineIndex:source.outlineIndex} : {})}));
  return url.href;
}
