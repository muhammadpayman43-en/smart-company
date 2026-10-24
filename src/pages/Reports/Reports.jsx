import {useRemoteRefresh} from "../../hooks/useRemoteRefresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiActivity, FiArrowLeft, FiArrowRight, FiBarChart2, FiBox, FiBriefcase, FiCalendar, FiCheckCircle, FiClock, FiDollarSign, FiDownload, FiFileText, FiFilter, FiGrid, FiInfo, FiRefreshCw, FiSearch, FiShoppingCart, FiStar, FiTrendingUp, FiUsers, FiWifi, FiWifiOff, FiX } from "react-icons/fi";
import { useLanguage } from "../../i18n/translation";
import { useCurrency } from "../../context/CurrencyContext";
import { getReportsData } from "../../sevices/database";
import PrintControls from "../../componets/common/PrintControls/PrintControls";
import { normalizeSearch, reportCatalog, reportCategories } from "./reportCatalog";
import { addDays, buildReport, createReportContext, kabulToday, presetRange } from "./reportEngine";
import { exportReport } from "./reportExport";
import "./Reports.css";

const icons = { sales: FiTrendingUp, purchases: FiShoppingCart, inventory: FiBox, expiry: FiClock, customers: FiUsers, suppliers: FiBriefcase, cash: FiDollarSign, profit: FiBarChart2, employees: FiActivity, management: FiGrid };
const presets = ["today", "yesterday", "week", "lastWeek", "month", "lastMonth", "year", "custom"];
const reportPaper = { a4: "size:A4 portrait;margin:10mm", a5: "size:A5 portrait;margin:8mm", "80mm": "size:80mm 200mm;margin:3mm", "58mm": "size:58mm 160mm;margin:2mm" };
const emptyFilters = { medicine: "", customer: "", supplier: "", manufacturer: "", formula: "", method: "", status: "", batch: "" };
const initialRange = () => ({ preset: "month", ...presetRange("month"), lowStock: "10" });
const metrics = [
  ["sales", "netSales", "salesSummary", "period", "sales"], ["purchases", "netPurchases", "purchasesSummary", "period", "purchases"],
  ["gross", "grossProfit", "grossProfit", "period", "profit"], ["expenses", "expenses", "expensesReport", "period", "profit"],
  ["net", "netProfit", "netProfit", "period", "profit"], ["receivables", "receivables", "customerDebtors", "asOf", "customers"],
  ["payables", "payables", "supplierDebts", "asOf", "suppliers"], ["stockValue", "stockValue", "inventoryCost", "current", "inventory"],
  ["expiring", "expiring", "expiryNear", "current", "expiry"], ["low", "low", "inventoryLow", "current", "inventory"],
];

function Reports({ database }) {
  const { t, language, direction } = useLanguage();
  const { currency, fromAfn, rateAvailable } = useCurrency();
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [updated, setUpdated] = useState(null), [online, setOnline] = useState(navigator.onLine);
  const [range, setRange] = useState(initialRange), [query, setQuery] = useState(""), [category, setCategory] = useState("all");
  const [activeId, setActiveId] = useState(null), [filters, setFilters] = useState(emptyFilters), [rowQuery, setRowQuery] = useState("");
  const [page, setPage] = useState(1), [sort, setSort] = useState(null), [preview, setPreview] = useState(false), [format, setFormat] = useState("a4");
  const [exporting, setExporting] = useState(false), [feedback, setFeedback] = useState("");
  const favoriteKey = `report-favorites:${database.databasePath}`;
  const [favorites, setFavorites] = useState(() => { try { const value = JSON.parse(localStorage.getItem(favoriteKey) || "[]"); return Array.isArray(value) ? value.filter((id) => reportCatalog.some((r) => r.id === id)) : []; } catch { return []; } });
  const requestId = useRef(0);
  const detailHeading = useRef(null);
  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setError("");
    try { const records = await getReportsData(database.databasePath); if (id === requestId.current) { setData(records); setUpdated(new Date()); } }
    catch { if (id === requestId.current) setError("r.loadError"); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [database.databasePath]);
  useRemoteRefresh(database,reload);
  useEffect(() => { reload(); return () => { requestId.current++; }; }, [reload]);
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener("online", update); window.addEventListener("offline", update); return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); }; }, []);
  useEffect(() => { try { localStorage.setItem(favoriteKey, JSON.stringify(favorites)); } catch { /* Local preferences must not block reports. */ } }, [favoriteKey, favorites]);
  useEffect(() => { setPage(1); }, [activeId, filters, range, rowQuery, language, sort, data]);
  useEffect(() => { if (activeId) detailHeading.current?.focus(); }, [activeId]);
  const locale = language === "en" ? "en-US" : language === "ps" ? "ps-AF" : "fa-AF";
  const number = (value, money = false) => value == null || !Number.isFinite(Number(value)) ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: money ? 2 : 0, minimumFractionDigits: money ? 2 : 0 }).format(value);
  const money = (value) => rateAvailable ? number(fromAfn(value), true) : "—";
  const solar = (value) => { if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value) || !Number.isFinite(Date.parse(`${value.slice(0, 10)}T12:00:00Z`))) return ""; return new Intl.DateTimeFormat(locale, { calendar: "persian", year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Kabul" }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)); };
  const statusText = (value) => { const key = `r.status.${value}`; const label = t(key); return label !== key ? label : t(`r.${value}`) !== `r.${value}` ? t(`r.${value}`) : t(`exp.${value}`) !== `exp.${value}` ? t(`exp.${value}`) : String(value ?? "—"); };
  const textValue = (column, row) => {
    const value = row[column.key];
    if (value == null || value === "") return "—";
    if (column.type === "status") return statusText(value);
    if (column.key === "name" && row.translateName) return value.startsWith("r.") ? t(value) : statusText(value);
    if (column.type === "money") return money(value);
    if (column.type === "number") return number(value);
    return String(value);
  };
  const active = reportCatalog.find((r) => r.id === activeId);
  const calculation = useMemo(() => {
    if (!data) return {};
    try {
      const context = createReportContext(data, { ...range, ...filters });
      const global = createReportContext(data, range);
      const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
      const previous = createReportContext(data, { ...range, from: addDays(range.from, -days), to: addDays(range.from, -1) }).metrics;
      return { context, global, previous, report: active ? buildReport(active, context) : null };
    } catch (error) { return { error: error.message === "invalid_range" ? "r.invalidRange" : "r.calculationError" }; }
  }, [data, range, filters, active]);
  const search = normalizeSearch(query);
  const matching = reportCatalog.filter((r) => !search || search.split(" ").every((word) => normalizeSearch(`${t(r.title)} ${t(r.description)} ${t(`r.category.${r.category}`)} ${t(`r.keywords.${r.category}`)} ${r.id} ${r.category}`).includes(word)));
  const visible = matching.filter((r) => category === "all" || category === "favorites" ? category !== "favorites" || favorites.includes(r.id) : r.category === category);
  const tableRows = useMemo(() => {
    let rows = calculation.report?.rows || [];
    const query = normalizeSearch(rowQuery);
    if (query) rows = rows.filter((row) => calculation.report.columns.some((column) => normalizeSearch(textValue(column, row)).includes(query)));
    if (sort) {
      rows = [...rows].sort((a, b) => { const av = a[sort.key], bv = b[sort.key]; if (av == null) return bv == null ? 0 : 1; if (bv == null) return -1; return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), locale, { numeric: true })) * sort.direction; });
    }
    return rows;
  }, [calculation.report, rowQuery, sort, language]);
  const pages = Math.max(1, Math.ceil(tableRows.length / 25)); const currentPage = Math.min(page, pages);
  const openReport = (id) => { setActiveId(id); setFilters(emptyFilters); setRowQuery(""); setSort(null); setFeedback(""); setPreview(false); };
  const toggleFavorite = (id) => setFavorites((values) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const reset = () => { setRange(initialRange()); setFilters(emptyFilters); setQuery(""); setRowQuery(""); setCategory("all"); };
  const changePreset = (preset) => setRange((r) => ({ ...r, preset, ...(preset === "custom" ? {} : presetRange(preset, data?.today || kabulToday())) }));
  const filterOptions = {
    medicine: (data?.medicines || []).map((m) => [m.id, m.name]), customer: (data?.customers || []).map((c) => [c.id, c.name]),
    supplier: (data?.suppliers || []).map((s) => [s.id, s.name]), manufacturer: (data?.suppliers || []).map((s) => [s.id, s.name]),
    formula: [...new Map((data?.medicines || []).map((m) => [m.formula_id, m.formula])).entries()],
    status: ["paid", "partial", "unpaid", "returned"].map((s) => [s, statusText(s)]), method: ["cash", "card", "bank", "mobile", "other", "unrecorded"].map((s) => [s, statusText(s)]),
    batch: (data?.batches || []).map((b) => [b.id, `${data.medicines.find((m) => m.id === b.medicine_id)?.name || ""} · ${b.batch_number || "—"} · ${b.expiry_date || "—"}`]),
  };
  const metadata = active ? [
    [t("r.title"), t(active.title)], [t("r.range"), `${range.from} — ${range.to}`], [t("r.col.basis"), t(`r.${active.basis}`)],
    ...Object.entries(filters).filter(([, value]) => value).map(([key, value]) => [t(`r.${key}`), filterOptions[key]?.find(([id]) => id === value)?.[1] || value]),
    [t("r.lowStock"), range.lowStock], [t("r.searchRows"), rowQuery || "—"], [t("r.source"), database.databaseName], [t("r.updated"), updated?.toLocaleString(locale, { timeZone: "Asia/Kabul" }) || "—"],
  ] : [];
  const exportExcel = async () => {
    if (!calculation.report?.columns.length) return;
    setExporting(true); setFeedback("");
    try { if (await exportReport({ title: t(active.title), ...calculation.report, rows: tableRows, metadata, notes: [...calculation.report.notes, "r.summaryNote"], language, textValue, t })) setFeedback("r.exported"); }
    catch { setFeedback("r.exportError"); }
    finally { setExporting(false); }
  };
  const renderTable = (rows, print = false) => <table className="report-data-table"><thead><tr>{calculation.report?.columns.map((column) => <th key={column.key} aria-sort={!print && sort?.key === column.key ? sort.direction === 1 ? "ascending" : "descending" : undefined}>{print ? t(column.label) : <button type="button" onClick={() => setSort({ key: column.key, direction: sort?.key === column.key ? -sort.direction : 1 })}>{t(column.label)}{sort?.key === column.key && (sort.direction === 1 ? " ↑" : " ↓")}</button>}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id}>{calculation.report.columns.map((column) => <td key={column.key} className={["number", "money"].includes(column.type) ? "report-number" : ""}>{column.type === "date" ? <><span dir="ltr">{textValue(column, row)}</span>{solar(row[column.key]) && <small>{solar(row[column.key])}</small>}</> : column.type === "status" ? <span className={`report-status report-status-${["expired", "near", "unpaid", "partial", "paid", "sellable"].includes(row[column.key]) ? row[column.key] : "neutral"}`}>{textValue(column, row)}</span> : textValue(column, row)}</td>)}</tr>) : <tr><td colSpan={calculation.report?.columns.length || 1} className="report-empty">{t("r.empty")}</td></tr>}</tbody></table>;
  const card = (report) => { const Icon = icons[report.category]; const starred = favorites.includes(report.id); return <article className={`report-card report-color-${report.category}${report.unavailable ? " is-unavailable" : ""}`} key={report.id}>
    <button className="report-card-open" type="button" onClick={() => openReport(report.id)}><span className="report-card-icon"><Icon aria-hidden="true" /></span><h3>{t(report.title)}</h3><p>{t(report.description)}</p><span className="report-card-footer"><span>{report.unavailable ? <><FiInfo />{t("r.needsData")}</> : <>{t("r.view")}{direction === "rtl" ? <FiArrowLeft /> : <FiArrowRight />}</>}</span><small>{t(`r.${report.basis}`)}</small></span></button>
    <button className={`report-favorite${starred ? " is-favorite" : ""}`} type="button" aria-label={t(starred ? "r.unfavorite" : "r.favorite")} aria-pressed={starred} onClick={() => toggleFavorite(report.id)}><FiStar aria-hidden="true" /></button>
  </article>; };

  return <section className={`reports-page${preview ? " has-preview" : ""}`} dir={direction}>
    <header className="reports-heading"><div><span className="reports-eyebrow"><FiBarChart2 />{t("r.title")}</span><h1>{active ? t(active.title) : t("r.title")}</h1><p>{active ? t(active.description) : t("r.intro")}</p></div><div className="report-top-actions">{active && <button type="button" className="report-button" onClick={() => { setActiveId(null); setPreview(false); }}>{direction === "rtl" ? <FiArrowRight /> : <FiArrowLeft />}{t("r.back")}</button>}<button type="button" className="report-button report-button-primary" disabled={loading} onClick={reload}><FiRefreshCw className={loading ? "is-refreshing" : ""} />{t("r.refresh")}</button></div></header>
    <section className="report-global-filters" aria-label={t("r.range")}>
      <label><span><FiCalendar />{t("r.range")}</span><select value={range.preset} onChange={(e) => changePreset(e.target.value)}>{presets.map((p) => <option key={p} value={p}>{t(`r.${p}`)}</option>)}</select></label>
      <label><span>{t("r.from")}</span><input type="date" value={range.from} onChange={(e) => setRange({ ...range, preset: "custom", from: e.target.value })} /><small>{solar(range.from)}</small></label>
      <label><span>{t("r.to")}</span><input type="date" value={range.to} onChange={(e) => setRange({ ...range, preset: "custom", to: e.target.value })} /><small>{solar(range.to)}</small></label>
      <label className="report-low-filter"><span>{t("r.lowStock")}</span><input type="number" min="1" step="1" value={range.lowStock} onChange={(e) => { if (e.target.value === "" || (/^\d+$/.test(e.target.value) && Number(e.target.value) > 0)) setRange({ ...range, lowStock: e.target.value }); }} /></label>
      <button type="button" className="report-button" onClick={reset}><FiX />{t("r.reset")}</button>
      <small className="report-timezone">{t("r.timezone")}</small>
    </section>
    {(error || calculation.error) && <div className="report-alert" role="alert">{t(error || calculation.error)}{error && <button className="report-button" type="button" onClick={reload}>{t("r.refresh")}</button>}</div>}
    {loading && <div className="report-loading" role="status"><FiRefreshCw className="is-refreshing" />{t("r.loading")}</div>}
    {!active && <>
      <div className="report-kpi-grid" aria-label={t("r.title")}>{metrics.map(([key, label, id, basis, color]) => {
        const Icon = icons[color], value = loading || calculation.error ? null : calculation.global?.metrics[key] ?? null;
        const oldValue = calculation.previous?.[key];
        const change = ["sales", "gross"].includes(key) && value != null && oldValue != null && oldValue !== 0 ? (value - oldValue) / Math.abs(oldValue) * 100 : null;
        const isMoney=!["low", "expiring"].includes(key);return <button key={key} type="button" className={`report-kpi report-color-${color}`} onClick={() => openReport(id)}><span className="report-kpi-top"><span>{t(`r.${label}`)}</span><Icon /></span><strong>{value == null ? loading ? "…" : t("r.na") : isMoney ? money(value) : number(value)}{value != null && isMoney && <small>{currency}</small>}</strong><span className="report-kpi-bottom"><small>{t(`r.${basis}`)}</small>{change != null && <span className={change >= 0 ? "is-positive" : "is-negative"}>{change > 0 ? "+" : ""}{number(change)}%</span>}</span></button>;
      })}</div>
      <div className="report-discovery"><label className="report-search"><FiSearch /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("r.search")} aria-label={t("r.search")} /></label><span>{number(reportCatalog.filter((r) => !r.unavailable).length)} {t("r.available")}</span></div>
      <div className="report-category-tabs" aria-label={t("r.all")}>{["all", ...reportCategories, "favorites"].map((id) => <button key={id} type="button" className={category === id ? "is-selected" : ""} aria-pressed={category === id} onClick={() => setCategory(id)}>{id === "favorites" && <FiStar />}{t(id === "all" ? "r.all" : id === "favorites" ? "r.favorites" : `r.category.${id}`)}<span>{matching.filter((r) => !r.unavailable && (id === "all" || (id === "favorites" ? favorites.includes(r.id) : r.category === id))).length}</span></button>)}</div>
      {category === "all" && !search && <section className="report-category-section"><h2><FiStar />{t("r.favorites")}</h2>{favorites.length ? <div className="report-card-grid">{reportCatalog.filter((r) => favorites.includes(r.id)).map(card)}</div> : <p className="report-favorites-empty">{t("r.noFavorites")}</p>}</section>}
      {visible.length ? (category === "favorites" ? ["favorites"] : reportCategories).map((id) => { const reports = visible.filter((r) => id === "favorites" || r.category === id); if (!reports.length) return null; const Icon = icons[id] || FiStar; return <section className={`report-category-section report-color-${id}`} key={id}><h2><Icon />{t(id === "favorites" ? "r.favorites" : `r.category.${id}`)}<span>{number(reports.length)}</span></h2><div className="report-card-grid">{reports.map(card)}</div></section>; }) : <div className="report-empty"><FiSearch /><p>{t("r.noReports")}</p><button className="report-button" type="button" onClick={() => { setQuery(""); setCategory("all"); }}>{t("r.reset")}</button></div>}
    </>}
    {active && <div className="report-detail" ref={detailHeading} tabIndex="-1">
      <div className="report-detail-basis"><FiInfo /><span>{t(`r.${active.basis}`)} · <bdi dir="ltr">{active.basis === "current" ? data?.today || kabulToday() : `${range.from} — ${range.to}`}</bdi></span><button className={`report-favorite${favorites.includes(active.id) ? " is-favorite" : ""}`} type="button" aria-pressed={favorites.includes(active.id)} aria-label={t(favorites.includes(active.id) ? "r.unfavorite" : "r.favorite")} onClick={() => toggleFavorite(active.id)}><FiStar /></button></div>
      {active.unavailable ? <div className="report-unavailable"><FiInfo /><h2>{t("r.needsData")}</h2><p>{t(`r.unavailable.${active.unavailable}`)}</p><button type="button" className="report-button" onClick={() => setActiveId(null)}>{t("r.back")}</button></div> : <>
        {data && <div className="report-detail-filters"><FiFilter aria-hidden="true" />{[...active.filters, ...(active.view === "expiry" ? ["batch"] : [])].map((key) => <label key={key}><span>{t(`r.${key}`)}</span><select value={filters[key]} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}><option value="">{t("r.allValues")}</option>{filterOptions[key].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>)}</div>}
        {calculation.report && !calculation.error && <>
          <div className="report-summary-grid">{calculation.report.summaries.map((item, i) => <div key={`${item.label}-${i}`}><span>{t(item.label)}</span><strong>{item.value == null ? t("r.na") : item.type === "money" ? money(item.value) : number(item.value)}{item.type === "money" && item.value != null && <small> {currency}</small>}</strong></div>)}</div>
          {["daily", "monthly", "yearly"].includes(active.option) && calculation.report.rows.length > 1 && <TrendChart rows={calculation.report.rows} title={t(active.title)} number={number} fromAfn={fromAfn} currency={currency} />}
          <div className="report-table-toolbar"><label className="report-search"><FiSearch /><input type="search" value={rowQuery} onChange={(e) => setRowQuery(e.target.value)} placeholder={t("r.searchRows")} aria-label={t("r.searchRows")} /></label><span>{number(tableRows.length)} {t("r.rows")}</span><button type="button" className="report-button" disabled={exporting || loading || !tableRows.length} onClick={exportExcel}><FiDownload />{t(exporting ? "r.loading" : "r.excel")}</button><button type="button" className="report-button report-button-primary" disabled={loading} onClick={() => setPreview(true)}><FiFileText />{t("r.preview")}</button></div>
          {feedback && <p className={feedback === "r.exportError" ? "report-alert" : "report-feedback"} role="status">{t(feedback)}</p>}
          <div className="report-table-scroll">{renderTable(tableRows.slice((currentPage - 1) * 25, currentPage * 25))}</div>
          <div className="report-pagination"><span>{t("r.page")} {number(currentPage)} / {number(pages)}</span><div><button type="button" className="report-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t("r.previous")}</button><button type="button" className="report-button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>{t("r.next")}</button></div></div>
          <aside className="report-notes"><FiInfo aria-hidden="true" /><div><p>{t("r.summaryNote")}</p>{[...new Set(calculation.report.notes)].map((note) => <p key={note}>{t(note)}</p>)}</div></aside>
        </>}
      </>}
    </div>}
    <footer className="reports-source"><span><FiCheckCircle />{t("r.source")}</span><span>{online ? <FiWifi /> : <FiWifiOff />}{t(online ? "r.online" : "r.offline")}</span><span><FiClock />{t("r.updated")}: {updated ? updated.toLocaleString(locale, { timeZone: "Asia/Kabul" }) : "—"}</span>{data && <span>{t("r.pending")}: {number(data.pendingSync)}</span>}</footer>
    {preview && <style media="print">{`@page {${reportPaper[format] || reportPaper.a4}}`}</style>}
    {preview && calculation.report && <div className="report-preview" role="dialog" aria-modal="true" aria-label={t("r.preview")} onKeyDown={(e) => { if (e.key === "Escape") setPreview(false); }}><header className="report-preview-toolbar"><PrintControls format={format} onFormatChange={setFormat} label={t("printPreview")} /><button type="button" className="report-button" autoFocus onClick={() => setPreview(false)}><FiX />{t("r.close")}</button></header><div className={`report-print-sheet print-paper-${format}`} dir={direction}><header><h2>{data?.company[0]?.company_name || database.databaseName}</h2><p>{data?.company[0]?.company_address} {data?.company[0]?.office_phone}</p><h1>{t(active.title)}</h1></header><dl>{metadata.map(([key, value], i) => <div key={`${key}-${i}`}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><div className="report-print-summary">{calculation.report.summaries.map((item, i) => <p key={i}>{t(item.label)}: <strong>{item.value == null ? t("r.na") : item.type === "money" ? money(item.value) : number(item.value)} {item.type === "money" ? currency : ""}</strong></p>)}</div>{renderTable(tableRows, true)}<aside>{[...calculation.report.notes, "r.summaryNote"].map((note) => <p key={note}>{t(note)}</p>)}</aside></div></div>}
  </section>;
}

function TrendChart({ rows, title, number, fromAfn, currency }) {
  const points = rows.slice(-120), values = points.map((r) => fromAfn(r.total) ?? 0);
  const min = Math.min(0, ...values), max = Math.max(1, ...values), scale = max - min;
  const x = (i) => 30 + i * 740 / Math.max(1, points.length - 1), y = (value) => 160 - (value - min) / scale * 130;
  return <figure className="report-trend"><figcaption><FiTrendingUp />{title} · {currency}</figcaption><svg viewBox="0 0 800 200" role="img" aria-label={title} dir="ltr"><line x1="30" x2="770" y1={y(0)} y2={y(0)} className="report-chart-axis" /><polyline points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} className="report-chart-line" />{points.map((row, i) => <circle key={row.id} cx={x(i)} cy={y(values[i])} r="4" className="report-chart-dot"><title>{row.name}: {number(values[i], true)} {currency}</title></circle>)}<text x="30" y="188">{points[0]?.name}</text><text x="770" y="188" textAnchor="end">{points.at(-1)?.name}</text></svg></figure>;
}

export default Reports;
