import {get, put} from './db.js';
const $ = s => document.querySelector(s);
let existing, nativeReady = false;
const status = (text, error = false) => { $('#result').textContent = text; $('#result').style.color = error ? 'var(--error)' : 'var(--ink)'; };
async function connectBrowser(root) {
  await put('pendingRoot', root);
  const response = await chrome.runtime.sendMessage({type: 'CONNECT'});
  if (!response?.ok) throw new Error(response?.error || '连接失败');
  status('已连接：' + root.name + '。可以关闭此页。');
  existing = root; $('#existing').hidden = false; $('#existing-name').textContent = root.name;
  await chrome.storage.local.set({setupDismissed: true});
}
$('#choose').onclick = async () => {
  $('#choose').disabled = true;
  try {
    if (!nativeReady) throw new Error('请先运行插件文件夹 native 内的“安装本地文件组件.command”，然后刷新此页。');
    const response = await chrome.runtime.sendMessage({type: 'CONNECT_NATIVE'});
    if (!response?.ok) throw new Error(response?.error || '连接失败');
    status('已连接：' + response.state.vaultName + '。Edge 和 Chrome 都会使用此位置，重启后继续保存。');
    await chrome.storage.local.set({setupDismissed: true});
    const info = await chrome.runtime.sendMessage({type: 'NATIVE_STATUS'});
    $('#existing').hidden = false; $('#existing-name').textContent = info.path;
  } catch (e) { status(e.message, true); } finally { $('#choose').disabled = false; }
};
$('#browser-choose').onclick = async () => {
  try {
    const parent = await window.showDirectoryPicker({id: 'yueji-vault', mode: 'readwrite', startIn: 'documents'});
    $('#browser-choose').disabled = true;
    await connectBrowser(parent);
  } catch (e) { if (e.name !== 'AbortError') status(e.message, true); }
  finally { $('#browser-choose').disabled = false; }
};
$('#reconnect').onclick = async () => {
  try { if (existing && await existing.requestPermission({mode: 'readwrite'}) === 'granted') await connectBrowser(existing); }
  catch (e) { status(e.message, true); }
};
try {
  const info = await chrome.runtime.sendMessage({type: 'NATIVE_STATUS'});
  nativeReady = !!info?.ok; $('#choose').disabled = false;
  if (nativeReady && info.connected) { $('#existing').hidden = false; $('#existing-name').textContent = info.path; }
  if (!nativeReady) { $('#fallback').hidden = false; status('请先运行 native 文件夹内的本地文件组件安装程序，再刷新此页。', true); }
  existing = await get('root');
  if (existing && !nativeReady) { $('#existing').hidden = false; $('#existing-name').textContent = existing.name; $('#reconnect').hidden = false; }
} catch (e) { status(e.message, true); $('#choose').disabled = false; }

const fallback = $('#fallback'); fallback.addEventListener('mouseenter', () => fallback.open = true); fallback.addEventListener('mouseleave', () => fallback.open = false);
