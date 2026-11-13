'use strict';

/**
 * Public market observatory. Never accepts private workbooks.
 * Each observation keeps the event date, origin, and quality. The verified
 * local snapshot is a continuity fallback, not a newly observed market quote.
 */
const verified = require('../data/public_snapshot.json');
const RATES_URL = 'https://dulieukinhte.com/du-lieu/lai-suat-dieu-hanh-lien-ngan-hang-391';
const TENOR_ORDER = ['ON', '1W', '2W', '1M', '3M', '6M', '9M'];
const RATE_KEY = new Map([
  ['qua đêm', 'ON'], ['qua dem', 'ON'], ['overnight', 'ON'], ['on', 'ON'],
  ['1 tuần', '1W'], ['1 tuan', '1W'], ['1 week', '1W'], ['1w', '1W'],
  ['2 tuần', '2W'], ['2 tuan', '2W'], ['2 week', '2W'], ['2w', '2W'],
  ['1 tháng', '1M'], ['1 thang', '1M'], ['1 month', '1M'], ['1m', '1M'],
  ['3 tháng', '3M'], ['3 thang', '3M'], ['3 month', '3M'], ['3m', '3M'],
  ['6 tháng', '6M'], ['6 thang', '6M'], ['6 month', '6M'], ['6m', '6M'],
  ['9 tháng', '9M'], ['9 thang', '9M'], ['9 month', '9M'], ['9m', '9M'],
]);

function cleanHtml(value) {
  return String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}
function cleanRate(raw) {
  const s = cleanHtml(raw).replace(/%/g, '').replace(/\s/g, '');
  if (!/^\d{1,2}(?:[,.]\d{1,4})?$/.test(s)) return null;
  const v = Number(s.replace(',', '.'));
  return Number.isFinite(v) && v >= 0 && v <= 25 ? v : null;
}
function normalizedDate(raw) {
  const s = cleanHtml(raw);
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso=s;
  else if (/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(s)) {
    const [d,m,y]=s.split(/[-/.]/);
    iso=`${y}-${m}-${d}`;
  } else if (/^\d{4}[/.]\d{2}[/.]\d{2}$/.test(s)) iso=s.replace(/[/.]/g,'-');
  if (!iso) return null;
  const timestamp=Date.parse(iso+'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10)!==iso) return null;
  const futureBoundary=Date.now()+36*60*60*1000;
  if(timestamp>futureBoundary || timestamp<Date.parse('2023-01-01T00:00:00Z'))return null;
  return iso;
}
function normTenor(s) {
  return RATE_KEY.get(cleanHtml(s).toLowerCase()) || null;
}
function getRows(html) {
  return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(match => [...match[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
      .map(cell => cleanHtml(cell[1])));
}
function parsePublicRateHtml(html) {
  // The source publishes a 31-day table; keep the dates of actual observations.
  const tables = [...String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    .map(match => getRows(match[0]));
  const parsed = [];
  for (const rows of tables) {
    const header = rows.find(row => row.filter(x => normalizedDate(x)).length >= 3);
    if (!header) continue;
    const datePositions = header.map((value, index) => ({ date: normalizedDate(value), index })).filter(x => x.date);
    if (datePositions.length < 3) continue;
    for (const row of rows) {
      const t = row.slice(0, 3).map(normTenor).find(Boolean);
      if (!t || !TENOR_ORDER.includes(t)) continue;
      const offsets = row.length - header.length;
      // Only parse aligned tables; if HTML changes, use the verified snapshot.
      if (Math.abs(offsets) > 2) continue;
      for (const { date, index } of datePositions) {
        const raw = row[index + offsets];
        const v = cleanRate(raw);
        if (v === null) continue;
        parsed.push({ date, tenor:t, rate_pct:v, published_on:date,
          source:'NHNN · Dữ Liệu Kinh Tế', source_url:RATES_URL,
          quality:'public_observed', source_type:'sbv_daily_average' });
      }
    }
    if (parsed.length > 5) break;
  }
  return parsed;
}
async function fetchWithTimeout(url, ms=4500, headers={}) {
  const response = await fetch(url, { headers: { 'Accept':'application/json,text/html,text/csv,application/xml;q=0.8', ...headers }, signal: AbortSignal.timeout(ms) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response;
}
async function liveInterbank() {
  const response = await fetchWithTimeout(RATES_URL, 4500, { 'Accept':'text/html' });
  const rows = parsePublicRateHtml(await response.text());
  return rows.length >= 14 ? rows : [];
}
async function licensedRates() {
  // Optional configured provider. Not used in demo without a verified key.
  if (!process.env.DLPL_API_KEY) return [];
  const url = process.env.LICENSED_INTERBANK_URL;
  if (!url || !/^https:\/\//.test(url)) return [];
  const resp = await fetchWithTimeout(url, 4500, { Authorization:`Bearer ${process.env.DLPL_API_KEY}` });
  const body = await resp.json();
  const records = Array.isArray(body) ? body : body.results || body.data || [];
  if (!Array.isArray(records)) return [];
  return records.map(r => {
    const date = normalizedDate(r.date || r.rate_date);
    const tenor = normTenor(r.tenor || r.term);
    const rate = cleanRate(String(r.rate_pct ?? r.rate ?? ''));
    if (!date || !tenor || rate === null) return null;
    return { date, tenor, rate_pct: rate, published_on:date,
      source:'Nguồn lãi suất có đăng ký', source_url:url,
      quality:'licensed_observed', source_type:'sbv_daily_average' };
  }).filter(Boolean);
}
async function liveFx() {
  const url='https://raw.githubusercontent.com/AllRates-Today/central-bank-exchange-rates/main/data/sbv/latest.json';
  const res=await fetchWithTimeout(url,4500);const p=await res.json();
  const rates=Array.isArray(p)?p:p.rates||p.data?.rates||[];
  if(!Array.isArray(rates))return null;
  const row=rates.find(x=>String(x.base||x.from||x.currency||x.symbol||'').toUpperCase()==='USD'
    && String(x.quote||x.to||'VND').toUpperCase()==='VND'
    && ['reference','central'].includes(String(x.type||x.rate_type||'').toLowerCase()));
  if(!row)return null;
  const rate=Number(row.value??row.rate);
  const date=normalizedDate(p.rate_date||p.date||p.updated_at?.slice(0,10)||row.date||row.rate_date);
  if(!date||!Number.isFinite(rate)||rate<20000||rate>35000)return null;
  return {date,rate,source:'Tỷ giá trung tâm · nguồn tổng hợp',source_url:url,
    quality:'third_party_mirror',type:'central_reference'};
}
async function fred(series) {
  const url=`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(series)}&cosd=2026-01-01`;
  const res=await fetchWithTimeout(url,4500,{'Accept':'text/csv'});
  const lines=(await res.text()).trim().split(/\r?\n/);
  for(let i=lines.length-1;i>=1;i--){
    const [date,raw]=lines[i].split(',');const value=Number(raw);
    if(normalizedDate(date)&&raw!==''&&raw!=='.'&&Number.isFinite(value))
      return {date,value,source:'FRED',source_url:`https://fred.stlouisfed.org/series/${series}`,quality:'public_observed'};
  }
  return null;
}
function decodeXml(raw){return cleanHtml(String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1'));}
async function fetchNews() {
  const providers=[
    ['Google News','https://news.google.com/rss/search?q=l%C3%A3i+su%E1%BA%A5t+li%C3%AAn+ng%C3%A2n+h%C3%A0ng+NHNN&hl=vi&gl=VN&ceid=VN:vi'],
    ['Federal Reserve','https://www.federalreserve.gov/feeds/press_all.xml']
  ];
  const items=[];
  await Promise.allSettled(providers.map(async([source,url])=>{
    const r=await fetchWithTimeout(url,4200,{'Accept':'application/xml'});
    const xml=await r.text();
    for(const [,body] of [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0,16)){
      const field=k=>{const m=body.match(new RegExp(`<${k}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${k}>`,'i'));return m?decodeXml(m[1]):''};
      const title=field('title').slice(0,230),link=field('link'),pub=field('pubDate');
      const ts=Date.parse(pub);
      if(!title || !/^https:\/\//.test(link) || !Number.isFinite(ts) || Date.now()-ts>7*86400000 || ts>Date.now()+86400000)continue;
      items.push({title,link,date:new Date(ts).toISOString().slice(0,10),source});
    }
  }));
  return items.sort((a,b)=>b.date.localeCompare(a.date)).slice(0,16);
}
function mergeByKey(fallback, live, key) {
  const map = new Map(fallback.map(x=>[key(x),x]));
  for (const row of live) map.set(key(row),row);
  return [...map.values()];
}
function quoteFreshness(observationDate, utcNow=Date.now()){
  if(!observationDate)return null;
  const age=Math.floor((utcNow-Date.parse(observationDate+'T00:00:00+07:00'))/86400000);
  return age>=0?age:0;
}
async function buildMarketPayload({fetchExternal=true}={}) {
  const settled = fetchExternal ? await Promise.allSettled([
    liveInterbank(),licensedRates(),liveFx(),fred('SOFR'),fred('DGS10'),fetchNews()
  ]) : [];
  const ok=i => settled[i]?.status==='fulfilled'?settled[i].value:null;
  const intraday=[...(ok(0)||[]),...(ok(1)||[])];
  const interbank=mergeByKey(verified.interbank,intraday,x=>`${x.date}|${x.tenor}`)
    .filter(x=>x.rate_pct>=0 && x.rate_pct<=25)
    .sort((a,b)=>a.date.localeCompare(b.date)||TENOR_ORDER.indexOf(a.tenor)-TENOR_ORDER.indexOf(b.tenor));
  const latestPublic=interbank.at(-1)?.date||null;
  const latestInterbank=interbank.reduce((v,r)=>!v || r.date>v ? r.date:v,null);
  const liveRateDate=intraday.reduce((v,r)=>!v || r.date>v ? r.date:v,null);
  const fx=ok(2)&&ok(2).date>=verified.fx.date?ok(2):verified.fx;
  const macro={
    SOFR:ok(3)&&ok(3).date>=verified.macro.SOFR.date?ok(3):verified.macro.SOFR,
    DGS10:ok(4)&&ok(4).date>=verified.macro.DGS10.date?ok(4):verified.macro.DGS10,
  };
  const news=mergeByKey(verified.news,ok(5)||[],x=>x.link).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20);
  return {
    asOf:new Date().toISOString(),refreshIntervalMinutes:60,
    interbank,marketQuotes:verified.marketQuotes,
    fx,macro,bonds:verified.bonds,news,
    coverage:{ratesDates:[...new Set(interbank.map(x=>x.date))].length,tenors:TENOR_ORDER,
      latestDailyDate:latestInterbank,latestProviderDate:liveRateDate,
      dailyAgeDays:quoteFreshness(latestInterbank)},
    providers:[
      {id:'sbv',status:intraday.length?'live':'snapshot',latestDate:latestInterbank,count:interbank.length},
      {id:'fx',status:fx.quality==='public_verified_snapshot'?'snapshot':'live',latestDate:fx.date},
      {id:'fred_sofr',status:macro.SOFR.quality==='public_verified_snapshot'?'snapshot':'live',latestDate:macro.SOFR.date},
      {id:'fred_dgs10',status:macro.DGS10.quality==='public_verified_snapshot'?'snapshot':'live',latestDate:macro.DGS10.date},
    ],
  };
}
async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'method_not_allowed'});
  res.setHeader('Cache-Control','public, s-maxage=3600, stale-while-revalidate=3600');
  res.setHeader('X-Content-Type-Options','nosniff');
  try{return res.status(200).json(await buildMarketPayload());}
  catch(e){return res.status(200).json(await buildMarketPayload({fetchExternal:false}));}
}
module.exports=handler;
module.exports.__test={parsePublicRateHtml,buildMarketPayload,cleanRate,normalizedDate,quoteFreshness};
