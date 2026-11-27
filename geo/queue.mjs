import {randomUUID} from "node:crypto";
const stamp=t=>new Date(t).toISOString();
import {providerIds} from "./providers.mjs";
const engines=new Set(providerIds);
export function openQueue(store,{clock=Date.now}={}){
 const {db}=store;
 db.exec("CREATE TABLE IF NOT EXISTS geo_schedules(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),prompt_id TEXT NOT NULL REFERENCES prompts(id),provider TEXT NOT NULL,interval_minutes INTEGER NOT NULL,enabled INTEGER NOT NULL,next_at TEXT NOT NULL,created_at TEXT NOT NULL);");
 db.exec("CREATE TABLE IF NOT EXISTS geo_jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),prompt_id TEXT NOT NULL REFERENCES prompts(id),provider TEXT NOT NULL,schedule_id TEXT REFERENCES geo_schedules(id),state TEXT NOT NULL,available_at TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,sample_id TEXT REFERENCES samples(id),error TEXT); CREATE INDEX IF NOT EXISTS geo_jobs_due ON geo_jobs(state,available_at);");
 // No automatic replay of a request with an unknown billing outcome.
 db.prepare("UPDATE geo_jobs SET state='interrupted',finished_at=?,error='Interrupted; inspect sample before retry' WHERE state='running'").run(stamp(clock()));
 function tx(fn){db.exec("BEGIN IMMEDIATE");try{const result=fn();db.exec("COMMIT");return result}catch(e){db.exec("ROLLBACK");throw e}}
 function validate(w,p,provider){if(!engines.has(provider))throw Error("Unsupported provider");if(!db.prepare("SELECT id FROM prompts WHERE id=? AND workspace_id=?").get(p,w))throw Error("Prompt not found in workspace")}
 function get(id,w){return db.prepare("SELECT * FROM geo_jobs WHERE id=? AND workspace_id=?").get(id,w)}
 function add(w,p,provider,scheduleId=null){
  validate(w,p,provider);
  if(db.prepare("SELECT count(*) AS n FROM geo_jobs WHERE state IN ('queued','running')").get().n>=200)throw Error("Queue capacity reached");
  const id=randomUUID(),t=stamp(clock());
  db.prepare("INSERT INTO geo_jobs(id,workspace_id,prompt_id,provider,schedule_id,state,available_at,created_at) VALUES(?,?,?,?,?,'queued',?,?)").run(id,w,p,provider,scheduleId,t,t);
  return get(id,w);
 }
 function enqueue(w,p,provider){return tx(()=>add(w,p,provider))}
 function schedule(w,input){
  const {promptId,provider,intervalMinutes}=input;validate(w,promptId,provider);
  if(!Number.isInteger(intervalMinutes)||intervalMinutes<60||intervalMinutes>10080)throw Error("Interval must be 60–10080 minutes");
  return tx(()=>{if(db.prepare("SELECT count(*) AS n FROM geo_schedules WHERE enabled=1").get().n>=100)throw Error("Schedule capacity reached");if(db.prepare("SELECT id FROM geo_schedules WHERE workspace_id=? AND prompt_id=? AND provider=? AND enabled=1").get(w,promptId,provider))throw Error("An active schedule already exists");const id=randomUUID(),t=clock();db.prepare("INSERT INTO geo_schedules VALUES(?,?,?,?,?,1,?,?)").run(id,w,promptId,provider,intervalMinutes,stamp(t+intervalMinutes*60000),stamp(t));return db.prepare("SELECT * FROM geo_schedules WHERE id=?").get(id)});
 }
 function stop(w,id){return tx(()=>{const r=db.prepare("UPDATE geo_schedules SET enabled=0 WHERE workspace_id=? AND id=?").run(w,id);if(!r.changes)throw Error("Schedule not found");db.prepare("UPDATE geo_jobs SET state='cancelled',finished_at=? WHERE workspace_id=? AND schedule_id=? AND state='queued'").run(stamp(clock()),w,id);return {cancelled:true}})}
 function cancel(w,id){const r=db.prepare("UPDATE geo_jobs SET state='cancelled',finished_at=? WHERE workspace_id=? AND id=? AND state='queued'").run(stamp(clock()),w,id);if(!r.changes)throw Error("Only queued jobs can be cancelled");return get(id,w)}
 function retry(w,id){return tx(()=>{const old=get(id,w);if(!old||!["failed","interrupted"].includes(old.state))throw Error("Only failed or interrupted jobs can be retried");return add(w,old.prompt_id,old.provider)})}
 function tick(configured){
  return tx(()=>{const t=clock();for(const s of db.prepare("SELECT * FROM geo_schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at,id").all(stamp(t))){
    // Advance from now, not from the old slot: no catch-up storm.
    if(!configured.includes(s.provider))continue;
    if(db.prepare("SELECT count(*) AS n FROM geo_jobs WHERE state IN ('queued','running')").get().n>=200)break;
    if(!db.prepare("SELECT id FROM geo_jobs WHERE schedule_id=? AND state IN ('queued','running')").get(s.id))add(s.workspace_id,s.prompt_id,s.provider,s.id);
    db.prepare("UPDATE geo_schedules SET next_at=? WHERE id=?").run(stamp(t+s.interval_minutes*60000),s.id);
  }});
 }
 function claim(configured,limit){
  return tx(()=>{const jobs=db.prepare("SELECT * FROM geo_jobs WHERE state='queued' AND available_at<=? ORDER BY created_at,rowid LIMIT 200").all(stamp(clock()));const j=jobs.find(j=>{if(!configured.includes(j.provider))return false;try{store.billingCheck?.(j.workspace_id,"samples");return true}catch(e){if(e.code!=="GEO_MONTHLY_QUOTA")throw e;db.prepare("UPDATE geo_jobs SET state='failed',finished_at=?,error=? WHERE id=? AND state='queued'").run(stamp(clock()),e.message,j.id);return false}});if(!j)return null;
   if(db.prepare("SELECT count(*) AS n FROM samples WHERE created_at>=?").get(new Date().toISOString().slice(0,10)).n>=limit)return null;
   const sample=store.reserve(j.workspace_id,j.prompt_id,j.provider,limit);
   db.prepare("UPDATE geo_jobs SET state='running',started_at=?,sample_id=? WHERE id=?").run(stamp(clock()),sample.id,j.id);
   return {...j,sample_id:sample.id,question:sample.prompt.question};
  });
 }
 function complete(j,result,error){
  return tx(()=>{if(!db.prepare("SELECT id FROM geo_jobs WHERE id=? AND state='running' AND sample_id=?").get(j.id,j.sample_id))throw Error("Job is not running");
   if(error){store.fail(j.sample_id,error.message,error.retryable===true)}else{store.finish(j.sample_id,store.workspace(j.workspace_id),result)}
   db.prepare("UPDATE geo_jobs SET state=?,finished_at=?,error=? WHERE id=?").run(error?"failed":"success",stamp(clock()),error?error.message:null,j.id);
   return get(j.id,j.workspace_id);
  });
 }
 const jobs=w=>db.prepare("SELECT * FROM geo_jobs WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100").all(w);
 const schedules=w=>db.prepare("SELECT * FROM geo_schedules WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").all(w);
 return {enqueue,schedule,stop,cancel,retry,tick,claim,complete,jobs,schedules,get};
}
