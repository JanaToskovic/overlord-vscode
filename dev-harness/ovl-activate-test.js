// Stub the vscode module and run the REAL extension activate()->refresh() against live sessions.
const Module=require('module'); const origLoad=Module._load;
let posted=[];
const cfgDefaults={ claudePath:'claude', pollMs:2500, sound:false, notifications:false, doneFlashSeconds:12, detectTypedQuestions:true, 'device.enabled':false, defaultDetail:'full', feedEvents:6 };
const fakeView={ webview:{ options:{}, set html(v){}, get html(){return '';}, onDidReceiveMessage(){}, postMessage(m){ posted.push(m); } }, badge:undefined };
const vscode={
  workspace:{ getConfiguration(){ return { get:(k)=> cfgDefaults[k] }; } },
  window:{
    createStatusBarItem(){ return { text:'',tooltip:'',backgroundColor:undefined,command:'',show(){},dispose(){} }; },
    registerWebviewViewProvider(id,prov){ vscode._provider=prov; return { dispose(){} }; },
    onDidChangeActiveTerminal(){ return { dispose(){} }; }, activeTerminal:undefined,
    tabGroups:{ onDidChangeTabs(){ return { dispose(){} }; }, all:[] },
    createTerminal(){ return { name:'t', processId:Promise.resolve(0), show(){}, sendText(){}, dispose(){} }; },
    createWebviewPanel(){ return { webview:{ options:{}, html:'', onDidReceiveMessage(){ return { dispose(){} }; }, postMessage(){} }, onDidDispose(){ return { dispose(){} }; }, reveal(){}, dispose(){} }; },
    terminals:[], showWarningMessage(){ return {then(){}}; }, showInformationMessage(){ return {then(){}}; }, showQuickPick(){ return Promise.resolve(null); },
  },
  TerminalLocation:{ Panel:1, Editor:2 }, ViewColumn:{ Active:-1 },
  Uri:{ file:(p)=>({ fsPath:p, toString:()=>'file://'+p }) },
  StatusBarAlignment:{ Right:2 }, ThemeColor:function(){}, ConfigurationTarget:{ Global:1 },
  commands:{ registerCommand(){ return { dispose(){} }; }, executeCommand(){ return Promise.resolve(); } },
};
Module._load=function(request){ if(request==='vscode') return vscode; return origLoad.apply(this, arguments); };

const ext=require(require('path').join(__dirname,'..','extension.js'));
const ctx={ subscriptions:[] };
(async()=>{
  try { ext.activate(ctx); } catch(e){ console.log('ACTIVATE THREW:', e.message); console.log(e.stack.split('\n').slice(0,5).join('\n')); return; }
  // resolveWebviewView sets _view and schedules refresh(40ms)
  try { vscode._provider.resolveWebviewView(fakeView); } catch(e){ console.log('resolveWebviewView THREW:', e.message); }
  // wait for the scheduled refresh + async work
  await new Promise(r=>setTimeout(r, 10000));
  console.log('posts captured:', posted.length);
  for(const p of posted){
    if(p.error){ console.log('  POST error:', p.error); }
    else { console.log('  POST sessions:', (p.sessions||[]).length, (p.sessions||[]).map(s=>s.name+':'+s.state+':L'+s.level+':feed'+(s.feed?s.feed.length:0)).join(', ')); }
  }
  if(posted.length===0) console.log('  >>> NO POSTS — this is the stuck symptom. refresh never posted.');
  process.exit(0);
})();
