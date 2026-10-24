import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {existsSync} from "node:fs";
import {mkdir,realpath,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
export const workerPath=process.env.DATABASE_WORKER || path.join(root,"src-tauri","target","debug",process.platform==="win32"?"spice-management-app.exe":"spice-management-app");
export const workerAvailable=()=>existsSync(workerPath);
export async function canonicalDatabasePath(filename){const resolved=await realpath(filename);return process.platform==="win32"?resolved.replace(/^\\\\\?\\/,"").toLowerCase():resolved;}
const workers=new Map();
class DatabaseWorker {
 constructor(databasePath){
  this.pending=new Map();this.counter=0;
  this.child=spawn(workerPath,["--database-worker"],{windowsHide:true,env:{...process.env,SPICE_DATABASE_PATH:databasePath},stdio:["pipe","pipe","pipe"]});
  createInterface({input:this.child.stdout}).on("line",line=>{let response;try{response=JSON.parse(line)}catch{return}const task=this.pending.get(response.id);if(!task)return;clearTimeout(task.timer);this.pending.delete(response.id);response.ok?task.resolve(response.result):task.reject(Object.assign(new Error(response.error),{code:response.error}));});
  let stderr="";this.child.stderr.on("data",chunk=>{stderr+=chunk;});
  const fail=()=>{const detail=stderr.trim();if(detail)console.error("Database worker unavailable:",detail);if(workers.get(databasePath)===this)workers.delete(databasePath);for(const task of this.pending.values()){clearTimeout(task.timer);task.reject(Object.assign(new Error("database_unavailable"),{status:503}));}this.pending.clear();};
  this.child.stdin.on("error",fail);
  this.child.on("error",fail);this.child.on("exit",fail);
 }
 request(payload){return new Promise((resolve,reject)=>{const id=++this.counter;const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error("request_timeout"),{status:504}));},20000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...payload,id})+"\n",error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(Object.assign(new Error("database_unavailable"),{status:503}));}});});}
 close(){return new Promise(resolve=>{const timer=setTimeout(()=>{this.child.kill();resolve()},5000);this.child.once("exit",()=>{clearTimeout(timer);resolve()});this.child.stdin.end()})}
}
export function databaseRequest(databasePath,payload){
 if(!databasePath||!workerAvailable())throw Object.assign(new Error("database_unavailable"),{status:503});
 if(!workers.has(databasePath))workers.set(databasePath,new DatabaseWorker(databasePath));
 return workers.get(databasePath).request(payload);
}
export function closeWorkers(){for(const worker of workers.values())worker.child.stdin.end();workers.clear();}
export async function closeDatabaseWorker(databasePath){const worker=workers.get(databasePath);if(!worker)return;workers.delete(databasePath);await worker.close();}
export async function createDatabaseSnapshot(databasePath){
 const directory=await mkdtemp(path.join(tmpdir(),"smart-company-snapshot-"));
 const destination=path.join(directory,"company.sqlite");
 try {await new Promise((resolve,reject)=>{const child=spawn(workerPath,["--database-backup",databasePath,destination],{windowsHide:true,stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",chunk=>error+=chunk);child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error(error||"snapshot_failed")));});return {path:destination,cleanup:()=>rm(directory,{recursive:true,force:true})};}
 catch(error){await rm(directory,{recursive:true,force:true});throw error}
}
export async function replaceDatabaseSnapshot(databasePath,snapshotPath,workspaceId,revision){
 await closeDatabaseWorker(databasePath);
 await new Promise((resolve,reject)=>{const child=spawn(workerPath,["--database-replace",snapshotPath,databasePath,workspaceId,String(revision)],{windowsHide:true,stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",chunk=>error+=chunk);child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error(error||"snapshot_failed")));});
}
export async function initializeDatabase(organization,input){
 const directory=path.resolve(process.env.SQLITE_DATA_DIR||path.join(root,"server","data"),organization.id);
 await mkdir(directory,{recursive:true});
 const payload={firstName:input.firstName,lastName:input.lastName,adminPhone:input.phone,password:input.password,confirmPassword:input.password,companyName:input.companyName,companyAddress:"",officePhone:input.phone,secondaryPhone:"",companyEmail:"",databaseName:"central",dbPath:directory};
 return new Promise((resolve,reject)=>{
  const child=spawn(workerPath,["--database-init"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});let output="";
  const timer=setTimeout(()=>{child.kill();reject(new Error("database_unavailable"))},20000);
  child.stdout.on("data",chunk=>output+=chunk);child.stderr.resume();child.on("error",()=>{clearTimeout(timer);reject(new Error("database_unavailable"))});
  child.on("exit",async()=>{clearTimeout(timer);try{const result=JSON.parse(output);if(!result.ok)throw Error(result.error);resolve(await canonicalDatabasePath(result.data.databasePath))}catch{reject(new Error("database_unavailable"))}});
  child.stdin.end(JSON.stringify(payload)+"\n");
 });
}
