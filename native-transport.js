let port, counter = 0;
const pending = new Map();

// Native messaging replies are ordered on one port. Keep that transport separate
// from storage so the shared cache and file handles do not form an import cycle.
export async function nativeRequest(message) {
  if (!port) {
    const opened = chrome.runtime.connectNative('com.yueji.notes');
    port = opened;
    opened.onMessage.addListener(reply => {
      const next = pending.values().next().value;
      if (!next) return;
      pending.delete(next.id);
      if (reply.ok) next.resolve(reply);
      else {
        const error = new Error(reply.error || '本地文件组件返回错误');
        error.name = reply.name || 'Error'; next.reject(error);
      }
    });
    opened.onDisconnect.addListener(() => {
      const error = new Error(chrome.runtime.lastError?.message || '本地文件组件未连接');
      if (port === opened) port = null;
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++counter; pending.set(id, {id, resolve, reject});
    try { port.postMessage(message); }
    catch (error) { pending.delete(id); reject(error); }
  });
}
