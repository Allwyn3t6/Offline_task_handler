const fs=require('fs'); const vm=require('vm');
const sheets={}; const mails=[], events=[];
function mkSheet(name){const data=[];return {name,data,getName:()=>name,
 getRange:(r,c,nr=1,nc=1)=>{const R={setNumberFormat(){return this},setFontWeight(){return this},
   getValues:()=>{const o=[];for(let i=0;i<nr;i++){o.push([]);for(let j=0;j<nc;j++)o[i].push((data[r-1+i]||[])[c-1+j]??'')}return o},
   setValues:v=>{v.forEach((row,i)=>{data[r-1+i]=data[r-1+i]||[];row.forEach((x,j)=>data[r-1+i][c-1+j]=x)});return R}};return R},
 getMaxRows:()=>1000,setFrozenRows(){},appendRow:r=>data.push(r),
 getDataRange:()=>({getValues:()=>data.map(r=>r.slice())})}}
const ctx={Logger:{log:console.log},
 SpreadsheetApp:{getActive:()=>({getSheetByName:n=>sheets[n],insertSheet:n=>sheets[n]=mkSheet(n),getUrl:()=>'url'}),flush(){}},
 PropertiesService:{getScriptProperties:()=>({_p:ctx._p,getProperty:k=>ctx._p[k],setProperty:(k,v)=>ctx._p[k]=v})},
 _p:{}, ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({everyMinutes:()=>({create(){}})})})},
 LockService:{getScriptLock:()=>({waitLock(){},tryLock:()=>true,releaseLock(){}})},
 Utilities:{getUuid:()=>'uuid-'+Math.random(),formatDate:(d)=>d.toISOString()},Session:{getScriptTimeZone:()=>'UTC'},
 ContentService:{createTextOutput:s=>({setMimeType(){return s}}),MimeType:{JSON:1}},
 MailApp:{sendEmail:m=>mails.push(m)},
 CalendarApp:{getDefaultCalendar:()=>({createEvent:(t,a,b,o)=>{events.push({t,a,o});return {addPopupReminder(){},removeAllReminders(){}}},createAllDayEvent:(t,a,o)=>{events.push({t,a,o});return {addPopupReminder(){}}}})},
 UrlFetchApp:{}};
vm.createContext(ctx); vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),ctx);

ctx.setup(); ctx._p.TOKEN='T';
const http=require('http'); const cache={};
http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{
 const u=new URL(q.url,'http://x');
 if(q.method==='POST'){const id=Math.random();cache[id]=ctx.doPost({postData:{contents:b}});r.writeHead(302,{Location:'/echo?id='+id});return r.end();}
 if(u.pathname==='/echo'){r.end(cache[u.searchParams.get('id')]);return;}
 if(u.pathname==='/stats'){r.end(JSON.stringify({mails:mails.length,events:events.length,rows:sheets.Entries.data.length}));return;}
 r.end(ctx.doGet({parameter:Object.fromEntries(u.searchParams)}));});}).listen(8799);
