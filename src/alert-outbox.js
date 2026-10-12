// Durable D1 outbox. Explicit provider ambiguity is quarantined because the
// provider may already have accepted the request. A Worker that disappears
// mid-send is different: the send lease eventually expires with no JavaScript
// catch/finally path at all. Retry that abandoned claim once so a transient
// Worker termination cannot permanently lose a reservation alert.
export async function enqueueOutbox(db, {key,source,listingId,event,title,showMatches=true,priority=false}) {
 const now=new Date().toISOString();
 const result=await db.prepare(`INSERT OR IGNORE INTO alert_outbox
 (alert_key,source,listing_id,payload,status,attempts,created_at,updated_at,title,show_matches,priority)
 VALUES(?,?,?,?,'pending',0,?,?,?,?,?)`)
 .bind(key,source,String(listingId),JSON.stringify(event),now,now,title,showMatches?1:0,priority?1:0).run();
 return Number(result?.meta?.changes||0)===1;
}
export async function claimOutbox(db,key,leaseSeconds=90){
 const now=new Date(),until=new Date(now.getTime()+leaseSeconds*1000).toISOString();
 const r=await db.prepare(`UPDATE alert_outbox SET status='sending',lease_until=?,updated_at=?,attempts=attempts+1
 WHERE alert_key=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
 .bind(until,now.toISOString(),key,now.toISOString()).run();
 return Number(r.meta?.changes||0)===1;
}
export async function markOutboxSent(db,key,messageId=null){
 await db.prepare(`UPDATE alert_outbox SET status='sent',provider_message_id=?,lease_until=NULL,updated_at=? WHERE alert_key=? AND status='sending'`)
 .bind(messageId,new Date().toISOString(),key).run();
}
export async function markOutboxUncertain(db,key,error){
 await db.prepare(`UPDATE alert_outbox SET status='uncertain',last_error=?,lease_until=NULL,updated_at=? WHERE alert_key=? AND status='sending'`)
 .bind(String(error).slice(0,1000),new Date().toISOString(),key).run();
}
export async function requeueOutbox(db,key,error,delaySeconds=60){
 const now=new Date();
 await db.prepare(`UPDATE alert_outbox SET status='pending',last_error=?,lease_until=NULL,
 next_attempt_at=?,updated_at=? WHERE alert_key=? AND status='sending'`)
 .bind(String(error).slice(0,1000),new Date(now.getTime()+delaySeconds*1000).toISOString(),now.toISOString(),key).run();
}

// Recover a claim whose Worker vanished before it could record success/failure.
// One abandoned claim is retried. If a second claimed attempt also disappears,
// quarantine it for review rather than risking an unlimited duplicate loop.
export async function recoverExpiredSends(db,maxAttempts=2){
 const now=new Date().toISOString();
 const retried=await db.prepare(`UPDATE alert_outbox SET status='pending',
 last_error='Previous delivery claim expired before confirmation; retrying once',
 lease_until=NULL,next_attempt_at=?,updated_at=?
 WHERE status='sending' AND lease_until<=? AND attempts<?`)
 .bind(now,now,now,maxAttempts).run();
 const uncertain=await db.prepare(`UPDATE alert_outbox SET status='uncertain',
 last_error='Delivery claim expired repeatedly; provider acceptance unknown',
 lease_until=NULL,updated_at=?
 WHERE status='sending' AND lease_until<=? AND attempts>=?`)
 .bind(now,now,maxAttempts).run();
 return {
  retried:Number(retried?.meta?.changes||0),
  uncertain:Number(uncertain?.meta?.changes||0),
 };
}

// Backward-compatible helper retained for callers/tests that explicitly want
// to quarantine every expired send without retrying it.
export async function quarantineExpiredSends(db){
 const now=new Date().toISOString();
 return db.prepare(`UPDATE alert_outbox SET status='uncertain',last_error='Delivery lease expired; provider acceptance unknown',
 lease_until=NULL,updated_at=? WHERE status='sending' AND lease_until<=?`).bind(now,now).run();
}
