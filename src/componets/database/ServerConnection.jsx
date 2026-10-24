import {useState} from "react";
import {FiArrowLeft,FiCheckCircle,FiServer,FiWifi} from "react-icons/fi";
import {useLanguage} from "../../i18n/translation";
import {connectServer,defaultApiPort,lastServer,normalizeServerAddress,testServer} from "../../sevices/remote";
import "../../pages/LoginPage/DatabaseLoginPage.css";
import "./ServerConnection.css";
export default function ServerConnection({onBack,onConnect,initialMode,backLabel}) {
 const {t,direction}=useLanguage(),last=lastServer();
 const [address,setAddress]=useState(last.address),[mode,setMode]=useState(initialMode||last.mode),[port,setPort]=useState(""),[workspaceId,setWorkspaceId]=useState(last.workspaceId||""),[username,setUsername]=useState(""),[password,setPassword]=useState(""),[busy,setBusy]=useState(false),[status,setStatus]=useState(""),[healthy,setHealthy]=useState(false);
 const run=async(connect)=>{setBusy(true);setStatus("");setHealthy(false);try{const normalized=normalizeServerAddress(address,port,mode);if(connect)onConnect(await connectServer({address:normalized,workspaceId:mode==="cloud"?workspaceId:"",username,password,mode}));else{await testServer(normalized);setStatus("net.connected");setHealthy(true)}}catch(error){setStatus(`net.error.${error.message}`)}finally{setBusy(false)}};
 return <main className="database-login-page" dir={direction}><button className="database-login-back" onClick={onBack}><FiArrowLeft/>{backLabel||t("backToDatabases")}</button><section className="database-login-panel server-connection"><div className="database-login-icon"><FiServer/></div><h1>{t("connectToServer")}</h1><p>{t("net.connectionHint")}</p><form onSubmit={event=>{event.preventDefault();void run(true)}}>
  <label>{t("net.mode")}<select value={mode} onChange={e=>{setMode(e.target.value);setHealthy(false)}}><option value="lan">{t("net.lan")}</option><option value="cloud">{t("net.cloud")}</option></select></label>
  <label>{t("net.address")}<input autoFocus dir="ltr" placeholder={mode==="lan"?"192.168.1.10":"https://api.example.com"} value={address} required onChange={e=>{setAddress(e.target.value);setHealthy(false)}} autoComplete="url"/></label>
  <label>{t("net.port")}<input dir="ltr" type="number" min="1" max="65535" placeholder={mode==="lan"?String(defaultApiPort):"443"} value={port} onChange={e=>{setPort(e.target.value);setHealthy(false)}}/></label>
  {mode==="cloud"&&<label>{t("net.workspace")}<input dir="ltr" value={workspaceId} onChange={e=>setWorkspaceId(e.target.value.trim())} required pattern="[a-fA-F0-9]{24}" autoComplete="organization"/></label>}
  <button className="products-secondary-button" type="button" disabled={busy||!address.trim()} onClick={()=>run(false)}><FiWifi/>{t("net.test")}</button>
  <label>{t("net.username")}<input value={username} onChange={e=>setUsername(e.target.value)} required autoComplete="username"/></label><label>{t("password")}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required autoComplete="current-password"/></label>
  {status&&<p role="status" className={healthy?"server-feedback":"database-login-error"}>{healthy&&<FiCheckCircle/>}{t(status)===status?t("net.error.server_unavailable"):t(status)}</p>}
  <button type="submit" className="database-login-submit" disabled={busy}>{t(busy?"loading":"connect")}</button>
 </form></section></main>;
}
