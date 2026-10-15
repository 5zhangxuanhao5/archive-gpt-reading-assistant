// A position is a serializable text anchor, not a selection or a DOM reference.
(() => {
  const DOM=globalThis.YuejiDOM, History=globalThis.GPTReaderHistory;
  const leaves='p,li,pre,td,th,h1,h2,h3,h4,h5,h6,blockquote';
  const normalized=text=>String(text || '').replace(/\s+/g,' ').trim();
  function key(url=location.href){
    const parsed=new URL(url);
    return /^\/c\/[^/]+\/?$/.test(parsed.pathname) ? parsed.origin+parsed.pathname.replace(/\/$/,'') : '';
  }
  function scrollerFor(node){
    for(let parent=node?.parentElement;parent;parent=parent.parentElement){
      if(/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight>parent.clientHeight+5)return parent;
    }
    return document.scrollingElement;
  }
  function textNodes(root){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let text='',node;
    while((node=walker.nextNode())){
      if(node.parentElement?.closest('button,[role="button"],svg,script,style,[hidden],[aria-hidden="true"]'))continue;
      nodes.push({node,start:text.length});text+=node.textContent;
    }
    return {nodes,text};
  }
  function textRange(root,offset){
    const {nodes,text}=textNodes(root);if(!nodes.length)return null;
    const at=Math.max(0,Math.min(offset,text.length)),entry=nodes.find(n=>at<n.start+n.node.length) || nodes.at(-1);
    const local=Math.max(0,Math.min(at-entry.start,entry.node.length)),range=document.createRange();
    range.setStart(entry.node,local);range.collapse(true);
    if(!range.getBoundingClientRect().height && entry.node.length){range.setStart(entry.node,Math.min(local,entry.node.length-1));range.setEnd(entry.node,Math.min(local+1,entry.node.length));}
    return range;
  }
  function pointRange(x,y){
    try{
      const position=document.caretPositionFromPoint?.(x,y);
      if(position){const range=document.createRange();range.setStart(position.offsetNode,position.offset);range.collapse(true);return range;}
      return document.caretRangeFromPoint?.(x,y) || null;
    }catch{return null;}
  }
  function capture(element,x,y){
    const chat=key();if(!chat)return null;DOM.scan();
    const message=DOM.locate(element),role=message && DOM.roleOf(message);
    if(!message || !['user','assistant'].includes(role))return null;
    const point=pointRange(x,y),pointElement=point?.startContainer.nodeType===1?point.startContainer:point?.startContainer.parentElement;
    let leaf=(pointElement && DOM.includes(message,pointElement) ? pointElement : element).closest(leaves);
    if(!leaf || !DOM.includes(message,leaf))leaf=element;
    if(!DOM.includes(message,leaf) || !normalized(leaf.textContent))return null;
    const {nodes,text}=textNodes(leaf);let offset=0;
    if(point && leaf.contains(point.startContainer)){
      const entry=nodes.find(n=>n.node===point.startContainer);
      if(entry)offset=entry.start+point.startOffset;
    }
    const range=textRange(leaf,offset),rect=range?.getBoundingClientRect(),box=leaf.getBoundingClientRect(),container=scrollerFor(leaf);
    const list=DOM.elementsOf(message,leaves);if(message.matches(leaves))list.unshift(message);
    const bounds=History.bounds(container);
    return {chat,role,messageId:DOM.idOf(message),messageIndex:DOM.messages(role).indexOf(message),messageText:normalized(DOM.textOf(message)).slice(0,180),leafIndex:list.indexOf(leaf),leafTag:leaf.tagName,leafText:normalized(text).slice(0,800),offset,prefix:text.slice(Math.max(0,offset-32),offset),suffix:text.slice(offset,offset+48),viewportY:rect?.height?rect.top:y,leafY:box.top,relativeY:y-box.top,scrollTop:container.scrollTop,edgeProgress:container.scrollTop-bounds.min,progress:bounds.extent?(container.scrollTop-bounds.min)/bounds.extent:0,at:Date.now()};
  }
  function messageFor(saved){
    DOM.scan();const messages=DOM.messages(saved.role);
    const exact=saved.messageId && messages.find(node=>DOM.idOf(node)===saved.messageId);if(exact)return exact;
    const indexed=messages[saved.messageIndex];
    if(indexed && normalized(DOM.textOf(indexed)).startsWith(saved.messageText))return indexed;
    return saved.messageText ? messages.find(node=>normalized(DOM.textOf(node)).startsWith(saved.messageText)) : null;
  }
  function resolve(saved){
    const message=messageFor(saved);if(!message)return null;
    const list=DOM.elementsOf(message,leaves);if(message.matches(leaves))list.unshift(message);
    const matches=node=>node?.tagName===saved.leafTag && normalized(textNodes(node).text).startsWith(saved.leafText);
    let leaf=list[saved.leafIndex];if(!matches(leaf))leaf=list.find(matches);
    if(!leaf && matches(message))leaf=message;
    if(!leaf)return null;
    const {text}=textNodes(leaf);let offset=saved.offset;
    if(text.slice(Math.max(0,offset-saved.prefix.length),offset)!==saved.prefix || text.slice(offset,offset+saved.suffix.length)!==saved.suffix){
      const context=saved.prefix+saved.suffix,at=context?text.indexOf(context):-1;
      if(at>=0)offset=at+saved.prefix.length;
      else if(saved.suffix && text.includes(saved.suffix))offset=text.indexOf(saved.suffix);
    }
    return {leaf,range:textRange(leaf,offset),container:scrollerFor(leaf)};
  }
  function restore(saved){
    if(!saved || saved.chat!==key())return false;
    const target=resolve(saved);if(!target)return false;
    const rect=target.range?.getBoundingClientRect(),delta=rect?.height?rect.top-saved.viewportY:target.leaf.getBoundingClientRect().top-saved.leafY;
    const before=target.container.style.scrollBehavior;target.container.style.scrollBehavior='auto';target.container.scrollTop+=delta;target.container.style.scrollBehavior=before;
    return true;
  }
  async function seek(saved,signal){
    if(saved.chat!==key())return false;
    if(restore(saved))return true;
    const chat=key();await History.seek(()=>messageFor(saved),saved.progress,signal);
    return !signal?.aborted && key()===chat && restore(saved);
  }
  globalThis.GPTReadingPosition={key,capture,resolve,restore,seek};
})();
