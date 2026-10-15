// Read message semantics across ChatGPT layouts without relying on one attribute.
(() => {
  const roots = 'main,[role="main"],#thread';
  const containers = 'article,section,[data-testid^="conversation-turn"],[data-turn-id],[data-message-id],[data-message-author-role],[data-message-role],[data-turn-role],[data-author],[data-role],[data-message-author],[data-chatgpt-search-unit-key],[data-content-search-unit-key],.user-message,.assistant-message';
  const speaker = text => {
    const value = String(text || '').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
    if (/^(you(?: said)?|你(?:说|說)|您(?:说|說)|用户|使用者)\s*[:：]?$/i.test(value)) return 'user';
    if (/^(chatgpt(?: said|\s*说|\s*說)?|assistant|助手|助理)\s*[:：]?$/i.test(value)) return 'assistant';
    return '';
  };
  const attrRole = node => {
    for (const attr of ['data-message-author-role', 'data-message-role', 'data-turn-role', 'data-author', 'data-role', 'data-message-author']) {
      const value = node.getAttribute(attr)?.toLowerCase();
      if (['user', 'human'].includes(value)) return 'user';
      if (['assistant', 'ai', 'chatgpt'].includes(value)) return 'assistant';
    }
    const unit = node.getAttribute('data-chatgpt-search-unit-key') || node.getAttribute('data-content-search-unit-key') || '';
    if (unit.endsWith(':user')) return 'user';
    if (unit.endsWith(':assistant')) return 'assistant';
    if (node.matches('.user-message,[data-testid="user-message"]') || node.classList.contains('group/user-message')) return 'user';
    if (node.matches('.assistant-message,[data-testid="assistant-message"]')) return 'assistant';
    return '';
  };
  const isContent = node => {
    if (!node.isConnected || node.closest('nav,header,aside,form,[contenteditable="true"],[hidden],[inert],[aria-hidden="true"],#yueji-dock')) return false;
    if (node.getClientRects().length) return true;
    // A display:contents wrapper has no box, although its message is visible.
    if (getComputedStyle(node).display !== 'contents') return false;
    const range = document.createRange(); range.selectNodeContents(node);
    return range.getClientRects().length > 0;
  };
  let records = [], lookup = new WeakMap();
  function scan() {
    const found = [];
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(node => speaker(node.textContent) && isContent(node));
    const add = (node, role, heading = null, range = null) => {
      if (!node || !role || !isContent(node) || found.some(r => r.node === node)) return;
      found.push({node, role, heading, range});
    };
    for (const node of document.querySelectorAll(containers)) {
      const role = attrRole(node);
      if (role) add(node, role);
    }
    // Nested wrappers should represent a single message, not duplicate it.
    for (let i = found.length - 1; i >= 0; i--) {
      if (found.some((r, j) => j !== i && r.role === found[i].role && found[i].node.contains(r.node))) found.splice(i, 1);
    }
    for (const heading of headings) {
      if (found.some(r => r.node.contains(heading))) continue;
      let candidate = heading.parentElement;
      let best = null;
      while (candidate && !candidate.matches('body,html,' + roots)) {
        if (headings.filter(h => candidate.contains(h)).length !== 1) break;
        best = candidate; candidate = candidate.parentElement;
      }
      // Prefer a turn wrapper when it contains only this speaker's message.
      const turn = heading.closest('article,section,[data-testid^="conversation-turn"],[data-turn-id]');
      if (turn && headings.filter(h => turn.contains(h)).length === 1) best = turn;
      const role = speaker(heading.textContent);
      if (best && found.some(r => r.role === role && best.contains(r.node))) continue;
      if (best && best.textContent.trim() !== heading.textContent.trim()) add(best, role, heading);
      else {
        // A layout may render its speaker and content as siblings rather than a wrapper.
        const root = heading.closest(roots);
        if (!root) continue;
        const range = document.createRange(); range.setStartAfter(heading);
        const next = headings.find(h => heading.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (next && root.contains(next)) range.setEndBefore(next); else range.setEnd(root, root.childNodes.length);
        add(heading, role, heading, range);
      }
    }
    found.sort((a, b) => a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    records = found; lookup = new WeakMap(records.map(record => [record.node, record]));
    return records;
  }
  function textOf(node) {
    const clone = lookup.get(node)?.range?.cloneContents() || node.cloneNode(true);
    clone.querySelectorAll('button,[role="button"],script,style,svg,nav,header,footer,form,[contenteditable="true"],[aria-hidden="true"],[hidden]').forEach(el => el.remove());
    clone.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').forEach(el => { if (speaker(el.textContent)) el.remove(); });
    const read = element => {
      if (element.nodeType === Node.TEXT_NODE) return element.textContent;
      if (![Node.ELEMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(element.nodeType)) return '';
      if (element.tagName === 'BR') return '\n';
      const content = [...element.childNodes].map(read).join('');
      return /^(P|DIV|LI|PRE|BLOCKQUOTE|TR|H[1-6])$/.test(element.tagName) ? content + '\n' : content;
    };
    return read(clone).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function messages(role) { return records.filter(r => r.role === role).map(r => r.node); }
  function locate(node, role) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return null;
    const matches = records.filter(record => (!role || record.role === role) && (record.range ? record.range.intersectsNode(element) : record.node.contains(element)));
    return matches.sort((a, b) => a.node.contains(b.node) ? 1 : -1)[0]?.node || null;
  }
  function idOf(node) {
    if (!node) return '';
    return node.getAttribute('data-message-id') || node.getAttribute('data-turn-id') || node.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/)[0] || node.querySelector('[data-message-id]')?.getAttribute('data-message-id') || node.closest('[data-turn-key]')?.getAttribute('data-turn-key') || node.closest('[data-testid^="conversation-turn"]')?.getAttribute('data-testid') || node.id || '';
  }
  function scopeOf(node) { const range = lookup.get(node)?.range; const scope = range?.commonAncestorContainer || node; return scope.nodeType === 1 ? scope : scope.parentElement; }
  function includes(node, child) { const range = lookup.get(node)?.range; return range ? range.intersectsNode(child) : node.contains(child); }
  function elementsOf(node, selector) { return [...scopeOf(node).querySelectorAll(selector)].filter(child => includes(node, child)); }
  globalThis.YuejiDOM = {scan, messages, locate, textOf, idOf, scopeOf, includes, elementsOf, roleOf: node => lookup.get(node)?.role || attrRole(node), pageRoot: node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest(roots)};
})();
