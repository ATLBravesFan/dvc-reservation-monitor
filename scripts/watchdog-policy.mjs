export const EXPECTED_RECOVERY_MINUTES={"dvc-shop":3,"davids":8,"rental-store-all":12,"rental-store-website-dispatch":8};
export const RECOVERY_MODES={"dvc-shop":"dvc-shop","davids":"davids","rental-store-all":"rental-store-all","rental-store-website-dispatch":"website-backup-dispatch"};
export function recoveryJobs(health,now=Date.now()){
 return Object.entries(EXPECTED_RECOVERY_MINUTES).flatMap(([name,interval])=>{
  const entry=(health||[]).find(x=>x.source===name);
  const last=Date.parse(entry?.lastSuccessAt||"");
  const delay=Number.isFinite(last)?(now-last)/60000-interval:Infinity;
  return delay>=10?[{source:name,mode:RECOVERY_MODES[name],before:Number.isFinite(last)?last:0}]:[];
 });
}
export function recoveredRecently(source,before,updated,now=Date.now()){
 return Number.isFinite(updated)&&updated>before&&(now-updated)/60000<=EXPECTED_RECOVERY_MINUTES[source]+10;
}
