// Replicate the host-side data path (readTailLines + recentEvents) against REAL sessions.
const fs=require('fs'), fsp=fs.promises, path=require('path'), os=require('os'), cp=require('child_process');
const A=require(require('path').join(__dirname,'..','agents.js'));
const READ_STEPS=[64*1024,256*1024,1024*1024];
const _tPath=new Map();
function transcriptPath(sid){
  if(_tPath.has(sid)) return _tPath.get(sid);
  let found=null;
  try{ const base=path.join(os.homedir(),'.claude','projects');
    for(const d of fs.readdirSync(base)){ const p=path.join(base,d,sid+'.jsonl'); if(fs.existsSync(p)){ found=p; break; } }
  }catch(_){}
  if(found)_tPath.set(sid,found); return found;
}
async function readTailLines(sid){
  const p=transcriptPath(sid); if(!p) return null;
  let stat; try{ stat=await fsp.stat(p);}catch(_){return null;}
  let lines=[], fh;
  try{ fh=await fsp.open(p,'r');
    for(const step of READ_STEPS){ const len=Math.min(step,stat.size); const start=stat.size-len; const buf=Buffer.alloc(len); await fh.read(buf,0,len,start); lines=A.splitTail(buf.toString('utf8'),start>0); if(start===0||lines.length>=24) break; }
  }catch(e){ throw new Error('readTailLines threw for '+sid+': '+e.message); }
  finally{ if(fh){ try{await fh.close();}catch(_){}}}
  if(lines.length===0&&stat.size>0) lines=['__overlord_oversized_line__'];
  return lines;
}
(async()=>{
  let out; try{ out=cp.execSync('claude agents --json',{encoding:'utf8',maxBuffer:8*1024*1024}); }catch(e){ console.log('claude agents failed:',e.message); process.exit(0); }
  const agents=A.parseAgents(out);
  console.log('sessions:',agents.length);
  const cap=6;
  for(const a of agents){
    try{
      const lines=await readTailLines(a.sessionId);
      if(!lines){ console.log(' ',a.sessionId.slice(0,8),a.status,'-> no transcript'); continue; }
      const q=A.endsWithQuestion(A.lastAssistantTextFromLines(lines));
      const events=A.recentEvents(lines,cap);
      // simulate the render detail build too
      const detail=events.map(ev=>ev.icon+' '+String(ev.full||ev.text).replace(/\s+/g,' ').trim().slice(0,199)).join('\n');
      console.log(' ',a.sessionId.slice(0,8),a.status,'lines='+lines.length,'events='+events.length,'q='+q,'detailLen='+detail.length);
    }catch(e){ console.log('  THREW for',a.sessionId.slice(0,8),':',e.message); console.log(e.stack.split('\n').slice(0,3).join('\n')); }
  }
  console.log('HOST PATH DONE');
})();
