import {invoke} from "@tauri-apps/api/core";
import {serverRequest} from "./remote";
export const isServerDatabase=database=>String(database?.databasePath||"").startsWith("remote:");
async function local(command,args){try{return await invoke(command,args)}catch(error){if((typeof error==="string"?error:error?.message)==="authentication_required")window.dispatchEvent(new Event("local-session-expired"));throw error}}
export const currentLocalUser=databasePath=>local("get_local_current_user",{databasePath});
export function listUsers(database){return isServerDatabase(database)?serverRequest("/users"):local("list_local_users",{databasePath:database.databasePath});}
export function saveUser(database,id,payload){
 return isServerDatabase(database)?serverRequest(id?`/users/${id}`:"/users",{method:id?"PUT":"POST",body:JSON.stringify(payload)}):local("save_local_user",{databasePath:database.databasePath,id:id||null,payload});
}
export function deleteUser(database,id,revision){
 return isServerDatabase(database)?serverRequest(`/users/${id}`,{method:"DELETE",headers:{"If-Match":String(revision)}}):local("delete_local_user",{databasePath:database.databasePath,id,revision});
}
