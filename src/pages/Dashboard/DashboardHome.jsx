import {useRemoteRefresh} from "../../hooks/useRemoteRefresh";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { LuBanknote, LuCalendarDays, LuChartNoAxesCombined, LuChartPie, LuChevronDown, LuChevronUp, LuCircleAlert, LuPill, LuRefreshCw, LuSettings2, LuShoppingBag, LuShoppingCart, LuTrendingUp, LuUsersRound } from "react-icons/lu";
import { useLanguage } from "../../i18n/translation";
import { getDashboardData } from "../../sevices/database";
import { addDays, calculateDashboardOverview, kabulToday, round } from "../Reports/reportEngine";
import { useCurrency } from "../../context/CurrencyContext";
import { useAccess } from "../../context/AccessContext";
import "./DashboardHome.css";

const statCards = [
  { key: "today", label: "todaySales", color: "blue", Icon: LuTrendingUp, caption: "today" },
  { key: "sales", label: "totalSales", color: "purple", Icon: LuShoppingBag, caption: "throughToday" },
  { key: "purchases", label: "totalPurchases", color: "teal", Icon: LuShoppingCart, caption: "throughToday" },
  { key: "gross", label: "grossProfit", color: "green", Icon: LuChartNoAxesCombined, caption: "throughToday" },
  { key: "receivables", label: "receivables", color: "orange", Icon: LuUsersRound, caption: "outstanding" },
  { key: "medicines", label: "totalMedicines", color: "rose", Icon: LuPill, caption: "catalog" },
];

function DashboardHome({ database }) {
  const { t, language, direction } = useLanguage();
  const { currency, fromAfn, rateAvailable } = useCurrency();
  const { user } = useAccess();
  const cardsKey = `smart-company:dashboard-cards:${database.databasePath}:${user?.id || user?.username || "owner"}`;
  const defaultCards = statCards.map(({ key }) => ({ key, visible: true }));
  const [cardSettings, setCardSettings] = useState(() => { try { const saved = JSON.parse(localStorage.getItem(cardsKey)); return Array.isArray(saved) ? saved : defaultCards; } catch { return defaultCards; } });
  const [customizing, setCustomizing] = useState(false);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(cardsKey)); setCardSettings(Array.isArray(saved) ? saved : defaultCards); } catch { setCardSettings(defaultCards); } }, [cardsKey]);
  const saveCards = (next) => { setCardSettings(next); localStorage.setItem(cardsKey, JSON.stringify(next)); };
  const moveCard = (index, offset) => { const next = [...cardSettings], target = index + offset; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; saveCards(next); };
  const visibleCards = cardSettings.filter((item) => item.visible).map((item) => statCards.find((card) => card.key === item.key)).filter(Boolean);
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(false), [updated, setUpdated] = useState(null);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const id = ++request.current;
    setLoading(true); setError(false);
    try { const snapshot = await getDashboardData(database.databasePath); if (request.current === id) { setData(snapshot); setUpdated(new Date()); } }
    catch { if (request.current === id) setError(true); }
    finally { if (request.current === id) setLoading(false); }
  }, [database.databasePath]);
  useRemoteRefresh(database,reload);
  useEffect(() => { reload(); return () => { request.current++; }; }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => { if (data && data.today !== kabulToday()) reload(); }, 60000);
    return () => clearInterval(timer);
  }, [data, reload]);
  const overview = useMemo(() => { if (!data) return null; try { return data.overview || calculateDashboardOverview(data); } catch { return null; } }, [data]);
  const displayOverview = useMemo(() => overview ? {
    ...overview,
    stats: Object.fromEntries(Object.entries(overview.stats).map(([key, value]) => [key, key === "medicines" || value == null ? value : fromAfn(value)])),
    weekly: overview.weekly.map((point) => ({ ...point, total: fromAfn(point.total) ?? 0 })),
    mix: { settled: fromAfn(overview.mix.settled) ?? 0, credit: fromAfn(overview.mix.credit) ?? 0 },
  } : null, [overview, fromAfn]);
  const locale = language === "en" ? "en-US" : language === "ps" ? "ps-AF" : "fa-AF";
  const formatNumber = (value, compact = false) => value == null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: "compact" } : {}) }).format(value);
  const formatDate = (date) => new Intl.DateTimeFormat(locale, { calendar: language === "en" ? "gregory" : "persian", timeZone: "Asia/Kabul", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));
  const pending = loading && !data;
  const failed = error || (!loading && !overview);

  return <section className="dashboard-overview" dir={direction} aria-label={t("home.title")} aria-busy={loading}>
    {failed && <div className="home-data-error" role="alert"><LuCircleAlert aria-hidden="true" /><span>{t("home.loadError")}</span><button type="button" onClick={reload}>{t("home.refresh")}</button></div>}
    <div className="home-customize"><button type="button" onClick={()=>setCustomizing(value=>!value)} aria-expanded={customizing}><LuSettings2/>{t("home.customize")}</button></div>
    {customizing&&<section className="home-customize-panel"><header><strong>{t("home.customize")}</strong><button type="button" onClick={()=>saveCards(defaultCards)}>{t("home.restoreDefault")}</button></header>{cardSettings.map((item,index)=>{const card=statCards.find(entry=>entry.key===item.key);return <div key={item.key}><label><input type="checkbox" checked={item.visible} onChange={()=>saveCards(cardSettings.map(entry=>entry.key===item.key?{...entry,visible:!entry.visible}:entry))}/>{t(`home.${card.label}`)}</label><span><button type="button" disabled={!index} onClick={()=>moveCard(index,-1)} aria-label={t("home.moveUp")}><LuChevronUp/></button><button type="button" disabled={index===cardSettings.length-1} onClick={()=>moveCard(index,1)} aria-label={t("home.moveDown")}><LuChevronDown/></button></span></div>})}</section>}
    <div className="home-stats-grid">
      {visibleCards.map(({ key, label, color, Icon, caption }) => <article key={key} className={`home-stat home-stat-${color}${pending ? " is-loading" : ""}`}>
        <div className="home-stat-top"><span className="home-stat-icon"><Icon aria-hidden="true" /></span><span className="home-stat-decoration" aria-hidden="true"><i /><i /><i /></span></div>
        <h2>{t(`home.${label}`)}</h2>
        {pending ? <span className="home-stat-skeleton" aria-label={t("home.loading")} /> : <div className="home-stat-value" title={key === "gross" && displayOverview?.stats.gross == null ? t("home.costUnknown") : undefined}><strong>{key !== "medicines" && !rateAvailable ? "—" : formatNumber(displayOverview?.stats[key])}</strong>{key !== "medicines" && displayOverview?.stats[key] != null && <span>{currency}</span>}</div>}
        <p>{t(key === "gross" && overview && overview.stats.gross == null ? "home.costUnknown" : `home.${caption}`)}</p>
      </article>)}
    </div>

    <div className="home-cash-summary"><LuBanknote aria-hidden="true"/><span>{t("exp.balance")}<small>{t("exp.basis")}</small></span><strong>{pending ? "…" : formatNumber(fromAfn(data?.cashBalance ?? (data?.cashTransactions || []).reduce((sum,row) => sum + (row.direction === "IN" ? row.amount_afn : -row.amount_afn),0)))} <small>{currency}</small></strong></div>
    <div className="home-analytics-grid">
      <section className="home-chart-panel home-weekly-panel" aria-labelledby="home-weekly-title">
        <header className="home-panel-header"><div><span className="home-panel-eyebrow"><LuChartNoAxesCombined aria-hidden="true" />{t("home.netSales")}</span><h2 id="home-weekly-title">{t("home.weeklyTitle")}</h2><p>{t("home.weeklyCaption")}</p></div><span className="home-period-badge"><LuCalendarDays aria-hidden="true" />{data ? `${formatDate(addDays(data.today, -6))} — ${formatDate(data.today)}` : "…"}</span></header>
        {pending ? <div className="home-chart-skeleton" role="status" aria-label={t("home.loading")} /> : displayOverview ? <WeeklySales points={displayOverview.weekly} formatNumber={formatNumber} formatDate={formatDate} currency={currency} t={t} /> : <div className="home-chart-empty"><LuChartNoAxesCombined aria-hidden="true" /><p>{t("home.loadError")}</p></div>}
      </section>
      <section className="home-chart-panel home-overview-panel" aria-labelledby="home-mix-title">
        <header className="home-panel-header"><div><span className="home-panel-eyebrow"><LuChartPie aria-hidden="true" />{t("home.throughToday")}</span><h2 id="home-mix-title">{t("home.overviewTitle")}</h2><p>{t("home.overviewCaption")}</p></div><span className="home-panel-symbol" aria-hidden="true"><LuBanknote /></span></header>
        {pending ? <div className="home-chart-skeleton home-donut-skeleton" role="status" aria-label={t("home.loading")} /> : displayOverview ? <SalesMix mix={displayOverview.mix} formatNumber={formatNumber} currency={currency} t={t} /> : <div className="home-chart-empty"><LuChartPie aria-hidden="true" /><p>{t("home.loadError")}</p></div>}
      </section>
    </div>
    <footer className="home-data-footer"><span><i aria-hidden="true" />{t("home.source")}{updated && <> · {t("home.updated")} <bdi>{updated.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kabul" })}</bdi></>}</span><small>{t("home.netNote")}</small><button type="button" disabled={loading} onClick={reload}><LuRefreshCw className={loading ? "home-refreshing" : ""} aria-hidden="true" />{t("home.refresh")}</button></footer>
  </section>;
}

function WeeklySales({ points, formatNumber, formatDate, currency, t }) {
  const unique = useId().replaceAll(":", "");
  const [active, setActive] = useState(null);
  const stage = useRef(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const w = width, h = width < 500 ? 260 : 320, left = width < 500 ? 43 : 58, right = 24, top = 30, bottom = 55;
  const rawMin = Math.min(0, ...points.map((p) => p.total)), rawMax = Math.max(0, ...points.map((p) => p.total));
  const upper = rawMax > 0 ? rawMax * 1.2 : 1, lower = rawMin < 0 ? rawMin * 1.2 : 0;
  const y = (value) => top + (upper - value) / (upper - lower) * (h - top - bottom);
  const plot = points.map((point, index) => ({ ...point, x: left + index * (w - left - right) / 6, y: y(point.total) }));
  const line = plot.reduce((path, point, index) => { if (!index) return `M${point.x},${point.y}`; const prev = plot[index - 1], mid = (prev.x + point.x) / 2; return `${path} C${mid},${prev.y} ${mid},${point.y} ${point.x},${point.y}`; }, "");
  const area = `${line} L${plot[6].x},${y(0)} L${plot[0].x},${y(0)} Z`;
  const noSales = !points.some((p) => p.count > 0);
  const focused = active == null ? null : plot[active];
  return <div className="home-weekly-body">
    <div className="home-chart-legend"><span><i />{t("home.netSales")}</span><small>{currency}</small></div>
    <div className="home-line-stage" ref={stage} dir="ltr" onMouseLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={`${unique}-title`}>
        <title id={`${unique}-title`}>{t("home.weeklyTitle")}</title>
        <defs><linearGradient id={`${unique}-area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6388f0" stopOpacity=".24" /><stop offset="100%" stopColor="#6388f0" stopOpacity=".01" /></linearGradient><linearGradient id={`${unique}-line`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#6584ed" /><stop offset="100%" stopColor="#3778dc" /></linearGradient></defs>
        {Array.from({ length: 5 }, (_, i) => { const value = lower + (upper - lower) * i / 4; return <g key={i}><line className="home-guide-line" x1={left} x2={w - right} y1={y(value)} y2={y(value)} /><text className="home-axis-label" x={left - 16} y={y(value) + 4} textAnchor="end">{formatNumber(value, true)}</text></g>; })}
        {!noSales && <><path d={area} fill={`url(#${unique}-area)`} /><path d={line} fill="none" stroke={`url(#${unique}-line)`} strokeWidth="3.5" strokeLinecap="round" /></>}
        {focused && <line className="home-hover-guide" x1={focused.x} x2={focused.x} y1={top} y2={h - bottom} />}
        {plot.map((point, i) => <g key={point.date}>
          <text className="home-day-label" x={point.x} y={h - 20} textAnchor="middle">{t(`home.${w < 400 ? "shortDay" : "day"}.${new Date(`${point.date}T12:00:00Z`).getUTCDay()}`)}</text>
          {!noSales && <circle className={`home-data-dot${active === i ? " is-active" : ""}`} cx={point.x} cy={point.y} r={active === i ? 6.5 : 4.5} />}
          <rect className="home-point-target" x={Math.max(left - 20, point.x - (w - left - right) / 12)} y={top - 12} width={(w - left - right) / 6} height={h - top - bottom + 24} tabIndex="0" role="img" aria-label={`${formatDate(point.date)}: ${formatNumber(point.total)} ${currency}`} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}><title>{formatDate(point.date)}: {formatNumber(point.total)} {currency}</title></rect>
        </g>)}
      </svg>
      {focused && <div className="home-chart-tooltip" role="tooltip" style={{ left: `${Math.min(86, Math.max(14, focused.x / w * 100))}%`, top: `${Math.max(6, Math.min(60, focused.y / h * 100 - 20))}%` }}><span>{formatDate(focused.date)}</span><strong>{formatNumber(focused.total)} <small>{currency}</small></strong></div>}
      {noSales && <div className="home-empty-week"><span><LuTrendingUp aria-hidden="true" /></span><p>{t("home.emptyWeek")}</p></div>}
    </div>
  </div>;
}

function SalesMix({ mix, formatNumber, currency, t }) {
  const unique = useId().replaceAll(":", "");
  const [active, setActive] = useState(null);
  const total = round(mix.settled + mix.credit), r = 78, circumference = 2 * Math.PI * r;
  const segments = [{ key: "settled", value: mix.settled, offset: 0 }, { key: "credit", value: mix.credit, offset: total ? mix.settled / total : 0 }];
  return <div className="home-mix-body">
    <div className={`home-donut-stage${!total ? " is-empty" : ""}`}>
      <svg viewBox="0 0 220 220" role="img" aria-label={t("home.overviewTitle")}>
        <defs><linearGradient id={`${unique}-settled`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#537deb" /><stop offset="100%" stopColor="#9271e3" /></linearGradient><linearGradient id={`${unique}-credit`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#e8a35b" /><stop offset="100%" stopColor="#efc184" /></linearGradient></defs>
        <circle className="home-donut-track" cx="110" cy="110" r={r} fill="none" strokeWidth="19" />
        {segments.filter((segment) => segment.value > 0).map((segment) => {
          const fraction = segment.value / total, gap = segments.every((s) => s.value > 0) ? Math.min(5, fraction * circumference / 2) : 0;
          return <circle key={segment.key} className={`home-donut-segment${active && active !== segment.key ? " is-muted" : ""}`} cx="110" cy="110" r={r} fill="none" stroke={`url(#${unique}-${segment.key})`} strokeWidth={active === segment.key ? "23" : "19"} strokeLinecap="round" strokeDasharray={`${Math.max(0, fraction * circumference - gap)} ${circumference}`} strokeDashoffset={-segment.offset * circumference - gap / 2} transform="rotate(-90 110 110)" tabIndex="0" onMouseEnter={() => setActive(segment.key)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(segment.key)} onBlur={() => setActive(null)} aria-label={`${t(`home.${segment.key}`)}: ${formatNumber(segment.value)} ${currency}`}><title>{t(`home.${segment.key}`)}: {formatNumber(segment.value)} {currency}</title></circle>;
        })}
      </svg>
      <div className="home-donut-center"><span>{t("home.donutTotal")}</span><strong title={`${formatNumber(total)} ${currency}`}>{formatNumber(total, total >= 1000000)}</strong><small>{currency}</small></div>
    </div>
    <ul className="home-mix-legend">{segments.map((segment) => <li key={segment.key} className={`home-mix-${segment.key}`} onMouseEnter={() => setActive(segment.key)} onMouseLeave={() => setActive(null)}><span><i />{t(`home.${segment.key}`)}</span><strong>{formatNumber(segment.value)}<small>{formatNumber(total ? segment.value / total * 100 : 0)}%</small></strong></li>)}</ul>
    <p className="home-mix-note">{t(total ? "home.creditNote" : "home.emptySales")}</p>
  </div>;
}

export default DashboardHome;
