'use strict';
/**
 * TreasuryIQ public-only refresh. Never reads, downloads, stores or pushes
 * bank workbook data. All observations carry their date and source.
 * Requires Node 20+ and ../api/market.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildMarketPayload } = require('../api/market.js').__test;
const TENORS = new Set(['ON','1W','2W','1M','3M','6M','9M']);
const DATE = /^20\d\d-\d\d-\d\d$/;
const safeDate = v => DATE.test(String(v||'')) && !Number.isNaN(Date.parse(v+'T00:00:00Z')) && Date.parse(v+'T00:00:00Z') <= Date.now()+86400000;
const signature = p => JSON.stringify({
  rates:p.interbank, quotes:p.marketQuotes,fx:p.fx,fxHistory:p.fxHistory,
  macro:p.macro,bonds:p.bonds,news:p.news
});
(async()=>{
 const target=path.resolve(process.argv[2]||'data/public_snapshot.json');
 const previous=JSON.parse(fs.readFileSync(target,'utf8'));
 const live=await buildMarketPayload({fetchExternal:process.env.TREASURY_OFFLINE!=='1'});
 const updated={...previous};
 const byKey=new Map((previous.interbank||[]).map(x=>[x.date+'|'+x.tenor,x]));
 for(const obs of live.interbank||[]){
  if(!TENORS.has(obs.tenor)||!safeDate(obs.date))continue;
  if(!Number.isFinite(Number(obs.rate_pct))||Number(obs.rate_pct)<0||Number(obs.rate_pct)>25)continue;
  if(!/^https:\/\//.test(String(obs.source_url||'')))continue;
  byKey.set(obs.date+'|'+obs.tenor,obs);
 }
 updated.interbank=[...byKey.values()].sort((a,b)=>a.date.localeCompare(b.date)||[...TENORS].indexOf(a.tenor)-[...TENORS].indexOf(b.tenor));
 for(const key of ['fx','macro','news']){
  if(key==='fx'){
   const x=live.fx;
   if(x&&safeDate(x.date)&&Number(x.rate)>20000&&Number(x.rate)<35000
      &&x.date>=(updated.fx?.date||'')&&/^https:\/\//.test(x.source_url||''))updated.fx=x;
  }else if(key==='macro'){
   for(const k of ['SOFR','DGS10']){
    const x=live.macro?.[k],old=updated.macro?.[k];
    if(x&&safeDate(x.date)&&Number.isFinite(Number(x.value))&&Math.abs(Number(x.value))<30
      &&x.date>=(old?.date||'')&&/^https:\/\//.test(x.source_url||'')){
      updated.macro={...(updated.macro||{}),[k]:x};
    }
   }
  }else if(Array.isArray(live.news)){
   const newsMap=new Map((previous.news||[]).map(x=>[x.link,x]));
   for(const x of live.news)if(safeDate(x.date)&&/^https:\/\//.test(x.link||''))newsMap.set(x.link,x);
   updated.news=[...newsMap.values()].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20);
  }
 }
 const fx=updated.fx;
 const fxMap=new Map((previous.fxHistory||[]).map(x=>[x.date,x]));
 if(fx&&safeDate(fx.date)&&Number.isFinite(Number(fx.rate))&&Number(fx.rate)>20000&&Number(fx.rate)<35000){
  fxMap.set(fx.date,{date:fx.date,rate:Number(fx.rate),source:fx.source,source_url:fx.source_url,quality:fx.quality});
 }
 updated.fxHistory=[...fxMap.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-366);
 if(updated.interbank.length<14||[...TENORS].some(t=>!updated.interbank.some(x=>x.tenor===t)))throw Error('Interbank completeness gate failed');
 if(signature(previous)===signature(updated)){
  console.log('TreasuryIQ: no new verified public observations; retaining previous snapshot.');
  return;
 }
 updated.meta={...previous.meta,checkedAt:new Date().toISOString(),kind:'public_snapshot'};
 fs.writeFileSync(target,JSON.stringify(updated,null,2)+'\n','utf8');
 console.log('TreasuryIQ: updated public market snapshot. Newest interbank: '+updated.interbank.at(-1).date+', FX: '+updated.fx.date);
})().catch(err=>{console.error('Market sync validation or provider failed:',err.message);process.exitCode=1});
