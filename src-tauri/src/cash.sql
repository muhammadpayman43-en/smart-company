-- Only new, explicitly classified cash payments are posted. Historical payments
-- remain untouched; opening money must be entered as a reviewed deposit.
CREATE TABLE IF NOT EXISTS cash_documents (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('EXPENSE','WITHDRAWAL','DEPOSIT')),
 title TEXT NOT NULL, category TEXT NOT NULL, person TEXT NOT NULL DEFAULT '',
 amount REAL NOT NULL CHECK(amount>0), currency TEXT NOT NULL CHECK(currency IN ('AFN','USD')),
 exchange_rate REAL NOT NULL CHECK(exchange_rate>0), amount_afn REAL NOT NULL CHECK(amount_afn>0),
 date TEXT NOT NULL, payment_source TEXT NOT NULL CHECK(payment_source IN ('cash','other')),
 notes TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS cash_documents_date ON cash_documents(kind,date);
CREATE TABLE IF NOT EXISTS cash_document_history (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES cash_documents(id), revision INTEGER NOT NULL,
 snapshot TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(document_id,revision)
);
CREATE TABLE IF NOT EXISTS cash_transactions (
 id TEXT PRIMARY KEY, date TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('IN','OUT')),
 category TEXT NOT NULL CHECK(category IN ('SALE','CUSTOMER_RECEIPT','PURCHASE','SUPPLIER_PAYMENT','EXPENSE','WITHDRAWAL','DEPOSIT','REFUND','ADJUSTMENT')),
 amount REAL NOT NULL CHECK(amount>0), currency TEXT NOT NULL CHECK(currency IN ('AFN','USD')),
 exchange_rate REAL NOT NULL CHECK(exchange_rate>0), amount_afn REAL NOT NULL CHECK(amount_afn>0),
 source_type TEXT NOT NULL, source_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, voided_at TEXT,
 UNIQUE(source_type,source_id)
);
CREATE INDEX IF NOT EXISTS cash_transactions_date ON cash_transactions(date);
CREATE TRIGGER IF NOT EXISTS cash_guard_insert BEFORE INSERT ON cash_transactions
 WHEN NEW.voided_at IS NULL AND NEW.direction='OUT' AND NOT EXISTS(SELECT 1 FROM cash_transactions WHERE source_type=NEW.source_type AND source_id=NEW.source_id) AND
 ROUND(COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount_afn ELSE -amount_afn END) FROM cash_transactions WHERE voided_at IS NULL),0)-NEW.amount_afn,2)<0
 BEGIN SELECT RAISE(ABORT,'cash_insufficient_balance'); END;
CREATE TRIGGER IF NOT EXISTS cash_guard_update BEFORE UPDATE ON cash_transactions
 WHEN ROUND(COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount_afn ELSE -amount_afn END) FROM cash_transactions WHERE voided_at IS NULL),0)
 - CASE WHEN OLD.voided_at IS NOT NULL THEN 0 WHEN OLD.direction='IN' THEN OLD.amount_afn ELSE -OLD.amount_afn END
 + CASE WHEN NEW.voided_at IS NOT NULL THEN 0 WHEN NEW.direction='IN' THEN NEW.amount_afn ELSE -NEW.amount_afn END,2)<0
 BEGIN SELECT RAISE(ABORT,'cash_insufficient_balance'); END;
CREATE TRIGGER IF NOT EXISTS cash_guard_delete BEFORE DELETE ON cash_transactions
 WHEN OLD.voided_at IS NULL AND OLD.direction='IN' AND
 ROUND(COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount_afn ELSE -amount_afn END) FROM cash_transactions WHERE voided_at IS NULL),0)-OLD.amount_afn,2)<0
 BEGIN SELECT RAISE(ABORT,'cash_insufficient_balance'); END;
CREATE TRIGGER IF NOT EXISTS cash_sync_insert AFTER INSERT ON cash_transactions BEGIN
 INSERT INTO sync_outbox(event_id,entity,record_id,operation,payload_json) VALUES((lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),'cash_transactions',NEW.id,'upsert',
 json_object('id',NEW.id,'date',NEW.date,'direction',NEW.direction,'category',NEW.category,'amount',NEW.amount,'currency',NEW.currency,'exchangeRate',NEW.exchange_rate,'amountAfn',NEW.amount_afn,'sourceType',NEW.source_type,'sourceId',NEW.source_id,'description',NEW.description,'voidedAt',NEW.voided_at));
 END;
CREATE TRIGGER IF NOT EXISTS cash_sync_update AFTER UPDATE ON cash_transactions BEGIN
 INSERT INTO sync_outbox(event_id,entity,record_id,operation,payload_json) VALUES((lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),'cash_transactions',NEW.id,'upsert',
 json_object('id',NEW.id,'date',NEW.date,'direction',NEW.direction,'category',NEW.category,'amount',NEW.amount,'currency',NEW.currency,'exchangeRate',NEW.exchange_rate,'amountAfn',NEW.amount_afn,'sourceType',NEW.source_type,'sourceId',NEW.source_id,'description',NEW.description,'voidedAt',NEW.voided_at));
 END;
CREATE TRIGGER IF NOT EXISTS cash_sale_payment AFTER INSERT ON sale_payments WHEN NEW.payment_method='cash' BEGIN
 INSERT INTO cash_transactions(id,date,direction,category,amount,currency,exchange_rate,amount_afn,source_type,source_id,description)
 VALUES((lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),NEW.payment_datetime,CASE WHEN NEW.payment_type='refund' THEN 'OUT' ELSE 'IN' END,
 CASE WHEN NEW.payment_type='refund' THEN 'REFUND' WHEN NEW.payment_datetime=(SELECT sale_datetime FROM sales WHERE id=NEW.sale_id) AND (SELECT COUNT(*) FROM sale_payments WHERE sale_id=NEW.sale_id)=1 THEN 'SALE' ELSE 'CUSTOMER_RECEIPT' END,
 NEW.amount,'AFN',1,NEW.amount,'sale_payment',NEW.id,(SELECT invoice_number FROM sales WHERE id=NEW.sale_id));
 END;
CREATE TRIGGER IF NOT EXISTS cash_supplier_payment AFTER INSERT ON purchase_payments WHEN NEW.payment_source='cash' BEGIN
 INSERT INTO cash_transactions(id,date,direction,category,amount,currency,exchange_rate,amount_afn,source_type,source_id,description)
 VALUES((lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),NEW.payment_date,'OUT',CASE WHEN NEW.payment_type='initial' THEN 'PURCHASE' ELSE 'SUPPLIER_PAYMENT' END,
 NEW.amount,'AFN',1,NEW.amount,'purchase_payment',NEW.id,(SELECT invoice_number FROM purchases WHERE id=NEW.purchase_id));
 END;
CREATE TRIGGER IF NOT EXISTS cash_customer_refund AFTER INSERT ON customer_credit_settlements WHEN NEW.payment_method='cash' BEGIN
 INSERT INTO cash_transactions(id,date,direction,category,amount,currency,exchange_rate,amount_afn,source_type,source_id,description)
 VALUES((lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),NEW.payment_datetime,'OUT','REFUND',NEW.amount,'AFN',1,NEW.amount,'customer_refund',NEW.id,NEW.notes);
 END;
