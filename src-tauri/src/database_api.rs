//! The HTTP API uses the same commands and connection as the desktop app.
//! Each remote write, its result, audit entry and revision commit together.
use super::*;
use serde_json::{json, Value};
use std::{cell::RefCell, io::{self, BufRead, Write}, ops::Deref, rc::Rc};

#[derive(Clone)]
pub(crate) struct SharedDatabase(Rc<Connection>);
impl SharedDatabase {
    pub fn new(connection: Connection) -> Self { Self(Rc::new(connection)) }
    pub fn transaction(&self) -> rusqlite::Result<BusinessTransaction> { self.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) }
    pub fn transaction_with_behavior(&self, behavior:rusqlite::TransactionBehavior) -> rusqlite::Result<BusinessTransaction> {
        let nested=!self.is_autocommit();
        let name=format!("business_{}",Uuid::new_v4().simple());
        let begin=if nested {format!("SAVEPOINT {name}")} else {format!("BEGIN {}",match behavior {rusqlite::TransactionBehavior::Deferred=>"DEFERRED",rusqlite::TransactionBehavior::Exclusive=>"EXCLUSIVE",_=>"IMMEDIATE"})};
        self.execute_batch(&begin)?;
        Ok(BusinessTransaction{connection:self.clone(),name,nested,finished:false})
    }
}
impl Deref for SharedDatabase { type Target=Connection; fn deref(&self)->&Connection {&self.0} }
pub(crate) struct BusinessTransaction { connection:SharedDatabase,name:String,nested:bool,finished:bool }
impl Deref for BusinessTransaction { type Target=Connection;fn deref(&self)->&Connection {&self.connection} }
impl BusinessTransaction {
    pub fn commit(mut self)->rusqlite::Result<()> {self.execute_batch(&if self.nested {format!("RELEASE {}",self.name)}else{"COMMIT".into()})?;self.finished=true;Ok(())}
    pub fn rollback(mut self)->rusqlite::Result<()> {self.undo()?;self.finished=true;Ok(())}
    fn undo(&self)->rusqlite::Result<()> {self.execute_batch(&if self.nested {format!("ROLLBACK TO {}; RELEASE {}",self.name,self.name)}else{"ROLLBACK".into()})}
}
impl Drop for BusinessTransaction { fn drop(&mut self) {if !self.finished {let _=self.undo();}} }

thread_local! {static REQUEST_DB:RefCell<Option<(String,SharedDatabase)>>=const {RefCell::new(None)};}
pub(crate) fn request_database(path:&str)->Result<Option<SharedDatabase>,String> {
    REQUEST_DB.with(|current| match current.borrow().as_ref() {
        Some((allowed,db)) if allowed==path=>Ok(Some(db.clone())),
        Some(_)=>Err("database_scope_violation".into()),None=>Ok(None),
    })
}
const API_SCHEMA:&str="
 CREATE TABLE IF NOT EXISTS api_requests (request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS api_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO api_state(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS api_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);";

fn field(args:&Value,key:&str)->Result<String,String> {args[key].as_str().map(str::to_owned).ok_or_else(||"invalid_request".into())}
fn dispatch(command:&str,mut args:Value,path:&str)->Result<Value,String> {
    if !args.is_object() {return Err("invalid_request".into());}
    args["databasePath"]=json!(path);
    if let Some(payload)=args.get_mut("payload") {if !payload.is_object(){return Err("invalid_request".into());}payload["databasePath"]=json!(path);}
    macro_rules! output {($call:expr)=>{serde_json::to_value($call?).map_err(|_|"serialization_failed".into())};}
    macro_rules! payload {($kind:ty)=>{serde_json::from_value::<$kind>(args["payload"].clone()).map_err(|_|"invalid_request".to_string())?};}
    let database=path.to_owned();
    match command {
        "list_medicine_formulas"=>output!(list_medicine_formulas(database)),
        "create_medicine_formula"=>output!(create_medicine_formula(payload!(CreateFormulaPayload))),
        "list_pharmaceutical_companies"=>output!(list_pharmaceutical_companies(database)),
        "create_pharmaceutical_company"=>output!(create_pharmaceutical_company(payload!(CreateCompanyPayload))),
        "update_pharmaceutical_company"=>output!(update_pharmaceutical_company(payload!(UpdateCompanyPayload))),
        "delete_pharmaceutical_company"=>output!(delete_pharmaceutical_company(database,field(&args,"companyId")?)),
        "get_company_purchase_account"=>output!(get_company_purchase_account(database,field(&args,"companyId")?)),
        "list_medicines"=>output!(list_medicines(database)),
        "create_medicine"=>output!(create_medicine(payload!(CreateMedicinePayload))),
        "update_medicine"=>output!(update_medicine(payload!(UpdateMedicinePayload))),
        "delete_medicine"=>output!(delete_medicine(database,field(&args,"medicineId")?)),
        "import_medicines"=>output!(import_medicines(payload!(ImportMedicinesPayload))),
        "list_purchases"=>output!(list_purchases(database)),
        "get_purchase"=>output!(get_purchase(database,field(&args,"purchaseId")?)),
        "create_purchase"=>output!(create_purchase(payload!(CreatePurchasePayload))),
        "record_purchase_payment"=>output!(record_purchase_payment(payload!(RecordPurchasePaymentPayload))),
        "return_purchase"=>output!(return_purchase(payload!(ReturnPurchasePayload))),
        "delete_purchase"=>output!(delete_purchase(database,field(&args,"purchaseId")?)),
        "list_sales"=>output!(list_sales(database)),
        "get_sale"=>output!(get_sale(database,field(&args,"saleId")?)),
        "create_sale"=>output!(create_sale(payload!(CreateSalePayload))),
        "record_sale_payment"=>output!(record_sale_payment(payload!(RecordSalePaymentPayload))),
        "cancel_sale"=>output!(cancel_sale(database,field(&args,"saleId")?)),
        "delete_sale"=>output!(delete_sale(database,field(&args,"saleId")?)),
        "list_customers"=>output!(list_customers(database)),
        "get_customer_account"=>output!(get_customer_account(database,field(&args,"customerId")?)),
        "create_customer"=>output!(create_customer(payload!(CreateCustomerPayload))),
        "update_customer"=>output!(update_customer(payload!(UpdateCustomerPayload))),
        "delete_customer"=>output!(delete_customer(database,field(&args,"customerId")?)),
        "record_customer_credit_settlement"=>output!(record_customer_credit_settlement(payload!(RecordCustomerCreditSettlementPayload))),
        "get_company_info"=>output!(get_company_info(database)),
        "get_app_settings"=>output!(get_app_settings(database)),
        "save_app_settings"=>output!(save_app_settings(payload!(SaveAppSettingsPayload))),
        "list_expiry_alerts"=>output!(list_expiry_alerts(database)),
        "get_reports_data"|"get_dashboard_data"=>reports::get_reports_data(database),
        "get_revision"=>{let db=open_product_database(&database)?;let revision:i64=db.query_row("SELECT revision FROM api_state WHERE id=1",[],|r|r.get(0)).map_err(|e|e.to_string())?;Ok(json!(revision))},
        "get_cash_register"=>cash::get_cash_register(database),
        "save_cash_document"=>cash::save_cash_document(payload!(cash::CashDocumentPayload)),
        "delete_cash_document"=>output!(cash::delete_cash_document(database,field(&args,"id")?,args["expectedRevision"].as_i64().ok_or("invalid_request")?)),
        "get_cash_document_history"=>cash::get_cash_document_history(database,field(&args,"id")?),
        _=>Err("unknown_command".into()),
    }
}

fn execute(db:&SharedDatabase,path:&str,request:&Value)->Result<Value,String> {
    let command=field(request,"command")?;
    let write=request["write"].as_bool().unwrap_or(false);
    let user=field(request,"userId")?;
    let transaction=db.transaction().map_err(|e|e.to_string())?;
    let request_id=request["requestId"].as_str().unwrap_or("");
    let fingerprint=request["fingerprint"].as_str().unwrap_or("");
    if write {
        Uuid::parse_str(request_id).map_err(|_|"request_id_required")?;
        let previous:Option<(String,String,String)>=db.query_row("SELECT user_id,fingerprint,result FROM api_requests WHERE request_id=?1",[request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        if let Some((owner,old_hash,result))=previous {
            if owner!=user||old_hash!=fingerprint {return Err("idempotency_conflict".into());}
            return serde_json::from_str(&result).map_err(|_|"serialization_failed".into());
        }
        if let Some(expected)=request["expectedRevision"].as_i64() {
            let actual:i64=db.query_row("SELECT revision FROM api_state WHERE id=1",[],|r|r.get(0)).map_err(|e|e.to_string())?;
            if expected!=actual {return Err("revision_conflict".into());}
        }
    }
    let result=dispatch(&command,request["args"].clone(),path)?;
    if write {
        db.execute("UPDATE api_state SET revision=revision+1 WHERE id=1",[]).map_err(|e|e.to_string())?;
        db.execute("INSERT INTO api_audit(id,user_id,action,request_id) VALUES(?1,?2,?3,?4)",params![Uuid::new_v4().to_string(),user,command,request_id]).map_err(|e|e.to_string())?;
    }
    let revision:i64=db.query_row("SELECT revision FROM api_state WHERE id=1",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let response=json!({"data":result,"revision":revision});
    if write {db.execute("INSERT INTO api_requests(request_id,user_id,fingerprint,result) VALUES(?1,?2,?3,?4)",params![request_id,user,fingerprint,response.to_string()]).map_err(|e|e.to_string())?;}
    transaction.commit().map_err(|e|e.to_string())?;
    Ok(response)
}

pub fn run_database_worker() {
    let path=match std::env::var("SPICE_DATABASE_PATH") {Ok(p)=>p,Err(_)=>return};
    let db=match open_product_database(&path) {Ok(db)=>db,Err(e)=>{eprintln!("Database worker: {e}");return;}};
    if let Err(e)=db.execute_batch(API_SCHEMA) {eprintln!("Database worker: {e}");return;}
    REQUEST_DB.with(|current|*current.borrow_mut()=Some((path.clone(),db.clone())));
    let mut stdout=io::BufWriter::new(io::stdout());
    for line in io::stdin().lock().lines() {
        let line=match line {Ok(line)=>line,Err(_)=>break};
        let response=match serde_json::from_str::<Value>(&line) {
            Ok(request)=>match execute(&db,&path,&request) {Ok(result)=>json!({"id":request["id"],"ok":true,"result":result}),Err(error)=>json!({"id":request["id"],"ok":false,"error":error})},
            Err(_)=>json!({"ok":false,"error":"invalid_request"}),
        };
        if writeln!(stdout,"{response}").and_then(|_|stdout.flush()).is_err() {break;}
    }
}

pub fn initialize_api_database() {
    let result=(|| {let mut input=String::new();io::stdin().read_line(&mut input).map_err(|e|e.to_string())?;let payload:CreateDatabasePayload=serde_json::from_str(&input).map_err(|_|"invalid_request")?;serde_json::to_value(create_local_database(payload)?).map_err(|e|e.to_string())})();
    println!("{}",match result {Ok(data)=>json!({"ok":true,"data":data}),Err(error)=>json!({"ok":false,"error":error})});
}
