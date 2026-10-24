use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use futures_util::future::TryFutureExt;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:3000/api/v1";
mod reports;
mod cash;
mod database_api;
mod network;
mod local_users;
mod license;
mod cloud_sync;
pub use database_api::run_database_worker;
pub use database_api::initialize_api_database;

pub fn backup_database_cli(source: &str, destination: &str) -> Result<(), String> {
    sqlite_backup(Path::new(source), Path::new(destination))
}

pub fn replace_database_cli(source: &str, destination: &str, workspace_id: &str, revision: i64) -> Result<(), String> {
    let source_db=Connection::open(source).map_err(|_|"invalid_database_file")?;
    let linked:String=source_db.query_row("SELECT workspace_id FROM sync_workspace LIMIT 1",[],|row|row.get(0)).map_err(|_|"workspace_mismatch")?;
    if linked!=workspace_id{return Err("workspace_mismatch".into())}
    drop(source_db);sqlite_backup(Path::new(source),Path::new(destination))?;
    let db=Connection::open(destination).map_err(|_|"snapshot_failed")?;
    db.execute("UPDATE api_state SET revision=?1 WHERE id=1",[revision]).map_err(|_|"snapshot_failed")?;
    db.execute("UPDATE sync_workspace SET base_revision=?1,last_sync_at=CURRENT_TIMESTAMP WHERE workspace_id=?2",params![revision,workspace_id]).map_err(|_|"snapshot_failed")?;
    db.execute("UPDATE sync_outbox SET synced_at=COALESCE(synced_at,CURRENT_TIMESTAMP)",[]).map_err(|_|"snapshot_failed")?;Ok(())
}

fn api_base_url() -> String {
    std::env::var("API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_string())
}

pub(crate) fn sqlite_backup(source_path: &Path, destination_path: &Path) -> Result<(), String> {
    if source_path == destination_path { return Err("backup_same_path".into()); }
    let source = Connection::open(source_path).map_err(|_| "invalid_database_file")?;
    let integrity: String = source.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|_| "invalid_database_file")?;
    if integrity != "ok" { return Err("invalid_database_file".into()); }
    let mut destination = Connection::open(destination_path).map_err(|_| "backup_failed")?;
    let backup = rusqlite::backup::Backup::new(&source, &mut destination).map_err(|_| "backup_failed")?;
    backup.run_to_completion(128, std::time::Duration::from_millis(5), None).map_err(|_| "backup_failed")?;
    Ok(())
}

#[tauri::command]
fn backup_local_database(database_path: String, destination_path: String) -> Result<(), String> {
    sqlite_backup(Path::new(&database_path), Path::new(&destination_path))
}

#[tauri::command]
fn restore_local_database(database_path: String, source_path: String) -> Result<String, String> {
    let source = Connection::open(&source_path).map_err(|_| "invalid_database_file")?;
    let valid: i64 = source.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_info') AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_users')", [], |row| row.get(0)).map_err(|_| "invalid_database_file")?;
    let integrity: String = source.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(|_| "invalid_database_file")?;
    if valid != 1 || integrity != "ok" { return Err("invalid_database_file".into()); }
    drop(source);
    let safety_path = format!("{}.pre-restore.sqlite", database_path);
    sqlite_backup(Path::new(&database_path), Path::new(&safety_path))?;
    sqlite_backup(Path::new(&source_path), Path::new(&database_path)).map_err(|_| "restore_failed".to_string())?;
    Ok(safety_path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDatabasePayload {
    first_name: String,
    last_name: String,
    admin_phone: String,
    password: String,
    confirm_password: String,
    company_name: String,
    company_address: String,
    office_phone: String,
    secondary_phone: String,
    company_email: String,
    database_name: String,
    db_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateDatabaseResult {
    database_name: String,
    database_path: String,
    administrator_name: String,
    #[serde(skip_serializing_if="Option::is_none")]
    user: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDatabaseSummary {
    database_name: String,
    database_path: String,
    company_name: String,
    administrator_name: String,
}

#[derive(Default, Deserialize, Serialize)]
struct DatabaseRegistry {
    databases: Vec<LocalDatabaseSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncOutboxEntry {
    event_id: String,
    entity: String,
    record_id: String,
    operation: String,
    data: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFormulaPayload {
    database_path: String,
    name: String,
    indication: String,
    side_effects: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCompanyPayload {
    database_path: String,
    name: String,
    country: String,
    address: String,
    email: String,
    phone: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCompanyPayload {
    database_path: String,
    id: String,
    name: String,
    country: String,
    address: String,
    email: String,
    phone: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMedicinePayload {
    database_path: String,
    name: String,
    #[serde(default)]
    barcode: String,
    formula_id: String,
    company_id: String,
    batch_number: String,
    gauge_number: String,
    units_per_pack: i64,
    purchase_price: f64,
    sale_price: f64,
    purchase_price_basis: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMedicinePayload {
    id: String,
    #[serde(flatten)]
    medicine: CreateMedicinePayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportMedicineRow {
    name: String,
    #[serde(default)]
    barcode: String,
    batch_number: String,
    gauge_number: String,
    formula_name: String,
    company_name: String,
    units_per_pack: i64,
    purchase_price: f64,
    sale_price: f64,
    purchase_price_basis: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportMedicinesPayload {
    database_path: String,
    rows: Vec<ImportMedicineRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportMedicinesResult {
    imported: usize,
    skipped: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePurchasePayload {
    database_path: String,
    #[serde(default = "cash::other_source")]
    payment_source: String,
    company_id: Option<String>,
    invoice_number: String,
    purchase_date: String,
    discount: f64,
    paid_amount: f64,
    notes: String,
    items: Vec<CreatePurchaseItemPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordPurchasePaymentPayload {
    database_path: String,
    #[serde(default = "cash::other_source")]
    payment_source: String,
    purchase_id: String,
    amount: f64,
    payment_date: String,
    notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReturnPurchasePayload {
    database_path: String,
    purchase_id: String,
    notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePurchaseItemPayload {
    medicine_id: String,
    quantity: i64,
    unit_type: String,
    unit_price: f64,
    #[serde(default)]
    sale_price: f64,
    expiry_date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAppSettingsPayload {
    database_path: String,
    usd_to_afn_rate: f64,
    expiry_alert_value: i64,
    expiry_alert_unit: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettingsRecord {
    usd_to_afn_rate: f64,
    expiry_alert_value: i64,
    expiry_alert_unit: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpiryAlertRecord {
    medicine_name: String,
    batch_number: String,
    expiry_date: String,
    quantity_remaining: i64,
    days_remaining: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PurchaseSummary {
    id: String,
    company_id: Option<String>,
    company_name: String,
    invoice_number: String,
    purchase_date: String,
    purchase_date_solar: String,
    subtotal: f64,
    discount: f64,
    total: f64,
    paid_amount: f64,
    remaining_amount: f64,
    status: String,
    notes: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PurchaseListSummary {
    id: String,
    company_id: Option<String>,
    company_name: String,
    invoice_number: String,
    purchase_date: String,
    purchase_date_solar: String,
    medicine_names: String,
    expiry_dates: String,
    subtotal: f64,
    discount: f64,
    total: f64,
    paid_amount: f64,
    remaining_amount: f64,
    status: String,
    notes: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PurchaseItemRecord {
    id: String,
    medicine_id: String,
    medicine_name: String,
    quantity: i64,
    unit_type: String,
    unit_price: f64,
    sale_price: f64,
    line_total: f64,
    expiry_date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PurchasePaymentRecord {
    id: String,
    payment_date: String,
    payment_date_solar: String,
    amount: f64,
    notes: String,
    payment_type: String,
    payment_source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PurchaseDetails {
    id: String,
    company_id: Option<String>,
    company_name: String,
    invoice_number: String,
    purchase_date: String,
    purchase_date_solar: String,
    subtotal: f64,
    discount: f64,
    total: f64,
    paid_amount: f64,
    remaining_amount: f64,
    status: String,
    notes: String,
    created_at: String,
    items: Vec<PurchaseItemRecord>,
    payments: Vec<PurchasePaymentRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanyPurchaseAccount {
    company: CompanyRecord,
    total_purchases: f64,
    total_paid: f64,
    amount_owed: f64,
    supplier_credit: f64,
    purchases: Vec<PurchaseSummary>,
    payments: Vec<CompanyPurchasePayment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanyPurchasePayment {
    id: String,
    purchase_id: String,
    invoice_number: String,
    payment_date: String,
    payment_date_solar: String,
    amount: f64,
    notes: String,
    payment_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerRecord {
    id: String,
    name: String,
    surname: String,
    phone: String,
    address: String,
    total_receivable: f64,
    total_received: f64,
    customer_credit: f64,
    balance: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCustomerPayload {
    database_path: String,
    name: String,
    surname: String,
    phone: String,
    address: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordCustomerCreditSettlementPayload {
    database_path: String,
    customer_id: String,
    amount: f64,
    payment_datetime: String,
    payment_method: String,
    notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCustomerPayload {
    database_path: String,
    id: String,
    name: String,
    surname: String,
    phone: String,
    address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerPaymentRecord {
    id: String,
    sale_id: String,
    invoice_number: String,
    customer_name: String,
    payment_datetime: String,
    amount: f64,
    payment_method: String,
    payment_type: String,
    notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerCreditRecord {
    id: String,
    source_type: String,
    source_id: String,
    amount: f64,
    notes: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomerAccountRecord {
    customer: CustomerRecord,
    sales: Vec<SaleSummary>,
    payments: Vec<CustomerPaymentRecord>,
    credit_history: Vec<CustomerCreditRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanyInfoRecord {
    company_name: String,
    company_address: String,
    office_phone: String,
    secondary_phone: String,
    email: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSalePayload {
    database_path: String,
    customer_id: Option<String>,
    sale_datetime: String,
    payment_method: String,
    discount: f64,
    paid_amount: f64,
    notes: String,
    items: Vec<CreateSaleItemPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSaleItemPayload {
    medicine_id: String,
    quantity: i64,
    unit_type: String,
    unit_price: f64,
    discount: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordSalePaymentPayload {
    database_path: String,
    sale_id: String,
    amount: f64,
    payment_datetime: String,
    payment_method: String,
    notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaleSummary {
    id: String,
    invoice_number: String,
    sale_datetime: String,
    sale_date_solar: String,
    customer_id: Option<String>,
    customer_name: String,
    customer_phone: String,
    subtotal: f64,
    line_discount_total: f64,
    discount: f64,
    total: f64,
    paid_amount: f64,
    remaining_amount: f64,
    status: String,
    payment_method: String,
    notes: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaleItemRecord {
    id: String,
    medicine_id: String,
    medicine_name: String,
    barcode: String,
    quantity: i64,
    unit_type: String,
    units_per_pack: i64,
    unit_price: f64,
    discount: f64,
    line_total: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SalePaymentRecord {
    id: String,
    payment_datetime: String,
    amount: f64,
    payment_method: String,
    payment_type: String,
    notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaleDetails {
    id: String,
    invoice_number: String,
    sale_datetime: String,
    sale_date_solar: String,
    customer_id: Option<String>,
    customer_name: String,
    customer_phone: String,
    subtotal: f64,
    line_discount_total: f64,
    discount: f64,
    total: f64,
    paid_amount: f64,
    remaining_amount: f64,
    status: String,
    payment_method: String,
    notes: String,
    created_at: String,
    items: Vec<SaleItemRecord>,
    payments: Vec<SalePaymentRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FormulaRecord {
    id: String,
    name: String,
    indication: String,
    side_effects: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanyRecord {
    id: String,
    name: String,
    country: String,
    address: String,
    email: String,
    phone: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MedicineRecord {
    id: String,
    name: String,
    formula_id: String,
    formula_name: String,
    company_id: String,
    company_name: String,
    batch_number: String,
    gauge_number: String,
    units_per_pack: i64,
    purchase_price: f64,
    sale_price: f64,
    suggested_sale_price: f64,
    suggested_sale_price_basis: String,
    purchase_price_basis: String,
    created_at: String,
    barcode: String,
    stock_quantity: i64,
}

fn open_product_database(database_path: &str) -> Result<database_api::SharedDatabase, String> {
    if let Some(connection) = database_api::request_database(database_path)? { return Ok(connection); }
    let canonical_path = fs::canonicalize(database_path).map_err(|_| "invalid_database_file")?;
    let connection = Connection::open(canonical_path).map_err(|_| "invalid_database_file")?;
    connection.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e|e.to_string())?;
    connection.pragma_update(None, "journal_mode", "WAL").map_err(|e|e.to_string())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(include_str!("schema.sql"))
        .map_err(|error| error.to_string())?;
    ensure_medicine_column(&connection, "batch_number", "TEXT NOT NULL DEFAULT ''")?;
    ensure_medicine_column(&connection, "gauge_number", "TEXT NOT NULL DEFAULT ''")?;
    ensure_medicine_column(&connection, "barcode", "TEXT NOT NULL DEFAULT ''")?;
    ensure_medicine_column(&connection, "sale_price", "REAL NOT NULL DEFAULT 0")?;
    ensure_customer_columns(&connection)?;
    ensure_purchase_date_solar_column(&connection)?;
    ensure_purchase_item_unit_column(&connection)?;
    ensure_purchase_item_pack_size_column(&connection)?;
    ensure_purchase_item_expiry_column(&connection)?;
    ensure_purchase_item_sale_price_column(&connection)?;
    connection.execute(
        "INSERT OR IGNORE INTO inventory_stock (medicine_id, quantity)
         SELECT medicine_id, SUM(quantity * CASE WHEN unit_type = 'pack' THEN units_per_pack ELSE 1 END)
         FROM purchase_items GROUP BY medicine_id",
        [],
    ).map_err(|error| error.to_string())?;
    let migrated: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM app_settings WHERE setting_key='inventory_batch_migration_v1')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !migrated {
        connection.execute("INSERT INTO inventory_batches (id, medicine_id, purchase_item_id, batch_number, expiry_date, quantity_remaining) SELECT 'legacy-' || medicine_id, medicine_id, NULL, '', '', quantity FROM inventory_stock WHERE quantity > 0", []).map_err(|error| error.to_string())?;
        connection.execute("INSERT OR REPLACE INTO app_settings(setting_key, setting_value) VALUES('inventory_batch_migration_v1','1')", []).map_err(|error| error.to_string())?;
    }
    cash::ensure_schema(&connection)?;
    Ok(database_api::SharedDatabase::new(connection))
}

fn ensure_purchase_item_expiry_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection.prepare("PRAGMA table_info(purchase_items)").map_err(|error| error.to_string())?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    drop(statement);
    if !columns.iter().any(|column| column == "expiry_date") {
        connection.execute_batch("ALTER TABLE purchase_items ADD COLUMN expiry_date TEXT NOT NULL DEFAULT ''").map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_purchase_item_sale_price_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection.prepare("PRAGMA table_info(purchase_items)").map_err(|error| error.to_string())?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    drop(statement);
    if !columns.iter().any(|column| column == "sale_price") {
        connection.execute_batch("ALTER TABLE purchase_items ADD COLUMN sale_price REAL NOT NULL DEFAULT 0 CHECK (sale_price >= 0)").map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_app_settings(database_path: String) -> Result<AppSettingsRecord, String> {
    let connection = open_product_database(&database_path)?;
    connection.execute("INSERT OR IGNORE INTO app_settings(setting_key,setting_value) VALUES('usd_to_afn_rate','70'),('expiry_alert_value','30'),('expiry_alert_unit','days')", []).map_err(|error| error.to_string())?;
    connection.query_row("SELECT CAST((SELECT setting_value FROM app_settings WHERE setting_key='usd_to_afn_rate') AS REAL), CAST((SELECT setting_value FROM app_settings WHERE setting_key='expiry_alert_value') AS INTEGER), (SELECT setting_value FROM app_settings WHERE setting_key='expiry_alert_unit')", [], |row| Ok(AppSettingsRecord { usd_to_afn_rate: row.get(0)?, expiry_alert_value: row.get(1)?, expiry_alert_unit: row.get(2)? })).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_app_settings(payload: SaveAppSettingsPayload) -> Result<AppSettingsRecord, String> {
    if !payload.usd_to_afn_rate.is_finite() || payload.usd_to_afn_rate <= 0.0 || payload.expiry_alert_value <= 0 || !matches!(payload.expiry_alert_unit.as_str(), "days" | "months") { return Err("settings_invalid_fields".to_string()); }
    let connection = open_product_database(&payload.database_path)?;
    connection.execute("INSERT OR REPLACE INTO app_settings(setting_key,setting_value) VALUES('usd_to_afn_rate',?1),('expiry_alert_value',?2),('expiry_alert_unit',?3)", params![payload.usd_to_afn_rate.to_string(), payload.expiry_alert_value.to_string(), payload.expiry_alert_unit]).map_err(|error| error.to_string())?;
    get_app_settings(payload.database_path)
}

#[tauri::command]
fn list_expiry_alerts(database_path: String) -> Result<Vec<ExpiryAlertRecord>, String> {
    let connection = open_product_database(&database_path)?;
    let settings = get_app_settings(database_path)?;
    let modifier = format!("+{} {}", settings.expiry_alert_value, settings.expiry_alert_unit);
    let mut statement = connection.prepare("SELECT m.name, b.batch_number, b.expiry_date, b.quantity_remaining, CAST(julianday(b.expiry_date)-julianday(date('now','localtime')) AS INTEGER) FROM inventory_batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.quantity_remaining>0 AND b.expiry_date<>'' AND b.expiry_date<=date('now','localtime', ?1) ORDER BY b.expiry_date, m.name").map_err(|error| error.to_string())?;
    let rows = statement.query_map([modifier], |row| Ok(ExpiryAlertRecord { medicine_name: row.get(0)?, batch_number: row.get(1)?, expiry_date: row.get(2)?, quantity_remaining: row.get(3)?, days_remaining: row.get(4)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string());
    rows
}

fn ensure_customer_columns(connection: &Connection) -> Result<(), String> {
    let mut statement = connection.prepare("PRAGMA table_info(customers)").map_err(|error| error.to_string())?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if !columns.iter().any(|column| column == "surname") {
        connection.execute_batch("ALTER TABLE customers ADD COLUMN surname TEXT NOT NULL DEFAULT ''")
            .map_err(|error| error.to_string())?;
    }
    if !columns.iter().any(|column| column == "address") {
        connection.execute_batch("ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT ''")
            .map_err(|error| error.to_string())?;
    }
    if !columns.iter().any(|column| column == "deleted_at") {
        connection.execute_batch("ALTER TABLE customers ADD COLUMN deleted_at TEXT")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_purchase_item_unit_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection.prepare("PRAGMA table_info(purchase_items)").map_err(|error| error.to_string())?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !columns.iter().any(|column| column == "unit_type") {
        connection.execute_batch("ALTER TABLE purchase_items ADD COLUMN unit_type TEXT NOT NULL DEFAULT 'pack'")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_purchase_item_pack_size_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection.prepare("PRAGMA table_info(purchase_items)").map_err(|error| error.to_string())?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if !columns.iter().any(|column| column == "units_per_pack") {
        connection.execute_batch("ALTER TABLE purchase_items ADD COLUMN units_per_pack INTEGER NOT NULL DEFAULT 1")
            .map_err(|error| error.to_string())?;
        connection.execute(
            "UPDATE purchase_items SET units_per_pack = COALESCE((SELECT units_per_pack FROM medicines WHERE medicines.id = purchase_items.medicine_id), 1)",
            [],
        ).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_purchase_date_solar_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection.prepare("PRAGMA table_info(purchases)").map_err(|error| error.to_string())?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if !columns.iter().any(|column| column == "purchase_date_solar") {
        connection.execute_batch("ALTER TABLE purchases ADD COLUMN purchase_date_solar TEXT NOT NULL DEFAULT ''")
            .map_err(|error| error.to_string())?;
    }
    let mut statement = connection.prepare("SELECT id, purchase_date FROM purchases WHERE purchase_date_solar = ''")
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (id, gregorian_date) in rows {
        if let Some(solar_date) = gregorian_to_jalali(&gregorian_date) {
            connection.execute("UPDATE purchases SET purchase_date_solar = ?1 WHERE id = ?2", params![solar_date, id])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_medicine_column(
    connection: &Connection,
    column_name: &str,
    column_definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(medicines)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !columns.iter().any(|column| column == column_name) {
        connection
            .execute_batch(&format!(
                "ALTER TABLE medicines ADD COLUMN {column_name} {column_definition}"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn queue_sync_event(
    connection: &Connection,
    entity: &str,
    record_id: &str,
    data: serde_json::Value,
) -> Result<(), String> {
    let event_id = Uuid::new_v4().to_string();
    let payload = serde_json::to_string(&data).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO sync_outbox (event_id, entity, record_id, operation, payload_json)
             VALUES (?1, ?2, ?3, 'upsert', ?4)",
            params![event_id, entity, record_id, payload],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_medicine_formulas(database_path: String) -> Result<Vec<FormulaRecord>, String> {
    let connection = open_product_database(&database_path)?;
    let mut statement = connection
        .prepare("SELECT id, name, indication, side_effects FROM medicine_formulas ORDER BY name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([], |row| {
            Ok(FormulaRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                indication: row.get(2)?,
                side_effects: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    records
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_medicine_formula(payload: CreateFormulaPayload) -> Result<FormulaRecord, String> {
    if payload.name.trim().is_empty() || payload.indication.trim().is_empty() {
        return Err("formula_required_fields".to_string());
    }
    let connection = open_product_database(&payload.database_path)?;
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO medicine_formulas (id, name, indication, side_effects) VALUES (?1, ?2, ?3, ?4)",
            params![id, payload.name.trim(), payload.indication.trim(), payload.side_effects.trim()],
        )
        .map_err(|error| if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) { "formula_name_exists".to_string() } else { error.to_string() })?;
    queue_sync_event(
        &connection,
        "medicine_formulas",
        &id,
        serde_json::json!({
            "id": id,
            "name": payload.name.trim(),
            "indication": payload.indication.trim(),
            "side_effects": payload.side_effects.trim(),
        }),
    )?;
    Ok(FormulaRecord {
        id,
        name: payload.name.trim().to_string(),
        indication: payload.indication.trim().to_string(),
        side_effects: payload.side_effects.trim().to_string(),
    })
}

#[tauri::command]
fn list_pharmaceutical_companies(database_path: String) -> Result<Vec<CompanyRecord>, String> {
    let connection = open_product_database(&database_path)?;
    let mut statement = connection
        .prepare("SELECT id, name, country, address, email, phone FROM pharmaceutical_companies ORDER BY name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([], |row| {
            Ok(CompanyRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                country: row.get(2)?,
                address: row.get(3)?,
                email: row.get(4)?,
                phone: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    records
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_customers(database_path: String) -> Result<Vec<CustomerRecord>, String> {
    let connection = open_product_database(&database_path)?;
    let mut statement = connection.prepare(
        "SELECT c.id, c.name, c.surname, c.phone, c.address,
                COALESCE((SELECT SUM(s.remaining_amount) FROM sales s WHERE s.customer_id = c.id
                    AND s.status NOT IN ('cancelled', 'returned')), 0),
                COALESCE((SELECT SUM(CASE p.payment_type WHEN 'refund' THEN -p.amount ELSE p.amount END)
                    FROM sale_payments p JOIN sales s ON s.id = p.sale_id
                    WHERE s.customer_id = c.id AND p.payment_type IN ('receipt', 'refund')), 0)
                    - COALESCE((SELECT SUM(cs.amount) FROM customer_credit_settlements cs WHERE cs.customer_id = c.id), 0),
                MAX(0, COALESCE((SELECT SUM(e.amount) FROM customer_credit_entries e WHERE e.customer_id = c.id), 0)
                    - COALESCE((SELECT SUM(a.amount) FROM customer_credit_applications a WHERE a.customer_id = c.id), 0)
                    - COALESCE((SELECT SUM(cs.amount) FROM customer_credit_settlements cs WHERE cs.customer_id = c.id), 0))
         FROM customers c WHERE c.deleted_at IS NULL ORDER BY c.name COLLATE NOCASE, c.surname COLLATE NOCASE",
    ).map_err(|error| error.to_string())?;
    let records = statement.query_map([], |row| Ok(CustomerRecord {
        id: row.get(0)?, name: row.get(1)?, surname: row.get(2)?, phone: row.get(3)?, address: row.get(4)?,
        total_receivable: row.get(5)?, total_received: row.get(6)?, customer_credit: row.get(7)?,
        balance: row.get::<_, f64>(5)? - row.get::<_, f64>(7)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    records
}

fn read_customer(connection: &Connection, customer_id: &str) -> Result<CustomerRecord, String> {
    connection.query_row(
        "SELECT c.id, c.name, c.surname, c.phone, c.address,
                COALESCE((SELECT SUM(s.remaining_amount) FROM sales s WHERE s.customer_id = c.id
                    AND s.status NOT IN ('cancelled', 'returned')), 0),
                COALESCE((SELECT SUM(CASE p.payment_type WHEN 'refund' THEN -p.amount ELSE p.amount END)
                    FROM sale_payments p JOIN sales s ON s.id = p.sale_id
                    WHERE s.customer_id = c.id AND p.payment_type IN ('receipt', 'refund')), 0)
                    - COALESCE((SELECT SUM(cs.amount) FROM customer_credit_settlements cs WHERE cs.customer_id = c.id), 0),
                MAX(0, COALESCE((SELECT SUM(e.amount) FROM customer_credit_entries e WHERE e.customer_id = c.id), 0)
                    - COALESCE((SELECT SUM(a.amount) FROM customer_credit_applications a WHERE a.customer_id = c.id), 0)
                    - COALESCE((SELECT SUM(cs.amount) FROM customer_credit_settlements cs WHERE cs.customer_id = c.id), 0))
         FROM customers c WHERE c.id = ?1",
        [customer_id],
        |row| {
            let total_receivable: f64 = row.get(5)?;
            let customer_credit: f64 = row.get(7)?;
            Ok(CustomerRecord {
                id: row.get(0)?, name: row.get(1)?, surname: row.get(2)?, phone: row.get(3)?,
                address: row.get(4)?, total_receivable, total_received: row.get(6)?, customer_credit,
                balance: total_receivable - customer_credit,
            })
        },
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
        "customer_not_found".to_string()
    } else { error.to_string() })
}

#[tauri::command]
fn create_customer(payload: CreateCustomerPayload) -> Result<CustomerRecord, String> {
    let name = payload.name.trim();
    if name.is_empty() { return Err("customer_name_required".to_string()); }
    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    let phone = payload.phone.trim();
    let surname = payload.surname.trim();
    let address = payload.address.trim();
    transaction.execute("INSERT INTO customers (id, name, surname, phone, address) VALUES (?1, ?2, ?3, ?4, ?5)", params![id, name, surname, phone, address])
        .map_err(|error| error.to_string())?;
    queue_sync_event(&transaction, "customers", &id, serde_json::json!({
        "id": id, "name": name, "surname": surname, "phone": phone, "address": address
    }))?;
    transaction.commit().map_err(|error| error.to_string())?;
    read_customer(&connection, &id)
}

#[tauri::command]
fn update_customer(payload: UpdateCustomerPayload) -> Result<CustomerRecord, String> {
    let name = payload.name.trim();
    if name.is_empty() || payload.id.trim().is_empty() { return Err("customer_name_required".to_string()); }
    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let updated = transaction.execute(
        "UPDATE customers SET name = ?1, surname = ?2, phone = ?3, address = ?4 WHERE id = ?5 AND deleted_at IS NULL",
        params![name, payload.surname.trim(), payload.phone.trim(), payload.address.trim(), payload.id],
    ).map_err(|error| error.to_string())?;
    if updated == 0 { return Err("customer_not_found".to_string()); }
    let customer = read_customer(&transaction, &payload.id)?;
    queue_sync_event(&transaction, "customers", &payload.id,
        serde_json::to_value(&customer).map_err(|error| error.to_string())?)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(customer)
}

#[tauri::command]
fn delete_customer(database_path: String, customer_id: String) -> Result<(), String> {
    let connection = open_product_database(&database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let affected = transaction.execute(
        "UPDATE customers SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?1 AND deleted_at IS NULL",
        [&customer_id],
    ).map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("customer_not_found".to_string());
    }
    queue_sync_event(&transaction, "customers", &customer_id, serde_json::Value::Null)?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_customer_account(database_path: String, customer_id: String) -> Result<CustomerAccountRecord, String> {
    let connection = open_product_database(&database_path)?;
    let customer = read_customer(&connection, &customer_id)?;
    let mut sales_statement = connection.prepare(
        "SELECT id, invoice_number, sale_datetime, sale_date_solar, customer_id, customer_name,
                customer_phone, subtotal, line_discount_total, discount, total, paid_amount,
                remaining_amount, status, payment_method, notes, created_at
         FROM sales WHERE customer_id = ?1 ORDER BY sale_datetime DESC, created_at DESC",
    ).map_err(|error| error.to_string())?;
    let sales = sales_statement.query_map([&customer_id], |row| Ok(SaleSummary {
        id: row.get(0)?, invoice_number: row.get(1)?, sale_datetime: row.get(2)?,
        sale_date_solar: row.get(3)?, customer_id: row.get(4)?, customer_name: row.get(5)?,
        customer_phone: row.get(6)?, subtotal: row.get(7)?, line_discount_total: row.get(8)?,
        discount: row.get(9)?, total: row.get(10)?, paid_amount: row.get(11)?,
        remaining_amount: row.get(12)?, status: row.get(13)?, payment_method: row.get(14)?,
        notes: row.get(15)?, created_at: row.get(16)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut payments_statement = connection.prepare(
        "SELECT id, sale_id, invoice_number, customer_name, payment_datetime, amount,
                payment_method, payment_type, notes FROM (
            SELECT p.id, p.sale_id, s.invoice_number, s.customer_name, p.payment_datetime,
                   p.amount, p.payment_method, p.payment_type, p.notes, p.created_at AS sort_date, p.rowid AS sort_order
            FROM sale_payments p JOIN sales s ON s.id = p.sale_id
            WHERE s.customer_id = ?1
            UNION ALL
            SELECT cs.id, '', 'Account credit', trim(c.name || ' ' || c.surname), cs.payment_datetime,
                   cs.amount, cs.payment_method, 'credit_settlement', cs.notes, cs.created_at, cs.rowid
            FROM customer_credit_settlements cs JOIN customers c ON c.id = cs.customer_id
            WHERE cs.customer_id = ?1
         ) ORDER BY payment_datetime DESC, sort_date DESC, sort_order DESC",
    ).map_err(|error| error.to_string())?;
    let payments = payments_statement.query_map([&customer_id], |row| Ok(CustomerPaymentRecord {
        id: row.get(0)?, sale_id: row.get(1)?, invoice_number: row.get(2)?, customer_name: row.get(3)?,
        payment_datetime: row.get(4)?, amount: row.get(5)?, payment_method: row.get(6)?,
        payment_type: row.get(7)?, notes: row.get(8)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut credit_statement = connection.prepare(
        "SELECT id, source_type, source_id, amount, notes, created_at FROM (
            SELECT e.id, e.source_type, e.source_id, e.amount, e.notes,
                CASE e.source_type
                    WHEN 'receipt_overpayment' THEN COALESCE((SELECT p.payment_datetime FROM sale_payments p WHERE p.id = e.source_id), e.created_at)
                    WHEN 'sale_return' THEN COALESCE((SELECT s.sale_datetime FROM sales s WHERE s.id = e.source_id), e.created_at)
                    ELSE e.created_at
                END AS created_at
            FROM customer_credit_entries e WHERE e.customer_id = ?1
            UNION ALL
            SELECT ca.id, 'sale_credit_applied', ca.sale_id, -ca.amount, 'Customer credit applied to invoice', s.sale_datetime
            FROM customer_credit_applications ca JOIN sales s ON s.id = ca.sale_id WHERE ca.customer_id = ?1
            UNION ALL
            SELECT id, 'credit_settlement', id, -amount, notes, payment_datetime
            FROM customer_credit_settlements WHERE customer_id = ?1
         ) ORDER BY created_at DESC",
    ).map_err(|error| error.to_string())?;
    let credit_history = credit_statement.query_map([&customer_id], |row| Ok(CustomerCreditRecord {
        id: row.get(0)?, source_type: row.get(1)?, source_id: row.get(2)?, amount: row.get(3)?,
        notes: row.get(4)?, created_at: row.get(5)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(CustomerAccountRecord { customer, sales, payments, credit_history })
}

#[tauri::command]
fn record_customer_credit_settlement(
    payload: RecordCustomerCreditSettlementPayload,
) -> Result<CustomerAccountRecord, String> {
    if payload.customer_id.trim().is_empty() || !payload.amount.is_finite() || payload.amount <= 0.0
        || !is_local_datetime(&payload.payment_datetime)
        || !matches!(payload.payment_method.as_str(), "cash" | "card" | "bank" | "mobile" | "other") {
        return Err("customer_credit_settlement_invalid".to_string());
    }
    let amount = round_money(payload.amount);
    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let credit: f64 = transaction.query_row(
        "SELECT MAX(0, COALESCE((SELECT SUM(amount) FROM customer_credit_entries WHERE customer_id = ?1), 0)
            - COALESCE((SELECT SUM(amount) FROM customer_credit_applications WHERE customer_id = ?1), 0)
            - COALESCE((SELECT SUM(amount) FROM customer_credit_settlements WHERE customer_id = ?1), 0))",
        [&payload.customer_id], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if amount > credit { return Err("customer_credit_settlement_exceeds_credit".to_string()); }
    let id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO customer_credit_settlements (id, customer_id, amount, payment_datetime, payment_method, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, payload.customer_id, amount, payload.payment_datetime, payload.payment_method, payload.notes.trim()],
    ).map_err(|error| error.to_string())?;
    let customer = read_customer(&transaction, &payload.customer_id)?;
    queue_sync_event(&transaction, "customers", &payload.customer_id,
        serde_json::to_value(customer).map_err(|error| error.to_string())?)?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_customer_account(payload.database_path, payload.customer_id)
}

#[tauri::command]
fn get_company_info(database_path: String) -> Result<Option<CompanyInfoRecord>, String> {
    let connection = open_product_database(&database_path)?;
    connection.query_row(
        "SELECT company_name, company_address, office_phone, secondary_phone, email
         FROM company_info ORDER BY created_at LIMIT 1",
        [],
        |row| Ok(CompanyInfoRecord {
            company_name: row.get(0)?, company_address: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            office_phone: row.get(2)?, secondary_phone: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            email: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        }),
    ).optional().map_err(|error| error.to_string())
}

#[tauri::command]
fn create_pharmaceutical_company(payload: CreateCompanyPayload) -> Result<CompanyRecord, String> {
    if payload.name.trim().is_empty() || payload.country.trim().is_empty() {
        return Err("company_required_fields".to_string());
    }
    let connection = open_product_database(&payload.database_path)?;
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO pharmaceutical_companies (id, name, country, address, email, phone) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, payload.name.trim(), payload.country.trim(), payload.address.trim(), payload.email.trim(), payload.phone.trim()],
        )
        .map_err(|error| if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) { "company_name_exists".to_string() } else { error.to_string() })?;
    queue_sync_event(
        &connection,
        "pharmaceutical_companies",
        &id,
        serde_json::json!({
            "id": id,
            "name": payload.name.trim(),
            "country": payload.country.trim(),
            "address": payload.address.trim(),
            "email": payload.email.trim(),
            "phone": payload.phone.trim(),
        }),
    )?;
    Ok(CompanyRecord {
        id,
        name: payload.name.trim().to_string(),
        country: payload.country.trim().to_string(),
        address: payload.address.trim().to_string(),
        email: payload.email.trim().to_string(),
        phone: payload.phone.trim().to_string(),
    })
}

#[tauri::command]
fn update_pharmaceutical_company(payload: UpdateCompanyPayload) -> Result<CompanyRecord, String> {
    if payload.name.trim().is_empty() || payload.country.trim().is_empty() {
        return Err("company_required_fields".to_string());
    }

    let connection = open_product_database(&payload.database_path)?;
    let affected = connection
        .execute(
            "UPDATE pharmaceutical_companies
             SET name = ?1, country = ?2, address = ?3, email = ?4, phone = ?5
             WHERE id = ?6",
            params![
                payload.name.trim(),
                payload.country.trim(),
                payload.address.trim(),
                payload.email.trim(),
                payload.phone.trim(),
                payload.id,
            ],
        )
        .map_err(|error| {
            if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
                "company_name_exists".to_string()
            } else {
                error.to_string()
            }
        })?;
    if affected == 0 {
        return Err("company_not_found".to_string());
    }

    queue_sync_event(
        &connection,
        "pharmaceutical_companies",
        &payload.id,
        serde_json::json!({
            "id": payload.id,
            "name": payload.name.trim(),
            "country": payload.country.trim(),
            "address": payload.address.trim(),
            "email": payload.email.trim(),
            "phone": payload.phone.trim(),
        }),
    )?;

    Ok(CompanyRecord {
        id: payload.id,
        name: payload.name.trim().to_string(),
        country: payload.country.trim().to_string(),
        address: payload.address.trim().to_string(),
        email: payload.email.trim().to_string(),
        phone: payload.phone.trim().to_string(),
    })
}

#[tauri::command]
fn delete_pharmaceutical_company(database_path: String, company_id: String) -> Result<(), String> {
    let connection = open_product_database(&database_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let in_use: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM medicines WHERE company_id = ?1)
                OR EXISTS(SELECT 1 FROM purchases WHERE company_id = ?1)",
            [&company_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if in_use {
        transaction.rollback().map_err(|error| error.to_string())?;
        return Err("company_in_use".to_string());
    }

    let affected = transaction
        .execute("DELETE FROM pharmaceutical_companies WHERE id = ?1", [&company_id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        transaction.rollback().map_err(|error| error.to_string())?;
        return Err("company_not_found".to_string());
    }

    queue_sync_event(
        &transaction,
        "pharmaceutical_companies",
        &company_id,
        serde_json::Value::Null,
    )?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn list_medicines(database_path: String) -> Result<Vec<MedicineRecord>, String> {
    let connection = open_product_database(&database_path)?;
    let mut statement = connection
        .prepare(
                "SELECT m.id, m.name, m.formula_id, f.name, m.company_id, c.name,
                    m.batch_number, m.gauge_number, m.units_per_pack, m.purchase_price,
                    m.sale_price,
                    COALESCE((SELECT pi.sale_price FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
                        WHERE pi.medicine_id=m.id AND NOT EXISTS(SELECT 1 FROM purchase_returns pr WHERE pr.purchase_id=p.id)
                        ORDER BY p.purchase_date DESC, p.created_at DESC, pi.rowid DESC LIMIT 1), m.sale_price),
                    COALESCE((SELECT pi.unit_type FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
                        WHERE pi.medicine_id=m.id AND NOT EXISTS(SELECT 1 FROM purchase_returns pr WHERE pr.purchase_id=p.id)
                        ORDER BY p.purchase_date DESC, p.created_at DESC, pi.rowid DESC LIMIT 1), 'unit'),
                    m.purchase_price_basis, m.created_at, m.barcode, COALESCE(s.quantity, 0)
             FROM medicines m
             JOIN medicine_formulas f ON f.id = m.formula_id
             JOIN pharmaceutical_companies c ON c.id = m.company_id
             LEFT JOIN inventory_stock s ON s.medicine_id = m.id
             ORDER BY m.created_at DESC, m.name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([], |row| {
            Ok(MedicineRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                formula_id: row.get(2)?,
                formula_name: row.get(3)?,
                company_id: row.get(4)?,
                company_name: row.get(5)?,
                batch_number: row.get(6)?,
                gauge_number: row.get(7)?,
                units_per_pack: row.get(8)?,
                purchase_price: row.get(9)?,
                sale_price: row.get(10)?,
                suggested_sale_price: row.get(11)?,
                suggested_sale_price_basis: row.get(12)?,
                purchase_price_basis: row.get(13)?,
                created_at: row.get(14)?,
                barcode: row.get(15)?,
                stock_quantity: row.get(16)?,
            })
        })
        .map_err(|error| error.to_string())?;
    records
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn purchase_status(total: f64, paid: f64) -> &'static str {
    if paid >= total { "paid" } else if paid <= 0.0 { "unpaid" } else { "partial" }
}

fn round_money(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn is_iso_purchase_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit()) {
        return false;
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => return false,
    };
    year > 0 && day > 0 && day <= days_in_month
}

fn gregorian_to_jalali(value: &str) -> Option<String> {
    if !is_iso_purchase_date(value) { return None; }
    let mut gy = value[0..4].parse::<i64>().ok()?;
    let gm = value[5..7].parse::<usize>().ok()?;
    let gd = value[8..10].parse::<i64>().ok()?;
    if gy < 622 { return None; }
    let g_day_offsets = [0_i64, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let mut jy;
    if gy > 1600 { jy = 979; gy -= 1600; } else { jy = 0; gy -= 621; }
    let gy2 = if gm > 2 { gy + 1 } else { gy };
    let mut days = 365 * gy + (gy2 + 3) / 4 - (gy2 + 99) / 100
        + (gy2 + 399) / 400 - 80 + gd + g_day_offsets[gm - 1];
    jy += 33 * (days / 12_053);
    days %= 12_053;
    jy += 4 * (days / 1_461);
    days %= 1_461;
    if days > 365 { jy += (days - 1) / 365; days = (days - 1) % 365; }
    let (jm, jd) = if days < 186 {
        (1 + days / 31, 1 + days % 31)
    } else {
        (7 + (days - 186) / 30, 1 + (days - 186) % 30)
    };
    Some(format!("{jy:04}-{jm:02}-{jd:02}"))
}

fn is_local_datetime(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 19 || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':'
        || !bytes.iter().enumerate().all(|(index, byte)| [4, 7, 10, 13, 16].contains(&index) || byte.is_ascii_digit()) {
        return false;
    }
    is_iso_purchase_date(&value[..10])
        && value[11..13].parse::<u32>().is_ok_and(|hour| hour < 24)
        && value[14..16].parse::<u32>().is_ok_and(|minute| minute < 60)
        && value[17..19].parse::<u32>().is_ok_and(|second| second < 60)
}

fn sale_status(total: f64, paid: f64) -> &'static str {
    if paid >= total { "paid" } else if paid <= 0.0 { "unpaid" } else { "partial" }
}

#[tauri::command]
fn list_purchases(database_path: String) -> Result<Vec<PurchaseListSummary>, String> {
    let connection = open_product_database(&database_path)?;
    let mut statement = connection.prepare(
        "SELECT id, company_id, company_name, invoice_number, purchase_date, purchase_date_solar,
                (SELECT group_concat(medicine_name, ' | ') FROM (SELECT medicine_name FROM purchase_items WHERE purchase_id=purchases.id ORDER BY rowid)),
                (SELECT group_concat(expiry_date, ' | ') FROM (SELECT expiry_date FROM purchase_items WHERE purchase_id=purchases.id ORDER BY rowid)),
                subtotal,
                discount, total, paid_amount,
                CASE WHEN EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) THEN 0 ELSE remaining_amount END,
                CASE WHEN EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) THEN 'returned' ELSE status END,
                notes, created_at
         FROM purchases ORDER BY purchase_date DESC, created_at DESC",
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(PurchaseListSummary {
        id: row.get(0)?, company_id: row.get(1)?, company_name: row.get(2)?,
        invoice_number: row.get(3)?, purchase_date: row.get(4)?, purchase_date_solar: row.get(5)?,
        medicine_names: row.get::<_, Option<String>>(6)?.unwrap_or_default(), expiry_dates: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        subtotal: row.get(8)?, discount: row.get(9)?, total: row.get(10)?, paid_amount: row.get(11)?,
        remaining_amount: row.get(12)?, status: row.get(13)?, notes: row.get(14)?, created_at: row.get(15)?,
    })).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_company_purchase_account(database_path: String, company_id: String) -> Result<CompanyPurchaseAccount, String> {
    let connection = open_product_database(&database_path)?;
    let company = connection.query_row(
        "SELECT id, name, country, address, email, phone FROM pharmaceutical_companies WHERE id = ?1",
        [&company_id],
        |row| Ok(CompanyRecord { id: row.get(0)?, name: row.get(1)?, country: row.get(2)?, address: row.get(3)?, email: row.get(4)?, phone: row.get(5)? }),
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "company_not_found".to_string() } else { error.to_string() })?;
    let mut statement = connection.prepare(
        "SELECT id, company_id, company_name, invoice_number, purchase_date, purchase_date_solar, subtotal,
                discount, total, paid_amount,
                CASE WHEN EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) THEN 0 ELSE remaining_amount END,
                CASE WHEN EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) THEN 'returned' ELSE status END,
                notes, created_at
         FROM purchases WHERE company_id = ?1 ORDER BY purchase_date DESC, created_at DESC",
    ).map_err(|error| error.to_string())?;
    let purchases = statement.query_map([&company_id], |row| Ok(PurchaseSummary {
        id: row.get(0)?, company_id: row.get(1)?, company_name: row.get(2)?, invoice_number: row.get(3)?,
        purchase_date: row.get(4)?, purchase_date_solar: row.get(5)?, subtotal: row.get(6)?, discount: row.get(7)?,
        total: row.get(8)?, paid_amount: row.get(9)?, remaining_amount: row.get(10)?, status: row.get(11)?,
        notes: row.get(12)?, created_at: row.get(13)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let active_purchases: Vec<_> = purchases.iter().filter(|purchase| purchase.status != "returned").collect();
    let total_purchases = round_money(active_purchases.iter().map(|purchase| purchase.total).sum());
    let total_paid = round_money(active_purchases.iter().map(|purchase| purchase.paid_amount).sum());
    let amount_owed = round_money(active_purchases.iter().map(|purchase| purchase.remaining_amount).sum());
    let supplier_credit = connection.query_row("SELECT COALESCE(SUM(credit_amount), 0) FROM purchase_returns WHERE company_id = ?1", [&company_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(
        "SELECT pp.id, p.id, p.invoice_number, pp.payment_date, pp.payment_date_solar, pp.amount, pp.notes, pp.payment_type
         FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
         WHERE p.company_id = ?1 ORDER BY pp.payment_date DESC, pp.created_at DESC, pp.rowid DESC",
    ).map_err(|error| error.to_string())?;
    let payments = statement.query_map([&company_id], |row| Ok(CompanyPurchasePayment {
        id: row.get(0)?, purchase_id: row.get(1)?, invoice_number: row.get(2)?, payment_date: row.get(3)?,
        payment_date_solar: row.get(4)?, amount: row.get(5)?, notes: row.get(6)?, payment_type: row.get(7)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(CompanyPurchaseAccount { company, total_purchases, total_paid, amount_owed, supplier_credit: round_money(supplier_credit), purchases, payments })
}

#[tauri::command]
fn get_purchase(database_path: String, purchase_id: String) -> Result<PurchaseDetails, String> {
    let connection = open_product_database(&database_path)?;
    read_purchase(&connection, &purchase_id)
}

fn read_purchase(connection: &Connection, purchase_id: &str) -> Result<PurchaseDetails, String> {
    let header = connection.query_row(
        "SELECT id, company_id, company_name, invoice_number, purchase_date, purchase_date_solar, subtotal,
                discount, total, paid_amount,
                CASE WHEN EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) THEN 0 ELSE remaining_amount END,
                CASE WHEN EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) THEN 'returned' ELSE status END,
                notes, created_at
         FROM purchases WHERE id = ?1",
        [&purchase_id],
        |row| Ok(PurchaseSummary {
            id: row.get(0)?, company_id: row.get(1)?, company_name: row.get(2)?,
            invoice_number: row.get(3)?, purchase_date: row.get(4)?, purchase_date_solar: row.get(5)?,
            subtotal: row.get(6)?, discount: row.get(7)?, total: row.get(8)?, paid_amount: row.get(9)?,
            remaining_amount: row.get(10)?, status: row.get(11)?, notes: row.get(12)?, created_at: row.get(13)?,
        }),
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "purchase_not_found".to_string() } else { error.to_string() })?;
    let mut statement = connection.prepare(
        "SELECT id, medicine_id, medicine_name, quantity, unit_type, unit_price, sale_price, line_total, expiry_date
         FROM purchase_items WHERE purchase_id = ?1 ORDER BY rowid",
    ).map_err(|error| error.to_string())?;
    let items = statement.query_map([&purchase_id], |row| Ok(PurchaseItemRecord {
        id: row.get(0)?, medicine_id: row.get(1)?, medicine_name: row.get(2)?,
        quantity: row.get(3)?, unit_type: row.get(4)?, unit_price: row.get(5)?, sale_price: row.get(6)?, line_total: row.get(7)?, expiry_date: row.get(8)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(
        "SELECT id, payment_date, payment_date_solar, amount, notes, payment_type, payment_source
         FROM purchase_payments WHERE purchase_id = ?1 ORDER BY created_at, rowid",
    ).map_err(|error| error.to_string())?;
    let payments = statement.query_map([&purchase_id], |row| Ok(PurchasePaymentRecord {
        id: row.get(0)?, payment_date: row.get(1)?, payment_date_solar: row.get(2)?,
        amount: row.get(3)?, notes: row.get(4)?, payment_type: row.get(5)?, payment_source: row.get(6)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(PurchaseDetails {
        id: header.id, company_id: header.company_id, company_name: header.company_name,
        invoice_number: header.invoice_number, purchase_date: header.purchase_date,
        purchase_date_solar: header.purchase_date_solar,
        subtotal: header.subtotal, discount: header.discount, total: header.total,
        paid_amount: header.paid_amount, remaining_amount: header.remaining_amount,
        status: header.status, notes: header.notes, created_at: header.created_at, items, payments,
    })
}

#[tauri::command]
fn create_purchase(payload: CreatePurchasePayload) -> Result<PurchaseDetails, String> {
    cash::validate_source(&payload.payment_source)?;
    if !is_iso_purchase_date(&payload.purchase_date) || payload.items.is_empty()
        || !payload.discount.is_finite() || payload.discount < 0.0
        || !payload.paid_amount.is_finite() || payload.paid_amount < 0.0 {
        return Err("purchase_invalid_fields".to_string());
    }
    let purchase_date_solar = gregorian_to_jalali(&payload.purchase_date)
        .ok_or_else(|| "purchase_invalid_fields".to_string())?;
    let connection = open_product_database(&payload.database_path)?;
    let company_id = payload.company_id.as_deref().map(str::trim).filter(|id| !id.is_empty())
        .ok_or_else(|| "purchase_company_required".to_string())?;
    let company_name = {
        connection.query_row(
            "SELECT name FROM pharmaceutical_companies WHERE id = ?1", [company_id], |row| row.get::<_, String>(0),
        ).optional().map_err(|error| error.to_string())?.ok_or_else(|| "purchase_company_not_found".to_string())?
    };

    let mut items = Vec::with_capacity(payload.items.len());
    let mut subtotal = 0.0;
    for item in &payload.items {
        if item.medicine_id.trim().is_empty() || item.quantity <= 0
            || !matches!(item.unit_type.as_str(), "pack" | "unit")
            || !item.unit_price.is_finite() || item.unit_price < 0.0
            || !item.sale_price.is_finite() || item.sale_price < 0.0
            || !is_iso_purchase_date(&item.expiry_date) {
            return Err("purchase_invalid_item".to_string());
        }
        let (medicine_name, units_per_pack) = connection.query_row(
            "SELECT name, units_per_pack FROM medicines WHERE id = ?1", [&item.medicine_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).optional().map_err(|error| error.to_string())?.ok_or_else(|| "purchase_medicine_not_found".to_string())?;
        let line_total = round_money(item.quantity as f64 * item.unit_price);
        if !line_total.is_finite() { return Err("purchase_invalid_item".to_string()); }
        subtotal = round_money(subtotal + line_total);
        items.push((Uuid::new_v4().to_string(), item.medicine_id.clone(), medicine_name, item.quantity, item.unit_type.clone(), units_per_pack, round_money(item.unit_price), round_money(item.sale_price), line_total, item.expiry_date.clone()));
    }
    let discount = round_money(payload.discount);
    let paid_amount = round_money(payload.paid_amount);
    if discount > subtotal || !subtotal.is_finite() { return Err("purchase_discount_exceeds_subtotal".to_string()); }
    let total = round_money(subtotal - discount);
    if paid_amount > total { return Err("purchase_paid_exceeds_total".to_string()); }
    let remaining_amount = round_money(total - paid_amount);
    let status = purchase_status(total, paid_amount);
    let id = Uuid::new_v4().to_string();
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO purchases (id, company_id, company_name, invoice_number, purchase_date, purchase_date_solar,
            subtotal, discount, total, paid_amount, remaining_amount, status, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![id, company_id, company_name, payload.invoice_number.trim(), payload.purchase_date, purchase_date_solar,
            subtotal, discount, total, paid_amount, remaining_amount, status, payload.notes.trim()],
    ).map_err(|error| error.to_string())?;
    for (item_id, medicine_id, medicine_name, quantity, unit_type, units_per_pack, unit_price, sale_price, line_total, expiry_date) in &items {
        transaction.execute(
            "INSERT INTO purchase_items (id, purchase_id, medicine_id, medicine_name, quantity, unit_type, units_per_pack, unit_price, sale_price, line_total, expiry_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![item_id, id, medicine_id, medicine_name, quantity, unit_type, units_per_pack, unit_price, sale_price, line_total, expiry_date],
        ).map_err(|error| error.to_string())?;
        let stock_delta = quantity.checked_mul(if unit_type == "pack" { *units_per_pack } else { 1 }).ok_or_else(|| "purchase_invalid_item".to_string())?;
        let batch_number: String = transaction.query_row("SELECT batch_number FROM medicines WHERE id = ?1", [medicine_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO inventory_batches (id, medicine_id, purchase_item_id, batch_number, expiry_date, quantity_remaining) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![Uuid::new_v4().to_string(), medicine_id, item_id, batch_number, expiry_date, stock_delta]).map_err(|error| error.to_string())?;
    }
    for (_, medicine_id, medicine_name, quantity, unit_type, units_per_pack, _, _, _, _) in &items {
        let stock_delta = quantity.checked_mul(if unit_type == "pack" { *units_per_pack } else { 1 })
            .ok_or_else(|| "purchase_invalid_item".to_string())?;
        transaction.execute(
            "INSERT INTO inventory_stock (medicine_id, quantity) VALUES (?1, ?2)
             ON CONFLICT(medicine_id) DO UPDATE SET quantity = inventory_stock.quantity + excluded.quantity, updated_at = CURRENT_TIMESTAMP",
            params![medicine_id, stock_delta],
        ).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO inventory_movements (id, medicine_id, reference_type, reference_id, quantity_change)
             VALUES (?1, ?2, 'purchase', ?3, ?4)
             ON CONFLICT(reference_type, reference_id, medicine_id)
             DO UPDATE SET quantity_change = inventory_movements.quantity_change + excluded.quantity_change",
            params![Uuid::new_v4().to_string(), medicine_id, id, stock_delta],
        ).map_err(|error| error.to_string())?;
        queue_sync_event(&transaction, "inventory", medicine_id, serde_json::json!({
            "medicineId": medicine_id, "medicineName": medicine_name, "quantityChange": stock_delta,
            "referenceType": "purchase", "referenceId": id
        }))?;
    }
    let initial_payment_id = if paid_amount > 0.0 {
        let payment_id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO purchase_payments (id, purchase_id, payment_date, payment_date_solar, amount, notes, payment_type, payment_source)
             VALUES (?1, ?2, ?3, ?4, ?5, '', 'initial', ?6)",
            params![payment_id, id, payload.purchase_date, purchase_date_solar, paid_amount, payload.payment_source],
        ).map_err(|error| error.to_string())?;
        Some(payment_id)
    } else { None };
    let sync_items: Vec<serde_json::Value> = items.iter().map(|(item_id, medicine_id, medicine_name, quantity, unit_type, units_per_pack, unit_price, sale_price, line_total, expiry_date)| serde_json::json!({
        "id": item_id, "medicineId": medicine_id, "medicineName": medicine_name,
        "quantity": quantity, "unitType": unit_type, "unitsPerPack": units_per_pack,
        "unitPrice": unit_price, "salePrice": sale_price, "lineTotal": line_total, "expiryDate": expiry_date
    })).collect();
    let sync_payload = serde_json::json!({
        "id": id, "companyId": company_id, "companyName": company_name,
        "invoiceNumber": payload.invoice_number.trim(), "purchaseDate": payload.purchase_date,
        "purchaseDateSolar": purchase_date_solar,
        "subtotal": subtotal, "discount": discount, "total": total,
        "paidAmount": paid_amount, "remainingAmount": remaining_amount,
        "status": status, "notes": payload.notes.trim(), "items": sync_items,
        "payments": if let Some(payment_id) = initial_payment_id { vec![serde_json::json!({
            "id": payment_id, "paymentDate": payload.purchase_date,
            "paymentDateSolar": purchase_date_solar, "amount": paid_amount,
            "notes": "", "paymentType": "initial", "paymentSource": payload.payment_source
        })] } else { Vec::new() }
    });
    queue_sync_event(&transaction, "purchases", &id, sync_payload)?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_purchase(payload.database_path, id)
}

#[tauri::command]
fn record_purchase_payment(payload: RecordPurchasePaymentPayload) -> Result<PurchaseDetails, String> {
    cash::validate_source(&payload.payment_source)?;
    if payload.purchase_id.trim().is_empty() || !payload.amount.is_finite() || payload.amount <= 0.0
        || !is_iso_purchase_date(&payload.payment_date) {
        return Err("purchase_payment_invalid_fields".to_string());
    }
    let payment_date_solar = gregorian_to_jalali(&payload.payment_date)
        .ok_or_else(|| "purchase_payment_invalid_fields".to_string())?;
    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let (total, previous_paid, previous_remaining, returned): (f64, f64, f64, bool) = transaction.query_row(
        "SELECT total, paid_amount, remaining_amount, EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) FROM purchases WHERE id = ?1",
        [&payload.purchase_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "purchase_not_found".to_string() } else { error.to_string() })?;
    if returned { return Err("purchase_already_returned".to_string()); }
    let amount = round_money(payload.amount);
    if amount <= 0.0 { return Err("purchase_payment_invalid_fields".to_string()); }
    if amount > previous_remaining { return Err("purchase_payment_exceeds_remaining".to_string()); }
    let paid_amount = round_money(previous_paid + amount);
    let remaining_amount = round_money((total - paid_amount).max(0.0));
    let status = purchase_status(total, paid_amount);
    let payment_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO purchase_payments (id, purchase_id, payment_date, payment_date_solar, amount, notes, payment_type, payment_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'settlement', ?7)",
        params![payment_id, payload.purchase_id, payload.payment_date, payment_date_solar, amount, payload.notes.trim(), payload.payment_source],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "UPDATE purchases SET paid_amount = ?1, remaining_amount = ?2, status = ?3 WHERE id = ?4",
        params![paid_amount, remaining_amount, status, payload.purchase_id],
    ).map_err(|error| error.to_string())?;
    let updated_purchase = read_purchase(&transaction, &payload.purchase_id)?;
    queue_sync_event(
        &transaction, "purchases", &payload.purchase_id,
        serde_json::to_value(&updated_purchase).map_err(|error| error.to_string())?,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updated_purchase)
}

#[tauri::command]
fn return_purchase(payload: ReturnPurchasePayload) -> Result<PurchaseDetails, String> {
    if payload.purchase_id.trim().is_empty() { return Err("purchase_not_found".to_string()); }
    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let (company_id, paid_amount, already_returned): (Option<String>, f64, bool) = transaction.query_row(
        "SELECT company_id, paid_amount, EXISTS(SELECT 1 FROM purchase_returns r WHERE r.purchase_id = purchases.id) FROM purchases WHERE id = ?1",
        [&payload.purchase_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "purchase_not_found".to_string() } else { error.to_string() })?;
    if already_returned { return Err("purchase_already_returned".to_string()); }
    let company_id = company_id.ok_or_else(|| "purchase_company_missing".to_string())?;
    let movements = {
        let mut statement = transaction.prepare("SELECT id, medicine_id, quantity, unit_type, units_per_pack FROM purchase_items WHERE purchase_id = ?1")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map([&payload.purchase_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    if movements.is_empty() { return Err("purchase_not_found".to_string()); }
    for (item_id, medicine_id, quantity, unit_type, units_per_pack) in movements {
        let stock_delta = quantity.checked_mul(if unit_type == "pack" { units_per_pack } else { 1 })
            .ok_or_else(|| "purchase_return_insufficient_stock".to_string())?;
        let affected = transaction.execute(
            "UPDATE inventory_stock SET quantity = quantity - ?1, updated_at = CURRENT_TIMESTAMP WHERE medicine_id = ?2 AND quantity >= ?1",
            params![stock_delta, medicine_id],
        ).map_err(|error| error.to_string())?;
        if affected == 0 { return Err("purchase_return_insufficient_stock".to_string()); }
        let lot_remaining: Option<i64> = transaction.query_row("SELECT quantity_remaining FROM inventory_batches WHERE purchase_item_id=?1", [&item_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        if let Some(lot_remaining) = lot_remaining {
            if lot_remaining < stock_delta { return Err("purchase_return_insufficient_stock".to_string()); }
            transaction.execute("UPDATE inventory_batches SET quantity_remaining=quantity_remaining-?1 WHERE purchase_item_id=?2", params![stock_delta, item_id]).map_err(|error| error.to_string())?;
        }
        transaction.execute(
            "INSERT INTO inventory_movements (id, medicine_id, reference_type, reference_id, quantity_change) VALUES (?1, ?2, 'return', ?3, ?4)",
            params![Uuid::new_v4().to_string(), medicine_id, payload.purchase_id, -stock_delta],
        ).map_err(|error| error.to_string())?;
        queue_sync_event(&transaction, "inventory", &medicine_id, serde_json::json!({
            "medicineId": medicine_id, "quantityChange": -stock_delta, "referenceType": "return", "referenceId": payload.purchase_id
        }))?;
    }
    let return_date: String = transaction.query_row("SELECT date('now')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO purchase_returns (id, purchase_id, company_id, credit_amount, return_date, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![Uuid::new_v4().to_string(), payload.purchase_id, company_id, round_money(paid_amount), return_date, payload.notes.trim()],
    ).map_err(|error| error.to_string())?;
    let updated = read_purchase(&transaction, &payload.purchase_id)?;
    let mut sync_payload = serde_json::to_value(&updated).map_err(|error| error.to_string())?;
    sync_payload["return"] = serde_json::json!({
        "companyId": company_id, "creditAmount": round_money(paid_amount), "returnDate": return_date,
        "notes": payload.notes.trim()
    });
    queue_sync_event(&transaction, "purchases", &payload.purchase_id, sync_payload)?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_purchase(payload.database_path, payload.purchase_id)
}

#[tauri::command]
fn delete_purchase(database_path: String, purchase_id: String) -> Result<(), String> {
    let connection = open_product_database(&database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let linked: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM purchase_payments WHERE purchase_id=?1)
             OR EXISTS(SELECT 1 FROM purchase_returns WHERE purchase_id=?1)",
        [&purchase_id], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if linked { return Err("purchase_has_financial_history".to_string()); }
    let items = {
        let mut statement = transaction.prepare("SELECT pi.id, pi.medicine_id, pi.quantity * CASE WHEN pi.unit_type='pack' THEN pi.units_per_pack ELSE 1 END, COALESCE(ib.quantity_remaining, -1) FROM purchase_items pi LEFT JOIN inventory_batches ib ON ib.purchase_item_id=pi.id WHERE pi.purchase_id=?1").map_err(|error| error.to_string())?;
        let rows = statement.query_map([&purchase_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))).map_err(|error| error.to_string())?; rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    if items.is_empty() { return Err("purchase_not_found".to_string()); }
    for (_, medicine_id, quantity, lot_remaining) in &items {
        if *lot_remaining != *quantity { return Err("purchase_stock_already_used".to_string()); }
        let affected = transaction.execute("UPDATE inventory_stock SET quantity=quantity-?1, updated_at=CURRENT_TIMESTAMP WHERE medicine_id=?2 AND quantity>=?1", params![quantity, medicine_id]).map_err(|error| error.to_string())?;
        if affected == 0 { return Err("purchase_stock_already_used".to_string()); }
    }
    for (item_id, medicine_id, quantity, _) in items {
        transaction.execute("DELETE FROM inventory_batches WHERE purchase_item_id=?1", [&item_id]).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO inventory_movements(id,medicine_id,reference_type,reference_id,quantity_change) VALUES(?1,?2,'return',?3,?4)", params![Uuid::new_v4().to_string(), medicine_id, purchase_id, -quantity]).map_err(|error| error.to_string())?;
        queue_sync_event(&transaction, "inventory", &medicine_id, serde_json::json!({"medicineId":medicine_id,"quantityChange":-quantity,"referenceType":"return","referenceId":purchase_id}))?;
    }
    transaction.execute("DELETE FROM purchases WHERE id=?1", [&purchase_id]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO sync_outbox(event_id,entity,record_id,operation,payload_json) VALUES(?1,'purchases',?2,'delete','null')", params![Uuid::new_v4().to_string(), purchase_id]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn read_sale(connection: &Connection, sale_id: &str) -> Result<SaleDetails, String> {
    let header = connection.query_row(
        "SELECT id, invoice_number, sale_datetime, sale_date_solar, customer_id, customer_name,
                customer_phone, subtotal, line_discount_total, discount, total, paid_amount,
                remaining_amount, status, payment_method, notes, created_at
         FROM sales WHERE id = ?1",
        [sale_id],
        |row| Ok(SaleSummary {
            id: row.get(0)?, invoice_number: row.get(1)?, sale_datetime: row.get(2)?,
            sale_date_solar: row.get(3)?, customer_id: row.get(4)?, customer_name: row.get(5)?,
            customer_phone: row.get(6)?, subtotal: row.get(7)?, line_discount_total: row.get(8)?,
            discount: row.get(9)?, total: row.get(10)?, paid_amount: row.get(11)?,
            remaining_amount: row.get(12)?, status: row.get(13)?, payment_method: row.get(14)?,
            notes: row.get(15)?, created_at: row.get(16)?,
        }),
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "sale_not_found".to_string() } else { error.to_string() })?;
    let mut statement = connection.prepare(
        "SELECT id, medicine_id, medicine_name, barcode, quantity, unit_type, units_per_pack,
                unit_price, discount, line_total
         FROM sale_items WHERE sale_id = ?1 ORDER BY rowid",
    ).map_err(|error| error.to_string())?;
    let items = statement.query_map([sale_id], |row| Ok(SaleItemRecord {
        id: row.get(0)?, medicine_id: row.get(1)?, medicine_name: row.get(2)?,
        barcode: row.get(3)?, quantity: row.get(4)?, unit_type: row.get(5)?,
        units_per_pack: row.get(6)?, unit_price: row.get(7)?, discount: row.get(8)?,
        line_total: row.get(9)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(
        "SELECT id, payment_datetime, amount, payment_method, payment_type, notes FROM (
            SELECT id, payment_datetime, amount, payment_method, payment_type, notes, created_at AS sort_date
            FROM sale_payments WHERE sale_id = ?1
            UNION ALL
            SELECT ca.id, s.sale_datetime, ca.amount, 'credit', 'credit_applied', 'Customer credit applied', ca.created_at
            FROM customer_credit_applications ca JOIN sales s ON s.id = ca.sale_id WHERE ca.sale_id = ?1
         ) ORDER BY sort_date",
    ).map_err(|error| error.to_string())?;
    let payments = statement.query_map([sale_id], |row| Ok(SalePaymentRecord {
        id: row.get(0)?, payment_datetime: row.get(1)?, amount: row.get(2)?,
        payment_method: row.get(3)?, payment_type: row.get(4)?, notes: row.get(5)?,
    })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(SaleDetails {
        id: header.id, invoice_number: header.invoice_number, sale_datetime: header.sale_datetime,
        sale_date_solar: header.sale_date_solar, customer_id: header.customer_id,
        customer_name: header.customer_name, customer_phone: header.customer_phone,
        subtotal: header.subtotal, line_discount_total: header.line_discount_total,
        discount: header.discount, total: header.total, paid_amount: header.paid_amount,
        remaining_amount: header.remaining_amount, status: header.status,
        payment_method: header.payment_method, notes: header.notes, created_at: header.created_at,
        items, payments,
    })
}

#[tauri::command]
fn list_sales(database_path: String) -> Result<Vec<SaleSummary>, String> {
    let connection = open_product_database(&database_path)?;
    let mut statement = connection.prepare(
        "SELECT id, invoice_number, sale_datetime, sale_date_solar, customer_id, customer_name,
                customer_phone, subtotal, line_discount_total, discount, total, paid_amount,
                remaining_amount, status, payment_method, notes, created_at
         FROM sales ORDER BY sale_datetime DESC, created_at DESC",
    ).map_err(|error| error.to_string())?;
    let records = statement.query_map([], |row| Ok(SaleSummary {
        id: row.get(0)?, invoice_number: row.get(1)?, sale_datetime: row.get(2)?,
        sale_date_solar: row.get(3)?, customer_id: row.get(4)?, customer_name: row.get(5)?,
        customer_phone: row.get(6)?, subtotal: row.get(7)?, line_discount_total: row.get(8)?,
        discount: row.get(9)?, total: row.get(10)?, paid_amount: row.get(11)?,
        remaining_amount: row.get(12)?, status: row.get(13)?, payment_method: row.get(14)?,
        notes: row.get(15)?, created_at: row.get(16)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    records
}

#[tauri::command]
fn get_sale(database_path: String, sale_id: String) -> Result<SaleDetails, String> {
    let connection = open_product_database(&database_path)?;
    read_sale(&connection, &sale_id)
}

#[tauri::command]
fn create_sale(payload: CreateSalePayload) -> Result<SaleDetails, String> {
    if !is_local_datetime(&payload.sale_datetime) || payload.items.is_empty()
        || !payload.discount.is_finite() || payload.discount < 0.0
        || !payload.paid_amount.is_finite() || payload.paid_amount < 0.0
        || !matches!(payload.payment_method.as_str(), "cash" | "card" | "bank" | "mobile" | "other") {
        return Err("sale_invalid_fields".to_string());
    }
    let sale_date = &payload.sale_datetime[..10];
    let sale_date_solar = gregorian_to_jalali(sale_date).ok_or_else(|| "sale_invalid_fields".to_string())?;
    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;

    let (customer_name, customer_phone) = if let Some(customer_id) = payload.customer_id.as_deref().filter(|id| !id.trim().is_empty()) {
        transaction.query_row("SELECT trim(name || ' ' || surname), phone FROM customers WHERE id = ?1 AND deleted_at IS NULL", [customer_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .optional().map_err(|error| error.to_string())?.ok_or_else(|| "sale_customer_not_found".to_string())?
    } else { (String::new(), String::new()) };

    let mut lines = Vec::with_capacity(payload.items.len());
    let mut required_stock: HashMap<String, i64> = HashMap::new();
    let mut subtotal = 0.0;
    let mut line_discount_total = 0.0;
    for item in &payload.items {
        if item.medicine_id.trim().is_empty() || item.quantity <= 0
            || !matches!(item.unit_type.as_str(), "pack" | "unit")
            || !item.unit_price.is_finite() || item.unit_price < 0.0
            || !item.discount.is_finite() || item.discount < 0.0 {
            return Err("sale_invalid_item".to_string());
        }
        let (name, barcode, units_per_pack, stock): (String, String, i64, i64) = transaction.query_row(
            "SELECT m.name, m.barcode, m.units_per_pack, COALESCE(s.quantity, 0)
             FROM medicines m LEFT JOIN inventory_stock s ON s.medicine_id = m.id WHERE m.id = ?1",
            [&item.medicine_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|error| error.to_string())?.ok_or_else(|| "sale_medicine_not_found".to_string())?;
        let gross = round_money(item.quantity as f64 * item.unit_price);
        let discount = round_money(item.discount);
        if !gross.is_finite() || discount > gross { return Err("sale_invalid_item".to_string()); }
        let line_total = round_money(gross - discount);
        let stock_delta = item.quantity.checked_mul(if item.unit_type == "pack" { units_per_pack } else { 1 })
            .ok_or_else(|| "sale_invalid_item".to_string())?;
        let required = required_stock.entry(item.medicine_id.clone()).or_insert(0);
        *required = required.checked_add(stock_delta).ok_or_else(|| "sale_invalid_item".to_string())?;
        subtotal = round_money(subtotal + gross);
        line_discount_total = round_money(line_discount_total + discount);
        lines.push((Uuid::new_v4().to_string(), item.medicine_id.clone(), name, barcode, item.quantity,
            item.unit_type.clone(), units_per_pack, round_money(item.unit_price), discount, line_total, stock));
    }
    for (medicine_id, needed) in &required_stock {
        let available = lines.iter().find(|line| &line.1 == medicine_id).map(|line| line.10).unwrap_or(0);
        if *needed > available { return Err("sale_insufficient_stock".to_string()); }
    }
    let discount = round_money(payload.discount);
    if discount > subtotal - line_discount_total { return Err("sale_discount_exceeds_subtotal".to_string()); }
    let total = round_money(subtotal - line_discount_total - discount);
    let cash_received = round_money(payload.paid_amount);
    let customer_id = payload.customer_id.as_deref().filter(|value| !value.trim().is_empty());
    if customer_id.is_none() && cash_received > total { return Err("sale_paid_exceeds_total".to_string()); }
    let cash_applied = cash_received.min(total);
    let available_credit: f64 = if let Some(customer_id) = customer_id {
        transaction.query_row(
            "SELECT MAX(0, COALESCE((SELECT SUM(amount) FROM customer_credit_entries WHERE customer_id = ?1), 0)
                - COALESCE((SELECT SUM(amount) FROM customer_credit_applications WHERE customer_id = ?1), 0))",
            [customer_id], |row| row.get(0),
        ).map_err(|error| error.to_string())?
    } else { 0.0 };
    let credit_applied = round_money(available_credit.min((total - cash_applied).max(0.0)));
    let paid_amount = round_money(cash_applied + credit_applied);
    let excess_receipt = round_money((cash_received - cash_applied).max(0.0));
    let remaining_amount = round_money(total - paid_amount);
    let status = sale_status(total, paid_amount);
    let id = Uuid::new_v4().to_string();
    let invoice_number = format!("S-{}-{}", sale_date.replace('-', ""), &id[..8].to_uppercase());
    transaction.execute(
        "INSERT INTO sales (id, invoice_number, sale_datetime, sale_date_solar, customer_id,
            customer_name, customer_phone, subtotal, line_discount_total, discount, total,
            paid_amount, remaining_amount, status, payment_method, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![id, invoice_number, payload.sale_datetime, sale_date_solar, customer_id,
            customer_name, customer_phone, subtotal, line_discount_total, discount, total,
            paid_amount, remaining_amount, status, payload.payment_method, payload.notes.trim()],
    ).map_err(|error| error.to_string())?;
    for (line_id, medicine_id, medicine_name, barcode, quantity, unit_type, units_per_pack, unit_price, line_discount, line_total, _) in &lines {
        transaction.execute(
            "INSERT INTO sale_items (id, sale_id, medicine_id, medicine_name, barcode, quantity,
                unit_type, units_per_pack, unit_price, discount, line_total)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![line_id, id, medicine_id, medicine_name, barcode, quantity, unit_type,
                units_per_pack, unit_price, line_discount, line_total],
        ).map_err(|error| error.to_string())?;
        let required_units = quantity.checked_mul(if unit_type == "pack" { *units_per_pack } else { 1 }).ok_or_else(|| "sale_invalid_item".to_string())?;
        allocate_inventory_batches(&transaction, line_id, medicine_id, required_units, sale_date)?;
    }
    for (medicine_id, stock_delta) in &required_stock {
        transaction.execute(
            "UPDATE inventory_stock SET quantity = quantity - ?1, updated_at = CURRENT_TIMESTAMP
             WHERE medicine_id = ?2 AND quantity >= ?1",
            params![stock_delta, medicine_id],
        ).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO inventory_movements (id, medicine_id, reference_type, reference_id, quantity_change)
             VALUES (?1, ?2, 'sale', ?3, ?4)",
            params![Uuid::new_v4().to_string(), medicine_id, id, -stock_delta],
        ).map_err(|error| error.to_string())?;
        let medicine_name = lines.iter().find(|line| &line.1 == medicine_id).map(|line| line.2.as_str()).unwrap_or("");
        queue_sync_event(&transaction, "inventory", medicine_id, serde_json::json!({
            "medicineId": medicine_id, "medicineName": medicine_name, "quantityChange": -stock_delta,
            "referenceType": "sale", "referenceId": id
        }))?;
    }
    if cash_received > 0.0 {
        let payment_id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO sale_payments (id, sale_id, payment_datetime, amount, payment_method, payment_type, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, 'receipt', '')",
            params![payment_id, id, payload.sale_datetime, cash_received, payload.payment_method],
        ).map_err(|error| error.to_string())?;
        if excess_receipt > 0.0 {
            let customer_id = customer_id.ok_or_else(|| "sale_customer_not_found".to_string())?;
            transaction.execute(
                "INSERT INTO customer_credit_entries (id, customer_id, source_type, source_id, amount, notes)
                 VALUES (?1, ?2, 'receipt_overpayment', ?3, ?4, 'Receipt exceeds invoice amount')",
                params![Uuid::new_v4().to_string(), customer_id, payment_id, excess_receipt],
            ).map_err(|error| error.to_string())?;
        }
    }
    if credit_applied > 0.0 {
        let customer_id = customer_id.ok_or_else(|| "sale_customer_not_found".to_string())?;
        transaction.execute(
            "INSERT INTO customer_credit_applications (id, customer_id, sale_id, amount) VALUES (?1, ?2, ?3, ?4)",
            params![Uuid::new_v4().to_string(), customer_id, id, credit_applied],
        ).map_err(|error| error.to_string())?;
    }
    let sync_items: Vec<serde_json::Value> = lines.iter().map(|line| serde_json::json!({
        "id": line.0, "medicineId": line.1, "medicineName": line.2, "barcode": line.3,
        "quantity": line.4, "unitType": line.5, "unitsPerPack": line.6, "unitPrice": line.7,
        "discount": line.8, "lineTotal": line.9
    })).collect();
    let sync_payload = serde_json::json!({
        "id": id, "invoiceNumber": invoice_number, "saleDateTime": payload.sale_datetime,
        "saleDateSolar": sale_date_solar, "customerId": customer_id,
        "customerName": customer_name, "customerPhone": customer_phone, "subtotal": subtotal,
        "lineDiscountTotal": line_discount_total, "discount": discount, "total": total,
        "paidAmount": paid_amount, "remainingAmount": remaining_amount, "status": status,
        "creditApplied": credit_applied, "excessReceiptCredit": excess_receipt,
        "paymentMethod": payload.payment_method, "notes": payload.notes.trim(), "items": sync_items,
        "payments": if cash_received > 0.0 { vec![serde_json::json!({
            "amount": cash_received, "paymentMethod": payload.payment_method, "paymentType": "receipt"
        })] } else { Vec::new() }
    });
    if let Some(customer_id) = customer_id {
        let customer = read_customer(&transaction, customer_id)?;
        queue_sync_event(&transaction, "customers", customer_id,
            serde_json::to_value(customer).map_err(|error| error.to_string())?)?;
    }
    queue_sync_event(&transaction, "sales", &id, sync_payload)?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_sale(payload.database_path, id)
}

fn allocate_inventory_batches(connection: &Connection, sale_item_id: &str, medicine_id: &str, mut required: i64, sale_date: &str) -> Result<(), String> {
    let batches = {
        let mut statement = connection.prepare("SELECT id, quantity_remaining FROM inventory_batches WHERE medicine_id=?1 AND quantity_remaining>0 AND (expiry_date='' OR expiry_date>=?2) ORDER BY CASE WHEN expiry_date='' THEN 1 ELSE 0 END, expiry_date, rowid").map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![medicine_id, sale_date], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        rows
    };
    for (batch_id, available) in batches {
        if required == 0 { break; }
        let taken = required.min(available);
        connection.execute("UPDATE inventory_batches SET quantity_remaining=quantity_remaining-?1 WHERE id=?2 AND quantity_remaining>=?1", params![taken, batch_id]).map_err(|error| error.to_string())?;
        connection.execute("INSERT INTO sale_item_batches(sale_item_id,batch_id,quantity) VALUES(?1,?2,?3)", params![sale_item_id, batch_id, taken]).map_err(|error| error.to_string())?;
        required -= taken;
    }
    if required > 0 { return Err("sale_insufficient_unexpired_stock".to_string()); }
    Ok(())
}

#[tauri::command]
fn record_sale_payment(payload: RecordSalePaymentPayload) -> Result<SaleDetails, String> {
    if payload.sale_id.trim().is_empty() || !payload.amount.is_finite() || payload.amount <= 0.0
        || !is_local_datetime(&payload.payment_datetime)
        || !matches!(payload.payment_method.as_str(), "cash" | "card" | "bank" | "mobile" | "other") {
        return Err("sale_payment_invalid_fields".to_string());
    }
    let amount = round_money(payload.amount);
    if amount <= 0.0 { return Err("sale_payment_invalid_fields".to_string()); }
    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let (total, paid, remaining, status, customer_id): (f64, f64, f64, String, Option<String>) = transaction.query_row(
        "SELECT total, paid_amount, remaining_amount, status, customer_id FROM sales WHERE id = ?1",
        [&payload.sale_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "sale_not_found".to_string() } else { error.to_string() })?;
    if status == "cancelled" || status == "returned" { return Err("sale_not_payable".to_string()); }
    let applied_amount = amount.min(remaining);
    let excess_amount = round_money((amount - applied_amount).max(0.0));
    if excess_amount > 0.0 && customer_id.is_none() { return Err("sale_payment_exceeds_remaining".to_string()); }
    let new_paid = round_money(paid + applied_amount);
    let new_remaining = round_money((total - new_paid).max(0.0));
    let new_status = sale_status(total, new_paid);
    let payment_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO sale_payments (id, sale_id, payment_datetime, amount, payment_method, payment_type, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, 'receipt', ?6)",
        params![payment_id, payload.sale_id, payload.payment_datetime, amount, payload.payment_method, payload.notes.trim()],
    ).map_err(|error| error.to_string())?;
    if excess_amount > 0.0 {
        transaction.execute(
            "INSERT INTO customer_credit_entries (id, customer_id, source_type, source_id, amount, notes)
             VALUES (?1, ?2, 'receipt_overpayment', ?3, ?4, 'Receipt exceeds invoice balance')",
            params![Uuid::new_v4().to_string(), customer_id, payment_id, excess_amount],
        ).map_err(|error| error.to_string())?;
    }
    transaction.execute(
        "UPDATE sales SET paid_amount = ?1, remaining_amount = ?2, status = ?3 WHERE id = ?4",
        params![new_paid, new_remaining, new_status, payload.sale_id],
    ).map_err(|error| error.to_string())?;
    let updated = read_sale(&transaction, &payload.sale_id)?;
    if let Some(customer_id) = customer_id.as_deref() {
        let customer = read_customer(&transaction, customer_id)?;
        queue_sync_event(&transaction, "customers", customer_id,
            serde_json::to_value(customer).map_err(|error| error.to_string())?)?;
    }
    queue_sync_event(&transaction, "sales", &payload.sale_id,
        serde_json::to_value(&updated).map_err(|error| error.to_string())?)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
fn cancel_sale(database_path: String, sale_id: String) -> Result<SaleDetails, String> {
    let connection = open_product_database(&database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let (status, paid, method, customer_id): (String, f64, String, Option<String>) = transaction.query_row(
        "SELECT status, paid_amount, payment_method, customer_id FROM sales WHERE id = ?1",
        [&sale_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "sale_not_found".to_string() } else { error.to_string() })?;
    if status == "cancelled" || status == "returned" { return Err("sale_already_reversed".to_string()); }
    let mut statement = transaction.prepare(
        "SELECT medicine_id, medicine_name, SUM(quantity * CASE WHEN unit_type='pack' THEN units_per_pack ELSE 1 END)
         FROM sale_items WHERE sale_id = ?1 GROUP BY medicine_id, medicine_name",
    ).map_err(|error| error.to_string())?;
    let restored = statement.query_map([&sale_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    drop(statement);
    for (medicine_id, medicine_name, quantity) in restored {
        transaction.execute(
            "INSERT INTO inventory_stock (medicine_id, quantity) VALUES (?1, ?2)
             ON CONFLICT(medicine_id) DO UPDATE SET quantity = inventory_stock.quantity + excluded.quantity, updated_at = CURRENT_TIMESTAMP",
            params![medicine_id, quantity],
        ).map_err(|error| error.to_string())?;
        let allocations = {
            let mut statement = transaction.prepare("SELECT sib.batch_id, sib.quantity FROM sale_item_batches sib JOIN sale_items si ON si.id=sib.sale_item_id WHERE si.sale_id=?1 AND si.medicine_id=?2").map_err(|error| error.to_string())?;
            let rows = statement.query_map(params![sale_id, medicine_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
        };
        if allocations.is_empty() {
            transaction.execute("UPDATE inventory_batches SET quantity_remaining=quantity_remaining+?1 WHERE id=?2", params![quantity, format!("legacy-{medicine_id}")]).map_err(|error| error.to_string())?;
        } else {
            for (batch_id, allocated) in allocations {
                transaction.execute("UPDATE inventory_batches SET quantity_remaining=quantity_remaining+?1 WHERE id=?2", params![allocated, batch_id]).map_err(|error| error.to_string())?;
            }
        }
        transaction.execute(
            "INSERT INTO inventory_movements (id, medicine_id, reference_type, reference_id, quantity_change)
             VALUES (?1, ?2, 'return', ?3, ?4)",
            params![Uuid::new_v4().to_string(), medicine_id, sale_id, quantity],
        ).map_err(|error| error.to_string())?;
        queue_sync_event(&transaction, "inventory", &medicine_id, serde_json::json!({
            "medicineId": medicine_id, "medicineName": medicine_name, "quantityChange": quantity,
            "referenceType": "return", "referenceId": sale_id
        }))?;
    }
    if paid > 0.0 {
        if let Some(customer_id) = customer_id.as_deref() {
            transaction.execute(
                "INSERT INTO customer_credit_entries (id, customer_id, source_type, source_id, amount, notes)
                 VALUES (?1, ?2, 'sale_return', ?3, ?4, 'Customer credit from sale return')",
                params![Uuid::new_v4().to_string(), customer_id, sale_id, paid],
            ).map_err(|error| error.to_string())?;
        } else {
            // Refund each original method separately: card/bank receipts must not leave the till.
            let receipts = {
                let mut statement = transaction.prepare("SELECT payment_method, ROUND(SUM(amount),2) FROM sale_payments WHERE sale_id=?1 AND payment_type='receipt' GROUP BY payment_method").map_err(|e|e.to_string())?;
                let rows = statement.query_map([&sale_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?))).map_err(|e|e.to_string())?;
                rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
            };
            let receipts = if receipts.is_empty() {vec![(method,paid)]} else {receipts};
            for (refund_method,refund_amount) in receipts {
                transaction.execute(
                    "INSERT INTO sale_payments (id, sale_id, payment_datetime, amount, payment_method, payment_type, notes)
                     VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%S','now','+4 hours','+30 minutes'), ?3, ?4, 'refund', 'Sale reversal refund')",
                    params![Uuid::new_v4().to_string(), sale_id, refund_amount, refund_method],
                ).map_err(|error| error.to_string())?;
            }
        }
    }
    let final_status = if paid > 0.0 { "returned" } else { "cancelled" };
    transaction.execute(
        "UPDATE sales SET paid_amount = 0, remaining_amount = 0, status = ?1 WHERE id = ?2",
        params![final_status, sale_id],
    ).map_err(|error| error.to_string())?;
    let updated = read_sale(&transaction, &sale_id)?;
    if let Some(customer_id) = customer_id.as_deref() {
        let customer = read_customer(&transaction, customer_id)?;
        queue_sync_event(&transaction, "customers", customer_id,
            serde_json::to_value(customer).map_err(|error| error.to_string())?)?;
    }
    queue_sync_event(&transaction, "sales", &sale_id,
        serde_json::to_value(&updated).map_err(|error| error.to_string())?)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
fn delete_sale(database_path: String, sale_id: String) -> Result<(), String> {
    let connection = open_product_database(&database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let linked: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sale_payments WHERE sale_id=?1) OR EXISTS(SELECT 1 FROM customer_credit_applications WHERE sale_id=?1)", [&sale_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if linked { return Err("sale_has_financial_history".to_string()); }
    let movements = {
        let mut statement = transaction.prepare("SELECT medicine_id, medicine_name, SUM(quantity * CASE WHEN unit_type='pack' THEN units_per_pack ELSE 1 END) FROM sale_items WHERE sale_id=?1 GROUP BY medicine_id, medicine_name").map_err(|error| error.to_string())?;
        let rows = statement.query_map([&sale_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))).map_err(|error| error.to_string())?; rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    if movements.is_empty() { return Err("sale_not_found".to_string()); }
    for (medicine_id, medicine_name, quantity) in movements {
        let allocations = {
            let mut statement = transaction.prepare("SELECT sib.batch_id,sib.quantity FROM sale_item_batches sib JOIN sale_items si ON si.id=sib.sale_item_id WHERE si.sale_id=?1 AND si.medicine_id=?2").map_err(|error| error.to_string())?;
            let rows = statement.query_map(params![sale_id, medicine_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?; rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
        };
        for (batch_id, allocated) in allocations { transaction.execute("UPDATE inventory_batches SET quantity_remaining=quantity_remaining+?1 WHERE id=?2", params![allocated,batch_id]).map_err(|error| error.to_string())?; }
        transaction.execute("INSERT INTO inventory_stock(medicine_id,quantity) VALUES(?1,?2) ON CONFLICT(medicine_id) DO UPDATE SET quantity=inventory_stock.quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP", params![medicine_id,quantity]).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO inventory_movements(id,medicine_id,reference_type,reference_id,quantity_change) VALUES(?1,?2,'return',?3,?4)", params![Uuid::new_v4().to_string(),medicine_id,sale_id,quantity]).map_err(|error| error.to_string())?;
        queue_sync_event(&transaction,"inventory",&medicine_id,serde_json::json!({"medicineId":medicine_id,"medicineName":medicine_name,"quantityChange":quantity,"referenceType":"return","referenceId":sale_id}))?;
    }
    transaction.execute("DELETE FROM sales WHERE id=?1", [&sale_id]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO sync_outbox(event_id,entity,record_id,operation,payload_json) VALUES(?1,'sales',?2,'delete','null')", params![Uuid::new_v4().to_string(),sale_id]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn create_medicine(payload: CreateMedicinePayload) -> Result<MedicineRecord, String> {
    if payload.name.trim().is_empty()
        || payload.units_per_pack <= 0
        || payload.purchase_price < 0.0
        || payload.sale_price < 0.0
    {
        return Err("medicine_invalid_fields".to_string());
    }
    if payload.purchase_price_basis != "pack" && payload.purchase_price_basis != "unit" {
        return Err("medicine_invalid_price_basis".to_string());
    }

    let connection = open_product_database(&payload.database_path)?;
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO medicines (id, name, formula_id, company_id, batch_number, gauge_number, units_per_pack, purchase_price, sale_price, purchase_price_basis, barcode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![id, payload.name.trim(), payload.formula_id, payload.company_id, payload.batch_number.trim(), payload.gauge_number.trim(), payload.units_per_pack, payload.purchase_price, payload.sale_price, payload.purchase_price_basis, payload.barcode.trim()],
        )
        .map_err(|error| error.to_string())?;
    let record = connection
        .query_row(
                "SELECT m.id, m.name, m.formula_id, f.name, m.company_id, c.name,
                    m.batch_number, m.gauge_number, m.units_per_pack, m.purchase_price,
                    m.sale_price, m.sale_price, 'unit', m.purchase_price_basis, m.created_at, m.barcode, COALESCE(s.quantity, 0)
             FROM medicines m
             JOIN medicine_formulas f ON f.id = m.formula_id
             JOIN pharmaceutical_companies c ON c.id = m.company_id
             LEFT JOIN inventory_stock s ON s.medicine_id = m.id
             WHERE m.id = ?1",
            [&id],
            |row| {
                Ok(MedicineRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    formula_id: row.get(2)?,
                    formula_name: row.get(3)?,
                    company_id: row.get(4)?,
                    company_name: row.get(5)?,
                    batch_number: row.get(6)?,
                    gauge_number: row.get(7)?,
                    units_per_pack: row.get(8)?,
                    purchase_price: row.get(9)?,
                    sale_price: row.get(10)?,
                    suggested_sale_price: row.get(11)?,
                    suggested_sale_price_basis: row.get(12)?,
                    purchase_price_basis: row.get(13)?,
                    created_at: row.get(14)?,
                    barcode: row.get(15)?,
                    stock_quantity: row.get(16)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    queue_sync_event(
        &connection,
        "products",
        &id,
        serde_json::to_value(&record).map_err(|error| error.to_string())?,
    )?;
    Ok(record)
}

#[tauri::command]
fn update_medicine(payload: UpdateMedicinePayload) -> Result<MedicineRecord, String> {
    let medicine = payload.medicine;
    if payload.id.trim().is_empty() || medicine.name.trim().is_empty()
        || medicine.units_per_pack <= 0 || medicine.purchase_price < 0.0 || medicine.sale_price < 0.0 {
        return Err("medicine_invalid_fields".to_string());
    }
    if medicine.purchase_price_basis != "pack" && medicine.purchase_price_basis != "unit" {
        return Err("medicine_invalid_price_basis".to_string());
    }
    let connection = open_product_database(&medicine.database_path)?;
    let affected = connection.execute(
        "UPDATE medicines SET name=?1, formula_id=?2, company_id=?3, batch_number=?4, gauge_number=?5, units_per_pack=?6, barcode=?7 WHERE id=?8",
        params![medicine.name.trim(), medicine.formula_id, medicine.company_id, medicine.batch_number.trim(), medicine.gauge_number.trim(), medicine.units_per_pack, medicine.barcode.trim(), payload.id],
    ).map_err(|error| error.to_string())?;
    if affected == 0 { return Err("medicine_not_found".to_string()); }
    let record = list_medicines(medicine.database_path)?.into_iter()
        .find(|record| record.id == payload.id).ok_or_else(|| "medicine_not_found".to_string())?;
    queue_sync_event(&connection, "products", &payload.id,
        serde_json::to_value(&record).map_err(|error| error.to_string())?)?;
    Ok(record)
}

#[tauri::command]
fn delete_medicine(database_path: String, medicine_id: String) -> Result<(), String> {
    let connection = open_product_database(&database_path)?;
    let affected = connection.execute("DELETE FROM medicines WHERE id=?1", [&medicine_id])
        .map_err(|error| error.to_string())?;
    if affected == 0 { return Err("medicine_not_found".to_string()); }
    queue_sync_event(&connection, "products", &medicine_id, serde_json::Value::Null)
}

#[tauri::command]
fn import_medicines(payload: ImportMedicinesPayload) -> Result<ImportMedicinesResult, String> {
    if payload.rows.len() > 10_000 {
        return Err("import_too_many_rows".to_string());
    }

    let connection = open_product_database(&payload.database_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut imported = 0;
    let mut skipped = 0;

    for row in payload.rows {
        let valid = !row.name.trim().is_empty()
            && !row.formula_name.trim().is_empty()
            && !row.company_name.trim().is_empty()
            && row.units_per_pack > 0
            && row.purchase_price >= 0.0
            && row.sale_price >= 0.0
            && (row.purchase_price_basis == "pack" || row.purchase_price_basis == "unit");
        if !valid {
            skipped += 1;
            continue;
        }

        let formula_id = transaction
            .query_row(
                "SELECT id FROM medicine_formulas WHERE name = ?1 COLLATE NOCASE",
                [row.formula_name.trim()],
                |record| record.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let company_id = transaction
            .query_row(
                "SELECT id FROM pharmaceutical_companies WHERE name = ?1 COLLATE NOCASE",
                [row.company_name.trim()],
                |record| record.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let (Some(formula_id), Some(company_id)) = (formula_id, company_id) else {
            skipped += 1;
            continue;
        };

        let id = Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO medicines (
                    id, name, formula_id, company_id, batch_number, gauge_number,
                    units_per_pack, purchase_price, sale_price, purchase_price_basis, barcode
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id,
                    row.name.trim(),
                    formula_id,
                    company_id,
                    row.batch_number.trim(),
                    row.gauge_number.trim(),
                    row.units_per_pack,
                    row.purchase_price,
                    row.sale_price,
                    row.purchase_price_basis,
                    row.barcode.trim(),
                ],
            )
            .map_err(|error| error.to_string())?;

        let event_data = serde_json::json!({
            "id": id,
            "name": row.name.trim(),
            "formulaId": formula_id,
            "companyId": company_id,
            "batchNumber": row.batch_number.trim(),
            "gaugeNumber": row.gauge_number.trim(),
            "barcode": row.barcode.trim(),
            "unitsPerPack": row.units_per_pack,
            "purchasePrice": row.purchase_price,
            "salePrice": row.sale_price,
            "purchasePriceBasis": row.purchase_price_basis,
        });
        queue_sync_event(&transaction, "products", &id, event_data)?;
        imported += 1;
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ImportMedicinesResult { imported, skipped })
}

#[tauri::command]
fn save_excel_export(file_path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(&file_path);
    let is_xlsx = target
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(false);
    if !is_xlsx || bytes.is_empty() {
        return Err("invalid_export_file".to_string());
    }

    fs::write(target, bytes).map_err(|_| "export_write_failed".to_string())
}

fn validate_payload(payload: &CreateDatabasePayload) -> Result<(), String> {
    let required = [
        (&payload.first_name, "First name is required"),
        (&payload.last_name, "Last name is required"),
        (&payload.admin_phone, "Mobile number is required"),
        (&payload.company_name, "Company name is required"),
        (&payload.office_phone, "Office phone is required"),
        (&payload.database_name, "Database name is required"),
        (&payload.db_path, "Database folder is required"),
    ];

    if let Some((_, message)) = required.iter().find(|(value, _)| value.trim().is_empty()) {
        return Err((*message).to_string());
    }
    if payload.password.chars().count() < 4 {
        return Err("Password must contain at least 4 characters".to_string());
    }
    if payload.password != payload.confirm_password {
        return Err("Passwords do not match".to_string());
    }

    Ok(())
}

fn database_file_name(name: &str) -> Result<String, String> {
    let safe_name: String = name
        .trim()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();

    let safe_name = safe_name.trim_matches('_');
    if safe_name.is_empty() {
        return Err("Database name must contain letters or numbers".to_string());
    }

    Ok(format!("{safe_name}.sqlite3"))
}

fn initialize_database(
    database_path: &Path,
    payload: &CreateDatabasePayload,
    password_hash: &str,
) -> Result<(), String> {
    let mut connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(include_str!("schema.sql"))
        .map_err(|error| error.to_string())?;

    let company_id = Uuid::new_v4().to_string();
    let admin_id = Uuid::new_v4().to_string();
    let event_id = Uuid::new_v4().to_string();
    let company_payload = serde_json::json!({
        "id": company_id,
        "company_name": payload.company_name.trim(),
        "company_address": payload.company_address.trim(),
        "office_phone": payload.office_phone.trim(),
        "secondary_phone": payload.secondary_phone.trim(),
        "email": payload.company_email.trim(),
    });
    let payload_json =
        serde_json::to_string(&company_payload).map_err(|error| error.to_string())?;

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO company_info (id, company_name, company_address, office_phone, secondary_phone, email)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                company_id,
                payload.company_name.trim(),
                payload.company_address.trim(),
                payload.office_phone.trim(),
                payload.secondary_phone.trim(),
                payload.company_email.trim(),
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO admin_users (id, first_name, last_name, phone_number, password_hash, role, username, is_owner)
             VALUES (?1, ?2, ?3, ?4, ?5, 'super_admin', ?6, 1)",
            params![
                admin_id,
                payload.first_name.trim(),
                payload.last_name.trim(),
                payload.admin_phone.trim(),
                password_hash,
                payload.admin_phone.trim().to_ascii_lowercase(),
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO sync_outbox (event_id, entity, record_id, operation, payload_json)
             VALUES (?1, 'company_info', ?2, 'upsert', ?3)",
            params![event_id, company_id, payload_json],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn open_matching_database(
    database_path: &Path,
    payload: &CreateDatabasePayload,
) -> Result<CreateDatabaseResult, String> {
    let already_exists = "database_already_exists";
    let connection = Connection::open(database_path).map_err(|_| already_exists.to_string())?;
    let administrator = connection
        .query_row(
            "SELECT first_name, last_name, password_hash
         FROM admin_users WHERE phone_number = ?1",
            [payload.admin_phone.trim()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| already_exists.to_string())?;
    let password_hash =
        PasswordHash::new(&administrator.2).map_err(|_| already_exists.to_string())?;
    Argon2::default()
        .verify_password(payload.password.as_bytes(), &password_hash)
        .map_err(|_| already_exists.to_string())?;

    let matching_company_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM company_info WHERE company_name = ?1)",
            [payload.company_name.trim()],
            |row| row.get(0),
        )
        .map_err(|_| already_exists.to_string())?;
    if !matching_company_exists {
        return Err(already_exists.to_string());
    }

    Ok(CreateDatabaseResult {
        database_name: payload.database_name.trim().to_string(),
        database_path: database_path.to_string_lossy().into_owned(),
        administrator_name: format!("{} {}", administrator.0, administrator.1),
        user: None,
    })
}

fn create_local_database(payload: CreateDatabasePayload) -> Result<CreateDatabaseResult, String> {
    validate_payload(&payload)?;

    let folder = fs::canonicalize(&payload.db_path).map_err(|error| error.to_string())?;
    if !folder.is_dir() {
        return Err("Selected database location is not a folder".to_string());
    }

    let file_name = database_file_name(&payload.database_name)?;
    let database_path: PathBuf = folder.join(&file_name);
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&database_path)
    {
        Ok(file) => drop(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return open_matching_database(&database_path, &payload);
        }
        Err(error) => return Err(error.to_string()),
    }

    let salt =
        SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|error| error.to_string())?;
    let password_hash = Argon2::default()
        .hash_password(payload.password.as_bytes(), &salt)
        .map_err(|error| error.to_string())?
        .to_string();

    if let Err(error) = initialize_database(&database_path, &payload, &password_hash) {
        let _ = fs::remove_file(&database_path);
        let _ = fs::remove_file(database_path.with_extension("sqlite3-wal"));
        let _ = fs::remove_file(database_path.with_extension("sqlite3-shm"));
        return Err(error);
    }

    Ok(CreateDatabaseResult {
        database_name: payload.database_name.trim().to_string(),
        database_path: database_path.to_string_lossy().into_owned(),
        administrator_name: format!("{} {}", payload.first_name.trim(), payload.last_name.trim()),
        user: None,
    })
}

fn database_registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    Ok(app_data_dir.join("local-databases.json"))
}

fn read_database_registry(app: &AppHandle) -> Result<DatabaseRegistry, String> {
    let registry_path = database_registry_path(app)?;
    match fs::read_to_string(registry_path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DatabaseRegistry::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn write_database_registry(app: &AppHandle, registry: &DatabaseRegistry) -> Result<(), String> {
    let registry_path = database_registry_path(app)?;
    let contents = serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?;
    fs::write(registry_path, contents).map_err(|error| error.to_string())
}

fn register_database(
    app: &AppHandle,
    database: LocalDatabaseSummary,
) -> Result<LocalDatabaseSummary, String> {
    let canonical_path = fs::canonicalize(&database.database_path)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    let database = LocalDatabaseSummary {
        database_path: canonical_path.clone(),
        ..database
    };
    let mut registry = read_database_registry(app)?;
    registry
        .databases
        .retain(|entry| entry.database_path != canonical_path);
    registry.databases.push(database.clone());
    write_database_registry(app, &registry)?;
    Ok(database)
}

fn summarize_existing_database(database_path: &Path) -> Result<LocalDatabaseSummary, String> {
    let canonical_path = fs::canonicalize(database_path).map_err(|error| error.to_string())?;
    if !canonical_path.is_file() {
        return Err("database_file_not_found".to_string());
    }
    let connection =
        Connection::open(&canonical_path).map_err(|_| "invalid_database_file".to_string())?;
    let company_name = connection
        .query_row(
            "SELECT company_name FROM company_info ORDER BY created_at LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "invalid_database_file".to_string())?;
    let administrator_name = connection
        .query_row(
            "SELECT first_name || ' ' || last_name FROM admin_users ORDER BY created_at LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "invalid_database_file".to_string())?;
    let database_name = canonical_path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid_database_file".to_string())?
        .to_string();

    Ok(LocalDatabaseSummary {
        database_name,
        database_path: canonical_path.to_string_lossy().into_owned(),
        company_name,
        administrator_name,
    })
}

fn authenticate_database(
    database_path: &Path,
    identifier: &str,
    password: &str,
) -> Result<CreateDatabaseResult, String> {
    let canonical_path =
        fs::canonicalize(database_path).map_err(|_| "invalid_credentials".to_string())?;
    let user = local_users::authenticate(canonical_path.to_str().ok_or("invalid_database_file")?, identifier, password)?;

    let database_name = canonical_path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid_database_file".to_string())?
        .to_string();
    Ok(CreateDatabaseResult {
        database_name,
        database_path: canonical_path.to_string_lossy().into_owned(),
        administrator_name: user["fullName"].as_str().unwrap_or("").to_owned(),
        user: Some(user),
    })
}

#[tauri::command]
fn create_local_database_command(
    app: AppHandle,
    window: tauri::WebviewWindow,
    mut payload: CreateDatabasePayload,
) -> Result<CreateDatabaseResult, String> {
    #[cfg(target_os="android")]
    {
        let folder=app.path().app_data_dir().map_err(|e|e.to_string())?.join("databases");
        fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
        payload.db_path=folder.to_string_lossy().into_owned();
    }
    let company_name = payload.company_name.trim().to_string();
    let identifier=payload.admin_phone.clone();let password=payload.password.clone();
    local_users::clear(window.label());
    let result = create_local_database(payload)?;
    register_database(
        &app,
        LocalDatabaseSummary {
            database_name: result.database_name.clone(),
            database_path: result.database_path.clone(),
            company_name,
            administrator_name: result.administrator_name.clone(),
        },
    )?;
    let session=authenticate_database(Path::new(&result.database_path),&identifier,&password)?;
    local_users::bind(window.label(),&session.database_path,session.user.as_ref().ok_or("invalid_credentials")?)?;
    Ok(session)
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct LocalStorageContext { platform: &'static str, database_directory: String }

#[tauri::command]
fn get_local_storage_context(app:AppHandle)->Result<LocalStorageContext,String>{
    let platform=if cfg!(target_os="android"){"android"}else if cfg!(target_os="windows"){"windows"}else{"desktop"};
    let folder=app.path().app_data_dir().map_err(|e|e.to_string())?.join("databases");
    if platform=="android" {fs::create_dir_all(&folder).map_err(|e|e.to_string())?;}
    Ok(LocalStorageContext{platform,database_directory:folder.to_string_lossy().into_owned()})
}

#[tauri::command]
fn list_local_databases(app: AppHandle) -> Result<Vec<LocalDatabaseSummary>, String> {
    let mut registry = read_database_registry(&app)?;
    registry
        .databases
        .retain(|database| Path::new(&database.database_path).is_file());
    write_database_registry(&app, &registry)?;
    Ok(registry.databases)
}

#[tauri::command]
fn register_existing_database(
    app: AppHandle,
    database_path: String,
) -> Result<LocalDatabaseSummary, String> {
    let summary = summarize_existing_database(Path::new(&database_path))?;
    register_database(&app, summary)
}

#[tauri::command]
fn authenticate_local_database(
    window: tauri::WebviewWindow,
    database_path: String,
    identifier: String,
    password: String,
) -> Result<CreateDatabaseResult, String> {
    local_users::clear(window.label());
    let result=authenticate_database(Path::new(&database_path), &identifier, &password)?;
    local_users::bind(window.label(),&result.database_path,result.user.as_ref().ok_or("invalid_credentials")?)?;
    Ok(result)
}

#[tauri::command]
async fn sign_in_to_api(
    app: AppHandle,
    database_path: String,
    identifier: String,
    password: String,
) -> Result<String, String> {
    let credentials = authenticate_database(Path::new(&database_path), &identifier, &password)?
        .administrator_name;

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/auth/login", api_base_url()))
        .json(&serde_json::json!({
            "organizationId": "",
            "phone": credentials,
            "password": password,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        let body = response
            .text()
            .await
            .map_err(|error| error.to_string())?;
        return Err(format!("API login failed: {}", body));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let token = body
        .get("token")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "API login response missing token".to_string())?;

    Ok(token.to_string())
}

#[tauri::command]
fn get_pending_sync_events(database_path: String) -> Result<Vec<SyncOutboxEntry>, String> {
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT event_id, entity, record_id, operation, payload_json
             FROM sync_outbox WHERE synced_at IS NULL ORDER BY id LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let payload_json: Option<String> = row.get(4)?;
            let data = payload_json
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;

            Ok(SyncOutboxEntry {
                event_id: row.get(0)?,
                entity: row.get(1)?,
                record_id: row.get(2)?,
                operation: row.get(3)?,
                data,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn mark_sync_events_completed(
    database_path: String,
    event_ids: Vec<String>,
) -> Result<usize, String> {
    let mut connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut updated = 0;

    for event_id in event_ids {
        updated += transaction
            .execute(
                "UPDATE sync_outbox SET synced_at = CURRENT_TIMESTAMP
                 WHERE event_id = ?1 AND synced_at IS NULL",
                [event_id],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(|invoke| {
            let checked=match invoke.message.payload(){tauri::ipc::InvokeBody::Json(args)=>local_users::authorize(invoke.message.webview_ref().label(),invoke.message.command(),args),_=>Err("permission_denied".to_string())};
            if let Err(error)=checked{invoke.resolver.reject(error);return true}
            if invoke.message.command()=="get_cash_register" {
                let result=match invoke.message.payload(){tauri::ipc::InvokeBody::Json(args)=>local_users::cash_snapshot(invoke.message.webview_ref().label(),args["databasePath"].as_str().unwrap_or("").to_owned()),_=>Err("invalid_request".into())};
                match result{Ok(data)=>invoke.resolver.resolve(data),Err(error)=>invoke.resolver.reject(error)};return true
            }
            let handler:fn(tauri::ipc::Invoke<tauri::Wry>)->bool=tauri::generate_handler![
            local_users::clear_local_session,
            local_users::get_local_current_user,
            local_users::list_local_users,
            local_users::save_local_user,
            local_users::delete_local_user,
            local_users::get_dashboard_data,
            create_local_database_command,
            get_local_storage_context,
            license::get_license_status,
            license::activate_license,
            list_local_databases,
            register_existing_database,
            authenticate_local_database,
            sign_in_to_api,
            list_medicine_formulas,
            create_medicine_formula,
            list_pharmaceutical_companies,
            create_pharmaceutical_company,
            update_pharmaceutical_company,
            delete_pharmaceutical_company,
            list_medicines,
            create_medicine,
            update_medicine,
            delete_medicine,
            list_purchases,
            get_purchase,
            get_company_purchase_account,
            create_purchase,
            record_purchase_payment,
            return_purchase,
            delete_purchase,
            list_customers,
            create_customer,
            update_customer,
            delete_customer,
            get_customer_account,
            record_customer_credit_settlement,
            get_company_info,
            list_sales,
            get_sale,
            create_sale,
            record_sale_payment,
            cancel_sale,
            delete_sale,
            import_medicines,
            save_excel_export,
            get_app_settings,
            save_app_settings,
            list_expiry_alerts,
            reports::get_reports_data,
            cash::get_cash_register,
            cash::save_cash_document,
            cash::delete_cash_document,
            cash::get_cash_document_history,
            get_pending_sync_events,
            mark_sync_events_completed
            ,backup_local_database
            ,restore_local_database
            ,cloud_sync::initialize_offline_database
            ,cloud_sync::get_offline_sync_status
            ,cloud_sync::sync_offline_database
            ,network::get_network_status
            ,network::start_network_server
            ,network::stop_network_server
        ];handler(invoke)
        })
        .on_window_event(|_, event| { if matches!(event, tauri::WindowEvent::Destroyed) { network::stop_owned_server(); } })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::password_hash::PasswordHash;

    fn test_payload(folder: &Path) -> CreateDatabasePayload {
        CreateDatabasePayload {
            first_name: "Amina".to_string(),
            last_name: "Example".to_string(),
            admin_phone: "+93700000000".to_string(),
            password: "test-password-123".to_string(),
            confirm_password: "test-password-123".to_string(),
            company_name: "Spice House".to_string(),
            company_address: "Main street".to_string(),
            office_phone: "+93711111111".to_string(),
            secondary_phone: String::new(),
            company_email: "hello@example.com".to_string(),
            database_name: "spice_shop".to_string(),
            db_path: folder.to_string_lossy().into_owned(),
        }
    }

    fn test_folder() -> PathBuf {
        let folder = std::env::temp_dir().join(format!("spice-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&folder).expect("create test folder");
        folder
    }

    #[test]
    fn validates_database_password_minimum_and_confirmation() {
        let folder = PathBuf::from("test-folder");
        let mut payload = test_payload(&folder);
        payload.password = "abc".to_string();
        payload.confirm_password = "abc".to_string();
        assert!(validate_payload(&payload).is_err());

        payload.password = "abcd".to_string();
        payload.confirm_password = "abcd".to_string();
        assert!(validate_payload(&payload).is_ok());

        payload.confirm_password = "abce".to_string();
        assert_eq!(validate_payload(&payload).unwrap_err(), "Passwords do not match");

        payload.confirm_password.clear();
        assert_eq!(validate_payload(&payload).unwrap_err(), "Passwords do not match");
    }

    #[test]
    fn creates_database_records_and_safe_outbox_event() {
        let folder = test_folder();
        let result = create_local_database(test_payload(&folder)).expect("create database");
        let connection = Connection::open(&result.database_path).expect("open database");

        let company_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM company_info", [], |row| row.get(0))
            .expect("count companies");
        let admin_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM admin_users", [], |row| row.get(0))
            .expect("count admins");
        let outbox_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
            .expect("count outbox events");
        let password_hash: String = connection
            .query_row("SELECT password_hash FROM admin_users LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("read password hash");
        let outbox_json: String = connection
            .query_row("SELECT payload_json FROM sync_outbox LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("read outbox event");

        assert_eq!((company_count, admin_count, outbox_count), (1, 1, 1));
        assert!(PasswordHash::new(&password_hash).is_ok());
        assert!(!outbox_json.contains("password"));

        let pending =
            get_pending_sync_events(result.database_path.clone()).expect("load pending sync event");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].entity, "company_info");
        assert_eq!(
            mark_sync_events_completed(
                result.database_path.clone(),
                vec![pending[0].event_id.clone()],
            )
            .expect("acknowledge sync event"),
            1
        );
        assert!(get_pending_sync_events(result.database_path.clone())
            .expect("load pending events after acknowledgment")
            .is_empty());

        drop(connection);
        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn reopens_existing_database_for_matching_admin() {
        let folder = test_folder();
        let first = create_local_database(test_payload(&folder)).expect("create first database");
        let reopened = create_local_database(test_payload(&folder)).expect("reopen database");

        assert_eq!(first.database_path, reopened.database_path);
        assert_eq!(reopened.administrator_name, "Amina Example");

        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn refuses_existing_database_for_wrong_password() {
        let folder = test_folder();
        create_local_database(test_payload(&folder)).expect("create first database");
        let mut wrong_credentials = test_payload(&folder);
        wrong_credentials.password = "wrong-password-123".to_string();
        wrong_credentials.confirm_password = wrong_credentials.password.clone();

        let error = create_local_database(wrong_credentials).expect_err("wrong password must fail");
        assert_eq!(error, "database_already_exists");

        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn authenticates_database_by_phone_or_full_name() {
        let folder = test_folder();
        let created = create_local_database(test_payload(&folder)).expect("create database");

        let by_phone = authenticate_database(
            Path::new(&created.database_path),
            "+93700000000",
            "test-password-123",
        )
        .expect("authenticate by phone");
        let by_name = authenticate_database(
            Path::new(&created.database_path),
            "Amina Example",
            "test-password-123",
        )
        .expect("authenticate by full name");

        assert_eq!(by_phone.administrator_name, "Amina Example");
        assert_eq!(by_name.database_path, created.database_path);
        assert_eq!(
            authenticate_database(
                Path::new(&created.database_path),
                "Amina Example",
                "incorrect-password",
            )
            .expect_err("incorrect password must fail"),
            "invalid_credentials"
        );

        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn summarizes_valid_existing_database_for_import() {
        let folder = test_folder();
        let created = create_local_database(test_payload(&folder)).expect("create database");
        let summary = summarize_existing_database(Path::new(&created.database_path))
            .expect("summarize existing database");

        assert_eq!(summary.company_name, "Spice House");
        assert_eq!(summary.administrator_name, "Amina Example");
        assert_eq!(summary.database_name, "spice_shop");

        let unrelated_file = folder.join("not-a-database.sqlite3");
        fs::write(&unrelated_file, "not sqlite data").expect("write unrelated file");
        assert_eq!(
            summarize_existing_database(&unrelated_file)
                .expect_err("unrelated file should not import"),
            "invalid_database_file"
        );

        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn creates_and_lists_medicine_with_formula_company_and_price_basis() {
        let folder = test_folder();
        let database = create_local_database(test_payload(&folder)).expect("create database");
        let formula = create_medicine_formula(CreateFormulaPayload {
            database_path: database.database_path.clone(),
            name: "Paracetamol 500 mg".to_string(),
            indication: "Pain and fever".to_string(),
            side_effects: "Nausea".to_string(),
        })
        .expect("create formula");
        let company = create_pharmaceutical_company(CreateCompanyPayload {
            database_path: database.database_path.clone(),
            name: "Example Pharma".to_string(),
            country: "Afghanistan".to_string(),
            address: "Kabul".to_string(),
            email: "contact@example.test".to_string(),
            phone: "+93700000001".to_string(),
        })
        .expect("create pharmaceutical company");

        let medicine = create_medicine(CreateMedicinePayload {
            database_path: database.database_path.clone(),
            name: "Paracetamol".to_string(),
            barcode: "1234567890123".to_string(),
            formula_id: formula.id,
            company_id: company.id,
            batch_number: String::new(),
            gauge_number: "20G".to_string(),
            units_per_pack: 20,
            purchase_price: 2.5,
            sale_price: 3.5,
            purchase_price_basis: "unit".to_string(),
        })
        .expect("create medicine");

        assert_eq!(medicine.name, "Paracetamol");
        assert_eq!(medicine.barcode, "1234567890123");
        assert_eq!(medicine.formula_name, "Paracetamol 500 mg");
        assert_eq!(medicine.company_name, "Example Pharma");
        assert_eq!(medicine.units_per_pack, 20);
        assert_eq!(medicine.purchase_price_basis, "unit");
        assert_eq!(
            list_medicines(database.database_path.clone())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_medicine_formulas(database.database_path.clone())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_pharmaceutical_companies(database.database_path.clone())
                .unwrap()
                .len(),
            1
        );

        let connection = Connection::open(&database.database_path).expect("open local database");
        let queued_events: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
            .expect("count queued events");
        assert_eq!(queued_events, 4);

        drop(connection);
        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn creates_purchase_atomically_calculates_totals_and_queues_sync() {
        let folder = test_folder();
        let database = create_local_database(test_payload(&folder)).expect("create database");
        let formula = create_medicine_formula(CreateFormulaPayload {
            database_path: database.database_path.clone(),
            name: "Test formula".to_string(), indication: "Test indication".to_string(), side_effects: String::new(),
        }).expect("create formula");
        let company = create_pharmaceutical_company(CreateCompanyPayload {
            database_path: database.database_path.clone(), name: "Test supplier".to_string(),
            country: "Afghanistan".to_string(), address: String::new(), email: String::new(), phone: String::new(),
        }).expect("create company");
        let medicine = create_medicine(CreateMedicinePayload {
            database_path: database.database_path.clone(), name: "Test medicine".to_string(), barcode: String::new(),
            formula_id: formula.id, company_id: company.id.clone(), batch_number: String::new(), gauge_number: String::new(),
            units_per_pack: 10, purchase_price: 2.5, sale_price: 3.0, purchase_price_basis: "unit".to_string(),
        }).expect("create medicine");

        let purchase = create_purchase(CreatePurchasePayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), company_id: Some(company.id.clone()),
            invoice_number: "INV-100".to_string(), purchase_date: "2026-10-19".to_string(),
            discount: 0.65, paid_amount: 5.0, notes: "Partial payment".to_string(),
            items: vec![CreatePurchaseItemPayload {
                medicine_id: medicine.id, quantity: 3, unit_type: "unit".to_string(), unit_price: 2.55,
                sale_price: 4.0, expiry_date: "2030-01-01".to_string(),
            }],
        }).expect("create purchase");

        assert_eq!(purchase.subtotal, 7.65);
        assert_eq!(purchase.total, 7.0);
        assert_eq!(purchase.remaining_amount, 2.0);
        assert_eq!(purchase.status, "partial");
        assert_eq!(purchase.purchase_date_solar, "1405-07-27");
        assert_eq!(purchase.items.len(), 1);
        assert_eq!(purchase.items[0].line_total, 7.65);
        let report_data = reports::get_reports_data(database.database_path.clone()).expect("read report snapshot");
        assert_eq!(report_data["purchases"][0]["id"], purchase.id);
        assert_eq!(report_data["purchaseItems"][0]["expiry_date"], "2030-01-01");
        let unit_cost = report_data["batches"][0]["unit_cost"].as_f64().unwrap();
        assert!((unit_cost - 7.0 / 3.0).abs() < 0.000001);
        assert!(!report_data.to_string().contains("password"));
        assert_eq!(report_data["source"], "sqlite");
        let sync_count: i64 = Connection::open(&database.database_path).unwrap().query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0)).unwrap();
        reports::get_reports_data(database.database_path.clone()).expect("repeat report snapshot");
        let repeated_count: i64 = Connection::open(&database.database_path).unwrap().query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0)).unwrap();
        assert_eq!(sync_count, repeated_count, "report reads must not queue duplicate financial events");
        assert_eq!(list_purchases(database.database_path.clone()).unwrap().len(), 1);
        let company_account = get_company_purchase_account(database.database_path.clone(), company.id.clone()).unwrap();
        assert_eq!(company_account.total_purchases, 7.0);
        assert_eq!(company_account.total_paid, 5.0);
        assert_eq!(company_account.amount_owed, 2.0);
        assert_eq!(company_account.purchases[0].company_id.as_deref(), Some(company.id.as_str()));
        assert_eq!(company_account.payments.len(), 1);
        let pending = get_pending_sync_events(database.database_path.clone()).unwrap();
        let purchase_event = pending.iter().find(|event| event.entity == "purchases").expect("purchase sync event");
        assert_eq!(purchase_event.data.as_ref().unwrap()["total"], 7.0);

        let settled = record_purchase_payment(RecordPurchasePaymentPayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), purchase_id: purchase.id.clone(),
            amount: 2.0, payment_date: "2026-10-20".to_string(), notes: "Paid in full".to_string(),
        }).expect("record settlement");
        assert_eq!(settled.paid_amount, 7.0);
        assert_eq!(settled.remaining_amount, 0.0);
        assert_eq!(settled.status, "paid");
        assert_eq!(settled.payments.len(), 2);
        assert_eq!(settled.payments[1].payment_date_solar, "1405-07-28");
        assert_eq!(get_company_purchase_account(database.database_path.clone(), company.id.clone()).unwrap().payments.len(), 2);
        let overpayment = record_purchase_payment(RecordPurchasePaymentPayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), purchase_id: purchase.id.clone(),
            amount: 0.01, payment_date: "2026-10-20".to_string(), notes: String::new(),
        }).expect_err("overpayment must be rejected");
        assert_eq!(overpayment, "purchase_payment_exceeds_remaining");

        let invalid_purchase = create_purchase(CreatePurchasePayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), company_id: Some(company.id.clone()), invoice_number: String::new(),
            purchase_date: "2026-10-19".to_string(), discount: 0.0, paid_amount: 0.0, notes: String::new(),
            items: vec![CreatePurchaseItemPayload {
                medicine_id: purchase.items[0].medicine_id.clone(), quantity: 0,
                unit_type: "unit".to_string(), unit_price: 1.0,
                sale_price: 2.0, expiry_date: "2030-01-01".to_string(),
            }],
        }).expect_err("zero quantity must be rejected");
        assert_eq!(invalid_purchase, "purchase_invalid_item");
        assert_eq!(list_purchases(database.database_path.clone()).unwrap().len(), 1);

        let return_without_supplier = create_purchase(CreatePurchasePayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), company_id: None, invoice_number: String::new(),
            purchase_date: "2026-10-19".to_string(), discount: 0.0, paid_amount: 0.0, notes: String::new(),
            items: vec![CreatePurchaseItemPayload { medicine_id: purchase.items[0].medicine_id.clone(), quantity: 1, unit_type: "unit".to_string(), unit_price: 1.0, sale_price: 2.0, expiry_date: "2030-01-01".to_string() }],
        }).expect_err("supplier is required");
        assert_eq!(return_without_supplier, "purchase_company_required");
        let returned = return_purchase(ReturnPurchasePayload {
            database_path: database.database_path.clone(), purchase_id: purchase.id.clone(), notes: "Returned to supplier".to_string(),
        }).expect("return purchase");
        assert_eq!(returned.status, "returned");
        assert_eq!(returned.remaining_amount, 0.0);
        assert_eq!(list_medicines(database.database_path.clone()).unwrap()[0].stock_quantity, 0);
        let company_after_return = get_company_purchase_account(database.database_path.clone(), company.id.clone()).unwrap();
        assert_eq!(company_after_return.total_purchases, 0.0);
        assert_eq!(company_after_return.total_paid, 0.0);
        assert_eq!(company_after_return.amount_owed, 0.0);
        assert_eq!(company_after_return.supplier_credit, 7.0);
        assert_eq!(return_purchase(ReturnPurchasePayload {
            database_path: database.database_path.clone(), purchase_id: purchase.id, notes: String::new(),
        }).unwrap_err(), "purchase_already_returned");

        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn creates_sale_tracks_stock_payments_and_invoice_reversal() {
        let folder = test_folder();
        let database = create_local_database(test_payload(&folder)).expect("create database");
        let formula = create_medicine_formula(CreateFormulaPayload {
            database_path: database.database_path.clone(), name: "Test formula".to_string(),
            indication: "Test indication".to_string(), side_effects: String::new(),
        }).expect("create formula");
        let company = create_pharmaceutical_company(CreateCompanyPayload {
            database_path: database.database_path.clone(), name: "Test company".to_string(),
            country: "Afghanistan".to_string(), address: String::new(), email: String::new(), phone: String::new(),
        }).expect("create company");
        let medicine = create_medicine(CreateMedicinePayload {
            database_path: database.database_path.clone(), name: "Test medicine".to_string(),
            barcode: "SALE-001".to_string(), formula_id: formula.id, company_id: company.id.clone(),
            batch_number: String::new(), gauge_number: String::new(), units_per_pack: 10,
            purchase_price: 2.0, sale_price: 4.0, purchase_price_basis: "unit".to_string(),
        }).expect("create medicine");
        create_purchase(CreatePurchasePayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), company_id: Some(company.id.clone()), invoice_number: String::new(),
            purchase_date: "2026-10-19".to_string(), discount: 0.0, paid_amount: 0.0,
            notes: String::new(), items: vec![CreatePurchaseItemPayload {
                medicine_id: medicine.id.clone(), quantity: 2, unit_type: "pack".to_string(), unit_price: 20.0,
                sale_price: 4.0, expiry_date: "2030-01-01".to_string(),
            }],
        }).expect("stock purchase");
        let sale = create_sale(CreateSalePayload {
            database_path: database.database_path.clone(), customer_id: None,
            sale_datetime: "2026-10-20T12:30:00".to_string(), payment_method: "cash".to_string(),
            discount: 2.0, paid_amount: 5.0, notes: "Test sale".to_string(), items: vec![CreateSaleItemPayload {
                medicine_id: medicine.id.clone(), quantity: 1, unit_type: "pack".to_string(),
                unit_price: 40.0, discount: 1.0,
            }],
        }).expect("create sale");
        assert_eq!(sale.total, 37.0);
        assert_eq!(sale.remaining_amount, 32.0);
        assert_eq!(sale.sale_date_solar, "1405-07-28");
        assert_eq!(sale.items[0].line_total, 39.0);
        assert_eq!(list_medicines(database.database_path.clone()).unwrap()[0].stock_quantity, 10);
        let oversell = create_sale(CreateSalePayload {
            database_path: database.database_path.clone(), customer_id: None,
            sale_datetime: "2026-10-20T12:35:00".to_string(), payment_method: "cash".to_string(),
            discount: 0.0, paid_amount: 0.0, notes: String::new(), items: vec![CreateSaleItemPayload {
                medicine_id: medicine.id.clone(), quantity: 2, unit_type: "pack".to_string(),
                unit_price: 40.0, discount: 0.0,
            }],
        }).expect_err("overselling available stock must fail");
        assert_eq!(oversell, "sale_insufficient_stock");
        let collected = record_sale_payment(RecordSalePaymentPayload {
            database_path: database.database_path.clone(), sale_id: sale.id.clone(), amount: 32.0,
            payment_datetime: "2026-10-20T13:00:00".to_string(), payment_method: "card".to_string(), notes: String::new(),
        }).expect("collect balance");
        assert_eq!(collected.status, "paid");
        assert_eq!(collected.payments.len(), 2);
        let reversed = cancel_sale(database.database_path.clone(), sale.id.clone()).expect("reverse sale");
        assert_eq!(reversed.status, "returned");
        assert_eq!(reversed.paid_amount, 0.0);
        assert_eq!(reversed.remaining_amount, 0.0);
        assert_eq!(reversed.payments.last().unwrap().payment_type, "refund");
        assert_eq!(list_medicines(database.database_path.clone()).unwrap()[0].stock_quantity, 20);
        create_purchase(CreatePurchasePayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), company_id: Some(company.id.clone()), invoice_number: "EXPIRED".to_string(),
            purchase_date: "2026-10-20".to_string(), discount: 0.0, paid_amount: 0.0, notes: String::new(),
            items: vec![CreatePurchaseItemPayload { medicine_id: medicine.id.clone(), quantity: 1, unit_type: "unit".to_string(), unit_price: 1.0, sale_price: 2.0, expiry_date: "2020-01-01".to_string() }],
        }).expect("record expired lot");
        let expired_only_sale = create_sale(CreateSalePayload {
            database_path: database.database_path.clone(), customer_id: None,
            sale_datetime: "2026-10-20T14:00:00".to_string(), payment_method: "cash".to_string(), discount: 0.0,
            paid_amount: 0.0, notes: String::new(), items: vec![CreateSaleItemPayload { medicine_id: medicine.id.clone(), quantity: 21, unit_type: "unit".to_string(), unit_price: 1.0, discount: 0.0 }],
        }).expect_err("expired stock must not be sold");
        assert_eq!(expired_only_sale, "sale_insufficient_unexpired_stock");
        assert_eq!(list_expiry_alerts(database.database_path.clone()).unwrap().len(), 1);
        let saved = save_app_settings(SaveAppSettingsPayload { database_path: database.database_path.clone(), usd_to_afn_rate: 71.5, expiry_alert_value: 2, expiry_alert_unit: "months".to_string() }).expect("save settings");
        assert_eq!(saved.usd_to_afn_rate, 71.5);
        assert_eq!(get_app_settings(database.database_path.clone()).unwrap().expiry_alert_unit, "months");
        let duplicate = cancel_sale(database.database_path.clone(), sale.id).expect_err("duplicate reversal rejected");
        assert_eq!(duplicate, "sale_already_reversed");
        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn customer_account_tracks_receipts_credit_application_and_sale_history() {
        let folder = test_folder();
        let database = create_local_database(test_payload(&folder)).expect("create database");
        let customer = create_customer(CreateCustomerPayload {
            database_path: database.database_path.clone(), name: "Sara".to_string(),
            surname: "Example".to_string(), phone: "0700000000".to_string(), address: "Kabul".to_string(),
        }).expect("create customer");
        assert_eq!(customer.name, "Sara");
        assert_eq!(customer.surname, "Example");
        let formula = create_medicine_formula(CreateFormulaPayload {
            database_path: database.database_path.clone(), name: "Test formula".to_string(),
            indication: "Test indication".to_string(), side_effects: String::new(),
        }).expect("create formula");
        let company = create_pharmaceutical_company(CreateCompanyPayload {
            database_path: database.database_path.clone(), name: "Test company".to_string(),
            country: "Afghanistan".to_string(), address: String::new(), email: String::new(), phone: String::new(),
        }).expect("create company");
        let medicine = create_medicine(CreateMedicinePayload {
            database_path: database.database_path.clone(), name: "Test medicine".to_string(),
            barcode: "CUST-001".to_string(), formula_id: formula.id, company_id: company.id.clone(),
            batch_number: String::new(), gauge_number: String::new(), units_per_pack: 1,
            purchase_price: 2.0, sale_price: 10.0, purchase_price_basis: "unit".to_string(),
        }).expect("create medicine");
        create_purchase(CreatePurchasePayload { payment_source: "other".into(),
            database_path: database.database_path.clone(), company_id: Some(company.id), invoice_number: String::new(),
            purchase_date: "2026-10-19".to_string(), discount: 0.0, paid_amount: 0.0,
            notes: String::new(), items: vec![CreatePurchaseItemPayload {
                medicine_id: medicine.id.clone(), quantity: 10, unit_type: "unit".to_string(), unit_price: 2.0,
                sale_price: 10.0, expiry_date: "2030-01-01".to_string(),
            }],
        }).expect("stock purchase");
        let first_sale = create_sale(CreateSalePayload {
            database_path: database.database_path.clone(), customer_id: Some(customer.id.clone()),
            sale_datetime: "2026-10-20T09:00:00".to_string(), payment_method: "cash".to_string(),
            discount: 0.0, paid_amount: 15.0, notes: String::new(), items: vec![CreateSaleItemPayload {
                medicine_id: medicine.id.clone(), quantity: 1, unit_type: "unit".to_string(), unit_price: 10.0, discount: 0.0,
            }],
        }).expect("create overpaid customer sale");
        assert_eq!(first_sale.paid_amount, 10.0);
        assert_eq!(first_sale.payments[0].amount, 15.0);
        let after_credit = get_customer_account(database.database_path.clone(), customer.id.clone()).expect("read customer account");
        assert_eq!(after_credit.customer.customer_credit, 5.0);
        assert_eq!(after_credit.customer.balance, -5.0);
        assert_eq!(after_credit.customer.total_received, 15.0);
        assert_eq!(after_credit.sales.len(), 1);
        let second_sale = create_sale(CreateSalePayload {
            database_path: database.database_path.clone(), customer_id: Some(customer.id.clone()),
            sale_datetime: "2026-10-20T10:00:00".to_string(), payment_method: "cash".to_string(),
            discount: 0.0, paid_amount: 0.0, notes: String::new(), items: vec![CreateSaleItemPayload {
                medicine_id: medicine.id.clone(), quantity: 1, unit_type: "unit".to_string(), unit_price: 8.0, discount: 0.0,
            }],
        }).expect("apply customer credit to sale");
        assert_eq!(second_sale.paid_amount, 5.0);
        assert_eq!(second_sale.remaining_amount, 3.0);
        assert_eq!(second_sale.payments[0].payment_type, "credit_applied");
        let updated_customer = update_customer(UpdateCustomerPayload {
            database_path: database.database_path.clone(), id: customer.id.clone(),
            name: "Sara".to_string(), surname: "Updated".to_string(), phone: "0700000001".to_string(), address: "Herat".to_string(),
        }).expect("update customer");
        assert_eq!(updated_customer.surname, "Updated");
        assert_eq!(updated_customer.balance, 3.0);
        assert_eq!(list_customers(database.database_path.clone()).unwrap().len(), 1);
        let settled = record_sale_payment(RecordSalePaymentPayload {
            database_path: database.database_path.clone(), sale_id: second_sale.id.clone(), amount: 5.0,
            payment_datetime: "2026-10-20T11:00:00".to_string(), payment_method: "cash".to_string(), notes: String::new(),
        }).expect("record payment with overage");
        assert_eq!(settled.paid_amount, 8.0);
        let reversed = cancel_sale(database.database_path.clone(), second_sale.id.clone()).expect("reverse second sale");
        assert_eq!(reversed.status, "returned");
        let final_account = get_customer_account(database.database_path.clone(), customer.id.clone()).expect("read final customer account");
        assert_eq!(final_account.customer.customer_credit, 10.0);
        assert_eq!(final_account.customer.balance, -10.0);
        assert!(final_account.credit_history.iter().any(|entry| entry.source_type == "sale_return"));
        assert_eq!(final_account.sales.len(), 2);
        let settled_credit = record_customer_credit_settlement(RecordCustomerCreditSettlementPayload {
            database_path: database.database_path.clone(), customer_id: final_account.customer.id.clone(),
            amount: 6.0, payment_datetime: "2026-10-20T12:00:00".to_string(),
            payment_method: "cash".to_string(), notes: "Partial credit settlement".to_string(),
        }).expect("settle customer credit");
        assert_eq!(settled_credit.customer.customer_credit, 4.0);
        assert_eq!(settled_credit.customer.balance, -4.0);
        assert!(settled_credit.payments.iter().any(|payment| payment.payment_type == "credit_settlement"));
        assert_eq!(settled_credit.customer.total_received, 14.0);
        delete_customer(database.database_path.clone(), customer.id.clone()).expect("archive customer");
        assert!(list_customers(database.database_path.clone()).unwrap().is_empty());
        assert_eq!(get_customer_account(database.database_path.clone(), customer.id.clone()).unwrap().sales.len(), 2);
        assert!(update_customer(UpdateCustomerPayload {
            database_path: database.database_path.clone(), id: customer.id.clone(), name: "Sara".to_string(),
            surname: "Updated".to_string(), phone: "0700000001".to_string(), address: "Herat".to_string(),
        }).is_err());
        fs::remove_dir_all(folder).expect("remove test folder");
    }

    #[test]
    fn imports_medicines_with_gauge_and_sale_price() {
        let folder = test_folder();
        let database = create_local_database(test_payload(&folder)).expect("create database");
        create_medicine_formula(CreateFormulaPayload {
            database_path: database.database_path.clone(),
            name: "Amoxicillin 500 mg".to_string(),
            indication: "Bacterial infection".to_string(),
            side_effects: "Rash".to_string(),
        })
        .expect("create formula");
        create_pharmaceutical_company(CreateCompanyPayload {
            database_path: database.database_path.clone(),
            name: "Example Pharma".to_string(),
            country: "Afghanistan".to_string(),
            address: "Kabul".to_string(),
            email: "contact@example.test".to_string(),
            phone: "+93700000001".to_string(),
        })
        .expect("create pharmaceutical company");

        let result = import_medicines(ImportMedicinesPayload {
            database_path: database.database_path.clone(),
            rows: vec![
                ImportMedicineRow {
                    name: "Amoxicillin".to_string(),
                    barcode: "9876543210123".to_string(),
                    batch_number: "B-001".to_string(),
                    gauge_number: "250 mg".to_string(),
                    formula_name: "Amoxicillin 500 mg".to_string(),
                    company_name: "Example Pharma".to_string(),
                    units_per_pack: 12,
                    purchase_price: 4.0,
                    sale_price: 6.5,
                    purchase_price_basis: "pack".to_string(),
                },
                ImportMedicineRow {
                    name: "".to_string(),
                    barcode: String::new(),
                    batch_number: String::new(),
                    gauge_number: String::new(),
                    formula_name: "Amoxicillin 500 mg".to_string(),
                    company_name: "Example Pharma".to_string(),
                    units_per_pack: 12,
                    purchase_price: 4.0,
                    sale_price: 6.5,
                    purchase_price_basis: "pack".to_string(),
                },
            ],
        })
        .expect("import medicines");

        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 1);

        let medicines = list_medicines(database.database_path.clone()).expect("list medicines");
        assert_eq!(medicines.len(), 1);
        assert_eq!(medicines[0].gauge_number, "250 mg");
        assert_eq!(medicines[0].sale_price, 6.5);
        assert_eq!(medicines[0].batch_number, "B-001");
        assert_eq!(medicines[0].barcode, "9876543210123");

        fs::remove_dir_all(folder).expect("remove test folder");
    }
}
