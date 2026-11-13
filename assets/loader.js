import {mmComputeInstrument} from './treasury-analytics.mjs';
/**
 * Bank workbook parser. Runs entirely in the browser; no data is POSTed anywhere.
 * JSZip is a self-hosted MIT-licensed vendor dependency. Reads only known XML
 * worksheets (skips huge TSDB sheets). Known mapping follows legacy MM QA.
 */
const rawNum=v=>v===null||v===undefined||v===''?null:typeof v==='number'&&Number.isFinite(v)?v:Number.isFinite(Number(String(v).replace(',','.')))?Number(String(v).replace(',','.')):null;
const isoDate=value=>{
  if(value===undefined||value===null||value==='')return null;
  if(typeof value==='number'){
    if(value<15000||value>150000)return null;
    return new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000).toISOString().slice(0,10);
  }
  let x=String(value).trim();if(/^\d{4}-\d\d-\d\d/.test(x))return x.slice(0,10);
  let d=x.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);if(d)return `${d[3]}-${d[2].padStart(2,'0')}-${d[1].padStart(2,'0')}`;
  const ms=Date.parse(x);return Number.isFinite(ms)?new Date(ms).toISOString().slice(0,10):null;
};
const cleanText=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').replace(/\s+/g,' ').trim().toLowerCase();
function colNum(ref){let num=0;for(const c of (ref.match(/^[A-Z]+/)?.[0]||''))num=num*26+c.charCodeAt(0)-64;return num}
function unxml(s){return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))}
function docParse(text){const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw Error('Excel XML không hợp lệ');return doc}
function tags(node,name){return [...node.getElementsByTagNameNS('*',name)]}
async function getStrings(zip){const file=zip.file('xl/sharedStrings.xml');if(!file)return[];const xml=await file.async('string');const values=[];const re=/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;let m;while((m=re.exec(xml))){const s=[...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x=>unxml(x[1])).join('');values.push(s)}return values}
async function workbookSheets(zip){const wb=docParse(await zip.file('xl/workbook.xml').async('string')),rels=docParse(await zip.file('xl/_rels/workbook.xml.rels').async('string'));const pathById=new Map(tags(rels,'Relationship').map(x=>[x.getAttribute('Id'),x.getAttribute('Target')]));const map={};for(const x of tags(wb,'sheet')){const id=x.getAttribute('r:id')||x.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');let target=pathById.get(id)||'';if(!target)continue;target=target.replace(/^\//,'');if(!target.startsWith('xl/'))target='xl/'+target;target=target.replace(/\/xl\/\.\/+/g,'xl/');map[x.getAttribute('name')]=target}return map}
function parseCells(rowXml,strings,maxCol=99999){const values=new Map();let m;const re=/<c\b([^>]*?)>([\s\S]*?)<\/c>|<c\b([^>]*?)\s*\/>/g;while((m=re.exec(rowXml))){const attr=m[1]||m[3]||'';const address=attr.match(/\br="([A-Z]+\d+)"/)?.[1];if(!address)continue;const ci=colNum(address);if(ci>maxCol)continue;const type=attr.match(/\bt="([^"]+)"/)?.[1]||'';const body=m[2]||'';let value=null;const vm=body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);if(type==='s'){const k=Number(vm?.[1]);value=strings[k]??null}else if(type==='inlineStr'){value=[...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x=>unxml(x[1])).join('')}else if(type==='str'){value=vm?unxml(vm[1]):null}else if(type==='b'){value=vm?.[1]==='1'}else if(vm){value=rawNum(vm[1])??unxml(vm[1])}if(value!==null&&value!==undefined)values.set(ci,value)}return values}
async function readSheet(zip,path,strings,{maxCol=99999,wantedRows=null}={}){const f=zip.file(path);if(!f)throw Error('Không tìm thấy worksheet XML: '+path);const xml=await f.async('string');const rows=new Map();const regex=/<row\b([^>]*)>([\s\S]*?)<\/row>/g;let m,ix=0;while((m=regex.exec(xml))){const nr=Number(m[1].match(/\br="(\d+)"/)?.[1]||++ix);if(wantedRows&&!wantedRows.has(nr))continue;rows.set(nr,parseCells(m[2],strings,maxCol))}return rows}
function blockFromLabel(name){const m=String(name).match(/^--\[([^\]]+)\]--$/);return m?.[1]?.trim().toUpperCase()||null}
function rowFinder(labels){const markers=[];for(const [r,v] of labels){const block=blockFromLabel(v);if(block)markers.push({r,block})}markers.sort((a,b)=>a.r-b.r);
return(label,block=null,required=true)=>{const cand=[...labels].filter(([r,text])=>cleanText(text)===cleanText(label)).filter(([r])=>{if(!block)return true;const prior=markers.filter(x=>x.r<r).at(-1);return prior?.block===block.toUpperCase()}).map(([r])=>r);if(cand.length===1)return cand[0];if(required)throw Error(`Không xác định được metric "${label}" trong block "${block||'không chỉ định'}" (khớp ${cand.length} dòng)`);return null};}
function freshness(rows,keys){for(let i=rows.length-1;i>=0;i--)for(const k of keys){if(rows[i][k]!=null&&Number.isFinite(+rows[i][k]))return rows[i].date}return null}

function calcSeries(dates,raws,market){
 const ordered=[...dates.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
 const out=[],warns=[];let lastFx=null,lastFxDate=null;
 const fieldNames=['interbank_vnd_loan','interbank_usd_loan','bond_pap','bond_trading','bond_afs','reso_vnd','secured_vnd','secured_usd','unsecured_vnd','unsecured_usd','cd_maturity_vnd','ld_vnd_balance','ld_vnd_rate','mm_funding_vnd_rate','trade_finance_vnd','trade_finance_usd'];
 for(const [date,col] of ordered){
  const observation=market.get(date)||{},fxRaw=observation.fx_mid;
  if(typeof fxRaw==='number'&&Number.isFinite(fxRaw)&&fxRaw>10000&&fxRaw<60000){lastFx=fxRaw;lastFxDate=date;}
  const carry=lastFxDate?Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(lastFxDate+'T00:00:00Z'))/86400000):null;
  const fx=carry!==null&&carry>=0&&carry<=7?lastFx:null;
  const raw=Object.fromEntries(fieldNames.map(k=>[k,raws[k]?.get(col)??null]));
  raw.hasTradeFinance=Boolean(raws.trade_finance_vnd||raws.trade_finance_usd);
  const computed=mmComputeInstrument(raw,fx);
  out.push({...observation,date,...computed,pnl_bn:raws.pnl_total?.has(col)?Number(raws.pnl_total.get(col))/1e9:null,fx_conversion_carry_days:carry});
 }
 if(out.some(r=>r.fx_conversion_carry_days>7))warns.push('FX mid cách ngày số dư quá 7 ngày: các quy đổi USD không được tính cho phiên này.');
 if(out.some(r=>r.swap_bn!=null&&r.swap_bn<0))warns.push('Một số phiên Swap residual âm; kiểm tra mapping các nhóm nguồn và định nghĩa Loan.');
 if(out.some(r=>r.instrument_recon_gap_bn!=null&&Math.abs(r.instrument_recon_gap_bn)>0.01))warns.push('Instrument reconciliation có chênh lệch; nếu Trade Finance tách riêng thì công thức Swap residual cần được xác nhận lại.');
 return {out,warns};
}

async function parseExcel(file){if(file.size>85*1024*1024)throw Error('Workbook quá lớn (>85 MB). Hãy chạy scripts/export_snapshot.py cục bộ để tránh treo trình duyệt.');if(!window.JSZip){await new Promise((ok,err)=>{const s=document.createElement('script');s.src=new URL('./vendor/jszip.min.js',import.meta.url).href;s.onload=ok;s.onerror=()=>err(Error('Không nạp được JSZip nội bộ'));document.head.appendChild(s)})}const zip=await window.JSZip.loadAsync(await file.arrayBuffer()),sheetPaths=await workbookSheets(zip),strings=await getStrings(zip);if(!sheetPaths.TongHop){const data=await parseAlternateWorkbookV13(zip,sheetPaths,strings,file);return sheetNamedV13(sheetPaths,'ITB')?enrichBookWorkbookV14(data,zip,sheetPaths,strings):data;}const tong=await readSheet(zip,sheetPaths.TongHop,strings);const labels=new Map(),dates=new Map();const dateCandidates=[...tong].filter(([row])=>row<=2500).map(([row,cols])=>({row,cols,dates:[...cols].filter(([c,v])=>c>=2&&isoDate(v)).length})).sort((a,b)=>b.dates-a.dates);const header=dateCandidates[0];if(!header||header.dates<2)throw Error('Không tìm thấy hàng tiêu đề ngày trong TongHop.');for(const [row,cols] of tong){if(row===header.row){for(const [col,val] of cols){if(col>=2){const day=isoDate(val);if(day)dates.set(day,col)}}}else if(cols.has(1))labels.set(row,cols.get(1))}const r=rowFinder(labels);const def={interbank_vnd_loan:['[VND] - Cho Vay','INTERBANK'],interbank_usd_loan:['[USD] - Cho Vay','INTERBANK'],reso_vnd:['[VND] - RESO','REPO AND RESO'],bond_pap:['Du No Thoi Diem BOND PAP',null],bond_trading:['Du No Thoi Diem BOND TRADING',null],bond_afs:['Du No Thoi Diem BOND AFS',null],secured_vnd:['Cho vay TSDB VND',null],secured_usd:['Cho vay TSDB USD',null],unsecured_vnd:['Cho vay tin chap vnd',null],unsecured_usd:['Cho vay tin chap USD',null],cd_maturity_vnd:['[VND] - CD Đáo Hạn',null],ld_vnd_balance:['[VND] - Cho Vay','LOAN AND DEPOSIT'],ld_vnd_rate:['[VND] - LS cho vay BQ','LOAN AND DEPOSIT'],mm_funding_vnd_rate:['[VND] - LS di vay BQ (Đầu Vào)',null],pnl_total:['PnL hàng ngày',null]};const mapping={},raws={};for(const [key,[label,block]] of Object.entries(def)){const index=r(label,block);mapping[key]=index;raws[key]=tong.get(index)||new Map()};for(const [key,label] of [['trade_finance_vnd','[VND] - Trade Finance'],['trade_finance_usd','[USD] - Trade Finance']]){const index=r(label,'TRADE FINANCE',false);if(index){mapping[key]=index;raws[key]=tong.get(index)||new Map()}}
const market=new Map();const set=(date,key,value)=>{if(!date||!dates.has(date)||value==null)return;if(!market.has(date))market.set(date,{});market.get(date)[key]=value};const warnings=[];if(!raws.trade_finance_vnd&&!raws.trade_finance_usd)warnings.push('Trade Finance chưa có trường nguồn được xác nhận dưới block TRADE FINANCE trong TongHop.');else warnings.push('Trade Finance có nguồn; công thức Swap residual hiện chưa trừ Trade Finance, cần đối chiếu chênh lệch.');const safeRead=async(name,maxCol)=>sheetPaths[name]?readSheet(zip,sheetPaths[name],strings,{maxCol}):new Map();const freshMap={};
const fx=await safeRead('Ty gia',6);for(const [nr,c] of fx){if(nr===1)continue;const date=isoDate(c.get(1));set(date,'fx_ask',rawNum(c.get(4)));set(date,'fx_bid',rawNum(c.get(5)));set(date,'fx_mid',rawNum(c.get(6)))}
const itb=await safeRead('LS ITB',12);const headers=new Map();const bestItbHeader=findHeaderV13(itb,['MMONVND','MMSWVND','MM1MVND','MM3MVND']);for(const [col,title] of bestItbHeader?.map?[...itb.get(bestItbHeader.nr)]:[])headers.set(cleanText(title).toUpperCase(),col);const itbDefs={MMONVND:'itb_on',MMSWVND:'itb_1w',MM2WVND:'itb_2w',MM1MVND:'itb_1m',MM2MVND:'itb_2m',MM3MVND:'itb_3m',MM6MVND:'itb_6m',MM9MVND:'itb_9m',MM1YVND:'itb_1y'};for(const [nr,c] of itb){if(nr===(bestItbHeader?.nr||1))continue;const date=isoDate(c.get(1));for(const [header,key] of Object.entries(itbDefs)){const col=headers.get(header);if(col){set(date,key,rawNum(c.get(col)));if(key==='itb_1w')set(date,'itb_sw',rawNum(c.get(col)))}}}
const gt=await safeRead('LS GTCG',3);for(const [nr,c] of gt){if(nr===1)continue;set(isoDate(c.get(2)),'gtcg_lsbq_pct',rawNum(c.get(3)))}
const vb=await safeRead('VBMA',17);for(const [nr,c] of vb){if(nr===1)continue;const yDate=isoDate(c.get(1)),mDate=isoDate(c.get(13));['1y','2y','3y','4y','5y','7y','10y','15y','20y','30y'].forEach((key,i)=>set(yDate,'vbma_'+key,rawNum(c.get(i+2))));['vbma_swap_on','vbma_swap_1m','vbma_swap_3m','vbma_itb_on'].forEach((key,i)=>set(mDate,key,rawNum(c.get(i+14))))}
const {out,warns}=calcSeries(dates,raws,market);warnings.push(...warns);if(!out.length)throw Error('Không có series hợp lệ');const freshest={TongHop:out.at(-1).date,'Ty gia':freshness(out,['fx_mid','fx_bid','fx_ask']),'LS ITB':freshness(out,['itb_on','itb_1m','itb_3m']),'LS GTCG':freshness(out,['gtcg_lsbq_pct']),'VBMA TPCP':freshness(out,['vbma_1y','vbma_5y','vbma_10y']),'VBMA Swap/ITB':freshness(out,['vbma_swap_on','vbma_swap_1m','vbma_swap_3m'])};for(const [key,date] of Object.entries(freshest))if(date&&key!=='TongHop'&&(new Date(out.at(-1).date)-new Date(date))/86400000>7)warnings.push(`Nguồn ${key} đang cũ: ${date}, cần đối chiếu số liệu mới.`);
return {meta:{kind:'private-local',source_file:file.name,asOf:out.at(-1).date,createdAt:new Date().toISOString(),label:'DỮ LIỆU NẠP TRÊN THIẾT BỊ'},source_freshness:freshest,series:out,mapping,warnings};}
function normFieldV13(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toUpperCase().replace(/[^A-Z0-9]+/g,'').trim()}

function sheetNamedV13(paths,...names){const entries=Object.entries(paths);for(const name of names){const x=entries.find(([key])=>normFieldV13(key)===normFieldV13(name));if(x)return x}return null}

function findHeaderV13(rows,labels){let best=null;for(const [nr,cells] of rows){if(nr>60)break;const map=new Map([...cells].map(([c,v])=>[normFieldV13(v),c]).filter(([k])=>k));const score=labels.reduce((n,x)=>n+(map.has(normFieldV13(x))?1:0),0);if(score>0&&(!best||score>best.score))best={nr,map,score};}return best}

function headerColV13(header,...labels){for(const key of labels){const col=header?.map?.get(normFieldV13(key));if(col)return col}return null}

function validDateV13(d){return typeof d==='string'&&/^20\d\d-\d\d-\d\d$/.test(d)&&d<=new Date(Date.now()+86400000).toISOString().slice(0,10)}

async function parseAlternateWorkbookV13(zip,paths,strings,file){
 const out=new Map(),mapped={},fresh={},warnings=[];
 const rowFor=date=>{if(!out.has(date))out.set(date,{date});return out.get(date)};
 const apply=(date,key,raw,source)=>{if(!validDateV13(date))return;const v=rawNum(raw);if(v===null||!Number.isFinite(v))return;if(key.startsWith('itb_')&&!(v>=0&&v<=45))return;if(key==='fx_mid'&&!(v>10000&&v<60000))return;
  rowFor(date)[key]=v;fresh[source]=!fresh[source]||fresh[source]<date?date:fresh[source];};
 const read=async(...names)=>{const selected=sheetNamedV13(paths,...names);if(!selected)return null;return {name:selected[0],rows:await readSheet(zip,selected[1],strings,{maxCol:50})}};
 const rates=await read('MMDaily','LS ITB');
 if(rates){
  const h=findHeaderV13(rates.rows,['Date','MMONVND','MM1MVND','MMSWVND','MM1WVND']);
  const dcol=headerColV13(h,'Date','Ngay','PriceDate')||1;
  const defs=[['itb_on','MMONVND'],['itb_1w','MMSWVND','MM1WVND'],['itb_2w','MM2WVND'],['itb_1m','MM1MVND'],['itb_2m','MM2MVND'],['itb_3m','MM3MVND'],['itb_6m','MM6MVND'],['itb_9m','MM9MVND'],['itb_1y','MM1YVND']];
  for(const [key,...labels] of defs){const col=headerColV13(h,...labels);if(col)mapped[key]={sheet:rates.name,field:labels[0],column:col}}
  for(const [nr,c] of rates.rows){if(nr<=(h?.nr||0))continue;const date=isoDate(c.get(dcol));for(const [key,...labels] of defs){const col=headerColV13(h,...labels);if(col)apply(date,key,c.get(col),rates.name)}}
 }
 const fx=await read('Ty gia','Tỷ giá');
 if(fx){
  const h=findHeaderV13(fx.rows,['PriceDate','RevalRateMid','Date','Mid','Ty gia']);
  const dc=headerColV13(h,'PriceDate','Date','Ngay')||1,mid=headerColV13(h,'RevalRateMid','FXMid','Mid','TyGiaMid'),bid=headerColV13(h,'Bid','TyGiaMua'),ask=headerColV13(h,'Ask','TyGiaBan');
  if(mid)mapped.fx_mid={sheet:fx.name,field:'RevalRateMid',column:mid};
  for(const [nr,c] of fx.rows){if(nr<=(h?.nr||0))continue;const date=isoDate(c.get(dc));if(mid)apply(date,'fx_mid',c.get(mid),fx.name);if(bid)apply(date,'fx_bid',c.get(bid),fx.name);if(ask)apply(date,'fx_ask',c.get(ask),fx.name)}
 }
 const bond=await read('Bond yield');
 if(bond){const h=findHeaderV13(bond.rows,['1y','3y','5y','10y']),dc=headerColV13(h,'Date','Ngay')||1;
  for(const [nr,c] of bond.rows){if(nr<=(h?.nr||0))continue;const d=isoDate(c.get(dc));for(const t of ['1y','2y','3y','4y','5y','7y','10y','15y','20y','30y']){const col=headerColV13(h,t);if(col)apply(d,'vbma_'+t,c.get(col),bond.name)}}
 }
 const swap=await read('Swap Daily');
 if(swap){const h=findHeaderV13(swap.rows,['Date','ON','1M','3M']),dc=headerColV13(h,'Date','Ngay')||1;
  for(const [nr,c] of swap.rows){if(nr<=(h?.nr||0))continue;const d=isoDate(c.get(dc));for(const [t,key] of [['ON','vbma_swap_on'],['1M','vbma_swap_1m'],['3M','vbma_swap_3m']]){const col=headerColV13(h,t);if(col)apply(d,key,c.get(col),swap.name)}}
 }
 for(const [sheet,metric] of [['ITB','loan_bn'],['LD ITB','ld_scale_bn']]){
  const sh=await read(sheet);if(!sh)continue;
  const h=findHeaderV13(sh.rows,['Date','[VND] - Cho Vay','[VND] - LS cho vay BQ','[VND] - LS di vay BQ']);
  const dc=headerColV13(h,'Date','Ngay')||1,loan=headerColV13(h,'[VND] - Cho Vay'),lrCol=headerColV13(h,'[VND] - LS cho vay BQ'),brCol=headerColV13(h,'[VND] - LS di vay BQ');
  if(loan)mapped[metric]={sheet,field:'[VND] - Cho Vay',column:loan};
  for(const [nr,c] of sh.rows){if(nr<=(h?.nr||0))continue;const d=isoDate(c.get(dc));if(!validDateV13(d))continue;
   const asset=loan?rawNum(c.get(loan)):null;
   if(asset!==null&&asset>=0){apply(d,metric,asset/1e9,sheet);if(sheet==='ITB')apply(d,'total_mm_bn',asset/1e9,sheet)}
   const lr=lrCol?rawNum(c.get(lrCol)):null,br=brCol?rawNum(c.get(brCol)):null;
   if(lr!==null&&br!==null&&lr>=0&&lr<=45&&br>=0&&br<=45&&sheet==='LD ITB')apply(d,'ld_nim_pct',lr-br,sheet);
  }
 }
 const rows=[...out.values()].sort((a,b)=>a.date.localeCompare(b.date));
 if(rows.length<2)throw Error('Không tìm thấy từ 2 ngày dữ liệu hợp lệ. Kiểm tra các sheet Date, ITB hoặc MMDaily.');
 if(!rows.some(x=>Object.keys(x).length>1))throw Error('Không nhận diện được trường từ tên cột trong workbook.');
 if(!rows.some(x=>x.loan_bn!=null))warnings.push('Workbook chỉ có thông tin lãi suất hoặc tỷ giá; các chỉ tiêu số dư sẽ xuất hiện khi có file MM.');
 return {meta:{kind:'private-local',source_file:file.name,asOf:rows.at(-1).date,createdAt:new Date().toISOString(),label:'Workbook',scope:sheetNamedV13(paths,'ITB')?'itb_vnd':'market_rates',mapping_count:Object.keys(mapped).length},series:rows,mapping:mapped,source_freshness:fresh,warnings};
}

function bookSpecV14(){
 return [
  ['itb','ITB',['Date','[VND] - Cho Vay','[VND] - Di Vay'],[
   ['asset_vnd_bn','[VND] - Cho Vay','vnd'],['fund_vnd_bn','[VND] - Di Vay','fund_vnd'],
   ['net_vnd_bn','[VND] - Net Cho Vay/Di Vay','vnd'],
   ['asset_usd_m','[USD] - Cho Vay','usd'],['fund_usd_m','[USD] - Di Vay','fund_usd'],
   ['net_usd_m','[USD] - Net Cho Vay/Di Vay','usd'],
   ['loan_rate_pct','[VND] - LS cho vay BQ','rate'],['fund_rate_pct','[VND] - LS di vay BQ','rate'],
   ['loan_term_days','[VND] - Ky han cho vay BQ','term'],['fund_term_days','[VND] - Ky han di vay BQ','term']]],
  ['ld_itb','LD ITB',['Date','[VND] - Cho Vay','[VND] - Di Vay'],[
   ['asset_vnd_bn','[VND] - Cho Vay','vnd'],['fund_vnd_bn','[VND] - Di Vay','fund_vnd'],
   ['net_vnd_bn','[VND] - Net Cho Vay/Di Vay','vnd'],
   ['asset_usd_m','[USD] - Cho Vay','usd'],['fund_usd_m','[USD] - Di Vay','fund_usd'],
   ['net_usd_m','[USD] - Net Cho Vay/Di Vay','usd'],
   ['loan_rate_pct','[VND] - LS cho vay BQ','rate'],['fund_rate_pct','[VND] - LS di vay BQ','rate'],
   ['loan_term_days','[VND] - Ky han cho vay BQ','term'],['fund_term_days','[VND] - Ky han di vay BQ','term']]],
  ['ld_alm','LD ALM',['Date','[VND] - Cho Vay','[VND] - Di Vay'],[
   ['asset_vnd_bn','[VND] - Cho Vay','vnd'],['fund_vnd_bn','[VND] - Di Vay','fund_vnd'],
   ['net_vnd_bn','[VND] - Net Cho Vay/Di Vay','vnd'],
   ['asset_usd_m','[USD] - Cho Vay','usd'],['fund_usd_m','[USD] - Di Vay','fund_usd'],
   ['net_usd_m','[USD] - Net Cho Vay/Di Vay','usd'],
   ['loan_rate_pct','[VND] - LS cho vay BQ','rate'],['fund_rate_pct','[VND] - LS di vay BQ','rate'],
   ['loan_term_days','[VND] - Ky han cho vay BQ','term'],['fund_term_days','[VND] - Ky han di vay BQ','term']]],
  ['repo','Repo',['Date','[VND] - RESO','[VND] - REPO'],[
   ['asset_vnd_bn','[VND] - RESO','vnd'],['fund_vnd_bn','[VND] - REPO','fund_vnd'],
   ['loan_rate_pct','[VND - RESO] - LS Cho Vay BQ','rate'],['fund_rate_pct','[VND - REPO] - LS Di Vay BQ','rate'],
   ['loan_term_days','[VND - RESO] - Ky Han Cho Vay B','term'],['fund_term_days','[VND - REPO] - Ky Han Di Vay BQ','term']]],
  ['swp','SwP',['Date','[VND] - Du No','[VND] - Cho vay'],[
   ['net_vnd_bn','[VND] - Du No','vnd'],['net_usd_m','[USD] - Du No','usd'],
   ['asset_vnd_bn','[VND] - Cho vay','vnd'],['fund_vnd_bn','[VND] - Đi vay','fund_vnd'],
   ['asset_usd_m','[USD] - Cho vay','usd'],['fund_usd_m','[USD] - Đi vay','fund_usd'],
   ['loan_rate_pct','[VND] - LS cho vay BQ','rate'],['fund_rate_pct','[VND] - LS di vay BQ','rate'],
   ['loan_term_days','[VND] - KY HAN cho vay BQ','term'],['fund_term_days','[VND] - KY HAN di vay BQ','term']]],
  ['cd','CD',['Date','Du No Thoi Diem BOND PAP'],[
   ['asset_vnd_bn','Du No Thoi Diem BOND PAP','vnd'],
   ['loan_rate_pct','Lai suat cho vay binh quan BOND','rate'],
   ['loan_term_days','Ky Han cho vay binh quan BOND P','term'],
   ['trading_vnd_bn','Du No Thoi Diem BOND TRADING','vnd'],
   ['afs_vnd_bn','Du No Thoi Diem BOND AFS','vnd'],
   ['cd_maturity_vnd_bn','[VND] - CD Đáo Hạn','vnd']]],
  ['ld_slide','Bảng L&D Slide',['Thời gian','Quy mô L&D','NIM'],[
   ['ld_total_vnd_bn','Quy mô L&D','vnd'],
   ['ld_nim_pct','NIM','rate'],
   ['gap_term_days','Gap kỳ hạn','term'],
   ['omo_vnd_bn','OMO','vnd']]]
 ];
}

async function enrichBookWorkbookV14(out,zip,paths,strings){
 const index=new Map((out.series||[]).map(r=>[r.date,r]));
 const quality=[],mapping={...(out.mapping||{})},counts={};
 const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&s<='2100-01-01';
 const getRow=date=>{if(!index.has(date))index.set(date,{date});return index.get(date)};
 const spec=bookSpecV14();
 for(const [code,sheet,anchors,fields] of spec){
  const found=sheetNamedV13(paths,sheet);
  if(!found){quality.push('Không có sheet '+sheet);continue}
  let rows;
  try{rows=await readSheet(zip,found[1],strings,{maxCol:40})}
  catch(e){quality.push('Không đọc được sheet '+sheet+': '+e.message);continue}
  const header=findHeaderV13(rows,anchors);const dateCol=headerColV13(header,'Date','Thời gian','Ngay');
  if(!dateCol){quality.push('Thiếu cột ngày: '+sheet);continue}
  const columns=[];
  for(const [metric,label,unit] of fields){
   const col=headerColV13(header,label);
   if(col){
    columns.push({metric,col,unit,label});
    mapping['book_'+code+'_'+metric]={sheet,field:label,column:col,unit};
   }
  }
  if(!columns.length){quality.push('Không nhận diện được trường số liệu: '+sheet);continue}
  let readCount=0;
  for(const [nr,cells] of rows){
   if(nr<=header.nr)continue;
   const day=isoDate(cells.get(dateCol));if(!validDate(day))continue;
   const rec=getRow(day);let any=false;
   for(const f of columns){
    let v=rawNum(cells.get(f.col));
    if(v===null||!Number.isFinite(v))continue;
    if(f.unit==='rate'&&(v<0||v>45))continue;
    if(f.unit==='term'&&(v<0||v>30000))continue;
    if(f.unit==='vnd'||f.unit==='fund_vnd')v/=1e9;
    if(f.unit==='usd'||f.unit==='fund_usd')v/=1e6;
    if(f.unit==='fund_vnd'||f.unit==='fund_usd')v=-Math.abs(v);
    rec['book_'+code+'_'+f.metric]=v;any=true;
   }
   if(any)readCount++;
  }
  counts[code]=readCount;
  if(readCount<2)quality.push('Sheet '+sheet+' có ít hơn hai ngày hợp lệ');
 }
 out.series=[...index.values()].sort((a,b)=>a.date.localeCompare(b.date));
 out.mapping=mapping;
 out.meta={...(out.meta||{}),kind:'private-local',hasBooks:true,bookSheets:Object.keys(counts),bookObservations:counts,bookLatestDate:out.series.filter(x=>Object.keys(x).some(k=>k.startsWith('book_'))).at(-1)?.date||null};
 out.source_freshness={...(out.source_freshness||{}),...Object.fromEntries(Object.entries(counts).filter(([,c])=>c>0).map(([code])=>[code,out.series.filter(r=>Object.keys(r).some(k=>k.startsWith('book_'+code+'_'))).at(-1)?.date||null]))};
 out.warnings=[...(out.warnings||[]),...quality];
 out.monthlyBooks=(await parseMonthlyBooksV14(zip,paths,strings)).filter(x=>x.month<=(out.meta.bookLatestDate||'').slice(0,7));
 // Legacy fields feed existing MM/L&D modules without double counting.
 for(const r of out.series){
  if(r.book_itb_asset_vnd_bn!==undefined)r.loan_bn=r.book_itb_asset_vnd_bn;
  if(r.book_ld_itb_asset_vnd_bn!==undefined)r.ld_scale_bn=r.book_ld_itb_asset_vnd_bn;
  if(r.book_ld_itb_loan_rate_pct!=null&&r.book_ld_itb_fund_rate_pct!=null)
    r.ld_nim_pct=r.book_ld_itb_loan_rate_pct-r.book_ld_itb_fund_rate_pct;
  if(r.book_cd_asset_vnd_bn!=null)r.invest_gtcg_bn=r.book_cd_asset_vnd_bn;
  if(r.book_repo_asset_vnd_bn!=null)r.reso_bn=r.book_repo_asset_vnd_bn;
  if(r.book_swp_net_vnd_bn!=null)r.swap_bn=r.book_swp_net_vnd_bn;
 }
 return out;
}

async function parseMonthlyBooksV14(zip,paths,strings){
 const sheet=sheetNamedV13(paths,'Tong hop MM');
 if(!sheet)return [];
 const rows=await readSheet(zip,sheet[1],strings,{maxCol:16});
 const nameBook=s=>{
  const k=normFieldV13(s);
  if(k==='LDINTERBANK')return 'ld_itb';
  if(k==='LDALM')return 'ld_alm';
  if(k==='CD')return 'cd';
  if(k==='BONDTRADING')return 'trading';
  if(k==='SWAP')return 'swp';
  if(k==='RESO'||k==='REPO')return 'repo';
  if(k==='TOTALVND'||k==='TOTALUSD')return 'total';
  return null;
 };
 const group=new Map();let current=null,assetCcy='VND',fundCcy='VND';
 const add=(row,book,currency,side,balance,rate,term)=>{
  const v=rawNum(balance);if(v===null||!Number.isFinite(v))return;
  if(!['VND','USD'].includes(currency))return;
  const key=[current,book,currency].join('|');
  if(!group.has(key))group.set(key,{month:current,book,currency,source:'Tong hop MM'});
  const target=group.get(key),scaled=v/(currency==='VND'?1e9:1e6);
  target[side]=side==='fund'?-Math.abs(scaled):scaled;
  const r=rawNum(rate),t=rawNum(term);
  if(r!==null&&r>=0&&r<=45)target[side+'_rate_pct']=r;
  if(t!==null&&t>=0&&t<=30000)target[side+'_term_days']=t;
  const reportedNIM=rawNum(row.get(13));
  if(reportedNIM!==null&&reportedNIM>-45&&reportedNIM<45)target.reported_nim_pct=reportedNIM;
 };
 for(const [,row] of rows){
  const marker=String(row.get(1)||'').trim().match(/^T\s*(\d{1,2})\s*[.\/]\s*(\d{2,4})$/i);
  if(marker){
   const month=Number(marker[1]),y=Number(marker[2]);
   current=month>=1&&month<=12?(y<100?2000+y:y)+'-'+String(month).padStart(2,'0'):null;
   assetCcy='VND';fundCcy='VND';
  }
  if(!current)continue;
  const aMark=normFieldV13(row.get(2)),fMark=normFieldV13(row.get(7));
  if(aMark==='VND'||aMark==='USD')assetCcy=aMark;
  if(fMark==='VND'||fMark==='USD')fundCcy=fMark;
  const a=nameBook(row.get(3)),f=nameBook(row.get(8));
  const aTotal=nameBook(row.get(2)),fTotal=nameBook(row.get(7));
  if(a||aTotal)add(row,a||aTotal,aTotal?aTotal==='total'&&aMark==='TOTALUSD'?'USD':'VND':assetCcy,'asset',row.get(4),row.get(5),row.get(6));
  if(f||fTotal)add(row,f||fTotal,fTotal?fMark==='TOTALUSD'?'USD':'VND':fundCcy,'fund',row.get(9),row.get(10),row.get(11));
 }
 return [...group.values()].sort((a,b)=>a.month.localeCompare(b.month)||a.book.localeCompare(b.book)||a.currency.localeCompare(b.currency));
}

function parseCSV(text,file){const lines=text.replace(/^\ufeff/,'').trim().split(/\r?\n/);const cols=lines.shift().split(',').map(x=>x.trim().replace(/^"|"$/g,''));if(!cols.includes('date'))throw Error('CSV cần có cột date (YYYY-MM-DD)');const data=[];for(const line of lines){if(!line.trim())continue;const values=line.split(',');const item={};for(let j=0;j<cols.length;j++){const key=cols[j];item[key]=key==='date'?isoDate(values[j]):rawNum(values[j])}if(item.date)data.push(item)}return {meta:{kind:'private-local',source_file:file.name,asOf:data.at(-1)?.date},source_freshness:{CSV:data.at(-1)?.date},series:data,warnings:['CSV phổ thông không kiểm chứng lại được mapping nghiệp vụ. Chỉ sử dụng các trường đã xuất với chuẩn đúng.']}}
export async function readUserFile(file){const ext=file.name.toLowerCase().split('.').at(-1);if(ext==='html'||ext==='htm'){const html=await file.text();const match=html.match(/<script\\s+[^>]*id=["']seed-data["'][^>]*>([\\s\\S]*?)<\\/script>/i);if(!match)throw Error('HTML không chứa bản dữ liệu TreasuryIQ');const data=JSON.parse(match[1]);if(data.meta?.kind!=='private-local'||!Array.isArray(data.series))throw Error('Dữ liệu trong HTML không hợp lệ');return data}if(ext==='json'){const data=JSON.parse(await file.text());if(!Array.isArray(data.series))throw Error('JSON cần trường series là một mảng dữ liệu.');return data}if(ext==='csv')return parseCSV(await file.text(),file);if(ext==='xlsx'||ext==='xlsm')return parseExcel(file);throw Error('Hỗ trợ .xlsx, .xlsm, .json hoặc .csv');}
