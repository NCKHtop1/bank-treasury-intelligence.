/* Local-only bridge from the user's saved TreasuryIQ HTML to GitHub Pages.
   Only activated by a nonce-bearing link opened from that HTML file.
   No banking data is sent to a third-party endpoint. */
export function installLocalHandoff(onImport) {
 const params=new URLSearchParams(window.location.search);
 const nonce=params.get('local_handoff');
 if(!nonce||!/^[a-f0-9]{32}$/.test(nonce)||!window.opener)return false;
 const opener=window.opener;
 let consumed=false;
 const announce=()=>{
   if(consumed)return;
   try{opener.postMessage({type:'TREASURYIQ_LOCAL_READY_V1',nonce},'*')}catch(_){}
 };
 const stop=()=>{window.clearInterval(timer)};
 const handler=async(event)=>{
   const message=event.data;
   if(consumed||event.source!==opener||!message||message.type!=='TREASURYIQ_LOCAL_DATA_V1'||message.nonce!==nonce)return;
   consumed=true;stop();
   const send=(ok,error)=>{try{event.source.postMessage({type:'TREASURYIQ_LOCAL_ACK_V1',nonce,ok,error:error||''},event.origin==='null'?'*':event.origin)}catch(_){}};
   try{
     const data=message.payload;
     if(!data||data.meta?.kind!=='private-local'||!Array.isArray(data.series)||data.series.length<2||data.series.length>30000)throw Error('Bản dữ liệu chưa hợp lệ');
     if(!data.series.some(r=>r&&typeof r==='object'&&Object.keys(r).some(k=>k.startsWith('book_')&&Number.isFinite(r[k]))))throw Error('Chưa nhận được dữ liệu Book');
     if(JSON.stringify(data).length>12000000)throw Error('Bản dữ liệu quá lớn');
     if(!data.series.every(r=>r&&/^20\d\d-\d\d-\d\d$/.test(String(r.date||''))))throw Error('Ngày số liệu không đúng định dạng');
     await onImport(data);
     window.history.replaceState(null,'',window.location.pathname+window.location.hash);
     send(true,'');
   }catch(err){consumed=false;send(false,err?.message||'Không đọc được bản lưu');}
 };
 window.addEventListener('message',handler);
 announce();
 const timer=window.setInterval(announce,850);
 window.setTimeout(()=>{stop()},45000);
 return true;
}