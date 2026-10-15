// Uses a temporary background chat tab for indexing; never scrolls the reading tab.
(() => {
  const DOM = globalThis.YuejiDOM;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const keyOf = item => item.id ? 'id:' + item.id : 'text:' + item.text;
  function merge(previous, snapshot, prepend = false) {
    if (prepend && snapshot.length && !snapshot.some(item => previous.some(q => keyOf(q) === keyOf(item)))) return [...snapshot, ...previous];
    const result = previous.map(item => ({...item}));
    let cursor = 0;
    for (let i = 0; i < snapshot.length; i++) {
      const item = snapshot[i], key = keyOf(item), existing = result.findIndex(q => keyOf(q) === key);
      if (existing >= 0) { result[existing] = {...result[existing], ...item}; cursor = existing + 1; continue; }
      const next = snapshot.slice(i + 1).map(keyOf).map(key => result.findIndex(q => keyOf(q) === key)).find(index => index >= 0);
      if (next !== undefined) cursor = next;
      else if (!i && result.length) cursor = result.length;
      result.splice(cursor++, 0, {...item});
    }
    return result;
  }
  function scroller() {
    const message = DOM.messages('user')[0] || DOM.messages('assistant')[0];
    for (let parent = message?.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 5) return parent;
    }
    return document.querySelector('.thread-scroll-container,[data-thread-scroll-container]') || document.scrollingElement;
  }
  function bounds(element) {
    const extent = Math.max(0, element.scrollHeight - element.clientHeight);
    const reverse = getComputedStyle(element).flexDirection === 'column-reverse';
    return {min: reverse ? -extent : 0, max: reverse ? 0 : extent, extent};
  }
  function move(element, top) {
    const before = element.style.scrollBehavior; element.style.scrollBehavior = 'auto'; element.scrollTop = top; element.style.scrollBehavior = before;
    element.dispatchEvent(new Event('scroll'));
  }
  function snapshot(element = scroller()) {
    DOM.scan();
    const {min, extent} = bounds(element), rect = element === document.scrollingElement ? {top: 0} : element.getBoundingClientRect();
    const occurrences = new Map();
    return DOM.messages('user').map(node => {
      const text = DOM.textOf(node) || '（附件或图片提问）';
      let id = DOM.idOf(node);
      if (!id) { const count = occurrences.get(text) || 0; occurrences.set(text, count + 1); id = 'fallback:' + text + ':' + count; }
      return {id, text, position: extent ? Math.max(0, Math.min(1, (element.scrollTop - min + node.getBoundingClientRect().top - rect.top) / extent)) : 0};
    });
  }
  async function walk({signal, onSnapshot = () => {}, stopWhen = () => null, maxMs = 180000} = {}) {
    const start = Date.now(), path = location.pathname;
    const check = () => { if (signal?.aborted || location.pathname !== path) throw new DOMException('已停止', 'AbortError'); if (Date.now() - start > maxMs) throw new Error('聊天较长或加载较慢，目录尚未补全；可继续补全'); };
    let container;
    while (!DOM.scan().length) { check(); if (Date.now() - start > 45000) throw new Error('聊天尚未加载，可稍后继续补全目录'); await pause(300); }
    container = scroller();
    let last = '', stableSince = Date.now();
    // Stay at the earliest edge long enough for asynchronously prepended history.
    while (true) {
      check(); container = scroller(); const limits = bounds(container); move(container, limits.min);
      await pause(300); check(); const rows = snapshot(container); onSnapshot(rows, 'start');
      const hit = stopWhen(); if (hit) return {hit, complete: false};
      const signature = container.scrollHeight + ':' + rows[0]?.id + ':' + rows.length;
      const loading = document.querySelector('main [aria-busy="true"],main [role="progressbar"],main [data-testid="loading"]');
      if (signature !== last || loading) { last = signature; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 2700) break;
    }
    // Walk down with overlap: virtualized turns disappear from the DOM after scrolling.
    let stableBottom = 0;
    while (true) {
      check(); container = scroller(); const limits = bounds(container);
      const rows = snapshot(container); onSnapshot(rows, 'walk');
      const hit = stopWhen(); if (hit) return {hit, complete: false};
      if (container.scrollTop >= limits.max - 3) {
        if (++stableBottom >= 5) return {complete: true};
        move(container, limits.max);
      } else { stableBottom = 0; move(container, Math.min(limits.max, container.scrollTop + Math.max(160, container.clientHeight * .65))); }
      await pause(220);
    }
  }
  async function seek(find, position, signal) {
    DOM.scan(); let hit = find(); if (hit) return hit;
    if (Number.isFinite(position)) {
      const element = scroller(), {min, extent} = bounds(element); move(element, min + position * extent); await pause(300); DOM.scan(); hit = find(); if (hit) return hit;
    }
    const result = await walk({signal, stopWhen: find, maxMs: 120000}); return result.hit || null;
  }
  globalThis.GPTReaderHistory = {keyOf, merge, snapshot, walk, seek, scroller, bounds};
  const token = location.hash.match(/^#gpt-reader-index=([\w-]+)$/)?.[1];
  if (!token) return;
  globalThis.GPTReaderIndexWorker = true;
  (async () => {
    const ready = await chrome.runtime.sendMessage({type: 'INDEX_WORKER_READY', token});
    if (!ready?.ok) { history.replaceState(history.state, '', location.href.split('#')[0]); location.reload(); return; }
    const abort = new AbortController();
    chrome.runtime.onMessage.addListener((message, sender, reply) => { if (message.type === 'STOP_INDEX') { reply({ok: true}); abort.abort(); } });
    let collected = [], at = 0, done = false;
    const progress = async (complete = false, error = '') => {
      at = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await chrome.runtime.sendMessage({type: 'INDEX_PROGRESS', token, items: collected, complete, error});
          if (!result?.ok) throw new DOMException('已停止', 'AbortError');
          return result;
        } catch (failure) { if (failure.name === 'AbortError' || attempt === 2) throw failure; await pause(250); }
      }
    };
    const keepAlive = setInterval(() => { if (!done) progress().catch(() => abort.abort()); }, 10000);
    try {
      await walk({signal: abort.signal, onSnapshot: (rows, phase) => {
        collected = merge(collected, rows, phase === 'start');
        if (Date.now() - at > 600) progress().catch(() => abort.abort());
      }});
      done = true; await progress(true);
    } catch (error) { done = true; await progress(false, error.name === 'AbortError' ? '已暂停，可继续补全' : error.message).catch(() => {}); }
    finally { clearInterval(keepAlive); }
  })().catch(() => {});
})();
