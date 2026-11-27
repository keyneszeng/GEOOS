import {createServer} from "node:http";
import {mkdirSync,readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {openStore} from "./store.mjs";
import {configuredProviders,sample} from "./providers.mjs";
import {openQueue} from "./queue.mjs";
import {analyze} from "./analysis.mjs";
import {openKnowledge} from "./knowledge.mjs";
import {openActions} from "./actions.mjs";
import {openAgent} from "./agent.mjs";
import {openImporter} from "./import.mjs";
import {openReviews} from "./reviews.mjs";
import {openAuth,canWrite} from "./auth.mjs";
import {openWorkflows} from "./workflows.mjs";
import {openPlanner} from "./planner.mjs";
import {openDistribution} from "./distribution.mjs";
import {openChannelIntelligence} from "./channel-intelligence.mjs";
import {openSiteAudit} from "./site-audit.mjs";
import {openSiteScan} from "./site-scan.mjs";
import {openRemediation} from "./site-remediation.mjs";
import {schemaTool} from "./schema-tools.mjs";
import {openDocuments} from "./documents.mjs";
import {openTraffic} from "./traffic-sync.mjs";
import {openBilling} from "./billing.mjs";
const port=Number(process.env.GEO_PORT||3100),path=resolve(process.env.GEO_DB||".geo-data/geo.sqlite"),limit=Number(process.env.GEO_DAILY_LIMIT||30);
if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(limit)||limit<1||limit>10000)throw Error("Invalid port or limit");
process.umask(0o077);mkdirSync(dirname(path),{recursive:true,mode:0o700});
const bind=process.env.GEO_CONTAINER_BIND==="1"?"0.0.0.0":"127.0.0.1";
const store=openStore(path),html=readFileSync(new URL("./index.html",import.meta.url)),host="127.0.0.1:"+port,origin="http://"+host;
const auth=openAuth(store,{bootstrapUser:process.env.GEO_ADMIN_USER,bootstrapPassword:process.env.GEO_ADMIN_PASSWORD});
delete process.env.GEO_ADMIN_PASSWORD;
const queue=openQueue(store);
const knowledge=openKnowledge(store),actions=openActions(store,knowledge);
const distribution=openDistribution(store,knowledge);
const documents=openDocuments(store,knowledge);
const traffic=openTraffic(store,distribution,auth,{config:{youtubeKey:process.env.GEO_YOUTUBE_API_KEY,instagram:JSON.parse(process.env.GEO_INSTAGRAM_CONFIG||"{}")}});
const agent=openAgent(store,knowledge,actions,{distribution,limit:Number(process.env.GEO_AGENT_DAILY_LIMIT||5)});
const importer=openImporter(store,knowledge,{hosts:(process.env.GEO_IMPORT_HOSTS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean),limit:Number(process.env.GEO_IMPORT_DAILY_LIMIT||10)});
const siteAudits=openSiteAudit(store,{hosts:importer.hosts,limit:Number(process.env.GEO_SITE_AUDIT_DAILY_LIMIT||5)});
const scans=openSiteScan(store,{hosts:importer.hosts});
const remediation=openRemediation(store);
const reviews=openReviews(store,knowledge);
let planner;
const workflows=openWorkflows(store,knowledge,actions,agent,auth,{providers:configuredProviders,authorize:r=>planner?.authorized(r)??true});
planner=openPlanner(store,knowledge,workflows,auth,{providers:configuredProviders,limit:Number(process.env.GEO_AUTO_DAILY_LIMIT||3)});
const channels=openChannelIntelligence(store);
const billing=openBilling(store);store.billingCheck=billing.check;
let busy=false;
function respond(res,status,data){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(data))}
async function body(req,max=65536){if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"])))throw Error("Expected JSON");let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>max)throw Error("Request too large");chunks.push(chunk)}const v=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));if(!v||Array.isArray(v)||typeof v!=="object")throw Error("Expected object");return v}
async function work(){
 if(busy)return;busy=true;
 try{const providers=configuredProviders();queue.tick(providers);const j=queue.claim(providers,limit);if(!j)return;
 let result;try{result=await sample(j.provider,j.question)}catch(e){queue.complete(j,null,{message:/^Provider HTTP \d+$/.test(e.message)?e.message:"Provider request failed or incomplete",retryable:e.retryable===true});return}
 queue.complete(j,result,null);
 }catch(e){console.error("GEO queue error:",e.message)}finally{busy=false}
}
const wake=()=>void work();
setInterval(wake,5000);
setInterval(()=>void traffic.tick().catch(()=>console.error("Traffic scheduler failed")),30000);
setInterval(()=>{try{planner.tick()}catch(e){console.error("Daily planner error:",e.message)}},30000);
setInterval(()=>void workflows.tick().catch(e=>console.error("Workflow error:",e.message)),5000);
createServer(async(req,res)=>{
 if(req.headers.host!==host||req.headers.origin&&req.headers.origin!==origin)return respond(res,403,{error:"Local origin required"});
 try{
 const url=new URL(req.url,origin);
 if(req.method==="GET"&&url.pathname==="/healthz"){store.db.prepare("SELECT 1").get();return respond(res,200,{ok:true})}
 if(req.method==="GET"&&url.pathname==="/"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'","X-Content-Type-Options":"nosniff"});return res.end(html)}
 if(req.method==="POST"&&req.headers.origin!==origin)return respond(res,403,{error:"Same-origin write required"});
 if(req.method==="POST"&&url.pathname==="/api/login"){const token=auth.login(await body(req));if(!token)return respond(res,401,{error:"Invalid credentials"});res.setHeader("Set-Cookie","geo_session="+token+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800");return respond(res,200,{ok:true})}
 const user=auth.authenticate(req);
 if(!user)return respond(res,401,{error:"Login required"});
 if(req.method==="POST"&&url.pathname==="/api/logout"){auth.logout(req);res.setHeader("Set-Cookie","geo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");return respond(res,200,{ok:true})}
 if(req.method==="POST"&&url.pathname==="/api/users"){if(!user.platform_admin)return respond(res,403,{error:"Platform admin required"});return respond(res,201,auth.provision(user,await body(req)))}
 if(req.method==="GET"&&url.pathname==="/api/workspaces")return respond(res,200,{user,workspaces:auth.list(user.id),providers:configuredProviders(),dailyLimit:limit,agentLimit:agent.limit,importHosts:importer.hosts,importLimit:importer.limit,auditLimit:siteAudits.limit});
 if(req.method==="POST"&&url.pathname==="/api/workspaces")return respond(res,201,auth.createWorkspace(user.id,await body(req)));
 const match=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]+)\/(prompts|samples|metrics|jobs|schedules|analysis|evidence|facts|public-facts|actions|agent|imports|reviews|review-metrics|comparison|members|audit|workflows|planner|distribution|channel-intelligence|site-audits|site-scans|site-tasks|schema|documents|traffic|billing)$/);
 if(!match)return respond(res,404,{error:"Not found"});
 const [,id,resource]=match;const role=auth.role(id,user.id);if(!role)return respond(res,404,{error:"Workspace not found"});
 if(["members","audit","billing"].includes(resource)&&role!=="owner")return respond(res,403,{error:"Workspace owner required"});
 // Recheck authorization after asynchronous body parsing. No request body is written to the audit log.
 const data=req.method==="POST"?await body(req,resource==="documents"?3*1024*1024:65536):null;
 if(data&&!(resource==="workflows"?["owner","editor"].includes(auth.role(id,user.id)):canWrite(auth.role(id,user.id),resource,data.action,data.state)))return respond(res,403,{error:"Role does not permit this action"});
 const write=(status,result)=>{auth.audit(id,user.id,resource,data?.action||"create",result?.id||data?.id||data?.targetId||data?.runId);return respond(res,status,result)};
 if(req.method==="POST"&&resource==="members")return respond(res,200,data.action==="remove"?auth.removeMember(id,user.id,data):auth.setMember(id,user.id,data));
 if(req.method==="GET"&&resource==="members")return respond(res,200,auth.members(id));
 if(req.method==="GET"&&resource==="audit")return respond(res,200,auth.logs(id));
 if(req.method==="GET"){
  if(resource==="billing")return respond(res,200,billing.read(id));
  if(resource==="documents")return respond(res,200,documents.list(id));
  if(resource==="traffic")return respond(res,200,traffic.list(id));
  if(resource==="site-scans")return respond(res,200,scans.recent(id));
  if(resource==="site-tasks")return respond(res,200,remediation.list(id));
  if(resource==="schema")return respond(res,405,{error:"Use POST"});
  if(resource==="site-audits")return respond(res,200,url.searchParams.has("id")?siteAudits.compare(id,url.searchParams.get("id")):siteAudits.recent(id));
  if(resource==="channel-intelligence")return respond(res,200,url.searchParams.has("month")?channels.calendar(id,url.searchParams.get("month")):url.searchParams.has("id")?channels.citations(id,url.searchParams.get("id"),Number(url.searchParams.get("days")||30)):channels.links(id));
  if(resource==="distribution")return respond(res,200,url.searchParams.has("id")?distribution.history(id,url.searchParams.get("id")):url.searchParams.has("age")?distribution.review(id,Number(url.searchParams.get("age"))):distribution.list(id));
  if(resource==="planner")return respond(res,200,planner.list(id));
  if(resource==="workflows")return respond(res,200,url.searchParams.has("id")?workflows.events(id,url.searchParams.get("id")):workflows.recent(id));
  if(resource==="imports")return respond(res,200,importer.recent(id));
  if(resource==="reviews")return respond(res,200,reviews.recent(id));
  if(resource==="review-metrics")return respond(res,200,reviews.stats(id));
  if(resource==="comparison")return respond(res,200,reviews.compare(id,url.searchParams.get("id"),Number(url.searchParams.get("days")||7)));
  if(resource==="agent")return respond(res,200,agent.recent(id));
  if(resource==="evidence")return respond(res,200,knowledge.listEvidence(id));
  if(resource==="facts")return respond(res,200,knowledge.listFacts(id));
  if(resource==="public-facts")return respond(res,200,knowledge.publicFacts(id));
  if(resource==="actions")return respond(res,200,url.searchParams.has("id")?actions.events(id,url.searchParams.get("id")):actions.list(id));
  if(resource==="jobs")return respond(res,200,queue.jobs(id));
  if(resource==="schedules")return respond(res,200,queue.schedules(id));
  if(resource==="analysis")return respond(res,200,analyze(store.db.prepare("SELECT id,prompt_id,question,provider,model,status,mentioned,competitor_hits,citations FROM samples WHERE workspace_id=? AND created_at>=? ORDER BY created_at DESC").all(id,new Date(Date.now()-30*86400000).toISOString())));
  return respond(res,200,resource==="prompts"?store.prompts(id):resource==="samples"?store.history(id):store.stats(id));
 }
 if(req.method==="POST"&&resource==="billing")return write(200,billing.change(user,id,data));
 if(req.method==="POST"&&resource==="documents"){if(data.action!=="import")throw Error("Unsupported document action");return write(201,await documents.run(id,user.id,data))}
 if(req.method==="POST"&&resource==="traffic")return write(200,traffic.plan(id,user.id,data));
 if(req.method==="POST"&&resource==="site-scans"){if(data.action!=="run")throw Error("Unsupported scan action");return write(201,await scans.run(id,user.id,data))}
 if(req.method==="POST"&&resource==="site-tasks")return write(200,data.action==="create"?remediation.create(id,user.id,data):remediation.change(id,user.id,data));
 if(req.method==="POST"&&resource==="schema")return respond(res,200,schemaTool(data));
 if(req.method==="POST"&&resource==="site-audits"){if(data.action!=="run")throw Error("Unsupported audit action");return write(201,await siteAudits.run(id,user.id,data))}
 if(req.method==="POST"&&resource==="channel-intelligence"){if(data.action!=="link")throw Error("Unsupported channel operation");return write(201,channels.createLink(id,user.id,data))}
 if(req.method==="POST"&&resource==="distribution"){const d=data;if(d.action==="channel")return write(201,distribution.channel(id,d));if(d.action==="create")return write(201,distribution.create(id,user.id,d));if(d.action==="metric")return write(201,distribution.metric(id,user.id,d));return write(200,distribution.change(id,user.id,d))}
 if(req.method==="POST"&&resource==="planner"){if(data.action==="create")return write(201,planner.create(id,user.id,data));if(data.action==="stop")return write(200,planner.stop(id,user.id,data.id));throw Error("Unsupported planner action")}
 if(req.method==="POST"&&resource==="workflows")return write(200,data.action==="create"?workflows.create(id,user.id,data):workflows.control(id,user.id,data));
 if(req.method==="POST"&&resource==="imports")return write(200,await importer.run(id,data));
 if(req.method==="POST"&&resource==="reviews")return write(200,reviews.review(id,data));
 if(req.method==="POST"&&resource==="agent"){const d=data;if(d.action==="run")return write(200,await agent.run(id,d));if(d.action==="adopt")return write(200,agent.adopt(id,d,user.id));throw Error("Unsupported agent action")}
 if(req.method==="POST"&&resource==="evidence")return write(201,knowledge.addEvidence(id,data));
 if(req.method==="POST"&&resource==="facts"){const d=data;return write(200,d.action==="review"?knowledge.review(id,d):knowledge.propose(id,d))}
 if(req.method==="POST"&&resource==="actions"){const d=data;if(d.action==="discover")return write(200,actions.discover(id));if(d.action==="draft")return write(200,actions.draft(id,d));if(d.action==="transition")return write(200,actions.transition(id,d));throw Error("Unsupported action")}
 if(req.method==="POST"&&resource==="prompts")return write(201,store.addPrompt(id,data));
 if(req.method==="POST"&&(resource==="samples"||resource==="jobs")){
  const d=data;if(d.action==="cancel")return write(200,queue.cancel(id,d.id));
  if(d.action==="retry"){const j=queue.retry(id,d.id);write(202,j);wake();return}
  if(!configuredProviders().includes(d.provider))throw Error("Provider not configured");
  const j=queue.enqueue(id,d.promptId,d.provider);write(202,j);wake();return
 }
 if(req.method==="POST"&&resource==="schedules"){const d=data;if(d.action==="stop")return write(200,queue.stop(id,d.id));if(!configuredProviders().includes(d.provider))throw Error("Provider not configured");return write(201,queue.schedule(id,d))}
 return respond(res,405,{error:"Method not allowed"});
 }catch(e){const msg=e instanceof SyntaxError?"Invalid JSON":String(e.message);return respond(res,400,{error:/SQLITE|database|constraint/i.test(msg)?"Database operation failed":msg.slice(0,200)})}
}).listen(port,bind,()=>console.log("GEO/OS live monitor: "+origin));
