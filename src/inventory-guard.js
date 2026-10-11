// Reject suspicious inventory collapses before snapshot replacement.
// Real inventory can shrink; the threshold is intentionally conservative.
export function assertInventoryHealthy(previous, rows, source, options={}) {
  const prior=Object.keys(previous||{}).length;
  const current=rows.length;
  const minimum=options.minimumPrior??30;
  const dropFraction=options.dropFraction??0.8;
  if(prior>=minimum && current<Math.max(1,Math.floor(prior*(1-dropFraction)))) {
    throw new Error(`${source} suspicious inventory collapse: ${prior} -> ${current}; snapshot preserved`);
  }
  const ids=new Set();
  for(const row of rows){
    if(!row.id)throw new Error(`${source} row missing reservation ID`);
    if(ids.has(String(row.id)))throw new Error(`${source} duplicate reservation ID ${row.id}`);
    ids.add(String(row.id));
    if(row.total!=null&&(!Number.isFinite(row.total)||row.total<0))throw new Error(`${source} invalid price for ${row.id}`);
    if(row.checkIn&&row.checkOut&&Date.parse(row.checkOut)<Date.parse(row.checkIn))throw new Error(`${source} invalid dates for ${row.id}`);
  }
}
