import {useEffect,useRef} from "react";
export function useRemoteRefresh(database,refresh){
 const callback=useRef(refresh);callback.current=refresh;
 useEffect(()=>{
  if(!String(database.databasePath).startsWith("remote:"))return;
  let pending=false;
  const reload=()=>{if(pending)return;pending=true;Promise.resolve().then(()=>callback.current()).catch(()=>{}).finally(()=>{pending=false})};
  window.addEventListener("remote-data-changed",reload);window.addEventListener("focus",reload);
  return()=>{window.removeEventListener("remote-data-changed",reload);window.removeEventListener("focus",reload)};
 },[database.databasePath]);
}
