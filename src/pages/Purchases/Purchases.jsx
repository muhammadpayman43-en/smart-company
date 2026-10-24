import {useRemoteRefresh} from "../../hooks/useRemoteRefresh";
import { useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { FiEye, FiPlus, FiSearch, FiTrash2, FiX, FiPrinter, FiRotateCcw } from "react-icons/fi";
import { useLanguage } from "../../i18n/translation";
import PrintControls from "../../componets/common/PrintControls/PrintControls";
import { createPurchase, deletePurchase, getPurchase, listMedicines, listPharmaceuticalCompanies, listPurchases, recordPurchasePayment, returnPurchase } from "../../sevices/database";
import "../Products/Products.css";
import "./Purchases.css";
import { useCurrency } from "../../context/CurrencyContext";

const localToday = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};
const emptyLine = () => ({ key: `${Date.now()}-${Math.random()}`, medicineId: "", quantity: "1", unitType: "pack", unitPrice: "", salePrice: "", expiryDate: "" });
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const convertUnitPrice = (value, fromUnit, toUnit, packSize) => {
  if (value === "" || value == null) return "";
  const price = Number(value);
  if (!Number.isFinite(price) || fromUnit === toUnit) return value;
  const factor = Number(packSize) || 1;
  return String(roundMoney(toUnit === "unit" ? price / factor : price * factor));
};
const salePriceForPurchaseUnit = (medicine, unitType) => convertUnitPrice(medicine?.suggestedSalePrice ?? medicine?.salePrice ?? "", medicine?.suggestedSalePriceBasis || "unit", unitType, medicine?.unitsPerPack);
const medicineStockLabel = (medicine, t) => {
  const stock = Math.max(0, Math.trunc(Number(medicine?.stockQuantity) || 0));
  const unitsPerPack = Math.max(1, Math.trunc(Number(medicine?.unitsPerPack) || 1));
  return `${medicine.name} — ${t("availableStock")}: ${Math.floor(stock / unitsPerPack)} ${t("perPack")} + ${stock % unitsPerPack} ${t("perUnit")}`;
};
const solarDate = (gregorianDate) => {
  if (!gregorianDate) return "";
  const date = new Date(`${gregorianDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

function Purchases({ database, initialPurchaseId = null }) {
  const { t, language } = useLanguage();
  const { currency, fromAfn } = useCurrency();
  const [purchases, setPurchases] = useState([]);
  const [medicines, setMedicines] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const saveInProgress = useRef(false);
  const paymentSaveInProgress = useRef(false);
  const [formError, setFormError] = useState("");
  const [detail, setDetail] = useState(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isPaymentFormOpen, setIsPaymentFormOpen] = useState(false);
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [paymentForm, setPaymentForm] = useState({ amount: "", paymentDate: localToday(), paymentSource: "cash", notes: "" });
  const [receipt, setReceipt] = useState(null);
  const [printFormat, setPrintFormat] = useState("a4");
  const [form, setForm] = useState({ companyId: "", invoiceNumber: "", purchaseDate: localToday(), discount: "0", paidAmount: "0", paymentSource: "cash", notes: "", items: [emptyLine()] });

  const reloadPurchases = async () => setPurchases(await listPurchases(database.databasePath));
  useRemoteRefresh(database,async()=>{await reloadPurchases();setMedicines(await listMedicines(database.databasePath));if(detail){const loaded=await getPurchase(database.databasePath,detail.id);setDetail(current=>current?.id===loaded.id?loaded:current);}});
  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setPageError("");
    Promise.all([listPurchases(database.databasePath), listMedicines(database.databasePath), listPharmaceuticalCompanies(database.databasePath)])
      .then(([purchaseRows, medicineRows, companyRows]) => {
        if (!active) return;
        setPurchases(purchaseRows);
        setMedicines(medicineRows);
        setCompanies(companyRows);
      })
      .catch(() => { if (active) setPageError("purchasesLoadFailed"); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [database.databasePath]);

  const filteredPurchases = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return purchases.filter((purchase) => {
      const matchesQuery = !query || [purchase.invoiceNumber, purchase.companyName, purchase.purchaseDate, purchase.purchaseDateSolar].some((value) => value?.toLocaleLowerCase().includes(query));
      return matchesQuery && (statusFilter === "all" || purchase.status === statusFilter)
        && (!dateFrom || purchase.purchaseDate >= dateFrom) && (!dateTo || purchase.purchaseDate <= dateTo);
    });
  }, [purchases, search, statusFilter, dateFrom, dateTo]);

  const subtotal = roundMoney(form.items.reduce((sum, line) => sum + Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.unitPrice) || 0), 0));
  const discount = Math.max(0, Number(form.discount) || 0);
  const total = roundMoney(Math.max(0, subtotal - discount));
  const paid = Math.max(0, Number(form.paidAmount) || 0);
  const remaining = roundMoney(Math.max(0, total - paid));

  const openForm = () => {
    setForm({ companyId: "", invoiceNumber: "", purchaseDate: localToday(), discount: "0", paidAmount: "0", paymentSource: "cash", notes: "", items: [emptyLine()] });
    setFormError("");
    setIsFormOpen(true);
  };

  const updateLine = (key, updates) => setForm((current) => ({ ...current, items: current.items.map((line) => line.key === key ? { ...line, ...updates } : line) }));

  const handleMedicineChange = (key, medicineId) => {
    const medicine = medicines.find((entry) => entry.id === medicineId);
    updateLine(key, {
      medicineId,
      unitType: medicine?.purchasePriceBasis || "pack",
      unitPrice: "",
      salePrice: medicine ? String(salePriceForPurchaseUnit(medicine, medicine.purchasePriceBasis || "pack")) : "",
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saveInProgress.current) return;
    setFormError("");
    if (!form.purchaseDate || form.items.length === 0 || form.items.some((line) => !line.medicineId || !line.expiryDate || !Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0 || !Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0 || !Number.isFinite(Number(line.salePrice)) || Number(line.salePrice) < 0)) {
      setFormError("purchaseInvalidFields");
      return;
    }
    if (discount > subtotal) { setFormError("purchaseDiscountTooHigh"); return; }
    if (paid > total) { setFormError("purchasePaidTooHigh"); return; }
    saveInProgress.current = true;
    setIsSaving(true);
    try {
      const saved = await createPurchase({
        databasePath: database.databasePath,
        companyId: form.companyId || null,
        invoiceNumber: form.invoiceNumber.trim(),
        purchaseDate: form.purchaseDate,
        discount: roundMoney(discount),
        paidAmount: roundMoney(paid),
        paymentSource: form.paymentSource,
        notes: form.notes.trim(),
        items: form.items.map((line) => ({ medicineId: line.medicineId, quantity: Number(line.quantity), unitType: line.unitType, unitPrice: roundMoney(Number(line.unitPrice)), salePrice: roundMoney(Number(line.salePrice)), expiryDate: line.expiryDate })),
      });
      setPurchases((current) => [{
        ...saved,
        medicineNames: saved.items.map((item) => item.medicineName).join(" | "),
        expiryDates: saved.items.map((item) => item.expiryDate).join(" | "),
      }, ...current.filter((purchase) => purchase.id !== saved.id)]);
      setIsFormOpen(false);
      setPageError("");
      try {
        await Promise.all([reloadPurchases(), listMedicines(database.databasePath).then(setMedicines)]);
      } catch { setPageError("purchasesLoadFailed"); }
    } catch (error) {
      const message = typeof error === "string" ? error : error?.message;
      const errorKeys = {
        cash_insufficient_balance: "exp.insufficient",
        cash_invalid_fields: "exp.invalid",
        purchase_invalid_fields: "purchaseInvalidFields",
        purchase_invalid_item: "purchaseInvalidFields",
        purchase_company_required: "purchaseCompanyRequired",
        purchase_invalid_item: "purchaseInvalidFields",
        purchase_medicine_not_found: "purchaseMedicineNotFound",
        purchase_company_not_found: "purchaseCompanyNotFound",
        purchase_discount_exceeds_subtotal: "purchaseDiscountTooHigh",
        purchase_paid_exceeds_total: "purchasePaidTooHigh",
      };
      setFormError(errorKeys[message] || "purchaseSaveFailed");
    } finally { saveInProgress.current = false; setIsSaving(false); }
  };

  const showDetail = async (purchaseId) => {
    setDetail(null);
    setIsPaymentFormOpen(false);
    setPaymentError("");
    setIsLoadingDetail(true);
    try { setDetail(await getPurchase(database.databasePath, purchaseId)); }
    catch { setPageError("purchaseDetailFailed"); }
    finally { setIsLoadingDetail(false); }
  };

  useEffect(() => { if (initialPurchaseId) showDetail(initialPurchaseId); }, [database.databasePath, initialPurchaseId]);

  const handleRecordPayment = async (event) => {
    event.preventDefault();
    if (paymentSaveInProgress.current) return;
    setPaymentError("");
    const amount = Number(paymentForm.amount);
    if (!detail || !Number.isFinite(amount) || amount <= 0 || amount > detail.remainingAmount) {
      setPaymentError(amount > (detail?.remainingAmount || 0) ? "purchasePaymentExceedsRemaining" : "purchasePaymentInvalid");
      return;
    }
    paymentSaveInProgress.current = true;
    setIsRecordingPayment(true);
    try {
      const updated = await recordPurchasePayment({
        databasePath: database.databasePath,
        purchaseId: detail.id,
        amount: roundMoney(amount),
        paymentDate: paymentForm.paymentDate,
        paymentSource: paymentForm.paymentSource,
        notes: paymentForm.notes.trim(),
      });
      setDetail(updated);
      setPurchases((current) => current.map((purchase) => purchase.id === updated.id ? { ...purchase, paidAmount: updated.paidAmount, remainingAmount: updated.remainingAmount, status: updated.status } : purchase));
      setIsPaymentFormOpen(false);
      setPaymentForm({ amount: "", paymentDate: localToday(), paymentSource: "cash", notes: "" });
    } catch (error) {
      const message = typeof error === "string" ? error : error?.message;
      setPaymentError(message === "cash_insufficient_balance" ? "exp.insufficient" : message === "purchase_payment_exceeds_remaining" ? "purchasePaymentExceedsRemaining" : message === "purchase_payment_invalid_fields" ? "purchasePaymentInvalid" : "purchasePaymentFailed");
    } finally { paymentSaveInProgress.current = false; setIsRecordingPayment(false); }
  };

  const handleReturnPurchase = async () => {
    if (!detail || detail.status === "returned") return;
    let accepted = false;
    try { accepted = await confirm(t("purchaseReturnConfirm"), { title: t("returnPurchase"), kind: "warning" }); }
    catch { setPageError("purchaseReturnFailed"); return; }
    if (!accepted) return;
    setIsReturning(true);
    try {
      const updated = await returnPurchase({ databasePath: database.databasePath, purchaseId: detail.id, notes: "" });
      setDetail(updated);
      setPurchases(await listPurchases(database.databasePath));
      setMedicines(await listMedicines(database.databasePath));
    } catch (error) {
      const message = String(error?.message || error).replace(/^Error:\s*/, "").replace(/^"|"$/g, "");
      setPaymentError(message === "purchase_return_insufficient_stock" ? "purchaseReturnInsufficientStock" : message === "purchase_already_returned" ? "purchaseAlreadyReturned" : "purchaseReturnFailed");
    } finally { setIsReturning(false); }
  };

  const handleDeletePurchase = async (purchase) => {
    let accepted = false;
    try { accepted = await confirm(t("deletePurchaseConfirm"), { title: t("deletePurchase"), kind: "warning" }); }
    catch { setPageError("purchaseDeleteFailed"); return; }
    if (!accepted) return;
    try {
      await deletePurchase(database.databasePath, purchase.id,purchase._apiRevision);
      await Promise.all([reloadPurchases(), listMedicines(database.databasePath).then(setMedicines)]);
    } catch (error) {
      const message = String(error?.message || error).replace(/^Error:\s*/, "").replace(/^"|"$/g, "");
      setPageError(message === "purchase_has_financial_history" ? "purchaseDeleteHasPayments" : message === "purchase_stock_already_used" ? "purchaseDeleteStockUsed" : "purchaseDeleteFailed");
    }
  };

  const money = (value) => `${new Intl.NumberFormat(language === "fa" ? "fa-AF" : language === "ps" ? "ps-AF" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fromAfn(value) ?? 0)} ${currency}`;
  const statusText = (status) => t(({ paid: "purchasePaid", partial: "purchasePartial", unpaid: "purchaseUnpaid", returned: "purchaseReturned" })[status] || "purchaseUnpaid");

  return (
    <div className={`products-page purchases-page${receipt ? " purchase-receipt-active" : ""}`} dir={language === "en" ? "ltr" : "rtl"}>
      <div className="products-page-heading">
        <div><p>{t("inventory")}</p><h1>{t("purchases")}</h1></div>
        <button className="products-primary-button" type="button" onClick={openForm}><FiPlus aria-hidden="true" />{t("newPurchase")}</button>
      </div>

      {pageError && <p className="products-page-error" role="alert">{t(pageError)}</p>}

      <section className="products-toolbar purchases-toolbar" aria-label={t("searchPurchases")}>
        <label className="products-search"><FiSearch aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("searchPurchases")} /></label>
        <label className="products-filter"><span>{t("purchaseStatus")}</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">{t("allPurchaseStatuses")}</option><option value="paid">{t("purchasePaid")}</option><option value="partial">{t("purchasePartial")}</option><option value="unpaid">{t("purchaseUnpaid")}</option><option value="returned">{t("purchaseReturned")}</option>
        </select></label>
        <label className="products-filter"><span>{t("dateFrom")}</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
        <label className="products-filter"><span>{t("dateTo")}</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
      </section>

      <section className="products-table-section" aria-labelledby="purchases-list-title">
        <div className="products-section-heading"><div><h2 id="purchases-list-title">{t("purchaseHistory")}</h2><span>{filteredPurchases.length}</span></div></div>
        <div className="products-table-scroll">
          <table className="products-table purchases-table">
            <thead><tr><th>{t("medicineName")}</th><th>{t("invoiceNumber")}</th><th>{t("supplierCompany")}</th><th>{t("finalAmount")}</th><th>{t("paidAmount")}</th><th>{t("remainingAmount")}</th><th>{t("purchaseStatus")}</th><th>{t("purchaseDate")}</th><th>{t("expiryDate")}</th><th>{t("actions")}</th></tr></thead>
            <tbody>
              {filteredPurchases.map((purchase) => <tr key={purchase.id} className="purchase-clickable-row" onClick={() => showDetail(purchase.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showDetail(purchase.id); } }} tabIndex="0">
                <td>{purchase.medicineNames ? purchase.medicineNames.split(" | ").map((name, index) => <div key={`${name}-${index}`}>{name}</div>) : "—"}</td><td>{purchase.invoiceNumber || "—"}</td><td>{purchase.companyName || "—"}</td>
                <td>{money(purchase.total)}</td><td>{money(purchase.paidAmount)}</td><td>{money(purchase.remainingAmount)}</td>
                <td><span className={`purchase-status purchase-status-${purchase.status}`}>{statusText(purchase.status)}</span></td>
                
                <td><div className="purchase-dual-date"><span dir="ltr">{purchase.purchaseDate}</span><small dir="ltr">{purchase.purchaseDateSolar} · {t("solarDate")}</small></div></td><td dir="ltr">{purchase.expiryDates ? purchase.expiryDates.split(" | ").map((date, index) => <div key={`${date}-${index}`}>{date}</div>) : "—"}</td><td className="purchase-row-actions"><button className="purchase-view-button" type="button" onClick={(event) => { event.stopPropagation(); showDetail(purchase.id); }} aria-label={`${t("viewPurchase")} ${purchase.invoiceNumber}`} title={t("viewPurchase")}><FiEye aria-hidden="true" /></button><button className="purchase-view-button purchase-delete-button" type="button" onClick={(event) => { event.stopPropagation(); handleDeletePurchase(purchase); }} aria-label={t("deletePurchase")} title={t("deletePurchase")}><FiTrash2 aria-hidden="true" /></button></td>
              </tr>)}
              {isLoading && <tr><td className="products-empty-cell" colSpan="10">{t("loading")}</td></tr>}
              {!isLoading && filteredPurchases.length === 0 && <tr><td className="products-empty-cell" colSpan="10">{t(search || statusFilter !== "all" ? "noPurchaseMatches" : "noPurchases")}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {(isFormOpen || detail || isLoadingDetail) && <div className="product-dialog-backdrop purchases-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSaving) { setIsFormOpen(false); setDetail(null); } }}>
        {isFormOpen ? <section className="product-dialog purchase-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-form-title">
          <div className="product-dialog-header"><div><p>{t("purchases")}</p><h2 id="purchase-form-title">{t("newPurchase")}</h2></div><button className="product-dialog-close" type="button" onClick={() => setIsFormOpen(false)} disabled={isSaving} aria-label={t("close")}><FiX /></button></div>
          <form className="product-form purchase-form" onSubmit={handleSubmit}>
            <div className="purchase-header-fields">
              <label><span>{t("supplierCompany")} *</span><select required value={form.companyId} onChange={(event) => setForm({ ...form, companyId: event.target.value })}><option value="">{t("selectSupplierCompany")}</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
              <label><span>{t("purchaseDate")} · {t("gregorianDate")} *</span><input type="date" value={form.purchaseDate} onChange={(event) => setForm({ ...form, purchaseDate: event.target.value })} required /><small className="purchase-date-preview" dir="ltr">{solarDate(form.purchaseDate)} · {t("solarDate")}</small></label>
              <label><span>{t("invoiceNumber")}</span><input value={form.invoiceNumber} onChange={(event) => setForm({ ...form, invoiceNumber: event.target.value })} /></label>
            </div>

            <section className="purchase-lines-section"><div className="purchase-lines-heading"><h3>{t("purchaseItems")}</h3><button className="products-secondary-button" type="button" onClick={() => setForm((current) => ({ ...current, items: [...current.items, emptyLine()] }))}><FiPlus />{t("addPurchaseItem")}</button></div>
              {form.items.map((line, index) => <div className="purchase-line" key={line.key}>
                <label className="purchase-line-medicine"><span>{t("medicineName")} {index + 1}</span><select value={line.medicineId} onChange={(event) => handleMedicineChange(line.key, event.target.value)} required><option value="">{t("selectMedicine")}</option>{medicines.map((medicine) => <option key={medicine.id} value={medicine.id}>{medicineStockLabel(medicine, t)}</option>)}</select></label>
                <label><span>{t("quantity")}</span><input type="number" min="1" step="1" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} required /></label>
                <label><span>{t("purchaseUnit")}</span><select value={line.unitType} onChange={(event) => { const unitType = event.target.value; const medicine = medicines.find((entry) => entry.id === line.medicineId); updateLine(line.key, { unitType, unitPrice: convertUnitPrice(line.unitPrice, line.unitType, unitType, medicine?.unitsPerPack), salePrice: convertUnitPrice(line.salePrice, line.unitType, unitType, medicine?.unitsPerPack) }); }}><option value="pack">{t("perPack")}</option><option value="unit">{t("perUnit")}</option></select></label>
                <label><span>{t("unitPurchasePrice")}</span><input type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} required /></label>
                <label><span>{t("salePrice")} · {t(line.unitType === "pack" ? "perPack" : "perUnit")}</span><input type="number" min="0" step="0.01" value={line.salePrice} onChange={(event) => updateLine(line.key, { salePrice: event.target.value })} required /></label>
                <label><span>{t("expiryDate")} *</span><input type="date" value={line.expiryDate} onChange={(event) => updateLine(line.key, { expiryDate: event.target.value })} required /></label>
                <div className="purchase-line-total"><span>{t("lineTotal")}</span><strong>{money(roundMoney((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0)))}</strong></div>
                <button className="purchase-remove-line" type="button" onClick={() => setForm((current) => ({ ...current, items: current.items.length > 1 ? current.items.filter((entry) => entry.key !== line.key) : current.items }))} aria-label={t("removePurchaseItem")} title={t("removePurchaseItem")}><FiTrash2 /></button>
              </div>)}
              {medicines.length === 0 && <p className="purchase-inline-hint">{t("purchaseNeedsMedicine")}</p>}
            </section>

            <div className="purchase-bottom-fields">
              <label className="purchase-notes"><span>{t("purchaseNotes")}</span><textarea rows="3" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              <div className="purchase-totals">
                <div><span>{t("initialAmount")}</span><strong>{money(subtotal)}</strong></div>
                <label><span>{t("discount")}</span><input type="number" min="0" step="0.01" value={form.discount} onChange={(event) => setForm({ ...form, discount: event.target.value })} /></label>
                <div className="purchase-total-emphasis"><span>{t("finalAmount")}</span><strong>{money(total)}</strong></div>
                <label><span>{t("paidAmount")}</span><input type="number" min="0" step="0.01" value={form.paidAmount} onChange={(event) => setForm({ ...form, paidAmount: event.target.value })} /></label>
                <label><span>{t("exp.source")}</span><select value={form.paymentSource} onChange={(event) => setForm({ ...form, paymentSource: event.target.value })}><option value="cash">{t("exp.cash")}</option><option value="other">{t("exp.other")}</option></select></label>
                <div><span>{t("remainingAmount")}</span><strong>{money(remaining)}</strong></div>
              </div>
            </div>
            {formError && <p className="product-form-error" role="alert">{t(formError)}</p>}
            <div className="product-dialog-actions"><button className="products-secondary-button" type="button" onClick={() => setIsFormOpen(false)} disabled={isSaving}>{t("cancel")}</button><button className="products-primary-button" type="submit" disabled={isSaving || medicines.length === 0}>{t(isSaving ? "loading" : "savePurchase")}</button></div>
          </form>
        </section> : <section className="product-dialog purchase-dialog purchase-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-detail-title">
          {isLoadingDetail || !detail ? <div className="purchase-detail-loading">{t("loading")}</div> : <>
            <div className="product-dialog-header"><div><p>{t("purchaseDetails")}</p><h2 id="purchase-detail-title">{detail.invoiceNumber || t("purchaseWithoutInvoice")}</h2></div><button className="product-dialog-close" type="button" onClick={() => setDetail(null)} aria-label={t("close")}><FiX /></button></div>
            <div className={`purchase-detail-content print-paper-${printFormat}`}><div className="purchase-print-header"><div><h2>{detail.companyName}</h2><span>{t("supplierCompany")}</span></div><div><strong>{t("purchaseInvoice")}</strong><span>{detail.invoiceNumber || t("purchaseWithoutInvoice")}</span><span>{detail.purchaseDate} · {detail.purchaseDateSolar}</span></div></div><dl className="purchase-detail-meta"><div><dt>{t("purchaseDate")}</dt><dd className="purchase-dual-date"><span dir="ltr">{detail.purchaseDate} · {t("gregorianDate")}</span><span dir="ltr">{detail.purchaseDateSolar} · {t("solarDate")}</span></dd></div><div><dt>{t("supplierCompany")}</dt><dd>{detail.companyName || "—"}</dd></div><div><dt>{t("purchaseStatus")}</dt><dd><span className={`purchase-status purchase-status-${detail.status}`}>{statusText(detail.status)}</span></dd></div></dl>
              <div className="products-table-scroll"><table className="products-table purchase-detail-table"><thead><tr><th>{t("medicineName")}</th><th>{t("quantity")}</th><th>{t("unitPurchasePrice")}</th><th>{t("salePrice")}</th><th>{t("expiryDate")}</th><th>{t("lineTotal")}</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td>{item.medicineName}</td><td>{item.quantity} {t(item.unitType === "unit" ? "perUnit" : "perPack")}</td><td>{money(item.unitPrice)}</td><td>{money(item.salePrice)} / {t(item.unitType === "unit" ? "perUnit" : "perPack")}</td><td dir="ltr">{item.expiryDate || "—"}</td><td>{money(item.lineTotal)}</td></tr>)}</tbody></table></div>
              <div className="purchase-detail-totals"><p><span>{t("initialAmount")}</span><strong>{money(detail.subtotal)}</strong></p><p><span>{t("discount")}</span><strong>{money(detail.discount)}</strong></p><p><span>{t("finalAmount")}</span><strong>{money(detail.total)}</strong></p><p><span>{t("paidAmount")}</span><strong>{money(detail.paidAmount)}</strong></p><p><span>{t("remainingAmount")}</span><strong>{money(detail.remainingAmount)}</strong></p></div>
              {detail.remainingAmount > 0 && !isPaymentFormOpen && <button className="products-primary-button purchase-record-payment-button" type="button" onClick={() => { setPaymentForm({ amount: String(detail.remainingAmount), paymentDate: localToday(), paymentSource: "cash", notes: "" }); setPaymentError(""); setIsPaymentFormOpen(true); }}>{t("recordPayment")}</button>}
              {detail.status !== "returned" && !isPaymentFormOpen && <button className="purchase-return-button" type="button" onClick={handleReturnPurchase} disabled={isReturning}><FiRotateCcw /> {t(isReturning ? "loading" : "returnPurchase")}</button>}
              {paymentError && !isPaymentFormOpen && <p className="product-form-error" role="alert">{t(paymentError)}</p>}
              {isPaymentFormOpen && detail.remainingAmount > 0 && <form className="purchase-payment-form" onSubmit={handleRecordPayment}>
                <h3>{t("recordPayment")}</h3><p>{t("remainingAmount")}: <strong>{money(detail.remainingAmount)}</strong></p>
                <div className="purchase-payment-fields">
                  <label><span>{t("paymentAmount")}</span><input type="number" min="0.01" max={detail.remainingAmount} step="0.01" value={paymentForm.amount} onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })} required /></label>
                  <label><span>{t("exp.source")}</span><select value={paymentForm.paymentSource} onChange={(event) => setPaymentForm({ ...paymentForm, paymentSource: event.target.value })}><option value="cash">{t("exp.cash")}</option><option value="other">{t("exp.other")}</option></select></label>
                  <label><span>{t("paymentDate")} · {t("gregorianDate")}</span><input type="date" value={paymentForm.paymentDate} onChange={(event) => setPaymentForm({ ...paymentForm, paymentDate: event.target.value })} required /><small className="purchase-date-preview" dir="ltr">{solarDate(paymentForm.paymentDate)} · {t("solarDate")}</small></label>
                  <label><span>{t("purchaseNotes")}</span><input value={paymentForm.notes} onChange={(event) => setPaymentForm({ ...paymentForm, notes: event.target.value })} /></label>
                </div>
                {paymentError && <p className="product-form-error" role="alert">{t(paymentError)}</p>}
                <div className="product-dialog-actions"><button className="products-secondary-button" type="button" onClick={() => setIsPaymentFormOpen(false)} disabled={isRecordingPayment}>{t("cancel")}</button><button className="products-primary-button" type="submit" disabled={isRecordingPayment}>{t(isRecordingPayment ? "loading" : "savePayment")}</button></div>
              </form>}
              {detail.payments?.length > 0 && <section className="purchase-payment-history"><h3>{t("paymentHistory")}</h3><div className="products-table-scroll"><table className="products-table purchase-detail-table"><thead><tr><th>{t("paymentDate")}</th><th>{t("paymentType")}</th><th>{t("exp.source")}</th><th>{t("paymentAmount")}</th><th>{t("purchaseNotes")}</th><th>{t("actions")}</th></tr></thead><tbody>{detail.payments.map((payment) => <tr key={payment.id}><td><div className="purchase-dual-date"><span dir="ltr">{payment.paymentDate}</span><small dir="ltr">{payment.paymentDateSolar} · {t("solarDate")}</small></div></td><td>{t(payment.paymentType === "initial" ? "initialPayment" : "settlementPayment")}</td><td>{t(`exp.${payment.paymentSource || "unrecorded"}`)}</td><td>{money(payment.amount)}</td><td>{payment.notes || "—"}</td><td><button className="purchase-view-button" type="button" onClick={() => setReceipt({ ...payment, companyName: detail.companyName, invoiceNumber: detail.invoiceNumber })} aria-label={t("printReceipt")} title={t("printReceipt")}><FiPrinter /></button></td></tr>)}</tbody></table></div></section>}
              {detail.notes && <div className="purchase-detail-notes"><strong>{t("purchaseNotes")}</strong><p>{detail.notes}</p></div>}
              <div className="purchase-document-actions"><PrintControls format={printFormat} onFormatChange={setPrintFormat} label={t("printInvoice")}/></div>
            </div>
          </>}
        </section>}
      </div>}
      {receipt && <div className="product-dialog-backdrop purchases-backdrop purchase-receipt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReceipt(null); }}><section className="product-dialog purchase-receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-receipt-title"><header className="product-dialog-header"><div><p>{t("purchasePaymentReceipt")}</p><h2 id="purchase-receipt-title">{receipt.invoiceNumber}</h2></div><button className="product-dialog-close" type="button" onClick={() => setReceipt(null)} aria-label={t("close")}><FiX /></button></header><div className={`purchase-receipt-print print-paper-${printFormat}`}><div className="purchase-print-header"><div><h2>{receipt.companyName}</h2><span>{t("supplierCompany")}</span></div><div><strong>{t("purchasePaymentReceipt")}</strong><span>{t("receiptNumber")}: {receipt.id.slice(0, 8).toUpperCase()}</span><span>{receipt.invoiceNumber}</span><span>{receipt.paymentDate} · {receipt.paymentDateSolar}</span></div></div><div className="purchase-receipt-amount"><span>{t(receipt.paymentType === "initial" ? "initialPayment" : "settlementPayment")}</span><strong>{money(receipt.amount)}</strong></div>{receipt.notes && <p>{receipt.notes}</p>}</div><footer className="product-dialog-actions purchase-document-actions"><PrintControls format={printFormat} onFormatChange={setPrintFormat} label={t("printReceipt")}/><button className="products-secondary-button" type="button" onClick={() => setReceipt(null)}>{t("close")}</button></footer></section></div>}
    </div>
  );
}

export default Purchases;
