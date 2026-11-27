import {createServer} from "node:http";
import {mkdirSync,readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {openStore} from "./store.mjs";
import {configuredProviders,sample} from "./providers.mjs";
import {openQueue} from "./queue.mjs";
import {analyze} from "./analysis.mjs";
const port=Number(process.env.GEO_PORT||3100),path=resolve(process.env.GEO_DB||".geo-data/geo.sqlite"),limit=Number(process.env.GEO_DAILY_LIMIT||30);
if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(limit)||limit<1||limit>10000)throw Error("Invalid port or limit");
process.umask(0o077);mkdirSync(dirname(path),{recursive:true,mode:0o700});
const store=openStore(path),html=readFileSync(new URL("./index.html",import.meta.url)),host="127.0.0.1:"+port,origin="http://"+host;
const queue=openQueue(store);
let busy=false;
function respond(res,status,data){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(data))}
async function body(req){if(!String(req.headers["content-type"]).startsWith("application/json"))throw Error("Expected JSON");let data="";for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>16384)throw Error("Request too large")}const v=JSON.parse(data);if(!v||Array.isArray(v)||typeof v!=="object")throw Error("Expected object");return v}
async function work(){
 if(busy)return;busy=true;
 try{const providers=configuredProviders();queue.tick(providers);const j=queue.claim(providers,limit);if(!j)return;
 let result;try{result=await sample(j.provider,j.question)}catch(e){queue.complete(j,null,{message:/^Provider HTTP \d+$/.test(e.message)?e.message:"Provider request failed or incomplete",retryable:e.retryable===true});return}
 queue.complete(j,result,null);
 }catch(e){console.error("GEO queue error:",e.message)}finally{busy=false}
}
const wake=()=>void work();
setInterval(wake,5000);
createServer(async(req,res)=>{
 if(req.headers.host!==host||req.headers.origin&&req.headers.origin!==origin)return respond(res,403,{error:"Local origin required"});
 try{
 const url=new URL(req.url,origin);
 if(req.method==="GET"&&url.pathname==="/"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'","X-Content-Type-Options":"nosniff"});return res.end(html)}
 if(req.method==="GET"&&url.pathname==="/api/workspaces")return respond(res,200,{workspaces:store.list(),providers:configuredProviders(),dailyLimit:limit});
 if(req.method==="POST"&&url.pathname==="/api/workspaces")return respond(res,201,store.createWorkspace(await body(req)));
 const match=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]+)\/(prompts|samples|metrics|jobs|schedules|analysis)$/);
 if(!match)return respond(res,404,{error:"Not found"});
 const [,id,resource]=match;if(!store.workspace(id))return respond(res,404,{error:"Workspace not found"});
 if(req.method==="GET"){
  if(resource==="jobs")return respond(res,200,queue.jobs(id));
  if(resource==="schedules")return respond(res,200,queue.schedules(id));
  if(resource==="analysis")return respond(res,200,analyze(store.db.prepare("SELECT id,prompt_id,question,provider,model,status,mentioned,competitor_hits,citations FROM samples WHERE workspace_id=? AND created_at>=? ORDER BY created_at DESC").all(id,new Date(Date.now()-30*86400000).toISOString())));
  return respond(res,200,resource==="prompts"?store.prompts(id):resource==="samples"?store.history(id):store.stats(id));
 }
 if(req.method==="POST"&&resource==="prompts")return respond(res,201,store.addPrompt(id,await body(req)));
 if(req.method==="POST"&&(resource==="samples"||resource==="jobs")){
  const d=await body(req);if(d.action==="cancel")return respond(res,200,queue.cancel(id,d.id));
  if(d.action==="retry"){const j=queue.retry(id,d.id);respond(res,202,j);wake();return}
  if(!configuredProviders().includes(d.provider))throw Error("Provider not configured");
  const j=queue.enqueue(id,d.promptId,d.provider);respond(res,202,j);wake();return
 }
 if(req.method==="POST"&&resource==="schedules"){const d=await body(req);if(d.action==="stop")return respond(res,200,queue.stop(id,d.id));if(!configuredProviders().includes(d.provider))throw Error("Provider not configured");return respond(res,201,queue.schedule(id,d))}
 return respond(res,405,{error:"Method not allowed"});
 }catch(e){const msg=e instanceof SyntaxError?"Invalid JSON":String(e.message);return respond(res,400,{error:/SQLITE|database|constraint/i.test(msg)?"Database operation failed":msg.slice(0,200)})}
}).listen(port,"127.0.0.1",()=>console.log("GEO/OS live monitor: "+origin));
