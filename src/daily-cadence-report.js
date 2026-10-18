// Read-only per-source cadence report for the previous complete New York calendar day.
// This endpoint intentionally does not expose reservation inventory or credentials.
const WATCHES = [
  ["rental-store-api",1,"Rental Store API (bargain checks)"],
  ["rental-store-all",10,"Rental Store all listings"],
  ["rental-store-website",5,"Rental Store website ingestion"],
  ["rental-store-website-dispatch",5,"Rental Store website dispatcher"],
  ["davids",5,"David's"],
  ["dvc-shop",5,"DVC Shop"],
  ["dvc-rental",5,"DVC-Rental ingestion (combined)"],
  ["dvc-rental-browser-dispatch",10,"DVC-Rental browser dispatcher"],
  ["dvcreservations-rare-finds",15,"Rare Finds"],
  ["alert-outbox-drain",1,"Alert outbox"],
  ["cloudflare-source-recovery",5,"Cloudflare source recovery"],
];
const NY="America/New_York";
function dateParts(date) {
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:NY,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day;
}
function utcBoundary(day) {
  const [y,m,d]=day.split("-").map(Number);
  const utcNoon=new Date(Date.UTC(y,m-1,d,16));
  const zone=new Intl.DateTimeFormat("en-US",{timeZone:NY,timeZoneName:"shortOffset"}).formatToParts(utcNoon).find(x=>x.type==="timeZoneName")?.value||"GMT-4";
  const offset=zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if(!offset) throw new Error("Cannot resolve New York UTC offset");
  const minutes=(offset[1]==="+"?1:-1)*(Number(offset[2])*60+Number(offset[3]||0));
  return new Date(Date.UTC(y,m-1,d)-minutes*60000);
}
export async function dailyCadenceReport(db, requestedDay=null, now=new Date()) {
  const today=dateParts(now);
  const day=requestedDay||dateParts(new Date(Date.UTC(...today.split("-").map((v,i)=>i===1?Number(v)-1:Number(v)))-86400000));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||dateParts(utcBoundary(day))!==day||day>=today) throw new Error("day must be a valid completed America/New_York date (YYYY-MM-DD)");
  const start=utcBoundary(day),end=utcBoundary(dateParts(new Date(Date.UTC(Number(day.slice(0,4)),Number(day.slice(5,7))-1,Number(day.slice(8,10)))+86400000)));
  const result=await db.prepare("SELECT source,started_at FROM execution_history WHERE outcome='success' AND started_at>=? AND started_at<? ORDER BY source,started_at").bind(start.toISOString(),end.toISOString()).all();
  const bySource=new Map();
  for(const row of result.results||[]) {
    if(!bySource.has(row.source))bySource.set(row.source,[]);
    bySource.get(row.source).push(Date.parse(row.started_at));
  }
  const watches=WATCHES.map(([source,configuredMinutes,label])=>{
    const times=bySource.get(source)||[];
    const gaps=times.slice(1).map((t,i)=>(t-times[i])/60000).filter(Number.isFinite);
    const averageMinutes=gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:null;
    const longestGapMinutes=gaps.length?Math.max(...gaps):null;
    const lateGaps=gaps.filter(g=>g>=configuredMinutes+10).length;
    return {source,label,configuredMinutes,successfulRuns:times.length,averageMinutes:averageMinutes===null?null:Number(averageMinutes.toFixed(2)),longestGapMinutes:longestGapMinutes===null?null:Number(longestGapMinutes.toFixed(2)),gapsAtLeast10MinutesLate:lateGaps,status:times.length<2?"insufficient-data":(averageMinutes>=configuredMinutes+10||lateGaps>=2?"behind":"within-threshold"),nextAction:times.length<2?"Check source health and ingestion history; cannot calculate intervals with fewer than two successful runs":averageMinutes>=configuredMinutes+10||lateGaps>=2?"Inspect dispatch schedules, failed/skipped runs and execution leases":"None indicated by successful-run cadence"};
  });
  return {day,timeZone:NY,windowStart:start.toISOString(),windowEndExclusive:end.toISOString(),measurement:"elapsed minutes between consecutive successful execution start times",limitations:["This measures successful execution cadence, not reservation publication-to-email latency.","Browser ingestion and dispatcher are different processes; a successful dispatch does not prove ingestion.","Missing history and zero successes are not equivalent; empty results need D1 retention/access verification.","Single unusually long gap is shown but only recurring gaps or a slow average trigger the behind flag."],watches};
}
