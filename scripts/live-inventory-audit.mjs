// Read-only live inventory audit. No D1 writes, ingestion or notifications.
import {URLS} from "../src/config.js";
import {parseDavids,parseDvcShop} from "../src/parsers.js";
import {parseDvcRentalDealsHtml} from "../src/dvc-rental-direct.js";
const base=(process.env.DVC_MONITOR_BASE_URL||"https://dvc-reservation-monitor.travisdasher04.workers.dev").replace(/\/$/,"");
async function get(url){
 const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{"User-Agent":"DVC-Inventory-Audit/1.0"}});
 if(!response.ok)throw Error(`HTTP ${response.status} from ${url}`);
 return response.text();
}
const targets=[
 ["dvc-shop",URLS.dvcShop,parseDvcShop],
 ["davids",URLS.davids,parseDavids],
 ["dvc-rental","https://dvc-rental.com/deals",parseDvcRentalDealsHtml]
];
let health;
try{health=JSON.parse(await get(base+"/health"));console.log("Worker health:",health.ok,"checkedAt:",health.checkedAt);}
catch(error){console.warn("Worker health unavailable:",String(error));process.exitCode=1;}
for(const [source,url,parse] of targets){
 try{
  const html=await get(url);
  const rows=parse(html);
  const ids=new Set(rows.map(row=>String(row.id)));
  const invalid=rows.filter(row=>!row.id||!row.checkIn||!row.checkOut||!Number.isFinite(row.total));
  const record=health?.health?.find(x=>x.source===source);
  const reported=record?.details;
  const published=source==="dvc-rental"?Number(html.match(/(\d+)\s+confirmed reservations/i)?.[1]):null;
  console.log(JSON.stringify({source,liveParsed:rows.length,uniqueIds:ids.size,publishedCount:published||null,invalidRows:invalid.length,workerLastSuccess:record?.lastSuccessAt||null,workerDetails:reported||null,exampleIds:rows.slice(0,5).map(x=>x.id)}));
  if(!rows.length||invalid.length|| (published&&published!==rows.length)){console.error("REVIEW REQUIRED:",source,"live listing extraction incomplete");process.exitCode=1;}
  if(!record?.lastSuccessAt){console.error("REVIEW REQUIRED:",source,"missing Worker success timestamp");process.exitCode=1;}
 }catch(error){console.error("AUDIT FAILED:",source,String(error));process.exitCode=1;}
}
console.log("NOTE: This audit compares public inventory counts and Worker health metadata. It cannot prove row-by-row D1 snapshot coverage without a read-only snapshot export.");
