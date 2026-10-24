import {useEffect,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
import {FiCopy,FiGlobe,FiPlay,FiRefreshCw,FiServer,FiSquare} from "react-icons/fi";
import {useLanguage} from "../../i18n/translation";
import {useAccess} from "../../context/AccessContext";
import {authenticateServer,defaultApiPort,testServer,remoteSession} from "../../sevices/remote";
import {isServerDatabase} from "../../sevices/users";
import ServerConnection from "../../componets/database/ServerConnection";
import {registerExistingDatabase} from "../../sevices/database";
import "./NetworkSettings.css";
export const networkError=(t,error)=>{const key=`net.error.${typeof error==="string"?error:error?.message}`;return t(key)===key?t("net.error.server_unavailable"):t(key)};
export default function NetworkSettings({database}) {
 const {t}=useLanguage(),{can}=useAccess();
 const remote=isServerDatabase(database);
 const remoteAddress=database.serverAddress?new URL(database.serverAddress):null;
 const [info,setInfo]=useState(null),[host,setHost]=useState(remoteAddress?.hostname||""),[port,setPort]=useState(remoteAddress?(remoteAddress.port||(remoteAddress.protocol==="https:"?"443":"80")):String(defaultApiPort)),[mode,setMode]=useState(database.mode==="cloud"?"cloud":"lan"),[username,setUsername]=useState(""),[password,setPassword]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState(""),[connectOpen,setConnectOpen]=useState(false);
 const [remoteHealthy,setRemoteHealthy]=useState(false);
 const [offline,setOffline]=useState(null),[syncUsername,setSyncUsername]=useState(""),[syncPassword,setSyncPassword]=useState("");
 const refresh=async()=>{if(!isTauri())return;const data=await invoke("get_network_status");setInfo(data);if(!remote){setHost(current=>current||data.host||data.addresses[0]?.address||"");setPort(String(data.port));}};
 useEffect(()=>{
  let active=true;
  const check=async()=>{try{if(remote&&database.serverAddress){await testServer(database.serverAddress);if(active)setRemoteHealthy(true)}else await refresh()}catch{if(active&&remote)setRemoteHealthy(false)}};
  void check();const timer=setInterval(check,10000);
  const online=()=>void check();window.addEventListener("online",online);window.addEventListener("focus",online);
  return()=>{active=false;clearInterval(timer);window.removeEventListener("online",online);window.removeEventListener("focus",online)};
 },[database.serverAddress,remote]);
 useEffect(()=>{if(!remote&&isTauri())invoke("get_offline_sync_status",{databasePath:database.databasePath}).then(setOffline).catch(()=>setOffline(null))},[database.databasePath,remote]);
 const run=async(action)=>{if(busy)return;setBusy(true);setError("");setMessage("");try{
  if(action==="start"){
   const result=await invoke("start_network_server",{databasePath:database.databasePath,identifier:username,password,host,port:Number(port)});await refresh();
   setHost(result.address?new URL(result.address).hostname:host);setPassword("");setMessage("net.running");
  }else if(action==="stop"){await invoke("stop_network_server",{serverToken:remote?remoteSession()?.token:null});await refresh();setMessage("net.stopped");}
  else if(action==="copy"){const address=database.serverAddress||info?.address||`http://${host}:${port}`;if(navigator.clipboard)await navigator.clipboard.writeText(address);else{const input=document.createElement("textarea");input.value=address;document.body.append(input);input.select();const copied=document.execCommand("copy");input.remove();if(!copied)throw Error("clipboard_failed");}setMessage("net.copied");}
  else if(action==="test"){await testServer(database.serverAddress||info?.address||`http://${host}:${port}`);setRemoteHealthy(Boolean(database.serverAddress));setMessage("net.connected");}
  else if(action==="offline"){
   const session=remoteSession();if(!session)throw Error("authentication_required");
   const snapshot=await invoke("initialize_offline_database",{serverAddress:session.address,serverToken:session.token,workspaceId:session.organization.id,password});
   await registerExistingDatabase(snapshot.databasePath);setPassword("");setMessage("net.offlineReady");
  }
  else if(action==="sync"){
   let session=remoteSession();if(!session||session.organization.id!==offline.workspaceId){await authenticateServer({address:offline.serverAddress,workspaceId:offline.workspaceId,username:syncUsername,password:syncPassword,mode:new URL(offline.serverAddress).protocol==="https:"?"cloud":"lan"});session=remoteSession()}
   await invoke("sync_offline_database",{databasePath:database.databasePath,serverToken:session.token});setOffline(await invoke("get_offline_sync_status",{databasePath:database.databasePath}));setSyncPassword("");setMessage("net.syncDone");
  }
  else await refresh();
 }catch(reason){setError(networkError(t,reason));}finally{setBusy(false)}};
 useEffect(()=>{
  if(!offline)return;let cancelled=false,timer,attempt=0;const delays=[5000,15000,30000,60000];
  const sync=async()=>{const session=remoteSession();if(cancelled||!navigator.onLine||!session||session.organization.id!==offline.workspaceId)return;try{await invoke("sync_offline_database",{databasePath:database.databasePath,serverToken:session.token});if(!cancelled){setOffline(await invoke("get_offline_sync_status",{databasePath:database.databasePath}));attempt=0}}catch{if(!cancelled&&attempt<delays.length)timer=setTimeout(sync,delays[attempt++])}};
  const online=()=>{attempt=0;void sync()};window.addEventListener("online",online);void sync();return()=>{cancelled=true;clearTimeout(timer);window.removeEventListener("online",online)};
 },[offline?.workspaceId,database.databasePath]);
 if(connectOpen)return <ServerConnection initialMode={mode} onBack={()=>setConnectOpen(false)} onConnect={()=>setConnectOpen(false)}/>;
 const running=info?.running||remoteHealthy,address=database.serverAddress||info?.address||(host?`http://${host}:${port}`:"");
 return <section className="settings-card network-card"><header><div className="network-heading"><span><FiServer/></span><div><h2>{t("net.title")}</h2><p>{t("net.subtitle")}</p></div></div><span className={`network-status ${running?"running":""}`}>{t(running?"net.running":"net.stopped")}</span></header>
  {remote&&<p className="network-current"><FiGlobe/><strong>{t("net.current")}</strong><bdi>{database.serverAddress}</bdi></p>}
  <div className="network-fields"><label>{t("net.mode")}<select value={mode} onChange={e=>setMode(e.target.value)}><option value="lan">{t("net.lan")}</option><option value="cloud">{t("net.cloud")}</option></select></label>
   {mode==="lan"&&<><label>{t("net.ip")}{remote?<input dir="ltr" readOnly value={host}/>:<select value={host} onChange={e=>setHost(e.target.value)} disabled={running||!info}><option value="">{t("net.selectAdapter")}</option>{info?.addresses.map(entry=><option key={`${entry.name}-${entry.address}`} value={entry.address}>{entry.address} · {entry.name}</option>)}</select>}</label><label>{t("net.port")}<input dir="ltr" type="number" min="1" max="65535" value={port} onChange={e=>setPort(e.target.value)} disabled={running||remote}/></label></>}
  </div>
  {address&&<div className="network-address"><code dir="ltr">{address}</code><button type="button" className="products-secondary-button" onClick={()=>run("copy")} disabled={busy}><FiCopy/>{t("net.copy")}</button></div>}
  <div className="network-actions"><button className="products-secondary-button" disabled={busy||!address} onClick={()=>run("test")}><FiRefreshCw/>{t("net.test")}</button><button className="products-secondary-button" onClick={()=>setConnectOpen(true)}><FiGlobe/>{t("connectToServer")}</button>
   {info?.running&&can("settings","edit")&&<button className="products-secondary-button" disabled={busy} onClick={()=>run("stop")}><FiSquare/>{t("net.stop")}</button>}
  </div>
  {remote&&can("settings","edit")&&<form className="network-start" onSubmit={e=>{e.preventDefault();run("offline")}}><p>{t("net.offlineHint")}</p><label>{t("password")}<input type="password" minLength="4" required value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label><button className="products-primary-button" disabled={busy||!remoteHealthy}><FiCopy/>{t("net.downloadOffline")}</button></form>}
  {mode==="lan"&&!remote&&can("settings","edit")&&<form className="network-start" onSubmit={e=>{e.preventDefault();run("start")}}><p>{t("net.startHint")}</p><div className="network-fields"><label>{t("databaseLoginIdentifier")}<input value={username} required onChange={e=>setUsername(e.target.value)} autoComplete="username"/></label><label>{t("password")}<input type="password" value={password} required onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label></div><button className="products-primary-button" disabled={busy||running||!host||!isTauri()}><FiPlay/>{t(busy?"loading":"net.start")}</button>{!isTauri()&&<p>{t("net.desktopOnly")}</p>}</form>}
  {offline&&<form className="network-start" onSubmit={e=>{e.preventDefault();run("sync")}}><h3>{t("net.syncTitle")}</h3><p>{t("net.workspace")}: <bdi>{offline.workspaceId}</bdi><br/>{t("net.pending")}: {offline.pending} · {t("net.lastSync")}: <bdi>{offline.lastSyncAt||"—"}</bdi></p><div className="network-fields"><label>{t("net.username")}<input required value={syncUsername} onChange={e=>setSyncUsername(e.target.value)} autoComplete="username"/></label><label>{t("password")}<input required type="password" value={syncPassword} onChange={e=>setSyncPassword(e.target.value)} autoComplete="current-password"/></label></div><button className="products-primary-button" disabled={busy}><FiRefreshCw/>{t("net.syncNow")}</button></form>}
  {message&&<p role="status" className="server-feedback">{t(message)}</p>}{error&&<p role="alert" className="products-page-error">{error}</p>}
 </section>;
}
