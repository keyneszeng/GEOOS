import {DatabaseSync} from "node:sqlite";
import {chmodSync,existsSync,statSync,copyFileSync,constants,mkdirSync,rmSync,mkdtempSync} from "node:fs";
import {resolve,dirname,join} from "node:path";
import {pathToFileURL} from "node:url";
function sourceFile(path){if(!existsSync(path)||!statSync(path).isFile())throw Error("Source database not found");return resolve(path)}
function check(db){const integrity=db.prepare("PRAGMA integrity_check").all();if(integrity.length!==1||integrity[0].integrity_check!=="ok"||db.prepare("PRAGMA foreign_key_check").all().length)throw Error("Database integrity check failed");if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get())throw Error("Not a GEO database")}
export function snapshot(source,destination,{restore=false}={}){
 process.umask(0o077);
 const src=sourceFile(source),dest=resolve(destination);
 if(existsSync(dest)||existsSync(dest+"-wal")||existsSync(dest+"-shm"))throw Error("Destination or sidecar exists; never overwrite");
 mkdirSync(dirname(dest),{recursive:true,mode:0o700});
 const dir=mkdtempSync(join(dirname(dest),".geo-snapshot-")),temp=join(dir,"snapshot.sqlite");
 let db;
 try{db=new DatabaseSync(src,{readOnly:true});db.exec("PRAGMA busy_timeout=5000");check(db);db.prepare("VACUUM INTO ?").run(temp);db.close();db=null;
  const staged=new DatabaseSync(temp);try{check(staged);if(restore){const has=t=>staged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);staged.exec("BEGIN IMMEDIATE");try{
   if(has("geo_sessions"))staged.exec("DELETE FROM geo_sessions");
   if(has("geo_schedules"))staged.exec("UPDATE geo_schedules SET enabled=0");
   if(has("geo_jobs"))staged.exec("UPDATE geo_jobs SET state='cancelled',error='Cancelled during restore',finished_at=datetime('now') WHERE state='queued'");
   staged.exec("COMMIT")}catch(e){staged.exec("ROLLBACK");throw e}check(staged)}}finally{staged.close()}
  copyFileSync(temp,dest,constants.COPYFILE_EXCL);chmodSync(dest,0o600);
  return dest;
 }finally{db?.close();rmSync(dir,{recursive:true,force:true})}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,src,dest]=process.argv.slice(2);
 if(!["backup","restore"].includes(mode)||!src||!dest){console.error("Usage: node geo/backup.mjs backup|restore SOURCE DESTINATION");process.exitCode=1}
 else try{console.log(snapshot(src,dest,{restore:mode==="restore"}))}catch(e){console.error(e.message);process.exitCode=1}
}
