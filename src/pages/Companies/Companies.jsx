import {useRemoteRefresh} from "../../hooks/useRemoteRefresh";
import { useEffect, useMemo, useState } from "react";
import { FiEdit2, FiPlus, FiSearch, FiTrash2, FiX, FiEye } from "react-icons/fi";
import { useLanguage } from "../../i18n/translation";
import { confirm } from "@tauri-apps/plugin-dialog";
import PrintControls from "../../componets/common/PrintControls/PrintControls";
import {
  createPharmaceuticalCompany,
  deletePharmaceuticalCompany,
  getCompanyPurchaseAccount,
  listPharmaceuticalCompanies,
  updatePharmaceuticalCompany,
} from "../../sevices/database";
import "../Products/Products.css";
import "./Companies.css";
import { useCurrency } from "../../context/CurrencyContext";

const emptyCompany = {
  name: "",
  country: "",
  address: "",
  email: "",
  phone: "",
};

function Companies({ database }) {
  const { t, language } = useLanguage();
  const { currency, fromAfn } = useCurrency();
  const [companies, setCompanies] = useState([]);
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState(null);
  const [companyForm, setCompanyForm] = useState(emptyCompany);
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [deletingCompanyId, setDeletingCompanyId] = useState(null);
  const [account, setAccount] = useState(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [printFormat, setPrintFormat] = useState("a4");

  const reloadCompanies = async () => {
    const rows = await listPharmaceuticalCompanies(database.databasePath);
    setCompanies(rows);
  };

  useRemoteRefresh(database,async()=>{await reloadCompanies();if(account){const loaded=await getCompanyPurchaseAccount(database.databasePath,account.company.id);setAccount(current=>current?.company.id===loaded.company.id?loaded:current);}});
  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    setPageError("");
    listPharmaceuticalCompanies(database.databasePath)
      .then((rows) => {
        if (mounted) setCompanies(rows);
      })
      .catch(() => {
        if (mounted) setPageError("companiesLoadFailed");
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [database.databasePath]);

  const filteredCompanies = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return companies;
    return companies.filter((company) =>
      [
        company.name,
        company.country,
        company.address,
        company.email,
        company.phone,
      ].some((value) => value?.toLocaleLowerCase().includes(query)),
    );
  }, [companies, search]);

  const openCreateDialog = () => {
    setEditingCompany(null);
    setCompanyForm(emptyCompany);
    setFormError("");
    setIsDialogOpen(true);
  };

  const openEditDialog = (company) => {
    setEditingCompany(company);
    setCompanyForm({
      name: company.name ?? "",
      country: company.country ?? "",
      address: company.address ?? "",
      email: company.email ?? "",
      phone: company.phone ?? "",
    });
    setFormError("");
    setIsDialogOpen(true);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const name = companyForm.name.trim();
    const country = companyForm.country.trim();
    if (!name || !country) {
      setFormError("companyRequiredFields");
      return;
    }

    setIsSaving(true);
    setFormError("");
    try {
      const payload = {
        databasePath: database.databasePath,
        ...companyForm,
        name,
        country,
        address: companyForm.address.trim(),
        email: companyForm.email.trim(),
        phone: companyForm.phone.trim(),
      };
      const saved = editingCompany
        ? await updatePharmaceuticalCompany({
            ...payload,
            id: editingCompany.id, expectedApiRevision:editingCompany._apiRevision,
          })
        : await createPharmaceuticalCompany(payload);
      if (editingCompany) {
        setCompanies((current) =>
          current.map((company) =>
            company.id === editingCompany.id ? saved : company,
          ),
        );
      } else {
        setCompanies((current) =>
          [...current, saved].sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
      setIsDialogOpen(false);
    } catch (error) {
      const message = typeof error === "string" ? error : error?.message;
      setFormError(
        message === "company_name_exists"
          ? "companyNameExists"
          : editingCompany
            ? "companyUpdateFailed"
            : "companySaveFailed",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (company) => {
    let confirmed;
    try {
      confirmed = await confirm(
        t("confirmDeleteCompany", { name: company.name }),
        { title: t("deleteCompany"), kind: "warning" },
      );
    } catch {
      setPageError("companyDeleteFailed");
      return;
    }
    if (!confirmed) return;
    setPageError("");
    setDeletingCompanyId(company.id);
    try {
      await deletePharmaceuticalCompany(database.databasePath, company.id,company._apiRevision);
      await reloadCompanies();
    } catch (error) {
      const message = typeof error === "string" ? error : error?.message;
      setPageError(
        message === "company_in_use" ? "companyInUse" : "companyDeleteFailed",
      );
    } finally {
      setDeletingCompanyId(null);
    }
  };

  const openAccount = async (company) => {
    setAccountLoading(true);
    setAccount(null);
    try {
      setAccount(await getCompanyPurchaseAccount(database.databasePath, company.id));
    } catch {
      setPageError("companyPurchaseAccountError");
    } finally {
      setAccountLoading(false);
    }
  };
  const money = (value) => `${new Intl.NumberFormat(language === "fa" ? "fa-AF" : language === "ps" ? "ps-AF" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fromAfn(value) ?? 0)} ${currency}`;

  return (
    <div className="products-page companies-page" dir={language === "en" ? "ltr" : "rtl"}>
      <div className="products-page-heading">
        <div>
          <p>{t("inventory")}</p>
          <h1>{t("companiesTitle")}</h1>
        </div>
        <button
          className="products-primary-button"
          type="button"
          onClick={openCreateDialog}
        >
          <FiPlus aria-hidden="true" /> {t("addCompany")}
        </button>
      </div>

      {pageError && (
        <p className="products-page-error" role="alert">
          {t(pageError)}
        </p>
      )}

      <section className="products-toolbar" aria-label={t("searchCompanies")}>
        <label className="products-search">
          <FiSearch aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchCompanies")}
          />
        </label>
      </section>

      <section
        className="products-table-section"
        aria-labelledby="companies-table-title"
      >
        <div className="products-section-heading">
          <div>
            <h2 id="companies-table-title">{t("companiesTitle")}</h2>
          </div>
          <span>{filteredCompanies.length}</span>
        </div>
        <div className="products-table-scroll">
          <table className="products-table companies-table">
            <thead>
              <tr>
                <th>{t("companyName")}</th>
                <th>{t("country")}</th>
                <th>{t("address")}</th>
                <th>{t("email")}</th>
                <th>{t("phone")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredCompanies.map((company) => (
                <tr key={company.id}>
                  <td className="products-medicine-name">{company.name}</td>
                  <td>{company.country || "—"}</td>
                  <td>{company.address || "—"}</td>
                  <td>{company.email || "—"}</td>
                  <td>{company.phone || "—"}</td>
                  <td className="company-row-actions">
                    <button
                      className="company-icon-button"
                      type="button"
                      aria-label={`${t("companyPurchaseHistory")} ${company.name}`}
                      title={t("companyPurchaseHistory")}
                      onClick={() => openAccount(company)}
                    >
                      <FiEye aria-hidden="true" />
                    </button>
                    <button
                      className="company-icon-button"
                      type="button"
                      aria-label={`${t("edit")} ${company.name}`}
                      onClick={() => openEditDialog(company)}
                    >
                      <FiEdit2 aria-hidden="true" />
                    </button>
                    <button
                      className="company-icon-button is-danger"
                      type="button"
                      aria-label={`${t("delete")} ${company.name}`}
                      disabled={deletingCompanyId === company.id}
                      onClick={() => handleDelete(company)}
                    >
                      <FiTrash2 aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
              {!isLoading && filteredCompanies.length === 0 && (
                <tr>
                  <td className="products-empty-cell" colSpan="6">
                    {t(search ? "noCompaniesMatch" : "noCompaniesYet")}
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td className="products-empty-cell" colSpan="6">
                    {t("loading")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {isDialogOpen && (
        <div
          className="product-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSaving)
              setIsDialogOpen(false);
          }}
        >
          <section
            className="product-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="company-dialog-title"
          >
            <div className="product-dialog-header">
              <h2 id="company-dialog-title">
                {t(editingCompany ? "editCompany" : "addCompany")}
              </h2>
              <button
                className="product-dialog-close"
                type="button"
                onClick={() => setIsDialogOpen(false)}
                disabled={isSaving}
                aria-label={t("cancel")}
              >
                <FiX aria-hidden="true" />
              </button>
            </div>
            <form className="product-form" onSubmit={handleSubmit}>
              <label>
                <span>{t("companyName")} *</span>
                <input
                  autoFocus
                  required
                  value={companyForm.name}
                  onChange={(event) =>
                    setCompanyForm({ ...companyForm, name: event.target.value })
                  }
                />
              </label>
              <div className="product-form-row">
                <label>
                  <span>{t("country")} *</span>
                  <input
                    required
                    value={companyForm.country}
                    onChange={(event) =>
                      setCompanyForm({
                        ...companyForm,
                        country: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  <span>{t("phone")}</span>
                  <input
                    type="tel"
                    value={companyForm.phone}
                    onChange={(event) =>
                      setCompanyForm({
                        ...companyForm,
                        phone: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <label>
                <span>{t("address")}</span>
                <input
                  value={companyForm.address}
                  onChange={(event) =>
                    setCompanyForm({
                      ...companyForm,
                      address: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>{t("email")}</span>
                <input
                  type="email"
                  value={companyForm.email}
                  onChange={(event) =>
                    setCompanyForm({
                      ...companyForm,
                      email: event.target.value,
                    })
                  }
                />
              </label>
              {formError && (
                <p className="product-form-error" role="alert">
                  {t(formError)}
                </p>
              )}
              <div className="product-dialog-actions">
                <button
                  className="products-secondary-button"
                  type="button"
                  onClick={() => setIsDialogOpen(false)}
                  disabled={isSaving}
                >
                  {t("cancel")}
                </button>
                <button
                  className="products-primary-button"
                  type="submit"
                  disabled={isSaving}
                >
                  {t(isSaving ? "loading" : "save")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {(accountLoading || account) && (
        <div className="product-dialog-backdrop company-account-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccount(null); }}>
          {accountLoading ? <div className="company-account-loading">{t("loading")}</div> : <section className="product-dialog company-account-dialog" role="dialog" aria-modal="true" aria-labelledby="company-account-title">
            <header className="product-dialog-header"><div><p>{t("companyPurchaseAccount")}</p><h2 id="company-account-title">{account.company.name}</h2><span>{account.company.country} {account.company.phone && `· ${account.company.phone}`}</span></div><button className="product-dialog-close" type="button" onClick={() => setAccount(null)} aria-label={t("close")}><FiX /></button></header>
            <div className="company-account-body">
              <div className="company-account-stats"><article><span>{t("totalPurchases")}</span><strong>{money(account.totalPurchases)}</strong></article><article><span>{t("totalPaid")}</span><strong>{money(account.totalPaid)}</strong></article><article><span>{t("amountOwedCompany")}</span><strong>{money(account.amountOwed)}</strong></article><article><span>{t("supplierCredit")}</span><strong>{money(account.supplierCredit)}</strong></article></div>
              <div className={`company-account-print print-paper-${printFormat}`}><div className="company-account-print-heading"><h2>{account.company.name}</h2><strong>{t("companyPurchaseHistory")}</strong></div><div className="products-table-scroll"><table className="products-table company-purchase-table"><thead><tr><th>{t("invoiceNumber")}</th><th>{t("purchaseDate")}</th><th>{t("finalAmount")}</th><th>{t("paidAmount")}</th><th>{t("remainingAmount")}</th><th>{t("purchaseStatus")}</th></tr></thead><tbody>{account.purchases.length === 0 ? <tr><td colSpan="6" className="products-empty-cell">{t("noPurchases")}</td></tr> : account.purchases.map((purchase) => <tr key={purchase.id}><td>{purchase.invoiceNumber || "—"}</td><td><span dir="ltr">{purchase.purchaseDate}</span><small dir="ltr">{purchase.purchaseDateSolar} · {t("solarDate")}</small></td><td>{money(purchase.total)}</td><td>{money(purchase.paidAmount)}</td><td>{money(purchase.remainingAmount)}</td><td>{t(({ paid: "purchasePaid", partial: "purchasePartial", unpaid: "purchaseUnpaid", returned: "purchaseReturned" })[purchase.status])}</td></tr>)}</tbody></table></div><section className="company-account-payment-history"><h3>{t("companyPaymentHistory")}</h3><div className="products-table-scroll"><table className="products-table company-purchase-table"><thead><tr><th>{t("paymentDate")}</th><th>{t("invoiceNumber")}</th><th>{t("paymentType")}</th><th>{t("paymentAmount")}</th><th>{t("purchaseNotes")}</th></tr></thead><tbody>{account.payments.length === 0 ? <tr><td colSpan="5" className="products-empty-cell">{t("noPurchasePayments")}</td></tr> : account.payments.map((payment) => <tr key={payment.id}><td><span dir="ltr">{payment.paymentDate}</span><small dir="ltr">{payment.paymentDateSolar} · {t("solarDate")}</small></td><td>{payment.invoiceNumber || "—"}</td><td>{t(payment.paymentType === "initial" ? "initialPayment" : "settlementPayment")}</td><td>{money(payment.amount)}</td><td>{payment.notes || "—"}</td></tr>)}</tbody></table></div></section><div className="company-account-print-total"><span>{t("amountOwedCompany")}</span><strong>{money(account.amountOwed)}</strong></div></div>
              <div className="company-account-actions"><PrintControls format={printFormat} onFormatChange={setPrintFormat} label={t("printStatement")}/></div>
            </div>
          </section>}
        </div>
      )}
    </div>
  );
}

export default Companies;
