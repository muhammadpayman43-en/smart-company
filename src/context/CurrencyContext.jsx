import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getAppSettings } from "../sevices/database";
import { useAccess } from "./AccessContext";

const CurrencyContext = createContext(null);

export function CurrencyProvider({ database, children }) {
  const { user } = useAccess();
  const storageKey = useMemo(() => `smart-company:display-currency:${database?.databasePath || "default"}:${user?.id || user?.username || "owner"}`, [database?.databasePath, user?.id, user?.username]);
  const [currency, setCurrencyState] = useState(() => localStorage.getItem(storageKey) || "AFN");
  const [rate, setRate] = useState(null);
  const refreshRate = useCallback(async () => {
    if (!database?.databasePath) return;
    try {
      const settings = await getAppSettings(database.databasePath);
      const next = Number(settings?.usdToAfnRate);
      setRate(Number.isFinite(next) && next > 0 ? next : null);
    } catch { setRate(null); }
  }, [database?.databasePath]);
  useEffect(() => { const saved = localStorage.getItem(storageKey); setCurrencyState(saved === "USD" ? "USD" : "AFN"); }, [storageKey]);
  useEffect(() => { refreshRate(); }, [refreshRate]);
  useEffect(() => { window.addEventListener("app-settings-changed", refreshRate); return () => window.removeEventListener("app-settings-changed", refreshRate); }, [refreshRate]);
  const setCurrency = useCallback((next) => { const value = next === "USD" ? "USD" : "AFN"; localStorage.setItem(storageKey, value); setCurrencyState(value); }, [storageKey]);
  const fromAfn = useCallback((value) => { const amount = Number(value); if (!Number.isFinite(amount)) return null; return currency === "AFN" ? amount : rate ? amount / rate : null; }, [currency, rate]);
  return <CurrencyContext.Provider value={{ currency, setCurrency, rate, fromAfn, refreshRate, rateAvailable: currency === "AFN" || Boolean(rate) }}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  const value = useContext(CurrencyContext);
  if (!value) throw new Error("useCurrency must be used inside CurrencyProvider");
  return value;
}
