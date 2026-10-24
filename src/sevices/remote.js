import {mutationCommands} from "../shared/permissions";
import {request as apiRequest} from "./api";
import {invoke,isTauri} from "@tauri-apps/api/core";
function clientRequestId(){
 if(crypto.randomUUID)return crypto.randomUUID();
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,"0")).join("");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const LAST_SERVER="sm_last_server";
let session=null,revision=null;
const pending=new Map();
export const defaultApiPort=Number(import.meta.env.VITE_API_PORT||3000);
const privateHost=host=>host==="localhost"||host==="127.0.0.1"||/^10\.\d+\.\d+\.\d+$/.test(host)||/^192\.168\.\d+\.\d+$/.test(host)||/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
export function normalizeServerAddress(value,port,mode="lan") {
 let input=value.trim();if(!input)throw Error("invalid_server_address");
 const hasScheme=/^https?:\/\//i.test(input);
 if(!hasScheme)input=`${mode==="lan"?"http":"https"}://${input}`;
 let url;try{url=new URL(input)}catch{throw Error("invalid_server_address")}
 if(url.username||url.password||url.search||url.hash||!["http:","https:"].includes(url.protocol)||!["/","/api/v1","/api/v1/"].includes(url.pathname))throw Error("invalid_server_address");
 if(url.protocol!=="https:"&&(mode!=="lan"||!privateHost(url.hostname)))throw Error("https_required");
 if(mode==="cloud"&&url.protocol!=="https:")throw Error("https_required");
 if(port!==undefined&&port!==""){if(!/^\d+$/.test(String(port))||Number(port)<1||Number(port)>65535)throw Error("invalid_server_port");url.port=String(port)}
 else if(!hasScheme&&!url.port&&mode==="lan")url.port=String(defaultApiPort);
 return url.origin;
}
async function request(address,path,{token,timeout=15000,...options}={}) {
 try{return await apiRequest(path,{baseUrl:address,token,timeout,...options})}
 catch(error){if(error.status===401&&token&&session?.address===address&&session.token===token){session=null;window.dispatchEvent(new Event("remote-session-expired"));}throw error}
}
export async function testServer(address) {
 const health=await request(address,"/health",{timeout:8000});
 if(health.apiVersion!==1||!health.capabilities?.centralDatabase||!health.capabilities?.rbac)throw Error("api_incompatible");
 return health;
}
export function lastServer(){try{return JSON.parse(localStorage.getItem(LAST_SERVER))||{address:"",mode:"lan"}}catch{return {address:"",mode:"lan"}}}
export async function connectServer({address,workspaceId,username,password,mode="lan"}) {
 const result=await authenticateServer({address,workspaceId,username,password,mode});address=result.address;
 if(isTauri())await invoke("clear_local_session");
 const database={databasePath:`remote:${result.organization.id}`,databaseName:result.organization.name,administratorName:result.user.fullName,mode,serverAddress:address,workspaceId:result.organization.id,user:result.user};
 window.dispatchEvent(new CustomEvent("remote-session-connected",{detail:database}));
 return database;
}
export async function authenticateServer({address,workspaceId,username,password,mode="cloud"}){
 address=normalizeServerAddress(address,undefined,mode);await testServer(address);const result=await request(address,"/api/v1/auth/login",{method:"POST",body:JSON.stringify({organizationId:workspaceId||undefined,username,password,central:true})});session={address,token:result.token,user:result.user,organization:result.organization};revision=null;pending.clear();localStorage.setItem(LAST_SERVER,JSON.stringify({address,mode,workspaceId:result.organization.id}));return {...result,address};
}
export function disconnectServer(){session=null;revision=null;pending.clear();}
export function remoteSession(){return session;}
export function serverRequest(path,options={}){if(!session)throw Error("authentication_required");return request(session.address,`/api/v1${path}`,{token:session.token,...options});}
export async function remoteInvoke(command,args) {
 if(!session)throw Error("authentication_required");
 const activeSession=session;
 const clean=structuredClone(args||{});delete clean.databasePath;if(clean.payload)delete clean.payload.databasePath;
 const write=mutationCommands.has(command),fingerprint=JSON.stringify({user:session.user.id,command,args:clean});
 let attempt=pending.get(fingerprint);
 if(write&&!attempt){attempt={id:clientRequestId(),revision:clean.expectedRevision??clean.payload?.expectedApiRevision??revision};pending.set(fingerprint,attempt)}
 // A retry after a timeout retains its key and original revision. No write is retried automatically.
 const editing=/^(update_|delete_|return_|cancel_|save_app_settings)/.test(command)||(command==="create_sale"&&clean.payload?.saleId);
 try {
  const result=await serverRequest(`/data/${command}`,{method:"POST",headers:{...(write?{"Idempotency-Key":attempt.id}:{}),...(editing&&attempt?.revision!=null?{"If-Match":String(attempt.revision)}:{})},body:JSON.stringify({args:clean})});
  if(session!==activeSession)throw Error("authentication_required");
  if(!result||!Object.hasOwn(result,"data")||!Number.isSafeInteger(result.revision)||result.revision<0)throw Object.assign(new Error("api_incompatible"),{uncertain:true});
  revision=Math.max(revision??0,result.revision);if(write)pending.delete(fingerprint);return result.data;
 }catch(error){if(write&&!error.uncertain)pending.delete(fingerprint);if(error.uncertain||[403,409].includes(error.status))window.dispatchEvent(new CustomEvent("remote-operation-error",{detail:error.status===409?"revision_conflict":error.status===403?"permission_denied":["request_timeout","connection_failed","api_incompatible"].includes(error.message)?error.message:"server_unavailable"}));throw error}
}
