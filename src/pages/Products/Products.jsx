import {useRemoteRefresh} from "../../hooks/useRemoteRefresh";
﻿import { useEffect, useRef, useState } from "react";
import { FiPlus, FiSearch, FiX, FiUpload, FiDownload, FiPackage, FiChevronDown, FiEdit2, FiTrash2 } from "react-icons/fi";
import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useLanguage } from "../../i18n/translation";
import {
  createMedicine,
  updateMedicine,
  deleteMedicine,
  createMedicineFormula,
  createPharmaceuticalCompany,
  importMedicines,
  listMedicineFormulas,
  listMedicines,
  listPharmaceuticalCompanies,
  saveExcelExport,
} from "../../sevices/database";
import {
  buildMedicineExportBlob,
  parseMedicineWorkbook,
} from "../../utils/medicineExcel";
import "./Products.css";

const emptyMedicine = {
  name: "",
  barcode: "",
  formulaId: "",
  companyId: "",
  batchNumber: "",
  gaugeNumber: "",
  unitsPerPack: "",
  purchasePrice: "0",
  salePrice: "0",
  purchasePriceBasis: "pack",
};

function Products({ database }) {
  const { t } = useLanguage();
  const [medicines, setMedicines] = useState([]);
  const [formulas, setFormulas] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [activeDialog, setActiveDialog] = useState(null);
  const [medicineForm, setMedicineForm] = useState(emptyMedicine);
  const [editingMedicineId, setEditingMedicineId] = useState(null);
  const editingApiRevision=useRef(null);
  const [medicineDialogError, setMedicineDialogError] = useState("");
  const [companyForm, setCompanyForm] = useState({
    name: "",
    country: "",
    address: "",
    email: "",
    phone: "",
  });
  const [companyDialogError, setCompanyDialogError] = useState("");
  const [formulaForm, setFormulaForm] = useState({
    name: "",
    indication: "",
    sideEffects: "",
  });
  const [formulaDialogError, setFormulaDialogError] = useState("");
  const [isSavingFormula, setIsSavingFormula] = useState(false);
  const [pageError, setPageError] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingCompany, setIsSavingCompany] = useState(false);

  const [importRows, setImportRows] = useState([]);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState("");
  const [importSummary, setImportSummary] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const fileInputRef = useRef(null);
  const isMedicineDialogOpen = activeDialog === "medicine";
  const isCompanyDialogOpen = activeDialog === "company";
  const isFormulaDialogOpen = activeDialog === "formula";
  const returnToMedicineAfterLookup = useRef(false);

  const reloadData = async () => {
    const [medicineRows, formulaRows, companyRows] = await Promise.all([
      listMedicines(database.databasePath),
      listMedicineFormulas(database.databasePath),
      listPharmaceuticalCompanies(database.databasePath),
    ]);
    setMedicines(medicineRows);
    setFormulas(formulaRows);
    setCompanies(companyRows);
  };

  useRemoteRefresh(database,reloadData);
  const openMedicineDialog = () => {
    setMedicineDialogError("");
    setMedicineForm(emptyMedicine);
    setEditingMedicineId(null);
    returnToMedicineAfterLookup.current = false;
    setActiveDialog("medicine");
  };

  const closeActiveDialog = () => {
    if (
      (activeDialog === "company" || activeDialog === "formula") &&
      returnToMedicineAfterLookup.current
    ) {
      setActiveDialog("medicine");
      returnToMedicineAfterLookup.current = false;
      return;
    }
    setActiveDialog(null);
  };

  const openCompanyDialog = ({ returnToMedicine = false } = {}) => {
    setCompanyDialogError("");
    setCompanyForm({
      name: "",
      country: "",
      address: "",
      email: "",
      phone: "",
    });
    returnToMedicineAfterLookup.current = returnToMedicine;
    setActiveDialog("company");
  };

  const openFormulaDialog = ({ returnToMedicine = false } = {}) => {
    setFormulaDialogError("");
    setFormulaForm({ name: "", indication: "", sideEffects: "" });
    returnToMedicineAfterLookup.current = returnToMedicine;
    setActiveDialog("formula");
  };

  const handleAddFormula = async (event) => {
    event.preventDefault();
    setFormulaDialogError("");
    const name = formulaForm.name.trim();
    const indication = formulaForm.indication.trim();
    if (!name || !indication) {
      setFormulaDialogError("formulaRequiredFields");
      return;
    }

    setIsSavingFormula(true);
    try {
      const formula = await createMedicineFormula({
        databasePath: database.databasePath,
        ...formulaForm,
        name,
        indication,
        sideEffects: formulaForm.sideEffects.trim(),
      });
      setFormulas((previous) =>
        [...previous.filter((entry) => entry.id !== formula.id), formula].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
      if (returnToMedicineAfterLookup.current) {
        setMedicineForm((previous) => ({ ...previous, formulaId: formula.id }));
        setActiveDialog("medicine");
      } else {
        setActiveDialog(null);
      }
    } catch (error) {
      const message = typeof error === "string" ? error : error?.message;
      setFormulaDialogError(
        message === "formula_name_exists"
          ? "formulaNameExists"
          : "formulaSaveFailed",
      );
    } finally {
      setIsSavingFormula(false);
    }
  };

  const handleAddCompany = async (event) => {
    event.preventDefault();
    setCompanyDialogError("");
    const name = companyForm.name.trim();
    const country = companyForm.country.trim();
    if (!name || !country) {
      setCompanyDialogError("companyRequiredFields");
      return;
    }

    setIsSavingCompany(true);
    try {
      const company = await createPharmaceuticalCompany({
        databasePath: database.databasePath,
        ...companyForm,
        name,
        country,
        address: companyForm.address.trim(),
        email: companyForm.email.trim(),
        phone: companyForm.phone.trim(),
      });
      setCompanies((previous) =>
        [...previous.filter((entry) => entry.id !== company.id), company].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
      if (returnToMedicineAfterLookup.current) {
        setMedicineForm((previous) => ({ ...previous, companyId: company.id }));
        setActiveDialog("medicine");
      } else {
        setActiveDialog(null);
      }
    } catch (error) {
      const message = typeof error === "string" ? error : error?.message;
      setCompanyDialogError(
        message === "company_name_exists"
          ? "companyNameExists"
          : "companySaveFailed",
      );
    } finally {
      setIsSavingCompany(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    Promise.all([
      listMedicines(database.databasePath),
      listMedicineFormulas(database.databasePath),
      listPharmaceuticalCompanies(database.databasePath),
    ])
      .then(([medicineRows, formulaRows, companyRows]) => {
        if (!isMounted) return;
        setMedicines(medicineRows);
        setFormulas(formulaRows);
        setCompanies(companyRows);
      })
      .catch(() => {
        if (isMounted) setPageError("productsLoadFailed");
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [database.databasePath]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredMedicines = medicines.filter((medicine) => {
    const matchesSearch =
      !normalizedSearch ||
      [medicine.name, medicine.barcode, medicine.batchNumber, medicine.formulaName, medicine.companyName].some(
        (value) => value?.toLowerCase().includes(normalizedSearch),
      );
    return (
      matchesSearch &&
      (companyFilter === "all" || medicine.companyId === companyFilter)
    );
  });

  const handleAddMedicine = async (event) => {
    event.preventDefault();
    setMedicineDialogError("");

    const name = medicineForm.name.trim();
    const unitsPerPack = Number(medicineForm.unitsPerPack);
    const purchasePrice = Number(medicineForm.purchasePrice) || 0;
    const salePrice = Number(medicineForm.salePrice) || 0;

    if (!name) {
      setMedicineDialogError("medicineNameRequired");
      return;
    }
    if (
      medicineForm.unitsPerPack === "" ||
      !Number.isFinite(unitsPerPack) ||
      unitsPerPack <= 0
    ) {
      setMedicineDialogError("invalidUnitsPerPack");
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        databasePath: database.databasePath,
        ...medicineForm,
        name,
        unitsPerPack,
        purchasePrice,
        salePrice,
      };
      if (editingMedicineId) {
        await updateMedicine({ ...payload, id: editingMedicineId, expectedApiRevision:editingApiRevision.current });
      } else {
        await createMedicine(payload);
      }
      await reloadData();
      setMedicineForm(emptyMedicine);
      setEditingMedicineId(null);
      setActiveDialog(null);
    } catch (error) {
      console.error("Failed to save medicine:", error);
      setMedicineDialogError("medicineSaveFailed");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteMedicine = async (medicine) => {
    if (!window.confirm(`${t("confirmDeleteMedicine")}\n${medicine.name}`)) return;
    setPageError("");
    try {
      await deleteMedicine(database.databasePath, medicine.id,medicine._apiRevision);
      setMedicines((current) => current.filter((entry) => entry.id !== medicine.id));
    } catch (error) {
      console.error("Failed to delete medicine:", error);
      setPageError("medicineDeleteFailed");
    }
  };

  const handleEditMedicine = (medicine) => {
    editingApiRevision.current=medicine._apiRevision;
    setMedicineForm({
      name: medicine.name,
      barcode: medicine.barcode || "",
      formulaId: medicine.formulaId,
      companyId: medicine.companyId,
      batchNumber: medicine.batchNumber || "",
      gaugeNumber: medicine.gaugeNumber || "",
      unitsPerPack: String(medicine.unitsPerPack),
      purchasePrice: String(medicine.purchasePrice),
      salePrice: String(medicine.salePrice),
      purchasePriceBasis: medicine.purchasePriceBasis,
    });
    setEditingMedicineId(medicine.id);
    setMedicineDialogError("");
    setActiveDialog("medicine");
  };

  const validImportRows = importRows.filter((row) => !row.errors?.length);

  const clearImportState = () => {
    setImportFileName("");
    setImportError("");
    setImportSummary(null);
    setImportRows([]);
  };

  const handleImport = async () => {
    if (validImportRows.length === 0 || isImporting) return;

    setIsImporting(true);
    setImportError("");
    try {
      const result = await importMedicines({
        databasePath: database.databasePath,
        rows: validImportRows,
      });
      await reloadData();
      setImportRows([]);
      setImportSummary({
        total: result.imported + result.skipped,
        invalid: result.skipped,
        imported: result.imported,
        skipped: result.skipped,
        completed: true,
      });
    } catch (error) {
      console.error("Failed to import medicines:", error);
      setImportError(
        typeof error === "string" ? error : error?.message || t("importFailed"),
      );
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileSelect = async (file) => {
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      clearImportState();
      setImportError(t("importInvalidFileType"));
      setIsImportDialogOpen(true);
      return;
    }

    clearImportState();
    setIsImportDialogOpen(true);
    setImportFileName(file.name);
    setIsReadingFile(true);
    try {
      const buffer = await file.arrayBuffer();
      const result = await parseMedicineWorkbook(buffer, t);
      const rows = Array.isArray(result?.rows) ? result.rows : [];

      if (rows.length === 0) {
        setImportError(t("importNothingToDo"));
        return;
      }
      if (rows.length > 10_000) {
        setImportError(t("importTooManyRows"));
        return;
      }

      const normalizedRows = rows.map((row) => ({
        ...row,
        errors: Array.isArray(row.errors) ? row.errors : [],
      }));
      setImportRows(normalizedRows);
      setImportSummary({
        total: normalizedRows.length,
        invalid: normalizedRows.filter((row) => row.errors.length > 0).length,
      });
    } catch (error) {
      console.error("Failed to read Excel file:", error);
      setImportError(t("importFailed"));
      setImportSummary({ total: 0, invalid: 0 });
    } finally {
      setIsReadingFile(false);
    }
  };

  const handleExportMedicines = async () => {
    setImportError("");
    setPageError("");
    setExportMessage("");
    try {
      const blob = await buildMedicineExportBlob(filteredMedicines, t);
      if (isTauri()) {
        const filePath = await save({
          title: t("exportMedicines"),
          defaultPath: "medicines.xlsx",
          filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
        });
        if (!filePath) return;
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        await saveExcelExport(filePath, bytes);
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "medicines.xlsx";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setExportMessage(t("exportComplete"));
    } catch (error) {
      console.error("Failed to export medicines:", error);
      setPageError(t("exportFailed"));
    }
  };

  return (
    <div className="products-page">
      <div className="products-page-heading">
        <div>
          <p>{t("inventory")}</p>
          <h1>{t("products")}</h1>
        </div>
      </div>

      {pageError && (
        <p className="products-page-error" role="alert">
          {t(pageError)}
        </p>
      )}
      {exportMessage && <p className="products-export-success" role="status">{exportMessage}</p>}

      <section className="products-toolbar" aria-label={t("productTools")}>
        <label className="products-search">
          <FiSearch aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchMedicines")}
          />
        </label>
        <label className="products-filter">
          <span>{t("company")}</span>
          <select
            value={companyFilter}
            onChange={(event) => setCompanyFilter(event.target.value)}
          >
            <option value="all">{t("allCompanies")}</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </label>
        <div className="products-toolbar-actions">
          <button
            className="products-primary-button products-add-medicine-button"
            type="button"
            onClick={openMedicineDialog}
          >
            <FiPlus aria-hidden="true" /> {t("addMedicine")}
          </button>
          <div className="products-excel-actions">
          <input
            ref={fileInputRef}
            className="excel-import-input"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              handleFileSelect(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button
            className="products-secondary-button products-import-button"
            type="button"
            disabled={isReadingFile || isImporting}
            onClick={() => fileInputRef.current?.click()}
          >
            <FiUpload aria-hidden="true" /> {t("importMedicines")}
          </button>
            <button
              className="products-secondary-button products-export-button"
              type="button"
              disabled={filteredMedicines.length === 0}
              onClick={handleExportMedicines}
            >
              <FiDownload aria-hidden="true" /> {t("exportMedicines")}
            </button>
          </div>
        </div>
      </section>

      <section
        className="products-table-section"
        aria-labelledby="medicine-list-title"
      >
        <div className="products-section-heading">
          <div>
            <h2 id="medicine-list-title">{t("medicineList")}</h2>
            <span>{filteredMedicines.length}</span>
          </div>
        </div>
        <div className="products-table-scroll">
          <table className="products-table">
            <thead>
              <tr>
                <th>{t("medicineName")}</th>
                <th>{t("barcode")}</th>
                <th>{t("formula")}</th>
                <th>{t("company")}</th>
                <th>{t("batchNumber")}</th>
                <th>{t("unitsPerPack")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredMedicines.map((medicine) => (
                <tr key={medicine.id}>
                  <td className="products-medicine-name">{medicine.name}</td>
                  <td dir="ltr">{medicine.barcode || "—"}</td>
                  <td>{medicine.formulaName}</td>
                  <td>{medicine.companyName}</td>
                  <td dir="ltr">{medicine.batchNumber || "—"}</td>
                  <td>{medicine.unitsPerPack}</td>
                  <td>
                    <div className="medicine-row-actions">
                      <button type="button" className="medicine-row-action medicine-row-edit" onClick={() => handleEditMedicine(medicine)} aria-label={`${t("edit")} ${medicine.name}`} title={t("edit")}>
                        <FiEdit2 aria-hidden="true" />
                      </button>
                      <button type="button" className="medicine-row-action medicine-row-delete" onClick={() => handleDeleteMedicine(medicine)} aria-label={`${t("delete")} ${medicine.name}`} title={t("delete")}>
                        <FiTrash2 aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!isLoading && filteredMedicines.length === 0 && (
                <tr>
                  <td className="products-empty-cell" colSpan="7">
                    {t(
                      normalizedSearch || companyFilter !== "all"
                        ? "noMedicineMatches"
                        : "noMedicinesYet",
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(isImportDialogOpen || isMedicineDialogOpen || isCompanyDialogOpen || isFormulaDialogOpen) && (
        <div
          className="product-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !isSaving &&
              !isSavingCompany &&
              !isImporting &&
              !isReadingFile
            ) {
              if (isImportDialogOpen) setIsImportDialogOpen(false);
              else closeActiveDialog();
            }
          }}
        >
          <section
            className={`product-dialog${isMedicineDialogOpen ? " medicine-dialog" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={
              isImportDialogOpen
                ? "import-dialog-title"
                : isCompanyDialogOpen
                ? "company-dialog-title"
                : isFormulaDialogOpen
                  ? "formula-dialog-title"
                  : "medicine-dialog-title"
            }
          >
            {isImportDialogOpen ? (
              <>
                <div className="product-dialog-header">
                  <div>
                    <p>{t("importMedicinesDescription")}</p>
                    <h2 id="import-dialog-title">{t("importMedicinesTitle")}</h2>
                  </div>
                  <button
                    type="button"
                    className="product-dialog-close"
                    onClick={() => setIsImportDialogOpen(false)}
                    disabled={isImporting || isReadingFile}
                    aria-label={t("close")}
                  >
                    <FiX aria-hidden="true" />
                  </button>
                </div>
                <div className="product-form product-import-dialog-content">
                  {importFileName && (
                    <p className="excel-import-summary">
                      {t("selectedFile")}: <strong>{importFileName}</strong>
                    </p>
                  )}
                  {isReadingFile && <p role="status">{t("loading")}</p>}
                  {importError && <p className="product-form-error" role="alert">{importError}</p>}
                  {importSummary && !importSummary.completed && (
                    <p className="excel-import-summary">
                      {t("importTotalRows")}: {importSummary.total} · {t("importValidRows")}: {importSummary.total - importSummary.invalid} · {t("importInvalidRows")}: {importSummary.invalid}
                    </p>
                  )}
                  {importSummary?.completed && (
                    <p className="excel-import-summary" role="status">
                      {t("importResult", {
                        imported: importSummary.imported,
                        total: importSummary.total,
                        skipped: importSummary.skipped,
                      })}
                    </p>
                  )}
                  {importRows.length > 0 && (
                    <div className="excel-import-preview">
                      <h3>{t("importPreview")}</h3>
                      <div className="excel-import-preview-scroll">
                        <table className="products-table">
                          <thead>
                            <tr>
                              <th>{t("importRow")}</th>
                              <th>{t("medicineName")}</th>
                              <th>{t("formula")}</th>
                              <th>{t("company")}</th>
                              <th>{t("unitsPerPack")}</th>
                              <th>{t("purchasePrice")}</th>
                              <th>{t("importIssues")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {importRows.slice(0, 20).map((row) => (
                              <tr key={row.rowNumber}>
                                <td>{row.rowNumber}</td>
                                <td>{row.name || "—"}</td>
                                <td>{row.formulaName || "—"}</td>
                                <td>{row.companyName || "—"}</td>
                                <td>{row.unitsPerPack || "—"}</td>
                                <td>{row.purchasePrice}</td>
                                <td className="field-error">{row.errors.map((errorKey) => t(errorKey)).join(", ")}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  <div className="product-dialog-actions">
                    <button
                      type="button"
                      className="products-secondary-button"
                      onClick={() => setIsImportDialogOpen(false)}
                      disabled={isImporting || isReadingFile}
                    >
                      {t(importSummary?.completed ? "importDone" : "cancel")}
                    </button>
                    {!importSummary?.completed && (
                      <button
                        type="button"
                        className="products-primary-button"
                        disabled={validImportRows.length === 0 || isImporting || isReadingFile}
                        onClick={handleImport}
                      >
                        {isImporting ? t("importInProgress") : t("importRun")}
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : isCompanyDialogOpen ? (
              <>
                <div className="product-dialog-header">
                  <h2 id="company-dialog-title">{t("addCompany")}</h2>
                  <button
                    type="button"
                    className="product-dialog-close"
                    onClick={closeActiveDialog}
                    disabled={isSavingCompany || isSaving}
                    aria-label={t("cancel")}
                  >
                    <FiX aria-hidden="true" />
                  </button>
                </div>
                <form className="product-form" onSubmit={handleAddCompany}>
                  <label>
                    <span>{t("companyName")} *</span>
                    <input
                      autoFocus
                      required
                      value={companyForm.name}
                      onChange={(event) =>
                        setCompanyForm({
                          ...companyForm,
                          name: event.target.value,
                        })
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
                  {companyDialogError && (
                    <p className="product-form-error" role="alert">
                      {t(companyDialogError)}
                    </p>
                  )}
                  <div className="product-dialog-actions">
                    <button
                      type="button"
                      className="products-secondary-button"
                      onClick={closeActiveDialog}
                      disabled={isSavingCompany || isSaving}
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="submit"
                      className="products-primary-button"
                      disabled={isSavingCompany}
                    >
                      {t(isSavingCompany ? "loading" : "save")}
                    </button>
                  </div>
                </form>
              </>
            ) : isFormulaDialogOpen ? (
              <>
                <div className="product-dialog-header">
                  <h2 id="formula-dialog-title">{t("addFormula")}</h2>
                  <button
                    type="button"
                    className="product-dialog-close"
                    onClick={closeActiveDialog}
                    disabled={isSavingFormula || isSaving || isSavingCompany}
                    aria-label={t("cancel")}
                  >
                    <FiX aria-hidden="true" />
                  </button>
                </div>
                <form className="product-form" onSubmit={handleAddFormula}>
                  <label>
                    <span>{t("formulaName")} *</span>
                    <input
                      autoFocus
                      required
                      value={formulaForm.name}
                      onChange={(event) =>
                        setFormulaForm({
                          ...formulaForm,
                          name: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{t("indication")} *</span>
                    <textarea
                      required
                      value={formulaForm.indication}
                      onChange={(event) =>
                        setFormulaForm({
                          ...formulaForm,
                          indication: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{t("sideEffects")}</span>
                    <textarea
                      value={formulaForm.sideEffects}
                      onChange={(event) =>
                        setFormulaForm({
                          ...formulaForm,
                          sideEffects: event.target.value,
                        })
                      }
                    />
                  </label>
                  {formulaDialogError && (
                    <p className="product-form-error" role="alert">
                      {t(formulaDialogError)}
                    </p>
                  )}
                  <div className="product-dialog-actions">
                    <button
                      type="button"
                      className="products-secondary-button"
                      onClick={closeActiveDialog}
                      disabled={isSavingFormula || isSaving || isSavingCompany}
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="submit"
                      className="products-primary-button"
                      disabled={isSavingFormula}
                    >
                      {t(isSavingFormula ? "loading" : "save")}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <div className="product-dialog-header">
                  <div className="medicine-dialog-heading">
                    <span className="medicine-dialog-heading-icon"><FiPackage aria-hidden="true" /></span>
                    <div>
                      <span className="medicine-dialog-kicker">{t("inventory")}</span>
                      <h2 id="medicine-dialog-title">{t(editingMedicineId ? "editMedicine" : "addMedicine")}</h2>
                      <p>{t("medicineFormSubtitle")}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="product-dialog-close"
                    onClick={closeActiveDialog}
                    disabled={isSaving || isSavingCompany}
                    aria-label={t("cancel")}
                  >
                    <FiX aria-hidden="true" />
                  </button>
                </div>

                <form className="product-form" onSubmit={handleAddMedicine}>
                  <section className="medicine-form-section">
                    <h3>{t("medicineDetails")}</h3>
                  <div className="product-form-row">
                    <label>
                      <span>{t("medicineName")} *</span>
                      <input
                        type="text"
                        value={medicineForm.name}
                        onChange={(event) =>
                          setMedicineForm({
                            ...medicineForm,
                            name: event.target.value,
                          })
                        }
                        required
                        autoFocus
                      />
                    </label>

                    <div className="product-select-with-add">
                      <label htmlFor="medicine-formula">{t("formula")}</label>
                      <div className="product-select-control">
                        <select
                          id="medicine-formula"
                          value={medicineForm.formulaId}
                          onChange={(event) =>
                            setMedicineForm({ ...medicineForm, formulaId: event.target.value })
                          }
                        >
                          <option value="">-</option>
                          {formulas.map((formula) => (
                            <option key={formula.id} value={formula.id}>{formula.name}</option>
                          ))}
                        </select>
                        <FiChevronDown className="product-select-chevron" aria-hidden="true" />
                        <button type="button" data-access-module="products" data-access-action="create" onClick={() => openFormulaDialog({ returnToMedicine: true })}>
                          <FiPlus aria-hidden="true" /> {t("addFormula")}
                        </button>
                      </div>
                    </div>
                  </div>
                  </section>

                  <section className="medicine-form-section">
                    <h3>{t("stockDetails")}</h3>
                  <div className="product-form-row">
                    <div className="product-select-with-add">
                      <label htmlFor="medicine-company">{t("company")}</label>
                      <div className="product-select-control">
                        <select
                          id="medicine-company"
                          value={medicineForm.companyId}
                          onChange={(event) =>
                            setMedicineForm({ ...medicineForm, companyId: event.target.value })
                          }
                        >
                          <option value="">-</option>
                          {companies.map((company) => (
                            <option key={company.id} value={company.id}>{company.name}</option>
                          ))}
                        </select>
                        <FiChevronDown className="product-select-chevron" aria-hidden="true" />
                        <button type="button" data-access-module="suppliers" data-access-action="create" onClick={() => openCompanyDialog({ returnToMedicine: true })}>
                          <FiPlus aria-hidden="true" /> {t("addCompany")}
                        </button>
                      </div>
                    </div>

                    <label>
                      <span>{t("batchNumber")}</span>
                      <input
                        type="text"
                        value={medicineForm.batchNumber}
                        onChange={(event) =>
                          setMedicineForm({
                            ...medicineForm,
                            batchNumber: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>

                  <div className="product-form-row">
                    <label>
                      <span>{t("barcode")}</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        autoComplete="off"
                        value={medicineForm.barcode}
                        onChange={(event) =>
                          setMedicineForm({
                            ...medicineForm,
                            barcode: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>{t("unitsPerPack")} *</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={medicineForm.unitsPerPack}
                        onChange={(event) =>
                          setMedicineForm({ ...medicineForm, unitsPerPack: event.target.value })
                        }
                        required
                      />
                    </label>
                  </div>
                  </section>

                  {medicineDialogError && (
                    <p className="product-form-error" role="alert">
                      {t(medicineDialogError)}
                    </p>
                  )}

                  <div className="product-dialog-actions">
                    <button
                      type="button"
                      className="products-secondary-button"
                      onClick={closeActiveDialog}
                      disabled={isSaving || isSavingCompany}
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="submit"
                      className="products-primary-button"
                      disabled={isSaving}
                    >
                      {isSaving ? t("loading") : t(editingMedicineId ? "saveChanges" : "save")}
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default Products;

