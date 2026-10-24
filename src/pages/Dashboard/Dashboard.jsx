import { useEffect, useRef, useState } from "react";
import Sidebar from "../../componets/layout/Sidebar/Sidebar";
import Header from "../../componets/layout/Header/Header";
import Products from "../Products/Products";
import Companies from "../Companies/Companies";
import Purchases from "../Purchases/Purchases";
import Sales from "../Sales/Sales";
import Customers from "../Customers/Customers";
import Settings from "../Settings/Settings";
import Reports from "../Reports/Reports";
import Expenses from "../Expenses/Expenses";
import DashboardHome from "./DashboardHome";
import Messages from "../Messages/Messages";
import MobileNavigation from "../../componets/layout/MobileNavigation/MobileNavigation";
import { useLanguage } from "../../i18n/translation";
import {closeTopDialog,confirmAndroidExit,useAndroidBack} from "../../hooks/useAndroidBack";
import "./Dashboard.css";
import "./MobileLayout.css";
import {PermissionScope,useAccess} from "../../context/AccessContext";
import PermissionControls from "../../componets/common/PermissionControls";
import {pageModule} from "../../shared/permissions";
import {useLicense} from "../../context/LicenseContext";

function Dashboard({ database, onLogout }) {
  const { t, direction, language } = useLanguage();
  const {pageAllowed}=useAccess();
  const {active:licenseActive}=useLicense();
  const [activePage, setActivePage] = useState(()=>["dashboard","products","purchases","sales","customers","companies","expenses","reports","settings"].find(pageAllowed)||"dashboard");
  const [sourceRequest, setSourceRequest] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expenseTab, setExpenseTab] = useState("EXPENSE");
  const [networkError,setNetworkError]=useState("");
  const historyRef=useRef([{page:"dashboard",tab:"EXPENSE"}]);
  const exitPending=useRef(false);
  useEffect(()=>{const show=event=>setNetworkError(event.detail);window.addEventListener("remote-operation-error",show);return()=>window.removeEventListener("remote-operation-error",show)},[]);
  const contentRef = useRef(null);
  const navigate = (page, tab = "EXPENSE") => {
    if(!(page==="messages"||pageAllowed(page))||(["purchases","sales","reports"].includes(page)&&!licenseActive))return;
    setSourceRequest(null);
    setActivePage(page);
    if (page === "expenses") setExpenseTab(tab);
    const last=historyRef.current.at(-1);
    if(last?.page!==page||last?.tab!==tab)historyRef.current.push({page,tab});
    setDrawerOpen(false);
  };
  useAndroidBack(()=>{
    if(drawerOpen){setDrawerOpen(false);return}
    if(closeTopDialog())return;
    if(activePage!=="dashboard"){
      if(historyRef.current.length>1)historyRef.current.pop();
      const previous=historyRef.current.at(-1)||{page:"dashboard",tab:"EXPENSE"};
      setSourceRequest(null);setActivePage(previous.page);if(previous.page==="expenses")setExpenseTab(previous.tab);return;
    }
    if(exitPending.current)return;exitPending.current=true;confirmAndroidExit(language).finally(()=>{exitPending.current=false});
  });
  useEffect(()=>{if(["purchases","sales","reports"].includes(activePage)&&!licenseActive)setActivePage("dashboard");},[activePage,licenseActive]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const closeOnDesktop = () => { if (!media.matches) setDrawerOpen(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [activePage, expenseTab]);
  const openCashSource = (target) => {
    if (!["purchases", "sales", "customers"].includes(target.page)) return;
    if(!pageAllowed(target.page)||(["purchases","sales"].includes(target.page)&&!licenseActive))return;
    setSourceRequest(target);
    setActivePage(target.page);
  };

  return (
    <main className={`dashboard-shell${drawerOpen ? " mobile-menu-open" : ""}`} dir={direction}>
      <Sidebar
        database={database}
        activePage={activePage}
        onNavigate={navigate}
      />
      <div className="dashboard-main" inert={drawerOpen ? true : undefined}>
        <Header database={database} onLogout={onLogout}
          pageTitle={t(activePage === "expenses" && expenseTab === "register" ? "exp.register" : activePage)}
          menuOpen={drawerOpen} onOpenMenu={() => setDrawerOpen(true)} />
        <div className="dashboard-content" ref={contentRef}>
        {networkError&&<div className="network-operation-error" role="alert"><span>{t(`net.error.${networkError}`)}</span><button type="button" onClick={()=>setNetworkError("")}>{t("close")}</button></div>}
        <PermissionScope module={pageModule(activePage)}><PermissionControls page={activePage}/>
        {!(activePage==="messages"||pageAllowed(activePage))?<section className="access-denied" role="alert">{t("net.error.permission_denied")}</section>:activePage === "messages" ? (
          <Messages database={database}/>
        ) : activePage === "products" ? (
          <Products database={database} />
        ) : activePage === "companies" ? (
          <Companies database={database} />
        ) : activePage === "purchases" ? (
          <Purchases database={database} initialPurchaseId={sourceRequest?.page === "purchases" ? sourceRequest.documentId : null} />
        ) : activePage === "sales" ? (
          <Sales database={database} initialSaleId={sourceRequest?.page === "sales" ? sourceRequest.documentId : null} />
        ) : activePage === "customers" ? (
          <Customers database={database} initialCustomerId={sourceRequest?.page === "customers" ? sourceRequest.documentId : null} initialPaymentId={sourceRequest?.page === "customers" ? sourceRequest.paymentId : null} />
        ) : activePage === "settings" ? (
          <Settings database={database} />
        ) : activePage === "reports" ? (
          <Reports database={database} />
        ) : activePage === "expenses" ? (
          <Expenses database={database} onOpenSource={openCashSource} initialTab={expenseTab} onTabChange={setExpenseTab} />
        ) : activePage === "dashboard" ? (
          <DashboardHome database={database} />
        ) : (
          <section className="dashboard-empty-space" aria-label="Dashboard" />
        )}
        </PermissionScope>
        </div>
      </div>
      <MobileNavigation database={database} activePage={activePage} expenseTab={expenseTab}
        open={drawerOpen} onOpen={() => setDrawerOpen(true)} onClose={() => setDrawerOpen(false)} onNavigate={navigate} />
    </main>
  );
}

export default Dashboard;
