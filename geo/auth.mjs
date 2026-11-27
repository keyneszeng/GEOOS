import {randomUUID,randomBytes,scryptSync,timingSafeEqual,createHash} from "node:crypto";
const stamp=()=>new Date().toISOString();
const hash=t=>createHash("sha256").update(t).digest("hex");
const roles=["owner","editor","reviewer","viewer"];
const name=v=>{if(typeof v!=="string"||!/^[a-zA-Z0-9_.@-]{3,100}$/.test(v))throw Error("Invalid username");return v.toLowerCase()};
function secret(v){if(typeof v!=="string"||v.length<12||v.length>128)throw Error("Password must contain 12–128 characters");return v}
function digest(password,salt){return scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024})}
export function canWrite(role,resource,action,state){
 if(role==="owner")return true;
 if(resource==="members"||resource==="audit")return false;
 if(resource==="site-scans"||resource==="schema")return role==="editor";
 if(resource==="site-tasks")return role==="editor"&&["create","implement"].includes(action)||role==="reviewer"&&action==="verify";
 if(resource==="site-audits")return role==="editor"&&action==="run";
 if(resource==="channel-intelligence")return role==="editor"&&action==="link";
 if(resource==="distribution")return role==="editor"&&["channel","create","revise","publish","cancel","metric"].includes(action)||role==="reviewer"&&["approve","reject"].includes(action);
 if(role==="reviewer")return resource==="reviews"||resource==="facts"&&action==="review"||resource==="actions"&&action==="transition"&&["approved","rejected","draft","verified"].includes(state);
 if(role==="editor")return ["prompts","samples","jobs","schedules","imports","evidence","agent"].includes(resource)||resource==="facts"&&action!=="review"||resource==="actions"&&(action==="discover"||action==="draft"||action==="transition"&&state==="implemented");
 return false;
}
export function openAuth(store,{bootstrapUser,bootstrapPassword,clock=Date.now}={}){
 const {db}=store;
 db.exec("CREATE TABLE IF NOT EXISTS geo_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL,platform_admin INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);");
 db.exec("CREATE TABLE IF NOT EXISTS geo_members(workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES geo_users(id),role TEXT NOT NULL CHECK(role IN ('owner','editor','reviewer','viewer')),PRIMARY KEY(workspace_id,user_id));");
 db.exec("CREATE TABLE IF NOT EXISTS geo_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES geo_users(id),expires_at INTEGER NOT NULL);");
 db.exec("CREATE TABLE IF NOT EXISTS geo_audit(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES geo_users(id),resource TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT,created_at TEXT NOT NULL);");
 function tx(fn){db.exec("BEGIN IMMEDIATE");try{const r=fn();db.exec("COMMIT");return r}catch(e){db.exec("ROLLBACK");throw e}}
 function createUser(username,password,admin=0){const u=name(username);secret(password);if(db.prepare("SELECT id FROM geo_users WHERE username=?").get(u))throw Error("Username already exists");const id=randomUUID(),salt=randomBytes(16).toString("hex");db.prepare("INSERT INTO geo_users VALUES(?,?,?,?,?,?)").run(id,u,salt,digest(password,salt).toString("hex"),admin,stamp());return {id,username:u,platform_admin:admin}}
 if(!db.prepare("SELECT count(*) AS n FROM geo_users").get().n){if(!bootstrapUser||!bootstrapPassword)throw Error("First start requires GEO_ADMIN_USER and GEO_ADMIN_PASSWORD (at least 12 characters)");tx(()=>{const admin=createUser(bootstrapUser,bootstrapPassword,1);db.prepare("INSERT INTO geo_members SELECT id,?,'owner' FROM workspaces").run(admin.id)})}
 const attempts=[];
 function login(input){const t=clock();while(attempts.length&&attempts[0]<=t-60000)attempts.shift();if(attempts.length>=12)throw Error("Too many login attempts; retry in one minute");attempts.push(t);
  const u=typeof input.username==="string"&&input.username.length<=100?db.prepare("SELECT * FROM geo_users WHERE username=?").get(input.username.toLowerCase()):null;
  const password=typeof input.password==="string"&&input.password.length<=128?input.password:"";
  const calculated=digest(password,u?.salt||"00000000000000000000000000000000"),expected=Buffer.from(u?.password_hash||"00".repeat(64),"hex");
  if(!u||!timingSafeEqual(calculated,expected))return null;
  const token=randomBytes(32).toString("hex");db.prepare("DELETE FROM geo_sessions WHERE expires_at<=?").run(t);db.prepare("INSERT INTO geo_sessions VALUES(?,?,?)").run(hash(token),u.id,t+8*3600000);return token;
 }
 const getToken=req=>{const matches=String(req.headers.cookie||"").split(";").map(s=>s.trim()).filter(s=>s.startsWith("geo_session="));if(matches.length!==1)return null;const token=matches[0].slice(12);return /^[a-f0-9]{64}$/.test(token)?token:null};
 function authenticate(req){const token=getToken(req);return token?db.prepare("SELECT u.id,u.username,u.platform_admin FROM geo_sessions s JOIN geo_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").get(hash(token),clock()):null}
 function logout(req){const token=getToken(req);if(token)db.prepare("DELETE FROM geo_sessions WHERE token_hash=?").run(hash(token))}
 const role=(w,u)=>db.prepare("SELECT role FROM geo_members WHERE workspace_id=? AND user_id=?").get(w,u)?.role;
 const list=u=>store.list().flatMap(w=>{const r=role(w.id,u);return r?[{...w,role:r}]:[]});
 function audit(w,u,resource,action,target=null){db.prepare("INSERT INTO geo_audit VALUES(?,?,?,?,?,?,?)").run(randomUUID(),w,u,resource,String(action||"create").slice(0,100),typeof target==="string"?target:null,stamp())}
 function createWorkspace(u,input){return tx(()=>{const w=store.createWorkspace(input);db.prepare("INSERT INTO geo_members VALUES(?,?,'owner')").run(w.id,u);audit(w.id,u,"workspaces","create",w.id);return {...w,role:"owner"}})}
 function provision(actor,input){if(!actor.platform_admin)throw Error("Platform admin required");return tx(()=>{const user=createUser(input.username,input.password);audit(null,actor.id,"users","create",user.id);return user})}
 function setMember(w,actor,input){if(role(w,actor)!=="owner")throw Error("Workspace owner required");if(!roles.includes(input.role))throw Error("Invalid role");const u=db.prepare("SELECT id FROM geo_users WHERE username=?").get(name(input.username));if(!u)throw Error("Unknown user");return tx(()=>{const old=role(w,u.id);if(old==="owner"&&input.role!=="owner"&&db.prepare("SELECT count(*) AS n FROM geo_members WHERE workspace_id=? AND role='owner'").get(w).n===1)throw Error("Cannot remove the last owner");db.prepare("INSERT INTO geo_members VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role").run(w,u.id,input.role);audit(w,actor,"members","set-role",u.id);return {user_id:u.id,role:input.role}})}
 function removeMember(w,actor,input){if(role(w,actor)!=="owner")throw Error("Workspace owner required");const u=db.prepare("SELECT id FROM geo_users WHERE username=?").get(name(input.username));if(!u)throw Error("Unknown user");return tx(()=>{if(role(w,u.id)==="owner"&&db.prepare("SELECT count(*) AS n FROM geo_members WHERE workspace_id=? AND role='owner'").get(w).n===1)throw Error("Cannot remove the last owner");db.prepare("DELETE FROM geo_members WHERE workspace_id=? AND user_id=?").run(w,u.id);audit(w,actor,"members","remove",u.id);return {removed:true}})}
 const members=w=>db.prepare("SELECT u.id,u.username,m.role FROM geo_members m JOIN geo_users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.username").all(w);
 const logs=w=>db.prepare("SELECT a.*,u.username FROM geo_audit a JOIN geo_users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 200").all(w);
 return {login,authenticate,logout,role,list,createWorkspace,provision,setMember,removeMember,members,logs,audit};
}
