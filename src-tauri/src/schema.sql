-- ========================================================
-- SPICE MANAGEMENT APP DATABASE SCHEMA
-- ========================================================

-- 1. جدول اطلاعات کمپنی (Company Info)
CREATE TABLE IF NOT EXISTS company_info (
    id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    company_address TEXT,
    office_phone TEXT NOT NULL,
    secondary_phone TEXT,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. جدول مشخصات آدمین / کاربران (Admin / Users)
CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone_number TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'viewer',
    username TEXT COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1,
    permissions_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    auth_version INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Offline-first change queue. Password hashes and user records are never queued.
CREATE TABLE IF NOT EXISTS sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    entity TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    synced_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
    ON sync_outbox(synced_at, id);

CREATE TABLE IF NOT EXISTS medicine_formulas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    indication TEXT NOT NULL,
    side_effects TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pharmaceutical_companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    country TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS medicines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    barcode TEXT NOT NULL DEFAULT '',
    formula_id TEXT NOT NULL REFERENCES medicine_formulas(id),
    company_id TEXT NOT NULL REFERENCES pharmaceutical_companies(id),
    batch_number TEXT NOT NULL DEFAULT '',
    gauge_number TEXT NOT NULL DEFAULT '',
    units_per_pack INTEGER NOT NULL CHECK (units_per_pack > 0),
    purchase_price REAL NOT NULL CHECK (purchase_price >= 0),
    sale_price REAL NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
    purchase_price_basis TEXT NOT NULL CHECK (purchase_price_basis IN ('pack', 'unit')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_medicines_formula ON medicines(formula_id);
CREATE INDEX IF NOT EXISTS idx_medicines_company ON medicines(company_id);

CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    company_id TEXT REFERENCES pharmaceutical_companies(id),
    company_name TEXT NOT NULL DEFAULT '',
    invoice_number TEXT NOT NULL DEFAULT '',
    purchase_date TEXT NOT NULL,
    purchase_date_solar TEXT NOT NULL DEFAULT '',
    subtotal REAL NOT NULL CHECK (subtotal >= 0),
    discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
    total REAL NOT NULL CHECK (total >= 0),
    paid_amount REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    remaining_amount REAL NOT NULL CHECK (remaining_amount >= 0),
    status TEXT NOT NULL CHECK (status IN ('paid', 'partial', 'unpaid')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_items (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    medicine_id TEXT NOT NULL,
    medicine_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_type TEXT NOT NULL CHECK (unit_type IN ('pack', 'unit')),
    units_per_pack INTEGER NOT NULL DEFAULT 1 CHECK (units_per_pack > 0),
    unit_price REAL NOT NULL CHECK (unit_price >= 0),
    sale_price REAL NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
    line_total REAL NOT NULL CHECK (line_total >= 0),
    expiry_date TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_payments (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    payment_date TEXT NOT NULL,
    payment_date_solar TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL CHECK (amount > 0),
    notes TEXT NOT NULL DEFAULT '',
    payment_type TEXT NOT NULL CHECK (payment_type IN ('initial', 'settlement')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_payments_purchase ON purchase_payments(purchase_id, created_at);

CREATE TABLE IF NOT EXISTS purchase_returns (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id),
    company_id TEXT NOT NULL REFERENCES pharmaceutical_companies(id),
    credit_amount REAL NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
    return_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_company ON purchase_returns(company_id, return_date);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    surname TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS customer_credit_entries (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('receipt_overpayment', 'sale_return')),
    source_id TEXT NOT NULL,
    amount REAL NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_credits_customer ON customer_credit_entries(customer_id, created_at);

CREATE TABLE IF NOT EXISTS customer_credit_applications (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    sale_id TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sale_id)
);

CREATE TABLE IF NOT EXISTS customer_credit_settlements (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    payment_datetime TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_credit_settlements_customer ON customer_credit_settlements(customer_id, payment_datetime);

CREATE TABLE IF NOT EXISTS inventory_stock (
    medicine_id TEXT PRIMARY KEY,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_movements (
    id TEXT PRIMARY KEY,
    medicine_id TEXT NOT NULL,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('purchase', 'sale', 'return')),
    reference_id TEXT NOT NULL,
    quantity_change INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reference_type, reference_id, medicine_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_medicine ON inventory_movements(medicine_id, created_at);

CREATE TABLE IF NOT EXISTS inventory_batches (
    id TEXT PRIMARY KEY,
    medicine_id TEXT NOT NULL,
    purchase_item_id TEXT UNIQUE REFERENCES purchase_items(id),
    batch_number TEXT NOT NULL DEFAULT '',
    expiry_date TEXT NOT NULL,
    quantity_remaining INTEGER NOT NULL CHECK (quantity_remaining >= 0)
);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_fefo ON inventory_batches(medicine_id, expiry_date, quantity_remaining);

CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    invoice_number TEXT NOT NULL UNIQUE,
    sale_datetime TEXT NOT NULL,
    sale_date_solar TEXT NOT NULL DEFAULT '',
    customer_id TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    subtotal REAL NOT NULL CHECK (subtotal >= 0),
    line_discount_total REAL NOT NULL DEFAULT 0 CHECK (line_discount_total >= 0),
    discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
    total REAL NOT NULL CHECK (total >= 0),
    paid_amount REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    remaining_amount REAL NOT NULL CHECK (remaining_amount >= 0),
    status TEXT NOT NULL CHECK (status IN ('paid', 'partial', 'unpaid', 'cancelled', 'returned')),
    payment_method TEXT NOT NULL DEFAULT 'cash',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    medicine_id TEXT NOT NULL,
    medicine_name TEXT NOT NULL,
    barcode TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_type TEXT NOT NULL CHECK (unit_type IN ('pack', 'unit')),
    units_per_pack INTEGER NOT NULL CHECK (units_per_pack > 0),
    unit_price REAL NOT NULL CHECK (unit_price >= 0),
    discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
    line_total REAL NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX IF NOT EXISTS idx_sales_datetime ON sales(sale_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id, sale_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS sale_item_batches (
    sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL REFERENCES inventory_batches(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (sale_item_id, batch_id)
);

CREATE TABLE IF NOT EXISTS sale_payments (
    id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    payment_datetime TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    payment_method TEXT NOT NULL DEFAULT 'cash',
    payment_type TEXT NOT NULL CHECK (payment_type IN ('receipt', 'refund')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id, created_at);
