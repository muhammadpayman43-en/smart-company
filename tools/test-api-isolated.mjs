// Uses the already-installed MongoDB binary with a disposable workspace dbPath.
// This avoids changing or consuming disk space in the real MongoDB service.
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import {createServer,createConnection} from "node:net";
import {fileURLToPath} from "node:url";
import path from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url));
const executable=process.env.MONGOD_BINARY||"C:\\Program Files\\MongoDB\\Server\\8.2\\bin\\mongod.exe";
if(!existsSync(executable))throw Error("Set MONGOD_BINARY to the existing mongod executable; no package will be installed.");
const parent=path.join(root,".license-issuer");await mkdir(parent,{recursive:true});
const folder=await mkdtemp(path.join(parent,"test-runtime-")),db=path.join(folder,"mongo"),temp=path.join(folder,"temp");await mkdir(db);await mkdir(temp);
const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,"127.0.0.1",()=>{const value=probe.address().port;probe.close(()=>resolve(value))})});
const mongo=spawn(executable,["--bind_ip","127.0.0.1","--port",String(port),"--dbpath",db,"--wiredTigerCacheSizeGB","0.25","--logpath",path.join(folder,"mongo.log")],{windowsHide:true,stdio:"ignore"});
const exited=new Promise(resolve=>mongo.once("exit",resolve));
try{
 let ready=false;
 for(let n=0;n<100;n++){
  if(mongo.exitCode!==null)throw Error("Temporary MongoDB exited before startup");
  ready=await new Promise(resolve=>{const socket=createConnection({host:"127.0.0.1",port});socket.on("connect",()=>{socket.destroy();resolve(true)});socket.on("error",()=>resolve(false))});
  if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(!ready)throw Error("Temporary MongoDB did not start");
 const child=spawn(process.execPath,["--test"],{cwd:path.join(root,"server"),windowsHide:true,stdio:"inherit",env:{...process.env,SPICE_TEST_MONGO_URL:`mongodb://127.0.0.1:${port}`,TEMP:temp,TMP:temp}});
 process.exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??1))});
}finally{
 mongo.kill();await exited;
 const resolved=path.resolve(folder);if(path.dirname(resolved)!==path.resolve(parent)||!path.basename(resolved).startsWith("test-runtime-"))throw Error("Unsafe temporary cleanup path");
 await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
