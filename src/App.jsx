import { useEffect, useState } from "react";
import "./App.css";
import LoginPage from "./pages/LoginPage/LoginPage";
import Dashboard from "./pages/Dashboard/Dashboard";
import {disconnectServer} from "./sevices/remote";
import {AccessProvider} from "./context/AccessContext";
import {CurrencyProvider} from "./context/CurrencyContext";
import {invoke,isTauri} from "@tauri-apps/api/core";

function App() {
  const [database, setDatabase] = useState(null);
  const logout=async()=>{if(isTauri())await invoke("clear_local_session").catch(()=>{});disconnectServer();setDatabase(null)};
  useEffect(()=>{
    const connected=event=>setDatabase(event.detail),expired=()=>setDatabase(current=>String(current?.databasePath).startsWith("remote:")?null:current);
    const localExpired=()=>setDatabase(current=>String(current?.databasePath).startsWith("remote:")?current:null);
    window.addEventListener("remote-session-connected",connected);window.addEventListener("remote-session-expired",expired);
    window.addEventListener("local-session-expired",localExpired);
    return()=>{window.removeEventListener("remote-session-connected",connected);window.removeEventListener("remote-session-expired",expired);window.removeEventListener("local-session-expired",localExpired)};
  },[]);

  if (database) {
    return <AccessProvider key={database.databasePath} database={database}><CurrencyProvider database={database}><Dashboard key={database.databasePath} database={database} onLogout={logout} /></CurrencyProvider></AccessProvider>;
  }

  return <LoginPage onEnterDashboard={setDatabase} />;
}

export default App;
