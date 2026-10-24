import { useEffect, useRef } from "react";
import { FiCheck, FiCreditCard, FiDollarSign, FiGrid, FiMoreHorizontal, FiSettings, FiShoppingBag, FiShoppingCart, FiUser, FiX } from "react-icons/fi";
import { menuItems } from "../Sidebar/Sidebar";
import { useLanguage } from "../../../i18n/translation";
import {useAccess} from "../../../context/AccessContext";
import {useLicense} from "../../../context/LicenseContext";

const tabs = [
  { key: "dashboard", label: "dashboard", icon: FiGrid },
  { key: "purchases", label: "purchases", icon: FiShoppingCart },
  { key: "sales", label: "sales", icon: FiDollarSign },
  { key: "expenses", label: "mobile.cash", icon: FiCreditCard },
];
const drawerItems = [...menuItems, { key: "settings", icon: FiSettings }];

export default function MobileNavigation({ database, activePage, expenseTab, open, onOpen, onClose, onNavigate }) {
  const { t, direction } = useLanguage();
  const {pageAllowed,can}=useAccess();
  const {active:licenseActive}=useLicense();
  const licensed=key=>!["purchases","sales","reports"].includes(key)||licenseActive;
  const visibleTabs=tabs.filter(item=>licensed(item.key)&&(item.key==="expenses"?can("cash_register"):pageAllowed(item.key)));
  const drawerRef = useRef(null);
  const closeRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const handleKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const buttons = drawerRef.current?.querySelectorAll("button:not(:disabled)");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKey);
      if (trigger?.isConnected && window.matchMedia("(max-width: 768px)").matches) trigger.focus();
    };
  }, [open, onClose]);

  const cashActive = activePage === "expenses" && expenseTab === "register";
  const moreActive = !["dashboard", "purchases", "sales"].includes(activePage) && !cashActive;
  return <div className="mobile-navigation" dir={direction}>
    <nav className="mobile-tab-bar" style={{"--mobile-tab-count":visibleTabs.length+1}} aria-label={t("mainNavigation")} inert={open ? true : undefined}>
      {visibleTabs.map(({ key, label, icon: Icon }) => {
        const active = key === "expenses" ? cashActive : activePage === key;
        return <button key={key} type="button" className={`mobile-tab${active ? " is-active" : ""}`}
          aria-current={active ? "page" : undefined} aria-label={t(key === "expenses" ? "exp.register" : key)}
          onClick={() => onNavigate(key, key === "expenses" ? "register" : undefined)}>
          <span className="mobile-tab-icon"><Icon aria-hidden="true" /></span><span>{t(label)}</span>
        </button>;
      })}
      <button type="button" className={`mobile-tab${moreActive || open ? " is-active" : ""}`} aria-expanded={open}
        aria-controls="mobile-drawer" aria-label={t("mobile.more")} onClick={onOpen}>
        <span className="mobile-tab-icon"><FiMoreHorizontal aria-hidden="true" /></span><span>{t("mobile.more")}</span>
      </button>
    </nav>
    <div className={`mobile-drawer-layer${open ? " is-open" : ""}`} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="mobile-drawer-backdrop" onClick={onClose} />
      <section id="mobile-drawer" ref={drawerRef} className="mobile-drawer" role="dialog" aria-modal={open ? true : undefined} aria-labelledby="mobile-drawer-title">
        <header className="mobile-drawer-header">
          <span className="mobile-brand-icon"><FiShoppingBag aria-hidden="true" /></span>
          <div><strong id="mobile-drawer-title">{t("appName")}</strong><span>{t("managementSystem")}</span></div>
          <button ref={closeRef} className="mobile-drawer-close" type="button" aria-label={t("close")} onClick={onClose}><FiX aria-hidden="true" /></button>
        </header>
        <nav className="mobile-drawer-links" aria-label={t("mainNavigation")}>
          <p>{t("workspace")}</p>
          {drawerItems.filter(item=>(item.key==="messages"||pageAllowed(item.key))&&licensed(item.key)).map(({ key, icon: Icon }) => <button key={key} type="button"
            className={`mobile-drawer-link${activePage === key ? " is-active" : ""}`}
            aria-current={activePage === key ? "page" : undefined} onClick={() => onNavigate(key)}>
            <span className="mobile-drawer-link-icon"><Icon aria-hidden="true" /></span><span>{t(key)}</span>
            {activePage === key && <FiCheck className="mobile-drawer-check" aria-hidden="true" />}
          </button>)}
        </nav>
        <footer className="mobile-drawer-profile"><span><FiUser aria-hidden="true" /></span><div><strong>{database?.administratorName || t("administrator")}</strong><small>{database?.databaseName || t("administrator")}</small></div></footer>
      </section>
    </div>
  </div>;
}
