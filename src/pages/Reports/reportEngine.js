const DAY = 86400000;
export const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const sum = (rows, key) => rows.reduce((total, row) => total + Number(typeof key === "function" ? key(row) : row[key] || 0), 0);
const index = (rows) => new Map(rows.map((row) => [row.id, row]));
const group = (rows, key) => {
  const result = new Map();
  for (const row of rows) { const id = typeof key === "function" ? key(row) : row[key]; if (!result.has(id)) result.set(id, []); result.get(id).push(row); }
  return result;
};
const day = (date) => String(date || "").slice(0, 10);
const time = (date) => Date.parse(`${day(date)}T00:00:00Z`);
export const addDays = (date, days) => new Date(time(date) + days * DAY).toISOString().slice(0, 10);
export const kabulToday = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};
function addMonths(date, count) {
  const d = new Date(time(date)); const originalDay = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(originalDay, lastDay)); return d.toISOString().slice(0, 10);
}
export function presetRange(preset, today = kabulToday()) {
  const d = new Date(time(today)); const month = `${today.slice(0, 7)}-01`;
  const saturday = addDays(today, -((d.getUTCDay() + 1) % 7));
  const ranges = {
    today: [today, today], yesterday: [addDays(today, -1), addDays(today, -1)],
    week: [saturday, today], lastWeek: [addDays(saturday, -7), addDays(saturday, -1)],
    month: [month, today], lastMonth: [addMonths(month, -1), addDays(month, -1)], year: [`${today.slice(0, 4)}-01-01`, today],
  };
  const [from, to] = ranges[preset] || ranges.month; return { from, to };
}

const col = (key, type = "text", label = key) => ({ key, type, label: `r.col.${label}` });
const moneyCols = (...keys) => keys.map((key) => col(key, "money"));
const numericCols = (...keys) => keys.map((key) => col(key, "number"));
const result = (columns, rows, summaries = [], notes = []) => ({ columns, rows, summaries, notes });
const summary = (label, value, type = "money") => ({ label: `r.${label}`, value: value == null ? null : round(value), type });
const financialColumns = [col("invoice"), col("date", "date"), col("name"), ...moneyCols("total", "paid", "remaining"), col("status", "status")];

export function createReportContext(data, filters) {
  const f = { medicine: "", manufacturer: "", formula: "", customer: "", supplier: "", method: "", status: "", lowStock: 10, ...filters };
  if (!Number.isFinite(time(f.from)) || !Number.isFinite(time(f.to)) || f.from > f.to) throw new Error("invalid_range");
  const inPeriod = (date) => day(date) >= f.from && day(date) <= f.to;
  const before = (date, end = f.to) => Boolean(date) && day(date) <= end;
  const medicines = index(data.medicines), purchases = index(data.purchases), sales = index(data.sales), batches = index(data.batches);
  const purchaseItems = group(data.purchaseItems, "purchase_id"), saleItems = group(data.saleItems, "sale_id");
  const batchesByMedicine = group(data.batches, "medicine_id"), salesByCustomer = group(data.sales, "customer_id"), purchasesBySupplier = group(data.purchases, "company_id");
  const creditsByCustomer = group(data.creditEntries, "customer_id"), applicationsByCustomer = group(data.creditApplications, "customer_id"), settlementsByCustomer = group(data.creditSettlements, "customer_id"), returnsBySupplier = group(data.purchaseReturns, "company_id");
  const purchasePayments = group(data.purchasePayments, "purchase_id"), salePayments = group(data.salePayments, "sale_id");
  const applications = group(data.creditApplications, "sale_id"), allocations = group(data.allocations, "sale_item_id");
  const purchaseReturns = new Map(data.purchaseReturns.map((row) => [row.purchase_id, row]));
  const medicineMatches = (id) => {
    const m = medicines.get(id);
    return (!f.medicine || id === f.medicine) && (!f.manufacturer || m?.company_id === f.manufacturer) && (!f.formula || m?.formula_id === f.formula);
  };
  const saleMatches = (s) => (!f.customer || s.customer_id === f.customer) && (!f.method || s.payment_method === f.method);
  const purchaseMatches = (p) => !f.supplier || p.company_id === f.supplier;
  const saleReversed = (s, end = f.to) => ["cancelled", "returned"].includes(s.status) && (!s.reversed_at || before(s.reversed_at, end));
  const purchaseReversed = (p, end = f.to) => before(purchaseReturns.get(p.id)?.date, end);
  const salePaid = (s, end = f.to) => Math.min(s.total, Math.max(0, sum((salePayments.get(s.id) || []).filter((p) => before(p.date, end)), (p) => p.payment_type === "refund" ? -p.amount : p.amount) + sum((applications.get(s.id) || []).filter((a) => before(a.date, end)), "amount")));
  const purchasePaid = (p, end = f.to) => Math.min(p.total, sum((purchasePayments.get(p.id) || []).filter((p) => before(p.date, end)), "amount"));
  const remainingSale = (s, end = f.to) => before(s.sale_datetime, end) && !saleReversed(s, end) ? Math.max(0, round(s.total - salePaid(s, end))) : 0;
  const remainingPurchase = (p, end = f.to) => before(p.purchase_date, end) && !purchaseReversed(p, end) ? Math.max(0, round(p.total - purchasePaid(p, end))) : 0;
  const saleStatus = (s) => saleReversed(s) ? "returned" : salePaid(s) >= s.total ? "paid" : salePaid(s) > 0 ? "partial" : "unpaid";
  const purchaseStatus = (p) => purchaseReversed(p) ? "returned" : purchasePaid(p) >= p.total ? "paid" : purchasePaid(p) > 0 ? "partial" : "unpaid";
  const statusMatches = (status) => !f.status || status === f.status;
  const selectedSales = data.sales.filter((s) => saleMatches(s) && statusMatches(saleStatus(s)) && (saleItems.get(s.id) || []).some((i) => medicineMatches(i.medicine_id)));
  const selectedPurchases = data.purchases.filter((p) => purchaseMatches(p) && statusMatches(purchaseStatus(p)) && (purchaseItems.get(p.id) || []).some((i) => medicineMatches(i.medicine_id)));
  const saleEvents = selectedSales.filter((s) => !["cancelled", "returned"].includes(s.status) || s.reversed_at).flatMap((s) => [
    ...(inPeriod(s.sale_datetime) ? [{ invoice: s, sign: 1, date: day(s.sale_datetime) }] : []),
    ...(s.reversed_at && inPeriod(s.reversed_at) ? [{ invoice: s, sign: -1, date: day(s.reversed_at) }] : []),
  ]);
  const purchaseEvents = selectedPurchases.flatMap((p) => [
    ...(inPeriod(p.purchase_date) ? [{ invoice: p, sign: 1, date: p.purchase_date }] : []),
    ...(inPeriod(purchaseReturns.get(p.id)?.date) ? [{ invoice: p, sign: -1, date: purchaseReturns.get(p.id).date }] : []),
  ]);
  const salesLines = saleEvents.flatMap((event) => (saleItems.get(event.invoice.id) || []).filter((i) => medicineMatches(i.medicine_id)).map((item) => {
    const linked = allocations.get(item.id) || [];
    const units = item.quantity * (item.unit_type === "pack" ? item.units_per_pack : 1);
    const knownCost = linked.length > 0 && sum(linked, "quantity") === units && linked.every((a) => batches.get(a.batch_id)?.unit_cost != null);
    const cost = knownCost ? sum(linked, (a) => a.quantity * batches.get(a.batch_id).unit_cost) * event.sign : null;
    const netBase = event.invoice.subtotal - event.invoice.line_discount_total;
    const net = item.line_total * (netBase > 0 ? event.invoice.total / netBase : 1) * event.sign;
    return { ...item, id: `${item.id}-${event.sign}`, name: item.medicine_name, invoice: event.invoice.invoice_number, header: event.invoice, date: event.date,
      quantity: units * event.sign, recorded_quantity: item.quantity * event.sign, total: net, discount: (item.quantity * item.unit_price - Math.abs(net)) * event.sign, cost, sign: event.sign,
      manufacturer: medicines.get(item.medicine_id)?.manufacturer || "", formula: medicines.get(item.medicine_id)?.formula || "" };
  }));
  const purchasesLines = purchaseEvents.flatMap((event) => (purchaseItems.get(event.invoice.id) || []).filter((i) => medicineMatches(i.medicine_id)).map((item) => ({
    ...item, id: `${item.id}-${event.sign}`, name: item.medicine_name, invoice: event.invoice.invoice_number, header: event.invoice, date: event.date,
    quantity: item.quantity * (item.unit_type === "pack" ? item.units_per_pack : 1) * event.sign, recorded_quantity: item.quantity * event.sign,
    total: item.line_total * (event.invoice.subtotal > 0 ? event.invoice.total / event.invoice.subtotal : 1) * event.sign,
    unitCost: item.unit_price / (item.unit_type === "pack" ? item.units_per_pack : 1), sign: event.sign,
    manufacturer: medicines.get(item.medicine_id)?.manufacturer || "",
  })));
  const stock = data.medicines.filter((m) => medicineMatches(m.id)).map((m) => {
    const lots = (batchesByMedicine.get(m.id) || []).filter((b) => b.quantity_remaining > 0);
    const consistent = sum(lots, "quantity_remaining") === m.stock;
    return { ...m, quantity: m.stock, batchQuantity: sum(lots, "quantity_remaining"), difference: m.stock - sum(lots, "quantity_remaining"),
      cost: consistent && lots.every((b) => b.unit_cost != null) ? sum(lots, (b) => b.quantity_remaining * b.unit_cost) : null,
      retail: consistent && lots.every((b) => b.unit_sale_price != null) ? sum(lots, (b) => b.quantity_remaining * b.unit_sale_price) : null };
  });
  const settings = Object.fromEntries(data.settings.map((s) => [s.setting_key, s.setting_value]));
  const alertValue = Number(settings.expiry_alert_value) || 30;
  const expiryLimit = settings.expiry_alert_unit === "months" ? addMonths(data.today, alertValue) : addDays(data.today, alertValue);
  const lots = data.batches.filter((b) => b.quantity_remaining > 0 && medicineMatches(b.medicine_id)).map((b) => ({
    ...b, name: medicines.get(b.medicine_id)?.name || b.medicine_id, quantity: b.quantity_remaining,
    days: b.expiry_date ? Math.round((time(b.expiry_date) - time(data.today)) / DAY) : null,
    status: !b.expiry_date ? "unknown" : b.expiry_date < data.today ? "expired" : b.expiry_date <= expiryLimit ? "near" : "sellable",
    cost: b.unit_cost == null ? null : b.unit_cost * b.quantity_remaining,
  })).sort((a, b) => (a.expiry_date || "9999").localeCompare(b.expiry_date || "9999") || a.name.localeCompare(b.name));
  const accountRows = (kind, end = f.to) => {
    const customer = kind === "customers";
    return (customer ? data.customers : data.suppliers).filter((entity) => !f[customer ? "customer" : "supplier"] || entity.id === f[customer ? "customer" : "supplier"]).map((entity) => {
      const invoices = ((customer ? salesByCustomer : purchasesBySupplier).get(entity.id) || []).filter((invoice) => before(invoice[customer ? "sale_datetime" : "purchase_date"], end));
      const debt = sum(invoices, (invoice) => customer ? remainingSale(invoice, end) : remainingPurchase(invoice, end));
      const credit = customer ? Math.max(0, sum((creditsByCustomer.get(entity.id) || []).filter((c) => before(c.date, end)), "amount") - sum((applicationsByCustomer.get(entity.id) || []).filter((c) => before(c.date, end)), "amount") - sum((settlementsByCustomer.get(entity.id) || []).filter((c) => before(c.date, end)), "amount")) : sum((returnsBySupplier.get(entity.id) || []).filter((r) => before(r.date, end)), "credit_amount");
      const buckets = [0, 0, 0, 0];
      for (const invoice of invoices) {
        const age = Math.floor((time(end) - time(invoice[customer ? "sale_datetime" : "purchase_date"])) / DAY);
        buckets[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += customer ? remainingSale(invoice, end) : remainingPurchase(invoice, end);
      }
      return { ...entity, debt, credit, balance: round(debt - credit), purchases: sum(invoices.filter((i) => !(customer ? saleReversed(i, end) : purchaseReversed(i, end))), "total"), age30: buckets[0], age60: buckets[1], age90: buckets[2], ageOver: buckets[3], existsAtEnd: before(entity.created_at, end) || invoices.length > 0 || debt > 0 || credit > 0 };
    }).filter((entity) => entity.existsAtEnd);
  };
  const cashRows = [
    ...data.salePayments.map((p) => ({ ...p, name: sales.get(p.sale_id)?.customer_name || "", invoice: sales.get(p.sale_id)?.invoice_number || "", customer_id: sales.get(p.sale_id)?.customer_id, inflow: p.payment_type === "receipt" ? p.amount : 0, outflow: p.payment_type === "refund" ? p.amount : 0, type: p.payment_type })),
    ...data.purchasePayments.map((p) => ({ ...p, name: purchases.get(p.purchase_id)?.company_name || "", invoice: purchases.get(p.purchase_id)?.invoice_number || "", company_id: purchases.get(p.purchase_id)?.company_id, payment_method: p.payment_source || "unrecorded", inflow: 0, outflow: p.amount, type: "supplier_payment" })),
    ...data.creditSettlements.map((p) => ({ ...p, name: data.customers.find((c) => c.id === p.customer_id)?.name || "", invoice: "", inflow: 0, outflow: p.amount, type: "credit_settlement" })),
  ].filter((p) => inPeriod(p.date) && (!f.customer || p.customer_id === f.customer) && (!f.supplier || p.company_id === f.supplier) && (!f.method || p.payment_method === f.method)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const customerAccounts = accountRows("customers"), supplierAccounts = accountRows("suppliers");
  const gross = selectedSales.every((s) => !["cancelled", "returned"].includes(s.status) || s.reversed_at) && salesLines.every((l) => l.cost != null) ? sum(salesLines, (l) => l.total - l.cost) : null;
  const expenseRows = (data.cashDocuments || []).filter((r) => !r.deleted_at && r.kind === "EXPENSE" && inPeriod(r.date));
  const expenses = round(sum(expenseRows, "amount_afn"));
  const ledgerRows = (data.cashTransactions || []).filter((r) => !r.voided_at).map((r) => ({ ...r, name: r.description, invoice: r.source_id, type: r.category, payment_method: "cash", inflow: r.direction === "IN" ? r.amount_afn : 0, outflow: r.direction === "OUT" ? r.amount_afn : 0 }));
  const metrics = {
    sales: round(sum(saleEvents, (e) => e.invoice.total * e.sign)), purchases: round(sum(purchaseEvents, (e) => e.invoice.total * e.sign)),
    gross, expenses, net: gross == null ? null : round(gross - expenses), receivables: round(sum(customerAccounts, "debt")), payables: round(sum(supplierAccounts, "debt")),
    stockValue: stock.every((s) => s.cost != null) ? round(sum(stock, "cost")) : null,
    expiring: lots.filter((b) => b.status === "near").length, low: Number(f.lowStock) > 0 ? stock.filter((s) => s.quantity > 0 && s.quantity <= Number(f.lowStock)).length : null,
  };
  return { data, f, inPeriod, before, medicines, purchases, sales, batches, saleItems, purchaseItems, selectedSales, selectedPurchases, saleEvents, purchaseEvents, salesLines, purchasesLines, stock, lots, accountRows, customerAccounts, supplierAccounts, cashRows, ledgerRows, expenseRows, metrics, saleStatus, purchaseStatus, salePaid, purchasePaid, purchaseReturns, remainingSale, remainingPurchase, medicineMatches };
}

function aggregate(rows, key) {
  return [...group(rows, key)].map(([name, values]) => ({ id: String(name ?? ""), name: name || "—", quantity: sum(values, "quantity"), total: sum(values, "total"), discount: sum(values, "discount"), count: new Set(values.map((r) => r.header?.id || r.id)).size }));
}

export function buildReport(report, context) {
  const c = context, { data, f } = c;
  if (report.unavailable) return result([], [], [], [`r.unavailable.${report.unavailable}`]);
  if (report.view === "overview") return result([col("name"), col("value", "money"), col("basis", "status")], [
    { id: "sales", name: "r.netSales", value: c.metrics.sales, basis: "period", translateName: true },
    { id: "purchases", name: "r.netPurchases", value: c.metrics.purchases, basis: "period", translateName: true },
    { id: "gross", name: "r.grossProfit", value: c.metrics.gross, basis: "period", translateName: true },
    { id: "receivables", name: "r.receivables", value: c.metrics.receivables, basis: "asOf", translateName: true },
    { id: "payables", name: "r.payables", value: c.metrics.payables, basis: "asOf", translateName: true },
    { id: "stockValue", name: "r.stockValue", value: c.metrics.stockValue, basis: "current", translateName: true },
  ], [], ["r.costNote", "r.cashNote"]);
  if (["sales", "purchases"].includes(report.view)) {
    const sale = report.view === "sales", option = report.option;
    const events = sale ? c.saleEvents : c.purchaseEvents, lines = sale ? c.salesLines : c.purchasesLines;
    const net = sum(events, (e) => e.invoice.total * e.sign);
    const summaries = [summary(sale ? "netSales" : "netPurchases", net), summary("invoiceCount", events.filter((e) => e.sign === 1).length, "number"), summary("returns", -sum(events.filter((e) => e.sign === -1), (e) => e.invoice.total * e.sign))];
    const notes = ["r.netCalculationNote", "r.currencyNote", ...(sale && data.sales.some((s) => ["cancelled", "returned"].includes(s.status) && !s.reversed_at) ? ["r.missingReversal"] : [])];
    if (["medicine", "manufacturer", "formula", "customer", "supplier", "best", "least", "daily", "monthly", "yearly", "payment"].includes(option)) {
      let groups = aggregate(lines, (line) => {
        if (["medicine", "best", "least"].includes(option)) return line.medicine_id;
        if (option === "customer") return line.header.customer_id || "walkIn";
        if (option === "supplier") return line.header.company_id || "unknown";
        if (option === "manufacturer") return c.medicines.get(line.medicine_id)?.company_id || "unknown";
        if (["daily", "monthly", "yearly"].includes(option)) return line.date.slice(0, option === "daily" ? 10 : option === "monthly" ? 7 : 4);
        if (option === "payment") return (sale ? c.saleStatus(line.header) : c.purchaseStatus(line.header)) === "paid" ? "paid" : "credit";
        return line[option];
      }).map((row) => ({ ...row, name: ["medicine", "best", "least"].includes(option) ? c.medicines.get(row.id)?.name || lines.find((l) => l.medicine_id === row.id)?.name || row.id : option === "customer" ? data.customers.find((x) => x.id === row.id)?.name || "r.walkIn" : option === "supplier" || option === "manufacturer" ? data.suppliers.find((x) => x.id === row.id)?.name || "—" : row.name,
        translateName: option === "payment" || (option === "customer" && row.id === "walkIn") }));
      if (["medicine", "best", "least"].includes(option)) {
        const found = new Set(groups.map((g) => g.id));
        if (option === "least") groups.push(...data.medicines.filter((m) => c.medicineMatches(m.id) && !found.has(m.id) && c.before(m.created_at)).map((m) => ({ id: m.id, name: m.name, quantity: 0, total: 0, count: 0 })));
        groups.sort((a, b) => option === "least" ? a.quantity - b.quantity : b.quantity - a.quantity);
      } else groups.sort((a, b) => ["customerTop", "supplierTop"].includes(report.id) ? b.total - a.total : a.id.localeCompare(b.id));
      return result([col("name"), ...numericCols("quantity", "count"), col("total", "money")], groups, [summary("netAmount", sum(groups, "total")), summary("baseUnits", sum(groups, "quantity"), "number")], [...notes, "r.baseUnitNote"]);
    }
    if (["lines", "prices"].includes(option)) return result([col("invoice"), col("date", "date"), col("name"), col("recorded_quantity", "number"), col("unit_type", "status"), col("units_per_pack", "number"), col("quantity", "number"), ...moneyCols(...(sale ? ["unit_price", "discount"] : ["unitCost", "sale_price"])), ...(!sale ? [col("expiry_date", "date")] : []), col("total", "money")], [...lines].sort((a, b) => b.date.localeCompare(a.date)), [summary("netAmount", sum(lines, "total")), summary("baseUnits", sum(lines, "quantity"), "number")], [...notes, "r.linePriceNote"]);
    let invoices = (sale ? c.selectedSales : c.selectedPurchases).filter((i) => c.inPeriod(i[sale ? "sale_datetime" : "purchase_date"]));
    if (option === "returns") invoices = events.filter((e) => e.sign < 0).map((e) => e.invoice);
    if (option === "unpaid") invoices = (sale ? c.selectedSales : c.selectedPurchases).filter((i) => c.before(i[sale ? "sale_datetime" : "purchase_date"]) && (sale ? c.remainingSale(i) : c.remainingPurchase(i)) > 0);
    if (option === "discounts") invoices = invoices.filter((i) => i.discount > 0 || (sale && i.line_discount_total > 0));
    const rows = invoices.map((i) => ({ id: i.id, invoice: i.invoice_number, name: i[sale ? "customer_name" : "company_name"] || "—", date: option === "returns" ? sale ? day(i.reversed_at) : c.purchaseReturns.get(i.id)?.date : day(i[sale ? "sale_datetime" : "purchase_date"]),
      total: i.total, paid: sale ? c.salePaid(i) : c.purchasePaid(i), remaining: sale ? c.remainingSale(i) : c.remainingPurchase(i), status: sale ? c.saleStatus(i) : c.purchaseStatus(i), discount: i.discount + (sale ? i.line_discount_total : 0) })).sort((a, b) => b.date.localeCompare(a.date));
    return result([...financialColumns, ...(option === "discounts" ? [col("discount", "money")] : [])], rows, option === "invoices" ? summaries : [summary("invoiceCount", rows.length, "number"), summary("totalAmount", sum(rows, "total")), summary("remaining", sum(rows, "remaining"))], [...notes, "r.wholeInvoiceNote"]);
  }
  if (report.view === "inventory") {
    let rows = c.stock;
    const option = report.option;
    if (option === "movements") {
      const movements = data.movements.filter((m) => c.medicineMatches(m.medicine_id));
      const balances = new Map(); const selected = [];
      for (const m of movements) { const balance = (balances.get(m.medicine_id) || 0) + m.quantity_change; balances.set(m.medicine_id, balance); if (c.inPeriod(m.date)) selected.push({ ...m, name: c.medicines.get(m.medicine_id)?.name || m.medicine_id, balance }); }
      return result([col("date", "date"), col("name"), col("reference_type", "status"), col("reference_id"), col("quantity_change", "number"), col("balance", "number")], selected, [summary("baseUnits", sum(selected, "quantity_change"), "number")], ["r.movementNote"]);
    }
    if (option === "low") rows = rows.filter((r) => r.quantity > 0 && r.quantity <= Number(f.lowStock));
    if (option === "out") rows = rows.filter((r) => r.quantity === 0);
    if (option === "idle") { const moved = new Set(data.movements.filter((m) => c.inPeriod(m.date)).map((m) => m.medicine_id)); rows = rows.filter((r) => r.quantity > 0 && !moved.has(r.id) && c.before(r.created_at)); }
    if (option === "inconsistent") rows = rows.filter((r) => r.quantity < 0 || r.difference !== 0);
    if (["manufacturer", "formula"].includes(option)) {
      rows = [...group(rows, (row) => option === "manufacturer" ? row.company_id : row.formula_id)].map(([id, values]) => ({ id, name: values[0][option], quantity: sum(values, "quantity"), cost: values.every((r) => r.cost != null) ? sum(values, "cost") : null }));
      return result([col("name"), col("quantity", "number"), col("cost", "money")], rows, [summary("stockValue", rows.every((r) => r.cost != null) ? sum(rows, "cost") : null)], ["r.currentStockNote", "r.costNote"]);
    }
    return result([col("name"), col("barcode"), col("manufacturer"), col("formula"), ...numericCols("quantity"), ...(option === "inconsistent" ? numericCols("batchQuantity", "difference") : moneyCols(option === "retail" ? "retail" : "cost"))], rows, [summary("medicineCount", rows.length, "number"), summary("baseUnits", sum(rows, "quantity"), "number"), summary(option === "retail" ? "retailValue" : "stockValue", rows.every((r) => r[option === "retail" ? "retail" : "cost"] != null) ? sum(rows, option === "retail" ? "retail" : "cost") : null)], ["r.currentStockNote", "r.costNote", ...(option === "low" ? ["r.lowStockNote"] : []), ...(option === "retail" ? ["r.retailNote"] : [])]);
  }
  if (report.view === "expiry") {
    const option = report.option;
    if (option === "history") {
      const rows = data.batches.filter((b) => c.medicineMatches(b.medicine_id) && (!f.batch || b.id === f.batch)).flatMap((b) => {
        const p = c.purchases.get(b.purchase_id), item = data.purchaseItems.find((i) => i.id === b.purchase_item_id);
        const inbound = p && item ? [{ id: `in-${b.id}`, name: c.medicines.get(b.medicine_id)?.name || "", batch_number: b.batch_number, date: p.purchase_date, quantity_change: item.quantity * (item.unit_type === "pack" ? item.units_per_pack : 1), reference_id: p.invoice_number, reference_type: "purchase" }] : [];
        const outbound = data.allocations.filter((a) => a.batch_id === b.id).flatMap((a) => { const i = data.saleItems.find((i) => i.id === a.sale_item_id); const s = c.sales.get(i?.sale_id); return s ? [{ id: `out-${a.sale_item_id}-${b.id}`, name: c.medicines.get(b.medicine_id)?.name || "", batch_number: b.batch_number, date: day(s.sale_datetime), quantity_change: -a.quantity, reference_id: s.invoice_number, reference_type: "sale" }, ...(s.reversed_at ? [{ id: `return-${a.sale_item_id}-${b.id}`, name: c.medicines.get(b.medicine_id)?.name || "", batch_number: b.batch_number, date: day(s.reversed_at), quantity_change: a.quantity, reference_id: s.invoice_number, reference_type: "return" }] : [])] : []; });
        const r = c.purchaseReturns.get(b.purchase_id);
        return [...inbound, ...outbound, ...(r && inbound[0] ? [{ ...inbound[0], id: `return-${b.id}`, date: r.date, quantity_change: -inbound[0].quantity_change, reference_type: "return" }] : [])];
      }).filter((r) => c.inPeriod(r.date)).sort((a, b) => a.date.localeCompare(b.date));
      return result([col("name"), col("batch_number"), col("date", "date"), col("reference_type", "status"), col("reference_id"), col("quantity_change", "number")], rows, [], ["r.batchHistoryNote"]);
    }
    let rows = c.lots.filter((r) => (!f.batch || r.id === f.batch));
    if (option === "expired") rows = rows.filter((r) => r.status === "expired");
    if (option === "near") rows = rows.filter((r) => r.status === "near");
    if (typeof option === "number") rows = rows.filter((r) => r.days != null && r.days >= 0 && r.days <= option);
    if (option === "missing") rows = rows.filter((r) => !r.expiry_date || !r.batch_number);
    if (option === "fefo") rows = rows.filter((r) => r.days != null && r.days >= 0);
    if (option === "buckets") {
      rows = [{ id: "expired", min: -Infinity, max: -1 }, { id: "days30", min: 0, max: 30 }, { id: "days60", min: 31, max: 60 }, { id: "days90", min: 61, max: 90 }, { id: "days180", min: 91, max: 180 }, { id: "later", min: 181, max: Infinity }, { id: "unknown", min: null, max: null }].map((bucket) => {
        const values = rows.filter((r) => bucket.min === null ? r.days == null : r.days != null && r.days >= bucket.min && r.days <= bucket.max);
        return { id: bucket.id, name: bucket.id, translateName: true, count: values.length, quantity: sum(values, "quantity"), cost: values.every((v) => v.cost != null) ? sum(values, "cost") : null };
      });
      return result([col("name"), ...numericCols("count", "quantity"), col("cost", "money")], rows, [], ["r.expiryBucketNote", "r.currentStockNote"]);
    }
    return result([col("name"), col("batch_number"), col("expiry_date", "date"), ...numericCols("quantity", "days"), col("status", "status"), col("cost", "money")], rows, [summary("batchCount", rows.length, "number"), summary("baseUnits", sum(rows, "quantity"), "number"), summary("stockValue", rows.every((r) => r.cost != null) ? sum(rows, "cost") : null)], ["r.currentStockNote", "r.expiryNote", "r.costNote"]);
  }
  if (["customers", "suppliers"].includes(report.view)) {
    const customer = report.view === "customers", option = report.option;
    let rows = customer ? c.customerAccounts : c.supplierAccounts;
    if (option === "debtors") rows = rows.filter((r) => r.debt > 0);
    if (option === "credits") rows = rows.filter((r) => r.credit > 0);
    if (option === "inactive") { const active = new Set(data.sales.filter((s) => c.inPeriod(s.sale_datetime)).map((s) => s.customer_id)); rows = rows.filter((r) => !active.has(r.id)); }
    if (["balances", "statement"].includes(option)) {
      const opening = index(c.accountRows(report.view, addDays(f.from, -1)));
      rows = rows.map((r) => ({ ...r, opening: opening.get(r.id)?.balance || 0, change: round(r.balance - (opening.get(r.id)?.balance || 0)) }));
      if (option === "balances") return result([col("name"), ...moneyCols("opening", "change", "balance", "debt", "credit")], rows, [summary("opening", sum(rows, "opening")), summary("closing", sum(rows, "balance"))], ["r.accountNote", "r.asOfNote"]);
      const ids = new Set(rows.map((r) => r.id)); const ledger = [];
      for (const entity of rows) ledger.push({ id: `opening-${entity.id}`, entityId: entity.id, name: entity.name, date: f.from, type: "opening", invoice: "", change: 0, balance: entity.opening, opening: true });
      for (const invoice of customer ? data.sales : data.purchases) {
        const entityId = invoice[customer ? "customer_id" : "company_id"]; if (!ids.has(entityId)) continue;
        const entity = rows.find((r) => r.id === entityId), invoiceDate = day(invoice[customer ? "sale_datetime" : "purchase_date"]);
        if (c.inPeriod(invoiceDate)) ledger.push({ id: `invoice-${invoice.id}`, entityId, name: entity.name, date: invoiceDate, invoice: invoice.invoice_number, change: invoice.total, type: customer ? "sale" : "purchase" });
        const returnedDate = customer ? day(invoice.reversed_at) : c.purchaseReturns.get(invoice.id)?.date;
        if (c.inPeriod(returnedDate)) ledger.push({ id: `return-${invoice.id}`, entityId, name: entity.name, date: returnedDate, invoice: invoice.invoice_number, change: -invoice.total, type: "return" });
      }
      for (const payment of customer ? data.salePayments : data.purchasePayments) {
        const invoice = (customer ? c.sales : c.purchases).get(payment[customer ? "sale_id" : "purchase_id"]); const entityId = invoice?.[customer ? "customer_id" : "company_id"];
        if (ids.has(entityId) && c.inPeriod(payment.date)) ledger.push({ id: payment.id, entityId, name: rows.find((r) => r.id === entityId).name, date: payment.date, invoice: invoice.invoice_number, change: customer && payment.payment_type === "refund" ? payment.amount : -payment.amount, type: customer ? payment.payment_type : "supplier_payment" });
      }
      if (customer) for (const payment of data.creditSettlements.filter((p) => ids.has(p.customer_id) && c.inPeriod(p.date))) ledger.push({ id: payment.id, entityId: payment.customer_id, name: rows.find((r) => r.id === payment.customer_id).name, date: payment.date, invoice: "", change: payment.amount, type: "credit_settlement" });
      ledger.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date) || (a.opening ? -1 : b.opening ? 1 : a.id.localeCompare(b.id)));
      const running = new Map(rows.map((r) => [r.id, r.opening]));
      for (const row of ledger) { if (!row.opening) running.set(row.entityId, round(running.get(row.entityId) + row.change)); row.balance = running.get(row.entityId); }
      return result([col("name"), col("date", "date"), col("invoice"), col("type", "status"), ...moneyCols("change", "balance")], ledger, [summary("opening", sum(rows, "opening")), summary("closing", sum(rows, "balance"))], ["r.accountNote", "r.statementNote"]);
    }
    return result([col("name"), col("phone"), ...moneyCols(...(option === "ageing" ? ["age30", "age60", "age90", "ageOver", "debt"] : ["purchases", "debt", "credit", "balance"]))], rows, [summary(customer ? "receivables" : "payables", sum(rows, "debt")), summary("credit", sum(rows, "credit"))], ["r.accountNote", "r.asOfNote", ...(option === "ageing" ? ["r.ageingNote"] : [])]);
  }
  if (report.view === "cash") {
    let rows = report.category === "cash" ? c.ledgerRows.filter((r) => c.inPeriod(r.date) && (!f.method || f.method === "cash")) : c.cashRows;
    if (report.option === "balance") {
      const opening = sum(c.ledgerRows.filter((r) => day(r.date) < f.from), (r) => r.inflow - r.outflow);
      const change = sum(rows, (r) => r.inflow - r.outflow);
      return result([col("name"), ...moneyCols("opening", "change", "balance")], [{ id: "cash", name: "r.cashBalance", translateName: true, opening, change, balance: round(opening + change) }], [summary("opening", opening), summary("closing", opening + change)], ["exp.cashNote", "exp.basis"]);
    }
    if (report.option === "receipts") rows = rows.filter((r) => r.inflow > 0);
    if (report.option === "payments") rows = rows.filter((r) => r.outflow > 0);
    if (report.category === "suppliers") rows = rows.filter((r) => r.type === "supplier_payment");
    const summaries = [summary("inflow", sum(rows, "inflow")), summary("outflow", sum(rows, "outflow")), summary("netFlow", sum(rows, (r) => r.inflow - r.outflow))];
    if (report.option === "methods") return result([col("payment_method", "status"), ...moneyCols("inflow", "outflow", "change")], [...group(rows, "payment_method")].map(([method, values]) => ({ id: method, payment_method: method, inflow: sum(values, "inflow"), outflow: sum(values, "outflow"), change: sum(values, (v) => v.inflow - v.outflow) })), summaries, report.category === "cash" ? ["exp.cashNote", "exp.basis"] : ["r.paymentFlowNote", "r.methodNote"]);
    return result([col("date", "date"), col("invoice"), col("name"), col("type", "status"), col("payment_method", "status"), ...(report.category === "cash" ? [{ key: "amount", type: "number", label: "exp.amount" }, { key: "currency", type: "text", label: "exp.currency" }] : []), ...moneyCols("inflow", "outflow")], rows, summaries, report.category === "cash" ? ["exp.cashNote", "exp.basis"] : ["r.paymentFlowNote", "r.methodNote"]);
  }
  if (report.view === "expenses") return result([
    col("date", "date"), {key:"title",type:"text",label:"exp.titleField"}, {key:"category",type:"status",label:"exp.category"},
    {key:"amount",type:"number",label:"exp.amount"}, {key:"currency",type:"text",label:"exp.currency"}, {key:"amount_afn",type:"money",label:"exp.basisAmount"},
  ], c.expenseRows.map((r) => ({...r, categoryKey: `exp.${r.category}`})), [summary("expenses", c.metrics.expenses)], ["exp.basis", "exp.withdrawalNote"]);
  if (report.view === "profit" && report.option === "net") return result([col("name"), col("value", "money")], [
    {id:"gross",name:"r.grossProfit",translateName:true,value:c.metrics.gross},
    {id:"expenses",name:"r.expenses",translateName:true,value:c.metrics.expenses},
    {id:"net",name:"r.netProfit",translateName:true,value:c.metrics.net},
  ], [summary("netProfit",c.metrics.net)], ["r.costNote","exp.profitNote","exp.basis"]);
  if (report.view === "profit") return result([col("invoice"), col("date", "date"), col("name"), col("quantity", "number"), ...moneyCols("total", "cost", "profit")], c.salesLines.map((l) => ({ ...l, profit: l.cost == null ? null : l.total - l.cost })), [summary("netSales", sum(c.salesLines, "total")), summary("grossProfit", c.metrics.gross)], ["r.costNote", "r.netCalculationNote"]);
  return result([], []);
}

export function calculateDashboardOverview(data) {
  const today = data.today || kabulToday();
  const firstDate = [...data.sales.map((sale) => sale.sale_datetime.slice(0, 10)), ...data.purchases.map((purchase) => purchase.purchase_date), today].sort()[0];
  const context = createReportContext(data, { from: firstDate, to: today });
  const weekly = Array.from({ length: 7 }, (_, i) => ({ date: addDays(today, i - 6), total: 0, count: 0 }));
  const days = new Map(weekly.map((value) => [value.date, value]));
  for (const event of context.saleEvents) {
    const entry = days.get(event.date);
    if (entry) { entry.total += event.invoice.total * event.sign; entry.count++; }
  }
  weekly.forEach((value) => { value.total = round(value.total); });
  // This is the same invoice classification used by the cash/credit sales report.
  // Credit applications count as settlement; future payments do not settle today's invoice.
  const mix = { settled: 0, credit: 0 };
  for (const sale of data.sales) {
    if (sale.sale_datetime.slice(0, 10) > today) continue;
    const status = context.saleStatus(sale);
    if (status !== "returned") mix[status === "paid" ? "settled" : "credit"] += sale.total;
  }
  mix.settled = round(mix.settled); mix.credit = round(mix.credit);
  return { stats: { today: weekly[6].total, sales: context.metrics.sales, purchases: context.metrics.purchases, gross: context.metrics.gross, receivables: context.metrics.receivables, medicines: data.medicines.length }, weekly, mix };
}
