import {randomUUID} from "node:crypto";
import {analyze} from "./analysis.mjs";
const now=()=>new Date().toISOString();
const canOperate=role=>["owner","editor"].includes(role);
export function openWorkflows(store,knowledge,actions,agent,auth,{providers=()=>[]}={}){
 const {db}=store;
 db.exec("CREATE TABLE IF NOT EXISTS geo_workflows(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),sample_id TEXT NOT NULL REFERENCES samples(id),provider TEXT NOT NULL,fact_ids TEXT NOT NULL,stage TEXT NOT NULL,state TEXT NOT NULL,pause_requested INTEGER NOT NULL DEFAULT 0,assessment_id TEXT REFERENCES geo_agent_runs(id),action_id TEXT REFERENCES geo_actions(id),composition_id TEXT REFERENCES geo_agent_runs(id),error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS geo_workflows_due ON geo_workflows(state,created_at);");
 db.exec("CREATE TABLE IF NOT EXISTS geo_workflow_events(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES geo_workflows(id),stage TEXT NOT NULL,state TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);");
 function tx(fn){db.exec("BEGIN IMMEDIATE");try{const r=fn();db.exec("COMMIT");return r}catch(e){db.exec("ROLLBACK");throw e}}
 const get=(w,id)=>db.prepare("SELECT * FROM geo_workflows WHERE workspace_id=? AND id=?").get(w,id);
 const event=(id,stage,state,note)=>db.prepare("INSERT INTO geo_workflow_events VALUES(?,?,?,?,?,?)").run(randomUUID(),id,stage,state,note,now());
 // In-flight provider outcome may be unknown: never automatically replay.
 tx(()=>{for(const r of db.prepare("SELECT * FROM geo_workflows WHERE state='running'").all()){db.prepare("UPDATE geo_workflows SET state='interrupted',error='Interrupted; inspect Agent runs before starting a new workflow',updated_at=? WHERE id=?").run(now(),r.id);event(r.id,r.stage,"interrupted","Service restarted; no automatic replay")}});
 function selected(w,ids){if(!Array.isArray(ids)||ids.length>10||ids.some(x=>typeof x!=="string"))throw Error("Choose at most 10 public fact versions");const unique=[...new Set(ids)],available=new Set(knowledge.publicFacts(w).map(f=>f.id));if(unique.some(x=>!available.has(x)))throw Error("Selected facts must be current approved public facts");return unique}
 function create(w,actor,input){
  if(!canOperate(auth.role(w,actor)))throw Error("Workflow operator required");
  if(input.confirm!==true)throw Error("Confirm transmission of selected question, answer and facts, and up to two potentially billable Agent calls");
  if(!providers().includes(input.provider)||input.provider==="openai-web")throw Error("Select a configured non-web Agent provider");
  const s=db.prepare("SELECT * FROM samples WHERE workspace_id=? AND id=? AND status='success'").get(w,input.sampleId);if(!s)throw Error("Successful sample required");
  if(s.answer.length>16000)throw Error("Sample exceeds Agent input limit");
  const factIds=selected(w,input.factIds??[]);
  return tx(()=>{if(db.prepare("SELECT count(*) AS n FROM geo_workflows WHERE state IN ('queued','running','paused')").get().n>=100)throw Error("Workflow capacity reached");
   if(db.prepare("SELECT id FROM geo_workflows WHERE workspace_id=? AND sample_id=? AND state IN ('queued','running','paused')").get(w,s.id))throw Error("An active workflow already exists for this sample");
   const id=randomUUID(),t=now();db.prepare("INSERT INTO geo_workflows(id,workspace_id,actor_id,sample_id,provider,fact_ids,stage,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'assess','queued',?,?)").run(id,w,actor,s.id,input.provider,JSON.stringify(factIds),t,t);event(id,"assess","queued","Operator confirmed data transfer and bounded calls");return get(w,id)});
 }
 function control(w,actor,input){if(!canOperate(auth.role(w,actor)))throw Error("Workflow operator required");return tx(()=>{const r=get(w,input.id);if(!r)throw Error("Workflow not found");if(actor!==r.actor_id&&auth.role(w,actor)!=="owner")throw Error("Only workflow creator or owner can control it");
  let state=r.state,flag=r.pause_requested;
  if(input.action==="pause"&&state==="running")flag=1;
  else if(input.action==="pause"&&state==="queued")state="paused";
  else if(input.action==="resume"&&state==="paused"){if(!canOperate(auth.role(w,r.actor_id)))throw Error("Original operator no longer authorized; create a new workflow");state="queued";flag=0}
  else if(input.action==="cancel"&&["queued","paused"].includes(state))state="cancelled";
  else throw Error("Invalid workflow control; pause an in-flight step before cancelling");
  db.prepare("UPDATE geo_workflows SET state=?,pause_requested=?,updated_at=? WHERE id=?").run(state,flag,now(),r.id);event(r.id,r.stage,state,input.action+(flag?" after current step":""));return get(w,r.id)})}
 const recent=w=>db.prepare("SELECT * FROM geo_workflows WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50").all(w);
 function events(w,id){if(!get(w,id))throw Error("Workflow not found");return db.prepare("SELECT * FROM geo_workflow_events WHERE workflow_id=? ORDER BY created_at,rowid").all(id)}
 function finish(r,next,patch={},note=""){return tx(()=>{const latest=get(r.workspace_id,r.id);if(latest.state!=="running")throw Error("Workflow no longer running");const terminal=["completed","failed"].includes(next),state=terminal?next:latest.pause_requested?"paused":"queued",stage=terminal?r.stage:next;
  db.prepare("UPDATE geo_workflows SET state=?,stage=?,pause_requested=0,assessment_id=COALESCE(?,assessment_id),action_id=COALESCE(?,action_id),composition_id=COALESCE(?,composition_id),error=?,updated_at=? WHERE id=?").run(state,stage,patch.assessmentId??null,patch.actionId??null,patch.compositionId??null,patch.error??null,now(),r.id);event(r.id,r.stage,state,note);return get(r.workspace_id,r.id)})}
 let busy=false;
 async function tick(){
  if(busy||agent.isBusy())return null;busy=true;
  let r;
  try{
   r=tx(()=>{const row=db.prepare("SELECT * FROM geo_workflows WHERE state='queued' ORDER BY updated_at,rowid LIMIT 1").get();if(!row)return null;db.prepare("UPDATE geo_workflows SET state='running',updated_at=? WHERE id=?").run(now(),row.id);event(row.id,row.stage,"running","Step started");return row});
   if(!r)return null;
   const w=r.workspace_id;
   if(!canOperate(auth.role(w,r.actor_id)))return finish(r,"failed",{error:"Original operator no longer authorized"},"Permission revoked; no request sent");
   const facts=selected(w,JSON.parse(r.fact_ids));
   const s=db.prepare("SELECT * FROM samples WHERE workspace_id=? AND id=? AND status='success'").get(w,r.sample_id);if(!s)throw Error("Sample unavailable");
   if(r.stage==="assess"){
    const a=await agent.run(w,{confirm:true,kind:"assess",targetId:s.id,provider:r.provider,factIds:facts});
    if(a.state!=="success")return finish(r,"failed",{assessmentId:a.id,error:a.error||"Assessment failed"},"Assessment request failed; no automatic retry");
    return finish(r,"discover",{assessmentId:a.id},"Assessment candidate saved; human review required");
   }
   if(r.stage==="discover"){
    const scope={promptId:s.prompt_id,provider:s.provider,model:s.model};
    const group=analyze(db.prepare("SELECT id,prompt_id,question,provider,model,status,mentioned,competitor_hits,citations FROM samples WHERE workspace_id=? AND prompt_id=? AND provider=? AND model=? AND created_at>=? ORDER BY created_at DESC").all(w,s.prompt_id,s.provider,s.model,new Date(Date.now()-30*86400000).toISOString())).find(g=>g.opportunity);
    if(!group)return finish(r,"completed",{},"No current mention-gap opportunity; assessment retained");
    actions.discover(w,scope);
    const a=db.prepare("SELECT * FROM geo_actions WHERE workspace_id=? AND prompt_id=? AND provider=? AND model=? AND competitor=?").get(w,s.prompt_id,s.provider,s.model,group.opportunity.competitor);
    if(!a||a.state!=="open"||!facts.length)return finish(r,"completed",{actionId:a?.id},"Opportunity saved or already exists; no new composition requested");
    return finish(r,"compose",{actionId:a.id},"Opportunity saved; preparing candidate");
   }
   if(r.stage==="compose"){
    const a=db.prepare("SELECT state FROM geo_actions WHERE workspace_id=? AND id=?").get(w,r.action_id);
    if(a?.state!=="open")return finish(r,"completed",{},"Action is no longer open; no draft overwritten");
    const c=await agent.run(w,{confirm:true,kind:"compose",targetId:r.action_id,provider:r.provider,factIds:facts});
    if(c.state!=="success")return finish(r,"failed",{compositionId:c.id,error:c.error||"Composition failed"},"Composition request failed; no automatic retry");
    return finish(r,"completed",{compositionId:c.id},"Candidate saved; no automatic adoption, approval or publication");
   }
   throw Error("Unknown workflow stage");
  }catch(e){if(r)return finish(r,"failed",{error:String(e.message).slice(0,200)},"Workflow halted; inspect before starting again");throw e}
  finally{busy=false}
 }
 return {create,control,recent,events,tick};
}
