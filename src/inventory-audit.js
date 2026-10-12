// Read-only inventory reconciliation. Never treats mismatches as deletions.
export function compareInventory(primary,secondary,{minimumOverlap=0.85}={}){
 const a=new Map(primary.map(r=>[String(r.id),r]));
 const b=new Map(secondary.map(r=>[String(r.id),r]));
 const shared=[...a.keys()].filter(id=>b.has(id));
 const onlyPrimary=[...a.keys()].filter(id=>!b.has(id));
 const onlySecondary=[...b.keys()].filter(id=>!a.has(id));
 const overlap= Math.min(a.size,b.size) ? shared.length/Math.min(a.size,b.size) : 0;
 const priceDifferences=shared.filter(id=>{
  const x=Number(a.get(id).total),y=Number(b.get(id).total);
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)>0.01;
 });
 return {primaryCount:a.size,secondaryCount:b.size,sharedCount:shared.length,overlap,
  onlyPrimary,onlySecondary,priceDifferences,requiresReview:!a.size||!b.size||overlap<minimumOverlap};
}
