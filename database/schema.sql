-- Enhanced Inventory Management System Schema

-- Inventory Items Table
CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imei TEXT UNIQUE,
    manufacturer TEXT,
    model_name TEXT,
    model_code TEXT,
    device_display TEXT,
    color TEXT,
    storage TEXT,
    carrier TEXT,
    condition TEXT,
    icloud_lock_on BOOLEAN DEFAULT 0,
    price_paid_cents INTEGER,
    suggested_price_cents INTEGER,
    selling_price_cents INTEGER,
    status TEXT DEFAULT 'in_stock', -- in_stock, sold, transferred_to_warehouse
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER,
    location TEXT DEFAULT 'store' -- store, warehouse
);

-- Create index on IMEI for faster lookups
CREATE INDEX IF NOT EXISTS idx_inventory_items_imei ON inventory_items(imei);
CREATE INDEX IF NOT EXISTS idx_inventory_items_status ON inventory_items(status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_location ON inventory_items(location);

-- Cash Drawer Table
CREATE TABLE IF NOT EXISTS cash_drawer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opening_amount_cents INTEGER NOT NULL,
    closing_amount_cents INTEGER,
    expected_amount_cents INTEGER,
    difference_cents INTEGER,
    status TEXT DEFAULT 'open', -- open, closed
    opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP,
    opened_by INTEGER,
    closed_by INTEGER,
    notes TEXT
);

-- Cash Transactions Table
CREATE TABLE IF NOT EXISTS cash_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cash_drawer_id INTEGER,
    amount_cents INTEGER NOT NULL,
    transaction_type TEXT NOT NULL, -- purchase, sale, adjustment, etc.
    reference_id INTEGER, -- ID of related inventory item or other entity
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER,
    FOREIGN KEY (cash_drawer_id) REFERENCES cash_drawer(id)
);

-- Warehouse Transfers Table
CREATE TABLE IF NOT EXISTS warehouse_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending', -- pending, in_transit, completed, cancelled
    notes TEXT,
    created_by INTEGER,
    received_by INTEGER,
    received_at TIMESTAMP
);

-- Warehouse Transfer Items Table
CREATE TABLE IF NOT EXISTS warehouse_transfer_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER,
    inventory_item_id INTEGER,
    status TEXT DEFAULT 'pending', -- pending, transferred, received
    notes TEXT,
    FOREIGN KEY (transfer_id) REFERENCES warehouse_transfers(id),
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id)
);

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL, -- admin, store_staff, warehouse_staff
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Sales Table
CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_amount_cents INTEGER NOT NULL,
    payment_method TEXT NOT NULL, -- cash, credit_card, etc.
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    notes TEXT,
    created_by INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Sale Items Table
CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER,
    inventory_item_id INTEGER,
    price_cents INTEGER NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id)
);

-- Audit Log Table
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL, -- inventory_item, cash_drawer, etc.
    entity_id INTEGER,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Insert default admin user (password: admin123)
INSERT OR IGNORE INTO users (username, password_hash, full_name, role)
VALUES ('admin', '$2y$10$8MJxGHj8yPJ5Oq5zT1z7.uXbGrXGTQjgNS7QOm0TAeRzIXjgpvUiK', 'System Administrator', 'admin');