import { recoveryJobs, recoveredRecently } from "./watchdog-policy.mjs";
// Independent recovery runner. Only consider checks overdue by 10+ minutes.
// Verify health AFTER the recovery, not merely HTTP status.
const base=(process.env.DVC_MONITOR_BASE_URL||"").replace(/\/$/,"");
const token=process.env.DVC_MONITOR_ADMIN_TOKEN;
if(!base||!token)throw Error("Monitor URL or admin token not configured");
const timeout=(ms)=>AbortSignal.timeout(ms);
async function health(){
  const r=await fetch(base+"/health",{signal:timeout(15000)});
  if(!r.ok)throw Error("Health endpoint HTTP "+r.status);
  return r.json();
}
const initial=await health();
const jobs=recoveryJobs(initial.health);
console.log("Sources requiring recovery:",jobs.map(j=>j.source).join(", ")||"none");
const failed=[];
const results=[];
await Promise.all(jobs.map(async job=>{
  try{
    const r=await fetch(base+"/run?mode="+encodeURIComponent(job.mode),{method:"POST",headers:{Authorization:"Bearer "+token},signal:timeout(45000)});
    const body=await r.text();
    if(!r.ok)throw Error("HTTP "+r.status+": "+body.slice(0,300));
    const result=JSON.parse(body);
    function failedResult(value){
      if(!value||typeof value!=="object")return false;
      if(value.ok===false)return true;
      return Object.values(value).some(v=>v&&typeof v==="object"&&failedResult(v));
    }
    if(failedResult(result))throw Error("Recovery returned failure: "+body.slice(0,500));
    function skippedResult(value){
      if(!value||typeof value!=="object")return false;
      if(value.skipped===true)return true;
      return Object.values(value).some(v=>v&&typeof v==="object"&&skippedResult(v));
    }
    if(skippedResult(result))console.log("ALREADY RUNNING",job.source,"A lease prevented duplicate execution; waiting for its outcome.");
    // A successful /run response may queue a browser workflow rather than finish it.
    // Do not declare immediate failure before the async job has had time to report.
    let entry, updated;
    let latest;
    for(let attempt=0;attempt<6;attempt++){
      const after=await health();
      entry=(after.health||[]).find(x=>x.source===job.source);
      latest=entry;
      updated=Date.parse(entry?.lastSuccessAt||"");
      if(recoveredRecently(job.source,job.before,updated))break;
      if(attempt<5)await new Promise(resolve=>setTimeout(resolve,10000));
    }
    if(!recoveredRecently(job.source,job.before,updated))throw Error("Source still unhealthy after recovery: "+JSON.stringify({source:job.source,lastCheckedAt:latest?.lastCheckedAt,lastSuccessAt:latest?.lastSuccessAt,consecutiveFailures:latest?.consecutiveFailures,lastError:latest?.lastError,runResult:result}).slice(0,1100));
    console.log("RECOVERED",job.source,entry.lastSuccessAt);
    results.push(job.source);
  }catch(e){console.error("FAILED",job.source,String(e));failed.push(job.source);}
}));
console.log("Recovered:",results.join(", ")||"none");
if(failed.length)throw Error("Recovery failed for: "+failed.join(", "));
