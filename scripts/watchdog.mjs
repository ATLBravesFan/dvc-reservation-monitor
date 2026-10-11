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
const expected={"dvc-shop":1,"davids":5,"rental-store-all":10,"dvc-rental-direct":5,"dvc-rental-dispatch":10,"rental-store-website-dispatch":5};
const modes={"dvc-shop":"dvc-shop","davids":"davids","rental-store-all":"rental-store","dvc-rental-direct":"dvc-rental-direct","dvc-rental-dispatch":"dvc-rental-dispatch","rental-store-website-dispatch":"website-backup-dispatch"};
const jobs=[];
for(const source of initial.health||[]){
  const interval=expected[source.source];if(!interval)continue;
  const last=Date.parse(source.lastSuccessAt||"");
  const delay=Number.isFinite(last)?(Date.now()-last)/60000-interval:Infinity;
  if(delay>=10)jobs.push({source:source.source,mode:modes[source.source],before:last});
}
console.log("Sources requiring recovery:",jobs.map(j=>j.source).join(", ")||"none");
const failed=[];
for(const job of jobs){
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
    const after=await health();
    const entry=(after.health||[]).find(x=>x.source===job.source);
    const updated=Date.parse(entry?.lastSuccessAt||"");
    if(!Number.isFinite(updated)||updated<=job.before)throw Error("Source health did not advance after recovery");
    console.log("RECOVERED",job.source,entry.lastSuccessAt);
  }catch(e){console.error("FAILED",job.source,String(e));failed.push(job.source);}
}
if(failed.length)throw Error("Recovery failed for: "+failed.join(", "));
