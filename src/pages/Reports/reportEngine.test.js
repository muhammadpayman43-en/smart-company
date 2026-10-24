import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, createReportContext, presetRange, kabulToday } from "./reportEngine.js";
import { reportCatalog, normalizeSearch } from "./reportCatalog.js";
import { reportTranslations } from "../../i18n/reports.js";
import { expenseTranslations } from "../../i18n/expenses.js";

function fixture() {
  return {
    today: "2026-10-20", settings: [], company: [], pendingSync: 0,
    medicines: [{ id: "m", name: "Medicine", barcode: "123", company_id: "manufacturer", manufacturer: "Manufacturer", formula_id: "formula", formula: "Formula", units_per_pack: 10, stock: 12, created_at: "2026-01-01" }],
    customers: [{ id: "c", name: "Customer", created_at: "2026-01-01" }], suppliers: [{ id: "s", name: "Supplier", created_at: "2026-01-01" }, { id: "manufacturer", name: "Manufacturer", created_at: "2026-01-01" }],
    purchases: [{ id: "p", company_id: "s", company_name: "Supplier", invoice_number: "P-1", purchase_date: "2026-10-01", subtotal: 100, discount: 10, total: 90, paid_amount: 90, remaining_amount: 0, status: "paid" }],
    purchaseItems: [{ id: "pi", purchase_id: "p", medicine_id: "m", medicine_name: "Medicine", quantity: 2, unit_type: "pack", units_per_pack: 10, unit_price: 50, sale_price: 125, line_total: 100, expiry_date: "2026-11-10" }],
    purchasePayments: [{ id: "pp1", purchase_id: "p", date: "2026-10-01", amount: 20 }, { id: "pp2", purchase_id: "p", date: "2026-10-22", amount: 70 }], purchaseReturns: [],
    sales: [{ id: "s1", invoice_number: "S-1", customer_id: "c", customer_name: "Customer", sale_datetime: "2026-10-10T10:00:00", subtotal: 100, line_discount_total: 10, discount: 10, total: 80, paid_amount: 80, remaining_amount: 0, status: "paid", payment_method: "cash", reversed_at: null }],
    saleItems: [{ id: "si", sale_id: "s1", medicine_id: "m", medicine_name: "Medicine", quantity: 8, unit_type: "unit", units_per_pack: 10, unit_price: 12.5, discount: 10, line_total: 90 }],
    salePayments: [{ id: "sp1", sale_id: "s1", date: "2026-10-10T10:00:00", amount: 30, payment_type: "receipt", payment_method: "cash" }, { id: "sp2", sale_id: "s1", date: "2026-10-25T10:00:00", amount: 50, payment_type: "receipt", payment_method: "bank" }],
    batches: [{ id: "b", medicine_id: "m", purchase_item_id: "pi", purchase_id: "p", batch_number: "B-1", expiry_date: "2026-11-10", quantity_remaining: 12, unit_cost: 4.5, unit_sale_price: 12.5 }],
    allocations: [{ sale_item_id: "si", batch_id: "b", quantity: 8 }], creditEntries: [], creditApplications: [], creditSettlements: [],
    movements: [{ id: "im1", medicine_id: "m", reference_type: "purchase", reference_id: "p", quantity_change: 20, date: "2026-10-01" }, { id: "im2", medicine_id: "m", reference_type: "sale", reference_id: "s1", quantity_change: -8, date: "2026-10-10" }],
  };
}
const range = { from: "2026-10-01", to: "2026-10-20", lowStock: 15 };
const report = (id, data = fixture(), filters = range) => buildReport(reportCatalog.find((r) => r.id === id), createReportContext(data, filters));

test("invoice cut-off ignores later receipts, and separates manufacturer from supplier", () => {
  const data = fixture(), c = createReportContext(data, range);
  assert.equal(c.metrics.sales, 80); assert.equal(c.metrics.purchases, 90);
  assert.equal(c.metrics.receivables, 50); assert.equal(c.metrics.payables, 70);
  assert.equal(c.metrics.gross, 44); assert.equal(c.metrics.stockValue, 54);
  assert.equal(c.metrics.expiring, 1); assert.equal(c.metrics.low, 1);
  assert.equal(report("salesSummary").rows[0].status, "partial");
  assert.equal(report("purchasesManufacturer").rows[0].name, "Manufacturer");
  assert.equal(report("purchasesSupplier").rows[0].name, "Supplier");
  assert.equal(report("purchasesMedicine").rows[0].quantity, 20);
  assert.equal(report("salesMedicine").rows[0].quantity, 8);
  assert.equal(report("supplierPayments").rows.length, 1);
});

test("older invoice returns belong to the return period and preserve customer credit", () => {
  const data = fixture();
  data.sales[0] = { ...data.sales[0], status: "returned", paid_amount: 0, reversed_at: "2026-10-20T10:00:00" };
  data.salePayments = data.salePayments.slice(0, 1);
  data.creditEntries.push({ id: "credit", customer_id: "c", source_type: "sale_return", source_id: "s1", amount: 30, date: "2026-10-20" });
  const c = createReportContext(data, { ...range, from: "2026-10-20" });
  assert.equal(c.metrics.sales, -80); assert.equal(c.metrics.gross, -44);
  assert.equal(c.customerAccounts[0].debt, 0); assert.equal(c.customerAccounts[0].credit, 30);
  assert.equal(c.customerAccounts[0].balance, -30);
  const statement = report("customerStatement", data, { ...range, from: "2026-10-20" });
  assert.equal(statement.rows[0].balance, 50); assert.equal(statement.rows.at(-1).balance, -30);
  assert.equal(report("salesSummary", data, { ...range, to: "2026-10-19" }).rows[0].status, "partial");
});

test("credit applications reduce debt once and are not duplicate cash receipts", () => {
  const data = fixture();
  data.cashTransactions=[{id:"cash-receipt",date:"2026-10-10",direction:"IN",category:"SALE",amount:30,currency:"AFN",amount_afn:30}];
  data.creditEntries.push({ id: "cr", customer_id: "c", source_type: "receipt_overpayment", source_id: "old", amount: 20, date: "2026-09-30" });
  data.creditApplications.push({ id: "app", customer_id: "c", sale_id: "s1", amount: 20, date: "2026-10-10" });
  const c = createReportContext(data, range);
  assert.equal(c.customerAccounts[0].debt, 30); assert.equal(c.customerAccounts[0].credit, 0);
  const statement = report("customerStatement", data);
  assert.equal(statement.rows[0].balance, -20); assert.equal(statement.rows.at(-1).balance, 30);
  assert.equal(report("cashReceipts", data).summaries[0].value, 30);
});

test("net profit subtracts only operating expenses; cash reports use ledger amounts rather than historic receipts",()=>{
 const data=fixture();
 const original=createReportContext(data,range).metrics.gross;
 data.cashDocuments=[{id:"expense",kind:"EXPENSE",date:"2026-10-20",amount:2,currency:"USD",amount_afn:140},{id:"owner",kind:"WITHDRAWAL",date:"2026-10-20",amount_afn:1000},{id:"deposit",kind:"DEPOSIT",date:"2026-10-20",amount_afn:5000}];
 data.cashTransactions=[{id:"opening",date:"2026-09-30",direction:"IN",category:"DEPOSIT",amount:100,currency:"USD",amount_afn:7000},{id:"expense",date:"2026-10-20",direction:"OUT",category:"EXPENSE",amount:2,currency:"USD",amount_afn:140}];
 const c=createReportContext(data,range);
 assert.equal(c.metrics.expenses,140);assert.equal(c.metrics.net,original-140);
 assert.equal(report("cashBalance",data).rows[0].opening,7000);
 assert.equal(report("cashBalance",data).rows[0].balance,6860);
 assert.equal(report("cashMovement",data).rows.length,1);
 assert.equal(report("expensesReport",data).rows.length,1);
 const legacy=fixture();assert.equal(report("cashMovement",legacy).rows.length,0);
});

test("purchase return removes payable and preserves amount already paid as supplier credit", () => {
  const data = fixture();
  data.purchaseReturns.push({ id: "pr", purchase_id: "p", company_id: "s", credit_amount: 20, date: "2026-10-20" });
  const c = createReportContext(data, { ...range, from: "2026-10-20" });
  assert.equal(c.metrics.purchases, -90); assert.equal(c.metrics.payables, 0);
  const account = c.supplierAccounts.find((r) => r.id === "s");
  assert.equal(account.credit, 20); assert.equal(account.balance, -20);
  assert.equal(report("supplierStatement", data, { ...range, from: "2026-10-20" }).rows.filter((r) => r.entityId === "s").at(-1).balance, -20);
});

test("expiry buckets never overlap, FEFO excludes expired/unknown batches, missing costs stay unknown", () => {
  const data = fixture();
  data.batches = ["2026-10-19", "2026-10-20", "2026-11-19", "2026-11-20", ""].map((date, i) => ({ ...data.batches[0], id: `b${i}`, quantity_remaining: 1, expiry_date: date, unit_cost: i === 4 ? null : 4.5 }));
  data.medicines[0].stock = 5;
  const buckets = report("expiryBuckets", data).rows;
  assert.equal(buckets.reduce((sum, r) => sum + r.count, 0), 5);
  assert.equal(buckets.find((b) => b.id === "days30").count, 2);
  assert.equal(buckets.find((b) => b.id === "days60").count, 1);
  assert.equal(report("expiry30", data).rows.length, 2);
  assert.equal(report("expiryFefo", data).rows.length, 3);
  assert.equal(createReportContext(data, range).metrics.stockValue, null);
  assert.equal(createReportContext(data, range).metrics.gross, null);
});

test("all report cards build and all three languages cover their labels and reasons", () => {
  const c = createReportContext(fixture(), range);
  for (const definition of reportCatalog) {
    const view = buildReport(definition, c);
    assert.ok(Array.isArray(view.rows), definition.id);
    for (const language of ["en", "fa", "ps"]) {
      const dictionary = {...reportTranslations[language],...expenseTranslations[language]};
      for (const key of [definition.title, definition.description, ...view.columns.map((col) => col.label), ...view.notes, ...view.summaries.map((s) => s.label)]) assert.ok(dictionary[key], `${language}: ${definition.id}: ${key}`);
    }
    for (const row of view.rows) for (const column of view.columns) if (["money", "number"].includes(column.type) && row[column.key] != null) assert.ok(Number.isFinite(row[column.key]), `${definition.id}: ${column.key}`);
  }
});

test("Kabul calendar presets, equal normalized Dari letters, empty data and invalid ranges", () => {
  assert.equal(kabulToday(new Date("2026-10-19T21:00:00Z")), "2026-10-20");
  assert.deepEqual(presetRange("week", "2026-10-20"), { from: "2026-10-17", to: "2026-10-20" });
  assert.deepEqual(presetRange("lastMonth", "2026-10-20"), { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(normalizeSearch("شركت دارويي"), normalizeSearch("شرکت دارویی"));
  assert.throws(() => createReportContext(fixture(), { from: "2026-10-20", to: "2026-10-01" }), /invalid_range/);
  const empty = fixture(); for (const [key, value] of Object.entries(empty)) if (Array.isArray(value)) empty[key] = [];
  for (const definition of reportCatalog) assert.doesNotThrow(() => buildReport(definition, createReportContext(empty, range)));
});
