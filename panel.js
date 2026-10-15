// The writing surface belongs to the page, so browser chrome does not take a title row.
(() => {
  if (globalThis.GPTReaderIndexWorker || window !== window.top || globalThis.GPTReadingPanel) return;
  const origin = new URL(chrome.runtime.getURL('/')).origin;
  const host = document.createElement('aside'); host.id = 'gpt-reader-panel';
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `<style>:host{all:initial;position:fixed;inset:0 0 0 auto;width:var(--reader-width,380px);height:100dvh;z-index:2147482990;background:#fff;border-left:1px solid #e5e5e5;box-sizing:border-box}:host([hidden]){display:none!important}iframe{display:block;width:100%;height:100%;border:0;background:inherit}.resize{position:absolute;inset:0 auto 0 -3px;width:7px;cursor:col-resize;z-index:2;touch-action:none}.resize:hover{background:#8883}@media(prefers-color-scheme:dark){:host{background:#212121;border-color:#3b3b3b}}</style><div class="resize" role="separator" aria-label="调整笔记宽度" aria-orientation="vertical"></div>`;
  const frame = document.createElement('iframe'); frame.title = '笔记与目录'; shadow.append(frame);
  host.hidden = true;
  let width = 380, dragging = false;
  let mode = 'notes', windowId, revision = 0, imageHost, imageFrame, frameReady=false;
  const layoutStyles = new Map(), layoutMetrics = new Map();
  const composerSelector = '#prompt-textarea,form textarea,form [contenteditable="true"],[role="textbox"][contenteditable="true"]';
  const clamp = value => Math.max(Math.min(280,innerWidth * .75),Math.min(value,Math.max(280,Math.min(680,innerWidth - 300))));
  const post = message => { if(!frameReady)return;try { frame.contentWindow?.postMessage(message,origin); } catch {} };
  if(globalThis.GPTImageDrag)globalThis.GPTImageDrag.onError=error=>post({type:'HOST_IMAGE_DRAG_ERROR',message:error.message});
  function setLayoutStyle(element,property,value) {
    let properties=layoutStyles.get(element);
    if(!properties){properties=new Map();layoutStyles.set(element,properties);}
    if(!properties.has(property))properties.set(property,{value:element.style.getPropertyValue(property),priority:element.style.getPropertyPriority(property)});
    if(element.style.getPropertyValue(property)!==value || element.style.getPropertyPriority(property)!=='important')element.style.setProperty(property,value,'important');
  }
  function restoreLayoutStyles(keep=new Set()) {
    for(const [element,properties] of layoutStyles)if(!keep.has(element)){
      for(const [property,original] of properties)if(original.value)element.style.setProperty(property,original.value,original.priority);else element.style.removeProperty(property);
      layoutStyles.delete(element);layoutMetrics.delete(element);
    }
  }
  function bodyRoot(element) {
    while(element?.parentElement && element.parentElement!==document.body)element=element.parentElement;
    return element?.parentElement===document.body && element!==host && element!==imageHost ? element : null;
  }
  function fixedContainingBlock(element,absolute=false) {
    for(let parent=element.parentElement;parent && parent!==document.documentElement;parent=parent.parentElement){
      // Body padding reserves flow layout, but its positioning box still spans
      // the viewport. A footer positioned against body must reserve the side too.
      if(parent===document.body)return null;
      const css=getComputedStyle(parent);
      if((absolute && css.position!=='static') || css.transform!=='none' || css.perspective!=='none' || css.filter!=='none' || /(?:layout|paint|strict|content)/.test(css.contain) || /transform|perspective|filter/.test(css.willChange))return parent;
    }
    return null;
  }
  function constrain(element,available,targets) {
    const css=getComputedStyle(element),rect=element.getBoundingClientRect();
    const viewportPosition=(css.position==='fixed' || css.position==='absolute') && !fixedContainingBlock(element,css.position==='absolute');
    if(!layoutMetrics.has(element)){
      if(rect.right<=available+1 && rect.width<=available+1)return;
      let centered=false;
      try{centered=viewportPosition && Math.abs(parseFloat(css.left)-innerWidth/2)<2 && Math.abs(new DOMMatrix(css.transform).m41+rect.width/2)<2;}catch{}
      const max=/^[\d.]+px$/.test(css.maxWidth)?parseFloat(css.maxWidth):Infinity;
      layoutMetrics.set(element,{centered,max,viewportPosition});
    }
    const metrics=layoutMetrics.get(element);targets.add(element);
    if(metrics.viewportPosition){
      if(metrics.centered)setLayoutStyle(element,'left',available/2+'px');
      else setLayoutStyle(element,'right',width+'px');
    }
    const left=metrics.centered || metrics.viewportPosition ? Math.max(0,parseFloat(css.left)||0) : Math.max(0,element.getBoundingClientRect().left);
    const room=metrics.centered ? available : Math.max(1,available-left);
    setLayoutStyle(element,'max-width',Math.min(metrics.max,room)+'px');
    setLayoutStyle(element,'box-sizing','border-box');
    const minimum=/^[\d.]+%$/.test(css.minWidth)?parseFloat(css.minWidth)*(metrics.viewportPosition?innerWidth:element.parentElement?.clientWidth || available)/100:parseFloat(css.minWidth);
    if(minimum>room)setLayoutStyle(element,'min-width','0px');
  }
  function reserveChatSpace() {
    const body=document.body,targets=new Set();if(!body){restoreLayoutStyles();return;}
    targets.add(body);setLayoutStyle(body,'padding-right',width+'px');setLayoutStyle(body,'box-sizing','border-box');
    const available=Math.max(1,innerWidth-width),roots=new Set();
    const inputs=[...document.querySelectorAll(composerSelector)].filter(element=>element!==body && !element.closest('#gpt-reader-panel,#gpt-reader-image'));
    for(const element of [...document.querySelectorAll('main,[role="main"],#thread'),...inputs]){const root=bodyRoot(element);if(root)roots.add(root);}
    for(const root of roots)constrain(root,available,targets);
    // Only the composer ancestry needs special handling for viewport-positioned
    // footers and descendants that explicitly use 100vw despite a narrower root.
    const composers=new Set();
    for(const input of inputs)for(let element=input;element && element!==body;element=element.parentElement)if(!roots.has(element))composers.add(element);
    for(const element of [...composers].reverse())constrain(element,available,targets);
    restoreLayoutStyles(targets);
  }
  function layout() {
    if (host.hidden) return;
    width = clamp(width); host.style.setProperty('--reader-width',width + 'px');
    reserveChatSpace();
    const dock = document.getElementById('yueji-dock'); if (dock) dock.style.right = width + 6 + 'px';
    if(imageHost)imageHost.style.right=width+'px';
    post({type:'HOST_VIEW',visible:!document.hidden,mode,windowId});
  }
  function mount() { const body=document.body || document.documentElement;if (body && !host.isConnected)body.append(host); }
  function open(message) {
    mount(); mode=message.mode || 'notes'; windowId=message.windowId; host.hidden=false;
    if (!frame.src) frame.src=chrome.runtime.getURL('notes.html')+'?surface=embedded&windowId='+windowId;
    layout(); post({type:'HOST_VIEW',visible:!document.hidden,mode,windowId});
  }
  function close() {
    closeImage();
    post({type:'HOST_VIEW',visible:false,mode}); host.hidden=true;
    restoreLayoutStyles();
    const dock=document.getElementById('yueji-dock');if(dock)dock.style.removeProperty('right');
  }
  function closeImage(){imageHost?.remove();imageHost=null;imageFrame=null;}
  function openImage(message){
    if(host.hidden || !message.imageId || !message.src)return;
    closeImage();imageHost=document.createElement('aside');imageHost.id='gpt-reader-image';
    imageHost.style.cssText='position:fixed;inset:0 '+width+'px 0 0;z-index:2147482989;background:'+ (message.theme==='dark'?'#212121':'#fff')+';';
    const imageShadow=imageHost.attachShadow({mode:'open'});imageFrame=document.createElement('iframe');imageFrame.title='图片预览';imageFrame.style.cssText='width:100%;height:100%;border:0;display:block';
    imageFrame.src=chrome.runtime.getURL('image-view.html')+'?'+new URLSearchParams({imageId:message.imageId,src:message.src,alt:message.alt || '',theme:message.theme || ''});
    imageShadow.append(imageFrame);document.body.append(imageHost);
  }
  frame.addEventListener('load',()=>{layout();post({type:'HOST_VIEW',visible:!host.hidden&&!document.hidden,mode,windowId});});
  window.addEventListener('message',event=>{
    if(event.source===imageFrame?.contentWindow && event.origin===origin && event.data?.type==='READER_IMAGE_CLOSE'){closeImage();return;}
    if(event.source!==frame.contentWindow || event.origin!==origin)return;
    if(event.data?.type==='READER_PANEL_CLOSE')close();
    if(event.data?.type==='READER_IMAGE')openImage(event.data);
    if(event.data?.type==='READER_IMAGE_DRAG_START'){closeImage();globalThis.GPTImageDrag?.prepare(event.data.token).catch(()=>{});}
    if(event.data?.type==='READER_IMAGE_CLOSE')closeImage();
    if(event.data?.type==='READER_PANEL_MODE')mode=event.data.mode==='outline'?'outline':'notes';
    if(event.data?.type==='READER_PANEL_READY'){frameReady=true;layout();post({type:'HOST_VIEW',visible:!host.hidden&&!document.hidden,mode,windowId});}
  });
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message.type==='INLINE_CONTEXT'){windowId=message.windowId;layout();reply({ok:true});return;}
    if(message.type==='OPEN_INLINE_IMAGE'){openImage(message);reply({ok:true});return;}
    if(message.type!=='OPEN_INLINE_NOTES')return;
    open(message);reply({ok:true});
  });
  document.addEventListener('pointerdown',event=>{
    if(host.hidden || event.composedPath().includes(host))return;
    revision++;post({type:'HOST_READING_POINTER',revision});
  },true);
  document.addEventListener('pointerup',event=>{
    if(host.hidden || event.composedPath().includes(host))return;
    const at=revision;
    setTimeout(()=>post({type:'HOST_READING_SELECTION',revision:at,selected:!!document.getSelection()?.toString().trim()}),0);
  },true);
  document.addEventListener('selectionchange',()=>{
    if(!host.hidden && document.getSelection()?.toString().trim())post({type:'HOST_READING_SELECTION',revision,selected:true});
  });
  document.addEventListener('visibilitychange',()=>{post({type:'HOST_VIEW',visible:!host.hidden&&!document.hidden,mode,windowId});});
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && imageHost)closeImage();});
  shadow.querySelector('.resize').addEventListener('pointerdown',event=>{
    dragging=true;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);frame.style.pointerEvents='none';
  });
  shadow.querySelector('.resize').addEventListener('pointermove',event=>{if(dragging){width=innerWidth-event.clientX;layout();}});
  shadow.querySelector('.resize').addEventListener('pointerup',event=>{
    if(!dragging)return;dragging=false;frame.style.pointerEvents='';event.currentTarget.releasePointerCapture(event.pointerId);
    chrome.storage.local.set({inlineNoteWidth:width}).catch(()=>{});
  });
  window.addEventListener('resize',layout);
  setInterval(()=>{if(!host.hidden){mount();layout();}},1000);
  chrome.storage.local.get('inlineNoteWidth').then(data=>{if(Number.isFinite(data.inlineNoteWidth))width=clamp(data.inlineNoteWidth);layout();});
  globalThis.GPTReadingPanel={open,close};
})();
