import { readUserFile } from './loader.js';
import {saveLastWorkbook,loadLastWorkbook,clearLastWorkbook} from './device-cache.mjs';
import {renderTreasuryWorkspace,mmAnalystAnswer} from './treasury-workspace.mjs';
import {mmAggregate} from './treasury-analytics.mjs';

const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const esc=v=>String(v??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const n=(v,opts={})=>v===null||v===undefined||!Number.isFinite(+v)?'—':Number(v).toLocaleString('vi-VN',{maximumFractionDigits:opts.d??2,minimumFractionDigits:opts.min??0});
const shortDate=d=>d?new Date(d+'T00:00:00').toLocaleDateString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric'}):'—';
const rateText=v=>v===null||!Number.isFinite(+v)?'—':`${n(v,{d:2})}%`;
const seriesLabels={
 itb_on:'ON · Nội bộ',itb_1w:'1W · Nội bộ',itb_2w:'2W · Nội bộ',itb_1m:'1M · Nội bộ',itb_3m:'3M · Nội bộ',itb_6m:'6M · Nội bộ',itb_9m:'9M · Nội bộ',
 itb_on_public:'ON · NHNN',itb_1w_public:'1W · NHNN',itb_2w_public:'2W · NHNN',itb_1m_public:'1M · NHNN',itb_3m_public:'3M · NHNN',itb_6m_public:'6M · NHNN',itb_9m_public:'9M · NHNN'
};
const colors={
 itb_on:'#3f73ae',itb_1w:'#289e94',itb_2w:'#6382aa',itb_1m:'#d0924d',itb_3m:'#8d78c3',itb_6m:'#bb7891',itb_9m:'#6e91a9',
 itb_on_public:'#2b83cf',itb_1w_public:'#19ac9a',itb_2w_public:'#6383c7',itb_1m_public:'#df993b',itb_3m_public:'#796acf',itb_6m_public:'#bc688a',itb_9m_public:'#71939d',
 loan_bn:'#326fbc',ld_scale_bn:'#18a8a1',gtcg_scale_bn:'#5d85cf',gtcg_lsbq_pct:'#e5a15f',fx_mid:'#3b83b9',fx_bid:'#18a499',fx_ask:'#dd9863',vbma_swap_on:'#298ab5',vbma_swap_1m:'#14a59c',vbma_swap_3m:'#9c7ec7'
};
const RATE_FIELDS=['itb_on','itb_1w','itb_2w','itb_1m','itb_3m','itb_6m','itb_9m'];
const VBMA_FIELDS=['vbma_swap_on','vbma_swap_1m','vbma_swap_3m','vbma_itb_on','vbma_1y','vbma_3y','vbma_5y','vbma_10y'];
const PUBLIC_FIELDS=RATE_FIELDS.map(key=>key+'_public');
Object.assign(seriesLabels,{vbma_swap_on:'Swap ON · VBMA',vbma_swap_1m:'Swap 1M · VBMA',vbma_swap_3m:'Swap 3M · VBMA',vbma_itb_on:'ITB ON · VBMA',vbma_1y:'Yield 1Y · VBMA',vbma_3y:'Yield 3Y · VBMA',vbma_5y:'Yield 5Y · VBMA',vbma_10y:'Yield 10Y · VBMA'});
Object.assign(colors,{vbma_itb_on:'#527cc9',vbma_1y:'#6f9b9c',vbma_3y:'#bc7789',vbma_5y:'#906ebf',vbma_10y:'#9d6b3e'});
const TERM_LABELS=['ON','1W','2W','1M','3M','6M','9M'];
const instruments=[['invest_gtcg_bn','Đầu tư GTCG','#3d75bf'],['reso_bn','Mua bán GTCG kỳ hạn','#47b5ab'],['secured_bn','Có TSĐB','#7b8bc5'],['unsecured_bn','Tín chấp','#f1b25b'],['swap_bn','Swap','#9a77bf']];
const state={
 data:null,
 publicMarket:{interbank:[],marketQuotes:[],fx:null,macro:{},bonds:[],news:[],providers:[]},
 period:'3M',freq:'daily',activePage:'overview',
 activeRates:new Set(['itb_on_public','itb_1w_public','itb_1m_public','itb_3m_public']),
 llm:false,importing:false,lastMarketFetch:0,marketRefreshing:false
};
const names={books:'Book Dashboard',overview:'Overview',rates:'Interbank rates',portfolio:'MM & Liquidity',bonds:'GTCG & VBMA',fx:'FX & Swap',news:'Market intelligence',assistant:'AI Analyst',quality:'Data quality'};
let toastTimeout=null;
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('show'),5200)}
function pageTo(page){if(!names[page])return;state.activePage=page;$$('.view').forEach(x=>x.classList.toggle('active',x.dataset.view===page));$$('[data-nav]').forEach(x=>x.classList.toggle('active',x.dataset.nav===page));$('#breadcrumb').textContent=names[page];$('#sidebar').classList.remove('open');window.scrollTo({top:0,behavior:'instant'});}
function dateCompare(a,b){return (a||'').localeCompare(b||'')}
function dataRows(){return state.data?.series||[]}
function last(){return dataRows().at(-1)||{}}
function latestValid(key,rows=dataRows()){for(let i=rows.length-1;i>=0;i--){const v=rows[i][key];if(Number.isFinite(+v)&&v!==null&&v!==undefined)return {date:rows[i].date,value:Number(v)}}return null}
function olderValid(key,offset=20){const rows=dataRows();if(rows.length<offset+1)return null;const idx=Math.max(0,rows.length-1-offset);for(let i=idx;i>=0;i--)if(rows[i][key]!=null&&Number.isFinite(+rows[i][key]))return Number(rows[i][key]);return null}
function calcDays(a,b){return a&&b?Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/86400000):null}
function periodStart(maxDate){if(!maxDate)return'0000-01-01';const max=new Date(maxDate+'T00:00:00');if(state.period==='ALL')return'0000-01-01';if(state.period==='1M')max.setMonth(max.getMonth()-1);if(state.period==='3M')max.setMonth(max.getMonth()-3);if(state.period==='6M')max.setMonth(max.getMonth()-6);if(state.period==='YTD'){max.setMonth(0);max.setDate(1)}return max.toISOString().slice(0,10)}
function dailyFiltered(){const rows=dataRows();const bound=periodStart(rows.at(-1)?.date);return rows.filter(x=>x.date>=bound)}
function dataFiltered(){const rows=dailyFiltered();if(state.freq==='daily')return rows;const by=new Map();for(const x of rows){const month=x.date.slice(0,7);if(!by.has(month))by.set(month,[]);by.get(month).push(x)}return [...by].map(([month,entries])=>{if(state.freq==='monthly_eop')return entries.at(-1);const out={date:entries.at(-1).date};for(const key of Object.keys(entries.at(-1)))if(key!=='date'){const valid=entries.map(x=>x[key]).filter(x=>typeof x==='number'&&Number.isFinite(x));out[key]=valid.length?valid.reduce((a,b)=>a+b,0)/valid.length:null}return out})}
function rateRows(){
 const raw=state.data?.meta?.kind!=='private-local' ? [] : dailyFiltered().map(x=>({...x}));
 const map=new Map(raw.map(x=>[x.date,x]));
 const termToField={ON:'itb_on_public','1W':'itb_1w_public','2W':'itb_2w_public','1M':'itb_1m_public','3M':'itb_3m_public','6M':'itb_6m_public','9M':'itb_9m_public'};
 for(const p of state.publicMarket.interbank||[]){
   if(!p?.date||!termToField[p.tenor]||!Number.isFinite(+p.rate_pct))continue;
   if(!map.has(p.date))map.set(p.date,{date:p.date});
   map.get(p.date)[termToField[p.tenor]]=Number(p.rate_pct);
 }
 const latest=[dataRows().at(-1)?.date,...(state.publicMarket.interbank||[]).map(x=>x.date)].filter(Boolean).sort().at(-1);
 const rows=[...map.values()].sort((a,b)=>dateCompare(a.date,b.date)).filter(x=>x.date>=periodStart(latest));return state.freq==='daily'?rows:mmAggregate(rows,state.freq);
}
function kpi({label,metric,unit,icon,mode}){const recent=latestValid(metric),old=olderValid(metric),curr=recent?.value;const diff=curr!=null&&old!=null?curr-old:null;const pct=curr!=null&&old?100*diff/Math.abs(old):null;const value=curr==null?'—':n(curr,{d:mode==='rate'?2:mode==='fx'?0:1});const delta=diff==null?'—':`${diff>0?'+':''}${mode==='rate'?n(diff,{d:2})+'đ':n(pct,{d:1})+'%'}`;const dir=diff==null?'flat':diff>0?'pos':diff<0?'neg':'flat';return `<div class="kpi-card"><div class="kpi-head">${esc(label)}<span class="kpi-symbol">${icon}</span></div><div class="kpi-value">${value}<small>${unit}</small></div><div class="kpi-bottom"><span class="delta ${dir}">${delta}</span><span>so với khoảng 20 phiên · ${esc(recent?.date||'—')}</span></div></div>`}
function renderKpis(){
 const defs=[{label:'Quy mô MM',metric:'loan_bn',unit:'tỷ VND',icon:'▤'},{label:'L&D NIM',metric:'ld_nim_pct',unit:'điểm %',icon:'◈',mode:'rate'},{label:'USD/VND · Mid',metric:'fx_mid',unit:'VND',icon:'⇆',mode:'fx'}];
 const benchmark=publicDisplay('ON');
 const pct=benchmark?rateText(benchmark.rate_pct):'—';
 const onCard=`<div class="kpi-card featured-kpi"><div class="kpi-head">Lãi suất ON <span class="kpi-symbol">〰</span></div><div class="kpi-value">${pct.replace('%','')}<small>%/năm</small></div><div class="kpi-bottom"><span class="data-pill">${esc(benchmark?.source_type==='interbank_indicative_rounded'?'Bản tin LNH':'NHNN')}</span><span>${shortDate(benchmark?.date)}</span></div></div>`;
 $('#kpiGrid').innerHTML=[kpi(defs[0]),onCard,kpi(defs[1]),kpi(defs[2])].join('');
 $('#portfolioKpis').innerHTML=[defs[0],{label:'Quy mô L&D',metric:'ld_scale_bn',unit:'tỷ VND',icon:'▤'}, {label:'Đầu tư GTCG',metric:'invest_gtcg_bn',unit:'tỷ VND',icon:'◈'},defs[1]].map(kpi).join('');
 const publicBond=state.publicMarket.bonds||[];
 const bondKpis=['5Y','10Y'].map(t=>{
  const b=publicBond.find(x=>x.tenor===t);
  return `<div class="kpi-card"><div class="kpi-head">Lợi suất TPCP ${t}<span class="kpi-symbol">◈</span></div><div class="kpi-value">${b?n(b.yield_pct,{d:2}):'—'}<small>%/năm</small></div><div class="kpi-bottom">${b?shortDate(b.date):'—'} · Thị trường</div></div>`;
 });
 $('#bondKpis').innerHTML=[kpi({label:'Quy mô GTCG ròng',metric:'gtcg_scale_bn',unit:'tỷ VND',icon:'▤'}),kpi({label:'LSBQ GTCG',metric:'gtcg_lsbq_pct',unit:'%/năm',icon:'〰',mode:'rate'}),...bondKpis].join('');
 const fx=state.publicMarket.fx;
 const fxCard=`<div class="kpi-card featured-kpi"><div class="kpi-head">Tỷ giá trung tâm USD/VND<span class="kpi-symbol">⇆</span></div><div class="kpi-value">${n(fx?.rate,{d:0})}<small>VND</small></div><div class="kpi-bottom">${shortDate(fx?.date)} · ${esc(fx?.source||'Nguồn thị trường')}</div></div>`;
 $('#fxKpis').innerHTML=[fxCard,kpi({label:'USD/VND Mid · Workbook',metric:'fx_mid',unit:'VND',icon:'⇆',mode:'fx'}),kpi({label:'USD/VND Bid',metric:'fx_bid',unit:'VND',icon:'⇆',mode:'fx'}),kpi({label:'Swap 1M',metric:'vbma_swap_1m',unit:'%/năm',icon:'〰',mode:'rate'})].join('');
}
function pathFor(rows,key,x,y){let p='',started=false;rows.forEach((r,i)=>{const z=r[key];if(typeof z!=='number'||!Number.isFinite(z)){started=false;return}p+=`${started?'L':'M'}${x(i).toFixed(2)},${y(z).toFixed(2)} `;started=true});return p.trim()}
function makeChart(el,rows,defs,{unit='rate',note='',empty='Chưa có dữ liệu',pointMode=false}={}){if(!el)return;const validDefs=defs.filter(d=>rows.some(r=>r[d.key]!=null&&Number.isFinite(+r[d.key])));if(!rows.length||!validDefs.length){el.innerHTML=`<div class="chart-error">${esc(empty)}</div>`;return}const compact=window.innerWidth<=760;const available=el.clientWidth||(window.innerWidth-52);const w=compact?Math.max(326,Math.min(600,available)):Math.max(600,Math.min(1000,available));const h=compact?258:318,pad={left:unit==='fx'?60:54,right:14,top:19,bottom:37};const vals=validDefs.flatMap(d=>rows.map(r=>r[d.key]).filter(x=>typeof x==='number'&&Number.isFinite(x)));let min=Math.min(...vals),max=Math.max(...vals),range=max-min;if(range===0)range=Math.max(1,Math.abs(max)*.2);min-=range*.15;max+=range*.19;const x=i=>pad.left+(rows.length===1?(w-pad.left-pad.right)/2:i/(rows.length-1)*(w-pad.left-pad.right));const y=v=>pad.top+(max-v)/(max-min)*(h-pad.top-pad.bottom);const f=v=>unit==='bn'?n(v,{d:0}):unit==='fx'?n(v,{d:0}):n(v,{d:1});const grid=Array.from({length:5},(_,i)=>{const frac=i/4,yy=pad.top+frac*(h-pad.top-pad.bottom);return `<line class="chart-grid" x1="${pad.left}" x2="${w-pad.right}" y1="${yy}" y2="${yy}"/><text x="${pad.left-9}" y="${yy+4}" text-anchor="end">${f(max-frac*(max-min))}</text>`}).join('');const ticks=Array.from(new Set(compact?[0,Math.round((rows.length-1)*.5),rows.length-1]:[0,Math.round((rows.length-1)*.25),Math.round((rows.length-1)*.5),Math.round((rows.length-1)*.75),rows.length-1])).map(i=>`<text x="${x(i)}" y="${h-8}" text-anchor="middle">${esc(rows[i].date.slice(5).replace('-','/'))}</text>`).join('');const lines=validDefs.map((d,j)=>{const col=d.color||colors[d.key]||['#2b79b8','#17a49b','#b47aa7'][j%3],p=pathFor(rows,d.key,x,y);const lastidx=rows.findLastIndex(row=>typeof row[d.key]==='number'&&Number.isFinite(row[d.key]));const dot=lastidx>=0?`<circle cx="${x(lastidx)}" cy="${y(rows[lastidx][d.key])}" r="3.5" fill="${col}" stroke="#fff" stroke-width="2"/>`:'';return `<path class="chart-line" stroke="${col}" stroke-dasharray="${d.dash?'6,6':'none'}" d="${p}"/>${dot}`}).join('');el.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(note||'Biểu đồ chuỗi thời gian')}">${grid}${ticks}<g>${lines}</g><line class="hover-line" style="display:none" stroke="#71869d" stroke-dasharray="4 4" x1="0" x2="0" y1="${pad.top}" y2="${h-pad.bottom}"/><rect class="hover-layer" x="${pad.left}" y="${pad.top}" width="${w-pad.left-pad.right}" height="${h-pad.top-pad.bottom}" fill="transparent"/></svg><div class="chart-tooltip"></div>`;const svg=$('svg',el),overlay=$('.hover-layer',svg),cross=$('.hover-line',svg),tooltip=$('.chart-tooltip',el);const touch=ev=>{const rect=svg.getBoundingClientRect();const ratio=(ev.clientX-rect.left)/rect.width;const i=Math.max(0,Math.min(rows.length-1,Math.round((ratio*w-pad.left)/(w-pad.left-pad.right)*(rows.length-1))));const row=rows[i];cross.style.display='block';cross.setAttribute('x1',x(i));cross.setAttribute('x2',x(i));let content=`<div style="font-weight:750;margin-bottom:6px">${shortDate(row.date)}</div>`;for(const d of validDefs){const v=row[d.key];if(v==null||!Number.isFinite(+v))continue;content+=`<div style="margin:3px 0;color:#dce9f3"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${d.color||colors[d.key]||'#7da'};margin-right:6px"></span>${esc(d.name||d.key)} <strong style="float:right;margin-left:18px">${f(v)}${unit==='rate'?'%':unit==='bn'?' tỷ':''}</strong></div>`}tooltip.innerHTML=content;tooltip.style.display='block';const rel=Math.max(0,Math.min(el.clientWidth-185,(ev.clientX-el.getBoundingClientRect().left)+12));tooltip.style.left=rel+'px';tooltip.style.top='9px'};overlay.addEventListener('mousemove',touch);overlay.addEventListener('mouseleave',()=>{cross.style.display='none';tooltip.style.display='none'});}
function rateDefinitions(){
 const hasLocal=state.data?.meta?.kind==='private-local';
 return [...PUBLIC_FIELDS,...(hasLocal?[...RATE_FIELDS,...VBMA_FIELDS]:[])]
 .filter(key=>state.activeRates.has(key)&&(!hasLocal||key.endsWith('_public')||dataRows().some(r=>Number.isFinite(r[key]))))
 .map(key=>({key,name:seriesLabels[key],color:colors[key],dash:key.endsWith('_public')||key.startsWith('vbma_')}));
}
function renderLegends(){
 const local=state.data?.meta?.kind==='private-local';
 const available=k=>!local||k.endsWith('_public')||dataRows().some(r=>Number.isFinite(r[k]));
 const button=k=>`<button class="legend-button ${state.activeRates.has(k)?'':'off'}" data-toggle-rate="${k}" role="checkbox" aria-checked="${state.activeRates.has(k)}" title="${esc(seriesLabels[k])}"><span class="legend-tick">✓</span><span class="legend-dot" style="--dot:${colors[k]}"></span>${esc(seriesLabels[k])}</button>`;
 const groups=[['NHNN',PUBLIC_FIELDS],...(local?[['LS ITB · workbook',RATE_FIELDS],['VBMA · Swap / Yield',VBMA_FIELDS]]:[])];
 const build=full=>groups.map(([label,keys])=>{const list=full?keys:(label==='NHNN'?keys.slice(0,4):label.startsWith('LS ITB')?keys.slice(0,3):keys.slice(0,4));const shown=list.filter(available);if(!shown.length)return '';return `<div class="rate-tick-group"><span class="rate-tick-label">${esc(label)}</span><div class="rate-tick-buttons">${shown.map(button).join('')}</div></div>`;}).join('');
 $('#rateLegend').innerHTML=build(false);$('#ratesLegend2').innerHTML=build(true);
}
function deltaMatchedToOrigin(tenor,observed){
 if(!observed || observed.source_type==='interbank_indicative_rounded')return null;
 const history=(state.publicMarket.interbank||[])
   .filter(x=>x.tenor===tenor&&x.source_type===observed.source_type&&x.date<=observed.date)
   .sort((a,b)=>b.date.localeCompare(a.date));
 return history.length>1?Number((history[0].rate_pct-history[1].rate_pct).toFixed(4)):null;
}
function renderRateCharts(){
 renderLegends();const rows=rateRows(),defs=rateDefinitions();
 makeChart($('#overviewRateChart'),rows,defs,{unit:'rate',empty:'Dữ liệu thị trường đang đồng bộ'});
 makeChart($('#fullRateChart'),rows,defs,{unit:'rate',empty:'Dữ liệu thị trường đang đồng bộ'});
 const sbvLatest=publicLatest('ON');
 $('#ratesSourceNote').textContent=sbvLatest?`NHNN · cập nhật quan sát ${shortDate(sbvLatest.date)} · Tự quét mỗi 60 phút`:'Đang đồng bộ lãi suất liên ngân hàng';
 const local=state.data?.meta?.kind==='private-local';
 const html=TERM_LABELS.map((tenor,i)=>{
  const localData=local?latestValid(RATE_FIELDS[i]):null;
  const sbv=publicLatest(tenor),bulletin=(state.publicMarket.marketQuotes||[]).filter(x=>x.tenor===tenor).sort((a,b)=>b.date.localeCompare(a.date))[0];
  const observed=bulletin&&(!sbv||bulletin.date>sbv.date)?bulletin:sbv;
  const change=deltaMatchedToOrigin(tenor,observed);
  const url=observed?.source_url&&/^https:\/\//.test(observed.source_url)?observed.source_url:'#';
  return `<tr><td class="emph">${tenor}</td><td class="emph">${rateText(observed?.rate_pct)}</td><td>${shortDate(observed?.date)}</td><td><a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(observed?.source_type==='interbank_indicative_rounded'?'Bản tin LNH':'NHNN')}</a></td><td><span class="${change==null?'':change>0?'change-up':change<0?'change-down':''}">${change==null?'—':(change>=0?'+':'')+n(change,{d:2})+' đpt'}</span></td>${local?`<td>${localData?rateText(localData.value):'Chưa có'}</td>`:''}</tr>`;
 }).join('');
 const table=`<table class="data-table"><thead><tr><th>Kỳ hạn</th><th>Quan sát gần nhất</th><th>Ngày</th><th>Nguồn</th><th>Δ cùng nguồn</th>${local?'<th>Workbook</th>':''}</tr></thead><tbody>${html}</tbody></table>`;
 $('#overviewRatesTable').innerHTML=table;$('#rateFullTable').innerHTML=table;
 const curve=TERM_LABELS.map((tenor,i)=>{
  const actual=local?latestValid(RATE_FIELDS[i]):null;
  const obs=actual||publicLatest(tenor);
  return obs?{date:tenor,value:Number(actual?.value??obs.rate_pct)}:null;
 }).filter(Boolean);
 drawBarCurve($('#curveChart'),curve,'Lãi suất theo kỳ hạn (%/năm)');
 renderQuickRates();
}
function drawBarCurve(el,items,label){if(!el)return;if(!items.length){el.innerHTML='<div class="chart-error">Không có quan sát đủ điều kiện</div>';return}const w=window.innerWidth<=760?Math.max(330,Math.min(460,el.clientWidth||window.innerWidth-55)):500,h=window.innerWidth<=760?260:300,top=24,bottom=46,left=42,right=10,max=Math.max(...items.map(x=>x.value))*1.18;const bar=(w-left-right)/items.length;const bars=items.map((it,i)=>{const x=left+i*bar+bar*.20,yy=top+(h-top-bottom)*(1-it.value/max);return `<rect x="${x}" y="${yy}" width="${bar*.60}" height="${h-bottom-yy}" rx="5" fill="${['#3277b5','#3c98b0','#50b0a5','#80afc7','#d5aa72','#8d81c6'][i%6]}"/><text x="${x+bar*.3}" y="${yy-8}" text-anchor="middle" style="fill:#5e758e">${n(it.value,{d:2})}</text><text x="${x+bar*.3}" y="${h-15}" text-anchor="middle">${esc(it.date)}</text>`}).join('');el.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${bars}</svg>`}
function renderDonut(){const latest=last();const items=instruments.map(([key,label,color])=>({key,label,color,value:Math.max(0,Number(latest[key])||0)}));const total=items.reduce((a,x)=>a+x.value,0);if(!total){$('#instrumentDonut').innerHTML='<div class="empty">Chưa có cấu trúc số dư</div>';return}let offset=0;const circ=2*Math.PI*70;const circles=items.map(x=>{const len=x.value/total*circ,svg=`<circle r="70" cx="100" cy="100" fill="none" stroke="${x.color}" stroke-width="20" stroke-dasharray="${len} ${circ-len}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"/>`;offset+=len;return svg}).join('');$('#instrumentDonut').innerHTML=`<svg viewBox="0 0 200 200" aria-label="Tỷ trọng các loại công cụ"><circle cx="100" cy="100" r="70" fill="none" stroke="#edf2f6" stroke-width="20"/>${circles}</svg><div class="donut-center"><strong>${n(total,{d:0})}</strong><span>TỶ VND</span></div>`;$('#instrumentLegend').innerHTML=items.map(x=>`<div class="donut-legend-item"><i style="--dot:${x.color}"></i>${esc(x.label)}<strong>${n(100*x.value/total,{d:1})}%</strong></div>`).join('')}
function renderPortfolio(){const rows=dataFiltered();makeChart($('#balanceChart'),rows,[{key:'loan_bn',name:'Dư nợ MM',color:'#3477bc'},{key:'ld_scale_bn',name:'Quy mô L&D',color:'#2eb1a4'}],{unit:'bn'});makeChart($('#portfolioChart'),rows,[{key:'loan_bn',name:'Dư nợ MM',color:'#3477bc'},{key:'ld_scale_bn',name:'Quy mô L&D',color:'#2eb1a4'},{key:'invest_gtcg_bn',name:'GTCG đầu tư',color:'#af8fc5'}],{unit:'bn'});const items=instruments.map(([key,label,color])=>({key,label,color,value:Math.max(0,Number(last()[key])||0)}));const total=Math.max(...items.map(x=>x.value),1);$('#portfolioBreakdown').innerHTML=items.map(x=>`<div class="breakdown-row"><div class="breakdown-label"><span>${esc(x.label)}</span><strong>${n(x.value,{d:1})} tỷ</strong></div><div class="breakdown-bar"><span style="--bar:${x.color};width:${x.value/total*100}%"></span></div></div>`).join('');const lastRow=last(),sum=items.reduce((a,x)=>a+x.value,0),gap=(Number(lastRow.loan_bn)||0)-sum;$('#reconDetails').innerHTML=[['Loan (nguồn chuẩn)',n(lastRow.loan_bn,{d:3})+' tỷ','Nguồn: INTERBANK VND + INTERBANK USD × FX mid'],['Tổng 5 nhóm instrument',n(sum,{d:3})+' tỷ','GTCG + RESO + TSĐB + Tín chấp + Swap residual'],['Swap residual',n(lastRow.swap_bn,{d:3})+' tỷ','Swap = Loan – GTCG – RESO – Có TSĐB – Tín chấp'],['Chênh lệch đối chiếu',n(gap,{d:4})+' tỷ','Bất kỳ Trade Finance khác 0 cần xác nhận lại residual']].map(x=>`<div class="metric-item"><label>${esc(x[0])}</label><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></div>`).join('')}
function renderBondsFx(){
 const rows=dataFiltered();
 makeChart($('#gtcgChart'),rows,[{key:'gtcg_scale_bn',name:'Quy mô GTCG',color:'#3c7cbc'}],{unit:'bn'});
 const latest=last(),isLocal=state.data?.meta?.kind==='private-local';
 const internal=[['1Y','vbma_1y'],['2Y','vbma_2y'],['5Y','vbma_5y'],['10Y','vbma_10y']].map(([date,k])=>({date,value:latest[k]})).filter(x=>x.value!=null);
 const publicCurve=(state.publicMarket.bonds||[]).map(x=>({date:x.tenor,value:x.yield_pct}));
 const preferInternal=isLocal&&internal.length>=3;
 drawBarCurve($('#bondCurveChart'),preferInternal?internal:publicCurve,'Lợi suất TPCP (%/năm)');
 $('#vbmaFreshnessNote').textContent=preferInternal?`VBMA · ${shortDate(state.data.source_freshness?.['VBMA TPCP'])}`:`TPCP thứ cấp · ${shortDate(state.publicMarket.bonds?.[0]?.date)} · nguồn AAS`;
 makeChart($('#fxChart'),rows,[{key:'fx_mid',name:'USD/VND Mid',color:'#277fb9'},{key:'fx_bid',name:'Bid',color:'#19a99a'},{key:'fx_ask',name:'Ask',color:'#e2a063'}],{unit:'fx'});
 makeChart($('#swapChart'),rows,[{key:'vbma_swap_on',name:'Swap ON',color:'#2c8cbd'},{key:'vbma_swap_1m',name:'Swap 1M',color:'#19a7a2'},{key:'vbma_swap_3m',name:'Swap 3M',color:'#9782c7'}],{unit:'rate'});
}
function publicLatest(tenor){return [...(state.publicMarket.interbank||[])].reverse().find(x=>x.tenor===tenor&&Number.isFinite(+x.rate_pct))||null}
function publicDisplay(tenor){
 const daily=publicLatest(tenor);
 const latestBulletin=(state.publicMarket.marketQuotes||[]).filter(x=>x.tenor===tenor).sort((a,b)=>b.date.localeCompare(a.date))[0];
 return latestBulletin&&(!daily||latestBulletin.date>daily.date)?latestBulletin:daily;
}
function renderQuickRates(){
 const el=$('#quickRateGrid');if(!el)return;
 el.innerHTML=TERM_LABELS.map(tenor=>{
  const obs=publicDisplay(tenor);
  const dif=deltaMatchedToOrigin(tenor,obs);
  const source=obs?.source_type==='interbank_indicative_rounded'?'Bản tin LNH':'NHNN';
  return `<div class="rate-tile"><div class="rate-tile-top"><span>${tenor}</span><span class="rate-tile-source">${source}</span></div><div class="rate-tile-value">${obs?rateText(obs.rate_pct):'Đang đồng bộ'}</div><div class="rate-tile-bottom"><span>${shortDate(obs?.date)}</span><span class="${dif==null?'':dif>0?'change-up':dif<0?'change-down':''}">${dif==null?'':(dif>=0?'+':'')+n(dif,{d:2})+'đ'}</span></div></div>`;
 }).join('');
}
function renderMarket(){
 const market=state.publicMarket;
 const keys=[['ON','Lãi suất ON','%/năm','◉'],['1W','Lãi suất 1W','%/năm','〰']];
 let out=keys.map(([tenor,label,unit,icon])=>{
  const x=publicDisplay(tenor),source=x?.source_type==='interbank_indicative_rounded'?'Bản tin liên ngân hàng':'NHNN';
  return `<div class="watch-item"><span class="watch-icon">${icon}</span><div class="watch-descript"><strong>${label}</strong><small>${shortDate(x?.date)} · ${source}</small></div><div class="watch-value">${x?rateText(x.rate_pct):'Đang tải'}</div></div>`;
 }).join('');
 const fx=market.fx;
 out+=`<div class="watch-item"><span class="watch-icon">$</span><div class="watch-descript"><strong>USD/VND · Tỷ giá trung tâm</strong><small>${shortDate(fx?.date)} · NHNN</small></div><div class="watch-value">${fx?n(fx.rate,{d:0}):'Đang tải'}</div></div>`;
 for(const [key,label] of [['SOFR','SOFR · Mỹ'],['DGS10','US Treasury 10Y']]){
  const v=market.macro?.[key];
  out+=`<div class="watch-item"><span class="watch-icon">⌁</span><div class="watch-descript"><strong>${label}</strong><small>${shortDate(v?.date)} · FRED</small></div><div class="watch-value">${v?rateText(v.value):'Đang tải'}</div></div>`;
 }
 $('#marketWatch').innerHTML=out;
 const news=market.news||[];
 const renderNews=items=>items.length?`<div class="news-list">${items.map(x=>`<div class="news-item"><a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer"><strong>${esc(x.title)}</strong></a><small>${esc(x.source)} · ${shortDate(x.date)}</small></div>`).join('')}</div>`:'<div class="empty">Đang đồng bộ bản tin thị trường</div>';
 $('#newsPreview').innerHTML=renderNews(news.slice(0,4));$('#newsAll').innerHTML=renderNews(news.slice(0,24));
 $('#providerList').innerHTML=[['NHNN','Lãi suất liên ngân hàng theo kỳ hạn','https://www.sbv.gov.vn/'],['VBMA','Trái phiếu và giao dịch kỳ hạn','https://vbma.org.vn/'],['FRED','Lãi suất Mỹ và lợi suất TPCP Mỹ','https://fred.stlouisfed.org/'],['Nguồn tổng hợp','Dữ liệu kinh tế công bố theo ngày','https://dulieukinhte.com/']].map(([name,description,url])=>`<div class="source-panel-row"><span class="source-icon">◈</span><div><strong>${name}</strong><p>${description}</p><a href="${url}" target="_blank" rel="noopener noreferrer">Xem nguồn ↗</a></div></div>`).join('');
}
function renderQuality(){const data=state.data||{},lastdate=last().date,dates=data.source_freshness||{},checks=Object.entries(dates).map(([name,date])=>({name,date,days:calcDays(date,lastdate)})),stale=checks.filter(x=>x.days!=null&&x.days>7).length;const missing=RATE_FIELDS.filter(k=>!latestValid(k)).length;const gap=last().instrument_recon_gap_bn;const cards=[['Nguồn kết nối',String(checks.length),'nguồn'],['Chuỗi lãi suất thiếu',String(missing),'kỳ hạn'],['Nguồn cũ >7 ngày',String(stale),'nguồn'],['Recon gap',n(gap,{d:4}),'tỷ VND']];$('#qualityKpis').innerHTML=cards.map(([label,value,unit])=>`<div class="kpi-card"><div class="kpi-head">${label}<span class="kpi-symbol">◈</span></div><div class="kpi-value">${value}<small>${unit}</small></div><div class="kpi-bottom">Đối chiếu tại ${shortDate(lastdate)}</div></div>`).join('');$('#freshnessTable').innerHTML=`<table class="data-table"><thead><tr><th>Sheet / nguồn</th><th>Ngày dữ liệu</th><th>Độ lệch</th><th>QC</th></tr></thead><tbody>${checks.map(x=>`<tr><td class="emph">${esc(x.name)}</td><td>${shortDate(x.date)}</td><td>${x.days!=null?x.days+' ngày':'—'}</td><td><span class="status-badge ${x.days==null?'missing':x.days>7?'bad':'ok'}">${x.days==null?'Thiếu':x.days>7?'Cũ nguồn':'Hợp lệ'}</span></td></tr>`).join('')}</tbody></table>`;const warns=[...(data.warnings||[])];if(!warns.length)warns.push('Không có cảnh báo từ bộ tính toán của snapshot này. Cần kiểm tra các trường nguồn và ngày cập nhật trước khi sử dụng nghiệp vụ.');if(stale)warns.push(`${stale} nguồn đang cũ hơn 7 ngày so với TongHop. Không được forward-fill thành dữ liệu thị trường mới.`);if(missing)warns.push(`${missing} kỳ hạn nội bộ không có quan sát. Benchmark NHNN được hiển thị tách riêng; không tự điền vào quote nội bộ.`);if(data.meta?.kind==='synthetic')warns.unshift('Các số dư, NIM, giá nội bộ là dữ liệu giả lập. Không sử dụng làm báo cáo ngân hàng.');$('#qualityWarnings').innerHTML=warns.map((w,i)=>`<div class="warning-item ${i===0&&data.meta?.kind!=='synthetic'?'ok':''}">${esc(w)}</div>`).join('')}
function renderMetadata(){
 const meta=state.data?.meta||{},local=meta.kind!=='synthetic';
 $('#asOfDate').textContent=shortDate(meta.asOf||last().date);
 $('#sourceBadge').textContent=local?'Excel đang mở':'Bản xem thử';
 $('#sourceBadge').className='source-badge '+(local?'local':'demo');
 $('#dataBannerTitle').textContent=local?'Dữ liệu Excel':'Dữ liệu mô phỏng';
 $('#dataBannerDetail').textContent=local?`${state.data.series.length} phiên · ${meta.source_file||'Dữ liệu đang mở'}`:`${state.data.series.length} phiên MM demo · Lãi suất thị trường theo nguồn công bố`;
 $('#aiDataMode').textContent=local?'Excel / JSON':'Dữ liệu demo';
 $('#aiAsOf').textContent=shortDate(last().date);
 $('#aiMarketMode').textContent=state.publicMarket.interbank?.length?'Đã đồng bộ':'Đang tải';
}
function render(){if(!state.data)return;renderMetadata();renderKpis();renderDonut();renderRateCharts();renderPortfolio();renderBondsFx();renderMarket();renderQuality();renderBooksV14();renderTreasuryWorkspace(state.data,{freq:state.freq,period:state.period})}
function csvExport(){const rows=dataFiltered();if(!rows.length)return toast('Chưa có dữ liệu để xuất.');const keys=Object.keys(rows[0]);const csv='\ufeff'+[keys.join(','),...rows.map(row=>keys.map(k=>row[k]===null||row[k]===undefined?'':String(row[k])).join(','))].join('\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`treasury_session_${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);toast('Đã xuất CSV từ dữ liệu hiện có trong trình duyệt.')}
function localAnswer(q){const question=q.toLowerCase();const r=last();const on=latestValid('itb_on'),prev=olderValid('itb_on',20),p=publicLatest('ON'),d=state.data?.meta?.kind==='synthetic'?'Số liệu MM là mô phỏng.':'Số liệu MM được nạp trong trình duyệt.';const fmt=v=>v==null?'chưa có quan sát hợp lệ':rateText(v);if(/nim|biên lãi|lợi nhuận/.test(question))return `${d}\nNIM L&D = Lãi suất cho vay bình quân VND – Lãi suất đi vay bình quân VND; chỉ tính khi dư nợ cho vay VND khác 0.\nNIM gần nhất: ${fmt(r.ld_nim_pct)} tại ${shortDate(r.date)}.\nLưu ý NIM không đồng nghĩa P&L, chưa phản ánh FTP, MTM, hedge cost hoặc impairment.`;if(/on|qua đêm|liên ngân|lãi suất|rate|kỳ hạn/.test(question))return `${d}\nITB ON nội bộ: ${fmt(on?.value)} (${shortDate(on?.date)}). ${prev!=null&&on?.value!=null?`Thay đổi khoảng 20 phiên: ${n(on.value-prev,{d:2})} điểm %.`:''}\nNHNN ON công khai: ${fmt(p?.rate_pct)} (${shortDate(p?.date)}), nguồn: ${p?.source||'chưa kết nối'}.\nHai chuỗi có thể khác định nghĩa; không tự gộp để lấp khoảng trống.`;if(/lỗi|thiếu|chất lượng|quality|qc|nguồn|cũ/.test(question)){const dates=state.data?.source_freshness||{},old=Object.entries(dates).filter(([k,v])=>calcDays(v,r.date)>7).map(([k,v])=>`${k} (${shortDate(v)})`);return `Kiểm tra tại ${shortDate(r.date)}:\n${old.length?'Nguồn cũ hơn 7 ngày: '+old.join(', '):'Không phát hiện nguồn cũ hơn 7 ngày từ metadata.'}\n${(state.data?.warnings||[]).slice(0,3).join('\n')||'Không có cảnh báo từ bộ xử lý.'}\nKhông có dữ liệu sẽ để trống thay vì tự bịa hoặc gán benchmark khác loại.`}if(/fx|usd|tỷ giá|swap/.test(question))return `${d}\nUSD/VND Mid: ${n(r.fx_mid,{d:0})} tại ${shortDate(r.date)}.\nSwap residual: ${n(r.swap_bn,{d:2})} tỷ VND = Loan – GTCG – RESO – TSĐB – Tín chấp.\nĐối với trạng thái FX, cần xác định book, đơn vị tiền tệ và ngày giá trước khi đánh giá rủi ro.`;if(/mm|quy mô|loan|dư nợ|gtcg|thanh khoản/.test(question))return `${d}\nTổng dư nợ MM tại ${shortDate(r.date)}: ${n(r.loan_bn,{d:2})} tỷ VND.\nĐầu tư GTCG: ${n(r.invest_gtcg_bn,{d:2})} tỷ; Có TSĐB: ${n(r.secured_bn,{d:2})} tỷ; Tín chấp: ${n(r.unsecured_bn,{d:2})} tỷ.\nGTCG ròng = BOND Trading + BOND PAP – CD đáo hạn (khác chỉ tiêu Đầu tư GTCG).\nDùng số dư theo ngày để tính BQ, không thay bằng snapshot cuối tháng.`;return `Tôi có thể trả lời câu hỏi về ON, lãi suất theo kỳ hạn, NIM, quy mô MM, GTCG, tỷ giá, Swap residual và cảnh báo nguồn.\n${d} Tại ${shortDate(r.date)}, dư nợ MM là ${n(r.loan_bn,{d:1})} tỷ và lãi suất ON nội bộ là ${fmt(on?.value)}.\nVui lòng hỏi thêm một chỉ tiêu cụ thể; mọi kết quả cần đối chiếu nguồn gốc trước khi sử dụng.`}
async function assistantRequest(question){return {answer:localAnswer(question),mode:'local'}}
function addBubble(type,text){const m=$('#chatMessages');const node=document.createElement('div');node.className='chat-bubble '+type;if(type==='assistant'){const label=document.createElement('div');label.className='bubble-label';label.textContent='PHÂN TÍCH';node.appendChild(label)}node.appendChild(document.createTextNode(text));m.appendChild(node);m.scrollTop=m.scrollHeight}
async function ask(q){const question=(q||'').trim();if(!question)return;pageTo('assistant');addBubble('user',question);const input=$('#chatInput');input.value='';input.disabled=true;const out=await assistantRequest(question);addBubble('assistant',out.answer);input.disabled=false;input.focus()}
async function importFile(file){if(!file)return;state.importing=true;toast('Đang phân tích file trên thiết bị; không tải lên máy chủ.');try{const result=await readUserFile(file);if(!Array.isArray(result.series)||result.series.length<2)throw Error('Không tìm thấy đủ chuỗi ngày hợp lệ.');result.series.sort((a,b)=>dateCompare(a.date,b.date));result.meta=result.meta||{};result.meta.kind='private-local';result.meta.asOf=result.series.at(-1).date;state.data=result;state.activeRates=new Set(['itb_on','itb_1w','itb_1m','itb_on_public','itb_1w_public']);state.period='3M';state.freq='daily';$('#freqSelect').value='daily';$$('[data-period]').forEach(x=>x.classList.toggle('selected',x.dataset.period==='3M'));render();toast(`Đã nạp ${result.series.length} quan sát từ ${file.name}. Dữ liệu chỉ nằm trong tab này.`)}catch(err){toast('Không nạp được file: '+(err.message||String(err)))}finally{state.importing=false;$('#filePicker').value=''}}
async function refreshPublic(){
 if(state.marketRefreshing)return;
 state.marketRefreshing=true;
 try{
  const url=new URL('../data/public_snapshot.json',import.meta.url);
  url.searchParams.set('v',String(Date.now()));
  const response=await fetch(url.href,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('HTTP '+response.status);
  const snapshot=await response.json();
  if(!Array.isArray(snapshot.interbank)||!snapshot.interbank.length)throw Error('Dữ liệu thị trường chưa hợp lệ');
  state.publicMarket=snapshot;state.lastMarketFetch=Date.now();
  const latest=publicLatest('ON')?.date;
  $('#marketStatus').textContent=latest?'Thị trường · '+shortDate(latest):'Thị trường';
  $('#marketDot').style.background='#35c4a6';
  render();
 }catch(_){
  const latest=publicLatest('ON')?.date;
  $('#marketStatus').textContent=latest?'Thị trường · '+shortDate(latest):'Chưa có dữ liệu thị trường';
  $('#marketDot').style.background=latest?'#35c4a6':'#e7b66c';
  render();
 }finally{state.marketRefreshing=false}
}
async function checkModel(){state.llm=false;$('#aiBackend').textContent='Phân tích trên thiết bị';$('#modelState').textContent='PHÂN TÍCH TRÊN THIẾT BỊ'}

function bind(){document.addEventListener('click',ev=>{const btn=ev.target.closest('[data-nav]');if(btn){pageTo(btn.dataset.nav);return}const rate=ev.target.closest('[data-toggle-rate]');if(rate){const key=rate.dataset.toggleRate;state.activeRates.has(key)?state.activeRates.delete(key):state.activeRates.add(key);renderRateCharts();return}const p=ev.target.closest('[data-period]');if(p){state.period=p.dataset.period;$$('[data-period]').forEach(x=>x.classList.toggle('selected',x.dataset.period===state.period));render()}});$('#importBtn').addEventListener('click',()=>$('#filePicker').click());$('#qualityImportBtn').addEventListener('click',()=>$('#filePicker').click());$('#importBtnQuality').addEventListener('click',()=>$('#filePicker').click());$('#filePicker').addEventListener('change',async ev=>{const files=[...(ev.target.files||[])];for(const file of files)await importFile(file)});$('#exportBtn').addEventListener('click',csvExport);$('#freqSelect').addEventListener('change',ev=>{state.freq=ev.target.value;render()});$('#themeBtn').addEventListener('click',()=>{document.body.classList.toggle('dark');$('#themeBtn').textContent=document.body.classList.contains('dark')?'☀':'☾'});$('#mobileMenu').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));$('#refreshMarket').addEventListener('click',refreshPublic);$('#refreshMarketTop')?.addEventListener('click',refreshPublic);$('#chatForm').addEventListener('submit',ev=>{ev.preventDefault();ask($('#chatInput').value)});$$('.question-chip').forEach(b=>b.addEventListener('click',()=>ask(b.textContent)));window.addEventListener('resize',()=>{if(state.data)renderRateCharts()})}
async function main(){
 bind();
 try{
  const [demo,pub]=await Promise.all([fetch(new URL('../data/demo.json',import.meta.url)),fetch(new URL('../data/public_snapshot.json',import.meta.url))]);
  if(!demo.ok)throw Error('Không tải được dữ liệu khởi tạo');
  state.data=await demo.json();state.data.series.sort((a,b)=>dateCompare(a.date,b.date));
  if(pub.ok)state.publicMarket=await pub.json();
  render();
 }catch(err){toast('Lỗi khởi tạo: '+err.message)}
 await refreshPublic();checkModel();
 window.setInterval(()=>refreshPublic(),60*60*1000);
 document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&Date.now()-state.lastMarketFetch>60*60*1000)refreshPublic();
 });
}

function makePublicSeries(snapshot){
 const dates=new Map(),fields={'ON':'itb_on_public','1W':'itb_1w_public','2W':'itb_2w_public','1M':'itb_1m_public','3M':'itb_3m_public','6M':'itb_6m_public','9M':'itb_9m_public'};
 for(const obs of snapshot.interbank||[]){
  if(!obs.date||!fields[obs.tenor]||!Number.isFinite(Number(obs.rate_pct)))continue;
  if(!dates.has(obs.date))dates.set(obs.date,{date:obs.date});
  dates.get(obs.date)[fields[obs.tenor]]=Number(obs.rate_pct);
 }
 const rows=[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date));
 if(!rows.length)throw Error('Không có dữ liệu lãi suất có ngày công bố');
 const last=rows.at(-1).date;
 return {meta:{kind:'public-only',source_file:'Public market',asOf:last,createdAt:snapshot.meta?.checkedAt||'',label:'Dữ liệu thị trường'},series:rows,
  source_freshness:{'Liên ngân hàng / NHNN':last,'Tỷ giá trung tâm':snapshot.fx?.date||null,'Lợi suất TPCP':snapshot.bonds?.[0]?.date||null,'SOFR':snapshot.macro?.SOFR?.date||null},warnings:[]};
}

function renderKpisV13(){
 if(state.data?.meta?.kind==='private-local')return _previousRenderKpis();
 const card=(label,value,unit,detail,highlight=false)=>`<div class="kpi-card ${highlight?'featured-kpi':''}"><div class="kpi-head">${esc(label)}<span class="kpi-symbol">↗</span></div><div class="kpi-value">${esc(String(value))}<small>${esc(unit)}</small></div><div class="kpi-bottom">${esc(detail)}</div></div>`;
 const obs=t=>publicDisplay(t);const f=t=>obs(t)?n(obs(t).rate_pct,{d:2}):'—';
 const day=t=>obs(t)?`${shortDate(obs(t).date)} · ${obs(t).source_type==='interbank_indicative_rounded'?'Bản tin LNH':'NHNN'}`:'Chưa công bố';
 const fx=state.publicMarket.fx;
 $('#kpiGrid').innerHTML=[card('Lãi suất ON',f('ON'),'%/năm',day('ON'),true),card('Lãi suất 1W',f('1W'),'%/năm',day('1W')),card('Lãi suất 1M',f('1M'),'%/năm',day('1M')),card('USD/VND trung tâm',fx?n(fx.rate,{d:0}):'—','VND',`${shortDate(fx?.date)} · NHNN`)].join('');
 $('#portfolioKpis').innerHTML=['ON','1W','2W','1M'].map((t,i)=>card('Lãi suất '+t,f(t),'%/năm',day(t),i===0)).join('');
 const bonds=state.publicMarket.bonds||[];
 $('#bondKpis').innerHTML=['3Y','5Y','7Y','10Y'].map((t,i)=>{const b=bonds.find(x=>x.tenor===t);return card('TPCP '+t,b?n(b.yield_pct,{d:2}):'—','%/năm',b?`${shortDate(b.date)} · TPCP thứ cấp`:'Chưa công bố',i===0)}).join('');
 const sofr=state.publicMarket.macro?.SOFR,dgs10=state.publicMarket.macro?.DGS10;
 $('#fxKpis').innerHTML=[card('USD/VND trung tâm',fx?n(fx.rate,{d:0}):'—','VND',`${shortDate(fx?.date)} · NHNN`,true),card('ON · VND',f('ON'),'%/năm',day('ON')),card('SOFR',sofr?n(sofr.value,{d:2}):'—','%/năm',`${shortDate(sofr?.date)} · FRED`),card('US Treasury 10Y',dgs10?n(dgs10.value,{d:2}):'—','%/năm',`${shortDate(dgs10?.date)} · FRED`)].join('');
}

function renderDonutV13(){
 const p=document.querySelector('#instrumentDonut')?.closest('.panel');
 const title=p?.querySelector('h2'),sub=p?.querySelector('.panel-sub'),foot=p?.querySelector('.panel-foot-note');
 if(state.data?.meta?.kind==='private-local'){
  if(title)title.textContent='Cơ cấu MM';if(sub)sub.textContent='Tỷ VND';if(foot)foot.textContent='Theo dư nợ cuối kỳ';
  return _previousRenderDonut();
 }
 if(title)title.textContent='Mặt bằng lãi suất';
 if(sub)sub.textContent='%/năm';
 if(foot)foot.textContent='Lãi suất từng kỳ hạn · NHNN';
 const arr=TERM_LABELS.map(t=>({label:t,value:publicLatest(t)?.rate_pct??null})).filter(x=>Number.isFinite(+x.value));
 $('#instrumentDonut').innerHTML=`<div class="public-curve-mark"><span>VNIBOR</span><strong>${rateText(publicLatest('ON')?.rate_pct)}</strong><small>Qua đêm · ${shortDate(publicLatest('ON')?.date)}</small></div>`;
 const max=Math.max(...arr.map(x=>x.value),1);
 $('#instrumentLegend').innerHTML=arr.map(x=>`<div class="market-term-line"><span>${x.label}</span><div class="term-track"><i style="width:${100*x.value/max}%"></i></div><strong>${rateText(x.value)}</strong></div>`).join('');
}

function renderPortfolioV13(){
 if(state.data?.meta?.kind==='private-local')return _previousRenderPortfolio();
 const rates=rateRows(),defs=[{key:'itb_on_public',name:'ON',color:'#267cb5'},{key:'itb_1w_public',name:'1W',color:'#1ca59e'},{key:'itb_1m_public',name:'1M',color:'#8e82cf'}];
 makeChart($('#balanceChart'),rates,defs,{unit:'rate',empty:'Đang cập nhật dữ liệu NHNN'});
 makeChart($('#portfolioChart'),rates,defs,{unit:'rate',empty:'Đang cập nhật dữ liệu NHNN'});
 const benchmark=TERM_LABELS.map(t=>({name:t,obs:publicLatest(t)})).filter(x=>x.obs);
 const max=Math.max(...benchmark.map(x=>x.obs.rate_pct),1);
 $('#portfolioBreakdown').innerHTML=benchmark.map(x=>`<div class="breakdown-row"><div class="breakdown-label"><span>${x.name}</span><strong>${rateText(x.obs.rate_pct)}</strong></div><div class="breakdown-bar"><span style="--bar:#26a69a;width:${100*x.obs.rate_pct/max}%"></span></div></div>`).join('');

 const terms=[['1W – ON','1W','ON'],['1M – ON','1M','ON'],['3M – ON','3M','ON'],['6M – 3M','6M','3M']];
 const data=terms.map(([label,left,right])=>{
  const l=publicLatest(left),r=publicLatest(right);
  const sameDay=l?.date&&l.date===r?.date;
  const val=sameDay?Number(l.rate_pct)-Number(r.rate_pct):null;
  return {label,val,date:l?.date};
 });
 $('#reconDetails').innerHTML=data.map(x=>`<div class="metric-item"><label>${esc(x.label)}</label><strong>${x.val==null?'—':(x.val>=0?'+':'')+n(x.val,{d:2})+' đpt'}</strong><small>${esc(shortDate(x.date))} · NHNN</small></div>`).join('');
 const heading=document.querySelector('[data-view="portfolio"] .grid-2-1 .panel h2');
 if(heading)heading.textContent='Diễn biến lãi suất';
 const breakdownHeading=document.querySelector('[data-view="portfolio"] .grid-2-1 .panel:nth-child(2) h2');
 if(breakdownHeading)breakdownHeading.textContent='Mặt bằng lãi suất theo kỳ hạn';
 const reconTitle=document.querySelector('[data-view="portfolio"] .panel.top-spaced h2');
 if(reconTitle)reconTitle.textContent='Chênh lệch lãi suất theo kỳ hạn';

}

function renderBondsFxV13(){
 if(state.data?.meta?.kind==='private-local')return _previousRenderBondsFx();
 const arr=state.publicMarket.bonds||[];
 drawBarCurve($('#bondCurveChart'),arr.map(x=>({date:x.tenor,value:Number(x.yield_pct)})).filter(x=>Number.isFinite(x.value)),'TPCP thứ cấp');
 $('#vbmaFreshnessNote').textContent=arr[0]?`Nguồn ${arr[0].source} · ${shortDate(arr[0].date)}`:'';
 makeChart($('#gtcgChart'),rateRows(),[{key:'itb_3m_public',name:'3M · NHNN',color:'#397bb9'},{key:'itb_6m_public',name:'6M · NHNN',color:'#20a9a1'}],{unit:'rate'});
 const history=(state.publicMarket.fxHistory||[]).map(x=>({date:x.date,fx_mid:x.rate}));
 if(history.length>1)makeChart($('#fxChart'),history,[{key:'fx_mid',name:'USD/VND trung tâm',color:'#397bb9'}],{unit:'fx'});
 else $('#fxChart').innerHTML=`<div class="market-feature"><span>Tỷ giá trung tâm NHNN</span><strong>${n(state.publicMarket.fx?.rate,{d:0})}</strong><small>${shortDate(state.publicMarket.fx?.date)}</small></div>`;
 const macro=state.publicMarket.macro||{};
 $('#swapChart').innerHTML=`<div class="market-feature-grid">${[['SOFR · Mỹ',macro.SOFR],['US 10Y',macro.DGS10]].map(([label,obs])=>`<div class="market-feature"><span>${label}</span><strong>${obs?rateText(obs.value):'—'}</strong><small>${shortDate(obs?.date)}</small></div>`).join('')}</div>`;
}

function renderQualityV13(){
 if(state.data?.meta?.kind==='private-local')return _previousRenderQuality();
 const snap=state.publicMarket,asOf=snap.interbank?.at(-1)?.date||'';
 const sources=[['Liên ngân hàng / NHNN',asOf],['Tỷ giá trung tâm',snap.fx?.date],['TPCP thứ cấp',snap.bonds?.[0]?.date],['SOFR / FRED',snap.macro?.SOFR?.date]];
 const cards=[['Kỳ hạn LNH',String(TERM_LABELS.filter(x=>publicLatest(x)).length),'kỳ hạn'],['Quan sát NHNN',String(snap.interbank?.length||0),'điểm'],['Nguồn dữ liệu',String(sources.filter(x=>x[1]).length),'nguồn'],['Bản tin',String(snap.news?.length||0),'tin']];
 $('#qualityKpis').innerHTML=cards.map(([label,v,unit])=>`<div class="kpi-card"><div class="kpi-head">${esc(label)}</div><div class="kpi-value">${v}<small>${esc(unit)}</small></div><div class="kpi-bottom">Dữ liệu công khai</div></div>`).join('');
 $('#freshnessTable').innerHTML=`<table class="data-table"><thead><tr><th>Nguồn</th><th>Ngày quan sát</th><th>Tình trạng</th></tr></thead><tbody>${sources.map(([label,date])=>`<tr><td>${esc(label)}</td><td>${shortDate(date)}</td><td>${date?'Có dữ liệu':'Chưa có'}</td></tr>`).join('')}</tbody></table>`;
 const completed=sources.filter(([,date])=>date).length;
 const missing=sources.filter(([,date])=>!date).map(([name])=>name);
 const rates=state.publicMarket.interbank||[];
 $('#qualityWarnings').innerHTML=`<div class="quality-brief"><strong>${completed}/${sources.length} nguồn có dữ liệu</strong><p>${rates.length} quan sát lãi suất với ngày công bố. ${missing.length?'Cần kiểm tra: '+esc(missing.join(', ')):'Các nhóm nguồn chính đã có số liệu.'}</p><span>Ngày của từng nguồn được giữ riêng khi tính và so sánh.</span></div>`;
}

function renderMetadataV13(){
 const meta=state.data?.meta||{},local=meta.kind==='private-local',latest=local?meta.asOf:publicLatest('ON')?.date;
 $('#asOfDate').textContent=shortDate(latest);
 $('#sourceBadge').textContent=local?'◉ WORKBOOK ĐÃ NẠP':'◉ DỮ LIỆU THỊ TRƯỜNG';
 $('#sourceBadge').className='source-badge '+(local?'local':'market-real');
 $('#dataBannerTitle').textContent=local?'Danh mục đang theo dõi':'Dữ liệu thị trường';
 $('#dataBannerDetail').textContent=local?`${state.data.series.length} phiên · ${(meta.files||[]).length||1} tệp đã lưu trên thiết bị`:`Lãi suất ${shortDate(latest)} · USD/VND ${shortDate(state.publicMarket.fx?.date)}`;
 $('#aiDataMode').textContent=local?'Danh mục trên máy':'Lãi suất & tỷ giá';
 $('#aiAsOf').textContent=shortDate(latest);
 $('#aiMarketMode').textContent=state.publicMarket.interbank?.length?'Đã cập nhật':'Đang tải';
 const reset=document.querySelector('#clearDeviceCache');if(reset)reset.hidden=!local;
}

function bookAnswerV14(question){
 const q=String(question||'').toLowerCase();
 const kinds=[
  {id:'ld_itb',name:'L&D Interbank',sheet:'LD ITB',match:/l\s*&\s*d\s*(itb|interbank)|ld\s*itb|ld\s*interbank|l&d liên ngân hàng/i},
  {id:'ld_alm',name:'L&D ALM',sheet:'LD ALM',match:/l\s*&\s*d\s*alm|ld\s*alm|book alm|alm book/i},
  {id:'repo',name:'Repo / Reso',sheet:'Repo',match:/\brepo\b|\breso\b/i},
  {id:'swp',name:'Swap MM',sheet:'SwP',match:/swap\s*mm|\bswp\b|book swap/i},
  {id:'cd',name:'CD / Bond PAP',sheet:'CD',match:/\bpap\b|book\s*cd|\bcd\s*\/|certificate of deposit/i},
  {id:'trading',name:'Bond Trading',sheet:'CD',match:/bond\s*trading|trading\s*book/i},
  {id:'afs',name:'Bond AFS',sheet:'CD',match:/\bafs\b|bond\s*afs/i},
  {id:'itb',name:'ITB tổng',sheet:'ITB',match:/itb\s*tổng|tổng\s*itb|book\s*itb/i}
 ];
 const selected=kinds.find(x=>x.match.test(q));
 const general=/\bbooks?\b|sổ kinh doanh|danh mục book|các book/.test(q);
 if(!selected&&!general)return null;
 const records=state.data?.series||[];
 const fmt=(value,unit='')=>value===null||value===undefined?'—':n(value,{d:2})+(unit?' '+unit:'');
 const key=(id,m)=>id==='trading'||id==='afs'?(m==='asset_vnd_bn'?'book_cd_'+(id==='trading'?'trading_vnd_bn':'afs_vnd_bn'):'unavailable_'+id+'_'+m):'book_'+id+'_'+m;
 const find=(id)=>[...records].reverse().find(x=>Object.keys(x).some(k=>k.startsWith('book_'+(['trading','afs'].includes(id)?'cd':id)+'_')));
 if(!state.data?.meta?.hasBooks&&!records.some(x=>Object.keys(x).some(k=>k.startsWith('book_'))))
  return 'Nguồn thị trường hiện có lãi suất và tỷ giá, chưa có số dư book. Số dư ITB, L&D, Repo, Swap và trái phiếu chỉ hiển thị từ dữ liệu nội bộ đã lưu trên thiết bị.';
 if(!selected){
  const coverage=kinds.map(x=>`${x.name}: ${shortDate(find(x.id)?.date)}`).join('\n');
  return `Có ${kinds.filter(x=>find(x.id)).length}/${kinds.length} book được nhận diện từ workbook.\n${coverage}\nITB tổng là số kiểm soát, không cộng thêm vào book thành phần.`;
 }
 const r=find(selected.id);
 if(!r)return `Chưa nhận diện được ${selected.name} trong dữ liệu đang mở. Kiểm tra sheet ${selected.sheet} và tên các trường nguồn.`;
 const get=m=>r[key(selected.id,m)]??null;
 const asset=get('asset_vnd_bn'),fund=get('fund_vnd_bn'),rawNet=get('net_vnd_bn');
 const net=rawNet!==null?rawNet:asset!==null&&fund!==null?asset+fund:null;
 const loanRate=get('loan_rate_pct'),fundRate=get('fund_rate_pct'),term=get('loan_term_days');
 return `${selected.name} — ${shortDate(r.date)} · Sheet ${selected.sheet}\nTài sản VND: ${fmt(asset,'tỷ')}; Nguồn vốn VND: ${fmt(fund,'tỷ')}; Net VND: ${fmt(net,'tỷ')}.\nCho vay USD: ${fmt(get('asset_usd_m'),'triệu USD')}; Đi vay USD: ${fmt(get('fund_usd_m'),'triệu USD')}.\nLSBQ cho vay: ${fmt(loanRate,'%/năm')}; LSBQ đi vay: ${fmt(fundRate,'%/năm')}; KHBQ cho vay: ${fmt(term,'ngày')}.\n${selected.id==='itb'?'ITB tổng là số kiểm soát; không cộng lại với các book thành phần.':'Số liệu lấy đúng từ tên trường và ngày trong workbook, không nội suy nguồn vốn còn thiếu.'}`;
}

function localAnswerV13(input){
 const q=String(input||'').toLowerCase();const lastRow=last(),on=publicDisplay('ON'),fx=state.publicMarket.fx,sofr=state.publicMarket.macro?.SOFR;
 const privateActive=state.data?.meta?.kind==='private-local';
 const bookResponse=bookAnswerV14(q);if(bookResponse!==null)return bookResponse;
 const termMatch=q.match(/(?:\b|^)(on|1w|2w|1m|3m|6m|9m)(?:\b|$)/i);
 const norm=t=>({on:'ON','1w':'1W','2w':'2W','1m':'1M','3m':'3M','6m':'6M','9m':'9M'})[t.toLowerCase()]||'ON';
 if(/nguồn|mới nhất|cập nhật|ngày nào|khi nào/.test(q)){
  return `Lãi suất NHNN: ${shortDate(publicLatest('ON')?.date)}. Bản tin liên ngân hàng: ${shortDate(state.publicMarket.marketQuotes?.at(-1)?.date)}. Tỷ giá trung tâm: ${shortDate(fx?.date)}. SOFR: ${shortDate(sofr?.date)}.\nDữ liệu được sử dụng đúng ngày quan sát; mỗi chỉ tiêu có đường dẫn nguồn ở bảng chi tiết.`;
 }
 if(/đường cong|chênh lệch|spread|so sánh|cấu trúc kỳ hạn/.test(q)){
  const a=publicLatest('ON'),b=publicLatest('1M'),c=publicLatest('3M');if(a&&b&&c)return `Đường cong lãi suất NHNN ngày ${shortDate(a.date)}:\nON ${rateText(a.rate_pct)} · 1M ${rateText(b.rate_pct)} · 3M ${rateText(c.rate_pct)}.\nSpread 1M–ON = ${n(b.rate_pct-a.rate_pct,{d:2})} điểm phần trăm; 3M–ON = ${n(c.rate_pct-a.rate_pct,{d:2})} điểm phần trăm.\nĐây là chênh lệch giữa các kỳ hạn cùng nguồn NHNN.`;
 }
 if(/nim|biên lãi|chi phí vốn|lợi nhuận/.test(q)){
  if(privateActive&&lastRow.ld_nim_pct!=null)return `L&D NIM tại ${shortDate(lastRow.date)}: ${rateText(lastRow.ld_nim_pct)}.\nCông thức = lãi suất cho vay bình quân VND − lãi suất đi vay bình quân VND, khi dư nợ hợp lệ. Chỉ tiêu chưa bao gồm điều chỉnh FTP, MTM, hedge cost.`;
  return `NIM L&D = lãi suất cho vay bình quân VND − lãi suất đi vay bình quân VND.\nNguồn thị trường hiện không có đủ số dư và lãi suất giao dịch nội bộ để tính NIM.`;
 }
 if(/fx|usd|tỷ giá|ngoại hối/.test(q)){
  const usd=privateActive&&lastRow.fx_mid!=null?`\nTỷ giá trong workbook (${shortDate(lastRow.date)}): ${n(lastRow.fx_mid,{d:0})} VND/USD.`:'';
  return `Tỷ giá trung tâm USD/VND: ${n(fx?.rate,{d:0})} VND/USD, ngày ${shortDate(fx?.date)} (${fx?.source||'NHNN'}).${usd}\nKhi so sánh cần thống nhất ngày quan sát và loại tỷ giá (trung tâm, bid, ask, mid).`;
 }
 if(/sofr|fed|mỹ|us 10|treasury 10/.test(q)){
  const d=state.publicMarket.macro?.DGS10;return `SOFR: ${sofr?rateText(sofr.value):'—'} (${shortDate(sofr?.date)}). US Treasury 10Y: ${d?rateText(d.value):'—'} (${shortDate(d?.date)}).\nĐây là lãi suất và lợi suất Mỹ; không quy đổi trực tiếp thành lãi suất ON VND.`;
 }
 if(/tpcp|trái phiếu|bond|yield|gtcg/.test(q)){
  const bonds=state.publicMarket.bonds||[];const b=bonds.find(x=>x.tenor==='10Y');return `Lợi suất TPCP thứ cấp 10Y: ${b?rateText(b.yield_pct):'—'} (${shortDate(b?.date)}).${privateActive&&lastRow.gtcg_scale_bn!=null?`\nGTCG ròng theo workbook: ${n(lastRow.gtcg_scale_bn,{d:2})} tỷ VND tại ${shortDate(lastRow.date)}.`:''}\nNguồn: ${b?.source||'bản tin thị trường'}.`;
 }
 if(/quy mô|dư nợ|mm|thanh khoản|ld|l&d/.test(q)){
  if(privateActive&&lastRow.loan_bn!=null)return `Quy mô cho vay ITB tại ${shortDate(lastRow.date)}: ${n(lastRow.loan_bn,{d:2})} tỷ VND.${lastRow.ld_scale_bn!=null?`\nL&D VND: ${n(lastRow.ld_scale_bn,{d:2})} tỷ VND.`:''}\nTheo các trường được nhận diện trong workbook đã nạp.`;
  return `Nguồn hiện tại có lãi suất liên ngân hàng và tỷ giá. Số dư MM, L&D và cơ cấu book là chỉ tiêu nội bộ, không thể suy ra chỉ từ lãi suất thị trường.`;
 }
 if(termMatch||/lãi suất|qua đêm|liên ngân|interbank/.test(q)){
  const t=termMatch?norm(termMatch[1]):'ON',a=publicDisplay(t),b=publicLatest(t);
  return `Lãi suất ${t} gần nhất: ${a?rateText(a.rate_pct):'—'} tại ${shortDate(a?.date)} (${a?.source_type==='interbank_indicative_rounded'?'Bản tin liên ngân hàng':'NHNN'}).\n${b?`NHNN cùng kỳ hạn: ${rateText(b.rate_pct)}, ngày ${shortDate(b.date)}.`:''}${privateActive&&latestValid('itb_'+t.toLowerCase())?`\nWorkbook: ${rateText(latestValid('itb_'+t.toLowerCase()).value)}, ngày ${shortDate(latestValid('itb_'+t.toLowerCase()).date)}.`:''}`;
 }
 return `Các chỉ tiêu hiện có gồm lãi suất ON–9M, tỷ giá USD/VND, SOFR và US 10Y. Có thể so sánh các kỳ hạn hoặc kiểm tra nguồn và ngày công bố.`;
}

async function importFileV13(file){
 if(!file||state.importing)return;
 state.importing=true;toast(`Đang đọc ${file.name}...`);
 try{
  const result=await readUserFile(file);
  if(!Array.isArray(result.series)||result.series.length<2)throw Error('Không có đủ ngày dữ liệu hợp lệ');
  const prior=state.data?.meta?.kind==='private-local'?state.data:null;
  const map=new Map((prior?.series||[]).map(x=>[x.date,{...x}]));
  for(const record of result.series){if(!record.date)continue;const dest=map.get(record.date)||{date:record.date};for(const [key,value] of Object.entries(record))if(key!=='date'&&value!==null&&value!==undefined&&value!=='')dest[key]=value;map.set(record.date,dest)}
  const series=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const names=[...(prior?.meta?.files|| (prior?.meta?.source_file?[prior.meta.source_file]:[])),file.name];
  state.data={...result,series,monthlyBooks:[...new Map([...(prior?.monthlyBooks||[]),...(result.monthlyBooks||[])].map(x=>[[x.month,x.book,x.currency].join('|'),x])).values()].sort((a,b)=>a.month.localeCompare(b.month)||a.book.localeCompare(b.book)||a.currency.localeCompare(b.currency)),meta:{...result.meta,kind:'private-local',source_file:[...new Set(names)].join(' · '),files:[...new Set(names)],asOf:series.at(-1)?.date},warnings:[...new Set([...(prior?.warnings||[]),...(result.warnings||[])])],source_freshness:{...(prior?.source_freshness||{}),...(result.source_freshness||{})},mapping:{...(prior?.mapping||{}),...(result.mapping||{})}};
  state.activeRates=new Set(['itb_on_public','itb_1w_public','itb_1m_public','itb_on','vbma_swap_on','vbma_itb_on']);
  state.period='3M';state.freq='daily';$('#freqSelect').value='daily';
  $('[data-period]').forEach(x=>x.classList.toggle('selected',x.dataset.period==='3M'));
  render();
  let stored=false;try{await saveLastWorkbook(state.data);stored=true;}catch(err){console.warn('Local workbook cache is unavailable:',err?.message)}
  if(result.meta?.hasBooks)pageTo('books');
  toast(stored?`Đã cập nhật ${series.length} ngày và lưu trên thiết bị`:`Đã cập nhật ${series.length} ngày · chưa lưu được trên thiết bị`);
 }catch(err){toast('Không thể nhập Excel: '+(err?.message||String(err)))}finally{state.importing=false;$('#filePicker').value=''}
}

async function refreshPublicV13(){
 if(state.marketRefreshing)return;
 state.marketRefreshing=true;
 try{
  const u=new URL('../data/public_snapshot.json',import.meta.url);u.searchParams.set('v',String(Date.now()));
  const r=await fetch(u.href,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('HTTP '+r.status);
  const snapshot=await r.json();if(!Array.isArray(snapshot.interbank)||!snapshot.interbank.length)throw Error('Nguồn chưa hợp lệ');
  state.publicMarket=snapshot;state.lastMarketFetch=Date.now();
  if(state.data?.meta?.kind!=='private-local')state.data=makePublicSeries(snapshot);
  const day=publicLatest('ON')?.date;
  $('#marketStatus').textContent=day?'NHNN · '+shortDate(day):'Thị trường';
  $('#marketDot').style.background='#29bfa9';
  render();
 }catch(e){$('#marketStatus').textContent=publicLatest('ON')?.date?'Thị trường · '+shortDate(publicLatest('ON').date):'Đang kết nối';if(state.data)render()}
 finally{state.marketRefreshing=false}
}

async function checkModelV13(){
 state.llm=false;$('#aiBackend').textContent='Có dữ liệu';$('#modelState').textContent='TRA CỨU SỐ LIỆU';
 $('#chatModeDesc').textContent='Lãi suất, tỷ giá và công thức';
}

async function mainV13(){
 bind();
 const picker=$('#filePicker');picker.setAttribute('multiple','');
 const menu=$('#mobileMenu'),sidebar=$('#sidebar');
 menu?.addEventListener('click',()=>document.body.classList.toggle('menu-open',sidebar.classList.contains('open')));
 $('#sidebarScrim')?.addEventListener('click',()=>{sidebar.classList.remove('open');document.body.classList.remove('menu-open')});
 document.addEventListener('click',ev=>{if(ev.target.closest('[data-nav]'))document.body.classList.remove('menu-open')});
 document.addEventListener('keydown',ev=>{if(ev.key==='Escape'){sidebar.classList.remove('open');document.body.classList.remove('menu-open')}});
 $('#clearDeviceCache')?.addEventListener('click',async()=>{
  if(state.importing)return;
  try{await clearLastWorkbook();state.data=makePublicSeries(state.publicMarket);pageTo('overview');render();toast('Đã xóa dữ liệu Excel lưu trên máy');}
  catch(err){toast('Chưa xóa được dữ liệu: '+err.message)}
 });
 // The shared file input queues every workbook sequentially through bind().
 document.addEventListener('dragover',event=>{if([...event.dataTransfer?.types||[]].includes('Files')){event.preventDefault();document.body.classList.add('file-dragging')}});
 document.addEventListener('dragleave',event=>{if(event.target===document.documentElement)document.body.classList.remove('file-dragging')});
 document.addEventListener('drop',async event=>{const files=[...(event.dataTransfer?.files||[])].filter(f=>/\.(xlsx|xlsm|json|csv)$/i.test(f.name));if(!files.length)return;event.preventDefault();document.body.classList.remove('file-dragging');for(const file of files)await importFileV13(file)});
 let restored=null;
 try{restored=await loadLastWorkbook()}catch(_){}
 try{
  const response=await fetch(new URL('../data/public_snapshot.json',import.meta.url),{cache:'no-store'});
  if(!response.ok)throw Error('Không đọc được dữ liệu thị trường');
  state.publicMarket=await response.json();
 }catch(err){console.warn('Public market snapshot is unavailable:',err?.message)}
 state.data=restored||(state.publicMarket.interbank.length?makePublicSeries(state.publicMarket):null);
 if(restored){
  state.activeRates=new Set(['itb_on_public','itb_1w_public','itb_1m_public','itb_on','vbma_swap_on','vbma_itb_on']);
  if(restored.meta?.hasBooks)state.activePage='overview';
 }
 if(state.data)render();
 else toast('Chưa tải được dữ liệu thị trường. Thử làm mới trang.');
 if(state.publicMarket.interbank.length)await refreshPublicV13();
 checkModelV13();
 window.setInterval(()=>refreshPublicV13(),60*60*1000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-state.lastMarketFetch>60*60*1000)refreshPublicV13()});
}
const _previousRenderKpis=renderKpis,_previousRenderDonut=renderDonut,_previousRenderPortfolio=renderPortfolio,_previousRenderBondsFx=renderBondsFx,_previousRenderQuality=renderQuality;
renderKpis=renderKpisV13;renderDonut=renderDonutV13;renderPortfolio=renderPortfolioV13;renderBondsFx=renderBondsFxV13;renderQuality=renderQualityV13;renderMetadata=renderMetadataV13;localAnswer=(q)=>mmAnalystAnswer(q,state.data)||localAnswerV13(q);importFile=importFileV13;refreshPublic=refreshPublicV13;checkModel=checkModelV13;
function renderBooksV14(){
 const hasBookRows=(state.data?.series||[]).some(row=>Object.keys(row).some(key=>key.startsWith('book_')));
 document.body.classList.toggle('market-only',!hasBookRows);
 const intro=document.querySelector('.book-intro-panel');if(intro)intro.hidden=!hasBookRows;
 const bookLink=document.querySelector('.sidebar .nav-link[data-nav="books"]');if(bookLink)bookLink.hidden=!hasBookRows;
 if(!hasBookRows){if(state.activePage==='books')pageTo('overview');return}

 const bk=[
  {id:'itb',label:'ITB tổng',hint:'Tổng Interbank · số kiểm soát',kind:'control',color:'#255f9e'},
  {id:'ld_itb',label:'L&D Interbank',hint:'Cho vay và đi vay liên ngân hàng',kind:'part',color:'#158f91'},
  {id:'ld_alm',label:'L&D ALM',hint:'Điều hòa vốn nội bộ / ALM',kind:'part',color:'#8065c0'},
  {id:'swp',label:'Swap MM',hint:'Swap tiền tệ · hai chân VND/USD',kind:'part',color:'#c48952'},
  {id:'repo',label:'Repo / Reso',hint:'Repo nguồn vốn / Reso sử dụng vốn',kind:'part',color:'#238bae'},
  {id:'cd',label:'CD / Bond PAP',hint:'Giấy tờ có giá · CD/PAP',kind:'part',color:'#b17e58'},
  {id:'trading',label:'Bond Trading',hint:'Sổ trái phiếu kinh doanh',kind:'part',color:'#7486af'},
  {id:'afs',label:'Bond AFS',hint:'Danh mục trái phiếu AFS',kind:'part',color:'#78968b'}
 ];
 const field=(b,metric)=>b==='trading'||b==='afs'?(metric==='asset_vnd_bn'?'book_cd_'+(b==='trading'?'trading_vnd_bn':'afs_vnd_bn'):'unavailable_'+b+'_'+metric):'book_'+b+'_'+metric;
 const series=state.data?.series||[];
 const isBookRow=r=>Object.keys(r).some(k=>k.startsWith('book_'));
 const lastBookRow=[...series].reverse().find(isBookRow);
 const asOf=lastBookRow?.date;
 const exactRow=b=>[...series].reverse().find(r=>r.date<=asOf&&Object.keys(r).some(k=>k.startsWith('book_'+(b==='trading'||b==='afs'?'cd':b)+'_')));
 const present=(r,k)=>r&&r[k]!==null&&r[k]!==undefined&&Number.isFinite(+r[k]);
 const metric=(b,m)=>{const r=asOf?exactRow(b):null;const k=field(b,m);return present(r,k)?Number(r[k]):null};
 const sourceDate=b=>exactRow(b)?.date||null;
 const display=(v,d=1)=>v===null?'—':n(v,{d});
 const rate=v=>v===null?'—':`${n(v,{d:2})}%`;
 const bookMetrics=b=>{
  const a=metric(b,'asset_vnd_bn'),f=metric(b,'fund_vnd_bn'),reported=metric(b,'net_vnd_bn');
  // Net of an asset-only book is intentionally not inferred from a missing funding field.
  const net=reported!==null?reported:(a!==null&&f!==null?a+f:null);
  return {a,f,net,ua:metric(b,'asset_usd_m'),uf:metric(b,'fund_usd_m'),lr:metric(b,'loan_rate_pct'),fr:metric(b,'fund_rate_pct'),tenor:metric(b,'loan_term_days'),fundTenor:metric(b,'fund_term_days'),date:sourceDate(b)};
 };
 const dict=Object.fromEntries(bk.map(x=>[x.id,bookMetrics(x.id)]));
 const active=!!asOf;
 const label=active?`Dữ liệu Book · ${shortDate(asOf)}`:'Chưa nạp workbook Book';
 const status=$('#bookDataStatus'),updated=$('#bookMainAsOf'),statusBadge=$('#booksStatusBadge'),asOfEl=$('#booksAsOf'),sourceEl=$('#bookSourceLabel');
 if(status)status.textContent=active?'Đã nhận dữ liệu Book':'Chưa nạp dữ liệu Book';
 if(updated)updated.textContent=active?`${shortDate(asOf)} · ${state.data.meta?.source_file||'Excel đã nạp'}`:'Nạp Excel để hiển thị số dư và rủi ro theo Book';
 if(statusBadge){statusBadge.textContent=active?'● DỮ LIỆU BOOK':'● CHƯA NẠP EXCEL';statusBadge.className='source-badge '+(active?'local':'demo')}
 if(asOfEl)asOfEl.textContent=label;
 if(sourceEl)sourceEl.textContent=active?`${state.data.meta?.source_file||'Excel'} · ${series.filter(isBookRow).length} phiên`:'Phân tích workbook ngay trong trình duyệt';
 const tiles=$('#bookCardsMain');
 if(tiles)tiles.innerHTML=bk.filter(x=>x.id!=='itb').map(book=>{
   const p=dict[book.id],v=p.a!==null?p.a:p.f!==null?p.f:p.net;
   const unit=p.a!==null||p.f!==null||p.net!==null?'tỷ VND':'';
   return `<button type="button" class="book-tile" data-nav="books"><span class="book-tile-accent" style="--c:${book.color}"></span><strong>${esc(book.label)}</strong><span class="book-tile-value">${display(v,1)} <small>${unit}</small></span><span class="book-tile-sub">${esc(book.hint)}</span></button>`
 }).join('');
 const base=dict.itb,ld=dict.ld_itb;
 const kpis=[
  ['ITB · Cho vay VND',base.a,'tỷ đồng','Tài sản gộp'],
  ['ITB · Đi vay VND',base.f,'tỷ đồng','Nguồn vốn, giữ dấu âm'],
  ['ITB · Net báo cáo',base.net,'tỷ đồng','Net theo sheet ITB'],
  ['L&D · Chênh LS VND',ld.lr!==null&&ld.fr!==null?ld.lr-ld.fr:null,'điểm %','LS cho vay trừ LS đi vay']
 ];
 const kpiRoot=$('#bookKpiGrid');
 if(kpiRoot)kpiRoot.innerHTML=kpis.map(([name,value,unit,small],i)=>`<div class="kpi-card ${i===0?'featured-kpi':''}"><div class="kpi-head">${esc(name)}<span class="kpi-symbol">${['▥','↙','◈','↗'][i]}</span></div><div class="kpi-value">${display(value,2)}<small>${unit}</small></div><div class="kpi-bottom">${esc(active?small+' · '+shortDate(asOf):'Chờ nạp Excel')}</div></div>`).join('');
 const overview=$('#bookMatrix');
 if(overview){
  const has=active;
  const format=(v,d=1)=>v===null?'<span class="book-missing">—</span>':`<span class="${v<0?'book-negative':''}">${display(v,d)}</span>`;
  overview.innerHTML=`<table class="book-table"><thead><tr><th>Book</th><th class="num">Tài sản VND <small>tỷ</small></th><th class="num">Nguồn vốn VND <small>tỷ</small></th><th class="num">Net VND <small>tỷ</small></th><th class="num">Cho vay USD <small>triệu</small></th><th class="num">Đi vay USD <small>triệu</small></th><th class="num">LS cho vay</th><th class="num">LS đi vay</th><th class="num">KH cho vay <small>ngày</small></th><th>Ngày</th></tr></thead>
   <tbody>${bk.map(book=>{const x=dict[book.id];return `<tr class="${book.kind==='control'?'book-control-row':''}"><td><span class="book-dot" style="--dot:${book.color}"></span><strong>${esc(book.label)}</strong><small>${esc(book.kind==='control'?'Tổng kiểm soát · không cộng trùng':book.hint)}</small></td><td class="num">${format(x.a)}</td><td class="num">${format(x.f)}</td><td class="num">${format(x.net)}</td><td class="num">${format(x.ua)}</td><td class="num">${format(x.uf)}</td><td class="num">${format(x.lr,2)}${x.lr===null?'':'%'}</td><td class="num">${format(x.fr,2)}${x.fr===null?'':'%'}</td><td class="num">${format(x.tenor,1)}</td><td>${shortDate(x.date)}</td></tr>`}).join('')}</tbody></table>
    ${!has?'<div class="book-empty-action"><strong>Danh mục Book đã sẵn sàng</strong><span>Chọn MB MM.xlsx để hiển thị số dư thực tế cho từng book.</span><button class="btn btn-primary" type="button" data-import-book>Nạp Excel Treasury</button></div>':''}`;
 }
 const selector=$('#bookSelect');
 if(selector){
  const prev=selector.value;
  selector.innerHTML=bk.map(b=>`<option value="${b.id}">${esc(b.label)}</option>`).join('');
  selector.value=bk.some(x=>x.id===prev)?prev:'ld_itb';
  selector.onchange=()=>renderBooksV14();
  const code=selector.value,rows=series.filter(r=>['asset_vnd_bn','fund_vnd_bn','net_vnd_bn','trading_vnd_bn','afs_vnd_bn'].some(m=>present(r,field(code,m))));
  const defs=[
   {key:field(code,'asset_vnd_bn'),name:'Tài sản',color:'#2877b1'},
   {key:field(code,'fund_vnd_bn'),name:'Nguồn vốn',color:'#dc8f5b'},
   {key:field(code,'net_vnd_bn'),name:'Net',color:'#20a99c'}
  ];
  if(code==='trading'||code==='afs')defs[0].key=field(code,'asset_vnd_bn');
  if(code==='repo'||code==='ld_itb'||code==='ld_alm'||code==='swp'||code==='itb'){
   const valid=defs.filter(d=>rows.some(r=>present(r,d.key)));
   makeChart($('#bookTrend'),rows,valid,{unit:'bn',empty:'Nạp Excel để xem biến động theo Book'});
  }else makeChart($('#bookTrend'),rows,defs.slice(0,1),{unit:'bn',empty:'Nạp Excel để xem biến động theo Book'});
 }
 const risk=$('#bookRiskCheck');
 if(risk){
  if(!active){risk.innerHTML='<div class="book-empty-compact">Nạp workbook để đối chiếu số dư và nguồn vốn theo ngày.</div>'}
  else{
   const cards=[],count=bk.filter(b=>dict[b.id].date).length;
   cards.push({title:'Độ phủ dữ liệu',detail:`${count}/${bk.length} book có ngày và trường hợp lệ`,kind:count===bk.length?'ok':'warn'});
   for(const book of bk.filter(b=>['itb','ld_itb','ld_alm','swp'].includes(b.id))){
    const x=dict[book.id];
    if(x.a!==null&&x.f!==null&&x.net!==null){
     const gap=x.net-(x.a+x.f);
     // Do not classify ITB aggregate residual as trading P&L or error.
     cards.push({title:book.label+' · Đối chiếu Net',detail:`Net báo cáo − (Tài sản + Nguồn vốn) = ${display(gap,2)} tỷ VND. ${book.id==='itb'?'ITB tổng cần đối chiếu phạm vi book thành phần.':'Cùng nguồn và ngày dữ liệu.'}`,kind:Math.abs(gap)<=0.01?'ok':'warn'});
    }
   }
   const staleness=bk.filter(b=>dict[b.id].date&&dict[b.id].date!==asOf);
   if(staleness.length)cards.push({title:'Book khác ngày báo cáo',detail:staleness.map(b=>b.label+' '+shortDate(dict[b.id].date)).join(' · '),kind:'warn'});
   risk.innerHTML=cards.map(x=>`<div class="book-risk-entry ${x.kind}"><span class="book-risk-icon">${x.kind==='ok'?'✓':'!'}</span><div><strong>${esc(x.title)}</strong><p>${esc(x.detail)}</p></div></div>`).join('');
  }
 }
 const map=$('#bookSourceMap');
 if(map){
  const data=state.data?.mapping||{};
  const items=Object.entries(data).filter(([k])=>k.startsWith('book_'));
  map.innerHTML=items.length?`<table class="data-table"><thead><tr><th>Chỉ tiêu</th><th>Sheet</th><th>Tên trường gốc</th><th>Vị trí dò được</th></tr></thead><tbody>${items.slice(0,120).map(([name,x])=>`<tr><td>${esc(name.replace(/^book_/,''))}</td><td>${esc(x.sheet)}</td><td>${esc(x.field)}</td><td>Cột ${esc(String(x.column))}</td></tr>`).join('')}</tbody></table>`:'<div class="book-empty-compact">Tên trường gốc và vị trí được xác định khi nạp workbook.</div>';
 }
 renderMonthlyBooksV14();
}

function renderMonthlyBooksV14(){
 const box=$('#bookMonthlyTable'),filter=$('#bookMonthFilter');
 if(!box||!filter)return;
 const items=(state.data?.monthlyBooks||[]).filter(r=>r?.month&&['VND','USD'].includes(r.currency));
 const months=[...new Set(items.map(x=>x.month))].sort().reverse();
 const selected=months.includes(filter.value)?filter.value:months[0];
 filter.innerHTML=months.map(month=>`<option value="${month}">${month.split('-').reverse().join('/')}</option>`).join('');
 if(selected)filter.value=selected;
 filter.disabled=!months.length;
 filter.onchange=()=>renderMonthlyBooksV14();
 if(!months.length){box.innerHTML='<div class="book-empty-compact">Nạp MB MM.xlsx để xem QMBQ, LSBQ và kỳ hạn theo tháng từ sheet Tong hop MM.</div>';return}
 const names={ld_itb:'L&D Interbank',ld_alm:'L&D ALM',swp:'Swap MM',repo:'Repo / Reso',cd:'CD / Bond PAP',trading:'Bond Trading',total:'Tổng theo báo cáo'};
 const ordered=['ld_itb','ld_alm','cd','trading','swp','repo','total'];
 const display=(v,d=1)=>v===undefined||v===null?'—':n(v,{d});
 const recs=items.filter(x=>x.month===selected).sort((a,b)=>a.currency.localeCompare(b.currency)||ordered.indexOf(a.book)-ordered.indexOf(b.book));
 box.innerHTML=`<table class="book-table"><thead><tr><th>Book / loại tiền</th><th class="num">QMBQ tài sản</th><th class="num">QMBQ nguồn vốn</th><th class="num">LSBQ cho vay (%)</th><th class="num">LSBQ đi vay (%)</th><th class="num">KHBQ cho vay (ngày)</th><th class="num">KHBQ đi vay (ngày)</th><th class="num">NIM theo báo cáo (%)</th></tr></thead><tbody>${recs.map(x=>{
 const cls=x.book==='total'?'book-control-row':'',unit=x.currency==='VND'?'tỷ VND':'triệu USD';
 return `<tr class="${cls}"><td><strong>${esc(names[x.book]||x.book)}</strong><small>${unit} · QMBQ tháng ${esc(selected)}</small></td><td class="num">${display(x.asset)}</td><td class="num">${display(x.fund)}</td><td class="num">${display(x.asset_rate_pct,2)}</td><td class="num">${display(x.fund_rate_pct,2)}</td><td class="num">${display(x.asset_term_days)}</td><td class="num">${display(x.fund_term_days)}</td><td class="num">${display(x.reported_nim_pct,2)}</td></tr>`;
 }).join('')}</tbody></table>`;
}
// Book import buttons are delegated to support dynamic panels.
document.addEventListener('click',ev=>{if(ev.target.closest('[data-import-book]')){$('#filePicker').click()}});
mainV13();
