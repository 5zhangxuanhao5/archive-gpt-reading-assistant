(() => {
  if (globalThis.GPTReaderIndexWorker) return;
  const send = message => { try { return chrome.runtime.sendMessage(message); } catch(error) { return Promise.reject(error); } };
  if (document.getElementById('yueji-dock')) return;
  const host = document.createElement('div'); host.id = 'yueji-dock';
  let domObserver = null, observedRoot = null;
  const observerOptions = {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'inert', 'aria-hidden', 'data-message-author-role', 'data-turn-id', 'data-message-id']};
  function ensureMounted() {
    const root = document.documentElement;
    if (domObserver && root && observedRoot !== root) { domObserver.disconnect(); domObserver.observe(root, observerOptions); observedRoot = root; }
    if (host.isConnected) return false;
    const parent = document.body || root;
    if (!parent) return false;
    parent.append(host); return true;
  }
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;right:6px;top:42%;z-index:2147483000;font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;color:#0d0d0d;font-size:13px}
    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #777;outline-offset:2px}
    .dock{display:flex;flex-direction:column;gap:2px;padding:3px;border:1px solid #e8e8e8;border-radius:12px;background:#fff;box-shadow:0 2px 8px #00000008}
    .tool{background:none;color:#555;border:0;width:34px;min-height:34px;border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;font-size:9px}
    .dock-handle{display:none;border:1px solid #e5e5e5;background:#fff;color:#666;width:20px;height:28px;border-radius:9px 0 0 9px;padding:0;font-size:16px}:host([data-collapsed="true"]) .dock{display:none;position:absolute;right:0;top:-42px}:host([data-collapsed="true"]) .dock-handle{display:block}:host([data-collapsed="true"]:hover) .dock,:host([data-collapsed="true"][data-keyboard="true"]:focus-within) .dock{display:flex}:host([data-collapsed="true"]:hover) .dock-handle,:host([data-collapsed="true"][data-keyboard="true"]:focus-within) .dock-handle{visibility:hidden}.tool svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.tool:hover,.tool.active{background:#ededed}.tool:disabled{opacity:.35;cursor:default}
    .outline{position:absolute;right:46px;top:-125px;width:min(330px,calc(100vw - 100px));max-height:70vh;border:1px solid #e5e5e5;border-radius:14px;background:#fff;box-shadow:0 8px 28px #00000016;display:flex;flex-direction:column;padding:17px}
    [hidden]{display:none!important}.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}.head strong{font-size:16px;letter-spacing:0}.close{border:0;background:none;font-size:21px;color:#777;padding:0 5px}
    input{width:100%;border:1px solid #eee;border-radius:8px;background:#f7f7f8;padding:9px;color:inherit}.list{overflow:auto;margin-top:12px;overscroll-behavior:contain}.item{width:100%;border:0;border-bottom:1px solid #eee;background:none;color:inherit;text-align:left;display:flex;gap:10px;padding:11px 7px;line-height:1.6;border-radius:6px}.item:hover,.item.current{background:#ededed}.number{font-size:11px;color:#888;min-width:22px;padding-top:2px}.text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.empty{padding:25px 8px;color:#888;line-height:1.8}.foot{font-size:11px;color:#888;margin-top:12px}
    .tooltip{position:fixed;width:min(400px,calc(100vw - 24px));max-height:50vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;padding:15px;background:#fff;color:#0d0d0d;border:1px solid #ddd;border-radius:12px;box-shadow:0 8px 35px #0002;pointer-events:auto;font-size:13px}
    .toast{position:absolute;right:46px;top:20px;width:210px;background:#242424;color:#fff;padding:11px 14px;border-radius:10px;line-height:1.6;pointer-events:none}
    @media(prefers-color-scheme:dark){:host{color:#ececec}.dock,.outline{background:#212121;border-color:#444}.tool{color:#ccc}.tool:hover,.tool.active,.item:hover,.item.current{background:#3b3b3b}input{background:#2f2f2f;color:#ececec;border-color:#444}.item{border-bottom-color:#444}}
  </style><button class="dock-handle" aria-label="展开阅读工具" title="历史、目录与笔记">‹</button><nav class="dock" aria-label="阅读工具"><button class="tool" id="outline-toggle" title="查看这段对话的历史提问"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h10"/></svg>历史</button><button class="tool" id="answer-outline-toggle" title="查看当前回答的标题目录"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h11M9 12h11M9 19h11"/><path d="M4 5h.01M4 12h.01M4 19h.01"/></svg>目录</button><button class="tool" id="notes" title="打开本地多标签笔记"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/></svg>笔记</button><button class="tool" id="return" title="回到本聊天的阅读定位" disabled hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12"/></svg>返回</button></nav><section class="outline" aria-label="历史提问" hidden><div class="head"><strong>历史提问</strong><button class="close" title="关闭历史">×</button></div><input id="search" placeholder="搜索这次对话的提问" aria-label="搜索提问"><div class="list"></div><div class="foot"></div></section><div class="tooltip" hidden></div><div class="toast" role="status" hidden></div>`;
  const selectionButton = document.createElement('button'); selectionButton.className = 'selection-tool'; selectionButton.hidden = true; selectionButton.textContent = '插入到当前笔记';
  shadow.append(selectionButton);
  const selectionStyle = document.createElement('style'); selectionStyle.textContent = '.selection-tool{position:fixed;border:1px solid #ddd;background:#fff;color:#333;border-radius:9px;padding:8px 12px;font-size:12px;white-space:nowrap;box-shadow:0 4px 16px #00000014;z-index:5}.selection-tool:hover{background:#eee}.selection-tool:disabled{opacity:.6}@media(prefers-color-scheme:dark){.selection-tool{background:#2f2f2f;color:#ececec;border-color:#444}.selection-tool:hover{background:#3b3b3b}}'; shadow.append(selectionStyle);
  ensureMounted();
  const $ = selector => shadow.querySelector(selector);
  let questions = [], catalog = [], signature = '', route = location.pathname + location.search, retiredMessages = new Map(), bookmark = null, pending = null, followupIntent = null;
  let historyRequested = '', historyState = {}, seekAbort;
  let lastLiveNodes = [];
  let autoReturn = true, guardTimer, guardStart = 0, guardSeen = 0, refreshTimer, toastTimer;
  let noteTarget = null, selectedQuote = null, selectionTimer, selectionVersion = 0, jumpTimer;
  const DOM = globalThis.YuejiDOM;
  const History = globalThis.GPTReaderHistory;
  const Answer = globalThis.GPTAnswerOutline;
  const Position = globalThis.GPTReadingPosition;
  let positionLoad=0, positionTimer, positionGesture=null, positionClick=null, returnAbort;
  const locationMark=document.createElement('span');locationMark.className='reading-mark';locationMark.setAttribute('aria-hidden','true');locationMark.hidden=true;shadow.append(locationMark);
  const locationStyle=document.createElement('style');locationStyle.textContent='.reading-mark{position:fixed;width:7px;height:7px;border:1.5px solid #8f8f8f;border-radius:50%;pointer-events:none;background:#fff;opacity:.75}:host([data-theme=dark]) .reading-mark{background:#212121;border-color:#b4b4b4}';shadow.append(locationStyle);
  function updatePositionMark(){const target=bookmark?.chat===Position.key() && Position.resolve(bookmark);const rect=target?.range?.getBoundingClientRect();if(!rect?.height || rect.top<20 || rect.top>innerHeight-35 || document.getElementById('gpt-reader-image')){locationMark.hidden=true;return;}const box=target.leaf.getBoundingClientRect();locationMark.style.left=Math.max(7,box.left-15)+'px';locationMark.style.top=rect.top+rect.height/2-3+'px';locationMark.hidden=false;}
  function showPosition(){const available=!!bookmark && bookmark.chat===Position.key();$('#return').disabled=!available;$('#return').hidden=!available;updatePositionMark();}
  async function loadPosition(){const chat=Position.key(),ticket=++positionLoad;bookmark=null;showPosition();if(!chat)return;try{const result=await send({type:'READING_POSITION_GET',url:chat});if(ticket===positionLoad && chat===Position.key() && !bookmark){bookmark=result?.position || null;showPosition();}}catch{}}
  function setPosition(position){bookmark=position;++positionLoad;followupIntent=null;pending=null;showPosition();send({type:'READING_POSITION_SET',url:position.chat,position}).then(result=>{if(!result?.ok)throw new Error(result?.error || '保存失败');}).catch(()=>toast('定位暂存在此页面，后台保存暂未完成'));}
  const hasSelection=()=>!!getSelection()?.toString().trim();
  const interactive=event=>event.composedPath().includes(host) || event.composedPath().some(node=>node?.id==='gpt-reader-panel' || node?.id==='gpt-reader-image') || event.target.closest?.('a,button,[role=button],input,textarea,select,form,[contenteditable=true],nav,aside,header,footer,[role=dialog],[role=menu],summary,label');
  let answerOutline = null, answerSignature = '', answerRefreshTimer;
  function publishAnswerOutline(force = false) {
    if (!Answer) return;
    const outline = Answer.snapshot(), next = JSON.stringify(outline); answerOutline = outline;
    if (!force && next === answerSignature) { positionDock(); return; }
    answerSignature = next; positionDock(); send({type: 'ANSWER_OUTLINE', outline}).catch(() => {});
  }
  const userNodes = () => DOM.messages('user');
  const assistantNodes = () => DOM.messages('assistant');
  const scrollerFor = node => {
    for (let p = node?.parentElement; p; p = p.parentElement) {
      const css = getComputedStyle(p);
      if (/(auto|scroll)/.test(css.overflowY) && p.scrollHeight > p.clientHeight + 5) return p;
    }
    return document.scrollingElement;
  };
  function positionDock() {
    const panel=document.getElementById('gpt-reader-panel');
    if(panel && !panel.hidden){host.style.right=(panel.getBoundingClientRect().width+6)+'px';host.dataset.collapsed='true';return;}
    const messages=assistantNodes(),current=messages.find(node=>answerOutline?.messageId && DOM.idOf(node)===answerOutline.messageId) || messages[answerOutline?.messageIndex];
    const leaves=current ? DOM.elementsOf(current,'.markdown,.prose,p,li,pre,h1,h2,h3,h4,h5,h6,table,blockquote') : [];
    const boxes=leaves.map(node=>node.getBoundingClientRect()).filter(rect=>rect.width>0 && rect.bottom>0 && rect.top<innerHeight);
    if(!boxes.length && current){const rect=current.getBoundingClientRect();if(rect.width>0)boxes.push(rect);}
    const right=boxes.length?Math.max(...boxes.map(rect=>rect.right)):innerWidth-50,gap=innerWidth-right;
    host.dataset.collapsed=gap<46?'true':'false';host.style.right=gap>=46?Math.max(4,(gap-42)/2)+'px':'2px';
  }
  function toast(text) { $('.toast').textContent = text; $('.toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('.toast').hidden = true, 1600); }
  function tooltip(item, text) {
    const tip = $('.tooltip'); tip.textContent = text; tip.hidden = false;
    const rect = item.getBoundingClientRect();
    const width = tip.getBoundingClientRect().width;
    let left = rect.left - width - 12;
    if (left < 12) left = Math.max(12, rect.left);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(12, Math.min(rect.top, innerHeight - tip.offsetHeight - 12)) + 'px';
  }
  function render() {
    const list = $('.list'); list.replaceChildren();
    const query = $('#search').value.toLowerCase();
    const visible = questions.filter(q => q.text.toLowerCase().includes(query));
    for (const q of visible) {
      const item = document.createElement('button'); item.className = 'item';
      const number = document.createElement('span'); number.className = 'number'; number.textContent = String(q.index + 1).padStart(2, '0');
      const text = document.createElement('span'); text.className = 'text'; text.textContent = q.text;
      item.append(number, text); item.setAttribute('aria-label', q.text);
      item.addEventListener('mouseenter', () => tooltip(item, q.text));
      item.addEventListener('mouseleave', e => { if (!e.relatedTarget || !$('.tooltip').contains(e.relatedTarget)) $('.tooltip').hidden = true; });
      item.addEventListener('focus', () => tooltip(item, q.text)); item.addEventListener('blur', () => $('.tooltip').hidden = true);
      item.addEventListener('click', async () => {
        cancelGuard(); $('.tooltip').hidden = true;
        pending = null; followupIntent = null; seekAbort?.abort(); seekAbort = new AbortController();
        const find = () => q.id && !q.id.startsWith('fallback:') ? userNodes().find(node => DOM.idOf(node) === q.id) : userNodes().find(node => DOM.textOf(node) === q.text);
        try {
          let node = find();
          if (!node) { toast('正在加载这条提问…'); node = await History.seek(find, q.position, seekAbort.signal); }
          if (!node) throw new Error('这条提问尚未加载，请稍后再试');
          node.scrollIntoView({behavior: 'instant', block: 'center'});
          node.animate([{outline: '3px solid #8ab4f8', outlineOffset: '8px'}, {outline: '3px solid transparent', outlineOffset: '8px'}], {duration: 1700});
        } catch (error) { if (error.name !== 'AbortError') toast(error.message); }
      }); list.append(item);
    }
    if (!visible.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = questions.length ? '没有找到对应的提问' : '打开一段对话后，你的提问会显示在这里。'; list.append(empty); }
    const foot = $('.foot'); foot.replaceChildren(document.createTextNode(`${questions.length} 条提问 · ${historyState.loading ? '正在后台补全…' : historyState.complete ? '已补全至开头' : '悬浮查看全文'}`));
    if (historyState.error) {
      const retry = document.createElement('button'); retry.textContent = '继续补全'; retry.title = historyState.error;
      retry.style.cssText = 'border:0;background:none;color:inherit;text-decoration:underline;padding:3px;';
      retry.onclick = () => { historyRequested = ''; requestHistory(); }; foot.append(' · ', retry);
    }
  }
  const currentRoute = () => location.pathname + location.search;
  const historyURL = () => location.origin + location.pathname;
  function rebuildQuestions(nodes) {
    const live = History.snapshot().filter(item => nodes.some(node => DOM.idOf(node) === item.id || DOM.textOf(node) === item.text));
    catalog = History.merge(catalog, live);
    questions = catalog.map((q, index) => ({...q, index, node: q.id && !q.id.startsWith('fallback:') ? nodes.find(node => DOM.idOf(node) === q.id) : nodes.find(node => DOM.textOf(node) === q.text)}));
  }
  async function requestHistory() {
    if (!/\/c\/[^/]+\/?$/.test(location.pathname) || !questions.length || historyRequested === historyURL()) return;
    const url = historyURL(); historyRequested = url; historyState = {loading: true}; render();
    try {
      const result = await send({type: 'REQUEST_OUTLINE', url});
      if (url !== historyURL()) return;
      if (!result?.ok) throw new Error(result?.error || '后台补全暂不可用');
      receiveHistory(result);
    } catch (error) { if (url === historyURL()) { historyState = {error: error.message}; render(); } }
  }
  function receiveHistory(message) {
    if (message.url !== historyURL()) return;
    const before = questions.map(q => q.id + ':' + q.text).join('\u0000') + JSON.stringify([historyState.loading, historyState.complete, historyState.error]);
    historyState = message;
    catalog = message.complete ? [...message.items] : History.merge(message.items || [], catalog);
    DOM.scan(); rebuildQuestions(userNodes());
    const after = questions.map(q => q.id + ':' + q.text).join('\u0000') + JSON.stringify([historyState.loading, historyState.complete, historyState.error]);
    if (before !== after && !$('.outline').hidden) render();
  }
  function refresh() {
    if (route !== currentRoute()) {
      retiredMessages = new Map(questions.filter(q => q.node?.isConnected).map(q => [q.node, {text: q.text, id: DOM.idOf(q.node)}]));
      questions = []; catalog = []; lastLiveNodes = []; historyState = {}; historyRequested = ''; seekAbort?.abort();
      send({type: 'CANCEL_OUTLINE'}).catch(() => {});
      $('.tooltip').hidden = true; if (!$('.outline').hidden) render();
      route = currentRoute(); clearTimeout(positionTimer);positionGesture=null;positionClick=null;returnAbort?.abort();pending = null; followupIntent = null; cancelGuard();loadPosition();signature = ''; $('#search').value = '';
      selectionButton.hidden = true; selectedQuote = null; registerReader();
    }
    DOM.scan();
    const nodes = userNodes().filter(node => !retiredMessages.has(node) || retiredMessages.get(node).text !== DOM.textOf(node) || retiredMessages.get(node).id !== DOM.idOf(node));
    const next = nodes.map((node, i) => (DOM.idOf(node) || i) + ':' + DOM.textOf(node)).join('\u0000');
    if (next !== signature || nodes.length !== lastLiveNodes.length || nodes.some((node, i) => node !== lastLiveNodes[i])) {
      const changed = next !== signature;
      signature = next; lastLiveNodes = nodes;
      rebuildQuestions(nodes);
      if (!$('.outline').hidden) render();
      if (changed && pending && pending.path === location.pathname && nodes.some(node => {
        const text = normalized(DOM.textOf(node)), key = History.keyOf({id: DOM.idOf(node), text: DOM.textOf(node)});
        return !pending.keys.has(key) && pending.expected && text.includes(pending.expected);
      })) {
        const saved = pending.bookmark; pending = null;
        if (autoReturn) startGuard(saved);
        else toast('已记住阅读位置，点击“返回”继续阅读');
      }
    }
    if (pending && Date.now() - pending.at > 60000) pending = null;
    if (!$('.outline').hidden) requestHistory();
    publishAnswerOutline();
  }
  function captureSelection() {
    captureQuoteSelection();
    if(hasSelection()){if(positionGesture)positionGesture.selected=true;positionClick=null;clearTimeout(positionTimer);}
  }
  function registerReader() {
    send({type: 'REGISTER_READER', pageUrl: location.href.split('#')[0]}).then(result => { noteTarget = result?.target || null; if (!noteTarget) selectionButton.hidden = true; }).catch(() => {});
  }
  function captureQuoteSelection() {
    DOM.scan();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) { selectionButton.hidden = true; selectedQuote = null; selectionVersion++; return; }
    const element = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
    if (element?.closest('input,textarea,form,[contenteditable="true"],nav,aside,header')) { selectionButton.hidden = true; selectedQuote = null; selectionVersion++; return; }
    const message = DOM.locate(element) || DOM.pageRoot(element);
    const focusElement = selection.focusNode?.nodeType === 1 ? selection.focusNode : selection.focusNode?.parentElement;
    if (!message || !(DOM.locate(focusElement) === message || (DOM.pageRoot(element) === message && message.contains(focusElement)))) { selectionButton.hidden = true; selectedQuote = null; return; }
    const rects = [...selection.getRangeAt(0).getClientRects()].filter(r => r.bottom > 0 && r.top < innerHeight);
    if (!rects.length) return;
    const rect = rects.at(-1), role = DOM.roleOf(message) || 'page', text = selection.toString();
    selectedQuote = {text, source: {url: location.href.split('#')[0], role, messageId: DOM.idOf(message) || '', messageIndex: DOM.messages(role).indexOf(message), text: text.slice(0, 180)}};
    const version = ++selectionVersion; clearTimeout(selectionTimer);
    selectionTimer = setTimeout(async () => {
      try { const result = await send({type: 'GET_NOTE_TARGET', pageUrl: location.href.split('#')[0]}); noteTarget = result?.target || null; } catch { noteTarget = null; }
      if (version !== selectionVersion) return;
      if (!selectedQuote || !noteTarget) { selectionButton.hidden = true; return; }
      selectionButton.hidden = false; selectionButton.title = '插入到「' + noteTarget.title + '」';
      const native = [...document.querySelectorAll('button,[role="button"]')].find(button => /^(ask chatgpt|向\s*(chatgpt|gpt)\s*提问|询问\s*(chatgpt|gpt)|问问\s*(chatgpt|gpt))$/i.test((button.textContent || button.getAttribute('aria-label') || '').trim()) && button.getBoundingClientRect().width > 0);
      const nativeRect = native?.getBoundingClientRect();
      const width = selectionButton.offsetWidth, height = selectionButton.offsetHeight;
      let left = nativeRect ? nativeRect.right + 6 : rect.left;
      let top = nativeRect ? nativeRect.top : rect.bottom + 9;
      if (left + width > innerWidth - 12) { left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)); if (nativeRect) top = nativeRect.bottom + 6; }
      if (top + height > innerHeight - 12) top = Math.max(12, rect.top - height - 8);
      selectionButton.style.left = Math.max(12, left) + 'px'; selectionButton.style.top = Math.max(12, top) + 'px';
    }, 120);
  }
  selectionButton.addEventListener('mousedown', event => event.preventDefault());
  selectionButton.addEventListener('pointerdown', event => event.stopPropagation());
  selectionButton.onclick = async () => {
    if (!selectedQuote) return; selectionButton.disabled = true;
    try { const result = await send({type: 'INSERT_SELECTED_QUOTE', pageUrl: location.href.split('#')[0], quote: selectedQuote}); if (!result?.ok) throw new Error(result?.error || '插入失败'); toast('已插入「' + result.title + '」'); selectionButton.hidden = true; }
    catch (e) { toast(e.message); } finally { selectionButton.disabled = false; }
  };
  const normalized = text => text.replace(/\s+/g, ' ').trim();
  function jumpToSource(source) {
    clearInterval(jumpTimer); cancelGuard(); pending = null;
    let attempts = 0;
    const tryJump = () => {
      DOM.scan();
      const role = source.role === 'user' ? 'user' : source.role === 'page' ? 'page' : 'assistant';
      const messages = role === 'page' ? [...document.querySelectorAll('main,[role="main"],#thread')] : DOM.messages(role);
      const snippet = normalized(source.text || '');
      let message = messages.find(node => source.messageId && DOM.idOf(node) === source.messageId);
      if (!message) { const indexed = messages[source.messageIndex]; if (indexed && (!snippet || normalized(DOM.textOf(indexed)).includes(snippet))) message = indexed; }
      if (!message && snippet) message = messages.find(node => normalized(DOM.textOf(node)).includes(snippet));
      if (!message) { if (++attempts > 200) { clearInterval(jumpTimer); toast('未找到摘录原文。请确认对话仍存在且已加载。'); } return; }
      let leaf = Answer?.findTarget?.(message, source) || Answer?.findHeading?.(message, source) || (snippet ? DOM.elementsOf(message, 'p,li,pre,h1,h2,h3,h4,h5,h6,blockquote,td').find(node => normalized(node.textContent).includes(snippet)) : null);
      (leaf || message).scrollIntoView({behavior: 'instant', block: 'center'});
      // Highlight the exact selected text when it is present in the rendered DOM.
      const structuralTarget = source.outlineId || Number.isInteger(source.outlineIndex) || source.headingId || Number.isInteger(source.headingIndex);
      const highlightRoot = structuralTarget && leaf ? leaf : DOM.scopeOf(message);
      const walker = document.createTreeWalker(highlightRoot, NodeFilter.SHOW_TEXT); const nodes = []; let all = '', node;
      while ((node = walker.nextNode())) { if (!DOM.includes(message, node)) continue; nodes.push({node, start: all.length}); all += node.textContent; }
      const start = all.indexOf(source.text || '');
      if (source.text && start >= 0) {
        const end = start + source.text.length, first = nodes.find(n => start >= n.start && start < n.start + n.node.length), last = nodes.find(n => end > n.start && end <= n.start + n.node.length);
        if (first && last) {
          const range = document.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const rect = range.getBoundingClientRect(); const container = scrollerFor(first.node);
          if (rect.top < 80 || rect.bottom > innerHeight - 100) container.scrollTop += rect.top - Math.min(innerHeight / 3, 240);
        }
      }
      (leaf || message).animate([{outline: '3px solid #8ab4f8', outlineOffset: '6px'}, {outline: '3px solid transparent', outlineOffset: '6px'}], {duration: 2400});
      clearInterval(jumpTimer); toast(structuralTarget ? '已定位到原文' : '已返回摘录原文');
    };
    toast(source.outlineId || source.headingId ? '正在定位原文…' : '正在定位摘录原文…'); tryJump();
    // If history is still loading, retry until its message appears.
    if (attempts) jumpTimer = setInterval(tryJump, 300);
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'OUTLINE_HISTORY') receiveHistory(message);
    if (message.type === 'NOTE_TARGET') { noteTarget = message.target; if (!noteTarget) selectionButton.hidden = true; else if (selectedQuote) captureQuoteSelection(); }
    if (message.type === 'JUMP_TO_SOURCE') jumpToSource(message.source);
    if (message.type === 'REQUEST_ANSWER_OUTLINE') { publishAnswerOutline(true); reply({ok: true, outline: answerOutline}); }
    if (['OUTLINE_HISTORY', 'NOTE_TARGET', 'JUMP_TO_SOURCE'].includes(message.type)) reply({ok: true});
  });
  function restore(saved) { const restored=Position.restore(saved);if(restored)updatePositionMark();return restored; }
  function cancelGuard() { clearInterval(guardTimer); guardTimer = null; }
  function startGuard(saved) {
    cancelGuard(); guardStart = Date.now(); guardSeen = Date.now();
    restore(saved); toast('已回到阅读位置 · 滚动即可自由阅读');
    guardTimer = setInterval(() => {
      const streaming = document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop streaming"],button[aria-label*="停止"]');
      if (streaming) guardSeen = Date.now();
      if (Position.key() !== saved.chat || Date.now() - guardStart > 120000 || (Date.now() - guardStart > 15000 && Date.now() - guardSeen > 1800)) return cancelGuard();
      restore(saved);
    }, 160);
  }
  function prepareSend() {
    if (pending && Date.now() - pending.at < 800) return;
    cancelGuard(); pending = null;
    const intent = followupIntent; followupIntent = null;
    if (!intent || intent.path !== location.pathname || Date.now() - intent.at > 5 * 60000 || (intent.quoteSeen && !composerHasQuote(intent))) return;
    const composer = document.querySelector('#prompt-textarea,form textarea,form [contenteditable="true"]');
    const expected = normalized(composer?.value ?? composer?.innerText ?? '');
    if (!expected) return;
    DOM.scan();
    const keys = new Set([...catalog.map(History.keyOf), ...userNodes().map(node => History.keyOf({id: DOM.idOf(node), text: DOM.textOf(node)}))]);
    pending = {bookmark: intent.bookmark, keys, expected, path: location.pathname, at: Date.now()};
  }
  const askButton = target => {
    const button = target.closest?.('button,[role="button"]');
    return button && [button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].some(label => /^(ask\s*(?:chatgpt|gpt)|向\s*(?:chatgpt|gpt)\s*提问|询问\s*(?:chatgpt|gpt)|问问\s*(?:chatgpt|gpt))$/i.test(String(label || '').trim())) ? button : null;
  };
  function armFollowup() {
    if (!bookmark || bookmark.chat !== Position.key()) return;
    followupIntent = {bookmark: {...bookmark}, quoteText:getSelection()?.toString().trim() || selectedQuote?.text || '', at: Date.now(), path: location.pathname};
  }
  function composerHasQuote(intent) {
    const composer = document.querySelector('#prompt-textarea,form textarea,form [contenteditable="true"]');
    const root = composer?.closest('form,[data-thread-scroll-footer]') || composer?.parentElement;
    return !!root && !!intent.quoteText && normalized(root.textContent).includes(normalized(intent.quoteText));
  }
  document.addEventListener('selectionchange', captureSelection);
  document.addEventListener('pointerup', event=>{captureSelection();const gesture=positionGesture;positionGesture=null;positionClick=null;if(!gesture || gesture.chat!==Position.key() || event.button!==0 || gesture.moved || gesture.selected || gesture.hadSelection || hasSelection() || interactive(event))return;const position=Position.capture(event.target,event.clientX,event.clientY);if(position)positionClick={position,x:event.clientX,y:event.clientY};},true);
  document.addEventListener('pointermove',event=>{if(positionGesture && Math.hypot(event.clientX-positionGesture.x,event.clientY-positionGesture.y)>5)positionGesture.moved=true;},true);
  for(const type of ['pointercancel','dragstart','contextmenu'])document.addEventListener(type,()=>{positionGesture=null;positionClick=null;clearTimeout(positionTimer);},true);
  document.addEventListener('click', event => {
    if (askButton(event.target)) {clearTimeout(positionTimer);positionClick=null;armFollowup();}
    else if(positionClick && event.isTrusted && event.detail===1 && !interactive(event)){const candidate=positionClick;positionClick=null;clearTimeout(positionTimer);positionTimer=setTimeout(()=>{if(candidate.position.chat===Position.key() && !hasSelection())setPosition(candidate.position);},360);}else{positionClick=null;clearTimeout(positionTimer);}
    const button = event.target.closest?.('button');
    if (button && (button.matches('[data-testid="send-button"]') || /^(send|send prompt|send message|发送|发送提示|发送消息)$/i.test(button.getAttribute('aria-label') || '') || (button.type === 'submit' && button.closest('form')?.querySelector('#prompt-textarea,textarea,[contenteditable="true"]')))) prepareSend();
  }, true);
  document.addEventListener('submit', event => { if (event.target.querySelector('#prompt-textarea,textarea,[contenteditable="true"]')) prepareSend(); }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target.closest?.('#prompt-textarea,textarea,[contenteditable="true"]')) prepareSend();
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key) && !event.target.closest?.('input,textarea,[contenteditable="true"]')) { cancelGuard(); pending = null; followupIntent = null; seekAbort?.abort();returnAbort?.abort(); }
    if (event.key === 'Escape') { $('.outline').hidden = true; $('.tooltip').hidden = true; $('#outline-toggle').classList.remove('active'); }
  }, true);
  for (const event of ['wheel', 'touchmove']) document.addEventListener(event, e => { if (e.composedPath().includes(host)) return; cancelGuard(); pending = null; followupIntent = null; seekAbort?.abort(); returnAbort?.abort();selectionButton.hidden = true; }, {passive: true, capture: true});
  document.addEventListener('pointerdown', event => {
    clearTimeout(positionTimer);positionClick=null;positionGesture=null;returnAbort?.abort();
    if (askButton(event.target)) { armFollowup(); return; }
    if(event.isTrusted && event.button===0 && !interactive(event))positionGesture={chat:Position.key(),x:event.clientX,y:event.clientY,hadSelection:hasSelection(),selected:false,moved:false};
    if (event.composedPath().includes(host) || event.target.closest?.('#prompt-textarea,form,textarea,[contenteditable="true"]')) return;
    cancelGuard(); pending = null; followupIntent = null; seekAbort?.abort();
  }, true);
  $('#return').onclick = async()=>{const saved=bookmark;if(!saved)return;cancelGuard();pending=null;followupIntent=null;returnAbort?.abort();returnAbort=new AbortController();try{if(!await Position.seek(saved,returnAbort.signal)){if(saved.chat===Position.key())toast('暂时未找到这个定位，请等待原文加载');return;}updatePositionMark();if(document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop streaming"],button[aria-label*="停止"]'))startGuard(saved);else toast('已回到本聊天的定位');}catch(error){if(error.name!=='AbortError')toast(error.message);}};
  host.addEventListener('pointerdown', () => { host.dataset.keyboard = 'false'; }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Tab') host.dataset.keyboard = 'true'; }, true);
  $('.dock-handle').addEventListener('mouseenter', () => { positionDock(); });
  $('#answer-outline-toggle').onclick = () => {
    $('.outline').hidden = true; $('.tooltip').hidden = true; $('#outline-toggle').classList.remove('active');
    publishAnswerOutline();
    send({type: 'OPEN_ANSWER_OUTLINE', outline: answerOutline}).then(result => { if (result?.error) toast(result.error); }).catch(() => toast('插件刚刚更新，请刷新网页'));
  };
  document.addEventListener('scroll', () => {
    updatePositionMark();
    if (!answerRefreshTimer) answerRefreshTimer = setTimeout(() => { answerRefreshTimer = null; publishAnswerOutline(); }, 90);
  }, {capture: true, passive: true});
  window.addEventListener('resize', () => {publishAnswerOutline();updatePositionMark();});
  $('#notes').onclick = () => send({type: 'OPEN_NOTES'}).then(result => { if (result?.error) toast('请点击浏览器工具栏的GPT阅读助手图标打开笔记'); }).catch(() => toast('插件刚刚更新，请刷新网页'));
  let outlineLeave;
  const openOutline = () => { clearTimeout(outlineLeave); $('.outline').hidden = false; $('#outline-toggle').classList.add('active'); refresh(); render(); requestHistory(); };
  const hideOutline = () => { outlineLeave = setTimeout(() => { $('.outline').hidden = true; $('.tooltip').hidden = true; $('#outline-toggle').classList.remove('active'); }, 130); };
  for (const element of [$('#outline-toggle'), $('.outline')]) { element.addEventListener('mouseenter', () => { clearTimeout(outlineLeave); if ($('.outline').hidden) openOutline(); }); element.addEventListener('mouseleave', hideOutline); }
  $('#outline-toggle').addEventListener('focus', openOutline); $('#outline-toggle').onclick = () => { clearTimeout(outlineLeave); if ($('.outline').hidden) openOutline(); };
  $('.close').onclick = () => { $('.outline').hidden = true; $('.tooltip').hidden = true; $('#outline-toggle').classList.remove('active'); };
  $('.tooltip').onmouseleave = () => $('.tooltip').hidden = true;
  $('#search').oninput = render;
  chrome.storage.local.get('autoReturn').then(settings => { autoReturn = settings.autoReturn !== false; });
  chrome.storage.onChanged.addListener(changes => { if (changes.autoReturn) autoReturn = changes.autoReturn.newValue !== false; });
  domObserver = new MutationObserver(mutations => {
    const remounted = ensureMounted();
    if (!remounted && !mutations.some(m => m.target !== host && !host.contains(m.target))) return;
    if (followupIntent) {
      if (composerHasQuote(followupIntent)) followupIntent.quoteSeen = true;
      else if (followupIntent.quoteSeen) followupIntent = null;
    }
    // Throttle rather than debounce: a continuously streaming answer cannot postpone updates.
    if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 60);
  });
  ensureMounted();
  window.addEventListener('gpt-reading-route', refresh);
  window.addEventListener('popstate', refresh); window.addEventListener('pageshow', refresh);
  setInterval(() => { if (ensureMounted() || route !== currentRoute() || !$('.outline').hidden) refresh(); }, 250); refresh();
  setInterval(() => {
    if (historyState.loading && historyRequested === historyURL()) send({type: 'OUTLINE_STATUS'}).then(result => { if (result?.ok) receiveHistory(result); }).catch(() => {});
  }, 10000);
  registerReader();loadPosition();
  let theme = '';
  function syncTheme() {
    const next = document.documentElement.classList.contains('dark') || getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'dark' : 'light';
    if (next === theme) return; theme = next; host.dataset.theme = theme;
    send({type: 'PAGE_THEME', theme}).catch(() => {});
  }
  const themeStyle = document.createElement('style'); themeStyle.textContent = ':host([data-theme="dark"]){color:#ececec}:host([data-theme="dark"]) .dock,:host([data-theme="dark"]) .outline{background:#212121;border-color:#444}:host([data-theme="dark"]) .tool{color:#ccc}:host([data-theme="dark"]) .tool:hover,:host([data-theme="dark"]) .tool.active,:host([data-theme="dark"]) .item:hover{background:#3b3b3b}:host([data-theme="dark"]) input{background:#2f2f2f;color:#ececec;border-color:#444}:host([data-theme="dark"]) .item{border-bottom-color:#444}:host([data-theme="dark"]) .selection-tool{background:#2f2f2f;color:#ececec;border-color:#444}:host([data-theme="light"]){color:#0d0d0d}:host([data-theme="light"]) .dock,:host([data-theme="light"]) .outline{background:#fff;border-color:#e5e5e5}:host([data-theme="light"]) .tool{color:#555}:host([data-theme="light"]) .tool:hover,:host([data-theme="light"]) .tool.active,:host([data-theme="light"]) .item:hover{background:#ededed}:host([data-theme="light"]) input{background:#f7f7f8;color:#0d0d0d;border-color:#eee}:host([data-theme="light"]) .selection-tool{background:#fff;color:#333;border-color:#ddd}'; shadow.append(themeStyle);
  new MutationObserver(syncTheme).observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'style', 'data-theme']}); syncTheme();
  if (location.hash.startsWith('#yueji=')) { try { jumpToSource(JSON.parse(decodeURIComponent(location.hash.slice(7)))); } catch {} }
})();
