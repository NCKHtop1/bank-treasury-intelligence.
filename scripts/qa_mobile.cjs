/* TreasuryIQ browser acceptance tests: public-first, responsive UX, encrypted device cache. */
const fs=require('fs');
const path=require('path');
const http=require('http');
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
const server=http.createServer((req,res)=>{
 const name=decodeURIComponent((req.url||'/').split('?')[0]);
 const safe=path.normalize(name).replace(/^(\.\.(\/|\\|$))+/,'').replace(/^\/+/,'');
 const full=path.resolve(ROOT,safe||'index.html');
 if(full!==ROOT&&!full.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end('Forbidden')}
 const file=fs.existsSync(full)&&fs.statSync(full).isFile()?full:path.join(ROOT,'index.html');
 res.setHeader('Content-Type',MIME[path.extname(file)]||'application/octet-stream');
 res.setHeader('Cache-Control','no-store');
 fs.createReadStream(file).pipe(res);
});
async function ready(page){
 await page.goto('http://127.0.0.1:8765/',{waitUntil:'domcontentloaded'});
 await page.locator('#quickRateGrid .rate-tile').first().waitFor({timeout:16000});
 await page.waitForFunction(()=>document.querySelectorAll('#quickRateGrid .rate-tile').length===7,{timeout:12000});
}
async function metrics(page,width,label){
 const v=await page.evaluate(()=>{
  const doc=document.documentElement,body=document.body;
  const tiled=[...document.querySelectorAll('#quickRateGrid .rate-tile')];
  const elements=[...document.querySelectorAll('.page .view.active *')].filter(el=>{
   const st=getComputedStyle(el),box=el.getBoundingClientRect();
   return box.width>20&&st.display!=='none'&&st.visibility!=='hidden'&&box.right>innerWidth+5;
  }).slice(0,10).map(el=>({tag:el.tagName,cls:el.className?.toString().slice(0,45),right:Math.round(el.getBoundingClientRect().right)}));
  return {
    innerWidth,scrollWidth:doc.scrollWidth,bodyWidth:body.scrollWidth,
    rates:tiled.length,rateNumbers:tiled.filter(x=>/\d+,\d+/.test(x.textContent)).length,
    marketOnly:body.classList.contains('market-only'),
    bookHidden:getComputedStyle(document.querySelector('.book-intro-panel')).display==='none',
    dockVisible:getComputedStyle(document.querySelector('.mobile-dock')).display!=='none',
    kpiCards:document.querySelectorAll('#kpiGrid .kpi-card').length,
    clipped:elements
  }
 });
 console.log(label+' @ '+width+'px: '+JSON.stringify(v));
 assert.equal(v.rates,7,'Rates missing at '+width);
 assert.ok(v.rateNumbers>=6,'Most rates not rendered at '+width);
 assert.ok(v.bookHidden,'Empty book banner should not take space');
 assert.ok(v.marketOnly,'Landing should be in public-market mode');
 assert.ok(v.kpiCards>=4,'Market KPI cards missing');
 if(width<=760)assert.ok(v.dockVisible,'Mobile nav not visible');
 if(width>760)assert.ok(!v.dockVisible,'Mobile nav showing on desktop');
 assert.ok(v.scrollWidth<=width+6,'Horizontal page overflow at '+width);
 return v;
}
async function run(){
 await new Promise((resolve,reject)=>server.listen(8765,'127.0.0.1',err=>err?reject(err):resolve()));
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 let pages=0;
 try{
  for(const width of [360,390,430,768,1280]){
   const ctx=await browser.newContext({viewport:{width,height:width<=430?820:900},deviceScaleFactor:1});
   const page=await ctx.newPage();
   const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await ready(page);
   await metrics(page,width,'PUBLIC');
   if(width===390){
    await page.locator('.mobile-dock [data-nav="portfolio"]').click();
    await page.locator('.view[data-view="portfolio"].active').waitFor();
    const text=await page.locator('#reconDetails').innerText();
    assert.ok(text.includes('ON'),'Treasury spreads missing');
    assert.ok(!text.includes('Nạp Excel'),'Import prompt still shown in portfolio');
    await page.locator('.mobile-dock [data-nav="fx"]').click();
    await page.locator('.view[data-view="fx"].active').waitFor();
    assert.ok(await page.locator('#fxChart svg').count()>0,'FX chart missing');
    await page.locator('.mobile-dock [data-nav="rates"]').click();
    await page.locator('.view[data-view="rates"].active').waitFor();
    assert.ok(await page.locator('#ratesLegend2 .legend-button').count()>=4,'Rate toggles missing');
    await page.locator('.mobile-dock [data-nav="overview"]').click();
    await page.screenshot({path:'mobile-390-public.png',fullPage:true});
    const scenario={meta:{kind:'private-local',asOf:'2026-11-10',source_file:'test-fixture.xlsx'},series:[
      {date:'2026-11-07',loan_bn:100,total_mm_bn:100,invest_gtcg_bn:40,reso_bn:10,secured_bn:20,unsecured_bn:10,swap_bn:20,gtcg_scale_bn:60,gtcg_lsbq_pct:5.1,ld_scale_bn:30,ld_nim_pct:2.5},
      {date:'2026-11-10',loan_bn:120,total_mm_bn:120,invest_gtcg_bn:45,reso_bn:10,secured_bn:25,unsecured_bn:15,swap_bn:25,gtcg_scale_bn:64,gtcg_lsbq_pct:5.2,ld_scale_bn:40,ld_nim_pct:2.7}
    ],mapping:{},source_freshness:{},warnings:[],monthlyBooks:[]};
    const persisted=await page.evaluate(async d=>{
      const m=await import('./assets/device-cache.mjs');
      await m.saveLastWorkbook(d);
      return (await m.loadLastWorkbook())?.series?.length;
    },scenario);
    assert.equal(persisted,2,'Device cache could not round-trip encrypted data');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('#mmOverview .mm-kpi').first().waitFor({timeout:16000});
    const saved=await page.locator('#sourceBadge').innerText();
    assert.ok(saved.includes('WORKBOOK'),'Cached workbook not auto-restored: '+saved);
    assert.equal(await page.locator('#clearDeviceCache').isVisible(),true,'Delete cache action missing');
    await page.screenshot({path:'mobile-390-remembered.png',fullPage:true});
    await page.locator('.mobile-dock [data-nav="portfolio"]').click();
    assert.ok(await page.locator('#mmAnalyticWorkspace').isVisible(),'Risk workspace not visible');
    await page.locator('.mobile-dock [data-nav="overview"]').click();
    await page.locator('.sidebar .nav-link[data-nav="quality"]').count();
    await page.locator('#clearDeviceCache').evaluate(el=>el.click());
    await page.waitForFunction(()=>document.body.classList.contains('market-only'));
    assert.ok(await page.locator('.book-intro-panel').isHidden(),'Book introduction remained after clearing cache');
    console.log('ENCRYPTED DEVICE CACHE: pass (save, restore, clear)');
   }else if(width===360){
    await page.screenshot({path:'mobile-360-public.png',fullPage:true});
   }else if(width===1280){
    await page.screenshot({path:'desktop-1280-public.png',fullPage:true});
   }
   assert.deepEqual(errors,[],'JavaScript runtime errors at '+width+': '+errors.join(', '));
   await ctx.close();pages++;
  }
  console.log('ALL BROWSER QA PASSED: '+pages+' viewports, market dashboard, mobile nav, FX, rates and saved workbook');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
}
run().catch(e=>{console.error('BROWSER QA FAILURE:',e.stack||e);process.exitCode=1;server.close()});
