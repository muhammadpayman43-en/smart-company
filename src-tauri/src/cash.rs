use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    let exists: bool = connection.prepare("PRAGMA table_info(purchase_payments)").map_err(|e|e.to_string())?
        .query_map([], |r|r.get::<_,String>(1)).map_err(|e|e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?.iter().any(|c|c=="payment_source");
    if !exists { connection.execute_batch("ALTER TABLE purchase_payments ADD COLUMN payment_source TEXT NOT NULL DEFAULT 'unrecorded'").map_err(|e|e.to_string())?; }
    connection.execute_batch(include_str!("cash.sql")).map_err(|e|e.to_string())
}

pub(crate) fn other_source() -> String { "other".into() }
fn read_rate(connection: &Connection) -> Result<f64,String> {
    let rate:f64=connection.query_row("SELECT COALESCE((SELECT CAST(setting_value AS REAL) FROM app_settings WHERE setting_key='usd_to_afn_rate'),70)",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !rate.is_finite() || rate<=0.0 { return Err("settings_invalid_fields".into()); } Ok(rate)
}
pub(crate) fn validate_source(source: &str) -> Result<(), String> {
    if matches!(source,"cash"|"other") { Ok(()) } else { Err("cash_invalid_fields".into()) }
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct CashDocumentPayload {
    pub database_path: String, pub id: String, pub expected_revision: Option<i64>,
    pub kind: String, pub title: String, pub category: String, pub person: String,
    pub amount: f64, pub currency: String, pub date: String, pub payment_source: String, pub notes: String,
}

fn read_document(connection:&Connection,id:&str)->Result<Value,String> {
    let rows=super::reports::query_rows(connection,"SELECT * FROM cash_documents WHERE id=?1",[id])?;
    rows.as_array().unwrap().first().cloned().ok_or_else(||"cash_document_not_found".into())
}
fn audit(connection:&Connection, document:&Value)->Result<(),String> {
    connection.execute("INSERT INTO cash_document_history(id,document_id,revision,snapshot) VALUES(?1,?2,?3,?4)",
        params![Uuid::new_v4().to_string(),document["id"].as_str(),document["revision"].as_i64(),document.to_string()]).map_err(|e|e.to_string())?;
    super::queue_sync_event(connection,"expenses",document["id"].as_str().unwrap(),document.clone())
}

#[tauri::command]
pub(crate) fn save_cash_document(payload:CashDocumentPayload)->Result<Value,String> {
    validate_source(&payload.payment_source)?;
    if !Uuid::parse_str(&payload.id).is_ok() || !super::is_iso_purchase_date(&payload.date)
        || !payload.amount.is_finite() || super::round_money(payload.amount)<=0.0
        || !matches!(payload.currency.as_str(),"AFN"|"USD") || payload.title.trim().is_empty()
        || payload.title.len()>300 || payload.person.len()>300 || payload.notes.len()>4000
        || !matches!(payload.kind.as_str(),"EXPENSE"|"WITHDRAWAL"|"DEPOSIT")
        || (payload.kind=="WITHDRAWAL" && payload.person.trim().is_empty())
        || (payload.kind=="EXPENSE" && !matches!(payload.category.as_str(),"rent"|"salary"|"electricity"|"transport"|"services"|"misc"))
        || (payload.kind=="DEPOSIT" && payload.payment_source!="cash") { return Err("cash_invalid_fields".into()); }
    let connection=super::open_product_database(&payload.database_path)?;
    let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let deleted:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM cash_documents WHERE id=?1 AND deleted_at IS NOT NULL)",[&payload.id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if deleted {return Err("cash_revision_conflict".into());}
    let existing:Option<(i64,String,String,f64)>=tx.query_row("SELECT revision,kind,currency,exchange_rate FROM cash_documents WHERE id=?1 AND deleted_at IS NULL",[&payload.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
    let revision=match (&existing,payload.expected_revision) {
        (None,None)=>1,
        (Some((rev,kind,_,_)),Some(expected)) if *rev==expected && kind==&payload.kind=>rev+1,
        _=>return Err("cash_revision_conflict".into()),
    };
    // Preserve the original USD rate when editing an existing document in the same currency.
    let rate=if payload.currency=="AFN" {1.0} else if let Some((_,_,currency,rate))=&existing {
        if currency==&payload.currency {*rate} else {read_rate(&tx)?}
    } else {read_rate(&tx)?};
    let amount=super::round_money(payload.amount);
    let basis=super::round_money(amount*rate);
    if !basis.is_finite() || basis<=0.0 || basis>1e12 {return Err("cash_invalid_fields".into());}
    tx.execute("INSERT INTO cash_documents(id,kind,title,category,person,amount,currency,exchange_rate,amount_afn,date,payment_source,notes,revision)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,person=excluded.person,amount=excluded.amount,currency=excluded.currency,exchange_rate=excluded.exchange_rate,amount_afn=excluded.amount_afn,date=excluded.date,payment_source=excluded.payment_source,notes=excluded.notes,revision=excluded.revision,updated_at=CURRENT_TIMESTAMP",
        params![payload.id,payload.kind,payload.title.trim(),if payload.kind=="EXPENSE" {&payload.category} else {&payload.kind},payload.person.trim(),amount,payload.currency,rate,basis,payload.date,payload.payment_source,payload.notes.trim(),revision]).map_err(|e|e.to_string())?;
    if payload.payment_source=="cash" {
        tx.execute("INSERT INTO cash_transactions(id,date,direction,category,amount,currency,exchange_rate,amount_afn,source_type,source_id,description)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'cash_document',?9,?10)
            ON CONFLICT(source_type,source_id) DO UPDATE SET date=excluded.date,direction=excluded.direction,category=excluded.category,amount=excluded.amount,currency=excluded.currency,exchange_rate=excluded.exchange_rate,amount_afn=excluded.amount_afn,description=excluded.description,voided_at=NULL",
            params![format!("cash-{}",payload.id),payload.date,if payload.kind=="DEPOSIT" {"IN"} else {"OUT"},payload.kind,amount,payload.currency,rate,basis,payload.id,payload.title.trim()]).map_err(|e|e.to_string())?;
    } else {
        tx.execute("UPDATE cash_transactions SET voided_at=CURRENT_TIMESTAMP WHERE source_type='cash_document' AND source_id=?1 AND voided_at IS NULL",[&payload.id]).map_err(|e|e.to_string())?;
    }
    let document=read_document(&tx,&payload.id)?; audit(&tx,&document)?;
    tx.commit().map_err(|e|e.to_string())?; Ok(document)
}

#[tauri::command]
pub(crate) fn delete_cash_document(database_path:String,id:String,expected_revision:i64)->Result<(),String> {
    let connection=super::open_product_database(&database_path)?;
    let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let changed=tx.execute("UPDATE cash_documents SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?1 AND revision=?2 AND deleted_at IS NULL",params![id,expected_revision]).map_err(|e|e.to_string())?;
    if changed!=1 {return Err("cash_revision_conflict".into());}
    tx.execute("UPDATE cash_transactions SET voided_at=CURRENT_TIMESTAMP WHERE source_type='cash_document' AND source_id=?1 AND voided_at IS NULL",[&id]).map_err(|e|e.to_string())?;
    audit(&tx,&read_document(&tx,&id)?)?; tx.commit().map_err(|e|e.to_string())
}

#[tauri::command]
pub(crate) fn get_cash_register(database_path:String)->Result<Value,String> {
    let connection=super::open_product_database(&database_path)?;
    let tx=connection.transaction().map_err(|e|e.to_string())?;
    let result=json!({"documents":super::reports::rows(&tx,"SELECT * FROM cash_documents WHERE deleted_at IS NULL ORDER BY date DESC,created_at DESC")?,
        "transactions":super::reports::rows(&tx,"SELECT ct.*,
            CASE ct.source_type WHEN 'sale_payment' THEN sp.sale_id WHEN 'purchase_payment' THEN pp.purchase_id WHEN 'customer_refund' THEN cs.customer_id END AS source_document_id
            FROM cash_transactions ct
            LEFT JOIN sale_payments sp ON ct.source_type='sale_payment' AND sp.id=ct.source_id
            LEFT JOIN purchase_payments pp ON ct.source_type='purchase_payment' AND pp.id=ct.source_id
            LEFT JOIN customer_credit_settlements cs ON ct.source_type='customer_refund' AND cs.id=ct.source_id
            WHERE ct.voided_at IS NULL ORDER BY ct.date,ct.created_at,ct.rowid")?,
        "rate":read_rate(&tx)?});
    tx.commit().map_err(|e|e.to_string())?; Ok(result)
}

#[tauri::command]
pub(crate) fn get_cash_document_history(database_path:String,id:String)->Result<Value,String> {
    let connection=super::open_product_database(&database_path)?;
    let mut statement=connection.prepare("SELECT snapshot FROM cash_document_history WHERE document_id=?1 ORDER BY revision DESC").map_err(|e|e.to_string())?;
    let snapshots=statement.query_map([id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(Value::Array(snapshots.iter().map(|s|serde_json::from_str(s).unwrap_or(Value::Null)).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;

    struct Database { folder:std::path::PathBuf, path:String }
    impl Database {
        fn new()->Self {
            let folder=std::env::temp_dir().join(format!("cash-test-{}",Uuid::new_v4()));
            std::fs::create_dir_all(&folder).unwrap();
            let path=folder.join("cash.sqlite").to_string_lossy().to_string();
            Connection::open(&path).unwrap().execute_batch(include_str!("schema.sql")).unwrap();
            open_product_database(&path).unwrap(); Self{folder,path}
        }
        fn balance(&self)->f64 {
            let connection=open_product_database(&self.path).unwrap();
            connection.query_row("SELECT ROUND(COALESCE(SUM(CASE WHEN direction='IN' THEN amount_afn ELSE -amount_afn END),0),2) FROM cash_transactions WHERE voided_at IS NULL",[],|r|r.get(0)).unwrap()
        }
        fn document(&self,kind:&str,amount:f64,source:&str)->CashDocumentPayload {
            CashDocumentPayload{database_path:self.path.clone(),id:Uuid::new_v4().to_string(),expected_revision:None,kind:kind.into(),title:"Office".into(),category:"rent".into(),person:"Owner".into(),amount,currency:"AFN".into(),date:"2026-10-20".into(),payment_source:source.into(),notes:String::new()}
        }
        fn seed(&self)->(String,String,String) {
            let company=create_pharmaceutical_company(CreateCompanyPayload{database_path:self.path.clone(),name:"Supplier".into(),country:"AF".into(),address:String::new(),email:String::new(),phone:String::new()}).unwrap();
            let formula=create_medicine_formula(CreateFormulaPayload{database_path:self.path.clone(),name:"Formula".into(),indication:"Indication".into(),side_effects:String::new()}).unwrap();
            let medicine=create_medicine(CreateMedicinePayload{database_path:self.path.clone(),name:"Medicine".into(),barcode:String::new(),formula_id:formula.id,company_id:company.id.clone(),batch_number:String::new(),gauge_number:String::new(),units_per_pack:1,purchase_price:0.0,sale_price:0.0,purchase_price_basis:"unit".into()}).unwrap();
            let purchase=self.purchase(&company.id,&medicine.id,20,1000.0,0.0,"other").unwrap();
            (company.id,medicine.id,purchase.id)
        }
        fn purchase(&self,company:&str,medicine:&str,qty:i64,price:f64,paid:f64,source:&str)->Result<PurchaseDetails,String> {
            create_purchase(CreatePurchasePayload{database_path:self.path.clone(),payment_source:source.into(),company_id:Some(company.into()),invoice_number:Uuid::new_v4().to_string(),purchase_date:"2026-10-20".into(),discount:0.0,paid_amount:paid,notes:String::new(),items:vec![CreatePurchaseItemPayload{medicine_id:medicine.into(),quantity:qty,unit_type:"unit".into(),unit_price:price,sale_price:price+100.0,expiry_date:"2099-01-01".into()}]})
        }
        fn sale(&self,medicine:&str,customer:Option<String>,price:f64,paid:f64,method:&str)->SaleDetails {
            create_sale(CreateSalePayload{database_path:self.path.clone(),customer_id:customer,sale_datetime:"2026-10-20T10:00:00".into(),payment_method:method.into(),discount:0.0,paid_amount:paid,notes:String::new(),items:vec![CreateSaleItemPayload{medicine_id:medicine.into(),quantity:1,unit_type:"unit".into(),unit_price:price,discount:0.0}]}).unwrap()
        }
    }
    impl Drop for Database {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.folder);}}

    #[test]
    fn actual_receipts_purchases_expenses_and_withdrawals_post_once_atomically() {
        let db=Database::new(); let (company,medicine,credit_purchase)=db.seed();
        assert_eq!(db.balance(),0.0);
        db.sale(&medicine,None,5000.0,5000.0,"cash"); assert_eq!(db.balance(),5000.0);
        let credit_sale=db.sale(&medicine,None,5000.0,0.0,"cash");assert_eq!(db.balance(),5000.0);
        record_sale_payment(RecordSalePaymentPayload{database_path:db.path.clone(),sale_id:credit_sale.id,amount:2000.0,payment_datetime:"2026-10-20T11:00:00".into(),payment_method:"cash".into(),notes:String::new()}).unwrap();assert_eq!(db.balance(),7000.0);
        let expense=save_cash_document(db.document("EXPENSE",500.0,"cash")).unwrap();assert_eq!(db.balance(),6500.0);
        let withdrawal=save_cash_document(db.document("WITHDRAWAL",1000.0,"cash")).unwrap();assert_eq!(db.balance(),5500.0);
        db.purchase(&company,&medicine,1,1500.0,1500.0,"cash").unwrap();assert_eq!(db.balance(),4000.0);
        record_purchase_payment(RecordPurchasePaymentPayload{database_path:db.path.clone(),payment_source:"cash".into(),purchase_id:credit_purchase,amount:500.0,payment_date:"2026-10-20".into(),notes:String::new()}).unwrap();assert_eq!(db.balance(),3500.0);
        db.sale(&medicine,None,1000.0,1000.0,"card");
        save_cash_document(db.document("EXPENSE",200.0,"other")).unwrap();assert_eq!(db.balance(),3500.0);
        let mut edited=db.document("EXPENSE",700.0,"cash");edited.id=expense["id"].as_str().unwrap().into();edited.expected_revision=Some(1);
        save_cash_document(edited).unwrap();assert_eq!(db.balance(),3300.0);
        delete_cash_document(db.path.clone(),expense["id"].as_str().unwrap().into(),2).unwrap();assert_eq!(db.balance(),4000.0);
        assert!(delete_cash_document(db.path.clone(),expense["id"].as_str().unwrap().into(),2).is_err());assert_eq!(db.balance(),4000.0);
        assert_eq!(get_cash_document_history(db.path.clone(),expense["id"].as_str().unwrap().into()).unwrap().as_array().unwrap().len(),3);
        let before=get_cash_register(db.path.clone()).unwrap();
        assert!(save_cash_document(db.document("WITHDRAWAL",5000.0,"cash")).unwrap_err().contains("cash_insufficient_balance"));
        assert_eq!(get_cash_register(db.path.clone()).unwrap(),before);
        let stock=list_medicines(db.path.clone()).unwrap()[0].stock_quantity;
        assert!(db.purchase(&company,&medicine,1,5000.0,5000.0,"cash").unwrap_err().contains("cash_insufficient_balance"));
        assert_eq!(list_medicines(db.path.clone()).unwrap()[0].stock_quantity,stock);
        let connection=open_product_database(&db.path).unwrap();
        let register=get_cash_register(db.path.clone()).unwrap();
        for row in register["transactions"].as_array().unwrap() {
            let sql=match row["source_type"].as_str().unwrap() {
                "sale_payment"=>"SELECT sale_id FROM sale_payments WHERE id=?1",
                "purchase_payment"=>"SELECT purchase_id FROM purchase_payments WHERE id=?1",
                _=>continue,
            };
            let source:String=connection.query_row(sql,[row["source_id"].as_str().unwrap()],|r|r.get(0)).unwrap();
            assert_eq!(row["source_document_id"],source);
        }
        let events=reports::rows(&connection,"SELECT event_id FROM sync_outbox WHERE entity='cash_transactions'").unwrap();
        assert!(!events.as_array().unwrap().is_empty());
        for event in events.as_array().unwrap(){Uuid::parse_str(event["event_id"].as_str().unwrap()).expect("sync event must have API-compatible UUID");}
        assert_eq!(withdrawal["kind"],"WITHDRAWAL");
    }

    #[test]
    fn deposits_keep_original_currency_and_rate_edits_voids_and_insufficient_funds_are_safe() {
        let db=Database::new();
        save_app_settings(SaveAppSettingsPayload{database_path:db.path.clone(),usd_to_afn_rate:70.0,expiry_alert_value:30,expiry_alert_unit:"days".into()}).unwrap();
        let mut deposit=db.document("DEPOSIT",10.0,"cash");deposit.currency="USD".into();let id=deposit.id.clone();
        let saved=save_cash_document(deposit).unwrap();assert_eq!(saved["amount"],10.0);assert_eq!(db.balance(),700.0);
        save_app_settings(SaveAppSettingsPayload{database_path:db.path.clone(),usd_to_afn_rate:80.0,expiry_alert_value:30,expiry_alert_unit:"days".into()}).unwrap();
        let mut edit=db.document("DEPOSIT",12.0,"cash");edit.currency="USD".into();edit.id=id.clone();edit.expected_revision=Some(1);
        assert_eq!(save_cash_document(edit).unwrap()["exchange_rate"],70.0);assert_eq!(db.balance(),840.0);
        let expense=save_cash_document(db.document("EXPENSE",500.0,"cash")).unwrap();assert_eq!(db.balance(),340.0);
        assert!(delete_cash_document(db.path.clone(),id.clone(),2).unwrap_err().contains("cash_insufficient_balance"));assert_eq!(db.balance(),340.0);
        let mut other=db.document("EXPENSE",500.0,"other");other.id=expense["id"].as_str().unwrap().into();other.expected_revision=Some(1);save_cash_document(other).unwrap();assert_eq!(db.balance(),840.0);
        delete_cash_document(db.path.clone(),id,2).unwrap();assert_eq!(db.balance(),0.0);
        assert!(save_cash_document(db.document("EXPENSE",0.001,"cash")).is_err());
    }

    #[test]
    fn customer_credit_is_not_cash_and_cash_refunds_are_recorded_once() {
        let db=Database::new();let (_,medicine,_)=db.seed();
        let customer=create_customer(CreateCustomerPayload{database_path:db.path.clone(),name:"Customer".into(),surname:String::new(),phone:String::new(),address:String::new()}).unwrap();
        db.sale(&medicine,Some(customer.id.clone()),5000.0,7000.0,"cash");assert_eq!(db.balance(),7000.0);
        let credit_sale=db.sale(&medicine,Some(customer.id.clone()),1000.0,0.0,"cash");assert_eq!(db.balance(),7000.0);
        cancel_sale(db.path.clone(),credit_sale.id).unwrap();assert_eq!(db.balance(),7000.0);
        record_customer_credit_settlement(RecordCustomerCreditSettlementPayload{database_path:db.path.clone(),customer_id:customer.id,amount:1000.0,payment_datetime:"2026-10-20T12:00:00".into(),payment_method:"cash".into(),notes:String::new()}).unwrap();assert_eq!(db.balance(),6000.0);
        let walk_in=db.sale(&medicine,None,500.0,200.0,"cash");assert_eq!(db.balance(),6200.0);
        record_sale_payment(RecordSalePaymentPayload{database_path:db.path.clone(),sale_id:walk_in.id.clone(),amount:300.0,payment_datetime:"2026-10-20T11:00:00".into(),payment_method:"bank".into(),notes:String::new()}).unwrap();
        cancel_sale(db.path.clone(),walk_in.id.clone()).unwrap();assert_eq!(db.balance(),6000.0);
        assert!(cancel_sale(db.path.clone(),walk_in.id).is_err());assert_eq!(db.balance(),6000.0);
        let register=get_cash_register(db.path.clone()).unwrap();
        let refund=register["transactions"].as_array().unwrap().iter().find(|r|r["source_type"]=="customer_refund").unwrap();
        assert!(refund["source_document_id"].as_str().is_some());
    }

    #[test]
    fn purchase_form_pack_unit_prices_expiry_validation_and_financial_effects() {
        let db=Database::new(); let (company,medicine,_)=db.seed();
        save_cash_document(db.document("DEPOSIT",1000.0,"cash")).unwrap();
        Connection::open(&db.path).unwrap().execute("UPDATE medicines SET units_per_pack=12 WHERE id=?1",[&medicine]).unwrap();
        let payload=json!({"databasePath":db.path,"companyId":company,"invoiceNumber":"FORM-TEST","purchaseDate":"2026-10-20","discount":1.10,"paidAmount":150.0,"paymentSource":"cash","notes":"Pack and unit purchase","items":[
            {"medicineId":medicine,"quantity":2,"unitType":"pack","unitPrice":120.55,"salePrice":150.75,"expiryDate":"2031-01-01"},
            {"medicineId":medicine,"quantity":3,"unitType":"unit","unitPrice":2.25,"salePrice":4.0,"expiryDate":"2032-02-29"}
        ]});
        let before=get_cash_register(db.path.clone()).unwrap();
        for (pointer,value) in [
            ("/items/0/expiryDate",json!("")),("/items/0/expiryDate",json!("2031-02-30")),
            ("/items/0/quantity",json!(0)),("/items/0/unitPrice",json!(-1)),("/items/0/salePrice",json!(-1)),
            ("/companyId",Value::Null),("/companyId",json!("missing")),("/paidAmount",json!(300)),
        ] {
            let mut invalid=payload.clone(); *invalid.pointer_mut(pointer).unwrap()=value;
            assert!(create_purchase(serde_json::from_value(invalid).unwrap()).is_err(),"reject {pointer}");
            assert_eq!(get_cash_register(db.path.clone()).unwrap(),before);
            assert_eq!(list_purchases(db.path.clone()).unwrap().len(),1);
            assert_eq!(list_medicines(db.path.clone()).unwrap()[0].stock_quantity,20);
        }
        let purchase=create_purchase(serde_json::from_value(payload).unwrap()).unwrap();
        assert_eq!(purchase.subtotal,247.85); assert_eq!(purchase.total,246.75);
        assert_eq!(purchase.paid_amount,150.0); assert_eq!(purchase.remaining_amount,96.75);
        assert_eq!(purchase.items[0].unit_type,"pack"); assert_eq!(purchase.items[0].sale_price,150.75);
        assert_eq!(purchase.items[1].expiry_date,"2032-02-29");
        assert_eq!(list_medicines(db.path.clone()).unwrap()[0].stock_quantity,47);
        assert_eq!(db.balance(),850.0);
        let account=get_company_purchase_account(db.path.clone(),company).unwrap();
        assert_eq!(account.total_purchases,20246.75); assert_eq!(account.total_paid,150.0);
        assert_eq!(account.amount_owed,20096.75);
        let connection=Connection::open(&db.path).unwrap();
        let (batches,quantity):(i64,i64)=connection.query_row("SELECT COUNT(*),SUM(quantity_remaining) FROM inventory_batches WHERE purchase_item_id IN (SELECT id FROM purchase_items WHERE purchase_id=?1)",[&purchase.id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!((batches,quantity),(2,27));
        let payments:i64=connection.query_row("SELECT COUNT(*) FROM purchase_payments WHERE purchase_id=?1",[&purchase.id],|r|r.get(0)).unwrap();assert_eq!(payments,1);
        let entries:i64=connection.query_row("SELECT COUNT(*) FROM cash_transactions WHERE source_type='purchase_payment' AND source_id IN (SELECT id FROM purchase_payments WHERE purchase_id=?1)",[&purchase.id],|r|r.get(0)).unwrap();assert_eq!(entries,1);
        for _ in 0..2 {get_purchase(db.path.clone(),purchase.id.clone()).unwrap();list_purchases(db.path.clone()).unwrap();}
        assert_eq!(get_cash_register(db.path.clone()).unwrap()["transactions"].as_array().unwrap().len(),2);
        assert_eq!(db.balance(),850.0);
    }

    #[test]
    fn migration_never_backfills_old_payments_or_reposts_new_ones() {
        let db=Database::new();let connection=Connection::open(&db.path).unwrap();
        connection.execute_batch("DROP TRIGGER cash_sale_payment; INSERT INTO sales(id,invoice_number,sale_datetime,subtotal,total,remaining_amount,status) VALUES('old','OLD','2026-01-01T10:00:00',100,100,0,'paid'); INSERT INTO sale_payments(id,sale_id,payment_datetime,amount,payment_method,payment_type) VALUES('old-payment','old','2026-01-01T10:00:00',100,'cash','receipt');").unwrap();
        ensure_schema(&connection).unwrap();assert_eq!(db.balance(),0.0);
        connection.execute("INSERT INTO sale_payments(id,sale_id,payment_datetime,amount,payment_method,payment_type) VALUES('new-payment','old','2026-10-20T10:00:00',50,'cash','receipt')",[]).unwrap();
        ensure_schema(&connection).unwrap();assert_eq!(db.balance(),50.0);
        assert!(connection.execute("INSERT INTO sale_payments(id,sale_id,payment_datetime,amount,payment_method,payment_type) VALUES('new-payment','old','2026-10-20T10:00:00',50,'cash','receipt')",[]).is_err());assert_eq!(db.balance(),50.0);
    }
}
