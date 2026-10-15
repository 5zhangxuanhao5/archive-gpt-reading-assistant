// A string marker survives Chromium's cross-renderer drag IPC even on versions
// that discard JS-created File bytes. Rebuild the file only after a real drop.
(() => {
  if (globalThis.GPTReaderIndexWorker || window !== window.top || globalThis.GPTImageDrag) return;
  const marker = 'application/x-gpt-reader-image';
  const validToken = token => typeof token === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(token);
  const files = new Map();
  const lifetime = 120000;
  let replaying = false;
  function prune() {
    const now = Date.now();
    for (const [token, entry] of files) if (entry.expires < now) files.delete(token);
    while (files.size > 4) files.delete(files.keys().next().value);
  }
  function prepare(token) {
    if (!validToken(token)) return Promise.reject(new Error('图片拖动信息无效'));
    prune();
    const cached = files.get(token); if (cached) return cached.promise;
    const entry = {expires: Date.now() + lifetime};
    entry.promise = chrome.runtime.sendMessage({type:'FETCH_IMAGE_DRAG',token}).then(result => {
      if (!result?.ok) throw new Error(result?.error || '图片暂时无法读取');
      const match = typeof result.dataURL === 'string' && result.dataURL.match(/^data:(image\/(?:png|jpeg|gif|webp|bmp|avif));base64,([A-Za-z0-9+/]*={0,2})$/i);
      if (!match || result.dataURL.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 + 100) throw new Error('图片数据无效');
      const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
      const extension = {png:'png',jpeg:'jpg',gif:'gif',webp:'webp',bmp:'bmp',avif:'avif'}[match[1].split('/')[1].toLowerCase()];
      return new File([bytes],'笔记图片.' + extension,{type:match[1].toLowerCase()});
    });
    // Preloading is optional. Its rejection is handled again by the actual drop.
    entry.promise.catch(() => { if (files.get(token) === entry) files.delete(token); });
    files.set(token, entry);
    setTimeout(() => { if ((files.get(token)?.expires || Infinity) <= Date.now()) files.delete(token); },lifetime + 20);
    prune(); return entry.promise;
  }
  function release(token) {
    files.delete(token);
    chrome.runtime.sendMessage({type:'FETCH_IMAGE_DRAG',token,release:true}).catch(() => {});
  }
  const carriesImage = event => event.isTrusted && !replaying && Array.from(event.dataTransfer?.types || []).includes(marker);
  for (const type of ['dragenter','dragover']) document.addEventListener(type,event => {
    if (!carriesImage(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  },true);
  document.addEventListener('drop',async event => {
    if (!carriesImage(event)) return;
    const token = event.dataTransfer.getData(marker);
    if (!validToken(token)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const original = event.target, clientX = event.clientX, clientY = event.clientY;
    try {
      const file = await prepare(token), target = original?.isConnected ? original : document.elementFromPoint(clientX,clientY);
      if (!(target instanceof Element)) throw new Error('图片放置位置已改变，请重新拖动');
      const transfer = new DataTransfer(); transfer.items.add(file); transfer.effectAllowed = 'copy'; transfer.dropEffect = 'copy';
      replaying = true;
      try {
        for (const type of ['dragenter','dragover','drop']) target.dispatchEvent(new DragEvent(type,{dataTransfer:transfer,clientX,clientY,bubbles:true,cancelable:true,composed:true}));
      } finally { replaying = false; }
    } catch (error) {
      globalThis.GPTImageDrag.lastError = error.message;
      globalThis.GPTImageDrag.onError?.(error);
      console.warn('GPT阅读助手：图片拖动失败',error.message);
    } finally { release(token); }
  },true);
  globalThis.GPTImageDrag = {prepare,release,lastError:'',onError:null};
})();
