// Drives the webview's renderUsage across the resilient-state metas (3.1.10):
// keep last-good rows on a transient error, correct notes, no exceptions.
class El {
  constructor(tag){ this.tag=tag; this.children=[]; this.parentNode=null; this._title=''; this.className=''; this._text=''; this.style={}; this.id=''; this.listeners={}; this._html=''; }
  get firstChild(){ return this.children[0]||null; }
  get lastChild(){ return this.children[this.children.length-1]||null; }
  set textContent(v){ this._text=v; } get textContent(){ return this._text; }
  set innerHTML(v){ this._html=v; if(v==='') this.children=[]; } get innerHTML(){ return this._html; }
  set title(v){ this._title=v; } get title(){ return this._title; }
  appendChild(n){ if(n.parentNode) n.parentNode._rm(n); this.children.push(n); n.parentNode=this; return n; }
  insertBefore(n, ref){ if(ref==null) return this.appendChild(n); const i=this.children.indexOf(ref); if(n.parentNode) n.parentNode._rm(n); this.children.splice(i,0,n); n.parentNode=this; return n; }
  _rm(n){ const i=this.children.indexOf(n); if(i>=0){ this.children.splice(i,1); n.parentNode=null; } }
  remove(){ if(this.parentNode) this.parentNode._rm(this); }
  addEventListener(t,f){ (this.listeners[t]=this.listeners[t]||[]).push(f); }
  querySelector(sel){ const cls=sel.replace('.',''); const find=(nd)=>{ for(const c of nd.children){ if((c.className||'').split(' ').indexOf(cls)>=0) return c; const r=find(c); if(r) return r; } return null; }; return find(this); }
  get scrollHeight(){return 100;} get scrollTop(){return 0;} set scrollTop(v){} get clientHeight(){return 50;}
}
const root=new El('div'); root.id='root';
const usageEl=new El('div'); usageEl.id='usage';
const body=new El('body');
const byId={root, usage:usageEl};
const document={ createElement:(t)=>new El(t), getElementById:(id)=>byId[id], body };
const window={ addEventListener:(t,f)=>{ window['_'+t]=f; }, innerWidth:1200, innerHeight:800 };
function acquireVsCodeApi(){ return { postMessage:()=>{} }; }

const { execFileSync }=require('child_process');
const path=require('path');
const extPath=process.argv[2]||path.join(__dirname,'..','extension.js');
const cooked=execFileSync(process.execPath,[__dirname+'/ovl-cooked.js',extPath],{encoding:'utf8',maxBuffer:16*1024*1024});
const m=cooked.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if(!m){ console.log('no <script> found in cooked html'); process.exit(1); }
eval(m[1]);
const handler=window._message;
if(!handler){ console.log('no message handler'); process.exit(1); }
function post(usage,enabled,dismissed,meta){ handler({data:{type:'usage',usage,enabled,dismissed,meta}}); }

// collect all descendant .unote texts + count of .urow bars
function notes(){ const out=[]; const walk=(nd)=>{ for(const c of nd.children){ if((c.className||'').indexOf('unote')>=0) out.push(c.textContent); walk(c);} }; walk(usageEl); return out; }
function rows(){ let n=0; const walk=(nd)=>{ for(const c of nd.children){ if((c.className||'')==='urow') n++; walk(c);} }; walk(usageEl); return n; }
function has(txt){ return notes().some(t=>t.indexOf(txt)>=0); }

const good={ plan:'Max · 20x', rows:[
  {label:'Session (5h)', percent:42, severity:'ok', resetText:'resets in 2h'},
  {label:'Weekly (all)', percent:71, severity:'warning', resetText:'resets Mon'},
  {label:'Fable', percent:12, severity:'ok', resetText:''},
] };
const now=Date.now();
let fail=0; function ok(c,m){ if(!c){ console.log('FAIL:',m); fail++; } }

// 1. loading: enabled, no data yet
post(null,true,false,{state:'loading',fetchedAt:0,nextAt:0});
ok(has('Loading'), '1 loading note'); ok(rows()===0,'1 no rows');

// 2. ok: rows + "updated just now"
post(good,true,false,{state:'ok',fetchedAt:now,nextAt:now+60000});
ok(rows()===3,'2 three rows'); ok(has('updated'),'2 updated note');

// 3. checking: keeps rows, shows checking…
post(good,true,false,{state:'checking',fetchedAt:now,nextAt:now+60000});
ok(rows()===3,'3 rows kept during checking'); ok(has('checking'),'3 checking note');

// 4. ratelimited WITH last-good: rows kept, "rate-limited, retrying in Nm"
post(good,true,false,{state:'ratelimited',fetchedAt:now-300000,nextAt:now+600000});
ok(rows()===3,'4 last-good rows kept on 429'); ok(has('rate-limited, retrying'),'4 retrying note');

// 5. ratelimited with NO prior data: message, no rows
post(null,true,false,{state:'ratelimited',fetchedAt:0,nextAt:now+120000});
ok(rows()===0,'5 no rows'); ok(has('Rate-limited by the usage API'),'5 cold-429 message');

// 6. login expired with last-good: rows kept + note
post(good,true,false,{state:'login',fetchedAt:now-600000,nextAt:now+60000});
ok(rows()===3,'6 rows kept on 401'); ok(has('login expired'),'6 login note');

// 7. nologin: message, no rows
post(null,true,false,{state:'nologin',fetchedAt:0,nextAt:0});
ok(rows()===0,'7 no rows'); ok(has('No Claude login found'),'7 nologin message');

// 8. disabled + not dismissed: invite card (no usage rows, no crash)
post(null,false,false,{state:'idle'});
ok(rows()===0,'8 no rows when disabled');

// 9. disabled + dismissed: nothing
post(null,false,true,{state:'idle'});
ok(usageEl.children.length===0,'9 empty when dismissed');

if(fail){ console.log('\n'+fail+' FAILED'); process.exit(1); }
console.log('\nusage-render tests PASS (9 states)');
