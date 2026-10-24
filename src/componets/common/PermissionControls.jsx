import {useEffect} from "react";
import {useAccess} from "../../context/AccessContext";
import {pageModule} from "../../shared/permissions";

// UI affordances only. Express independently authorizes every database operation.
const controls={
 products:{create:".products-add-medicine-button,.products-import-button,.product-select-control button",edit:".medicine-row-edit",delete:".medicine-row-delete",print:".products-export-button"},
 companies:{create:".products-page-heading>.products-primary-button",edit:".company-row-actions button:nth-child(2)",delete:".company-row-actions button:nth-child(3)"},
 purchases:{create:".products-page-heading>.products-primary-button",delete:".purchase-delete-button,.purchase-return-button"},
 sales:{create:".products-page-heading .products-primary-button",delete:".purchase-delete-button,.sales-return-button"},
 customers:{create:".products-page-heading .products-primary-button",edit:".customer-row-actions button:nth-child(2),.customer-account-actions .products-primary-button,.customer-sale-body>.product-dialog-actions>.products-primary-button",delete:".customer-delete-button"},
 reports:{print:".report-table-toolbar>button"},
};
export default function PermissionControls({page}) {
 const {user,can}=useAccess();
 useEffect(()=>{
  const root=document.querySelector(".dashboard-content");if(!root)return;
  const observe=()=>observer.observe(root,{childList:true,subtree:true});
  const apply=()=>{
   observer.disconnect();
   for(const [action,selector] of Object.entries(controls[page]||{}))for(const node of root.querySelectorAll(selector))node.dataset.accessDenied=String(!can(pageModule(page),action));
   for(const node of root.querySelectorAll("[data-access-module][data-access-action]"))node.dataset.accessDenied=String(!can(node.dataset.accessModule,node.dataset.accessAction));
   if(page==="purchases")for(const node of root.querySelectorAll(".purchase-record-payment-button"))node.dataset.accessDenied=String(!can("suppliers","edit"));
   if(page==="sales")for(const node of root.querySelectorAll(".sales-detail-actions>.products-secondary-button"))node.dataset.accessDenied=String(!can("customers","edit"));
   if(page==="sales")for(const node of root.querySelectorAll(".sales-quick-customer"))node.dataset.accessDenied=String(!can("customers","create"));
   observe();
  };
  const observer=new MutationObserver(apply);
  apply();
  return()=>{observer.disconnect();for(const node of root.querySelectorAll("[data-access-denied]"))delete node.dataset.accessDenied};
 },[page,user]);
 return null;
}
