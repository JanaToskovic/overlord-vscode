// Proves globalState-backed persistence for the usage on/off state + level toggles,
// even when the settings.json write-back is a no-op (the real-world failure we hit).
const Module=require('module'); const origLoad=Module._load;
const path=require('path');
const extPath=path.join(__dirname,'..','extension.js');
const agentsPath=path.join(__dirname,'..','agents.js');

// mutable shared state so each run gets a fresh memento + config
const S={ memento:null, configUsage:false, posted:[], msgHandler:null };
function makeMemento(seed){ const m=new Map(Object.entries(seed||{})); return { get:(k,d)=> m.has(k)?m.get(k):d, update:(k,v)=>{ m.set(k,v); return Promise.resolve(); }, _map:m }; }

const fakeView={ webview:{ options:{}, set html(v){}, get html(){return '';},
  onDidReceiveMessage(cb){ S.msgHandler=cb; return { dispose(){} }; },
  postMessage(m){ S.posted.push(m); } }, badge:undefined };

const cfgDefaults={ claudePath:'claude', pollMs:2500, sound:false, doneFlashSeconds:12, detectTypedQuestions:true, 'device.enabled':false, defaultDetail:'remember', feedEvents:6, newSessionCommand:'claude' };
const vscode={
  workspace:{
    getConfiguration(){ return { get:(k)=> k==='usage'? S.configUsage : cfgDefaults[k], update:async()=>{ /* simulate FAILING settings write: no-op */ } }; },
    onDidChangeConfiguration(){ return { dispose(){} }; },
  },
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

let fail=0; function ok(c,m){ if(!c){ console.log('FAIL:',m); fail++; } }

// fresh module load + activate with a seeded memento; returns the usage post's `enabled`
function boot(seed, configUsage){
  delete require.cache[extPath]; delete require.cache[agentsPath];
  S.memento=makeMemento(seed); S.configUsage=!!configUsage; S.posted=[]; S.msgHandler=null;
  const ext=require(extPath);
  ext.activate({ subscriptions:[], globalState:S.memento });
  vscode._provider.resolveWebviewView(fakeView);
  vscode._provider.postUsage();                 // force a usage post to read `enabled`
  const u=[...S.posted].reverse().find(p=>p.type==='usage');
  return { enabled: u? u.enabled : undefined, dismissed: u? u.dismissed : undefined, ext };
}

// 1. nothing persisted, config off -> card OFF
ok(boot({}, false).enabled===false, '1 fresh+configOff -> off');

// 2. config on (manual Settings) -> card ON
ok(boot({}, true).enabled===true, '2 configOn -> on');

// 3. migration: user had enabled before (usageEverEnabled) but no usageOn + config off -> ON, invite suppressed
{ const r=boot({'overlord.usageEverEnabled':true}, false);
  ok(r.enabled===true, '3 everEnabled migrates to ON'); ok(r.dismissed===true, '3 invite suppressed'); }

// 4. explicit disable persisted -> stays OFF even if everEnabled
ok(boot({'overlord.usageOn':false,'overlord.usageEverEnabled':true}, false).enabled===false, '4 explicit off wins');

// 5. persisted ON with failing settings write -> ON
ok(boot({'overlord.usageOn':true}, false).enabled===true, '5 persisted usageOn survives');

// 6. clicking Enable persists usageOn+everEnabled to globalState (not settings)
{ const r=boot({}, false);
  S.msgHandler({ type:'usageEnable' });
  ok(S.memento._map.get('overlord.usageOn')===true, '6 enable persists usageOn to globalState');
  ok(S.memento._map.get('overlord.usageEverEnabled')===true, '6 enable persists everEnabled');
}

// 7. clicking the ✕ (disable) persists usageOn=false
{ const r=boot({'overlord.usageOn':true}, false);
  S.msgHandler({ type:'usageDisable' });
  ok(S.memento._map.get('overlord.usageOn')===false, '7 disable persists usageOn=false');
}

// 8. cycleLevel persists overlord.levels (remember is now default)
{ const r=boot({}, false);
  S.msgHandler({ type:'cycleLevel', sid:'sess-A' });
  const lv=S.memento._map.get('overlord.levels');
  ok(lv && typeof lv==='object' && ('sess-A' in lv), '8 cycleLevel persists a level for the sid');
}

if(fail){ console.log('\n'+fail+' FAILED'); process.exit(1); }
console.log('\npersistence tests PASS (8 scenarios)');
process.exit(0);   // activate() leaves poll timers running; exit explicitly
