use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Map, Value};

// Explicit projections keep administrator credentials and unrelated settings out of reports.
pub(crate) fn rows(connection: &Connection, sql: &str) -> Result<Value, String> {
    query_rows(connection,sql,[])
}

pub(crate) fn query_rows(connection: &Connection, sql: &str, params:impl rusqlite::Params) -> Result<Value, String> {
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
    let mapped = statement.query_map(params, |row| {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
                ValueRef::Blob(_) => Value::Null,
            };
            record.insert(name.clone(), value);
        }
        Ok(Value::Object(record))
    }).map_err(|e| e.to_string())?;
    Ok(Value::Array(mapped.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?))
}

#[tauri::command]
pub(crate) fn get_reports_data(database_path: String) -> Result<Value, String> {
    let connection = super::open_product_database(&database_path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    // All report families see the same SQLite snapshot, even if a sync/write happens concurrently.
    let result = json!({
        "source": "sqlite", "timezone": "Asia/Kabul",
        "today": transaction.query_row("SELECT date('now','+4 hours','+30 minutes')", [], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?,
        "company": rows(&transaction, "SELECT company_name, company_address, office_phone FROM company_info LIMIT 1")?,
        "settings": rows(&transaction, "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('expiry_alert_value','expiry_alert_unit','usd_to_afn_rate')")?,
        "medicines": rows(&transaction, "SELECT m.id, m.name, m.barcode, m.company_id, m.formula_id, m.units_per_pack, m.created_at, COALESCE(c.name,'') AS manufacturer, COALESCE(f.name,'') AS formula, COALESCE(s.quantity,0) AS stock FROM medicines m LEFT JOIN pharmaceutical_companies c ON c.id=m.company_id LEFT JOIN medicine_formulas f ON f.id=m.formula_id LEFT JOIN inventory_stock s ON s.medicine_id=m.id")?,
        "customers": rows(&transaction, "SELECT id, trim(name || ' ' || surname) AS name, phone, address, deleted_at, datetime(created_at,'+4 hours','+30 minutes') AS created_at FROM customers")?,
        "suppliers": rows(&transaction, "SELECT id, name, phone, country, datetime(created_at,'+4 hours','+30 minutes') AS created_at FROM pharmaceutical_companies")?,
        "purchases": rows(&transaction, "SELECT id, company_id, company_name, invoice_number, purchase_date, purchase_date_solar, subtotal, discount, total, paid_amount, remaining_amount, status, notes FROM purchases")?,
        "purchaseItems": rows(&transaction, "SELECT id, purchase_id, medicine_id, medicine_name, quantity, unit_type, units_per_pack, unit_price, sale_price, line_total, expiry_date FROM purchase_items ORDER BY rowid")?,
        "purchasePayments": rows(&transaction, "SELECT id, purchase_id, payment_date AS date, amount, payment_type, payment_source, notes FROM purchase_payments ORDER BY payment_date, rowid")?,
        "purchaseReturns": rows(&transaction, "SELECT id, purchase_id, company_id, credit_amount, return_date AS date, notes FROM purchase_returns")?,
        "sales": rows(&transaction, "SELECT s.id, s.invoice_number, s.sale_datetime, s.sale_date_solar, s.customer_id, s.customer_name, s.customer_phone, s.subtotal, s.line_discount_total, s.discount, s.total, s.paid_amount, s.remaining_amount, s.status, s.payment_method, s.notes, CASE WHEN s.status IN ('cancelled','returned') THEN (SELECT MIN(datetime(im.created_at,'+4 hours','+30 minutes')) FROM inventory_movements im WHERE im.reference_type='return' AND im.reference_id=s.id) END AS reversed_at FROM sales s")?,
        "saleItems": rows(&transaction, "SELECT id, sale_id, medicine_id, medicine_name, barcode, quantity, unit_type, units_per_pack, unit_price, discount, line_total FROM sale_items ORDER BY rowid")?,
        "salePayments": rows(&transaction, "SELECT id, sale_id, payment_datetime AS date, amount, payment_method, payment_type, notes FROM sale_payments ORDER BY payment_datetime, rowid")?,
        "creditEntries": rows(&transaction, "SELECT e.id, e.customer_id, e.source_type, e.source_id, e.amount, CASE WHEN e.source_type='receipt_overpayment' THEN COALESCE((SELECT payment_datetime FROM sale_payments WHERE id=e.source_id),datetime(e.created_at,'+4 hours','+30 minutes')) ELSE datetime(e.created_at,'+4 hours','+30 minutes') END AS date FROM customer_credit_entries e")?,
        "creditApplications": rows(&transaction, "SELECT a.id, a.customer_id, a.sale_id, a.amount, s.sale_datetime AS date FROM customer_credit_applications a JOIN sales s ON s.id=a.sale_id")?,
        "creditSettlements": rows(&transaction, "SELECT id, customer_id, amount, payment_datetime AS date, payment_method, notes FROM customer_credit_settlements")?,
        "batches": rows(&transaction, "SELECT b.id, b.medicine_id, b.purchase_item_id, b.batch_number, b.expiry_date, b.quantity_remaining, pi.purchase_id, CASE WHEN pi.id IS NOT NULL THEN pi.unit_price * CASE WHEN p.subtotal>0 THEN (p.subtotal-p.discount)/p.subtotal ELSE 1 END / CASE WHEN pi.unit_type='pack' THEN pi.units_per_pack ELSE 1 END END AS unit_cost, CASE WHEN pi.id IS NOT NULL THEN pi.sale_price / CASE WHEN pi.unit_type='pack' THEN pi.units_per_pack ELSE 1 END END AS unit_sale_price FROM inventory_batches b LEFT JOIN purchase_items pi ON pi.id=b.purchase_item_id LEFT JOIN purchases p ON p.id=pi.purchase_id")?,
        "allocations": rows(&transaction, "SELECT sale_item_id, batch_id, quantity FROM sale_item_batches")?,
        "movements": rows(&transaction, "SELECT id, medicine_id, reference_type, reference_id, quantity_change, datetime(created_at,'+4 hours','+30 minutes') AS date FROM inventory_movements ORDER BY created_at, rowid")?,
        "cashTransactions": rows(&transaction, "SELECT * FROM cash_transactions WHERE voided_at IS NULL ORDER BY date,created_at,rowid")?,
        "cashDocuments": rows(&transaction, "SELECT * FROM cash_documents WHERE deleted_at IS NULL")?,
        "pendingSync": transaction.query_row("SELECT COUNT(*) FROM sync_outbox WHERE synced_at IS NULL", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?
    });
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(result)
}
