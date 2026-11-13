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
function calcSeries(dates,raws,market){const sorted=[...dates.entries()].sort((a,b)=>a[0].localeCompare(b[0]));const out=[],warns=[];let lastFx=null,lastFxDate=null;
const val=(x,k)=>raws[k]?.get(x)??null;const sum=(...args)=>args.every(v=>v!==null&&v!==undefined&&Number.isFinite(+v))?args.reduce((a,b)=>a+Number(b),0):null;
const scale=v=>v===null?null:v/1e9;
for(const [date,col] of sorted){const mr=market.get(date)||{},fxval=mr.fx_mid;if(fxval!=null){lastFx=fxval;lastFxDate=date}const gap=lastFxDate?Math.round((new Date(date)-new Date(lastFxDate))/86400000):null;const fx=(gap!=null&&gap<=7)?lastFx:null;
const loan=scale(sum(val(col,'interbank_vnd_loan'),fx!=null&&val(col,'interbank_usd_loan')!=null?val(col,'interbank_usd_loan')*fx:null));
const invest=scale(sum(val(col,'bond_pap'),val(col,'bond_trading'),val(col,'bond_afs')));
const reso=scale(val(col,'reso_vnd'));
const secured=scale(sum(val(col,'secured_vnd'),fx!=null&&val(col,'secured_usd')!=null?val(col,'secured_usd')*fx:null));
const unsecured=scale(sum(val(col,'unsecured_vnd'),fx!=null&&val(col,'unsecured_usd')!=null?val(col,'unsecured_usd')*fx:null));
const swap=sum(loan,invest!=null?-invest:null,reso!=null?-reso:null,secured!=null?-secured:null,unsecured!=null?-unsecured:null);
const gtcg=scale(sum(val(col,'bond_trading'),val(col,'bond_pap'),val(col,'cd_maturity_vnd')!=null?-val(col,'cd_maturity_vnd'):null));
const ldScale=sum(secured,unsecured),ldRate=val(col,'ld_vnd_rate'),funding=val(col,'mm_funding_vnd_rate'),ldBalance=val(col,'ld_vnd_balance');
const nim=ldRate!=null&&funding!=null&&ldBalance!=null&&Math.abs(ldBalance)>0?ldRate-funding:null;
const item={...mr,date,loan_bn:loan,total_mm_bn:loan,invest_gtcg_bn:invest,reso_bn:reso,secured_bn:secured,unsecured_bn:unsecured,swap_bn:swap,trade_finance_bn:null,instrument_recon_gap_bn:loan!=null&&swap!=null?loan-(invest+reso+secured+unsecured+swap):null,gtcg_scale_bn:gtcg,ld_scale_bn:ldScale,ld_nim_pct:nim,pnl_bn:scale(val(col,'pnl_total')),fx_conversion_carry_days:gap};out.push(item)}
if(out.some(x=>x.fx_conversion_carry_days>7))warns.push('Có phiên thiếu FX mid quá 7 ngày; không tính quy đổi USD sang VND cho các phiên này.');return {out,warns}}
async function parseExcel(file){if(file.size>85*1024*1024)throw Error('Workbook quá lớn (>85 MB). Hãy chạy scripts/export_snapshot.py cục bộ để tránh treo trình duyệt.');if(!window.JSZip){await new Promise((ok,err)=>{const s=document.createElement('script');s.src=new URL('./vendor/jszip.min.js',import.meta.url).href;s.onload=ok;s.onerror=()=>err(Error('Không nạp được JSZip nội bộ'));document.head.appendChild(s)})}const zip=await window.JSZip.loadAsync(await file.arrayBuffer()),sheetPaths=await workbookSheets(zip),strings=await getStrings(zip);if(!sheetPaths.TongHop)return parseAlternateWorkbookV13(zip,sheetPaths,strings,file);const tong=await readSheet(zip,sheetPaths.TongHop,strings);const labels=new Map(),dates=new Map();const headers=[...tong].filter(([row])=>row<=50).map(([row,cols])=>({row,cols,dates:[...cols].filter(([c,v])=>c>=2&&isoDate(v)).length})).sort((a,b)=>b.dates-a.dates);const header=headers[0];if(!header||header.dates<2)throw Error('Không tìm thấy hàng tiêu đề ngày trong TongHop (quét 50 dòng đầu).');for(const [row,cols] of tong){if(row===header.row){for(const [col,val] of cols){if(col>=2){const day=isoDate(val);if(day)dates.set(day,col)}}}else if(cols.has(1))labels.set(row,cols.get(1))}const r=rowFinder(labels);const def={interbank_vnd_loan:['[VND] - Cho Vay','INTERBANK'],interbank_usd_loan:['[USD] - Cho Vay','INTERBANK'],reso_vnd:['[VND] - RESO','REPO AND RESO'],bond_pap:['Du No Thoi Diem BOND PAP',null],bond_trading:['Du No Thoi Diem BOND TRADING',null],bond_afs:['Du No Thoi Diem BOND AFS',null],secured_vnd:['Cho vay TSDB VND',null],secured_usd:['Cho vay TSDB USD',null],unsecured_vnd:['Cho vay tin chap vnd',null],unsecured_usd:['Cho vay tin chap USD',null],cd_maturity_vnd:['[VND] - CD Đáo Hạn',null],ld_vnd_balance:['[VND] - Cho Vay','LOAN AND DEPOSIT'],ld_vnd_rate:['[VND] - LS cho vay BQ','LOAN AND DEPOSIT'],mm_funding_vnd_rate:['[VND] - LS di vay BQ (Đầu Vào)',null],pnl_total:['PnL hàng ngày',null]};const mapping={},raws={};for(const [key,[label,block]] of Object.entries(def)){const index=r(label,block);mapping[key]=index;raws[key]=tong.get(index)||new Map()}
const market=new Map();const set=(date,key,value)=>{if(!date||!dates.has(date)||value==null)return;if(!market.has(date))market.set(date,{});market.get(date)[key]=value};const warnings=['Trade Finance chưa có nguồn trong TongHop được xác nhận. Không tự gán "Cho vay FI" vào Trade Finance.'];const safeRead=async(name,maxCol)=>sheetPaths[name]?readSheet(zip,sheetPaths[name],strings,{maxCol}):new Map();const freshMap={};
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

function parseCSV(text,file){const lines=text.replace(/^\ufeff/,'').trim().split(/\r?\n/);const cols=lines.shift().split(',').map(x=>x.trim().replace(/^"|"$/g,''));if(!cols.includes('date'))throw Error('CSV cần có cột date (YYYY-MM-DD)');const data=[];for(const line of lines){if(!line.trim())continue;const values=line.split(',');const item={};for(let j=0;j<cols.length;j++){const key=cols[j];item[key]=key==='date'?isoDate(values[j]):rawNum(values[j])}if(item.date)data.push(item)}return {meta:{kind:'private-local',source_file:file.name,asOf:data.at(-1)?.date},source_freshness:{CSV:data.at(-1)?.date},series:data,warnings:['CSV phổ thông không kiểm chứng lại được mapping nghiệp vụ. Chỉ sử dụng các trường đã xuất với chuẩn đúng.']}}
export async function readUserFile(file){const ext=file.name.toLowerCase().split('.').at(-1);if(ext==='json'){const data=JSON.parse(await file.text());if(!Array.isArray(data.series))throw Error('JSON cần trường series là một mảng dữ liệu.');return data}if(ext==='csv')return parseCSV(await file.text(),file);if(ext==='xlsx'||ext==='xlsm')return parseExcel(file);throw Error('Hỗ trợ .xlsx, .xlsm, .json hoặc .csv');}
