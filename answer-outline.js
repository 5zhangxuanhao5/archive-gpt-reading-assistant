// Tracks the actual answer structure at the reader's position, including text leaves.
(() => {
  if (globalThis.GPTReaderIndexWorker) return;
  const DOM = globalThis.YuejiDOM;
  const selector = 'h1,h2,h3,h4,h5,h6,[role="heading"][aria-level]';
  const owners = new WeakMap();
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const speaker = text => /^(?:chatgpt(?: said|\s*说|\s*說)?|assistant|助手|助理)\s*[:：]?$/i.test(clean(text));
  const excluded = node => node.closest('pre,code,nav,header,footer,button,[role="button"],aside,form,[contenteditable="true"],[hidden],[inert],[aria-hidden="true"]');
  function headingsOf(message) {
    return DOM.elementsOf(message, selector).filter(node => !excluded(node) && !speaker(node.textContent) && clean(node.textContent) && node.getClientRects().length);
  }
  const rawLevel = node => Number(node.tagName.match(/^H([1-6])$/)?.[1] || node.getAttribute('aria-level'));
  const visible = node => !excluded(node) && node.getClientRects().length && clean(node.textContent);
  function ownListText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('ul,ol,menu,' + selector + ',pre,button,[role="button"],nav,[hidden],[aria-hidden="true"]').forEach(child => child.remove());
    return clean(DOM.textOf(clone));
  }
  function structureOf(message) {
    const headingNodes = headingsOf(message), headingIndices = new Map(headingNodes.map((node,index) => [node,index]));
    const nodes = DOM.elementsOf(message, selector + ',p,li,tr').filter(visible), stack = [], entries = [], listParents = new Map(), ids = new Set();
    for (const node of nodes) {
      if (entries.length >= 2000) break;
      let kind, text, level, htmlLevel, headingIndex;
      if (node.matches(selector)) {
        htmlLevel = rawLevel(node);
        if (speaker(node.textContent) || !Number.isInteger(htmlLevel) || htmlLevel < 1 || htmlLevel > 24) continue;
        while (stack.length && stack.at(-1).htmlLevel >= htmlLevel) stack.pop();
        level = Math.min(24, stack.length + 1); stack.push({htmlLevel,level});
        kind = 'heading'; text = clean(DOM.textOf(node)); headingIndex = headingIndices.get(node);
      } else {
        // A list item represents its own text only; its nested list is separate.
        // Markdown often wraps that same text in a paragraph, which must not be duplicated.
        if (node.matches('p') && node.closest('li')) continue;
        const parentList = node.parentElement?.closest('li');
        const listDepth = parentList && listParents.has(parentList) ? listParents.get(parentList) + 1 : (stack.at(-1)?.level || 0) + 1;
        level = Math.min(24, listDepth);
        kind = node.matches('li') ? 'list' : 'text';
        text = kind === 'list' ? ownListText(node) : clean(DOM.textOf(node));
      }
      if (!text || speaker(text)) continue;
      if (kind === 'list') listParents.set(node, level);
      const storedId = node.dataset.gptReaderOutline || (kind === 'heading' ? node.dataset.gptReaderHeading : '');
      const id = storedId && !ids.has(storedId) ? storedId : node.id && !ids.has(node.id) ? node.id : 'gpt-reader-' + (kind === 'heading' ? 'heading-' : 'outline-') + crypto.randomUUID();
      ids.add(id);
      if (id !== node.id) node.dataset.gptReaderOutline = id;
      if (kind === 'heading' && id !== node.id) node.dataset.gptReaderHeading = id;
      entries.push({node,id,text,level,kind,...(htmlLevel ? {htmlLevel,headingIndex} : {})});
    }
    // Plain text replies can consist of a text node directly inside their wrapper.
    if (!entries.length && visible(message) && !speaker(message.textContent)) {
      const text = clean(DOM.textOf(message));
      if (text) {
        const id = message.id || message.dataset.gptReaderOutline || 'gpt-reader-outline-' + crypto.randomUUID();
        if (!message.id) message.dataset.gptReaderOutline = id;
        entries.push({node:message,id,text,level:1,kind:'text'});
      }
    }
    return entries;
  }
  function visibleBounds(message) {
    const boxes = speaker(message.textContent) ? [] : [...message.getClientRects()];
    if (!boxes.length || boxes.every(rect => !rect.height || !rect.width)) {
      for (const leaf of DOM.elementsOf(message, 'p,li,pre,h1,h2,h3,h4,h5,h6,blockquote,table')) {
        if (!excluded(leaf)) boxes.push(...leaf.getClientRects());
      }
    }
    const valid = boxes.filter(rect => rect.width > 0 && rect.height > 0);
    if (!valid.length) return null;
    let top = 0, bottom = innerHeight;
    for (let parent = message.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY) && parent.clientHeight > 0) {
        const clip = parent.getBoundingClientRect();top = Math.max(top, clip.top);bottom = Math.min(bottom, clip.bottom);
      }
    }
    const composer = document.querySelector('#prompt-textarea,form textarea,form [contenteditable="true"]')?.closest('form,[data-thread-scroll-footer]');
    if (composer && /fixed|sticky/.test(getComputedStyle(composer).position)) {
      const box = composer.getBoundingClientRect();if (box.top > top && box.bottom >= bottom - 60) bottom = Math.min(bottom, box.top);
    }
    if (bottom <= top) return null;
    const start = Math.min(...valid.map(rect => rect.top)),end = Math.max(...valid.map(rect => rect.bottom));
    const visible = Math.max(0, Math.min(end,bottom) - Math.max(start,top));
    if (!visible) return null;
    const readingLine = top + Math.min(200,(bottom - top) * .33);
    const distance = readingLine < start ? start - readingLine : readingLine > end ? readingLine - end : 0;
    return {visible,distance};
  }
  function snapshot() {
    DOM.scan();
    const route = location.pathname + location.search;
    const all = DOM.messages('assistant');
    const messages = all.filter(node => {
      const previous=owners.get(node),id=DOM.idOf(node),text=DOM.textOf(node);
      if(previous && previous.route!==route && previous.id===id && previous.text===text)return false;
      owners.set(node,{route,id,text});return true;
    });
    const candidates = messages.map(node => ({node,box:visibleBounds(node)})).filter(item => item.box).sort((a,b) => a.box.distance - b.box.distance || b.box.visible - a.box.visible);
    const url = location.href.split('#')[0], message = candidates[0]?.node;
    if (!message) return {url,messageId:'',messageIndex:-1,title:'当前回答',headings:[],maxLevel:0};
    const messageId = DOM.idOf(message),messageIndex = all.indexOf(message);
    const headings = structureOf(message).slice(0,2000).map(({node,id,text,level,kind,htmlLevel,headingIndex},index) => {
      return {id,text,level,kind,...(htmlLevel ? {htmlLevel} : {}),source:{url,role:'assistant',messageId,messageIndex,text:text.slice(0,180),outlineId:id,outlineIndex:index,...(kind === 'heading' ? {headingId:id,headingIndex} : {})}};
    });
    return {url,messageId,messageIndex,title:headings.find(item => item.kind === 'heading')?.text || clean(DOM.textOf(message)).slice(0,80) || '当前回答',headings,maxLevel:headings.reduce((max,item) => Math.max(max,item.level),0)};
  }
  function findTarget(message,source) {
    if (source.outlineId || Number.isInteger(source.outlineIndex)) {
      const entries = structureOf(message);
      const byId = entries.find(entry => source.outlineId && entry.id === source.outlineId);
      if (byId) return byId.node;
      const indexed = entries[source.outlineIndex];
      if (indexed && indexed.text.startsWith(clean(source.text))) return indexed.node;
      // IDs are transient when another conversation is re-rendered; text and
      // the structural index still identify the original leaf after navigation.
      const matches = entries.filter(entry => entry.text.startsWith(clean(source.text)));
      if (matches.length === 1) return matches[0].node;
    }
    return findHeading(message,source);
  }
  function findHeading(message,source) {
    const nodes = headingsOf(message);
    return nodes.find(node => source.headingId && (node.id === source.headingId || node.dataset.gptReaderHeading === source.headingId)) ||
      (Number.isInteger(source.headingIndex) && clean(nodes[source.headingIndex]?.textContent).startsWith(clean(source.text)) ? nodes[source.headingIndex] : null);
  }
  globalThis.GPTAnswerOutline = {snapshot,findHeading,findTarget};
})();
