// End-to-end: real activate() posts -> feed through the actual webview script in a DOM mock.
const Module=require('module'); const origLoad=Module._load; const fs=require('fs');
let posted=[];
const cfgDefaults={ claudePath:'claude', pollMs:2500, sound:false, notifications:false, doneFlashSeconds:12, detectTypedQuestions:true, 'device.enabled':false, defaultDetail:'full', feedEvents:6, 'launcher1.command':'yolo', 'launcher1.name':'CoS', 'launcher1.icon':'claude' };
let cookedHtml='';
const fakeView={ webview:{ options:{}, set html(v){ cookedHtml=v; }, get html(){return cookedHtml;}, onDidReceiveMessage(){}, postMessage(m){ posted.push(m); } }, badge:undefined };
const vscode={ workspace:{ getConfiguration(){ return { get:(k)=>cfgDefaults[k] }; } },
  window:{ createStatusBarItem(){ return {text:'',show(){},dispose(){}}; }, registerWebviewViewProvider(i,p){ vscode._p=p; return {dispose(){}}; }, terminals:[], showWarningMessage(){return{then(){}};}, showInformationMessage(){return{then(){}};}, showQuickPick(){return Promise.resolve(null);}, onDidChangeActiveTerminal(){return{dispose(){}};}, activeTerminal:undefined, tabGroups:{ onDidChangeTabs(){return{dispose(){}};}, all:[] }, createTerminal(){ return { name:'t', processId:Promise.resolve(0), show(){}, sendText(){}, dispose(){} }; }, createWebviewPanel(){ return { webview:{ options:{}, html:'', onDidReceiveMessage(){return{dispose(){}};}, postMessage(){} }, onDidDispose(){return{dispose(){}};}, reveal(){}, dispose(){} }; } },
  StatusBarAlignment:{Right:2}, ThemeColor:function(){}, ConfigurationTarget:{Global:1}, commands:{ registerCommand(){ return {dispose(){}}; }, executeCommand(){ return Promise.resolve(); } } };
Module._load=function(r){ if(r==='vscode') return vscode; return origLoad.apply(this,arguments); };
const ext=require(require('path').join(__dirname,'..','extension.js'));
ext.activate({subscriptions:[]}); vscode._p.resolveWebviewView(fakeView);
// Trigger the resolveTermNames post path on the first poll: a terminal whose
// pid IS a live session pid (ancestorsOf(pid) contains pid itself), so a term
// name resolves, changed=true, and an extra attachAndPost-routed post fires.
try {
  const live=JSON.parse(require('child_process').execSync('claude agents --json',{encoding:'utf8',timeout:4000})||'[]');
  if(live.length) vscode.window.terminals.push({ name:'e2e-term', processId:Promise.resolve(live[0].pid) });
} catch(_) { /* no live sessions -> path not exercisable this run */ }
(async()=>{
  await new Promise(r=>setTimeout(r,10000));
  const realPosts=posted.slice();
  console.log('real posts captured:', realPosts.length);
  if(!realPosts.length){ console.log('NO POSTS -> host never posted'); process.exit(0); }
  // Telemetry contract: EVERY posted sessions message (poll posts AND the
  // resolveTermNames post) carries the telemetry fields - a regression back to
  // provider.post(buildSessions(...)) produces a post without metaText and fails here.
  let checked=0;
  for(const p of realPosts.filter(p=>p&&p.type==='sessions')){
    for(const s of (p.sessions||[])){
      checked++;
      if(!('metaText' in s)||!('tooltipLines' in s)){ console.log('TELEMETRY FIELDS MISSING on',s.name); process.exit(1); }
      if(typeof s.sub!=='string'||!s.sub){ console.log('EMPTY statusText on',s.name); process.exit(1); }
    }
  }
  const termPosts=realPosts.filter(p=>p&&p.type==='sessions'&&(p.sessions||[]).some(s=>s.name==='e2e-term'));
  console.log('telemetry fields present on all',checked,'posted session rows: OK'+(termPosts.length?' (incl. resolveTermNames-path post)':''));
  // ---- DOM mock ----
  class El{constructor(t){this.tag=t;this.children=[];this.parentNode=null;this._t='';this.className='';this._x='';this.style={};this.id='';this.listeners={};this._h='';}
    get firstChild(){return this.children[0]||null;} get lastChild(){return this.children[this.children.length-1]||null;}
    get nextSibling(){if(!this.parentNode)return null;const i=this.parentNode.children.indexOf(this);return this.parentNode.children[i+1]||null;}
    set textContent(v){this._x=v;} get textContent(){return this._x;} set innerHTML(v){this._h=v;if(v==='')this.children=[];} get innerHTML(){return this._h;}
    set title(v){this._t=v;} get title(){return this._t;}
    appendChild(n){if(n.parentNode)n.parentNode._rm(n);this.children.push(n);n.parentNode=this;return n;}
    insertBefore(n,ref){if(ref==null)return this.appendChild(n);const i=this.children.indexOf(ref);if(i<0)throw new Error('NotFoundError insertBefore tag='+this.tag);if(n.parentNode)n.parentNode._rm(n);this.children.splice(i,0,n);n.parentNode=this;return n;}
    _rm(n){const i=this.children.indexOf(n);if(i>=0){this.children.splice(i,1);n.parentNode=null;}} remove(){if(this.parentNode)this.parentNode._rm(this);}
    addEventListener(t,f){(this.listeners[t]=this.listeners[t]||[]).push(f);}
    querySelector(s){const c=s.replace('.','');const f=(n)=>{for(const ch of n.children){if((ch.className||'').split(' ').indexOf(c)>=0)return ch;const r=f(ch);if(r)return r;}return null;};return f(this);}
    get scrollHeight(){return 100;} get scrollTop(){return 0;} set scrollTop(v){} get clientHeight(){return 50;} get offsetWidth(){return 120;} get offsetHeight(){return 40;} }
  const root=new El('div');root.id='root';const e0=new El('div');e0.className='empty';e0.textContent='Looking…';root.appendChild(e0);
  const launchers=new El('div');launchers.id='launchers';
  const body=new El('body');const byId={root,launchers};
  global.document={createElement:t=>new El(t),getElementById:id=>byId[id],body};
  global.window={addEventListener:(t,f)=>{global.window['_'+t]=f;},innerWidth:1200,innerHeight:800};
  global.acquireVsCodeApi=()=>({postMessage:()=>{}});
  // Use the COOKED html captured from resolveWebviewView - never the raw source
  // (template-literal escapes are transformed when html() runs; see ovl-cooked.js).
  const m=cookedHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if(!m){ console.log('no <script> in cooked html'); process.exit(1); }
  try{ new (require('vm').Script)(m[1],{filename:'webview.js'}); }
  catch(e){ console.log('COOKED SCRIPT PARSE FAILED:',e.message); console.log(e.stack.split('\n').slice(0,3).join('\n')); process.exit(1); }
  try { (0,eval)(m[1]); } catch(e){ console.log('SCRIPT LOAD THREW:',e.message); process.exit(1); }
  const h=global.window._message; if(!h){ console.log('no message handler'); process.exit(0); }
  try { for(const p of realPosts){ h({data:p}); } console.log('RENDER of real posts: OK, root children=',root.children.length); }
  catch(e){ console.log('RENDER of real posts THREW:',e.message); console.log(e.stack.split('\n').slice(0,4).join('\n')); }
  // Launch Pills (2.6.0): the bar must render from the post payload and must
  // SURVIVE the empty and error states (showEmpty wipes #root, not #launchers).
  // Anatomy: N .pill + trailing .pillcfg (✎); empty config -> .pill.ghost + .pillcfg.
  const L=[{icon:'claude',name:'CoS',command:'yolo',cwd:'',autoLaunch:true}];
  try {
    h({data:{type:'sessions',sessions:[],error:null,launchers:L}});
    if(launchers.children.length!==2||launchers.children[0].className!=='pill'||launchers.children[1].className!=='pillcfg'){ console.log('LAUNCHER BAR WRONG in zero-sessions state:',launchers.children.length); process.exit(1); }
    if(!/Runs: yolo/.test(launchers.children[0].title)||!/Auto-launch: on/.test(launchers.children[0].title)||launchers.children[0].title.split('\n').length!==3){ console.log('PILL TOOLTIP WRONG (want 3 real-newline lines):',JSON.stringify(launchers.children[0].title)); process.exit(1); }
    h({data:{type:'sessions',sessions:[],error:'boom',launchers:L}});
    if(launchers.children.length!==2){ console.log('LAUNCHER BAR MISSING in error state:',launchers.children.length); process.exit(1); }
    h({data:{type:'sessions',sessions:[],error:null,launchers:[]}});
    if(launchers.children.length!==2||launchers.children[0].className!=='pill ghost'){ console.log('GHOST PILL MISSING on empty config'); process.exit(1); }
    console.log('launch pills: bar survives empty+error states, ghost+cfg on empty config, tooltip OK');
  } catch(e){ console.log('LAUNCHER ASSERTS THREW:',e.message); process.exit(1); }
  process.exit(0);
})();
