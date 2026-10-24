import { useEffect, useRef, useState } from "react";
import { FiAlertTriangle, FiSave } from "react-icons/fi";
import { useLanguage } from "../../i18n/translation";
import { getAppSettings, listExpiryAlerts, saveAppSettings } from "../../sevices/database";
import "../Products/Products.css";
import "./Settings.css";
import NetworkSettings from "./NetworkSettings";
import UserManagement from "./UserManagement";
import LicenseSettings from "./LicenseSettings";
import {useAccess} from "../../context/AccessContext";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import { backupLocalDatabase, restoreLocalDatabase } from "../../sevices/database";
import { isServerDatabase } from "../../sevices/users";

function Settings({ database }) {
  const { t, language } = useLanguage();
  const {can}=useAccess();
  const settingsVisible=can("settings");
  const apiRevision=useRef(null);
  const [form, setForm] = useState({ usdToAfnRate: "70", expiryAlertValue: "30", expiryAlertUnit: "days" });
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState("");

  const databaseBackup = async (action) => {
    if (backupBusy || isServerDatabase(database)) return;
    setBackupBusy(true); setBackupStatus("");
    try {
      if (action === "backup") {
        const destination = await save({ defaultPath: `${database.databaseName || "smart-company"}-backup.sqlite`, filters: [{ name: "SQLite", extensions: ["sqlite", "db"] }] });
        if (!destination) return;
        await backupLocalDatabase(database.databasePath, destination); setBackupStatus("net.backupDone");
      } else {
        const source = await open({ multiple: false, filters: [{ name: "SQLite", extensions: ["sqlite", "db"] }] });
        if (!source || !await confirm(t("net.confirmRestore"), { kind: "warning" })) return;
        await restoreLocalDatabase(database.databasePath, source); setBackupStatus("net.restoreDone");
        setTimeout(() => window.location.reload(), 900);
      }
    } catch { setBackupStatus("net.backupFailed"); } finally { setBackupBusy(false); }
  };

  useEffect(() => {
    if(!settingsVisible)return;
    let active = true;
    Promise.all([getAppSettings(database.databasePath), listExpiryAlerts(database.databasePath)]).then(([settings, rows]) => {
      if (!active) return;
      apiRevision.current=settings._apiRevision;
      setForm({ usdToAfnRate: String(settings.usdToAfnRate), expiryAlertValue: String(settings.expiryAlertValue), expiryAlertUnit: settings.expiryAlertUnit });
      setAlerts(rows);
    }).catch(() => { if (active) setStatus("settingsFailed"); });
    return () => { active = false; };
  }, [database?.databasePath,settingsVisible]);

  const submit = async (event) => {
    event.preventDefault();
    setStatus("");
    try {
      const settings = await saveAppSettings({ databasePath: database.databasePath, expectedApiRevision:apiRevision.current, usdToAfnRate: Number(form.usdToAfnRate), expiryAlertValue: Number(form.expiryAlertValue), expiryAlertUnit: form.expiryAlertUnit });
      apiRevision.current=settings._apiRevision;
      setForm({ usdToAfnRate: String(settings.usdToAfnRate), expiryAlertValue: String(settings.expiryAlertValue), expiryAlertUnit: settings.expiryAlertUnit });
      setAlerts(await listExpiryAlerts(database.databasePath));
      setStatus("settingsSaved");
      window.dispatchEvent(new Event("app-settings-changed"));
    } catch { setStatus("settingsFailed"); }
  };

  return <section className="products-page settings-page" dir={language === "en" ? "ltr" : "rtl"}>
    <div className="products-page-heading"><div><p>{t("settings")}</p><h1>{t("settings")}</h1></div></div>
    {can("settings")&&<form className="settings-form" onSubmit={submit}><fieldset className="settings-fields" disabled={!can("settings","edit")}>
      <section className="settings-card">
        <h2>{t("exchangeSettings")}</h2>
        <label>{t("usdAfnRate")}<div className="settings-rate-input"><span>1 USD =</span><input type="number" min="0.0001" step="any" required value={form.usdToAfnRate} onChange={(event) => setForm({ ...form, usdToAfnRate: event.target.value })}/><strong>AFN</strong></div></label>
      </section>
      <section className="settings-card">
        <h2>{t("expiryAlertPeriod")}</h2>
        <div className="settings-period-fields"><input aria-label={t("expiryAlertPeriod")} type="number" min="1" step="1" required value={form.expiryAlertValue} onChange={(event) => setForm({ ...form, expiryAlertValue: event.target.value })}/><select value={form.expiryAlertUnit} onChange={(event) => setForm({ ...form, expiryAlertUnit: event.target.value })}><option value="days">{t("days")}</option><option value="months">{t("months")}</option></select></div>
      </section>
      {can("settings","edit")&&<button className="products-primary-button" type="submit"><FiSave/>{t("saveSettings")}</button>}
      {status && <p className={`settings-feedback ${status === "settingsFailed" ? "is-error" : ""}`} role="status">{t(status)}</p>}
    </fieldset></form>}
    {can("settings")&&<><NetworkSettings database={database}/>{!isServerDatabase(database)&&<section className="settings-card settings-backup"><h2>{t("net.backupTitle")}</h2><p>{t("net.backupHint")}</p><div className="settings-backup-actions"><button className="products-secondary-button" disabled={backupBusy||!can("settings","edit")} onClick={()=>databaseBackup("backup")}>{t("net.backup")}</button><button className="products-secondary-button" disabled={backupBusy||!can("settings","edit")} onClick={()=>databaseBackup("restore")}>{t("net.restore")}</button></div>{backupStatus&&<p className="settings-feedback" role="status">{t(backupStatus)}</p>}</section>}<section className="settings-card settings-alerts">
      <h2><FiAlertTriangle aria-hidden="true"/>{t("expiryAlerts")}</h2>
      {alerts.length === 0 ? <p className="settings-empty">{t("noExpiryAlerts")}</p> : <div className="products-table-scroll"><table className="products-table settings-alert-table"><thead><tr><th>{t("medicineName")}</th><th>{t("batchNumber")}</th><th>{t("expiresOn")}</th><th>{t("quantity")}</th><th>{t("daysRemaining")}</th></tr></thead><tbody>{alerts.map((alert, index) => <tr key={`${alert.expiryDate}-${alert.batchNumber}-${alert.medicineName}-${index}`}><td>{alert.medicineName}</td><td>{alert.batchNumber || "—"}</td><td dir="ltr">{alert.expiryDate}</td><td>{alert.quantityRemaining}</td><td><span className={`expiry-days${alert.daysRemaining < 0 ? " is-expired" : ""}`}>{alert.daysRemaining < 0 ? t("expired") : alert.daysRemaining}</span></td></tr>)}</tbody></table></div>}
    </section></>}
    <UserManagement database={database}/>
    <LicenseSettings/>
  </section>;
}

export default Settings;
