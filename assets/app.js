import { readUserFile } from './loader.js';

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
const PUBLIC_FIELDS=RATE_FIELDS.map(key=>key+'_public');
const TERM_LABELS=['ON','1W','2W','1M','3M','6M','9M'];
const instruments=[['invest_gtcg_bn','Đầu tư GTCG','#3d75bf'],['reso_bn','Mua bán GTCG kỳ hạn','#47b5ab'],['secured_bn','Có TSĐB','#7b8bc5'],['unsecured_bn','Tín chấp','#f1b25b'],['swap_bn','Swap','#9a77bf']];
const state={
 data:null,
 publicMarket:{interbank:[],marketQuotes:[],fx:null,macro:{},bonds:[],news:[],providers:[]},
 period:'3M',freq:'daily',activePage:'overview',
 activeRates:new Set(['itb_on_public','itb_1w_public','itb_1m_public','itb_3m_public']),
 llm:false,importing:false,lastMarketFetch:0,marketRefreshing:false
};
const names={overview:'Overview',rates:'Interbank rates',portfolio:'MM & Liquidity',bonds:'GTCG & VBMA',fx:'FX & Swap',news:'Market intelligence',assistant:'AI Analyst',quality:'Data quality'};
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
 const raw=state.data?.meta?.kind==='synthetic' ? [] : dailyFiltered().map(x=>({...x}));
 const map=new Map(raw.map(x=>[x.date,x]));
 const termToField={ON:'itb_on_public','1W':'itb_1w_public','2W':'itb_2w_public','1M':'itb_1m_public','3M':'itb_3m_public','6M':'itb_6m_public','9M':'itb_9m_public'};
 for(const p of state.publicMarket.interbank||[]){
   if(!p?.date||!termToField[p.tenor]||!Number.isFinite(+p.rate_pct))continue;
   if(!map.has(p.date))map.set(p.date,{date:p.date});
   map.get(p.date)[termToField[p.tenor]]=Number(p.rate_pct);
 }
 const latest=[dataRows().at(-1)?.date,...(state.publicMarket.interbank||[]).map(x=>x.date)].filter(Boolean).sort().at(-1);
 return [...map.values()].sort((a,b)=>dateCompare(a.date,b.date)).filter(x=>x.date>=periodStart(latest));
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
function makeChart(el,rows,defs,{unit='rate',note='',empty='Chưa có dữ liệu',pointMode=false}={}){if(!el)return;const validDefs=defs.filter(d=>rows.some(r=>r[d.key]!=null&&Number.isFinite(+r[d.key])));if(!rows.length||!validDefs.length){el.innerHTML=`<div class="chart-error">${esc(empty)}</div>`;return}const w=1000,h=318,pad={left:unit==='fx'?72:62,right:20,top:19,bottom:37};const vals=validDefs.flatMap(d=>rows.map(r=>r[d.key]).filter(x=>typeof x==='number'&&Number.isFinite(x)));let min=Math.min(...vals),max=Math.max(...vals),range=max-min;if(range===0)range=Math.max(1,Math.abs(max)*.2);min-=range*.15;max+=range*.19;const x=i=>pad.left+(rows.length===1?(w-pad.left-pad.right)/2:i/(rows.length-1)*(w-pad.left-pad.right));const y=v=>pad.top+(max-v)/(max-min)*(h-pad.top-pad.bottom);const f=v=>unit==='bn'?n(v,{d:0}):unit==='fx'?n(v,{d:0}):n(v,{d:1});const grid=Array.from({length:5},(_,i)=>{const frac=i/4,yy=pad.top+frac*(h-pad.top-pad.bottom);return `<line class="chart-grid" x1="${pad.left}" x2="${w-pad.right}" y1="${yy}" y2="${yy}"/><text x="${pad.left-9}" y="${yy+4}" text-anchor="end">${f(max-frac*(max-min))}</text>`}).join('');const ticks=Array.from(new Set([0,Math.round((rows.length-1)*.25),Math.round((rows.length-1)*.5),Math.round((rows.length-1)*.75),rows.length-1])).map(i=>`<text x="${x(i)}" y="${h-8}" text-anchor="middle">${esc(rows[i].date.slice(5).replace('-','/'))}</text>`).join('');const lines=validDefs.map((d,j)=>{const col=d.color||colors[d.key]||['#2b79b8','#17a49b','#b47aa7'][j%3],p=pathFor(rows,d.key,x,y);const lastidx=rows.findLastIndex(row=>typeof row[d.key]==='number'&&Number.isFinite(row[d.key]));const dot=lastidx>=0?`<circle cx="${x(lastidx)}" cy="${y(rows[lastidx][d.key])}" r="3.5" fill="${col}" stroke="#fff" stroke-width="2"/>`:'';return `<path class="chart-line" stroke="${col}" stroke-dasharray="${d.dash?'6,6':'none'}" d="${p}"/>${dot}`}).join('');el.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(note||'Biểu đồ chuỗi thời gian')}">${grid}${ticks}<g>${lines}</g><line class="hover-line" style="display:none" stroke="#71869d" stroke-dasharray="4 4" x1="0" x2="0" y1="${pad.top}" y2="${h-pad.bottom}"/><rect class="hover-layer" x="${pad.left}" y="${pad.top}" width="${w-pad.left-pad.right}" height="${h-pad.top-pad.bottom}" fill="transparent"/></svg><div class="chart-tooltip"></div>`;const svg=$('svg',el),overlay=$('.hover-layer',svg),cross=$('.hover-line',svg),tooltip=$('.chart-tooltip',el);const touch=ev=>{const rect=svg.getBoundingClientRect();const ratio=(ev.clientX-rect.left)/rect.width;const i=Math.max(0,Math.min(rows.length-1,Math.round((ratio*w-pad.left)/(w-pad.left-pad.right)*(rows.length-1))));const row=rows[i];cross.style.display='block';cross.setAttribute('x1',x(i));cross.setAttribute('x2',x(i));let content=`<div style="font-weight:750;margin-bottom:6px">${shortDate(row.date)}</div>`;for(const d of validDefs){const v=row[d.key];if(v==null||!Number.isFinite(+v))continue;content+=`<div style="margin:3px 0;color:#dce9f3"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${d.color||colors[d.key]||'#7da'};margin-right:6px"></span>${esc(d.name||d.key)} <strong style="float:right;margin-left:18px">${f(v)}${unit==='rate'?'%':unit==='bn'?' tỷ':''}</strong></div>`}tooltip.innerHTML=content;tooltip.style.display='block';const rel=Math.max(0,Math.min(el.clientWidth-185,(ev.clientX-el.getBoundingClientRect().left)+12));tooltip.style.left=rel+'px';tooltip.style.top='9px'};overlay.addEventListener('mousemove',touch);overlay.addEventListener('mouseleave',()=>{cross.style.display='none';tooltip.style.display='none'});}
function rateDefinitions(){
 const hasLocal=state.data?.meta?.kind!=='synthetic';
 return [...PUBLIC_FIELDS,...(hasLocal?RATE_FIELDS:[])].filter(key=>state.activeRates.has(key)).map(key=>({key,name:seriesLabels[key],color:colors[key],dash:key.endsWith('_public')}));
}
function renderLegends(){
 const local=state.data?.meta?.kind!=='synthetic';
 const render=(element,showAll)=>{
 const publicFields=showAll?PUBLIC_FIELDS:PUBLIC_FIELDS.slice(0,6);
 const keys=[...publicFields,...(local?(showAll?RATE_FIELDS:RATE_FIELDS.slice(0,4)):[])];
 element.innerHTML=keys.map(key=>`<button class="legend-button ${state.activeRates.has(key)?'':'off'}" data-toggle-rate="${key}" aria-pressed="${state.activeRates.has(key)}"><span class="legend-dot" style="--dot:${colors[key]}"></span>${esc(seriesLabels[key])}</button>`).join('');
 };
 render($('#rateLegend'),false);render($('#ratesLegend2'),true);
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
 const local=state.data?.meta?.kind!=='synthetic';
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
function drawBarCurve(el,items,label){if(!el)return;if(!items.length){el.innerHTML='<div class="chart-error">Không có quan sát đủ điều kiện</div>';return}const w=500,h=300,top=24,bottom=46,left=40,right=10,max=Math.max(...items.map(x=>x.value))*1.18;const bar=(w-left-right)/items.length;const bars=items.map((it,i)=>{const x=left+i*bar+bar*.20,yy=top+(h-top-bottom)*(1-it.value/max);return `<rect x="${x}" y="${yy}" width="${bar*.60}" height="${h-bottom-yy}" rx="5" fill="${['#3277b5','#3c98b0','#50b0a5','#80afc7','#d5aa72','#8d81c6'][i%6]}"/><text x="${x+bar*.3}" y="${yy-8}" text-anchor="middle" style="fill:#5e758e">${n(it.value,{d:2})}</text><text x="${x+bar*.3}" y="${h-15}" text-anchor="middle">${esc(it.date)}</text>`}).join('');el.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${bars}</svg>`}
function renderDonut(){const latest=last();const items=instruments.map(([key,label,color])=>({key,label,color,value:Math.max(0,Number(latest[key])||0)}));const total=items.reduce((a,x)=>a+x.value,0);if(!total){$('#instrumentDonut').innerHTML='<div class="empty">Chưa có cấu trúc số dư</div>';return}let offset=0;const circ=2*Math.PI*70;const circles=items.map(x=>{const len=x.value/total*circ,svg=`<circle r="70" cx="100" cy="100" fill="none" stroke="${x.color}" stroke-width="20" stroke-dasharray="${len} ${circ-len}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"/>`;offset+=len;return svg}).join('');$('#instrumentDonut').innerHTML=`<svg viewBox="0 0 200 200" aria-label="Tỷ trọng các loại công cụ"><circle cx="100" cy="100" r="70" fill="none" stroke="#edf2f6" stroke-width="20"/>${circles}</svg><div class="donut-center"><strong>${n(total,{d:0})}</strong><span>TỶ VND</span></div>`;$('#instrumentLegend').innerHTML=items.map(x=>`<div class="donut-legend-item"><i style="--dot:${x.color}"></i>${esc(x.label)}<strong>${n(100*x.value/total,{d:1})}%</strong></div>`).join('')}
function renderPortfolio(){const rows=dataFiltered();makeChart($('#balanceChart'),rows,[{key:'loan_bn',name:'Dư nợ MM',color:'#3477bc'},{key:'ld_scale_bn',name:'Quy mô L&D',color:'#2eb1a4'}],{unit:'bn'});makeChart($('#portfolioChart'),rows,[{key:'loan_bn',name:'Dư nợ MM',color:'#3477bc'},{key:'ld_scale_bn',name:'Quy mô L&D',color:'#2eb1a4'},{key:'invest_gtcg_bn',name:'GTCG đầu tư',color:'#af8fc5'}],{unit:'bn'});const items=instruments.map(([key,label,color])=>({key,label,color,value:Math.max(0,Number(last()[key])||0)}));const total=Math.max(...items.map(x=>x.value),1);$('#portfolioBreakdown').innerHTML=items.map(x=>`<div class="breakdown-row"><div class="breakdown-label"><span>${esc(x.label)}</span><strong>${n(x.value,{d:1})} tỷ</strong></div><div class="breakdown-bar"><span style="--bar:${x.color};width:${x.value/total*100}%"></span></div></div>`).join('');const lastRow=last(),sum=items.reduce((a,x)=>a+x.value,0),gap=(Number(lastRow.loan_bn)||0)-sum;$('#reconDetails').innerHTML=[['Loan (nguồn chuẩn)',n(lastRow.loan_bn,{d:3})+' tỷ','Nguồn: INTERBANK VND + INTERBANK USD × FX mid'],['Tổng 5 nhóm instrument',n(sum,{d:3})+' tỷ','GTCG + RESO + TSĐB + Tín chấp + Swap residual'],['Swap residual',n(lastRow.swap_bn,{d:3})+' tỷ','Swap = Loan – GTCG – RESO – Có TSĐB – Tín chấp'],['Chênh lệch đối chiếu',n(gap,{d:4})+' tỷ','Bất kỳ Trade Finance khác 0 cần xác nhận lại residual']].map(x=>`<div class="metric-item"><label>${esc(x[0])}</label><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></div>`).join('')}
function renderBondsFx(){
 const rows=dataFiltered();
 makeChart($('#gtcgChart'),rows,[{key:'gtcg_scale_bn',name:'Quy mô GTCG',color:'#3c7cbc'}],{unit:'bn'});
 const latest=last(),isLocal=state.data?.meta?.kind!=='synthetic';
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
function render(){if(!state.data)return;renderMetadata();renderKpis();renderDonut();renderRateCharts();renderPortfolio();renderBondsFx();renderMarket();renderQuality()}
function csvExport(){const rows=dataFiltered();if(!rows.length)return toast('Chưa có dữ liệu để xuất.');const keys=Object.keys(rows[0]);const csv='\ufeff'+[keys.join(','),...rows.map(row=>keys.map(k=>row[k]===null||row[k]===undefined?'':String(row[k])).join(','))].join('\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`treasury_session_${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);toast('Đã xuất CSV từ dữ liệu hiện có trong trình duyệt.')}
function localAnswer(q){const question=q.toLowerCase();const r=last();const on=latestValid('itb_on'),prev=olderValid('itb_on',20),p=publicLatest('ON'),d=state.data?.meta?.kind==='synthetic'?'Số liệu MM là mô phỏng.':'Số liệu MM được nạp trong trình duyệt.';const fmt=v=>v==null?'chưa có quan sát hợp lệ':rateText(v);if(/nim|biên lãi|lợi nhuận/.test(question))return `${d}\nNIM L&D = Lãi suất cho vay bình quân VND – Lãi suất đi vay bình quân VND; chỉ tính khi dư nợ cho vay VND khác 0.\nNIM gần nhất: ${fmt(r.ld_nim_pct)} tại ${shortDate(r.date)}.\nLưu ý NIM không đồng nghĩa P&L, chưa phản ánh FTP, MTM, hedge cost hoặc impairment.`;if(/on|qua đêm|liên ngân|lãi suất|rate|kỳ hạn/.test(question))return `${d}\nITB ON nội bộ: ${fmt(on?.value)} (${shortDate(on?.date)}). ${prev!=null&&on?.value!=null?`Thay đổi khoảng 20 phiên: ${n(on.value-prev,{d:2})} điểm %.`:''}\nNHNN ON công khai: ${fmt(p?.rate_pct)} (${shortDate(p?.date)}), nguồn: ${p?.source||'chưa kết nối'}.\nHai chuỗi có thể khác định nghĩa; không tự gộp để lấp khoảng trống.`;if(/lỗi|thiếu|chất lượng|quality|qc|nguồn|cũ/.test(question)){const dates=state.data?.source_freshness||{},old=Object.entries(dates).filter(([k,v])=>calcDays(v,r.date)>7).map(([k,v])=>`${k} (${shortDate(v)})`);return `Kiểm tra tại ${shortDate(r.date)}:\n${old.length?'Nguồn cũ hơn 7 ngày: '+old.join(', '):'Không phát hiện nguồn cũ hơn 7 ngày từ metadata.'}\n${(state.data?.warnings||[]).slice(0,3).join('\n')||'Không có cảnh báo từ bộ xử lý.'}\nKhông có dữ liệu sẽ để trống thay vì tự bịa hoặc gán benchmark khác loại.`}if(/fx|usd|tỷ giá|swap/.test(question))return `${d}\nUSD/VND Mid: ${n(r.fx_mid,{d:0})} tại ${shortDate(r.date)}.\nSwap residual: ${n(r.swap_bn,{d:2})} tỷ VND = Loan – GTCG – RESO – TSĐB – Tín chấp.\nĐối với trạng thái FX, cần xác định book, đơn vị tiền tệ và ngày giá trước khi đánh giá rủi ro.`;if(/mm|quy mô|loan|dư nợ|gtcg|thanh khoản/.test(question))return `${d}\nTổng dư nợ MM tại ${shortDate(r.date)}: ${n(r.loan_bn,{d:2})} tỷ VND.\nĐầu tư GTCG: ${n(r.invest_gtcg_bn,{d:2})} tỷ; Có TSĐB: ${n(r.secured_bn,{d:2})} tỷ; Tín chấp: ${n(r.unsecured_bn,{d:2})} tỷ.\nGTCG ròng = BOND Trading + BOND PAP – CD đáo hạn (khác chỉ tiêu Đầu tư GTCG).\nDùng số dư theo ngày để tính BQ, không thay bằng snapshot cuối tháng.`;return `Tôi có thể trả lời câu hỏi về ON, lãi suất theo kỳ hạn, NIM, quy mô MM, GTCG, tỷ giá, Swap residual và cảnh báo nguồn.\n${d} Tại ${shortDate(r.date)}, dư nợ MM là ${n(r.loan_bn,{d:1})} tỷ và lãi suất ON nội bộ là ${fmt(on?.value)}.\nVui lòng hỏi thêm một chỉ tiêu cụ thể; mọi kết quả cần đối chiếu nguồn gốc trước khi sử dụng.`}
async function assistantRequest(question){const isPrivate=state.data?.meta?.kind!=='synthetic';if(isPrivate)return {answer:localAnswer(question),mode:'local'};try{const r=await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question}),signal:AbortSignal.timeout(9000)});if(r.ok){const j=await r.json();if(j?.answer)return {answer:j.answer,mode:'online'}}}catch(_e){}return {answer:localAnswer(question),mode:'local'}}
function addBubble(type,text){const m=$('#chatMessages');const node=document.createElement('div');node.className='chat-bubble '+type;if(type==='assistant'){const label=document.createElement('div');label.className='bubble-label';label.textContent='TREASURY ANALYST';node.appendChild(label)}node.appendChild(document.createTextNode(text));m.appendChild(node);m.scrollTop=m.scrollHeight}
async function ask(q){const question=(q||'').trim();if(!question)return;pageTo('assistant');addBubble('user',question);const input=$('#chatInput');input.value='';input.disabled=true;const out=await assistantRequest(question);addBubble('assistant',out.answer+(out.mode==='local'?'\n\n[Phân tích tại thiết bị; chưa dùng mô hình AI trực tuyến]':''));input.disabled=false;input.focus()}
async function importFile(file){if(!file)return;state.importing=true;toast('Đang phân tích file trên thiết bị; không tải lên máy chủ.');try{const result=await readUserFile(file);if(!Array.isArray(result.series)||result.series.length<2)throw Error('Không tìm thấy đủ chuỗi ngày hợp lệ.');result.series.sort((a,b)=>dateCompare(a.date,b.date));result.meta=result.meta||{};result.meta.kind='private-local';result.meta.asOf=result.series.at(-1).date;state.data=result;state.activeRates=new Set(['itb_on','itb_1w','itb_1m','itb_on_public','itb_1w_public']);state.period='3M';state.freq='daily';$('#freqSelect').value='daily';$$('[data-period]').forEach(x=>x.classList.toggle('selected',x.dataset.period==='3M'));render();toast(`Đã nạp ${result.series.length} quan sát từ ${file.name}. Dữ liệu chỉ nằm trong tab này.`)}catch(err){toast('Không nạp được file: '+(err.message||String(err)))}finally{state.importing=false;$('#filePicker').value=''}}
async function refreshPublic(){
 if(state.marketRefreshing)return;
 state.marketRefreshing=true;$('#marketStatus').textContent='Đang cập nhật';
 try{
  const r=await fetch('/api/market',{signal:AbortSignal.timeout(13000)});
  if(!r.ok)throw Error('API '+r.status);
  const out=await r.json();if(!Array.isArray(out.interbank)||out.interbank.length<20)throw Error('Nguồn dữ liệu không hợp lệ');
  state.publicMarket=out;state.lastMarketFetch=Date.now();
  const lastDate=out.coverage?.latestDailyDate||out.interbank.at(-1)?.date;
  $('#marketStatus').textContent='Thị trường · '+shortDate(lastDate);
  $('#marketDot').style.background='#35c4a6';render();
 }catch(_){
  if(!state.publicMarket.interbank?.length){
    try{const fallback=await fetch('/data/public_snapshot.json');if(fallback.ok)state.publicMarket=await fallback.json()}catch(_e){}
  }
  const lastDate=publicLatest('ON')?.date;
  $('#marketStatus').textContent=lastDate?'Thị trường · '+shortDate(lastDate):'Đang đồng bộ';
  $('#marketDot').style.background=lastDate?'#35c4a6':'#e7b66c';render();
 }finally{state.marketRefreshing=false}
}
async function checkModel(){try{const r=await fetch('/api/assistant',{signal:AbortSignal.timeout(6000)});const data=r.ok?await r.json():null;state.llm=!!data?.enabled;$('#aiBackend').textContent=state.llm?'Sẵn sàng — public only':'Local fallback';$('#modelState').textContent=state.llm?'AI KẾT NỐI — CHỈ NGUỒN CÔNG KHAI':'CHẾ ĐỘ PHÂN TÍCH NỘI BỘ';}catch(_){$('#aiBackend').textContent='Local fallback'}}
function bind(){document.addEventListener('click',ev=>{const btn=ev.target.closest('[data-nav]');if(btn){pageTo(btn.dataset.nav);return}const rate=ev.target.closest('[data-toggle-rate]');if(rate){const key=rate.dataset.toggleRate;state.activeRates.has(key)?state.activeRates.delete(key):state.activeRates.add(key);renderRateCharts();return}const p=ev.target.closest('[data-period]');if(p){state.period=p.dataset.period;$$('[data-period]').forEach(x=>x.classList.toggle('selected',x.dataset.period===state.period));render()}});$('#importBtn').addEventListener('click',()=>$('#filePicker').click());$('#qualityImportBtn').addEventListener('click',()=>$('#filePicker').click());$('#importBtnQuality').addEventListener('click',()=>$('#filePicker').click());$('#filePicker').addEventListener('change',ev=>importFile(ev.target.files?.[0]));$('#exportBtn').addEventListener('click',csvExport);$('#freqSelect').addEventListener('change',ev=>{state.freq=ev.target.value;render()});$('#themeBtn').addEventListener('click',()=>{document.body.classList.toggle('dark');$('#themeBtn').textContent=document.body.classList.contains('dark')?'☀':'☾'});$('#mobileMenu').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));$('#refreshMarket').addEventListener('click',refreshPublic);$('#refreshMarketTop')?.addEventListener('click',refreshPublic);$('#chatForm').addEventListener('submit',ev=>{ev.preventDefault();ask($('#chatInput').value)});$$('.question-chip').forEach(b=>b.addEventListener('click',()=>ask(b.textContent)));window.addEventListener('resize',()=>{if(state.data)renderRateCharts()})}
async function main(){
 bind();
 try{
  const [demo,pub]=await Promise.all([fetch('/data/demo.json'),fetch('/data/public_snapshot.json')]);
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
main();
