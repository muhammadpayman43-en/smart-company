import { invoke as localInvoke } from "@tauri-apps/api/core";
import {remoteInvoke} from "./remote";
async function invoke(command,args={}) {
  const path=args.databasePath||args.payload?.databasePath;
  if(String(path).startsWith("remote:"))return remoteInvoke(command,args);
  try{return await localInvoke(command,args)}catch(error){if((typeof error==="string"?error:error?.message)==="authentication_required")window.dispatchEvent(new Event("local-session-expired"));throw error}
}

export function getDashboardData(databasePath) {
  return invoke("get_dashboard_data",{databasePath});
}

export function getReportsData(databasePath) {
  return invoke("get_reports_data", { databasePath });
}

export function createLocalDatabase(payload) {
  return invoke("create_local_database_command", { payload });
}

export function listLocalDatabases() {
  return invoke("list_local_databases");
}

export function registerExistingDatabase(databasePath) {
  return invoke("register_existing_database", { databasePath });
}

export function authenticateLocalDatabase(databasePath, identifier, password) {
  return invoke("authenticate_local_database", {
    databasePath,
    identifier,
    password,
  });
}

export function getPendingSyncEvents(databasePath) {
  return invoke("get_pending_sync_events", { databasePath });
}

export function markSyncEventsCompleted(databasePath, eventIds) {
  return invoke("mark_sync_events_completed", { databasePath, eventIds });
}

export function listMedicineFormulas(databasePath) {
  return invoke("list_medicine_formulas", { databasePath });
}

export function createMedicineFormula(payload) {
  return invoke("create_medicine_formula", { payload });
}

export function listPharmaceuticalCompanies(databasePath) {
  return invoke("list_pharmaceutical_companies", { databasePath });
}

export function getCompanyPurchaseAccount(databasePath, companyId) {
  return invoke("get_company_purchase_account", { databasePath, companyId });
}

export function createPharmaceuticalCompany(payload) {
  return invoke("create_pharmaceutical_company", { payload });
}

export function updatePharmaceuticalCompany(payload) {
  return invoke("update_pharmaceutical_company", { payload });
}

export function deletePharmaceuticalCompany(databasePath, companyId, expectedRevision) {
  return invoke("delete_pharmaceutical_company", { databasePath, companyId, expectedRevision });
}

export function listMedicines(databasePath) {
  return invoke("list_medicines", { databasePath });
}

export function createMedicine(payload) {
  return invoke("create_medicine", { payload });
}

export function updateMedicine(payload) {
  return invoke("update_medicine", { payload });
}

export function deleteMedicine(databasePath, medicineId, expectedRevision) {
  return invoke("delete_medicine", { databasePath, medicineId, expectedRevision });
}

export function listPurchases(databasePath) {
  return invoke("list_purchases", { databasePath });
}

export function getPurchase(databasePath, purchaseId) {
  return invoke("get_purchase", { databasePath, purchaseId });
}

export function createPurchase(payload) {
  return invoke("create_purchase", { payload });
}

export function recordPurchasePayment(payload) {
  return invoke("record_purchase_payment", { payload });
}

export function returnPurchase(payload) {
  return invoke("return_purchase", { payload });
}

export function deletePurchase(databasePath, purchaseId, expectedRevision) {
  return invoke("delete_purchase", { databasePath, purchaseId, expectedRevision });
}

export function listCustomers(databasePath) {
  return invoke("list_customers", { databasePath });
}

export function createCustomer(payload) {
  return invoke("create_customer", { payload });
}

export function updateCustomer(payload) {
  return invoke("update_customer", { payload });
}

export function deleteCustomer(databasePath, customerId, expectedRevision) {
  return invoke("delete_customer", { databasePath, customerId, expectedRevision });
}

export function getCustomerAccount(databasePath, customerId) {
  return invoke("get_customer_account", { databasePath, customerId });
}

export function recordCustomerCreditSettlement(payload) {
  return invoke("record_customer_credit_settlement", { payload });
}

export function getCompanyInfo(databasePath) {
  return invoke("get_company_info", { databasePath });
}

export function listSales(databasePath) {
  return invoke("list_sales", { databasePath });
}

export function getSale(databasePath, saleId) {
  return invoke("get_sale", { databasePath, saleId });
}

export function createSale(payload) {
  return invoke("create_sale", { payload });
}

export function recordSalePayment(payload) {
  return invoke("record_sale_payment", { payload });
}

export function cancelSale(databasePath, saleId) {
  return invoke("cancel_sale", { databasePath, saleId });
}

export function deleteSale(databasePath, saleId, expectedRevision) {
  return invoke("delete_sale", { databasePath, saleId, expectedRevision });
}

export function importMedicines(payload) {
  return invoke("import_medicines", { payload });
}

export function saveExcelExport(filePath, bytes) {
  return invoke("save_excel_export", { filePath, bytes });
}

export function getAppSettings(databasePath) {
  return invoke("get_app_settings", { databasePath });
}

export function saveAppSettings(payload) {
  return invoke("save_app_settings", { payload });
}

export const backupLocalDatabase = (databasePath, destinationPath) => invoke("backup_local_database", { databasePath, destinationPath });
export const restoreLocalDatabase = (databasePath, sourcePath) => invoke("restore_local_database", { databasePath, sourcePath });

export function listExpiryAlerts(databasePath) {
  return invoke("list_expiry_alerts", { databasePath });
}

export const getCashRegister = (databasePath) => invoke("get_cash_register", { databasePath });
export const saveCashDocument = (payload) => invoke("save_cash_document", { payload });
export const deleteCashDocument = (databasePath, id, expectedRevision) => invoke("delete_cash_document", { databasePath, id, expectedRevision });
export const getCashDocumentHistory = (databasePath, id) => invoke("get_cash_document_history", { databasePath, id });
