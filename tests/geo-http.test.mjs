import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
test("HTTP login, CSRF, roles, workspace isolation and logout", {timeout:20000},async()=>{
 const socket=createServer();socket.listen(0,"127.0.0.1");await once(socket,"listening");const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const root=mkdtempSync(join(tmpdir(),"geo-http-")),origin="http://127.0.0.1:"+port;
 const child=spawn(process.execPath,["geo/server.mjs"],{env:{...process.env,GEO_PORT:String(port),GEO_DB:join(root,"db.sqlite"),GEO_ADMIN_USER:"admin",GEO_ADMIN_PASSWORD:"test-password-12345",DEEPSEEK_API_KEY:"",PERPLEXITY_API_KEY:""},stdio:["ignore","pipe","pipe"]});
 let stderr="";child.stderr.on("data",x=>stderr+=x);
 async function call(path,data,cookie="",sameOrigin=true){return fetch(origin+path,{method:data===undefined?"GET":"POST",headers:{...(cookie?{cookie}:{}),...(data===undefined?{}:{"content-type":"application/json",...(sameOrigin?{origin}:{})})},...(data===undefined?{}:{body:JSON.stringify(data)})})}
 try{let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin)).ok){ready=true;break}}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100))}assert.ok(ready,stderr);
 assert.equal((await call("/api/workspaces")).status,401);assert.equal((await call("/api/login",{username:"admin",password:"test-password-12345"},"",false)).status,403);
 async function login(username){const r=await call("/api/login",{username,password:"test-password-12345"});assert.equal(r.status,200);const cookie=r.headers.get("set-cookie");assert.match(cookie,/HttpOnly/);return cookie.split(";")[0]}
 const admin=await login("admin");assert.equal((await call("/api/users",{username:"viewer",password:"test-password-12345"},admin)).status,201);
 const w=await (await call("/api/workspaces",{name:"A",brand:"Acme"},admin)).json(),path="/api/workspaces/"+w.id;const viewer=await login("viewer");
 assert.equal((await call(path+"/prompts",undefined,viewer)).status,404);
 assert.equal((await call(path+"/members",{username:"viewer",role:"viewer"},admin)).status,200);
 assert.equal((await call(path+"/prompts",undefined,viewer)).status,200);
 assert.equal((await call(path+"/prompts",{question:"Which tool?"},viewer)).status,403);
 assert.equal((await call(path+"/prompts",{question:"Which tool?"},admin)).status,201);
 assert.equal((await call(path+"/audit",undefined,viewer)).status,403);
 assert.equal((await call("/api/users",{username:"bad",password:"test-password-12345"},viewer)).status,403);
 assert.equal((await call(path+"/members",{username:"viewer",action:"remove"},admin)).status,200);
 assert.equal((await call(path+"/prompts",undefined,viewer)).status,404);
 assert.equal((await call("/api/logout",{},admin)).status,200);assert.equal((await call("/api/workspaces",undefined,admin)).status,401);
 }finally{if(child.exitCode===null){child.kill();await once(child,"exit")}rmSync(root,{recursive:true,force:true})}
});
