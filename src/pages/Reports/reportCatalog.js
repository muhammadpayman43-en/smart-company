// Every card declares its source, period basis and available filters. Unsupported sources
// remain discoverable with an explanation instead of fabricated rows or zero balances.
const define = (category, entries) => entries.map(([id, view, option, unavailable]) => ({
  id, category, view, option, unavailable, permission: "administrator",
  title: `r.${id}`, description: `r.${id}.description`,
  basis: ["inventory", "expiry"].includes(category) ? "current" : ["customers", "suppliers"].includes(category) ? "asOf" : "period",
  filters: category === "sales" ? ["medicine", "customer", "manufacturer", "formula", "status", "method"]
    : category === "purchases" ? ["medicine", "supplier", "manufacturer", "status"]
    : category === "inventory" || category === "expiry" ? ["medicine", "manufacturer", "formula"]
    : category === "customers" ? ["customer"] : category === "suppliers" ? ["supplier"] : ["method"],
}));

export const reportCatalog = [
  ...define("sales", [
    ["salesSummary", "sales", "invoices"], ["salesDaily", "sales", "daily"],
    ["salesMonthly", "sales", "monthly"], ["salesYearly", "sales", "yearly"],
    ["salesInvoices", "sales", "lines"], ["salesMedicine", "sales", "medicine"],
    ["salesCustomer", "sales", "customer"], ["salesEmployee", null, null, "employee"],
    ["salesWarehouse", null, null, "warehouse"], ["salesPayment", "sales", "payment"],
    ["salesManufacturer", "sales", "manufacturer"], ["salesFormula", "sales", "formula"],
    ["salesBest", "sales", "best"], ["salesLeast", "sales", "least"],
    ["salesDiscounts", "sales", "discounts"], ["salesReturns", "sales", "returns"],
    ["salesUnpaid", "sales", "unpaid"], ["salesTrend", "sales", "daily"],
  ]),
  ...define("purchases", [
    ["purchasesSummary", "purchases", "invoices"], ["purchasesInvoices", "purchases", "lines"],
    ["purchasesMedicine", "purchases", "medicine"], ["purchasesSupplier", "purchases", "supplier"],
    ["purchasesManufacturer", "purchases", "manufacturer"], ["purchasesPayment", "purchases", "payment"],
    ["purchasesReturns", "purchases", "returns"], ["purchasesDiscounts", "purchases", "discounts"],
    ["purchasesUnpaid", "purchases", "unpaid"], ["purchasePrices", "purchases", "prices"],
  ]),
  ...define("inventory", [
    ["inventoryCurrent", "inventory", "current"], ["inventoryWarehouse", null, null, "warehouse"],
    ["inventoryBatches", "expiry", "all"], ["inventoryManufacturer", "inventory", "manufacturer"],
    ["inventoryFormula", "inventory", "formula"], ["inventoryMovements", "inventory", "movements"],
    ["inventoryLow", "inventory", "low"], ["inventoryOut", "inventory", "out"],
    ["inventoryOver", null, null, "stockCeiling"], ["inventoryIdle", "inventory", "idle"],
    ["inventoryCost", "inventory", "cost"], ["inventoryRetail", "inventory", "retail"],
    ["inventoryAdjustments", null, null, "adjustment"], ["inventoryTransfers", null, null, "warehouse"],
    ["inventoryWaste", null, null, "waste"], ["inventoryCount", null, null, "count"],
    ["inventoryInconsistent", "inventory", "inconsistent"],
  ]),
  ...define("expiry", [
    ["expiryExpired", "expiry", "expired"], ["expiryNear", "expiry", "near"],
    ["expiry30", "expiry", 30], ["expiry60", "expiry", 60], ["expiry90", "expiry", 90], ["expiry180", "expiry", 180],
    ["expiryBuckets", "expiry", "buckets"], ["expiryBatch", "expiry", "all"],
    ["expirySellable", "expiry", "sellable"], ["expiryExpiredValue", "expiry", "expired"],
    ["expiryRiskValue", "expiry", "near"], ["expiryMissing", "expiry", "missing"],
    ["expiryFefo", "expiry", "fefo"], ["expiryHistory", "expiry", "history"],
  ]),
  ...define("customers", [
    ["customerAccounts", "customers", "accounts"], ["customerStatement", "customers", "statement"],
    ["customerDebtors", "customers", "debtors"], ["customerCredits", "customers", "credits"],
    ["customerAgeing", "customers", "ageing"], ["customerOverdue", null, null, "dueDate"],
    ["customerReceipts", "cash", "receipts"], ["customerTop", "sales", "customer"],
    ["customerInactive", "customers", "inactive"], ["customerCreditLimit", null, null, "creditLimit"],
    ["customerBalances", "customers", "balances"],
  ]),
  ...define("suppliers", [
    ["supplierAccounts", "suppliers", "accounts"], ["supplierStatement", "suppliers", "statement"],
    ["supplierDebts", "suppliers", "debtors"], ["supplierCredits", "suppliers", "credits"],
    ["supplierAgeing", "suppliers", "ageing"], ["supplierDue", null, null, "dueDate"],
    ["supplierPayments", "cash", "payments"], ["supplierTop", "purchases", "supplier"],
    ["supplierBalances", "suppliers", "balances"],
  ]),
  ...define("cash", [
    ["cashReceipts", "cash", "receipts"], ["cashPayments", "cash", "payments"],
    ["cashMovement", "cash", "all"], ["cashBank", null, null, "bank"],
    ["cashTransfer", null, null, "bank"], ["cashBalance", "cash", "balance"],
    ["cashFlow", "cash", "all"], ["cashMethods", "cash", "methods"],
    ["cashReconcile", null, null, "openingCash"], ["cashCorrections", null, null, "audit"],
  ]),
  ...define("profit", [["grossProfit", "profit", "gross"], ["expensesReport", "expenses", "expenses"], ["netProfit", "profit", "net"]]),
  ...define("employees", [["employeeActivity", null, null, "employee"]]),
  ...define("management", [["businessOverview", "overview", "overview"]]),
].map((report) => ({ ...report,
  description: `r.desc.${report.unavailable || report.view}`,
  basis: ["inventoryMovements", "inventoryIdle", "expiryHistory", "customerInactive"].includes(report.id) || ["cash", "sales", "purchases"].includes(report.view) ? "period" : report.basis,
}));

export const reportCategories = ["sales", "purchases", "inventory", "expiry", "customers", "suppliers", "cash", "profit", "employees", "management"];
export const normalizeSearch = (value) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[\u064b-\u065f\u200c]/g, " ").replace(/\s+/g, " ").trim();
