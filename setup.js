import {get,put} from './db.js';
const $=s=>document.querySelector(s);
const status=(text,error=false)=>{$('#result').textContent=text;$('#result').style.color=error?'var(--error)':'var(--ink)';};
async function connect(root){
  await put('pendingRoot',root);
  const response=await chrome.runtime.sendMessage({type:'CONNECT'});
  if(!response?.ok)throw Error(response?.error||'连接失败');
  status('已绑定 '+root.name+'。仍会保留浏览器备份，可以回到聊天继续使用。');
  $('#existing').hidden=false;$('#existing-name').textContent=root.name;
}
$('#browser-choose').onclick=async()=>{
  try {
    const root=await window.showDirectoryPicker({id:'gpt-reader-vault',mode:'readwrite',startIn:'documents'});
    $('#browser-choose').disabled=true;await connect(root);
  }catch(e){if(e.name!=='AbortError')status(e.message,true);}
  finally{$('#browser-choose').disabled=false;}
};
if(typeof window.showDirectoryPicker!=='function'){$('#browser-choose').disabled=true;status('此浏览器未提供文件夹接口；可继续自动保存，并从笔记设置导出备份。');}
const existing=await get('root');
if(existing){$('#existing').hidden=false;$('#existing-name').textContent=existing.name;$('#reconnect').hidden=false;}
$('#reconnect').onclick=async()=>{try{if(existing&&await existing.requestPermission({mode:'readwrite'})==='granted')await connect(existing);}catch(e){status(e.message,true);}};
