(() => {
  const params = new URLSearchParams(location.search);
  const image = document.getElementById('image-viewer-image');
  const status = document.getElementById('image-viewer-status');
  const close = document.getElementById('image-viewer-close');
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  image.alt = (params.get('alt') || '笔记图片').slice(0,1000);
  let idleTimer;
  function hideControls() {
    clearTimeout(idleTimer); document.body.classList.remove('controls-visible');
  }
  function showControls() {
    clearTimeout(idleTimer); document.body.classList.add('controls-visible');
    idleTimer = setTimeout(hideControls,900);
  }
  document.addEventListener('pointermove',showControls,{passive:true});
  document.addEventListener('pointerleave',hideControls,{passive:true});
  document.documentElement.addEventListener('pointerleave',hideControls,{passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)hideControls();});
  window.addEventListener('blur',hideControls);
  window.addEventListener('pagehide',hideControls);
  close.addEventListener('focus',showControls);
  close.addEventListener('blur',hideControls);
  function closePreview() {
    let parentOrigin = '*';
    try {
      const candidate = new URL(document.referrer).origin;
      if (['https://chatgpt.com','https://chat.openai.com',new URL(chrome.runtime.getURL('/')).origin].includes(candidate)) parentOrigin = candidate;
    } catch {}
    parent.postMessage({type:'READER_IMAGE_CLOSE'},parentOrigin);
  }
  close.addEventListener('click',closePreview);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();closePreview();}
  });
  function fail(message) {
    image.hidden = true; status.hidden = false; status.textContent = '图片暂时无法打开：' + message;
  }
  (async () => {
    try {
      const imageId = params.get('imageId') || '', src = params.get('src') || '';
      if (imageId.length > 100 || src.length > 1000) throw new Error('图片信息无效');
      const result = await chrome.runtime.sendMessage({type:'GET_IMAGE',imageId,src});
      if (!result?.ok) throw new Error(result?.error || '请重新打开图片');
      const dataURL = result.dataURL;
      if (typeof dataURL !== 'string' || dataURL.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 + 100 || !/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]*={0,2}$/i.test(dataURL)) throw new Error('图片内容无效');
      image.addEventListener('load',()=>{image.hidden=false;status.hidden=true;},{once:true});
      image.addEventListener('error',()=>fail('请检查原图片文件是否还在笔记库中。'),{once:true});
      image.src = dataURL;
    } catch(error) { fail(error?.message || '请稍后重试'); }
  })();
})();
