import {createContext,useCallback,useContext,useEffect,useMemo,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";

const LicenseContext=createContext({status:"not_activated",deviceId:"",active:false,refresh:async()=>{},activate:async()=>{}});
export function LicenseProvider({children}){
 const [license,setLicense]=useState({status:"not_activated",deviceId:"",activationDate:"",expiryDate:"",remainingDays:0});
 const refresh=useCallback(async()=>{if(!isTauri())return license;const next=await invoke("get_license_status");setLicense(next);return next;},[]);
 const activate=useCallback(async(value)=>{const next=await invoke("activate_license",{license:value});setLicense(next);return next;},[]);
 useEffect(()=>{refresh().catch(()=>{});},[refresh]);
 const value=useMemo(()=>({...license,active:license.status==="active",refresh,activate}),[license,refresh,activate]);
 return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}
export const useLicense=()=>useContext(LicenseContext);
