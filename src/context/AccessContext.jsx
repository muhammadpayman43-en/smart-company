import {createContext,useContext,useEffect,useState} from "react";
import {accessiblePage,permits} from "../shared/permissions";
import {serverRequest,remoteInvoke} from "../sevices/remote";
import {currentLocalUser,isServerDatabase} from "../sevices/users";
const AccessContext=createContext({user:null,can:()=>false,hasPermission:()=>false,pageAllowed:()=>false});
const ScopeContext=createContext("dashboard");
export function AccessProvider({database,children}) {
 const [user,setUser]=useState(database.user||null);
 useEffect(()=>{
  setUser(database.user||null);const remote=isServerDatabase(database);
  let active=true,lastRevision=null,polling=false;
  const refresh=()=> (remote?serverRequest("/auth/me").then(result=>result.user):currentLocalUser(database.databasePath)).then(user=>{if(active)setUser(user)}).catch(error=>{if(active&&!remote&&(typeof error==="string"?error:error?.message)==="authentication_required"){setUser(null);window.dispatchEvent(new Event("local-session-expired"))}});
  const poll=async()=>{if(polling||document.hidden)return;polling=true;try{const current=await remoteInvoke("get_revision",{});if(active&&lastRevision!==null&&current!==lastRevision)window.dispatchEvent(new Event("remote-data-changed"));lastRevision=current}catch{}finally{polling=false}};
  const timer=setInterval(refresh,30000),dataTimer=remote?setInterval(poll,5000):null;void refresh();if(remote)void poll();window.addEventListener("focus",refresh);window.addEventListener("local-users-changed",refresh);
  return()=>{active=false;clearInterval(timer);clearInterval(dataTimer);window.removeEventListener("focus",refresh);window.removeEventListener("local-users-changed",refresh)};
 },[database]);
 const authorized=(module,action="view")=>Boolean(user)&&permits(user,module,action);
 return <AccessContext.Provider value={{user,hasPermission:authorized,can:authorized,pageAllowed:page=>Boolean(user)&&accessiblePage(user,page)}}>{children}</AccessContext.Provider>;
}
export const PermissionScope=({module,children})=><ScopeContext.Provider value={module}>{children}</ScopeContext.Provider>;
export function useAccess(){const access=useContext(AccessContext),module=useContext(ScopeContext);return {...access,canHere:(action="view")=>access.can(module,action)}}
