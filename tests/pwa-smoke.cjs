const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');const http=require('http');const path=require('path');const assert=require('assert');
const root=path.resolve(__dirname,'..');
(async()=>{
const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true});
let simulateUpdate=false;
const server=http.createServer((req,res)=>{
 let file=decodeURIComponent(req.url.split('?')[0]).replace(/^\/Gold-Prices\//,'/');
 if(file==='/')file='/index.html';
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
 try{let data=fs.readFileSync(root+file);if(simulateUpdate&&file==='/service-worker.js')data=Buffer.from(data.toString().replace("'v9-2'","'v9-test-update'"));res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain'});res.end(data);}catch{res.writeHead(404);res.end();}
}).listen(8765,'127.0.0.1');
try{
const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await context.route(/https:\/\/(api.gold-api.com|api.frankfurter.dev|r.jina.ai|xaus.com|api.allorigins.win)/,route=>{
 const u=route.request().url();let data;
 if(u.includes('gold-api')) data={price:4000};
 else if(u.includes('frankfurter'))data={rate:50,date:'2026-10-30'};
 else if(u.includes('isagha'))return route.fulfill({body:'عيار 24 6500 ج.م عيار 22',contentType:'text/plain'});
 else data={points:Array.from({length:190},(_,i)=>({d:new Date(Date.now()-(189-i)*86400000).toISOString().slice(0,10),c:3000+i*5}))};
 return route.fulfill({json:data});
});
await page.goto('http://127.0.0.1:8765/Gold-Prices/');
await page.waitForFunction(()=>document.querySelector('#liveLabel').textContent==='LIVE');
await page.evaluate(()=>navigator.serviceWorker.ready);
await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
assert((await page.locator('#egUsd').textContent()).includes('130.00'));
assert((await page.locator('#fx').textContent()).includes('50.00'));
for(const range of ['1W','1M','3M','6M']){
 await page.locator(`[data-range="${range}"]`).click();
 assert((await page.locator('#chartChangeLabel').textContent()).startsWith(range));
 assert(await page.locator('#goldChart path').count()===2);
}
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
const cdp=await context.newCDPSession(page);await cdp.send('Page.enable');
const manifest=await cdp.send('Page.getAppManifest');assert(!manifest.errors.length,JSON.stringify(manifest.errors));
const installability=await cdp.send('Page.getInstallabilityErrors');assert(installability.installabilityErrors.every(e=>e.errorId==='in-incognito'),JSON.stringify(installability));console.log('Installability:',JSON.stringify(installability));
const cached=await page.evaluate(async()=>{const c=await caches.open('gold-prices-shell-v9-2');return (await c.keys()).map(x=>x.url)});
assert(cached.length===11);assert(cached.every(u=>u.startsWith('http://127.0.0.1:8765/Gold-Prices/')));
await page.screenshot({path:'/tmp/gold-online.png',fullPage:true});
await context.setOffline(true);await page.reload();
await page.waitForFunction(()=>document.querySelector('#liveLabel').textContent==='OFFLINE');
assert((await page.locator('#egPrice').textContent()).includes('6,500'));
assert(await page.locator('#goldChart path').count()===2);
await page.locator('[data-range="1W"]').click();
await page.screenshot({path:'/tmp/gold-offline.png',fullPage:true});
await context.setOffline(false);
await page.waitForFunction(()=>document.querySelector('#liveLabel').textContent==='LIVE');
assert.deepEqual(errors,[]);console.log('PASS: mobile layout, manifest, service worker, all chart ranges, conversion, offline reload, cached chart, reconnection, no JavaScript errors');
// Expired history must stay visible even while every source is stalled or fails.
await page.evaluate(()=>{
  const saved=JSON.parse(localStorage.getItem('gold24-v8'));
  saved.historyAt=Date.now()-7*3600000;
  localStorage.setItem('gold24-v8',JSON.stringify(saved));
});
let releaseHistory;
const historyGate=new Promise(resolve=>releaseHistory=resolve);
let historyRequests=0;
const historyPattern=/https:\/\/(xaus.com|r.jina.ai\/https:\/\/xaus.com|api.allorigins.win)/;
await page.route(historyPattern,async route=>{
  historyRequests++;
  await historyGate;
  await route.abort().catch(()=>{});
});
await page.reload();
await page.waitForFunction(()=>document.querySelector('#diagHistory').textContent==='Updating saved chart…');
assert.equal(await page.locator('#goldChart path').count(),2);
assert.equal(await page.locator('#chartLoading').isVisible(),false);
await page.locator('[data-range="1M"]').click();
assert((await page.locator('#chartChangeLabel').textContent()).startsWith('1M'));
releaseHistory();
await page.waitForFunction(()=>document.querySelector('#diagHistory').textContent==='Cached');
assert.equal(await page.locator('#chartLoading').isVisible(),false);
assert.equal(historyRequests,3);
await page.unroute(historyPattern);
// With no saved chart, a valid fallback wins without waiting for the direct route.
await page.evaluate(()=>localStorage.removeItem('gold24-v8'));
let releaseDirect;
const directGate=new Promise(resolve=>releaseDirect=resolve);
await page.route('https://xaus.com/api/v1/history',async route=>{
  await directGate;
  await route.abort().catch(()=>{});
});
const started=Date.now();
await page.reload();
await page.waitForFunction(()=>document.querySelector('#diagHistory').textContent==='Live',null,{timeout:5000});
assert(Date.now()-started<5000);
assert.equal(await page.locator('#goldChart path').count(),2);
releaseDirect();
console.log('PASS: expired chart stays visible and interactive during failed refresh; fallback loads within 5 seconds despite stalled direct feed');
// An installed shell can receive an update without reinstalling or losing saved data.
simulateUpdate=true;
await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
await page.locator('#updateApp').waitFor({state:'visible'});
await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#updateApp').click()]);
await page.waitForFunction(async()=>
  (await caches.keys()).includes('gold-prices-shell-v9-test-update') &&
  document.querySelector('#updateApp').hidden &&
  !!localStorage.getItem('gold24-v8'));
assert(!(await page.evaluate(()=>caches.keys())).includes('gold-prices-shell-v9-2'));
console.log('PASS: update button activates new shell and preserves saved data without reinstalling');
simulateUpdate=false;
await context.close();
if(process.env.TEST_LIVE === '1'){
const live=await browser.newContext();const lp=await live.newPage();
await lp.goto('http://127.0.0.1:8765/Gold-Prices/');
await lp.waitForFunction(()=>document.querySelector('#refresh').textContent==='Refresh',{},{timeout:100000});
await lp.waitForFunction(()=>!['Waiting','Loading…'].includes(document.querySelector('#diagHistory').textContent),{},{timeout:100000});
console.log('LIVE FEEDS:',await lp.locator('#diag').innerText());
console.log('LIVE STATUS:',await lp.locator('#status').textContent());
await lp.screenshot({path:'/tmp/gold-real.png',fullPage:true});
await live.close();
}
}finally{server.close();await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
