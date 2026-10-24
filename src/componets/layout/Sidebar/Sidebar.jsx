import { useState } from "react";
import {
  FiBarChart2,
  FiBox,
  FiBriefcase,
  FiCreditCard,
  FiChevronLeft,
  FiChevronRight,
  FiDollarSign,
  FiGrid,
  FiPackage,
  FiSettings,
  FiShoppingCart,
  FiUsers,
  FiMessageCircle,
} from "react-icons/fi";
import { useLanguage } from "../../../i18n/translation";
import "./Sidebar.css";
import {useAccess} from "../../../context/AccessContext";
import {useLicense} from "../../../context/LicenseContext";
import brandLogo from "../../../assets/smart-company-logo.png";

export const menuItems = [
  { key: "dashboard", icon: FiGrid },
  { key: "messages", icon: FiMessageCircle },
  { key: "products", icon: FiPackage },
  { key: "companies", icon: FiBriefcase },
  { key: "customers", icon: FiUsers },
  { key: "purchases", icon: FiShoppingCart },
  { key: "sales", icon: FiDollarSign },
  { key: "expenses", icon: FiCreditCard },
  { key: "reports", icon: FiBarChart2 },
];

function Sidebar({ database, activePage, onNavigate }) {
  const { t } = useLanguage();
  const {pageAllowed,user}=useAccess();
  const {active:licenseActive}=useLicense();
  const [activeItem, setActiveItem] = useState(activePage || "dashboard");
  const currentPage = activePage || activeItem;
  const [collapsed, setCollapsed] = useState(false);

  const handleNavigate = (page) => {
    setActiveItem(page);
    onNavigate?.(page);
  };

  return (
    <aside className={`dashboard-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label={t("mainNavigation")}>
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark" aria-hidden="true">
          <img src={brandLogo} alt="" />
        </div>
        <div className="sidebar-brand-copy">
          <span className="sidebar-brand-name">{t("appName")}</span>
          <span className="sidebar-brand-caption">{t("managementSystem")}</span>
        </div>
      </div>

      <button
        className="sidebar-collapse-button"
        type="button"
        aria-label={t("mainNavigation")}
        aria-expanded={!collapsed}
        title={t("mainNavigation")}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? <FiChevronRight aria-hidden="true" /> : <FiChevronLeft aria-hidden="true" />}
      </button>

      <nav className="sidebar-navigation" aria-label={t("mainNavigation")}>
        <span className="sidebar-section-label">{t("workspace")}</span>
        {menuItems.filter(item=>(item.key==="messages"||pageAllowed(item.key))&&(!["purchases","sales","reports"].includes(item.key)||licenseActive)).map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={`sidebar-nav-item${currentPage === key ? " is-active" : ""}`}
            onClick={() => handleNavigate(key)}
            aria-label={t(key)}
            title={t(key)}
            aria-current={currentPage === key ? "page" : undefined}
          >
            <Icon aria-hidden="true" />
            <span>{t(key)}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        {pageAllowed("settings")&&<button
          type="button"
          className={`sidebar-nav-item sidebar-settings${currentPage === "settings" ? " is-active" : ""}`}
          onClick={() => handleNavigate("settings")}
          aria-label={t("settings")}
          title={t("settings")}
          aria-current={currentPage === "settings" ? "page" : undefined}
        >
          <FiSettings aria-hidden="true" />
          <span>{t("settings")}</span>
        </button>}

        <div className="sidebar-profile">
          <div className="sidebar-profile-avatar" aria-hidden="true">
            SM
          </div>
          <div className="sidebar-profile-copy">
            <span>{user?.fullName||database?.administratorName || t("appName")}</span>
            <span>{t(user?`net.role.${user.role}`:"administrator")}</span>
          </div>
          <FiBox className="sidebar-profile-icon" aria-hidden="true" />
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
