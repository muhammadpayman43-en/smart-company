// Actual React UI and service routing; the Tauri bridge and HTTP replies are
// isolated fixtures. Real SQLite authorization is tested in local_users.rs.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createServer as portProbe} from "node:net";
import {createServer} from "vite";
const root=process.cwd(),folder=await mkdtemp(path.join(tmpdir(),"spice-local-users-ui-"));
const port=await new Promise(resolve=>{const probe=portProbe();probe.listen(0,"127.0.0.1",()=>{const value=probe.address().port;probe.close(()=>resolve(value))})});
const vite=await createServer({server:{port:0,strictPort:false}});await vite.listen();const url=`http://127.0.0.1:${vite.httpServer.address().port}`;
const browser=spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",["--headless=new","--disable-gpu","--no-first-run",`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(folder,"profile")}`,"about:blank"],{windowsHide:true,stdio:"ignore"});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let socket,checks=0;
try{
 let tabs;for(let i=0;i<100;i++){try{tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();break}catch{await delay(100)}}
 socket=new WebSocket(tabs.find(t=>t.type==="page").webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener("open",resolve,{once:true}));
 let id=0;const pending=new Map(),errors=[];
 socket.addEventListener("message",event=>{const value=JSON.parse(event.data);if(value.method==="Runtime.exceptionThrown")errors.push(value.params.exceptionDetails);const task=pending.get(value.id);if(task){pending.delete(value.id);clearTimeout(task.timer);value.error?task.reject(Error(value.error.message)):task.resolve(value.result)}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>reject(Error("CDP timeout")),15000);pending.set(current,{resolve,reject,timer});socket.send(JSON.stringify({id:current,method,params}))});
 const evaluate=async expression=>{const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
 const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await delay(50)}throw Error("UI timeout: "+expression)};
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.addScriptToEvaluateOnNewDocument",{source:`
 window.isTauri=true;window.__calls=[];window.__http=[];window.__normal=false;
 window.__owner={id:'local-owner',fullName:'Local Owner',username:'owner',role:'super_admin',active:true,isOwner:true,permissions:{},revision:1};
 window.__users=[window.__owner];window.__current=window.__owner;
 const db={databasePath:'X:/isolated-users.sqlite3',databaseName:'Isolated users',companyName:'Test pharmacy',administratorName:'Local Owner'};
 window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{
 window.__calls.push({command,args});
 if(command==='list_local_databases')return [db];
 if(command==='authenticate_local_database'){window.__current=window.__normal?{id:'normal',fullName:'Normal Viewer',username:'normal',role:'viewer',active:true,permissions:{},revision:1}:window.__owner;return {...db,user:window.__current};}
 if(command==='clear_local_session')return;
 if(command==='get_local_current_user')return window.__current;
 if(command==='list_local_users')return {users:window.__users};
 if(command==='save_local_user'){const user={...args.payload,id:args.id||'added-user',revision:(args.payload.revision||0)+1};delete user.password;window.__users=window.__users.filter(u=>u.id!==user.id).concat(user);return {user};}
 if(command==='delete_local_user'){window.__users=window.__users.filter(u=>u.id!==args.id);return {deleted:true};}
 if(command==='plugin:dialog|confirm')return true;
 if(command==='plugin:dialog|message')return 'Ok';
 if(command==='get_app_settings')return {usdToAfnRate:70,expiryAlertValue:30,expiryAlertUnit:'days'};
 if(command==='get_company_info')return {companyName:'Test pharmacy'};
 if(command==='get_network_status')return {running:false,addresses:[],port:3000};
 if(command==='get_reports_data'||command==='get_dashboard_data')return {today:'2026-10-22',overview:{stats:{today:0,sales:0,purchases:0,gross:0,receivables:0,medicines:0},weekly:Array.from({length:7},(_,i)=>({date:'2026-10-'+(16+i),total:0,count:0})),mix:{settled:0,credit:0}}};
 if(['list_medicines','list_medicine_formulas','list_pharmaceutical_companies','list_expiry_alerts'].includes(command))return [];
 throw Error('Unexpected native command: '+command);
 }};
 const original=window.fetch;window.fetch=async(input,options={})=>{
 if(!String(input).startsWith('http://127.0.0.1:15999'))return original(input,options);
 const pathname=new URL(input).pathname;window.__http.push(pathname);let body;
 const user={...window.__owner,id:'server-owner',fullName:'Server Owner'},organization={id:'server-org',name:'Central pharmacy'};
 if(pathname==='/health')body={apiVersion:1,capabilities:{centralDatabase:true,rbac:true}};
 else if(pathname.endsWith('/auth/login'))body={token:'isolated-token',user,organization};
 else if(pathname.endsWith('/auth/me'))body={user,organization};
 else if(pathname.endsWith('/users'))body={users:[user]};
 else if(pathname.endsWith('/get_app_settings'))body={data:{usdToAfnRate:70,expiryAlertValue:30,expiryAlertUnit:'days'},revision:1};
 else if(pathname.endsWith('/get_revision'))body={data:1,revision:1};
 else if(pathname.endsWith('/get_dashboard_data'))body={data:{today:'2026-10-22',overview:{stats:{today:0,sales:0,purchases:0,gross:0,receivables:0,medicines:0},weekly:Array.from({length:7},(_,i)=>({date:'2026-10-'+(16+i),total:0,count:0})),mix:{settled:0,credit:0}}},revision:1};
 else body={data:[],revision:1};
 return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 };
 `});
 const fill=async(selector,value)=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 await send("Page.navigate",{url});await wait('document.querySelector(".local-database-item")');await evaluate("localStorage.setItem('language','en')");
 await evaluate('document.querySelector(".local-database-item").click()');await wait('document.querySelector("#database-login-identifier")');
 await fill('#database-login-identifier','owner');await fill('#database-login-password','1234');await evaluate('document.querySelector(".database-login-submit").click()');await wait('document.querySelector(".sidebar-settings")');checks++;
 await evaluate('document.querySelector(".sidebar-settings").click()');await wait('document.querySelector(".users-card .products-primary-button")');checks++;
 assert.equal(await evaluate('window.__http.length'),0);assert.ok(await evaluate('document.querySelector(".users-card").textContent.includes("SQLite")'));checks++;
 await evaluate('document.querySelector(".users-card header button").click()');await wait('document.querySelector(".users-form")');
 await fill('.users-form .network-fields label:nth-child(1) input','Browser local user');await fill('.users-form .network-fields label:nth-child(2) input','browser_user');await fill('.users-form input[type=password]','test-password-123');await fill('.users-form .network-fields label:nth-child(4) input','test-password-123');
 await evaluate('document.querySelector(".permission-table tbody tr:nth-child(2) td:nth-child(3) input").click()');
 await evaluate('document.querySelector(".users-form button[type=submit],.users-form footer .products-primary-button").click()');await wait('!document.querySelector(".users-form")&&document.querySelectorAll(".users-card tbody tr").length===2');
 const saved=await evaluate('window.__calls.find(c=>c.command==="save_local_user").args');assert.equal(saved.id,null);assert.equal(saved.payload.role,'viewer');assert.equal(saved.payload.permissions.products.create,true);checks++;
 await evaluate('document.querySelectorAll(".users-card tbody tr")[1].querySelector("button").click()');await wait('document.querySelector(".users-form")');await fill('.users-form .network-fields label:nth-child(1) input','Edited local user');await evaluate('document.querySelector(".users-form footer .products-primary-button").click()');await wait('document.querySelector(".users-card tbody").textContent.includes("Edited local user")');checks++;
 await evaluate('document.querySelectorAll(".users-card tbody tr")[1].querySelectorAll("button")[1].click()');await wait('window.__users.find(u=>u.id==="added-user")?.active===false');checks++;
 await evaluate('document.querySelectorAll(".users-card tbody tr")[1].querySelectorAll("button")[1].click()');await wait('window.__users.find(u=>u.id==="added-user")?.active===true');checks++;
 await evaluate('document.querySelectorAll(".users-card tbody tr")[1].querySelectorAll("button")[2].click()');await wait('document.querySelectorAll(".users-card tbody tr").length===1');checks++;
 const callsBefore=await evaluate('window.__calls.filter(c=>["list_local_users","save_local_user","delete_local_user"].includes(c.command)).length');
 await evaluate(`(async()=>{const remote=await import('/src/sevices/remote.js');await remote.connectServer({address:'http://127.0.0.1:15999',username:'server-owner',password:'test',mode:'lan'});})()`);
 await wait('document.querySelector(".sidebar-settings")');await evaluate('document.querySelector(".sidebar-settings").click()');await wait('document.querySelector(".users-card tbody")?.textContent.includes("Server Owner")');
 assert.equal(await evaluate('window.__calls.filter(c=>["list_local_users","save_local_user","delete_local_user"].includes(c.command)).length'),callsBefore);assert.ok(await evaluate('window.__http.includes("/api/v1/users")'));checks++;
 await evaluate('window.dispatchEvent(new Event("local-session-expired"))');assert.ok(await evaluate('Boolean(document.querySelector(".users-card"))'));checks++;
 // Sign out of central mode and sign into SQLite without reloading the app.
 const cleared=await evaluate('window.__calls.filter(c=>c.command==="clear_local_session").length');
 await evaluate('document.querySelector(".header-profile-button").click()');await wait('document.querySelector(".header-profile-popover")');await evaluate('document.querySelector(".header-profile-popover > button:last-child").click()');await wait('document.querySelector(".local-database-item")');
 assert.equal(await evaluate('window.__calls.filter(c=>c.command==="clear_local_session").length'),cleared+1);checks++;
 await evaluate('window.__normal=true;document.querySelector(".local-database-item").click()');await wait('document.querySelector("#database-login-identifier")');await fill('#database-login-identifier','normal');await fill('#database-login-password','test-password-123');await evaluate('document.querySelector(".database-login-submit").click()');await wait('document.querySelector(".dashboard-shell")');await wait('document.querySelector(".products-page")');
 assert.equal(await evaluate('Boolean(document.querySelector(".sidebar-settings"))'),false);assert.equal(await evaluate('Boolean(document.querySelector(".users-card"))'),false);checks++;
 await evaluate('window.dispatchEvent(new Event("remote-session-expired"))');assert.ok(await evaluate('Boolean(document.querySelector(".dashboard-shell"))'));checks++;
 assert.equal(errors.length,0,JSON.stringify(errors));checks++;
 console.log(`${checks} local/server UI checks passed. React was real; native/HTTP fixtures were mocked. SQLite permissions were tested separately in Rust.`);
}finally{
 socket?.close();browser.kill();await vite.close();await delay(500);
 const resolved=path.resolve(folder);if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('spice-local-users-ui-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
