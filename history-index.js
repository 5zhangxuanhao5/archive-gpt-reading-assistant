import {get, put} from './db.js';

const jobs = new Map();
const generations = new Map();
let activeJob = null;
let metadataQueue = Promise.resolve();
const saveJobs = () => {
  const tasks = [...jobs.values()].filter(job => !job.finished).map(({url, token, windowId, tabId, deadline, owners}) => ({url, token, windowId, tabId, deadline, owners: [...owners]}));
  metadataQueue = metadataQueue.catch(() => {}).then(() => chrome.storage.session.set({outlineTasks: tasks}));
  return metadataQueue;
};
const jobsReady = chrome.storage.session.get('outlineTasks').then(async ({outlineTasks = []}) => {
  for (const task of outlineTasks) {
    try {
      canonical(task.url);
      const cache = await get('outline:' + task.url);
      const job = {...task, owners: new Set(task.owners), items: cache?.items || [], complete: false};
      jobs.set(job.url, job); if (job.tabId) activeJob = job;
    } catch {}
  }
}).catch(() => {});
const canonical = value => {
  const url = new URL(value);
  if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(url.origin) || !/\/c\/[^/]+\/?$/.test(url.pathname)) throw new Error('请先打开一段聊天');
  return url.origin + url.pathname;
};
function validItems(items) {
  if (!Array.isArray(items) || items.length > 30000) throw new Error('目录数据无效');
  return items.map(item => {
    if (typeof item.id !== 'string' || typeof item.text !== 'string') throw new Error('目录数据无效');
    return {id: item.id.slice(0, 100000), text: item.text.slice(0, 200000), position: Number.isFinite(item.position) ? Math.max(0, Math.min(1, item.position)) : 0};
  });
}
const payload = job => ({type: 'OUTLINE_HISTORY', url: job.url, items: job.items, complete: !!job.complete, loading: !job.finished, error: job.error || ''});
function broadcast(job) {
  for (const tabId of job.owners) chrome.tabs.sendMessage(tabId, payload(job)).catch(() => job.owners.delete(tabId));
}
async function finish(job, error = '') {
  if (job.finished) return;
  job.finished = true; job.error = error;
  await put('outline:' + job.url, {items: job.items, complete: !!job.complete, updated: Date.now()});
  broadcast(job); clearTimeout(job.timer);
  if (job.tabId) {
    chrome.tabs.sendMessage(job.tabId, {type: 'STOP_INDEX'}).catch(() => {});
    // Only close the temporary tab we created. If the user opened it, leave it intact.
    try { const tab = await chrome.tabs.get(job.tabId); if (!tab.active) await chrome.tabs.remove(job.tabId); else { await chrome.tabs.update(job.tabId, {url: job.url}); await chrome.tabs.reload(job.tabId); } } catch {}
  }
  jobs.delete(job.url); if (activeJob === job) activeJob = null;
  await saveJobs();
  pump();
}
async function pump() {
  if (activeJob) return;
  const job = [...jobs.values()].find(job => !job.finished && job.owners.size);
  if (!job) return;
  activeJob = job;
  try {
    const tab = await chrome.tabs.create({url: 'about:blank', active: false, windowId: job.windowId});
    job.tabId = tab.id;
    if (job.finished) { const current = await chrome.tabs.get(tab.id); if (!current.active) await chrome.tabs.remove(tab.id); else await chrome.tabs.update(tab.id, {url: job.url}); return; }
    job.deadline = Date.now() + 240000; await saveJobs();
    await chrome.tabs.update(tab.id, {url: job.url + '#gpt-reader-index=' + job.token});
    if (job.finished) return;
    job.timer = setTimeout(() => finish(job, '聊天较长或加载较慢，可继续补全目录'), 240000);
  } catch (error) { await finish(job, error.message); }
}
async function request(message, sender) {
  const generation = generations.get(sender.tab.id) || 0;
  const url = canonical(sender.url);
  const requested = canonical(message.url || sender.url); if (requested !== url) throw new Error('目录来源无效');
  for (const job of jobs.values()) if (job.url !== url && job.owners.delete(sender.tab.id) && !job.owners.size) await finish(job, '已暂停');
  const cached = await get('outline:' + url);
  if (generation !== (generations.get(sender.tab.id) || 0)) return {ok: false, error: '已切换聊天'};
  let job = jobs.get(url);
  if (!job) {
    job = {url, items: cached?.items || [], complete: false, owners: new Set(), token: crypto.randomUUID(), windowId: sender.tab.windowId};
    jobs.set(url, job);
  }
  job.owners.add(sender.tab.id); pump();
  await saveJobs();
  return {ok: true, ...payload(job)};
}
chrome.tabs.onRemoved.addListener(tabId => {
  jobsReady.then(() => {
  generations.set(tabId, (generations.get(tabId) || 0) + 1);
  for (const job of jobs.values()) {
    if (job.tabId === tabId && !job.finished) { finish(job, '后台补全已停止，可继续补全'); continue; }
    if (job.owners.delete(tabId) && !job.owners.size) finish(job, '已暂停');
  }
  saveJobs();
  });
});
chrome.tabs.onActivated.addListener(({tabId}) => {
  jobsReady.then(() => { if (activeJob?.tabId === tabId) finish(activeJob, '已暂停后台补全，可继续补全'); });
});
// Indexing reports keep the extension worker alive while the temporary tab is scanning.
export function handleHistoryMessage(message, sender, reply) {
  if (!['REQUEST_OUTLINE', 'OUTLINE_STATUS', 'CANCEL_OUTLINE', 'INDEX_WORKER_READY', 'INDEX_PROGRESS'].includes(message.type)) return false;
  if (!sender.tab || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) return false;
  jobsReady.then(() => dispatchHistoryMessage(message, sender, reply)).catch(error => reply({ok: false, error: error.message}));
  return true;
}
function dispatchHistoryMessage(message, sender, reply) {
  if (message.type === 'REQUEST_OUTLINE') {
    request(message, sender).then(reply).catch(error => reply({ok: false, error: error.message})); return true;
  }
  if (message.type === 'CANCEL_OUTLINE') {
    generations.set(sender.tab.id, (generations.get(sender.tab.id) || 0) + 1);
    for (const job of jobs.values()) if (job.owners.delete(sender.tab.id) && !job.owners.size) finish(job, '已暂停');
    saveJobs(); reply({ok: true}); return true;
  }
  if (message.type === 'OUTLINE_STATUS') {
    const url = canonical(sender.url), job = jobs.get(url);
    if (!job || !job.owners.has(sender.tab.id)) { reply({ok: true, url, loading: false, error: '后台补全已暂停，可继续补全'}); return; }
    if (job.deadline && Date.now() > job.deadline) { finish(job, '后台加载超时，可继续补全'); reply({ok: true, ...payload({...job, finished: true, error: '后台加载超时，可继续补全'})}); return; }
    reply({ok: true, ...payload(job)}); pump(); return;
  }
  if (!['INDEX_WORKER_READY', 'INDEX_PROGRESS'].includes(message.type)) return false;
  let source;
  try { source = canonical(sender.url); } catch { reply({ok: false}); return true; }
  const job = [...jobs.values()].find(job => job.tabId === sender.tab.id && job.token === message.token && source === job.url);
  if (!job || job.finished) { reply({ok: false}); return true; }
  if (job.deadline && Date.now() > job.deadline) { finish(job, '后台加载超时，可继续补全'); reply({ok: false}); return; }
  if (message.type === 'INDEX_WORKER_READY') { reply({ok: true}); return true; }
  try {
    const incoming = validItems(message.items);
    // The worker performs an authoritative oldest-to-newest pass; never inherit stale branches.
    job.items = incoming; job.complete = !!message.complete;
    broadcast(job); reply({ok: true});
    if (message.complete || message.error) finish(job, String(message.error || ''));
  } catch (error) { reply({ok: false, error: error.message}); finish(job, error.message); }
  return true;
}
