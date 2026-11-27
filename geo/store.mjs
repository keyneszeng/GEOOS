import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {mentions,metrics} from "./core.mjs";
const now=()=>new Date().toISOString();
export function openStore(path){
 const db=new DatabaseSync(path);
 db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
 db.exec("CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,brand TEXT NOT NULL,aliases TEXT NOT NULL,competitors TEXT NOT NULL,created_at TEXT NOT NULL);");
 db.exec("CREATE TABLE IF NOT EXISTS prompts(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),question TEXT NOT NULL,topic TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace_id,question));");
 db.exec("CREATE TABLE IF NOT EXISTS samples(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),prompt_id TEXT NOT NULL REFERENCES prompts(id),question TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL DEFAULT 'pending',status TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,answer TEXT,citations TEXT,sources TEXT,usage TEXT,raw TEXT,mentioned INTEGER,competitor_hits TEXT,error TEXT,retryable INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS sample_history ON samples(workspace_id,created_at DESC);");
 const list=()=>db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map(w=>({...w,aliases:JSON.parse(w.aliases),competitors:JSON.parse(w.competitors)}));
 const workspace=id=>list().find(w=>w.id===id);
 function clean(v,max){if(typeof v!=="string"||!v.trim()||v.length>max)throw Error("Invalid text input");return v.trim()}
 function names(v){if(!Array.isArray(v)||v.length>20)throw Error("Invalid aliases or competitors");return [...new Set(v.map(x=>clean(x,100)))]}
 function createWorkspace(input){const w={id:randomUUID(),name:clean(input.name,100),brand:clean(input.brand,100),aliases:names(input.aliases??[]),competitors:names(input.competitors??[]),created_at:now()};db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?)").run(w.id,w.name,w.brand,JSON.stringify(w.aliases),JSON.stringify(w.competitors),w.created_at);return w}
 function addPrompt(id,input){const w=workspace(id);if(!w)throw Error("Workspace not found");const question=clean(input.question,1000);if(mentions(question,[w.brand,...w.aliases,...w.competitors]))throw Error("Use an unbranded decision question");const p={id:randomUUID(),workspace_id:id,question,topic:clean(input.topic||"未分类",100),created_at:now()};if(db.prepare("SELECT id FROM prompts WHERE workspace_id=? AND question=?").get(id,question))throw Error("Question already exists");db.prepare("INSERT INTO prompts VALUES(?,?,?,?,?)").run(p.id,id,p.question,p.topic,p.created_at);return p}
 const prompts=id=>db.prepare("SELECT * FROM prompts WHERE workspace_id=? ORDER BY created_at").all(id);
 function reserve(id,promptId,provider,limit){api.billingCheck?.(id,"samples");const p=db.prepare("SELECT * FROM prompts WHERE workspace_id=? AND id=?").get(id,promptId);if(!p)throw Error("Prompt not found in workspace");const sampleId=randomUUID(),t=now();const r=db.prepare("INSERT INTO samples(id,workspace_id,prompt_id,question,provider,status,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM samples WHERE created_at>=?)<?").run(sampleId,id,promptId,p.question,provider,"running",t,t.slice(0,10),limit);if(!r.changes)throw Error("Daily global attempt limit reached (UTC)");return {id:sampleId,prompt:p}}
 function finish(id,w,r){db.prepare("UPDATE samples SET status='success',finished_at=?,model=?,answer=?,citations=?,sources=?,usage=?,raw=?,mentioned=?,competitor_hits=? WHERE id=? AND status='running'").run(now(),r.model,r.answer,JSON.stringify(r.citations),JSON.stringify(r.sources),JSON.stringify(r.usage),JSON.stringify(r.raw),Number(mentions(r.answer,[w.brand,...w.aliases])),JSON.stringify(w.competitors.filter(c=>mentions(r.answer,[c]))),id)}
 function fail(id,error,retryable=false){db.prepare("UPDATE samples SET status='failed',finished_at=?,error=?,retryable=? WHERE id=? AND status='running'").run(now(),String(error).slice(0,200),Number(retryable),id)}
 const history=id=>db.prepare("SELECT id,prompt_id,question,provider,model,status,created_at,finished_at,answer,citations,sources,usage,mentioned,competitor_hits,error,retryable FROM samples WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").all(id);
 const stats=id=>metrics(db.prepare("SELECT provider,model,status,mentioned,json_array_length(COALESCE(citations,'[]')) AS citation_count FROM samples WHERE workspace_id=? AND created_at>=?").all(id,new Date(Date.now()-30*86400000).toISOString()));
 db.prepare("UPDATE samples SET status='failed',finished_at=?,error='Interrupted; retry manually' WHERE status='running'").run(now());
 const api={db,list,workspace,createWorkspace,addPrompt,prompts,reserve,finish,fail,history,stats};return api;
}
