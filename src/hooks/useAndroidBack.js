import {useEffect,useRef} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {exit,onBackButtonPress} from "@tauri-apps/api/app";
import {confirm} from "@tauri-apps/plugin-dialog";

export function useAndroidBack(handler){
 const latest=useRef(handler);latest.current=handler;
 useEffect(()=>{if(!isTauri())return;let listener,cancelled=false;onBackButtonPress(()=>latest.current?.()).then(value=>{if(cancelled)value.unregister();else listener=value}).catch(()=>{});return()=>{cancelled=true;listener?.unregister();};},[]);
}

export function closeTopDialog(){
 const dialogs=[...document.querySelectorAll('[role="dialog"],.modal-overlay')].filter(node=>node.getClientRects().length);
 const dialog=dialogs.at(-1);if(!dialog)return false;
 const close=dialog.querySelector('.product-dialog-close,.close-btn,.mobile-drawer-close')||dialog.querySelector(':scope > header button');
 if(close){close.click();return true}return false;
}

export async function confirmAndroidExit(language="fa"){
 const copy={en:["Exit Application","Are you sure you want to exit the application?","Exit","Cancel"],fa:["خروج از برنامه","آیا مطمئن هستید که می‌خواهید از برنامه خارج شوید؟","خروج","لغو"],ps:["له اپلېکېشن څخه وتل","ایا ډاډه یاست چې له اپلېکېشن څخه وځئ؟","وتل","لغوه"]}[language]||[];
 if(await confirm(copy[1],{title:copy[0],kind:"warning",okLabel:copy[2],cancelLabel:copy[3]}))await exit(0);
}
