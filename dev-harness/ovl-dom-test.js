// Minimal DOM mock to run Overlord's webview script and catch runtime errors.
class El {
  constructor(tag){ this.tag=tag; this.children=[]; this.parentNode=null; this._title=''; this.className=''; this._text=''; this.style={}; this.id=''; this.listeners={}; this._html=''; }
  get firstChild(){ return this.children[0]||null; }
  get lastChild(){ return this.children[this.children.length-1]||null; }
  get nextSibling(){ if(!this.parentNode) return null; const i=this.parentNode.children.indexOf(this); return this.parentNode.children[i+1]||null; }
  set textContent(v){ this._text=v; } get textContent(){ return this._text; }
  set innerHTML(v){ this._html=v; if(v==='') this.children=[]; } get innerHTML(){ return this._html; }
  set title(v){ this._title=v; } get title(){ return this._title; }
  appendChild(n){ if(n.parentNode) n.parentNode._rm(n); this.children.push(n); n.parentNode=this; return n; }
  insertBefore(n, ref){ if(ref==null) return this.appendChild(n); const i=this.children.indexOf(ref); if(i<0) throw new Error('InsertBefore NotFoundError: ref is not a child of this node (tag='+this.tag+')'); if(n.parentNode) n.parentNode._rm(n); this.children.splice(i,0,n); n.parentNode=this; return n; }
  _rm(n){ const i=this.children.indexOf(n); if(i>=0){ this.children.splice(i,1); n.parentNode=null; } }
  remove(){ if(this.parentNode) this.parentNode._rm(this); }
  addEventListener(t,f){ (this.listeners[t]=this.listeners[t]||[]).push(f); }
  querySelector(sel){ const cls=sel.replace('.',''); const find=(nd)=>{ for(const c of nd.children){ if((c.className||'').split(' ').indexOf(cls)>=0) return c; const r=find(c); if(r) return r; } return null; }; return find(this); }
  get scrollHeight(){return 100;} get scrollTop(){return 0;} set scrollTop(v){} get clientHeight(){return 50;}
  get offsetWidth(){return 120;} get offsetHeight(){return 40;}
}
const root=new El('div'); root.id='root';
const empty=new El('div'); empty.className='empty'; empty.textContent='Looking for Claude Code sessions…'; root.appendChild(empty);
const body=new El('body');
const byId={root};
const document={ createElement:(t)=>new El(t), getElementById:(id)=>byId[id], body };
const window={ addEventListener:(t,f)=>{ window['_'+t]=f; }, innerWidth:1200, innerHeight:800 };
function acquireVsCodeApi(){ return { postMessage:()=>{} }; }

// load the webview script from the COOKED html() output (never the raw source -
// template-literal escapes like \n are transformed when html() runs; see ovl-cooked.js)
const { execFileSync }=require('child_process');
const extPath=process.argv[2]||require('path').join(__dirname,'..','extension.js');
const cooked=execFileSync(process.execPath,[__dirname+'/ovl-cooked.js',extPath],{encoding:'utf8',maxBuffer:16*1024*1024});
const m=cooked.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if(!m){ console.log('no <script> found in cooked html'); process.exit(1); }
try{ new (require('vm').Script)(m[1],{filename:'webview.js'}); }
catch(e){ console.log('COOKED SCRIPT PARSE FAILED:',e.message); console.log(e.stack.split('\n').slice(0,3).join('\n')); process.exit(1); }
eval(m[1]);

// sample sessions
function ev(id,kind,icon,text,full,ok){ return {id,kind,icon,text,full,ok}; }
const s1={ sid:'a', color:'#f5b14c', name:'Api', sub:'working 4m · fable-5 · ⑂2', state:'working', level:1,
  metaText:'ctx 62% · up 3h12m', tooltipLines:['model: claude-fable-5','context: 124k/200k tokens'],
  feed:[ ev('t1#0','tool','🤖','Task: Billing sync','Task: Billing sync + PRICE catalog scan'), ev('t2#0','text','💬','Stopping','**Done** — line one\n\n\nNext `code` line'), ev('t3#0','thinking','💭','thinking…','thinking…') ] };
const s2={ sid:'b', color:'#858585', name:'Overlord', sub:'idle', state:'idle', level:1,
  metaText:null, tooltipLines:[],
  feed:[ ev('u1#0','text','💬','Installed','Installed jana.overlord'), ev('u2#0','tool','🔧','Bash: ls /tmp','Bash: ls /tmp/example/...') ] };

const handler=window._message;
if(!handler){ console.log('no message handler registered'); process.exit(1); }
function post(sessions,error){ handler({data:{type:'sessions',sessions,error:error||null}}); }

function findRow(name){ for(const c of root.children){ const nm=c.querySelector&&c.querySelector('.nm'); if(nm&&nm.textContent===name) return c; } return null; }
try {
  console.log('render 1 (2 sessions)...'); post([s1,s2]);
  // telemetry render assertions
  const row1=findRow('Api');
  if(row1.querySelector('.st').textContent!=='working 4m · fable-5 · ⑂2') throw new Error('statusText not rendered');
  if(row1.querySelector('.mt').textContent!=='ctx 62% · up 3h12m') throw new Error('metaText not rendered');
  if(row1.querySelector('.mt').style.display==='none') throw new Error('meta strip hidden despite metaText');
  if(row1.title.indexOf('model: claude-fable-5')<0) throw new Error('tooltip lines missing');
  if(row1.title.indexOf('Done — line one\n   \n   Next code line')<0) throw new Error('tooltip event formatting wrong: '+JSON.stringify(row1.title.slice(0,200)));
  if(row1.title.indexOf('**')>=0) throw new Error('markdown noise not stripped from tooltip');
  const row2=findRow('Overlord');
  if(row2.querySelector('.mt').style.display!=='none') throw new Error('meta strip should be hidden when metaText null');
  console.log('telemetry render assertions OK');
  // Zone affordances: Jump link back at feed bottom, eye carries its own action title
  const fb1=row1.nextSibling;
  if(!fb1.children.find(c=>c.textContent==='Jump ↗')) throw new Error('Jump link missing from feed box');
  const eyeEl=row1.children.find(c=>c.className==='eye');
  if(!eyeEl||eyeEl.title!=='Jump to terminal ↗') throw new Error('eye jump title missing');
  console.log('zone affordance assertions OK');
  console.log('render 2 (same)...'); post([s1,s2]);
  console.log('render 3 (reordered: s2,s1)...'); post([s2,s1]);
  console.log('render 4 (s1 feed grew)...'); post([Object.assign({},s1,{feed:s1.feed.concat([ev('t4#0','tool','🔧','Bash: x','Bash: xyz')])}),s2]);
  console.log('render 5 (s2 removed)...'); post([s1]);
  console.log('render 6 (empty)...'); post([]);
  console.log('render 7 (error)...'); post(null,'boom error');
  console.log('render 8 (back to sessions)...'); post([s1,s2]);
  console.log('render 9 (dense mode keeps meta strip)...'); post([Object.assign({},s1,{level:0}),s2]);
  const denseRow=findRow('Api');
  if(denseRow.querySelector('.mt').style.display==='none') throw new Error('meta strip must stay visible in dense mode');
  console.log('dense-mode meta strip OK');
  console.log('ALL RENDERS OK');
} catch(e){ console.log('THREW:', e.message); console.log(e.stack.split('\n').slice(0,4).join('\n')); }
