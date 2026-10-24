import assert from "node:assert/strict";
import {before,after,test} from "node:test";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir,networkInterfaces} from "node:os";
import path from "node:path";
import request from "supertest";
import mongoose from "mongoose";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {createInterface} from "node:readline";
import WebSocket from "ws";

const name=`spice_central_test_${randomUUID().replaceAll("-","")}`;
process.env.MONGODB_URI=`${process.env.SPICE_TEST_MONGO_URL||"mongodb://127.0.0.1:27017"}/${name}`;
process.env.JWT_SECRET="isolated-central-tests-secret-over-32-characters";
process.env.SQLITE_DATA_DIR=await mkdtemp(path.join(tmpdir(),"spice-central-test-"));
process.env.SPICE_LICENSE_TEST_DIR=process.env.SQLITE_DATA_DIR;
const machine="SM-"+"A".repeat(43);
let app,closeWorkers,User,Organization,AuditLog,ChatMessage,attachChat,owner,viewer,operator,company,formula,medicine,purchase,sale,base,listener,chat;
const password="central-test-password";
const rpc=(token,command,args={},key=randomUUID(),expected)=>{
 let call=request(app).post(`/api/v1/data/${command}`).auth(token,{type:"bearer"}).set("X-Spice-Machine",machine).set("Idempotency-Key",key).send({args});
 if(expected!==undefined)call=call.set("If-Match",String(expected));return call;
};
const createUser=(role,username,permissions={})=>request(app).post("/api/v1/users").auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).send({fullName:`${role} Test`,username,password,active:true,role,permissions});
const login=username=>request(app).post("/api/v1/auth/login").send({username,password});
before(async()=>{
 ({app}=await import("../src/app.js"));({closeWorkers}=await import("../src/database.js"));({User}=await import("../src/models/User.js"));({Organization}=await import("../src/models/Organization.js"));({AuditLog}=await import("../src/models/AuditLog.js"));({ChatMessage}=await import("../src/models/ChatMessage.js"));({attachChat}=await import("../src/chat.js"));
 await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:5000});await Promise.all([User.init(),Organization.init(),AuditLog.init(),ChatMessage.init()]);
 const response=await request(app).post("/api/v1/auth/register").send({companyName:"Isolated Central Test",firstName:"Central",lastName:"Owner",phone:"+93700123456",username:`owner_${randomUUID().slice(0,8)}`,password});
 assert.equal(response.status,201,JSON.stringify(response.body));owner=response.body;
 const host=Object.values(networkInterfaces()).flat().find(entry=>entry?.family==="IPv4"&&!entry.internal)?.address||"127.0.0.1";
 listener=await new Promise(resolve=>{const server=app.listen(0,host,()=>resolve(server))});chat=attachChat(listener);base=`http://${host}:${listener.address().port}`;
}, {timeout:30000});
after(async()=>{
 closeWorkers?.();chat?.close();if(listener)await new Promise(resolve=>listener.close(resolve));
 if(mongoose.connection.name===name&&name.startsWith("spice_central_test_"))await mongoose.connection.dropDatabase();
 await mongoose.disconnect();await new Promise(resolve=>setTimeout(resolve,500));
 if(path.dirname(path.resolve(process.env.SQLITE_DATA_DIR))!==path.resolve(tmpdir()))throw Error("Unsafe test directory");
 await rm(process.env.SQLITE_DATA_DIR,{recursive:true,force:true,maxRetries:5,retryDelay:300});
});
test("LAN interface exposes versioned health but refuses unauthenticated database operations",async()=>{
 const health=await(await fetch(`${base}/health`)).json();assert.equal(health.apiVersion,1);assert.equal(health.capabilities.centralDatabase,true);
 const denied=await fetch(`${base}/api/v1/data/list_medicines`,{method:"POST",headers:{"Content-Type":"application/json"},body:'{"args":{}}'});assert.equal(denied.status,401);
});
test("registration creates a central SQLite database without exposing its path or password",async()=>{
 assert.equal(owner.user.role,"super_admin");assert.equal(owner.user.passwordHash,undefined);assert.equal(owner.organization.databasePath,undefined);
 const response=await rpc(owner.token,"list_medicines");assert.equal(response.status,200);assert.deepEqual(response.body.data,[]);
});
test("workspace snapshot is authenticated, scoped and has a server revision",async()=>{
 const denied=await request(app).get("/api/v1/snapshot/status");assert.equal(denied.status,401);
 const status=await request(app).get("/api/v1/snapshot/status").auth(owner.token,{type:"bearer"});assert.equal(status.status,200,JSON.stringify(status.body));assert.equal(status.body.workspaceId,owner.organization.id);assert.ok(Number.isInteger(status.body.revision));
 const snapshot=await request(app).get("/api/v1/snapshot").auth(owner.token,{type:"bearer"});assert.equal(snapshot.status,200);assert.equal(snapshot.headers["x-workspace-id"],owner.organization.id);assert.equal(snapshot.headers["content-type"],"application/vnd.sqlite3");assert.match(snapshot.headers["content-disposition"],/\.sqlite/);
});
test("users have server-hashed passwords, custom permissions and working JWT logins",async()=>{
 const a=await createUser("viewer",`viewer_${name}`),b=await createUser("sales_operator",`sales_${name}`);assert.equal(a.status,201,JSON.stringify(a.body));assert.equal(b.status,201);
 viewer={...a.body,...(await login(a.body.user.username)).body};operator={...b.body,...(await login(b.body.user.username)).body};
 assert.ok(viewer.token&&operator.token);const stored=await User.findById(viewer.user.id).select("+passwordHash");assert.notEqual(stored.passwordHash,password);assert.match(stored.passwordHash,/^\$2/);
 assert.equal((await rpc(viewer.token,"create_medicine",{payload:{}})).status,403);assert.equal((await rpc(operator.token,"delete_sale",{saleId:randomUUID()})).status,403);assert.equal((await request(app).get("/api/v1/users").auth(operator.token,{type:"bearer"}).set("X-Spice-Machine",machine)).status,403);
});
test("authenticated users exchange one persisted real-time message without duplicates",async()=>{
 const connect=token=>new Promise((resolve,reject)=>{const socket=new WebSocket(`${base.replace("http","ws")}/api/v1/chat?token=${encodeURIComponent(token)}`);const timer=setTimeout(()=>reject(Error("chat ready timeout")),5000);socket.on("message",raw=>{if(JSON.parse(raw).type==="ready"){clearTimeout(timer);resolve(socket)}});socket.once("error",reject)});
 const [sender,receiver]=await Promise.all([connect(owner.token),connect(viewer.token)]),clientId=randomUUID();
 try{const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("chat timeout")),5000);receiver.on("message",raw=>{const value=JSON.parse(raw);if(value.type==="message"&&value.message.clientId===clientId){clearTimeout(timer);resolve(value.message)}})});sender.send(JSON.stringify({type:"send",recipientId:viewer.user.id,clientId,text:"سلام"}));assert.equal((await received).text,"سلام");sender.send(JSON.stringify({type:"send",recipientId:viewer.user.id,clientId,text:"سلام"}));await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await ChatMessage.countDocuments({clientId}),1);const history=await request(app).get(`/api/v1/chat/history/${owner.user.id}`).auth(viewer.token,{type:"bearer"});assert.equal(history.status,200);assert.equal(history.body.messages.filter(row=>row.clientId===clientId).length,1);}finally{sender.close();receiver.close()}
});
test("existing product commands create real shared catalog records",async()=>{
 const c=await rpc(owner.token,"create_pharmaceutical_company",{payload:{name:"Central Supplier",country:"Afghanistan",address:"",email:"",phone:""}});assert.equal(c.status,200,JSON.stringify(c.body));company=c.body.data;
 const f=await rpc(owner.token,"create_medicine_formula",{payload:{name:"Paracetamol",indication:"Test",sideEffects:""}});assert.equal(f.status,200,JSON.stringify(f.body));formula=f.body.data;
 const m=await rpc(owner.token,"create_medicine",{payload:{name:"Central Medicine",barcode:"998899",formulaId:formula.id,companyId:company.id,unitsPerPack:10,purchasePrice:0,salePrice:0,purchasePriceBasis:"unit",batchNumber:"LOT-1",gaugeNumber:""}});assert.equal(m.status,200,JSON.stringify(m.body));medicine=m.body.data;
});
test("cash deposits and purchases update stock, supplier debt and the central register atomically",async()=>{
 const deposit=await rpc(owner.token,"save_cash_document",{payload:{id:randomUUID(),expectedRevision:null,kind:"DEPOSIT",title:"Opening",person:"",category:"DEPOSIT",amount:10000,currency:"AFN",date:"2026-10-21",paymentSource:"cash",notes:""}});assert.equal(deposit.status,200,JSON.stringify(deposit.body));
 const p=await rpc(owner.token,"create_purchase",{payload:{companyId:company.id,invoiceNumber:"PUR-LAN-1",purchaseDate:"2026-10-21",discount:0,paidAmount:100,paymentSource:"cash",notes:"",items:[{medicineId:medicine.id,quantity:2,unitType:"pack",unitPrice:100,salePrice:150,expiryDate:"2028-12-31"}]}});assert.equal(p.status,200,JSON.stringify(p.body));purchase=p.body.data;assert.equal(purchase.total,200);assert.equal(purchase.remainingAmount,100);
 const catalog=await rpc(operator.token,"list_medicines");assert.equal(catalog.body.data[0].stockQuantity,20);
 const account=await rpc(owner.token,"get_company_purchase_account",{companyId:company.id});assert.equal(account.status,200);assert.ok(JSON.stringify(account.body.data).includes("100"));
});
test("a second LAN client sells into the same database and repeat requests do not duplicate stock or cash",async()=>{
 const key=randomUUID(),args={payload:{customerId:null,saleDatetime:"2026-10-21T10:30:00",paymentMethod:"cash",discount:0,paidAmount:30,notes:"LAN second client",items:[{medicineId:medicine.id,quantity:2,unitType:"unit",unitPrice:15,discount:0}]}};
 const send=()=>fetch(`${base}/api/v1/data/create_sale`,{method:"POST",headers:{"Content-Type":"application/json","X-Spice-Machine":machine,Authorization:`Bearer ${operator.token}`,"Idempotency-Key":key},body:JSON.stringify({args})});
 const a=await send(),b=await send();assert.equal(a.status,200,await a.clone().text());assert.equal(b.status,200);const first=await a.json(),second=await b.json();assert.equal(first.data.id,second.data.id);sale=first.data;
 const list=await rpc(owner.token,"list_sales");assert.equal(list.body.data.length,1);const inventory=await rpc(owner.token,"list_medicines");assert.equal(inventory.body.data[0].stockQuantity,18);
 const cash=await rpc(owner.token,"get_cash_register");const balance=cash.body.data.transactions.reduce((sum,row)=>sum+(row.direction==="IN"?row.amount_afn:-row.amount_afn),0);assert.equal(balance,9930);
 const conflict=await rpc(operator.token,"create_sale",{payload:{...args.payload,notes:"different"}},key);assert.equal(conflict.status,409);
});
test("simultaneous clients cannot oversell or produce partial failed sales",async()=>{
 const args={payload:{customerId:null,saleDatetime:"2026-10-21T11:30:00",paymentMethod:"cash",discount:0,paidAmount:0,notes:"Concurrency",items:[{medicineId:medicine.id,quantity:12,unitType:"unit",unitPrice:15,discount:0}]}};
 const responses=await Promise.all([rpc(operator.token,"create_sale",args),rpc(operator.token,"create_sale",args)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
 assert.equal(responses.find(r=>r.status===400).body.error,"sale_insufficient_stock");const stock=await rpc(owner.token,"list_medicines");assert.equal(stock.body.data[0].stockQuantity,6);const list=await rpc(owner.token,"list_sales");assert.equal(list.body.data.length,2);
});
test("an expired batch cannot be sold",async()=>{
 const p=await rpc(owner.token,"create_purchase",{payload:{companyId:company.id,invoiceNumber:"OLD",purchaseDate:"2026-10-21",discount:0,paidAmount:0,paymentSource:"other",notes:"",items:[{medicineId:medicine.id,quantity:1,unitType:"pack",unitPrice:100,salePrice:150,expiryDate:"2020-01-01"}]}});assert.equal(p.status,200);
 const s=await rpc(operator.token,"create_sale",{payload:{customerId:null,saleDatetime:"2026-10-21T12:30:00",paymentMethod:"cash",discount:0,paidAmount:0,notes:"Expired",items:[{medicineId:medicine.id,quantity:10,unitType:"unit",unitPrice:15,discount:0}]}});assert.equal(s.status,400);assert.match(s.body.error,/stock|expired/);
});
test("stale revisions reject updates without overwriting another client's work",async()=>{
 const list=await rpc(owner.token,"list_medicines"),old=list.body.revision;
 const input={...medicine,name:"First edit",id:medicine.id};delete input._apiRevision;
 const first=await rpc(owner.token,"update_medicine",{payload:input},randomUUID(),old);assert.equal(first.status,200,JSON.stringify(first.body));
 const second=await rpc(owner.token,"update_medicine",{payload:{...input,name:"Stale edit"}},randomUUID(),old);assert.equal(second.status,409);assert.equal(second.body.error,"revision_conflict");
});
test("lost replies and a restarted SQLite worker retain durable idempotency",async()=>{
 const id=randomUUID(),key=randomUUID(),args={payload:{id,expectedRevision:null,kind:"DEPOSIT",title:"Lost reply",person:"",category:"DEPOSIT",amount:25,currency:"AFN",date:"2026-10-21",paymentSource:"cash",notes:""}};
 const response=await fetch(`${base}/api/v1/data/save_cash_document`,{method:"POST",headers:{"Content-Type":"application/json","X-Spice-Machine":machine,Authorization:`Bearer ${owner.token}`,"Idempotency-Key":key},body:JSON.stringify({args})});assert.equal(response.status,200);await response.body.cancel();
 closeWorkers();await new Promise(resolve=>setTimeout(resolve,150));
 const retry=await rpc(owner.token,"save_cash_document",args,key);assert.equal(retry.status,200,JSON.stringify(retry.body));assert.equal(retry.body.data.id,id);
 const register=await rpc(owner.token,"get_cash_register");assert.equal(register.body.data.transactions.filter(row=>row.source_id===id).length,1);
});
test("cash document edits and deletes reverse their effects once and enforce document revisions",async()=>{
 const id=randomUUID(),input={id,expectedRevision:null,kind:"EXPENSE",title:"Test expense",person:"",category:"rent",amount:20,currency:"AFN",date:"2026-10-21",paymentSource:"cash",notes:""};
 const created=await rpc(owner.token,"save_cash_document",{payload:input});assert.equal(created.status,200);
 const changed=await rpc(owner.token,"save_cash_document",{payload:{...input,expectedRevision:1,amount:30}});assert.equal(changed.status,200);assert.equal(changed.body.data.revision,2);
 const stale=await rpc(owner.token,"save_cash_document",{payload:{...input,expectedRevision:1,amount:100}});assert.equal(stale.status,409);
 const removed=await rpc(owner.token,"delete_cash_document",{id,expectedRevision:2});assert.equal(removed.status,200);
 const register=await rpc(owner.token,"get_cash_register");assert.ok(!register.body.data.transactions.some(row=>row.source_id===id));assert.ok(!register.body.data.documents.some(row=>row.id===id));
});
test("invalid requests, missing idempotency and unauthorized financial snapshots are rejected",async()=>{
 const missing=await request(app).post("/api/v1/data/create_sale").auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).send({args:{payload:{}}});assert.equal(missing.status,400);assert.equal(missing.body.error,"request_id_required");
 const invalid=await rpc(owner.token,"create_purchase",{payload:{}});assert.equal(invalid.status,400);
 for(const payload of ["bad",42,null,[]])assert.equal((await rpc(owner.token,"create_sale",{payload})).status,400);
 assert.equal((await rpc(owner.token,"list_medicines")).status,200);
 assert.equal((await rpc(operator.token,"get_reports_data")).status,403);assert.equal((await rpc(viewer.token,"get_cash_register")).status,403);
 assert.equal((await rpc(owner.token,"arbitrary_sql",{sql:"SELECT * FROM admin_users"})).status,404);
});
test("organization scoping prevents users reading or mutating a different organization's records",async()=>{
 const response=await request(app).post("/api/v1/auth/register").send({companyName:"Other tenant",firstName:"Other",lastName:"Owner",phone:"+93700987654",password});assert.equal(response.status,201,JSON.stringify(response.body));
 const list=await rpc(response.body.token,"list_medicines",{databasePath:"C:/secret.sqlite3",organizationId:owner.organization.id});assert.equal(list.status,200);assert.equal(list.body.data.length,0);
 const get=await rpc(response.body.token,"get_sale",{saleId:sale.id});assert.equal(get.status,404);
});
test("permission overrides deny direct API access; inactive accounts and old tokens cannot log in",async()=>{
 let target=(await request(app).get("/api/v1/users").auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine)).body.users.find(u=>u.id===operator.user.id);
 const update={fullName:target.fullName,username:target.username,role:target.role,active:true,permissions:{sales:{create:false}},revision:target.revision};
 const changed=await request(app).put(`/api/v1/users/${target.id}`).auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).send(update);assert.equal(changed.status,200);
 assert.equal((await rpc(operator.token,"list_sales")).status,401);
 const refreshed=(await login(target.username)).body;assert.equal((await rpc(refreshed.token,"create_sale",{payload:{}})).status,403);
 const disabled=await request(app).put(`/api/v1/users/${target.id}`).auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).send({...update,active:false,revision:changed.body.user.revision});assert.equal(disabled.status,200);assert.equal((await login(target.username)).status,401);
});
test("password resets invalidate existing sessions and never return password hashes",async()=>{
 const target=(await request(app).get("/api/v1/users").auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine)).body.users.find(user=>user.id===viewer.user.id);
 const changed=await request(app).put(`/api/v1/users/${target.id}`).auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).send({fullName:target.fullName,username:target.username,role:target.role,active:true,permissions:{},revision:target.revision,password:"new-central-password"});assert.equal(changed.status,200);assert.equal(changed.body.user.passwordHash,undefined);
 assert.equal((await login(target.username)).status,401);assert.equal((await rpc(viewer.token,"list_medicines")).status,401);
 const fresh=await request(app).post("/api/v1/auth/login").send({username:target.username,password:"new-central-password"});assert.equal(fresh.status,200);
});
test("desktop server bootstrap starts and stops the existing API without resetting shared data",async()=>{
 const database=await Organization.findById(owner.organization.id).select("+databasePath");
 const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,"127.0.0.1",()=>{const value=probe.address().port;probe.close(()=>resolve(value))})});
 const child=spawn(process.execPath,["src/server.js","--desktop-server"],{cwd:path.resolve("."),windowsHide:true,env:{...process.env,PORT:String(port),API_HOST:"127.0.0.1",LAN_ENABLED:"true",SERVER_MODE:"lan"},stdio:["pipe","pipe","pipe"]});child.stderr.resume();
 try{
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Server bootstrap timed out")),10000);createInterface({input:child.stdout}).on("line",line=>{try{const value=JSON.parse(line);if(value.ready){clearTimeout(timer);resolve(value)}}catch{}});child.on("error",error=>{clearTimeout(timer);reject(error)});child.on("exit",code=>{if(code){clearTimeout(timer);reject(Error(`Server exited ${code}`))}})});
  child.stdin.end(JSON.stringify({databasePath:database.databasePath,organizationKey:randomUUID(),companyName:"Test",firstName:"Central",lastName:"Owner",phone:"+93700123456",password})+"\n");
  const running=await ready;assert.equal(running.username,owner.user.username);assert.equal((await fetch(running.address+"/health")).status,200);
  const response=await fetch(running.address+"/api/v1/data/list_medicines",{method:"POST",headers:{"Content-Type":"application/json","X-Spice-Machine":machine,Authorization:`Bearer ${owner.token}`},body:'{"args":{}}'});assert.equal(response.status,200);assert.equal((await response.json()).data[0].id,medicine.id);
 }finally{await new Promise(resolve=>{child.once("exit",resolve);child.kill();if(child.exitCode!==null)resolve()});}
 await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});
test("cloud API refuses plaintext and accepts HTTPS only through an explicitly trusted proxy",async()=>{
 const {env}=await import("../src/config/env.js");env.SERVER_MODE="cloud";
 try{
  const plain=await request(app).post("/api/v1/auth/login").send({username:viewer.user.username,password:"new-central-password"});assert.equal(plain.status,426);
  const spoofed=await request(app).post("/api/v1/auth/login").set("X-Forwarded-Proto","https").send({username:viewer.user.username,password:"new-central-password"});assert.equal(spoofed.status,426);
  app.set("trust proxy","loopback");const secure=await request(app).post("/api/v1/auth/login").set("X-Forwarded-Proto","https").send({username:viewer.user.username,password:"new-central-password"});assert.equal(secure.status,200);
 }finally{env.SERVER_MODE="lan";app.set("trust proxy",false)}
});
test("the last active super admin is protected, including concurrent demotions",async()=>{
 const single=await request(app).delete(`/api/v1/users/${owner.user.id}`).auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).set("If-Match",String(owner.user.revision));assert.equal(single.status,409);assert.equal(single.body.error,"last_super_admin");
 const second=await createUser("super_admin",`second_${name}`);assert.equal(second.status,201);
 const make=user=>({fullName:user.fullName,username:user.username,role:"admin",active:true,permissions:{},revision:user.revision});
 const responses=await Promise.all([request(app).put(`/api/v1/users/${owner.user.id}`).auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).send(make(owner.user)),request(app).put(`/api/v1/users/${second.body.user.id}`).auth(owner.token,{type:"bearer"}).set("X-Spice-Machine",machine).send(make(second.body.user))]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(await User.countDocuments({organizationId:owner.organization.id,role:"super_admin",active:{$ne:false}}),1);
});
test("authentication and permission changes are recorded without storing plaintext passwords in audits",async()=>{
 const logs=await AuditLog.find({organizationId:owner.organization.id}).lean();assert.ok(logs.some(l=>l.action==="login"));assert.ok(logs.some(l=>l.action==="user_permissions_changed"));assert.ok(!JSON.stringify(logs).includes(password));
});
test("a normal user can be deleted with the correct revision while stale deletion is rejected",async()=>{
 const admin=await User.findOne({organizationId:owner.organization.id,role:"super_admin",active:{$ne:false}});
 const token=(await login(admin.username)).body.token;assert.ok(token);
 const created=await request(app).post("/api/v1/users").auth(token,{type:"bearer"}).set("X-Spice-Machine",machine).send({fullName:"Disposable User",username:`remove_${name}`,password,role:"viewer",active:true,permissions:{}});assert.equal(created.status,201);
 const wrong=await request(app).delete(`/api/v1/users/${created.body.user.id}`).auth(token,{type:"bearer"}).set("X-Spice-Machine",machine).set("If-Match","99");assert.equal(wrong.status,409);
 const removed=await request(app).delete(`/api/v1/users/${created.body.user.id}`).auth(token,{type:"bearer"}).set("X-Spice-Machine",machine).set("If-Match","1");assert.equal(removed.status,200);
 assert.equal(await User.countDocuments({_id:created.body.user.id}),0);assert.equal((await login(created.body.user.username)).status,401);
});
test("repeated login requests are rate limited",async()=>{
 let response;for(let i=0;i<31;i++)response=await request(app).post("/api/v1/auth/login").send({});assert.equal(response.status,429);assert.equal(response.body.error,"too_many_attempts");assert.ok(Number(response.headers["retry-after"])>0);
});
