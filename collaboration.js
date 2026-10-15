// Three-way merges use the document the editor actually saw as their base.
// Independent edits commute. Ambiguous replacements keep both frames.
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function edits(before, after) {
  if (before === after) return [];
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const a = before.slice(prefix, before.length - suffix), b = after.slice(prefix, after.length - suffix);
  if (!a.length || !b.length) return [{from:prefix, to:before.length - suffix, insert:b}];
  let frontier = new Map([[1, 0]]), trace = [], distance = 0, found = false, work = 0;
  for (distance = 0; distance <= Math.min(a.length + b.length, 1500); distance++) {
    trace.push(new Map(frontier));
    for (let k = -distance; k <= distance; k += 2) {
      if (++work > 2000000) break;
      let x = k === -distance || (k !== distance && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1)) ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier.set(k, x);
      if (x >= a.length && y >= b.length) { found = true; break; }
    }
    if (found || work > 2000000) break;
  }
  if (!found) return [{from:prefix, to:before.length - suffix, insert:b}];
  let x = a.length, y = b.length; const steps = [];
  for (let d = distance; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const previousK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const previousX = v.get(previousK) ?? 0, previousY = previousX - previousK;
    while (x > previousX && y > previousY) { steps.push(['=', a[--x]]); y--; }
    if (d > 0) { if (x === previousX) steps.push(['+', b[--y]]); else steps.push(['-', a[--x]]); }
  }
  steps.reverse(); const result = []; let position = prefix, current;
  for (const [type, character] of steps) {
    if (type === '=') { current = null; position++; }
    else { if (!current) { current = {from:position, to:position, insert:''}; result.push(current); } if (type === '-') { position++; current.to++; } else current.insert += character; }
  }
  return result;
}

export function mergeText(base, local, remote) {
  base = String(base ?? ''); local = String(local ?? ''); remote = String(remote ?? '');
  if (local === remote || remote === base) return {text:local};
  if (local === base) return {text:remote};
  const changes = edits(base, remote).map(change => ({...change, side:0}));
  for (const change of edits(base, local)) {
    let duplicate = false;
    for (const other of changes) {
      if (equal({from:other.from,to:other.to,insert:other.insert}, change)) { duplicate = true; break; }
      const point = change.from === change.to, otherPoint = other.from === other.to;
      const overlaps = point && otherPoint ? false : point ? change.from > other.from && change.from < other.to : otherPoint ? other.from > change.from && other.from < change.to : Math.max(change.from,other.from) < Math.min(change.to,other.to);
      if (overlaps) return {text:remote, conflict:true};
    }
    if (!duplicate) changes.push({...change, side:1});
  }
  changes.sort((a,b) => a.from - b.from || a.to - b.to || a.side - b.side);
  let text = '', position = 0;
  for (const change of changes) { text += base.slice(position, change.from) + change.insert; position = Math.max(position, change.to); }
  return {text:text + base.slice(position)};
}

export function mergeDocuments(base, local, remote) {
  const result = clone(remote), conflicts = [];
  result.blocks ||= []; result.quotes ||= [];
  const resultIds = new Set(result.blocks.map(block => block.id));
  const old = new Map((base.blocks || []).map(block => [block.id,block]));
  const mine = new Map((local.blocks || []).map(block => [block.id,block]));
  const theirs = new Map((remote.blocks || []).map(block => [block.id,block]));
  const baseQuotes = new Map((base.quotes || []).map(quote => [quote.id,quote]));
  const localQuotes = new Map((local.quotes || []).map(quote => [quote.id,quote]));
  const remoteQuotes = new Map((remote.quotes || []).map(quote => [quote.id,quote]));
  const content = (block,quotes) => block?.type === 'quote' ? {...block,quote:quotes.get(block.quoteId)} : block;
  const insertAfterLocal = (block,index) => {
    const preceding = local.blocks.slice(0,index).reverse().find(item => resultIds.has(item.id));
    const following = preceding ? null : local.blocks.slice(index + 1).find(item => resultIds.has(item.id));
    const at = preceding ? result.blocks.findIndex(item => item.id === preceding.id) + 1 : following ? result.blocks.findIndex(item => item.id === following.id) : result.blocks.length;
    result.blocks.splice(at,0,clone(block));
    resultIds.add(block.id);
    if (block.type === 'quote' && !result.quotes.some(quote => quote.id === block.quoteId) && localQuotes.has(block.quoteId)) result.quotes.push(clone(localQuotes.get(block.quoteId)));
  };
  for (const [id,before] of old) {
    if (mine.has(id)) continue;
    const current = theirs.get(id);
    if (current && equal(content(before,baseQuotes),content(current,remoteQuotes))) { result.blocks = result.blocks.filter(block => block.id !== id); resultIds.delete(id); }
    else if (current) conflicts.push(id); // Deleting an edited frame keeps that edited frame.
  }
  for (let index = 0; index < (local.blocks || []).length; index++) {
    const block = local.blocks[index], before = old.get(block.id), current = theirs.get(block.id);
    if (!before) {
      if (!current) insertAfterLocal(block,index);
      else if (!equal(content(block,localQuotes),content(current,remoteQuotes))) {
        const preserved = clone(block); preserved.id = crypto.randomUUID(); conflicts.push(block.id);
        if (preserved.type === 'quote') { const quote = clone(localQuotes.get(preserved.quoteId)); if (quote) { quote.id = crypto.randomUUID(); preserved.quoteId = quote.id; result.quotes.push(quote); } }
        result.blocks.splice(result.blocks.findIndex(item => item.id === current.id) + 1,0,preserved);
        resultIds.add(preserved.id);
      }
      continue;
    }
    if (equal(content(before,baseQuotes),content(block,localQuotes))) continue;
    if (!current) { insertAfterLocal(block,index); conflicts.push(block.id); continue; }
    let merged = clone(current), conflict = false;
    const textType = item => ['text','empty'].includes(item.type);
    if ((textType(before) && textType(block) && textType(current)) || (before.type === 'quote' && block.type === 'quote' && current.type === 'quote' && block.quoteId === before.quoteId && current.quoteId === before.quoteId)) {
      const quote = before.type === 'quote';
      const mergedText = mergeText(quote ? baseQuotes.get(before.quoteId)?.text : before.text, quote ? localQuotes.get(block.quoteId)?.text : block.text, quote ? remoteQuotes.get(current.quoteId)?.text : current.text);
      conflict = !!mergedText.conflict;
      if (quote) { const item = result.quotes.find(q => q.id === current.quoteId); if (item) item.text = mergedText.text; }
      else { merged.text = mergedText.text; merged.type = mergedText.text ? 'text' : 'empty'; }
      if (block.color !== before.color) { if (current.color === before.color || current.color === block.color) { if (block.color) merged.color = block.color; else delete merged.color; } else conflict = true; }
    } else if (equal(content(before,baseQuotes),content(current,remoteQuotes))) merged = clone(block);
    else if (!equal(content(block,localQuotes),content(current,remoteQuotes))) conflict = true;
    if (conflict) {
      conflicts.push(block.id);
      const preserved = clone(block); preserved.id = crypto.randomUUID();
      if (preserved.type === 'quote') { const quote = clone(localQuotes.get(preserved.quoteId)); if (quote) { quote.id = crypto.randomUUID(); preserved.quoteId = quote.id; result.quotes.push(quote); } }
      result.blocks.splice(result.blocks.findIndex(item => item.id === current.id) + 1,0,preserved);
      resultIds.add(preserved.id);
    } else {
      result.blocks[result.blocks.findIndex(item => item.id === current.id)] = merged;
      if (merged.type === 'quote' && merged.quoteId !== current.quoteId && localQuotes.has(merged.quoteId)) result.quotes.push(clone(localQuotes.get(merged.quoteId)));
    }
  }
  const used = new Set(result.blocks.filter(block => block.type === 'quote').map(block => block.quoteId));
  if (result.blocks.length > 10000) throw new Error('协同合并后的笔记超过 1 万个框，请拆分笔记后重试');
  result.quotes = result.quotes.filter(quote => used.has(quote.id));
  return {blocks:result.blocks,quotes:result.quotes,conflicts};
}
