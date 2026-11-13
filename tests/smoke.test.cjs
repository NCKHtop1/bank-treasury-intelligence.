'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p),'utf8');
const demo = JSON.parse(read('data/demo.json'));
const snapshot = JSON.parse(read('data/public_snapshot.json'));
const api = require('../api/market.js');
function responder(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},status(v){this.statusCode=v;return this},json(v){this.body=v;return this}};}

test('demo observations synthetic, chronological, and private Trade Finance null',()=>{
 assert.equal(demo.meta.kind,'synthetic');
 assert.ok(demo.series.length>=200);
 for(let i=1;i<demo.series.length;i++) assert.ok(demo.series[i].date>demo.series[i-1].date);
 for(const r of demo.series){
   assert.equal(r.trade_finance_bn,null);
   const sum = r.invest_gtcg_bn+r.reso_bn+r.secured_bn+r.unsecured_bn+r.swap_bn;
   assert.ok(Math.abs(r.loan_bn-sum)<.051,`Reconciliation date=${r.date}`);
   assert.ok(Math.abs(r.ld_scale_bn-r.secured_bn-r.unsecured_bn)<.051,`L&D date=${r.date}`);
   assert.ok(r.fx_bid<=r.fx_mid&&r.fx_mid<=r.fx_ask,`FX bid/mid/ask ${r.date}`);
 }
});

test('private Excel stays browser-side; AI remote endpoint rejects private data',()=>{
 const app=read('assets/app.js'),loader=read('assets/loader.js'),assistant=read('api/assistant.js');
 assert.match(app,/readUserFile\(file\)/);
 assert.match(loader,/file\.arrayBuffer\(\)/);
 assert.match(assistant,/only_public_question_allowed/);
 assert.ok(!fs.existsSync(path.join(root,'api/upload.js')));
 assert.ok(!fs.existsSync(path.join(root,'data/private.json')));
});

test('public source time series covers seven distinct tenors, with attribution',()=>{
 assert.equal(snapshot.interbank.length,70);
 const tenors=new Set(snapshot.interbank.map(x=>x.tenor));
 assert.deepEqual([...tenors].sort(),['1M','1W','2W','3M','6M','9M','ON'].sort());
 assert.equal(new Set(snapshot.interbank.map(x=>`${x.date}|${x.tenor}`)).size,snapshot.interbank.length);
 assert.ok(snapshot.interbank.every(x=>Number.isFinite(x.rate_pct)&&x.rate_pct>=0&&x.rate_pct<=25&&x.date&&x.source&&x.source_url?.startsWith('https://')&&x.quality));
 assert.ok(snapshot.marketQuotes.every(x=>x.source_type==='interbank_indicative_rounded'&&x.source_url));
 assert.ok(snapshot.bonds.every(x=>x.tenor&&x.yield_pct&&x.source_url));
 assert.ok(snapshot.news.every(x=>x.title&&x.date&&x.link));
});

test('provider timeout still returns fully sourced snapshot with market FX and US macro',async()=>{
 const prev=global.fetch;global.fetch=async()=>{throw Error('network down');};
 const out=responder();try{await api({method:'GET'},out);}finally{global.fetch=prev;}
 assert.equal(out.statusCode,200);
 assert.equal(out.body.interbank.find(x=>x.date==='2026-11-11'&&x.tenor==='ON').rate_pct,4.33);
 assert.equal(out.body.marketQuotes.find(x=>x.tenor==='ON').rate_pct,4.8);
 assert.ok(out.body.fx.rate>20000);
 assert.equal(out.body.macro.SOFR.value,3.89);
 assert.equal(out.body.macro.DGS10.value,4.98);
 assert.ok(out.body.bonds.length>=5&&out.body.news.length>=3);
 assert.equal(out.body.refreshIntervalMinutes,60);
 assert.equal(out.headers['Cache-Control'],'public, s-maxage=3600, stale-while-revalidate=3600');
 assert.ok(out.body.providers.some(x=>x.status==='snapshot'));
});

test('public HTML parser normalizes rate decimal and date, rejects text noise',()=>{
 const html=`<table><tr><th>Kỳ hạn</th><th>10-11-2026</th><th>11-11-2026</th><th>12-11-2026</th></tr><tr><th>ON</th><td>4,20</td><td>4.33</td><td>4.75</td></tr><tr><th>1W</th><td>4,36</td><td>4,66</td><td>4.83</td></tr><tr><th>3M</th><td>6,00</td><td>6.33</td><td>—</td></tr></table>`;
 const parsed=api.__test.parsePublicRateHtml(html);
 assert.equal(parsed.length,8);
 assert.equal(parsed.find(x=>x.date==='2026-11-11'&&x.tenor==='ON').rate_pct,4.33);
 assert.ok(!parsed.some(x=>x.date==='2026-11-12'&&x.tenor==='3M'));
 assert.equal(api.__test.cleanRate('4.82%'),4.82);
 assert.equal(api.__test.cleanRate('35,50'),null);
 assert.equal(api.__test.cleanRate('<script>bad()</script>'),null);
 assert.equal(api.__test.normalizedDate('11/11/2026'),'2026-11-11');
 assert.equal(api.__test.normalizedDate('31-02-2026'),null);
 assert.equal(api.__test.normalizedDate('2030-12-31'),null);
});

test('hourly refresh is wired; no Vercel Hobby hourly cron misconfiguration',()=>{
 const app=read('assets/app.js'),v=JSON.parse(read('vercel.json'));
 assert.match(app,/setInterval\(\(\)=>refreshPublic\(\),60\*60\*1000\)/);
 assert.match(app,/visibilitychange/);
 assert.ok(!('crons' in v));
 const workflow=read('.github/workflows/public-market-hourly.yml');
 assert.match(workflow,/cron: ['"]0 0-12 \* \* 1-5['"]/);
 assert.match(workflow,/VERCEL_AUTOMATION_BYPASS_SECRET/);
});

test('date/tenor UI provenance does not compare rate changes across incompatible series',()=>{
 const app=read('assets/app.js');
 assert.match(app,/deltaMatchedToOrigin\(tenor,observed\)/);
 assert.match(app,/observed\.source_type==='interbank_indicative_rounded'/);
 assert.match(app,/deltaMatchedToOrigin\(tenor,obs\)/);
 assert.match(app,/state\.data\?\.meta\?\.kind==='synthetic' \? \[\] : dailyFiltered/);
});
