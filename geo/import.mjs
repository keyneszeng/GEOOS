import {resolve4} from "node:dns/promises";
import {request as httpsRequest} from "node:https";
import {isIP} from "node:net";
import {randomUUID} from "node:crypto";
const now=()=>new Date().toISOString();
// Restrict outbound connections to globally routable IPv4. IPv6, redirects and arbitrary ports are not supported.
export function publicIPv4(ip){
 if(isIP(ip)!==4)return false;
 const [a,b,c]=ip.split(".").map(Number);
 return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
export function allowedUrl(value,hosts){
 if(typeof value!=="string"||value.length>2000)throw Error("Invalid URL");
 const u=new URL(value);
 if(u.protocol!=="https:"||u.username||u.password||u.port||u.search||u.hash||isIP(u.hostname)||!hosts.includes(u.hostname))throw Error("URL must use an explicitly allowed HTTPS hostname, without credentials, query or fragment");
 return u;
}
export async function fetchPublicPage(value,hosts,{resolve=resolve4,request=httpsRequest,xml=false,userAgent="GEOOS-Evidence/0.1"}={}){
 const u=allowedUrl(value,hosts);
 // Resolve once and pin the actual connection to the checked address (DNS rebinding protection).
 let timer;const ips=await Promise.race([resolve(u.hostname),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("DNS timeout")),5000)})]).finally(()=>clearTimeout(timer));
 if(!ips.length||ips.some(ip=>!publicIPv4(ip)))throw Error("Non-public DNS address");
 const ip=ips[0];
 return new Promise((resolve,reject)=>{
  let done=false,t;const finish=(err,result)=>{if(done)return;done=true;clearTimeout(t);err?reject(err):resolve(result)};
  const req=request(u,{method:"GET",family:4,autoSelectFamily:false,agent:false,headers:{"User-Agent":userAgent,"Accept":xml?"text/html,text/plain,application/xml,text/xml":"text/html,text/plain","Accept-Encoding":"identity"},lookup:(_host,opts,cb)=>opts.all?cb(null,[{address:ip,family:4}]):cb(null,ip,4)},res=>{
   const type=String(res.headers["content-type"]||"").toLowerCase();
   if(res.statusCode!==200||!(xml?/^(text\/html|text\/plain|application\/xml|text\/xml)(?:;|$)/:/^(text\/html|text\/plain)(?:;|$)/).test(type)||res.headers["content-encoding"]&&res.headers["content-encoding"]!=="identity"||/charset\s*=\s*["']?(?!utf-8\b|utf8\b)[a-z0-9-]+/i.test(type)){res.destroy();finish(Error("Only HTTP 200 uncompressed UTF-8 HTML or text is supported"));return}
   let n=0;const chunks=[];
   res.on("data",chunk=>{n+=chunk.length;if(n>512*1024){res.destroy();finish(Error("Page exceeds 512 KiB"));return}chunks.push(chunk)});
   res.on("error",e=>finish(e));res.on("aborted",()=>finish(Error("Response aborted")));
   res.on("end",()=>{try{finish(null,{url:u.href,type,robotsHeader:String(res.headers["x-robots-tag"]||"").slice(0,1000),text:new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))})}catch(e){finish(e)}});
  });
  t=setTimeout(()=>{req.destroy();finish(Error("Page request timeout"))},15000);req.on("error",e=>finish(e));req.end();
 });
}
export function textSnapshot(page){
 let text=page.text;
 if(page.type.startsWith("text/html")){
  // Deliberately lossy text-only extraction; never render/execute remote HTML.
  text=text.replace(/<!--[\s\S]*?-->/g," ").replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi," ").replace(/<[^>]*>/g," ").replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g,x=>({"&nbsp;":" ","&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"}[x]));
 }
 text=text.replace(/\s+/g," ").trim();
 if(!text)throw Error("No extractable text");
 return {excerpt:[...text].slice(0,3000).join(""),truncated:[...text].length>3000};
}
export function openImporter(store,knowledge,{hosts=[],fetchPage=fetchPublicPage,limit=10}={}){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid import daily limit");
 const {db}=store;
 db.exec("CREATE TABLE IF NOT EXISTS geo_imports(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),url TEXT NOT NULL,state TEXT NOT NULL,evidence_id TEXT REFERENCES geo_evidence(id),truncated INTEGER,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);");
 db.prepare("UPDATE geo_imports SET state='interrupted',finished_at=?,error='Interrupted' WHERE state='running'").run(now());
 let busy=false;
 async function run(w,input){
  if(input.confirm!==true||!store.workspace(w))throw Error("Explicit authorized public-page confirmation required");
  const u=allowedUrl(input.url,hosts);
  if(busy)throw Error("Import busy");
  const id=randomUUID(),t=now();
  if(!db.prepare("INSERT INTO geo_imports(id,workspace_id,url,state,created_at) SELECT ?,?,?,'running',? WHERE (SELECT count(*) FROM geo_imports WHERE created_at>=?)<?").run(id,w,u.href,t,t.slice(0,10),limit).changes)throw Error("Daily import limit reached");
  busy=true;
  try{const p=await fetchPage(u.href,hosts);if(p.url!==u.href)throw Error("Redirect not allowed");const x=textSnapshot(p);const e=knowledge.addEvidence(w,{title:u.hostname+" "+u.pathname.slice(0,150),url:u.href,excerpt:x.excerpt,visibility:"public"});db.prepare("UPDATE geo_imports SET state='success',evidence_id=?,truncated=?,finished_at=? WHERE id=?").run(e.id,Number(x.truncated),now(),id)}catch{db.prepare("UPDATE geo_imports SET state='failed',error='Public page fetch or extraction failed',finished_at=? WHERE id=?").run(now(),id)}finally{busy=false}
  return db.prepare("SELECT * FROM geo_imports WHERE id=?").get(id);
 }
 const recent=w=>db.prepare("SELECT * FROM geo_imports WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50").all(w);
 return {run,recent,hosts,limit};
}
