/**
 * TreasuryIQ private workbook cache.
 * Only derived observations are stored on this device; nothing is uploaded.
 * Non-extractable WebCrypto key + AES-GCM at rest in IndexedDB.
 */
const DB_NAME='treasuryiq-device-v1';
const DB_VERSION=1;
const KEY_NAME='device-key';
const RECORD_NAME='latest';
const CACHE_LIMIT=32*1024*1024;
function openStore(){
 return new Promise((resolve,reject)=>{
  if(!('indexedDB' in globalThis)||!globalThis.crypto?.subtle){reject(new Error('Trình duyệt không hỗ trợ lưu dữ liệu cục bộ'));return}
  const r=indexedDB.open(DB_NAME,DB_VERSION);
  r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('keys'))db.createObjectStore('keys');if(!db.objectStoreNames.contains('data'))db.createObjectStore('data')};
  r.onsuccess=()=>resolve(r.result);
  r.onerror=()=>reject(r.error||new Error('Không mở được dữ liệu trên thiết bị'));
 });
}
async function getItem(store,key){
 const db=await openStore();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(store,'readonly'),r=tx.objectStore(store).get(key);
  r.onsuccess=()=>resolve(r.result??null);
  r.onerror=()=>reject(r.error);
  tx.oncomplete=()=>db.close();
  tx.onerror=()=>{db.close();reject(tx.error)};
 });
}
async function setItem(store,key,val){
 const db=await openStore();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(store,'readwrite');
  tx.objectStore(store).put(val,key);
  tx.oncomplete=()=>{db.close();resolve(true)};
  tx.onerror=()=>{db.close();reject(tx.error)};
  tx.onabort=()=>{db.close();reject(tx.error)};
 });
}
async function deleteItem(store,key){
 const db=await openStore();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(key);
  tx.oncomplete=()=>{db.close();resolve(true)};
  tx.onerror=()=>{db.close();reject(tx.error)};
 });
}
async function deviceKey(create=false){
 let key=await getItem('keys',KEY_NAME);
 if(!key&&create){
  key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  await setItem('keys',KEY_NAME,key);
 }
 return key;
}
function validData(data){
 return data&&data.meta?.kind==='private-local'&&Array.isArray(data.series)&&data.series.length>0&&
 data.series.every(r=>r&&typeof r.date==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(r.date));
}
async function saveLastWorkbook(data){
 if(!validData(data))throw new Error('Không có dữ liệu hợp lệ để lưu');
 const sanitized={
  meta:data.meta,
  series:data.series,
  monthlyBooks:data.monthlyBooks||[],
  mapping:data.mapping||{},
  source_freshness:data.source_freshness||{},
  warnings:data.warnings||[]
 };
 const bytes=new TextEncoder().encode(JSON.stringify(sanitized));
 if(bytes.byteLength>CACHE_LIMIT)throw new Error('Dữ liệu quá lớn để lưu trên thiết bị');
 const key=await deviceKey(true),iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,bytes);
 await setItem('data',RECORD_NAME,{version:1,iv,cipher:new Uint8Array(cipher),savedAt:new Date().toISOString()});
 return {savedAt:new Date().toISOString(),days:sanitized.series.length};
}
async function loadLastWorkbook(){
 try{
  const record=await getItem('data',RECORD_NAME);
  if(!record||record.version!==1)return null;
  const key=await deviceKey(false);
  if(!key)return null;
  const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(record.iv)},key,new Uint8Array(record.cipher));
  const payload=JSON.parse(new TextDecoder().decode(raw));
  if(!validData(payload))return null;
  return {...payload,meta:{...payload.meta,kind:'private-local',restored:true},deviceSavedAt:record.savedAt};
 }catch(_){return null}
}
async function clearLastWorkbook(){return deleteItem('data',RECORD_NAME)}
export {saveLastWorkbook,loadLastWorkbook,clearLastWorkbook};
