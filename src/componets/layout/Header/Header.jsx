import { useState } from "react";
import {
	FiBell,
	FiChevronDown,
	FiGlobe,
	FiMenu,
	FiMoon,
	FiSun,
	FiUser,
} from "react-icons/fi";
import { useLanguage } from "../../../i18n/translation";
import { useTheme } from "../../../hooks/useTheme";
import { useCurrency } from "../../../context/CurrencyContext";
import "./Header.css";

function Header({ database, onLogout, pageTitle, onOpenMenu, menuOpen }) {
	const { t, language, setLanguage, languageInfo, languages } = useLanguage();
	const { currency, setCurrency, rateAvailable } = useCurrency();
	const { isDark, toggleTheme } = useTheme();
	const [openMenu, setOpenMenu] = useState(null);
	const today = new Date();
	const languageLocale = language === "en" ? "en-US" : language === "ps" ? "ps-AF" : "fa-AF";
	const solarDate = new Intl.DateTimeFormat(`${languageLocale}-u-ca-persian`, {
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(today);

	const gregorianDate = new Intl.DateTimeFormat(languageLocale, {
		calendar: "gregory",
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(today);

	return (
		<header
			className={`dashboard-header ${languageInfo.direction === "rtl" ? "is-rtl" : "is-ltr"}`}
			dir={languageInfo.direction}
			aria-label={t("dashboardHeader")}
		>
			<div className="header-mobile-context">
				<button className="header-icon-button header-menu-toggle" type="button" aria-label={t("mobile.openMenu")}
					aria-expanded={menuOpen} aria-controls="mobile-drawer" onClick={() => { setOpenMenu(null); onOpenMenu?.(); }}>
					<FiMenu aria-hidden="true" />
				</button>
				<div className="header-mobile-title"><span>{t("appName")}</span><strong>{pageTitle || t("dashboard")}</strong></div>
			</div>
			<div className="dashboard-header-context">
				<div className="dashboard-header-dates">
					<div className="dashboard-header-date">
						<span>{t("solarDate")}</span>
						<time dir="auto" dateTime={today.toISOString()}>{solarDate}</time>
					</div>
					<div className="dashboard-header-date">
						<span>{t("gregorianDate")}</span>
						<time dir="auto" dateTime={today.toISOString()}>{gregorianDate}</time>
					</div>
				</div>
			</div>

			<div className="dashboard-header-actions" dir="ltr">
				<button
					className="header-icon-button header-theme-toggle"
					type="button"
					aria-label={t(isDark ? "switchToLightTheme" : "switchToDarkTheme")}
					title={t(isDark ? "switchToLightTheme" : "switchToDarkTheme")}
					onClick={toggleTheme}
				>
					{isDark ? <FiSun aria-hidden="true" /> : <FiMoon aria-hidden="true" />}
				</button>

				<div className="header-menu-container">
					<button
						className="header-icon-button header-notifications-button"
						type="button"
						aria-label={t("notifications")}
						aria-expanded={openMenu === "notifications"}
						onClick={() => setOpenMenu(openMenu === "notifications" ? null : "notifications")}
					>
						<FiBell aria-hidden="true" />
					</button>
					{openMenu === "notifications" && (
						<div className="header-popover header-notifications-popover" role="status">
							<strong>{t("notifications")}</strong>
							<p>{t("noNotifications")}</p>
						</div>
					)}
				</div>

				<div className="header-currency-control" role="group" aria-label={t("currency")}>
					{["AFN", "USD"].map((option) => (
						<button
							key={option}
							type="button"
							className={currency === option ? "is-selected" : ""}
							aria-pressed={currency === option}
							onClick={() => setCurrency(option)}
						>
							{option}
						</button>
					))}
				</div>
				{!rateAvailable && <span className="header-currency-warning" title={t("currencyRateMissing")}>!</span>}

				<div className="header-language-select-wrap">
					<FiGlobe aria-hidden="true" />
					<select
						className="header-language-select"
						aria-label={t("changeLanguage")}
						value={language}
						dir={languageInfo.direction}
						onChange={(event) => setLanguage(event.target.value)}
					>
						{Object.entries(languages).map(([code, languageOption]) => (
							<option key={code} value={code}>{languageOption.label}</option>
						))}
					</select>
					<FiChevronDown className="header-language-select-chevron" aria-hidden="true" />
				</div>

				<div className="header-menu-container">
					<button
						className="header-profile-button"
						type="button"
						aria-label={t("openProfile")}
						aria-expanded={openMenu === "profile"}
						onClick={() => setOpenMenu(openMenu === "profile" ? null : "profile")}
					>
						<span className="header-profile-avatar" aria-hidden="true"><FiUser /></span>
						<FiChevronDown className="header-profile-chevron" aria-hidden="true" />
					</button>
					{openMenu === "profile" && (
						<div className="header-popover header-profile-popover" dir={languageInfo.direction}>
							<strong>{database?.administratorName || t("administrator")}</strong>
							<span>{database?.databaseName}</span>
							<div className="header-mobile-utilities">
								<label><span>{t("language")}</span><select aria-label={t("changeLanguage")} value={language} onChange={(event) => setLanguage(event.target.value)}>
									{Object.entries(languages).map(([code, option]) => <option key={code} value={code}>{option.label}</option>)}
								</select></label>
								<button className="header-mobile-theme" type="button" onClick={toggleTheme}>
									{isDark ? <FiSun aria-hidden="true" /> : <FiMoon aria-hidden="true" />}{t(isDark ? "switchToLightTheme" : "switchToDarkTheme")}
								</button>
								<div className="header-mobile-currency" role="group" aria-label={t("currency")}>
									{["AFN", "USD"].map((option) => <button key={option} type="button" aria-pressed={currency === option} onClick={() => setCurrency(option)}>{option}</button>)}
								</div>
								<div className="header-mobile-dates"><span>{solarDate}</span><span>{gregorianDate}</span></div>
							</div>
							<button type="button" onClick={onLogout}>{t("logout")}</button>
						</div>
					)}
				</div>
			</div>
		</header>
	);
}

export default Header;

