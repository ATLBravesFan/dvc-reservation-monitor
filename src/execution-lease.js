// Atomic, expiring D1 leases. Use before a watch starts; release in finally.
// Tokens prevent an expired owner from releasing a newer owner's lease.
export async function acquireLease(db, source, ttlSeconds=90) {
  const token=crypto.randomUUID();
  const now=new Date();
  const expires=new Date(now.getTime()+ttlSeconds*1000).toISOString();
  const result=await db.prepare(`
    INSERT INTO execution_leases(source,token,acquired_at,expires_at)
    VALUES(?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET token=excluded.token,
      acquired_at=excluded.acquired_at,expires_at=excluded.expires_at
    WHERE execution_leases.expires_at <= excluded.acquired_at
  `).bind(source,token,now.toISOString(),expires).run();
  return Number(result.meta?.changes||0)===1 ? token : null;
}
export async function releaseLease(db,source,token){
  await db.prepare("DELETE FROM execution_leases WHERE source=? AND token=?").bind(source,token).run();
}
export async function withLease(db,source,fn,ttlSeconds=90){
  const token=await acquireLease(db,source,ttlSeconds);
  if(!token)return {skipped:true,reason:"already-running"};
  const id=crypto.randomUUID(),started=new Date().toISOString();
  try {
    await db.prepare("INSERT INTO execution_history(id,source,started_at,outcome) VALUES(?,?,?,'running')").bind(id,source,started).run();
  } catch (error) {
    await releaseLease(db,source,token);
    throw error;
  }
  try{
    const value=await fn();
    await db.prepare("UPDATE execution_history SET finished_at=?,outcome='success' WHERE id=?").bind(new Date().toISOString(),id).run();
    return value;
  }catch(error){
    await db.prepare("UPDATE execution_history SET finished_at=?,outcome='failure',error=? WHERE id=?").bind(new Date().toISOString(),String(error).slice(0,1000),id).run();
    throw error;
  }finally{await releaseLease(db,source,token);}
}
