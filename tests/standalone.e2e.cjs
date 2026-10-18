// Isolated profiles only. Never run against the user's normal browser profile.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const extension=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
const id=[...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(n=>String.fromCharCode(97+parseInt(n,16))).join(''),base='chrome-extension://'+id+'/';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-reader-standalone-')),passed=[],errors=[],contexts=new Set();
const screenshotRoot=process.env.SCREENSHOT_DIR;let portable,chromePortable;
async function check(name,fn){try{await fn();passed.push(name);console.log('PASS',name);}catch(e){errors.push({name,error:e.stack});console.error('FAIL',name,e.message);throw e;}}
async function launch(name){
 const profile=path.join(temp,name),context=await chromium.launchPersistentContext(profile,{executablePath:process.env[name.toUpperCase()+'_EXECUTABLE'],channel:process.env[name.toUpperCase()+'_EXECUTABLE']?undefined:name,headless:true,acceptDownloads:true,ignoreDefaultArgs:['--disable-extensions'],args:name==='chrome'?['--enable-unsafe-extension-debugging']:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:960,height:800}});
 contexts.add(context);context.setDefaultTimeout(12000);
 if(name==='chrome'){const cdp=await context.browser().newBrowserCDPSession();assert.equal((await cdp.send('Extensions.loadUnpacked',{path:extension})).id,id);await cdp.detach();}
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage();await page.goto(base+'notes.html');await page.waitForFunction(()=>!document.querySelector('#save-status').textContent.includes('正在打开'));
 return {name,profile,context,worker,page};
}
async function api(b,message){const r=await b.page.evaluate(m=>chrome.runtime.sendMessage(m),message);assert.ok(r?.ok,r?.error||JSON.stringify(r));return r;}
const state=async b=>(await api(b,{type:'LIST'})).state;
const block=text=>({id:crypto.randomUUID(),type:'text',text});
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=';
async function close(b){await b.context.close();contexts.delete(b.context);}
(async()=>{try{
 for(const name of ['chrome','msedge']){
  let b=await launch(name),nid;
  await check(name+' fresh install needs no host, folder or setup',async()=>{
   assert.ok(!manifest.permissions.includes('nativeMessaging'));assert.ok(!manifest.permissions.includes('sidePanel'));assert.ok(!fs.existsSync(path.join(extension,'native')));
   assert.equal((await state(b)).notes.length,0);assert.equal(await b.page.locator('#setup-card').isVisible(),false);assert.equal(await b.page.locator('#welcome-new').isVisible(),true);
   assert.equal(await b.page.evaluate(async()=>!!(await import('./db.js')).get&&!!(await chrome.permissions.getAll()).permissions.includes('unlimitedStorage')),true);
  });
  await check(name+' UI creates and saves a note immediately',async()=>{
   await b.page.locator('#welcome-new').click();await b.page.locator('#name-input').fill('无需安装组件');await b.page.locator('#name-input').press('Enter');
   await b.page.locator('#block-editor .block-insert').first().click();await b.page.locator('.cm-content').first().fill('目录帮助阅读，笔记辅助记忆。');
   await b.page.waitForFunction(async()=>{const r=await chrome.runtime.sendMessage({type:'LIST'});return r.state.notes.some(n=>n.blocks?.some(b=>b.text==='目录帮助阅读，笔记辅助记忆。'));});
   nid=(await state(b)).notes[0].id;assert.equal(await b.page.locator('#save-status').innerText(),'已保存到此浏览器');
  });
  await check(name+' image persists without any folder',async()=>{
   const r=await api(b,{type:'STORE_IMAGE',noteId:nid,dataURL:image,alt:'本地测试图片'});const got=await api(b,{type:'GET_IMAGE',imageId:r.imageId,src:r.src});assert.equal(got.dataURL,image);
   await b.page.waitForFunction(()=>!!document.querySelector('.note-image')||!!document.querySelector('#block-editor img'));
  });
  await check(name+' concurrent edits preserve both changes',async()=>{
   const made=await api(b,{type:'CREATE',title:'并发编辑'});let n=made.state.notes.find(n=>n.id===made.noteId);
   let saved=await api(b,{type:'SAVE',id:n.id,rev:n.rev,blocks:[block('AB')],quotes:[],clientId:'initial',sequence:1});n=saved.state.notes.find(n=>n.title==='并发编辑');
   const baseDoc={rev:n.rev,blocks:n.blocks,quotes:n.quotes};
   await Promise.all([api(b,{type:'SAVE',id:n.id,rev:n.rev,base:baseDoc,blocks:[{...n.blocks[0],text:'XAB'}],quotes:[],clientId:'a',sequence:1}),api(b,{type:'SAVE',id:n.id,rev:n.rev,base:baseDoc,blocks:[{...n.blocks[0],text:'ABY'}],quotes:[],clientId:'b',sequence:1})]);
   assert.equal((await state(b)).notes.find(x=>x.id===n.id).blocks[0].text,'XABY');
  });
  await check(name+' full backup exports text and image bytes',async()=>{
   const r=await api(b,{type:'BACKUP'});portable={format:'gpt-reader-backup-v2',folders:r.state.folders,notes:r.state.notes,assets:r.assets};assert.ok(portable.notes.length>=2);assert.equal(portable.assets[0].dataURL,image);if(name==='chrome')chromePortable=structuredClone(portable);
   await b.page.locator('#settings').click();const download=b.page.waitForEvent('download');await b.page.locator('#export').click();const dl=await download;const p=await dl.path();const file=JSON.parse(fs.readFileSync(p,'utf8'));assert.equal(file.format,'gpt-reader-backup-v2');assert.equal(file.assets[0].dataURL,image);
  });
  await check(name+' import restores quotes and images without replacing notes',async()=>{
   const before=(await state(b)).notes.length,backup=structuredClone(portable);
   backup.notes[0].quotes.push({id:'test-quote',text:'摘录原文',source:{url:'https://chatgpt.com/c/fixture',messageId:'answer',text:'摘录原文',role:'assistant'}});backup.notes[0].blocks.push({id:'test-block',type:'quote',quoteId:'test-quote'});
   const r=await api(b,{type:'IMPORT_BACKUP',backup});assert.equal(r.state.notes.length,before+backup.notes.length);
   const imported=r.state.notes.find(n=>n.id===r.noteId),oldImage=portable.notes[0].blocks.find(x=>x.type==='image'),newImage=imported.blocks.find(x=>x.type==='image');
   assert.notEqual(newImage.imageId,oldImage.imageId);assert.equal((await api(b,{type:'GET_IMAGE',imageId:newImage.imageId,src:newImage.src})).dataURL,image);assert.equal(imported.quotes[0].text,'摘录原文');
  });
  await check(name+' malformed backup is rejected atomically',async()=>{
   const before=await state(b),bad=structuredClone(portable);bad.notes.push({title:'../wrong',quotes:[],blocks:[]});const r=await b.page.evaluate(backup=>chrome.runtime.sendMessage({type:'IMPORT_BACKUP',backup}),bad);assert.ok(r.error);assert.deepEqual(await state(b),before);
   bad.notes=[];bad.folders=['../escape'];const r2=await b.page.evaluate(backup=>chrome.runtime.sendMessage({type:'IMPORT_BACKUP',backup}),bad);assert.ok(r2.error);assert.deepEqual(await state(b),before);
   const missing=structuredClone(portable);missing.assets=[];const r3=await b.page.evaluate(backup=>chrome.runtime.sendMessage({type:'IMPORT_BACKUP',backup}),missing);assert.ok(r3.error);assert.deepEqual(await state(b),before);
  });
  await check(name+' IDB transaction abort preserves committed state',async()=>{
   const before=await state(b);const r=await b.page.evaluate(async()=>{const db=await import('./db.js');try{await db.putMany([['state',{notes:[],folders:[],version:99999}],['bad',()=>{}]]);return false;}catch{return true;}});assert.ok(r);assert.deepEqual(await state(b),before);
  });
  await check(name+' optional folder settings require no external runtime',async()=>{
   await b.page.goto(base+'setup.html');assert.match(await b.page.locator('h1').innerText(),/自动保存在此浏览器/);assert.ok(!/Python/.test(await b.page.locator('body').innerText()));await b.page.goto(base+'notes.html');
  });
  await check(name+' old native flags never trigger a native connection',async()=>{
   await b.page.evaluate(async()=>{const db=await import('./db.js');await db.put('sharedCache',{protocol:1});await db.put('nativeMode',true);});assert.ok((await state(b)).notes.length);assert.equal((await state(b)).shared,false);
  });
  const beforeRestart=await state(b);
  await check(name+' browser restart retains all notes, quotes and image bytes',async()=>{
   await close(b);b=await launch(name);assert.deepEqual(await state(b),beforeRestart);const a=portable.assets[0];assert.equal((await api(b,{type:'GET_IMAGE',imageId:a.imageId,src:a.src})).dataURL,image);
  });
  await check(name+' separate browser profiles exchange complete backups',async()=>{
   const transfer=chromePortable||portable;const r=await api(b,{type:'IMPORT_BACKUP',backup:transfer});assert.equal(r.importedCount,transfer.notes.length);assert.equal(r.state.shared,false);const imported=r.state.notes.find(n=>n.id===r.noteId),img=imported.blocks.find(b=>b.type==='image');assert.equal((await api(b,{type:'GET_IMAGE',imageId:img.imageId,src:img.src})).dataURL,image);
  });
  if(screenshotRoot){await b.page.evaluate(nid=>chrome.storage.local.set({panelState:{active:nid,opened:[nid],expanded:[''],selectedFolder:''}}),nid);await b.page.reload();await b.page.waitForSelector('.cm-content');await b.page.screenshot({path:path.join(screenshotRoot,name+'-standalone.png')});}
  await close(b);
 }
}catch(e){if(!errors.length)errors.push({name:'suite',error:e.stack});}finally{for(const c of contexts)await c.close().catch(()=>{});const result={passed:passed.length,failed:errors.length,tests:passed,errors,extensionId:id,version:manifest.version,isolatedProfiles:true,realWindowsVerified:false};fs.writeFileSync(process.env.TEST_RESULT||path.join(temp,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:passed.length,failed:errors.length}));if(errors.length)process.exitCode=1;}})();
