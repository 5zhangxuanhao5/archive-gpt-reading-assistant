// Browser-local storage: no host, native messaging or external process.
let connection;
export function db() {
  if (!connection) connection = new Promise((resolve,reject)=>{
    const request=indexedDB.open('yueji-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('data');
    request.onsuccess=()=>{const database=request.result;database.onversionchange=()=>{database.close();connection=null;};resolve(database);};
    request.onerror=()=>{connection=null;reject(request.error);};
  });
  return connection;
}
export async function get(key) {
  const database=await db();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction('data','readonly');let value;
    const request=tx.objectStore('data').get(key);
    request.onsuccess=()=>{value=request.result;};
    tx.oncomplete=()=>resolve(value);
    tx.onabort=tx.onerror=()=>reject(tx.error||request.error||Error('浏览器数据读取失败'));
  });
}
export async function putMany(entries) {
  const database=await db();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction('data','readwrite');
    tx.oncomplete=()=>resolve();
    tx.onabort=tx.onerror=()=>reject(tx.error||Error('浏览器保存失败，请检查磁盘空间并导出备份'));
    try {for(const [key,value] of entries)tx.objectStore('data').put(value,key);}
    catch(error){tx.abort();reject(error);}
  });
}
export function put(key,value) {return putMany([[key,value]]);}
// The worker serializes whole operations. Import commits state and images atomically.
let queue=Promise.resolve();
export function withSharedStore(fn) {const task=queue.then(fn,fn);queue=task.catch(()=>{});return task;}
export async function sharedStatus() {return null;}
export async function cacheRevision() {return {shared:false,revision:(await get('state'))?.version||0,connected:true};}
