// Independent GitHub Actions watchdog: recover only sources more than 10 minutes
// past their expected interval. Do not alter alert history or notify on one miss.
const base=(process.env.DVC_MONITOR_BASE_URL||"").replace(/\/$/,"");
const token=process.env.DVC_MONITOR_ADMIN_TOKEN;
if(!base||!token)throw Error("Monitor URL or admin token not configured");
const response=await fetch(base+"/health",{signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error("Health endpoint HTTP "+response.status);
const health=await response.json();
const expected={"dvc-shop":1,"davids":5,"rental-store-all":10,"dvc-rental-direct":5,"dvc-rental-dispatch":10,"rental-store-website-dispatch":5};
const modes={"dvc-shop":"dvc-shop","davids":"davids","rental-store-all":"rental-store","dvc-rental-direct":"dvc-rental-direct","dvc-rental-dispatch":"dvc-rental-dispatch","rental-store-website-dispatch":"website-backup-dispatch"};
const now=Date.now();
for(const source of health.health||[]){
  const interval=expected[source.source];if(!interval)continue;
  const last=Date.parse(source.lastSuccessAt||"");
  const delay=Number.isFinite(last)?(now-last)/60000-interval:Infinity;
  if(delay<10)continue;
  console.log("RECOVER",source.source,"overdue by",Math.round(delay),"minutes");
  try{
    const r=await fetch(base+"/run?mode="+encodeURIComponent(modes[source.source]),{method:"POST",headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(25000)});
    const body=await r.text();
    if(!r.ok)throw Error("HTTP "+r.status+": "+body.slice(0,200));
    console.log("RECOVERY RESPONSE",source.source,body.slice(0,300));
  }catch(error){console.error("RECOVERY FAILED",source.source,String(error));}
}
