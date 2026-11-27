import {randomUUID} from "node:crypto";
import {allowedUrl,fetchPublicPage} from "./import.mjs";
import {inspectPage} from "./site-audit.mjs";
const now=()=>new Date().toISOString();
const decode=s=>s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'");
export function robotsPolicy(text){
 const groups=[],sitemaps=[];let g=null;
 for(const raw of text.split(/\r?\n/)){const line=raw.replace(/#.*$/,"").trim(),i=line.indexOf(":");if(i<0)continue;const key=line.slice(0,i).trim().toLowerCase(),value=line.slice(i+1).trim();
 if(key==="sitemap"){if(value)sitemaps.push(value);continue}
 if(key==="user-agent"){if(!g||g.started){g={agents:[],rules:[],started:false};groups.push(g)}g.agents.push(value.toLowerCase());continue}
 if(g&&["allow","disallow"].includes(key)){g.started=true;if(value)g.rules.push({allow:key==="allow",path:value})}
 }
 // Conservative: only wildcard and our actual agent groups, and never override a matching disallow.
 const relevant=groups.filter(g=>g.agents.some(a=>a==="*"||a&&"geoos-audit".includes(a)));
 return {sitemaps:sitemaps.slice(0,20),rules:relevant.flatMap(g=>g.rules),allows(path){return !relevant.some(g=>g.rules.some(r=>!r.allow&&(!r.path.startsWith("/")||r.path.includes("*")||r.path.includes("$")||r.path.includes("%")||path.includes("%")||path.startsWith(r.path))))}};
}
export function sitemapLocations(text){if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error("Unsupported sitemap declarations");const root=text.match(/<(urlset|sitemapindex)\b/i)?.[1]?.toLowerCase();if(!root)throw Error("Unsupported sitemap");const locations=[...text.matchAll(/<loc\b[^>]*>([^<]{1,2000})<\/loc\s*>/gi)].map(m=>decode(m[1].trim()));return {index:root==="sitemapindex",locations:locations.slice(0,200),truncated:locations.length>200}}
function links(text){const clean=text.replace(/<!--[\s\S]*?-->/g,"").replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,"");return [...clean.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].slice(0,200).map(m=>decode(m[1]??m[2]??m[3]))}
export function openSiteScan(store,{hosts=[],fetchPage=fetchPublicPage,limit=3,delay=()=>new Promise(r=>setTimeout(r,1000))}={}){
 const {db}=store;if(!Number.isInteger(limit)||limit<1||limit>20)throw Error("Invalid scan limit");
 db.exec("CREATE TABLE IF NOT EXISTS geo_site_scans(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),url TEXT NOT NULL,state TEXT NOT NULL,report TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);");
 db.prepare("UPDATE geo_site_scans SET state='interrupted',error='Interrupted; no replay',finished_at=? WHERE state='running'").run(now());
 const get=(w,id)=>db.prepare("SELECT * FROM geo_site_scans WHERE workspace_id=? AND id=?").get(w,id);
 const unpack=r=>({...r,report:r.report?JSON.parse(r.report):null});
 let busy=false;
 async function run(w,actor,input){if(input.confirm!==true||!store.workspace(w))throw Error("Explicit website authorization required");const seed=allowedUrl(input.url,hosts),max=input.maxPages??5;if(!Number.isInteger(max)||max<1||max>10)throw Error("Choose 1–10 pages");if(busy)throw Error("Scan busy");
 const id=randomUUID(),t=now();if(!db.prepare("INSERT INTO geo_site_scans(id,workspace_id,actor_id,url,state,created_at) SELECT ?,?,?,?,'running',? WHERE (SELECT count(*) FROM geo_site_scans WHERE created_at>=?)<?").run(id,w,actor,seed.href,t,t.slice(0,10),limit).changes)throw Error("Daily scan limit reached");busy=true;
 const report={pages:[],sitemaps:[],robots:null,blocked:[],unvisited:0,limitations:"Bounded same-origin static crawl; conservative robots handling, no browser rendering, no indexing guarantee."};
 try{const local=(v,base=seed.href)=>{try{const u=allowedUrl(new URL(v,base).href,hosts);return u.origin===seed.origin?u.href:null}catch{return null}};
 let requests=0;const fetchOne=async url=>{if(requests++)await delay();const p=await fetchPage(url,hosts,{xml:true,userAgent:"GEOOS-Audit/0.1"});if(p.url!==url)throw Error("Redirect not allowed");return p};
 // Fail closed when robots cannot be read, including 404 under the shared strict fetcher.
 const robots=await fetchOne(seed.origin+"/robots.txt");if(!robots.type.startsWith("text/plain"))throw Error("robots.txt must be readable text/plain");
 const policy=robotsPolicy(robots.text);report.robots={rules:policy.rules.slice(0,100),sitemapCount:policy.sitemaps.length};
 const permitted=u=>policy.allows(new URL(u).pathname),queue=[],seen=new Set(),smSeen=new Set();
 const add=u=>{if(u&&!seen.has(u)&&seen.size<500){seen.add(u);if(permitted(u))queue.push(u);else if(report.blocked.length<100)report.blocked.push(u)}};
 add(seed.href);const maps=[...policy.sitemaps,seed.origin+"/sitemap.xml"].map(x=>local(x)).filter(Boolean);
 while(maps.length&&smSeen.size<3){const u=maps.shift();if(smSeen.has(u)||!permitted(u))continue;smSeen.add(u);try{const p=await fetchOne(u),m=sitemapLocations(p.text);report.sitemaps.push({url:u,...m,locations:m.locations.length});for(const loc of m.locations){const v=local(loc,u);if(v){if(m.index)maps.push(v);else add(v)}}}catch{report.sitemaps.push({url:u,error:"Unreadable or unsupported sitemap"})}}
 while(queue.length&&report.pages.length<max){const u=queue.shift();try{const p=await fetchOne(u);report.pages.push({url:u,report:inspectPage(p)});for(const x of links(p.text))add(local(x,u))}catch{report.pages.push({url:u,error:"Fetch or HTML inspection failed"})}}
 report.unvisited=queue.length;report.requests=requests;db.prepare("UPDATE geo_site_scans SET state='success',report=?,finished_at=? WHERE id=?").run(JSON.stringify(report),now(),id);
 }catch{db.prepare("UPDATE geo_site_scans SET state='failed',report=?,error='Robots or site scan unavailable; stopped conservatively',finished_at=? WHERE id=?").run(JSON.stringify(report),now(),id)}finally{busy=false}return unpack(get(w,id))}
 const recent=w=>db.prepare("SELECT * FROM geo_site_scans WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10").all(w).map(unpack);
 return {run,recent,limit};
}
