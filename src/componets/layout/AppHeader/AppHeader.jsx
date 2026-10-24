import {
  FiGlobe,
  FiMoon,
  FiSun,
} from "react-icons/fi";
import "./AppHeader.css";
import brandLogo from "../../../assets/smart-company-logo.png";

import { useLanguage } from "../../../i18n/translation";
import { useTheme } from "../../../hooks/useTheme";


function AppHeader() {
  const {
    language,
    setLanguage,
    t,
  } = useLanguage();
  const { isDark, toggleTheme } = useTheme();

  const handleLanguageChange = () => {
    if (language === "fa") {
      setLanguage("ps");
    } else if (language === "ps") {
      setLanguage("en");
    } else {
      setLanguage("fa");
    }
  };

  return (
    <header className="app-header">
      <div className="app-header-inner">

      <div className="app-header-actions">

        <button
          type="button"
          className="header-button header-theme-button"
          onClick={toggleTheme}
          aria-label={t(isDark ? "switchToLightTheme" : "switchToDarkTheme")}
          title={t(isDark ? "switchToLightTheme" : "switchToDarkTheme")}
          aria-pressed={isDark}
        >
          {isDark ? <FiSun className="header-icon" aria-hidden="true" /> : <FiMoon className="header-icon" aria-hidden="true" />}
        </button>

        <button
          type="button"
          className="header-button header-language-button"
          onClick={handleLanguageChange}
        >
          <FiGlobe className="header-icon" />

          <span>
            {t("language")}
          </span>
        </button>

      </div>

      <div className="app-header-brand">

        <span className="app-header-title">
          {t("appName")}
        </span>

        <div className="app-header-logo">
          <img src={brandLogo} alt="" />
        </div>

      </div>
      </div>

    </header>
  );
}

export default AppHeader;
