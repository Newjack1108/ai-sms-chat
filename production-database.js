// Production Database for Stock Control System
// Supports both SQLite and PostgreSQL

const { isPostgreSQL, pool, queryWithRetry } = require('./database-pg');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const {
    londonYmd,
    londonMondayYmd,
    londonMondayYmdFromYmd,
    londonYmdAddDays,
    londonDayStartUtc,
    londonNextDayStartUtc,
    londonDayStartMs,
    londonDayEndInclusiveIso,
    londonWeekdaySun0,
    londonWeekdaySun0FromYmd,
    roundClockUpLondon15,
    roundClockDownLondon15,
    londonLocalTimeToUtc,
    ymdFromDbOrInstant
} = require('./uk-datetime');

// Get database connection (SQLite or PostgreSQL)
let db;
let dbPath;

// Initialize SQLite if PostgreSQL not available
if (!isPostgreSQL) {
    // Use same path logic as main database
    if (process.env.DATABASE_PATH) {
        dbPath = process.env.DATABASE_PATH.replace('leads.db', 'production.db');
    } else if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
        const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
        if (!fs.existsSync(volumePath)) {
            fs.mkdirSync(volumePath, { recursive: true });
        }
        dbPath = path.join(volumePath, 'production.db');
    } else if (process.env.RAILWAY_ENVIRONMENT) {
        dbPath = '/app/production.db';
    } else {
        dbPath = path.join(__dirname, 'production.db');
    }
    
    try {
        db = new Database(dbPath);
        db.pragma('foreign_keys = ON');
        console.log(`🗄️ Production SQLite database: ${dbPath}`);
    } catch (error) {
        console.error(`❌ Production database connection failed: ${error.message}`);
        throw error;
    }
}

function ensureSQLitePendingAmendmentUniqueness() {
    if (!db) return;
    try {
        db.exec(`
            DELETE FROM timesheet_amendments
            WHERE id IN (
                SELECT id FROM (
                    SELECT ta.id FROM timesheet_amendments ta
                    INNER JOIN (
                        SELECT timesheet_entry_id, MIN(id) AS keep_id
                        FROM timesheet_amendments
                        WHERE status = 'pending'
                        GROUP BY timesheet_entry_id
                        HAVING COUNT(*) > 1
                    ) g ON g.timesheet_entry_id = ta.timesheet_entry_id
                    WHERE ta.status = 'pending' AND ta.id != g.keep_id
                )
            )
        `);
        db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_amendments_one_pending_per_entry
            ON timesheet_amendments(timesheet_entry_id) WHERE status = 'pending'
        `);
        console.log('✅ timesheet_amendments: at most one pending row per entry enforced');
    } catch (error) {
        console.log('⚠️ timesheet_amendments uniqueness migration:', error.message);
    }
}

async function ensurePostgresPendingAmendmentUniqueness() {
    if (!isPostgreSQL) return;
    try {
        await pool.query(`
            DELETE FROM timesheet_amendments ta
            USING (
                SELECT timesheet_entry_id, MIN(id) AS keep_id
                FROM timesheet_amendments
                WHERE status = 'pending'
                GROUP BY timesheet_entry_id
                HAVING COUNT(*) > 1
            ) d
            WHERE ta.timesheet_entry_id = d.timesheet_entry_id
              AND ta.status = 'pending'
              AND ta.id <> d.keep_id
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_amendments_one_pending_per_entry
            ON timesheet_amendments (timesheet_entry_id) WHERE (status = 'pending')
        `);
        console.log('✅ timesheet_amendments: at most one pending row per entry enforced');
    } catch (error) {
        console.log('⚠️ timesheet_amendments uniqueness migration:', error.message);
    }
}

// Initialize database schema
async function initializeProductionDatabase() {
    if (isPostgreSQL) {
        await initializePostgreSQL();
    } else {
        initializeSQLite();
    }
}

function initializeSQLite() {
    if (!db) return;
    
    console.log('🗄️ Initializing Production SQLite database...');
    
    // Production users table
    db.exec(`
        CREATE TABLE IF NOT EXISTS production_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'office', 'staff', 'installer')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Stock items table
    db.exec(`
        CREATE TABLE IF NOT EXISTS stock_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            category TEXT,
            unit TEXT NOT NULL,
            current_quantity REAL DEFAULT 0,
            min_quantity REAL DEFAULT 0,
            location TEXT,
            cost_per_unit_gbp REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Panels table
    db.exec(`
        CREATE TABLE IF NOT EXISTS panels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            panel_type TEXT,
            status TEXT DEFAULT 'active',
            cost_gbp REAL DEFAULT 0,
            built_quantity REAL DEFAULT 0,
            min_stock REAL DEFAULT 0,
            max_stock REAL DEFAULT 0,
            labour_hours REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Components table
    db.exec(`
        CREATE TABLE IF NOT EXISTS components (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            component_type TEXT,
            status TEXT DEFAULT 'active',
            cost_gbp REAL DEFAULT 0,
            built_quantity REAL DEFAULT 0,
            min_stock REAL DEFAULT 0,
            max_stock REAL DEFAULT 0,
            labour_hours REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Component BOM items table (components use raw materials)
    db.exec(`
        CREATE TABLE IF NOT EXISTS component_bom_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            component_id INTEGER NOT NULL,
            stock_item_id INTEGER NOT NULL,
            quantity_required REAL NOT NULL,
            unit TEXT NOT NULL,
            FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
            FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE
        )
    `);
    
    // Component movements table
    db.exec(`
        CREATE TABLE IF NOT EXISTS component_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            component_id INTEGER NOT NULL,
            movement_type TEXT NOT NULL CHECK(movement_type IN ('build', 'use', 'adjustment')),
            quantity REAL NOT NULL,
            reference TEXT,
            user_id INTEGER,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (component_id) REFERENCES components(id),
            FOREIGN KEY (user_id) REFERENCES production_users(id)
        )
    `);
    
    // BOM items table (built items use raw materials and components)
    db.exec(`
        CREATE TABLE IF NOT EXISTS bom_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            panel_id INTEGER NOT NULL,
            item_type TEXT NOT NULL CHECK(item_type IN ('raw_material', 'component')),
            item_id INTEGER NOT NULL,
            quantity_required REAL NOT NULL,
            unit TEXT NOT NULL,
            FOREIGN KEY (panel_id) REFERENCES panels(id) ON DELETE CASCADE
        )
    `);
    
    // Finished products table
    db.exec(`
        CREATE TABLE IF NOT EXISTS finished_products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            product_type TEXT,
            leadlock_category TEXT NOT NULL DEFAULT 'sheds',
            is_optional_extra INTEGER NOT NULL DEFAULT 0,
            category TEXT DEFAULT 'Other',
            status TEXT DEFAULT 'active',
            cost_gbp REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Suppliers table
    db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            code TEXT,
            contact_name TEXT,
            email TEXT,
            phone TEXT,
            address TEXT,
            notes TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Product components table
    db.exec(`
        CREATE TABLE IF NOT EXISTS product_components (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            component_type TEXT NOT NULL CHECK(component_type IN ('raw_material', 'component', 'built_item')),
            component_id INTEGER NOT NULL,
            quantity_required REAL NOT NULL,
            unit TEXT NOT NULL,
            FOREIGN KEY (product_id) REFERENCES finished_products(id) ON DELETE CASCADE
        )
    `);

    // Optional many-to-many approved suppliers per product
    db.exec(`
        CREATE TABLE IF NOT EXISTS product_suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            supplier_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES finished_products(id) ON DELETE CASCADE,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
            UNIQUE(product_id, supplier_id)
        )
    `);

    // Purchase orders table
    db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            po_number TEXT NOT NULL UNIQUE,
            supplier_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'sent', 'partial', 'received', 'cancelled')),
            order_date TEXT NOT NULL,
            expected_date TEXT,
            notes TEXT,
            subtotal_gbp REAL DEFAULT 0,
            is_one_off_purchase INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
            FOREIGN KEY (created_by) REFERENCES production_users(id)
        )
    `);

    // Purchase order items
    db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            purchase_order_id INTEGER NOT NULL,
            stock_item_id INTEGER NOT NULL,
            quantity REAL NOT NULL,
            unit_cost_gbp REAL NOT NULL DEFAULT 0,
            line_total_gbp REAL NOT NULL DEFAULT 0,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
            FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
        )
    `);

    // Migrate purchase_orders to add is_one_off_purchase
    try {
        const poColumns = db.prepare(`PRAGMA table_info(purchase_orders)`).all();
        const hasOneOffFlag = poColumns.some(col => col.name === 'is_one_off_purchase');
        if (!hasOneOffFlag) {
            db.exec(`ALTER TABLE purchase_orders ADD COLUMN is_one_off_purchase INTEGER NOT NULL DEFAULT 0`);
            console.log('✅ Added is_one_off_purchase column to purchase_orders table');
        }
    } catch (error) {
        console.log('⚠️ Purchase orders migration check skipped:', error.message);
    }
    
    // Product orders table
    db.exec(`
        CREATE TABLE IF NOT EXISTS product_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            order_date TEXT,
            status TEXT DEFAULT 'pending',
            created_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES finished_products(id),
            FOREIGN KEY (created_by) REFERENCES production_users(id)
        )
    `);
    
    // Order products junction table (for multiple products per order)
    db.exec(`
        CREATE TABLE IF NOT EXISTS order_products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES product_orders(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES finished_products(id)
        )
    `);
    
    // Order spares table
    db.exec(`
        CREATE TABLE IF NOT EXISTS order_spares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            item_type TEXT NOT NULL CHECK(item_type IN ('component', 'built_item', 'raw_material')),
            item_id INTEGER NOT NULL,
            quantity_needed REAL NOT NULL,
            quantity_loaded REAL DEFAULT 0,
            quantity_used REAL DEFAULT 0,
            quantity_returned REAL DEFAULT 0,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES product_orders(id) ON DELETE CASCADE
        )
    `);
    
    // Migrate finished_products to add category column
    try {
        const tableInfo = db.prepare(`PRAGMA table_info(finished_products)`).all();
        const hasCategory = tableInfo.some(col => col.name === 'category');
        if (!hasCategory) {
            db.exec('ALTER TABLE finished_products ADD COLUMN category TEXT DEFAULT \'Other\'');
            console.log('✅ Added category column to finished_products table');
        }
        const hasLoadTime = tableInfo.some(col => col.name === 'estimated_load_time');
        if (!hasLoadTime) {
            db.exec('ALTER TABLE finished_products ADD COLUMN estimated_load_time REAL DEFAULT 0');
            console.log('✅ Added estimated_load_time column to finished_products table');
        }
        const hasInstallTime = tableInfo.some(col => col.name === 'estimated_install_time');
        if (!hasInstallTime) {
            db.exec('ALTER TABLE finished_products ADD COLUMN estimated_install_time REAL DEFAULT 0');
            console.log('✅ Added estimated_install_time column to finished_products table');
        }
        const hasTravelTime = tableInfo.some(col => col.name === 'estimated_travel_time');
        if (!hasTravelTime) {
            db.exec('ALTER TABLE finished_products ADD COLUMN estimated_travel_time REAL DEFAULT 0');
            console.log('✅ Added estimated_travel_time column to finished_products table');
        }
        const hasNumberOfBoxes = tableInfo.some(col => col.name === 'number_of_boxes');
        if (!hasNumberOfBoxes) {
            db.exec('ALTER TABLE finished_products ADD COLUMN number_of_boxes INTEGER DEFAULT 1');
            console.log('✅ Added number_of_boxes column to finished_products table');
        }
        const hasOptionalExtra = tableInfo.some(col => col.name === 'is_optional_extra');
        if (!hasOptionalExtra) {
            db.exec('ALTER TABLE finished_products ADD COLUMN is_optional_extra INTEGER NOT NULL DEFAULT 0');
            console.log('✅ Added is_optional_extra column to finished_products table');
        }
        const hasLeadlockCategory = tableInfo.some(col => col.name === 'leadlock_category');
        if (!hasLeadlockCategory) {
            db.exec('ALTER TABLE finished_products ADD COLUMN leadlock_category TEXT NOT NULL DEFAULT \'sheds\'');
            db.exec(`
                UPDATE finished_products
                SET leadlock_category = CASE
                    WHEN LOWER(TRIM(COALESCE(product_type, ''))) IN ('stable', 'stables') THEN 'stables'
                    WHEN LOWER(TRIM(COALESCE(product_type, ''))) IN ('cabin', 'cabins') THEN 'cabins'
                    ELSE 'sheds'
                END
            `);
            console.log('✅ Added leadlock_category column to finished_products table');
        }
    } catch (error) {
        console.log('⚠️ Finished products migration check skipped:', error.message);
    }
    
    // Migrate product_orders to add customer_name column
    try {
        const tableInfo = db.prepare(`PRAGMA table_info(product_orders)`).all();
        const hasCustomerName = tableInfo.some(col => col.name === 'customer_name');
        if (!hasCustomerName) {
            db.exec('ALTER TABLE product_orders ADD COLUMN customer_name TEXT');
            console.log('✅ Added customer_name column to product_orders table');
        }
        const hasSalesOrderRef = tableInfo.some(col => col.name === 'sales_order_ref');
        if (!hasSalesOrderRef) {
            db.exec('ALTER TABLE product_orders ADD COLUMN sales_order_ref TEXT');
            console.log('✅ Added sales_order_ref column to product_orders table');
        }
        const leadlockCols = ['customer_postcode', 'customer_address', 'customer_email', 'customer_phone', 'currency', 'total_amount', 'installation_booked', 'leadlock_order_id', 'labour_estimate_hours', 'shipping_boxes_count', 'travel_time_hours_round_trip', 'notes'];
        for (const col of leadlockCols) {
            if (!tableInfo.some(c => c.name === col)) {
                const type = col === 'total_amount' || col === 'labour_estimate_hours' || col === 'travel_time_hours_round_trip' ? 'REAL' : col === 'installation_booked' ? 'INTEGER' : 'TEXT';
                const def = col === 'installation_booked' ? ' DEFAULT 0' : '';
                db.exec(`ALTER TABLE product_orders ADD COLUMN ${col} ${type}${def}`);
                console.log(`✅ Added ${col} column to product_orders table`);
            }
        }
    } catch (error) {
        console.log('⚠️ Product orders migration check skipped:', error.message);
    }
    
    // LeadLock work order items table
    db.exec(`
        CREATE TABLE IF NOT EXISTS leadlock_work_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER,
            product_name TEXT,
            quantity INTEGER DEFAULT 1,
            description TEXT,
            unit_price REAL DEFAULT 0,
            install_hours REAL DEFAULT 0,
            number_of_boxes INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES product_orders(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES finished_products(id)
        )
    `);
    
    // Migrate leadlock_work_order_items to add product_id if missing
    try {
        const itemCols = db.prepare(`PRAGMA table_info(leadlock_work_order_items)`).all();
        if (!itemCols.some(c => c.name === 'product_id')) {
            db.exec('ALTER TABLE leadlock_work_order_items ADD COLUMN product_id INTEGER REFERENCES finished_products(id)');
            console.log('✅ Added product_id column to leadlock_work_order_items table');
        }
    } catch (error) {
        console.log('⚠️ LeadLock work order items migration check skipped:', error.message);
    }
    
    // Product sales sync table (tracks products pushed to sales app)
    db.exec(`
        CREATE TABLE IF NOT EXISTS product_sales_sync (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES finished_products(id)
        )
    `);
    
    // Migrate existing orders to order_products table
    try {
        const existingOrderProducts = db.prepare(`SELECT COUNT(*) as count FROM order_products`).get();
        if (existingOrderProducts.count === 0) {
            // Migrate existing product_orders with product_id to order_products
            const existingOrders = db.prepare(`
                SELECT id, product_id, quantity 
                FROM product_orders 
                WHERE product_id IS NOT NULL
            `).all();
            
            if (existingOrders.length > 0) {
                const insertStmt = db.prepare(`
                    INSERT INTO order_products (order_id, product_id, quantity)
                    VALUES (?, ?, ?)
                `);
                
                const insertMany = db.transaction((orders) => {
                    for (const order of orders) {
                        insertStmt.run(order.id, order.product_id, order.quantity);
                    }
                });
                
                insertMany(existingOrders);
                console.log(`✅ Migrated ${existingOrders.length} existing orders to order_products table`);
            }
        }
    } catch (error) {
        console.log('⚠️ Order products migration check skipped:', error.message);
    }
    
    // Migrate order_spares table (check if exists)
    try {
        const tableInfo = db.prepare(`PRAGMA table_info(order_spares)`).all();
        if (tableInfo.length === 0) {
            // Table doesn't exist, it will be created by CREATE TABLE IF NOT EXISTS above
            console.log('✅ Order spares table will be created');
        }
    } catch (error) {
        console.log('⚠️ Order spares migration check skipped:', error.message);
    }
    
    // Stock movements table
    db.exec(`
        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stock_item_id INTEGER NOT NULL,
            movement_type TEXT NOT NULL CHECK(movement_type IN ('in', 'out', 'adjustment')),
            quantity REAL NOT NULL,
            reference TEXT,
            user_id INTEGER,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
            cost_gbp REAL DEFAULT 0,
            FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
            FOREIGN KEY (user_id) REFERENCES production_users(id)
        )
    `);
    
    // Stock check reminders table
    db.exec(`
        CREATE TABLE IF NOT EXISTS stock_check_reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stock_item_id INTEGER,
            check_frequency_days INTEGER,
            last_checked_date TEXT,
            next_check_date TEXT,
            is_active INTEGER DEFAULT 1,
            user_id INTEGER,
            target_role TEXT,
            created_by_user_id INTEGER,
            reminder_text TEXT,
            reminder_type TEXT DEFAULT 'stock_check',
            FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            FOREIGN KEY (created_by_user_id) REFERENCES production_users(id)
        )
    `);
    
    // Migrate stock_check_reminders to add user assignment columns and text reminder fields
    try {
        const reminderColumns = db.prepare("PRAGMA table_info(stock_check_reminders)").all();
        const reminderColumnNames = reminderColumns.map(col => col.name);
        
        if (!reminderColumnNames.includes('user_id')) {
            db.exec('ALTER TABLE stock_check_reminders ADD COLUMN user_id INTEGER');
            console.log('✅ Added user_id column to stock_check_reminders');
        }
        if (!reminderColumnNames.includes('target_role')) {
            db.exec('ALTER TABLE stock_check_reminders ADD COLUMN target_role TEXT');
            console.log('✅ Added target_role column to stock_check_reminders');
        }
        if (!reminderColumnNames.includes('created_by_user_id')) {
            db.exec('ALTER TABLE stock_check_reminders ADD COLUMN created_by_user_id INTEGER');
            console.log('✅ Added created_by_user_id column to stock_check_reminders');
        }
        if (!reminderColumnNames.includes('reminder_text')) {
            db.exec('ALTER TABLE stock_check_reminders ADD COLUMN reminder_text TEXT');
            console.log('✅ Added reminder_text column to stock_check_reminders');
        }
        if (!reminderColumnNames.includes('reminder_type')) {
            db.exec('ALTER TABLE stock_check_reminders ADD COLUMN reminder_type TEXT DEFAULT \'stock_check\'');
            console.log('✅ Added reminder_type column to stock_check_reminders');
        }
    } catch (error) {
        console.log('⚠️ Stock check reminders migration check skipped:', error.message);
    }
    
    // Compliance inspection assets and audit records
    db.exec(`
        CREATE TABLE IF NOT EXISTS inspection_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_type TEXT NOT NULL CHECK(asset_type IN ('ladder', 'emergency_lighting', 'lev')),
            asset_name TEXT NOT NULL,
            location TEXT,
            identifier TEXT,
            frequency_days INTEGER NOT NULL DEFAULT 30,
            last_inspection_date TEXT,
            next_inspection_date TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_by_user_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by_user_id) REFERENCES production_users(id)
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS inspection_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id INTEGER NOT NULL,
            inspector_user_id INTEGER,
            inspector_name TEXT,
            inspection_date TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pass', 'fail')),
            defects TEXT,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (asset_id) REFERENCES inspection_assets(id) ON DELETE CASCADE,
            FOREIGN KEY (inspector_user_id) REFERENCES production_users(id)
        )
    `);
    try {
        const seedCount = db.prepare('SELECT COUNT(*) AS c FROM inspection_assets').get();
        if (seedCount && seedCount.c === 0) {
            const today = new Date().toISOString().split('T')[0];
            const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
            db.prepare(
                `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, 1, NULL)`
            ).run('ladder', 'Example Ladder #1', 'Workshop', 'LD-001', 30, yesterday);
            db.prepare(
                `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, 1, NULL)`
            ).run('emergency_lighting', 'Example Emergency Light — Reception', 'Reception', 'EL-R01', 30, yesterday);
            db.prepare(
                `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, 1, NULL)`
            ).run('lev', 'Example LEV — Welding Bay', 'Welding Bay', 'LEV-WB1', 30, today);
            console.log('✅ Seeded example compliance inspection assets');
        }
    } catch (e) {
        console.log('⚠️ Inspection assets seed skipped:', e.message);
    }
    
    // Tasks table
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            assigned_to_user_id INTEGER,
            created_by_user_id INTEGER,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
            due_date TEXT,
            completed_at TEXT,
            completed_by_user_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (assigned_to_user_id) REFERENCES production_users(id),
            FOREIGN KEY (created_by_user_id) REFERENCES production_users(id),
            FOREIGN KEY (completed_by_user_id) REFERENCES production_users(id)
        )
    `);
    
    // Task comments table
    db.exec(`
        CREATE TABLE IF NOT EXISTS task_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            comment TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES production_users(id)
        )
    `);
    
    // Panel movements table (track when panels are built/used)
    db.exec(`
        CREATE TABLE IF NOT EXISTS panel_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            panel_id INTEGER NOT NULL,
            movement_type TEXT NOT NULL CHECK(movement_type IN ('build', 'use', 'adjustment')),
            quantity REAL NOT NULL,
            reference TEXT,
            user_id INTEGER,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (panel_id) REFERENCES panels(id),
            FOREIGN KEY (user_id) REFERENCES production_users(id)
        )
    `);
    
    // Production settings table
    db.exec(`
        CREATE TABLE IF NOT EXISTS production_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Weekly planner table
    db.exec(`
        CREATE TABLE IF NOT EXISTS weekly_planner (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            week_start_date TEXT NOT NULL UNIQUE,
            staff_available INTEGER DEFAULT 1,
            hours_available REAL DEFAULT 40,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Planner items table
    db.exec(`
        CREATE TABLE IF NOT EXISTS planner_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            planner_id INTEGER NOT NULL,
            item_type TEXT NOT NULL CHECK(item_type IN ('component', 'built_item', 'job')),
            item_id INTEGER,
            job_name TEXT,
            quantity_to_build REAL NOT NULL,
            quantity_built REAL DEFAULT 0,
            hours_used REAL DEFAULT 0,
            priority TEXT DEFAULT 'medium' CHECK(priority IN ('high', 'medium', 'low')),
            status TEXT DEFAULT 'planned' CHECK(status IN ('planned', 'in_progress', 'completed')),
            start_day INTEGER CHECK(start_day >= 0 AND start_day <= 5),
            end_day INTEGER CHECK(end_day >= 0 AND end_day <= 5),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (planner_id) REFERENCES weekly_planner(id) ON DELETE CASCADE
        )
    `);
    
    // Jobs/Sites table for timesheet
    db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Timesheet entries table
    db.exec(`
        CREATE TABLE IF NOT EXISTS timesheet_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            clock_in_time TEXT NOT NULL,
            clock_out_time TEXT,
            clock_in_latitude REAL,
            clock_in_longitude REAL,
            clock_out_latitude REAL,
            clock_out_longitude REAL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            FOREIGN KEY (job_id) REFERENCES jobs(id)
        )
    `);
    
    // Timesheet notices table
    db.exec(`
        CREATE TABLE IF NOT EXISTS timesheet_notices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            priority TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
            created_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT,
            FOREIGN KEY (created_by) REFERENCES production_users(id)
        )
    `);
    
    // NFC clock: cards (one per staff) and readers (one per tablet/location)
    db.exec(`
        CREATE TABLE IF NOT EXISTS nfc_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            card_uid TEXT NOT NULL UNIQUE,
            label TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES production_users(id)
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS nfc_readers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reader_id TEXT NOT NULL UNIQUE,
            reader_token TEXT NOT NULL,
            job_id INTEGER NOT NULL,
            name TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (job_id) REFERENCES jobs(id)
        )
    `);
    
    // Create indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bom_panel ON bom_items(panel_id);
        CREATE INDEX IF NOT EXISTS idx_bom_item ON bom_items(item_id);
        CREATE INDEX IF NOT EXISTS idx_component_bom_component ON component_bom_items(component_id);
        CREATE INDEX IF NOT EXISTS idx_component_bom_stock ON component_bom_items(stock_item_id);
        CREATE INDEX IF NOT EXISTS idx_component_movements_component ON component_movements(component_id);
        CREATE INDEX IF NOT EXISTS idx_product_components_product ON product_components(product_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_user ON stock_movements(user_id);
        CREATE INDEX IF NOT EXISTS idx_stock_items_category ON stock_items(category);
        CREATE INDEX IF NOT EXISTS idx_product_orders_created_at ON product_orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_product_orders_status ON product_orders(status);
        CREATE INDEX IF NOT EXISTS idx_order_products_order_id ON order_products(order_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_code_unique ON suppliers(code);
        CREATE INDEX IF NOT EXISTS idx_product_suppliers_product ON product_suppliers(product_id);
        CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_order_items_stock ON purchase_order_items(stock_item_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to_user_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_panel_movements_panel ON panel_movements(panel_id);
        CREATE INDEX IF NOT EXISTS idx_planner_items_planner ON planner_items(planner_id);
        CREATE INDEX IF NOT EXISTS idx_planner_items_panel ON planner_items(panel_id);
        CREATE INDEX IF NOT EXISTS idx_weekly_planner_date ON weekly_planner(week_start_date);
        CREATE INDEX IF NOT EXISTS idx_timesheet_entries_user ON timesheet_entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_timesheet_entries_job ON timesheet_entries(job_id);
        CREATE INDEX IF NOT EXISTS idx_timesheet_entries_clock_in ON timesheet_entries(clock_in_time);
        CREATE INDEX IF NOT EXISTS idx_timesheet_notices_status ON timesheet_notices(status);
        CREATE INDEX IF NOT EXISTS idx_nfc_cards_user ON nfc_cards(user_id);
        CREATE INDEX IF NOT EXISTS idx_nfc_cards_uid ON nfc_cards(card_uid);
        CREATE INDEX IF NOT EXISTS idx_nfc_readers_reader_id ON nfc_readers(reader_id);
    `);
    
    // Migrate existing panels table to add new columns
    try {
        const columns = db.prepare("PRAGMA table_info(panels)").all();
        const columnNames = columns.map(col => col.name);
        
        if (!columnNames.includes('built_quantity')) {
            db.exec('ALTER TABLE panels ADD COLUMN built_quantity REAL DEFAULT 0');
            console.log('✅ Added built_quantity column to panels');
        }
        if (!columnNames.includes('min_stock')) {
            db.exec('ALTER TABLE panels ADD COLUMN min_stock REAL DEFAULT 0');
            console.log('✅ Added min_stock column to panels');
        }
        if (!columnNames.includes('labour_hours')) {
            db.exec('ALTER TABLE panels ADD COLUMN labour_hours REAL DEFAULT 0');
            console.log('✅ Added labour_hours column to panels');
        }
        if (!columnNames.includes('max_stock')) {
            db.exec('ALTER TABLE panels ADD COLUMN max_stock REAL DEFAULT 0');
            console.log('✅ Added max_stock column to panels');
        }
    } catch (error) {
        console.log('⚠️ Migration check skipped:', error.message);
    }
    
    // Migrate existing components table to add max_stock
    try {
        const compColumns = db.prepare("PRAGMA table_info(components)").all();
        const compColumnNames = compColumns.map(col => col.name);
        if (!compColumnNames.includes('max_stock')) {
            db.exec('ALTER TABLE components ADD COLUMN max_stock REAL DEFAULT 0');
            console.log('✅ Added max_stock column to components');
        }
    } catch (error) {
        console.log('⚠️ Components migration check skipped:', error.message);
    }
    
    // Migrate existing planner_items table to add new columns
    try {
        const plannerColumns = db.prepare("PRAGMA table_info(planner_items)").all();
        const plannerColumnNames = plannerColumns.map(col => col.name);
        
        if (!plannerColumnNames.includes('quantity_built')) {
            db.exec('ALTER TABLE planner_items ADD COLUMN quantity_built REAL DEFAULT 0');
            console.log('✅ Added quantity_built column to planner_items');
        }
        if (!plannerColumnNames.includes('hours_used')) {
            db.exec('ALTER TABLE planner_items ADD COLUMN hours_used REAL DEFAULT 0');
            console.log('✅ Added hours_used column to planner_items');
        }
        
        // Add job_name column for job items
        if (!plannerColumnNames.includes('job_name')) {
            db.exec('ALTER TABLE planner_items ADD COLUMN job_name TEXT');
            console.log('✅ Added job_name column to planner_items');
        }
        
        // Add start_day and end_day columns for day assignments
        if (!plannerColumnNames.includes('start_day')) {
            db.exec('ALTER TABLE planner_items ADD COLUMN start_day INTEGER');
            console.log('✅ Added start_day column to planner_items');
        }
        if (!plannerColumnNames.includes('end_day')) {
            db.exec('ALTER TABLE planner_items ADD COLUMN end_day INTEGER');
            console.log('✅ Added end_day column to planner_items');
        }
    } catch (error) {
        console.log('⚠️ Planner items migration check skipped:', error.message);
    }
    
    // Insert default labour rate if not exists
    const settingCheck = db.prepare('SELECT COUNT(*) as count FROM production_settings WHERE key = ?').get('labour_rate_per_hour');
    if (settingCheck.count === 0) {
        db.prepare('INSERT INTO production_settings (key, value) VALUES (?, ?)').run('labour_rate_per_hour', '25.00');
    }
    
    // Migrate production_users role constraint to include 'office' role
    // SQLite doesn't support ALTER TABLE for CHECK constraints, so we need to recreate the table
    try {
        // Check if table exists and has old constraint
        const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='production_users'").get();
        if (tableInfo && tableInfo.sql && !tableInfo.sql.includes("'office'")) {
            console.log('🔄 Migrating production_users table to support office role...');
            
            // Create new table with updated constraint
            db.exec(`
                CREATE TABLE IF NOT EXISTS production_users_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('admin', 'office', 'staff', 'installer')),
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Copy data (migrate 'manager' role to 'office' if exists)
            db.exec(`
                INSERT INTO production_users_new (id, username, password_hash, role, created_at)
                SELECT id, username, password_hash, 
                       CASE WHEN role = 'manager' THEN 'office' ELSE role END,
                       created_at
                FROM production_users
            `);
            
            // Drop old table
            db.exec('DROP TABLE production_users');
            
            // Rename new table
            db.exec('ALTER TABLE production_users_new RENAME TO production_users');
            
            console.log('✅ Migrated production_users table to support office role (manager -> office)');
        }
    } catch (error) {
        console.log('⚠️ Role constraint migration check skipped:', error.message);
    }
    
    // Migrate production_users to add status column (active | left_company)
    try {
        const userColumns = db.prepare("PRAGMA table_info(production_users)").all();
        const hasStatus = userColumns.some(c => c.name === 'status');
        if (!hasStatus) {
            db.exec("ALTER TABLE production_users ADD COLUMN status TEXT DEFAULT 'active'");
            console.log('✅ Added status column to production_users');
        }
    } catch (error) {
        console.log('⚠️ Status column migration check skipped:', error.message);
    }
    
    // Migrate production_users role constraint to include 'installer' role
    try {
        const tableInfoInstaller = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='production_users'").get();
        if (tableInfoInstaller && tableInfoInstaller.sql && !tableInfoInstaller.sql.includes("'installer'")) {
            console.log('🔄 Migrating production_users table to support installer role...');
            const installerUserCols = db.prepare("PRAGMA table_info(production_users)").all();
            const installerHasStatus = installerUserCols.some(c => c.name === 'status');
            
            if (installerHasStatus) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS production_users_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        role TEXT NOT NULL CHECK(role IN ('admin', 'office', 'staff', 'installer')),
                        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                        status TEXT DEFAULT 'active'
                    )
                `);
                db.exec(`
                    INSERT INTO production_users_new (id, username, password_hash, role, created_at, status)
                    SELECT id, username, password_hash, role, created_at, COALESCE(status, 'active')
                    FROM production_users
                `);
            } else {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS production_users_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        role TEXT NOT NULL CHECK(role IN ('admin', 'office', 'staff', 'installer')),
                        created_at TEXT DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                db.exec(`
                    INSERT INTO production_users_new (id, username, password_hash, role, created_at)
                    SELECT id, username, password_hash, role, created_at
                    FROM production_users
                `);
            }
            
            db.exec('DROP TABLE production_users');
            db.exec('ALTER TABLE production_users_new RENAME TO production_users');
            console.log('✅ Migrated production_users table to support installer role');
        }
    } catch (error) {
        console.log('⚠️ Installer role migration check skipped:', error.message);
    }
    
    // Migrate timesheet_entries to add hour calculation columns
    try {
        const columns = db.prepare("PRAGMA table_info(timesheet_entries)").all();
        const columnNames = columns.map(col => col.name);
        
        if (!columnNames.includes('regular_hours')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN regular_hours REAL DEFAULT 0');
            console.log('✅ Added regular_hours column to timesheet_entries');
        }
        if (!columnNames.includes('overtime_hours')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN overtime_hours REAL DEFAULT 0');
            console.log('✅ Added overtime_hours column to timesheet_entries');
        }
        if (!columnNames.includes('weekend_hours')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN weekend_hours REAL DEFAULT 0');
            console.log('✅ Added weekend_hours column to timesheet_entries');
        }
        if (!columnNames.includes('overnight_hours')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN overnight_hours REAL DEFAULT 0');
            console.log('✅ Added overnight_hours column to timesheet_entries');
        }
        if (!columnNames.includes('total_hours')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN total_hours REAL DEFAULT 0');
            console.log('✅ Added total_hours column to timesheet_entries');
        }
        if (!columnNames.includes('calculated_at')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN calculated_at TEXT');
            console.log('✅ Added calculated_at column to timesheet_entries');
        }
        if (!columnNames.includes('edited_by_admin_id')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN edited_by_admin_id INTEGER');
            console.log('✅ Added edited_by_admin_id column to timesheet_entries');
        }
        if (!columnNames.includes('edited_by_admin_at')) {
            db.exec('ALTER TABLE timesheet_entries ADD COLUMN edited_by_admin_at TEXT');
            console.log('✅ Added edited_by_admin_at column to timesheet_entries');
        }
    } catch (error) {
        console.log('⚠️ Timesheet entries migration check skipped:', error.message);
    }
    
    // Migrate timesheet_daily_entries to add day_type column
    try {
        const dailyColumns = db.prepare("PRAGMA table_info(timesheet_daily_entries)").all();
        const dailyColumnNames = dailyColumns.map(col => col.name);
        
        if (!dailyColumnNames.includes('day_type')) {
            db.exec('ALTER TABLE timesheet_daily_entries ADD COLUMN day_type TEXT CHECK(day_type IN (\'holiday_paid\', \'holiday_unpaid\', \'sick_paid\', \'sick_unpaid\'))');
            console.log('✅ Added day_type column to timesheet_daily_entries');
        }
    } catch (error) {
        console.log('⚠️ Timesheet daily entries day_type migration check skipped:', error.message);
    }
    
    // Create weekly_timesheets table
    db.exec(`
        CREATE TABLE IF NOT EXISTS weekly_timesheets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            week_start_date TEXT NOT NULL,
            week_end_date TEXT NOT NULL,
            status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'approved')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            UNIQUE(user_id, week_start_date)
        )
    `);
    
    // Migrate weekly_timesheets to add manager approval columns
    try {
        const weeklyColumns = db.prepare("PRAGMA table_info(weekly_timesheets)").all();
        const weeklyColumnNames = weeklyColumns.map(col => col.name);
        
        if (!weeklyColumnNames.includes('manager_approved')) {
            db.exec('ALTER TABLE weekly_timesheets ADD COLUMN manager_approved INTEGER DEFAULT 0');
            console.log('✅ Added manager_approved column to weekly_timesheets');
        }
        if (!weeklyColumnNames.includes('approved_by')) {
            db.exec('ALTER TABLE weekly_timesheets ADD COLUMN approved_by INTEGER');
            console.log('✅ Added approved_by column to weekly_timesheets');
        }
        if (!weeklyColumnNames.includes('approved_at')) {
            db.exec('ALTER TABLE weekly_timesheets ADD COLUMN approved_at TEXT');
            console.log('✅ Added approved_at column to weekly_timesheets');
        }
    } catch (error) {
        console.log('⚠️ Weekly timesheets migration check skipped:', error.message);
    }
    
    // Create timesheet_daily_entries table
    db.exec(`
        CREATE TABLE IF NOT EXISTS timesheet_daily_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            weekly_timesheet_id INTEGER NOT NULL,
            entry_date TEXT NOT NULL,
            timesheet_entry_id INTEGER,
            daily_notes TEXT,
            overnight_away INTEGER DEFAULT 0,
            regular_hours REAL DEFAULT 0,
            overtime_hours REAL DEFAULT 0,
            weekend_hours REAL DEFAULT 0,
            overnight_hours REAL DEFAULT 0,
            total_hours REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (weekly_timesheet_id) REFERENCES weekly_timesheets(id),
            FOREIGN KEY (timesheet_entry_id) REFERENCES timesheet_entries(id),
            UNIQUE(weekly_timesheet_id, entry_date)
        )
    `);
    
    // Create timesheet_amendments table
    db.exec(`
        CREATE TABLE IF NOT EXISTS timesheet_amendments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timesheet_entry_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            original_clock_in_time TEXT NOT NULL,
            original_clock_out_time TEXT,
            amended_clock_in_time TEXT NOT NULL,
            amended_clock_out_time TEXT,
            reason TEXT NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
            reviewed_by INTEGER,
            reviewed_at TEXT,
            review_notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (timesheet_entry_id) REFERENCES timesheet_entries(id),
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            FOREIGN KEY (reviewed_by) REFERENCES production_users(id)
        )
    `);
    
    // Create indexes for new tables
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_weekly_timesheets_user ON weekly_timesheets(user_id);
        CREATE INDEX IF NOT EXISTS idx_weekly_timesheets_week ON weekly_timesheets(week_start_date);
        CREATE INDEX IF NOT EXISTS idx_daily_entries_weekly ON timesheet_daily_entries(weekly_timesheet_id);
        CREATE INDEX IF NOT EXISTS idx_daily_entries_date ON timesheet_daily_entries(entry_date);
        CREATE INDEX IF NOT EXISTS idx_amendments_entry ON timesheet_amendments(timesheet_entry_id);
        CREATE INDEX IF NOT EXISTS idx_amendments_user ON timesheet_amendments(user_id);
        CREATE INDEX IF NOT EXISTS idx_amendments_status ON timesheet_amendments(status);
    `);
    
    // Holiday entitlements table
    db.exec(`
        CREATE TABLE IF NOT EXISTS holiday_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            year INTEGER NOT NULL,
            total_days INTEGER NOT NULL,
            days_used DECIMAL(10,2) DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            UNIQUE(user_id, year)
        )
    `);
    
    // Holiday requests table
    db.exec(`
        CREATE TABLE IF NOT EXISTS holiday_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            days_requested DECIMAL(10,2) NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
            requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
            requested_by_user_id INTEGER NOT NULL,
            reviewed_by_user_id INTEGER,
            reviewed_at TEXT,
            review_notes TEXT,
            is_company_shutdown INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            FOREIGN KEY (requested_by_user_id) REFERENCES production_users(id),
            FOREIGN KEY (reviewed_by_user_id) REFERENCES production_users(id)
        )
    `);
    
    // Company shutdown periods table
    db.exec(`
        CREATE TABLE IF NOT EXISTS company_shutdown_periods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            year INTEGER NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            description TEXT,
            is_active INTEGER DEFAULT 1,
            created_by_user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by_user_id) REFERENCES production_users(id)
        )
    `);
    
    // Migrate timesheet_daily_entries to add holiday_request_id column
    try {
        const dailyColumns = db.prepare("PRAGMA table_info(timesheet_daily_entries)").all();
        const dailyColumnNames = dailyColumns.map(col => col.name);
        
        if (!dailyColumnNames.includes('holiday_request_id')) {
            // SQLite doesn't support adding foreign key constraints via ALTER TABLE
            // Just add the column; the foreign key relationship is conceptual
            db.exec('ALTER TABLE timesheet_daily_entries ADD COLUMN holiday_request_id INTEGER');
            console.log('✅ Added holiday_request_id column to timesheet_daily_entries');
        }
    } catch (error) {
        console.log('⚠️ Timesheet daily entries holiday_request_id migration check skipped:', error.message);
    }
    
    // Create indexes for holiday tables
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_holiday_entitlements_user ON holiday_entitlements(user_id);
        CREATE INDEX IF NOT EXISTS idx_holiday_entitlements_year ON holiday_entitlements(year);
        CREATE INDEX IF NOT EXISTS idx_holiday_requests_user ON holiday_requests(user_id);
        CREATE INDEX IF NOT EXISTS idx_holiday_requests_status ON holiday_requests(status);
        CREATE INDEX IF NOT EXISTS idx_holiday_requests_dates ON holiday_requests(start_date, end_date);
        CREATE INDEX IF NOT EXISTS idx_shutdown_periods_year ON company_shutdown_periods(year);
    `);
    
    // Installations table
    db.exec(`
        CREATE TABLE IF NOT EXISTS installations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            works_order_id INTEGER,
            installation_date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT,
            duration_hours REAL NOT NULL,
            location TEXT,
            address TEXT,
            notes TEXT,
            status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
            created_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (works_order_id) REFERENCES product_orders(id),
            FOREIGN KEY (created_by) REFERENCES production_users(id)
        )
    `);
    
    // Installation assignments table
    db.exec(`
        CREATE TABLE IF NOT EXISTS installation_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            installation_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT,
            assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            UNIQUE(installation_id, user_id)
        )
    `);
    
    // Create indexes for installations
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_installations_date ON installations(installation_date);
        CREATE INDEX IF NOT EXISTS idx_installations_order ON installations(works_order_id);
        CREATE INDEX IF NOT EXISTS idx_installations_status ON installations(status);
        CREATE INDEX IF NOT EXISTS idx_installation_assignments_installation ON installation_assignments(installation_id);
        CREATE INDEX IF NOT EXISTS idx_installation_assignments_user ON installation_assignments(user_id);
    `);
    
    // Installation days table
    db.exec(`
        CREATE TABLE IF NOT EXISTS installation_days (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            installation_id INTEGER NOT NULL,
            day_date TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            duration_hours REAL,
            notes TEXT,
            FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE,
            UNIQUE(installation_id, day_date)
        )
    `);

    // Installation checklist responses
    db.exec(`
        CREATE TABLE IF NOT EXISTS installation_checklist_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            installation_id INTEGER NOT NULL,
            checklist_type TEXT NOT NULL CHECK(checklist_type IN ('pre_fitting', 'completion')),
            question_key TEXT NOT NULL,
            answer INTEGER NOT NULL CHECK(answer IN (0, 1)),
            updated_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE,
            FOREIGN KEY (updated_by) REFERENCES production_users(id),
            UNIQUE(installation_id, checklist_type, question_key)
        )
    `);

    // Installation customer sign-off + consent
    db.exec(`
        CREATE TABLE IF NOT EXISTS installation_signoffs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            installation_id INTEGER NOT NULL UNIQUE,
            signer_name TEXT,
            signer_phone TEXT,
            signature_data_url TEXT,
            social_media_consent INTEGER CHECK(social_media_consent IN (0, 1)),
            satisfaction_emoji TEXT,
            signed_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE
        )
    `);

    // Installation sign-off tokens for customer links
    db.exec(`
        CREATE TABLE IF NOT EXISTS installation_signoff_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            installation_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT,
            used_at TEXT,
            created_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES production_users(id)
        )
    `);

    // Installation photos (Cloudinary metadata)
    db.exec(`
        CREATE TABLE IF NOT EXISTS installation_photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            installation_id INTEGER NOT NULL,
            stage_label TEXT NOT NULL,
            image_url TEXT NOT NULL,
            cloudinary_public_id TEXT,
            uploaded_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE,
            FOREIGN KEY (uploaded_by) REFERENCES production_users(id)
        )
    `);
    
    // Migrate installations table to support multi-day
    try {
        const tableInfo = db.prepare(`PRAGMA table_info(installations)`).all();
        const hasStartDate = tableInfo.some(col => col.name === 'start_date');
        const hasEndDate = tableInfo.some(col => col.name === 'end_date');
        
        if (!hasStartDate) {
            // Drop old index if it exists
            try {
                db.exec('DROP INDEX IF EXISTS idx_installations_date');
            } catch (error) {
                // Index might not exist, ignore
            }
            // Rename installation_date to start_date
            db.exec('ALTER TABLE installations RENAME COLUMN installation_date TO start_date');
            console.log('✅ Renamed installation_date to start_date in installations table');
        }
        
        if (!hasEndDate) {
            // Add end_date column and set it to start_date for existing records
            db.exec('ALTER TABLE installations ADD COLUMN end_date TEXT');
            db.exec('UPDATE installations SET end_date = start_date WHERE end_date IS NULL');
            console.log('✅ Added end_date column to installations table');
        }
    } catch (error) {
        console.log('⚠️ Installations migration check skipped:', error.message);
    }
    
    // Create indexes for installations (after migration)
    try {
        const tableInfo = db.prepare(`PRAGMA table_info(installations)`).all();
        const hasStartDate = tableInfo.some(col => col.name === 'start_date');
        const dateColumn = hasStartDate ? 'start_date' : 'installation_date';
        
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_installations_date ON installations(${dateColumn});
            CREATE INDEX IF NOT EXISTS idx_installations_order ON installations(works_order_id);
            CREATE INDEX IF NOT EXISTS idx_installations_status ON installations(status);
            CREATE INDEX IF NOT EXISTS idx_installation_assignments_installation ON installation_assignments(installation_id);
            CREATE INDEX IF NOT EXISTS idx_installation_assignments_user ON installation_assignments(user_id);
        `);
    } catch (error) {
        console.log('⚠️ Could not create installation indexes:', error.message);
    }
    
    // Create indexes for installation_days
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_installation_days_installation ON installation_days(installation_id);
        CREATE INDEX IF NOT EXISTS idx_installation_days_date ON installation_days(day_date);
        CREATE INDEX IF NOT EXISTS idx_installation_checklist_installation ON installation_checklist_responses(installation_id, checklist_type);
        CREATE INDEX IF NOT EXISTS idx_installation_signoff_tokens_token ON installation_signoff_tokens(token);
        CREATE INDEX IF NOT EXISTS idx_installation_photos_installation ON installation_photos(installation_id);
    `);

    // Daily fitter vehicle/trailer inspections
    db.exec(`
        CREATE TABLE IF NOT EXISTS daily_vehicle_inspections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inspection_date TEXT NOT NULL,
            inspected_by_user_id INTEGER NOT NULL,
            vehicle_registration TEXT,
            trailer_attached INTEGER NOT NULL DEFAULT 0 CHECK(trailer_attached IN (0, 1)),
            trailer_registration TEXT,
            notes TEXT,
            overall_status TEXT NOT NULL DEFAULT 'pass' CHECK(overall_status IN ('pass', 'warning')),
            critical_fail_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (inspected_by_user_id) REFERENCES production_users(id),
            UNIQUE(inspection_date, inspected_by_user_id)
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS daily_vehicle_inspection_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inspection_id INTEGER NOT NULL,
            section TEXT NOT NULL CHECK(section IN ('vehicle', 'trailer')),
            question_key TEXT NOT NULL,
            answer TEXT NOT NULL CHECK(answer IN ('pass', 'fail', 'na')),
            is_critical INTEGER NOT NULL DEFAULT 0 CHECK(is_critical IN (0, 1)),
            comment TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (inspection_id) REFERENCES daily_vehicle_inspections(id) ON DELETE CASCADE,
            UNIQUE(inspection_id, section, question_key)
        )
    `);
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_daily_vehicle_inspections_date_user ON daily_vehicle_inspections(inspection_date, inspected_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_daily_vehicle_inspections_status ON daily_vehicle_inspections(overall_status, inspection_date);
        CREATE INDEX IF NOT EXISTS idx_daily_vehicle_responses_inspection ON daily_vehicle_inspection_responses(inspection_id, section);
    `);
    
    ensureSQLitePendingAmendmentUniqueness();
    
    console.log('✅ Production SQLite database initialized');
}

async function initializePostgreSQL() {
    if (!isPostgreSQL) return;
    
    console.log('🗄️ Initializing Production PostgreSQL database...');
    
    try {
        // Verify connection (with retry for cold-start)
        await queryWithRetry(() => pool.query('SELECT 1'));
        
        // Production users
        await pool.query(`
            CREATE TABLE IF NOT EXISTS production_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL CHECK(role IN ('admin', 'office', 'staff', 'installer')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Stock items
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                category VARCHAR(255),
                unit VARCHAR(50) NOT NULL,
                current_quantity DECIMAL(10,2) DEFAULT 0,
                min_quantity DECIMAL(10,2) DEFAULT 0,
                location VARCHAR(255),
                cost_per_unit_gbp DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Panels
        await pool.query(`
            CREATE TABLE IF NOT EXISTS panels (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                panel_type VARCHAR(100),
                status VARCHAR(50) DEFAULT 'active',
                cost_gbp DECIMAL(10,2) DEFAULT 0,
                built_quantity DECIMAL(10,2) DEFAULT 0,
                min_stock DECIMAL(10,2) DEFAULT 0,
                max_stock DECIMAL(10,2) DEFAULT 0,
                labour_hours DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Components
        await pool.query(`
            CREATE TABLE IF NOT EXISTS components (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                component_type VARCHAR(100),
                status VARCHAR(50) DEFAULT 'active',
                cost_gbp DECIMAL(10,2) DEFAULT 0,
                built_quantity DECIMAL(10,2) DEFAULT 0,
                min_stock DECIMAL(10,2) DEFAULT 0,
                max_stock DECIMAL(10,2) DEFAULT 0,
                labour_hours DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Component BOM items (components use raw materials)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS component_bom_items (
                id SERIAL PRIMARY KEY,
                component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
                stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
                quantity_required DECIMAL(10,2) NOT NULL,
                unit VARCHAR(50) NOT NULL
            )
        `);
        
        // Component movements
        await pool.query(`
            CREATE TABLE IF NOT EXISTS component_movements (
                id SERIAL PRIMARY KEY,
                component_id INTEGER NOT NULL REFERENCES components(id),
                movement_type VARCHAR(20) NOT NULL CHECK(movement_type IN ('build', 'use', 'adjustment')),
                quantity DECIMAL(10,2) NOT NULL,
                reference TEXT,
                user_id INTEGER REFERENCES production_users(id),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // BOM items (built items use raw materials and components)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bom_items (
                id SERIAL PRIMARY KEY,
                panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
                item_type VARCHAR(20) NOT NULL CHECK(item_type IN ('raw_material', 'component')),
                item_id INTEGER NOT NULL,
                quantity_required DECIMAL(10,2) NOT NULL,
                unit VARCHAR(50) NOT NULL
            )
        `);
        
        // Finished products
        await pool.query(`
            CREATE TABLE IF NOT EXISTS finished_products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                product_type VARCHAR(100),
                leadlock_category VARCHAR(20) NOT NULL DEFAULT 'sheds',
                is_optional_extra BOOLEAN NOT NULL DEFAULT FALSE,
                category VARCHAR(100) DEFAULT 'Other',
                status VARCHAR(50) DEFAULT 'active',
                cost_gbp DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Product components
        await pool.query(`
            CREATE TABLE IF NOT EXISTS product_components (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES finished_products(id) ON DELETE CASCADE,
                component_type VARCHAR(20) NOT NULL CHECK(component_type IN ('raw_material', 'component', 'built_item')),
                component_id INTEGER NOT NULL,
                quantity_required DECIMAL(10,2) NOT NULL,
                unit VARCHAR(50) NOT NULL
            )
        `);

        // Suppliers
        await pool.query(`
            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                code VARCHAR(100),
                contact_name VARCHAR(255),
                email VARCHAR(255),
                phone VARCHAR(100),
                address TEXT,
                notes TEXT,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Product suppliers (optional many-to-many approved suppliers per product)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS product_suppliers (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES finished_products(id) ON DELETE CASCADE,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(product_id, supplier_id)
            )
        `);

        // Purchase orders
        await pool.query(`
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id SERIAL PRIMARY KEY,
                po_number VARCHAR(32) NOT NULL UNIQUE,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
                status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'sent', 'partial', 'received', 'cancelled')),
                order_date DATE NOT NULL,
                expected_date DATE,
                notes TEXT,
                subtotal_gbp DECIMAL(12,2) DEFAULT 0,
                is_one_off_purchase BOOLEAN NOT NULL DEFAULT FALSE,
                created_by INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Purchase order items
        await pool.query(`
            CREATE TABLE IF NOT EXISTS purchase_order_items (
                id SERIAL PRIMARY KEY,
                purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
                stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
                quantity DECIMAL(12,2) NOT NULL,
                unit_cost_gbp DECIMAL(12,2) NOT NULL DEFAULT 0,
                line_total_gbp DECIMAL(12,2) NOT NULL DEFAULT 0,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'purchase_orders' AND column_name = 'is_one_off_purchase'
                ) THEN
                    ALTER TABLE purchase_orders ADD COLUMN is_one_off_purchase BOOLEAN NOT NULL DEFAULT FALSE;
                END IF;
            END $$;
        `);
        
        // Product orders
        await pool.query(`
            CREATE TABLE IF NOT EXISTS product_orders (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES finished_products(id),
                quantity INTEGER NOT NULL,
                order_date DATE,
                status VARCHAR(50) DEFAULT 'pending',
                created_by INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Order products junction table (for multiple products per order)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_products (
                id SERIAL PRIMARY KEY,
                order_id INTEGER NOT NULL REFERENCES product_orders(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL REFERENCES finished_products(id),
                quantity INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Order spares table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_spares (
                id SERIAL PRIMARY KEY,
                order_id INTEGER NOT NULL REFERENCES product_orders(id) ON DELETE CASCADE,
                item_type VARCHAR(20) NOT NULL CHECK(item_type IN ('component', 'built_item', 'raw_material')),
                item_id INTEGER NOT NULL,
                quantity_needed DECIMAL(10,2) NOT NULL,
                quantity_loaded DECIMAL(10,2) DEFAULT 0,
                quantity_used DECIMAL(10,2) DEFAULT 0,
                quantity_returned DECIMAL(10,2) DEFAULT 0,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_orders_created_at ON product_orders(created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_orders_status ON product_orders(status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_products_order_id ON order_products(order_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_items_category ON stock_items(category)`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_code_unique ON suppliers(code) WHERE code IS NOT NULL`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_suppliers_product ON product_suppliers(product_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers(supplier_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_purchase_order_items_stock ON purchase_order_items(stock_item_id)`);
        
        // Migrate finished_products to add category column
        try {
            const columnCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'finished_products' AND column_name = 'category'
            `);
            if (columnCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE finished_products ADD COLUMN category VARCHAR(100) DEFAULT 'Other'`);
                console.log('✅ Added category column to finished_products table');
            }
            const loadTimeCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'finished_products' AND column_name = 'estimated_load_time'
            `);
            if (loadTimeCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE finished_products ADD COLUMN estimated_load_time DECIMAL(10,2) DEFAULT 0`);
                console.log('✅ Added estimated_load_time column to finished_products table');
            }
            const installTimeCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'finished_products' AND column_name = 'estimated_install_time'
            `);
            if (installTimeCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE finished_products ADD COLUMN estimated_install_time DECIMAL(10,2) DEFAULT 0`);
                console.log('✅ Added estimated_install_time column to finished_products table');
            }
            const travelTimeCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'finished_products' AND column_name = 'estimated_travel_time'
            `);
            if (travelTimeCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE finished_products ADD COLUMN estimated_travel_time DECIMAL(10,2) DEFAULT 0`);
                console.log('✅ Added estimated_travel_time column to finished_products table');
            }
            const numberOfBoxesCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'finished_products' AND column_name = 'number_of_boxes'
            `);
            if (numberOfBoxesCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE finished_products ADD COLUMN number_of_boxes INTEGER DEFAULT 1`);
                console.log('✅ Added number_of_boxes column to finished_products table');
            }
            const optionalExtraCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'finished_products' AND column_name = 'is_optional_extra'
            `);
            if (optionalExtraCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE finished_products ADD COLUMN is_optional_extra BOOLEAN NOT NULL DEFAULT FALSE`);
                console.log('✅ Added is_optional_extra column to finished_products table');
            }
            const leadlockCategoryCheck = await pool.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'finished_products' AND column_name = 'leadlock_category'
            `);
            if (leadlockCategoryCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE finished_products ADD COLUMN leadlock_category VARCHAR(20) NOT NULL DEFAULT 'sheds'`);
                await pool.query(`
                    UPDATE finished_products
                    SET leadlock_category = CASE
                        WHEN LOWER(TRIM(COALESCE(product_type, ''))) IN ('stable', 'stables') THEN 'stables'
                        WHEN LOWER(TRIM(COALESCE(product_type, ''))) IN ('cabin', 'cabins') THEN 'cabins'
                        ELSE 'sheds'
                    END
                `);
                console.log('✅ Added leadlock_category column to finished_products table');
            }
        } catch (error) {
            console.log('⚠️ Finished products migration check skipped:', error.message);
        }
        
        // Migrate product_orders to add customer_name column
        try {
            const columnCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'product_orders' AND column_name = 'customer_name'
            `);
            if (columnCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE product_orders ADD COLUMN customer_name VARCHAR(255)`);
                console.log('✅ Added customer_name column to product_orders table');
            }
            const salesOrderRefCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'product_orders' AND column_name = 'sales_order_ref'
            `);
            if (salesOrderRefCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE product_orders ADD COLUMN sales_order_ref VARCHAR(255)`);
                console.log('✅ Added sales_order_ref column to product_orders table');
            }
            const leadlockCols = [
                { name: 'customer_postcode', type: 'VARCHAR(50)' },
                { name: 'customer_address', type: 'TEXT' },
                { name: 'customer_email', type: 'VARCHAR(255)' },
                { name: 'customer_phone', type: 'VARCHAR(50)' },
                { name: 'currency', type: 'VARCHAR(10)' },
                { name: 'total_amount', type: 'DECIMAL(10,2)' },
                { name: 'installation_booked', type: 'BOOLEAN DEFAULT FALSE' },
                { name: 'leadlock_order_id', type: 'VARCHAR(100)' },
                { name: 'labour_estimate_hours', type: 'DECIMAL(10,2)' },
                { name: 'shipping_boxes_count', type: 'INTEGER' },
                { name: 'travel_time_hours_round_trip', type: 'DECIMAL(10,2)' },
                { name: 'notes', type: 'TEXT' }
            ];
            for (const col of leadlockCols) {
                const colCheck = await pool.query(`
                    SELECT column_name FROM information_schema.columns 
                    WHERE table_name = 'product_orders' AND column_name = $1
                `, [col.name]);
                if (colCheck.rows.length === 0) {
                    await pool.query(`ALTER TABLE product_orders ADD COLUMN ${col.name} ${col.type}`);
                    console.log(`✅ Added ${col.name} column to product_orders table`);
                }
            }
        } catch (error) {
            console.log('⚠️ Product orders migration check skipped:', error.message);
        }
        
        // LeadLock work order items table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leadlock_work_order_items (
                id SERIAL PRIMARY KEY,
                order_id INTEGER NOT NULL REFERENCES product_orders(id) ON DELETE CASCADE,
                product_id INTEGER REFERENCES finished_products(id),
                product_name VARCHAR(255),
                quantity INTEGER DEFAULT 1,
                description TEXT,
                unit_price DECIMAL(10,2) DEFAULT 0,
                install_hours DECIMAL(10,2) DEFAULT 0,
                number_of_boxes INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Migrate leadlock_work_order_items to add product_id if missing
        try {
            const itemColCheck = await pool.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'leadlock_work_order_items' AND column_name = 'product_id'
            `);
            if (itemColCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE leadlock_work_order_items ADD COLUMN product_id INTEGER REFERENCES finished_products(id)`);
                console.log('✅ Added product_id column to leadlock_work_order_items table');
            }
        } catch (error) {
            console.log('⚠️ LeadLock work order items migration check skipped:', error.message);
        }
        
        // Product sales sync table (tracks products pushed to sales app)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS product_sales_sync (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES finished_products(id),
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Migrate existing orders to order_products table
        try {
            const countResult = await pool.query(`SELECT COUNT(*) as count FROM order_products`);
            if (parseInt(countResult.rows[0].count) === 0) {
                // Migrate existing product_orders with product_id to order_products
                const existingOrders = await pool.query(`
                    SELECT id, product_id, quantity 
                    FROM product_orders 
                    WHERE product_id IS NOT NULL
                `);
                
                if (existingOrders.rows.length > 0) {
                    for (const order of existingOrders.rows) {
                        await pool.query(`
                            INSERT INTO order_products (order_id, product_id, quantity)
                            VALUES ($1, $2, $3)
                        `, [order.id, order.product_id, order.quantity]);
                    }
                    console.log(`✅ Migrated ${existingOrders.rows.length} existing orders to order_products table`);
                }
            }
        } catch (error) {
            console.log('⚠️ Order products migration check skipped:', error.message);
        }
        
        // Migrate order_spares table (check if exists)
        try {
            const tableCheck = await pool.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_name = 'order_spares'
            `);
            if (tableCheck.rows.length === 0) {
                // Table doesn't exist, it will be created by CREATE TABLE IF NOT EXISTS above
                console.log('✅ Order spares table will be created');
            }
        } catch (error) {
            console.log('⚠️ Order spares migration check skipped:', error.message);
        }
        
        // Stock movements
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_movements (
                id SERIAL PRIMARY KEY,
                stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
                movement_type VARCHAR(20) NOT NULL CHECK(movement_type IN ('in', 'out', 'adjustment')),
                quantity DECIMAL(10,2) NOT NULL,
                reference TEXT,
                user_id INTEGER REFERENCES production_users(id),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                cost_gbp DECIMAL(10,2) DEFAULT 0
            )
        `);
        
        // Stock check reminders
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_check_reminders (
                id SERIAL PRIMARY KEY,
                stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE CASCADE,
                check_frequency_days INTEGER,
                last_checked_date DATE,
                next_check_date DATE,
                is_active BOOLEAN DEFAULT TRUE,
                user_id INTEGER REFERENCES production_users(id),
                target_role VARCHAR(20),
                created_by_user_id INTEGER REFERENCES production_users(id),
                reminder_text TEXT,
                reminder_type VARCHAR(20) DEFAULT 'stock_check'
            )
        `);
        
        // Migrate stock_check_reminders to add user assignment columns and text reminder fields
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='stock_check_reminders' AND column_name='user_id'
                ) THEN
                    ALTER TABLE stock_check_reminders ADD COLUMN user_id INTEGER REFERENCES production_users(id);
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='stock_check_reminders' AND column_name='target_role'
                ) THEN
                    ALTER TABLE stock_check_reminders ADD COLUMN target_role VARCHAR(20);
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='stock_check_reminders' AND column_name='created_by_user_id'
                ) THEN
                    ALTER TABLE stock_check_reminders ADD COLUMN created_by_user_id INTEGER REFERENCES production_users(id);
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='stock_check_reminders' AND column_name='reminder_text'
                ) THEN
                    ALTER TABLE stock_check_reminders ADD COLUMN reminder_text TEXT;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='stock_check_reminders' AND column_name='reminder_type'
                ) THEN
                    ALTER TABLE stock_check_reminders ADD COLUMN reminder_type VARCHAR(20) DEFAULT 'stock_check';
                END IF;
                
                -- Make stock_item_id nullable if it's currently NOT NULL
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='stock_check_reminders' 
                    AND column_name='stock_item_id' 
                    AND is_nullable = 'NO'
                ) THEN
                    ALTER TABLE stock_check_reminders ALTER COLUMN stock_item_id DROP NOT NULL;
                END IF;
                
                -- Make check_frequency_days nullable if it's currently NOT NULL
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='stock_check_reminders' 
                    AND column_name='check_frequency_days' 
                    AND is_nullable = 'NO'
                ) THEN
                    ALTER TABLE stock_check_reminders ALTER COLUMN check_frequency_days DROP NOT NULL;
                END IF;
            END $$;
        `);
        console.log('✅ Checked/added user assignment and text reminder columns to stock_check_reminders');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_assets (
                id SERIAL PRIMARY KEY,
                asset_type VARCHAR(40) NOT NULL CHECK(asset_type IN ('ladder', 'emergency_lighting', 'lev')),
                asset_name VARCHAR(255) NOT NULL,
                location TEXT,
                identifier TEXT,
                frequency_days INTEGER NOT NULL DEFAULT 30,
                last_inspection_date DATE,
                next_inspection_date DATE NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_by_user_id INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspection_records (
                id SERIAL PRIMARY KEY,
                asset_id INTEGER NOT NULL REFERENCES inspection_assets(id) ON DELETE CASCADE,
                inspector_user_id INTEGER REFERENCES production_users(id),
                inspector_name TEXT,
                inspection_date DATE NOT NULL,
                status VARCHAR(10) NOT NULL CHECK(status IN ('pass', 'fail')),
                defects TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try {
            const seedRes = await pool.query('SELECT COUNT(*)::int AS c FROM inspection_assets');
            if (seedRes.rows[0].c === 0) {
                const today = new Date().toISOString().split('T')[0];
                const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
                await pool.query(
                    `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
                     VALUES ('ladder', $1, $2, $3, 30, NULL, $4, TRUE, NULL)`,
                    ['Example Ladder #1', 'Workshop', 'LD-001', yesterday]
                );
                await pool.query(
                    `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
                     VALUES ('emergency_lighting', $1, $2, $3, 30, NULL, $4, TRUE, NULL)`,
                    ['Example Emergency Light — Reception', 'Reception', 'EL-R01', yesterday]
                );
                await pool.query(
                    `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
                     VALUES ('lev', $1, $2, $3, 30, NULL, $4, TRUE, NULL)`,
                    ['Example LEV — Welding Bay', 'Welding Bay', 'LEV-WB1', today]
                );
                console.log('✅ Seeded example compliance inspection assets (PostgreSQL)');
            }
        } catch (seedErr) {
            console.log('⚠️ Inspection assets seed skipped:', seedErr.message);
        }
        
        // Tasks
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                assigned_to_user_id INTEGER REFERENCES production_users(id),
                created_by_user_id INTEGER REFERENCES production_users(id),
                status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
                due_date DATE,
                completed_at TIMESTAMP,
                completed_by_user_id INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Task comments
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_comments (
                id SERIAL PRIMARY KEY,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                comment TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Panel movements table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS panel_movements (
                id SERIAL PRIMARY KEY,
                panel_id INTEGER NOT NULL REFERENCES panels(id),
                movement_type VARCHAR(20) NOT NULL CHECK(movement_type IN ('build', 'use', 'adjustment')),
                quantity DECIMAL(10,2) NOT NULL,
                reference TEXT,
                user_id INTEGER REFERENCES production_users(id),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Production settings table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS production_settings (
                key VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Weekly planner table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS weekly_planner (
                id SERIAL PRIMARY KEY,
                week_start_date DATE NOT NULL UNIQUE,
                staff_available INTEGER DEFAULT 1,
                hours_available DECIMAL(10,2) DEFAULT 40,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Planner items table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS planner_items (
                id SERIAL PRIMARY KEY,
                planner_id INTEGER NOT NULL REFERENCES weekly_planner(id) ON DELETE CASCADE,
                item_type VARCHAR(20) NOT NULL CHECK(item_type IN ('component', 'built_item', 'job')),
                item_id INTEGER,
                job_name VARCHAR(255),
                quantity_to_build DECIMAL(10,2) NOT NULL,
                quantity_built DECIMAL(10,2) DEFAULT 0,
                hours_used DECIMAL(10,2) DEFAULT 0,
                priority VARCHAR(20) DEFAULT 'medium' CHECK(priority IN ('high', 'medium', 'low')),
                status VARCHAR(20) DEFAULT 'planned' CHECK(status IN ('planned', 'in_progress', 'completed')),
                start_day INTEGER CHECK(start_day >= 0 AND start_day <= 5),
                end_day INTEGER CHECK(end_day >= 0 AND end_day <= 5),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Jobs/Sites table for timesheet
        await pool.query(`
            CREATE TABLE IF NOT EXISTS jobs (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                status VARCHAR(20) DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Timesheet entries table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS timesheet_entries (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                job_id INTEGER NOT NULL REFERENCES jobs(id),
                clock_in_time TIMESTAMP NOT NULL,
                clock_out_time TIMESTAMP,
                clock_in_latitude DECIMAL(10,8),
                clock_in_longitude DECIMAL(11,8),
                clock_out_latitude DECIMAL(10,8),
                clock_out_longitude DECIMAL(11,8),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Timesheet notices table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS timesheet_notices (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                priority VARCHAR(20) DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
                status VARCHAR(20) DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
                created_by INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP
            )
        `);
        
        // NFC clock: cards (one per staff) and readers (one per tablet/location)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS nfc_cards (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                card_uid VARCHAR(255) NOT NULL UNIQUE,
                label TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS nfc_readers (
                id SERIAL PRIMARY KEY,
                reader_id VARCHAR(255) NOT NULL UNIQUE,
                reader_token TEXT NOT NULL,
                job_id INTEGER NOT NULL REFERENCES jobs(id),
                name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Migrate bom_items table to add item_type and item_id columns if they don't exist
        // This MUST run before creating indexes on those columns
        try {
            await pool.query(`
                DO $$ 
                BEGIN 
                    -- Check if bom_items table exists and if item_type column is missing
                    IF EXISTS (
                        SELECT 1 FROM information_schema.tables 
                        WHERE table_schema = 'public' AND table_name='bom_items'
                    ) AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='bom_items' AND column_name='item_type'
                    ) THEN
                        -- Add item_type and item_id columns as nullable first
                        ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(20);
                        ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS item_id INTEGER;
                        
                        -- Set default values for existing rows (assume raw_material)
                        UPDATE bom_items SET item_type = 'raw_material' WHERE item_type IS NULL;
                        
                        -- Set item_id based on existing structure if possible
                        -- Check for stock_item_id or similar column and migrate
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns 
                            WHERE table_schema = 'public' AND table_name='bom_items' AND column_name='stock_item_id'
                        ) THEN
                            UPDATE bom_items SET item_id = stock_item_id WHERE item_id IS NULL;
                        END IF;
                        
                        -- If there are still NULL values, we need to handle them
                        -- For safety, set a default item_id if NULL (but this shouldn't happen)
                        UPDATE bom_items SET item_id = 0 WHERE item_id IS NULL;
                        UPDATE bom_items SET item_type = 'raw_material' WHERE item_type IS NULL;
                        
                        -- Now make columns NOT NULL
                        ALTER TABLE bom_items ALTER COLUMN item_type SET NOT NULL;
                        ALTER TABLE bom_items ALTER COLUMN item_id SET NOT NULL;
                        
                        -- Add CHECK constraint if it doesn't exist
                        IF NOT EXISTS (
                            SELECT 1 FROM information_schema.table_constraints 
                            WHERE table_schema = 'public' AND table_name='bom_items' 
                            AND constraint_name='bom_items_item_type_check'
                        ) THEN
                            ALTER TABLE bom_items ADD CONSTRAINT bom_items_item_type_check 
                                CHECK (item_type IN ('raw_material', 'component'));
                        END IF;
                    END IF;
                    
                    -- Make stock_item_id nullable if it exists (so inserts using new schema don't fail)
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='bom_items' 
                        AND column_name='stock_item_id' AND is_nullable = 'NO'
                    ) THEN
                        ALTER TABLE bom_items ALTER COLUMN stock_item_id DROP NOT NULL;
                    END IF;
                END $$;
            `);
        } catch (error) {
            console.error('Error migrating bom_items table:', error);
            // Continue - the table might already be in the correct state
        }
        
        // Create indexes - only create item_id index if column exists
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_bom_panel ON bom_items(panel_id)`);
        
        // Check if item_id column exists before creating index
        const itemIdColumnCheck = await pool.query(`
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name='bom_items' AND column_name='item_id'
        `);
        if (itemIdColumnCheck.rows.length > 0) {
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_bom_item ON bom_items(item_id)`);
        }
        
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_component_bom_component ON component_bom_items(component_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_component_bom_stock ON component_bom_items(stock_item_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_component_movements_component ON component_movements(component_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_components_product ON product_components(product_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_user ON stock_movements(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to_user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_panel_movements_panel ON panel_movements(panel_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_planner_items_planner ON planner_items(planner_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_planner_items_panel ON planner_items(panel_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_weekly_planner_date ON weekly_planner(week_start_date)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_timesheet_entries_user ON timesheet_entries(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_timesheet_entries_job ON timesheet_entries(job_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_timesheet_entries_clock_in ON timesheet_entries(clock_in_time)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_timesheet_notices_status ON timesheet_notices(status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_nfc_cards_user ON nfc_cards(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_nfc_cards_uid ON nfc_cards(card_uid)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_nfc_readers_reader_id ON nfc_readers(reader_id)`);
        
        // Migrate production_users role constraint to include 'office' role
        // Do not loop all CHECK constraints: names like 2200_49171_1_not_null must be quoted in SQL,
        // and many are NOT NULL-related — dropping them would break the table.
        try {
            // Migrate 'manager' role to 'office' if any exist
            try {
                await pool.query(`
                    UPDATE production_users 
                    SET role = 'office' 
                    WHERE role = 'manager'
                `);
                console.log('✅ Migrated manager roles to office role');
            } catch (e) {
                console.log('⚠️ Manager to office migration:', e.message);
            }
            
            // Add new constraint with office role (will fail silently if already exists with correct values)
            try {
                await pool.query(`
                    ALTER TABLE production_users 
                    DROP CONSTRAINT IF EXISTS production_users_role_check
                `);
                await pool.query(`
                    ALTER TABLE production_users 
                    ADD CONSTRAINT production_users_role_check 
                    CHECK (role IN ('admin', 'office', 'staff', 'installer'))
                `);
                console.log('✅ Updated production_users role constraint (admin, office, staff, installer)');
            } catch (e) {
                // Constraint might already be correct or table doesn't exist yet
                if (!e.message.includes('does not exist')) {
                    console.log('⚠️ Role constraint update:', e.message);
                }
            }
        } catch (error) {
            // If constraint doesn't exist or update fails, table creation will handle it
            console.log('⚠️ Role constraint migration check:', error.message);
        }
        
        // Migrate production_users to add status column (active | left_company)
        try {
            const statusColCheck = await pool.query(`
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'production_users' AND column_name = 'status'
            `);
            if (statusColCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE production_users ADD COLUMN status VARCHAR(20) DEFAULT 'active'`);
                console.log('✅ Added status column to production_users');
            }
        } catch (error) {
            console.log('⚠️ Status column migration check skipped:', error.message);
        }
        
        // Migrate existing panels table to add new columns
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='panels' AND column_name='built_quantity'
                ) THEN
                    ALTER TABLE panels ADD COLUMN built_quantity DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='panels' AND column_name='min_stock'
                ) THEN
                    ALTER TABLE panels ADD COLUMN min_stock DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='panels' AND column_name='labour_hours'
                ) THEN
                    ALTER TABLE panels ADD COLUMN labour_hours DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='panels' AND column_name='max_stock'
                ) THEN
                    ALTER TABLE panels ADD COLUMN max_stock DECIMAL(10,2) DEFAULT 0;
                END IF;
            END $$;
        `);
        
        // Migrate existing components table to add max_stock
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='components' AND column_name='max_stock'
                ) THEN
                    ALTER TABLE components ADD COLUMN max_stock DECIMAL(10,2) DEFAULT 0;
                END IF;
            END $$;
        `);
        
        // Migrate existing planner_items table to add new columns
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='planner_items' AND column_name='quantity_built'
                ) THEN
                    ALTER TABLE planner_items ADD COLUMN quantity_built DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='planner_items' AND column_name='hours_used'
                ) THEN
                    ALTER TABLE planner_items ADD COLUMN hours_used DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                -- FIRST: Make panel_id nullable if it exists (needed for components and jobs)
                -- This MUST happen before adding new columns to allow inserts without panel_id
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_schema = 'public' AND table_name='planner_items' 
                    AND column_name='panel_id' AND is_nullable = 'NO'
                ) THEN
                    ALTER TABLE planner_items ALTER COLUMN panel_id DROP NOT NULL;
                END IF;
                
                -- Migrate to new structure: panel_id -> item_type + item_id
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='panel_id'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='item_type'
                ) THEN
                    ALTER TABLE planner_items ADD COLUMN item_type VARCHAR(20);
                    ALTER TABLE planner_items ADD COLUMN item_id INTEGER;
                    UPDATE planner_items SET item_type = 'built_item', item_id = panel_id WHERE panel_id IS NOT NULL;
                    ALTER TABLE planner_items ALTER COLUMN item_type SET NOT NULL;
                END IF;
                
                -- Add job_name column for job items
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='job_name'
                ) THEN
                    ALTER TABLE planner_items ADD COLUMN job_name VARCHAR(255);
                END IF;
                
                -- Add start_day and end_day columns for day assignments
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='start_day'
                ) THEN
                    ALTER TABLE planner_items ADD COLUMN start_day INTEGER;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='end_day'
                ) THEN
                    ALTER TABLE planner_items ADD COLUMN end_day INTEGER;
                END IF;
            END $$;
        `);
        
        // Insert default labour rate if not exists
        const settingCheck = await pool.query(`SELECT COUNT(*) as count FROM production_settings WHERE key = 'labour_rate_per_hour'`);
        if (parseInt(settingCheck.rows[0].count) === 0) {
            await pool.query(`INSERT INTO production_settings (key, value) VALUES ('labour_rate_per_hour', '25.00')`);
        }
        
        // Migrate timesheet_entries to add hour calculation columns
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='regular_hours'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN regular_hours DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='overtime_hours'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN overtime_hours DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='weekend_hours'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN weekend_hours DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='overnight_hours'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN overnight_hours DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='total_hours'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN total_hours DECIMAL(10,2) DEFAULT 0;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='calculated_at'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN calculated_at TIMESTAMP;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='edited_by_admin_id'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN edited_by_admin_id INTEGER REFERENCES production_users(id);
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_entries' AND column_name='edited_by_admin_at'
                ) THEN
                    ALTER TABLE timesheet_entries ADD COLUMN edited_by_admin_at TIMESTAMP;
                END IF;
            END $$;
        `);
        
        // Create weekly_timesheets table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS weekly_timesheets (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                week_start_date DATE NOT NULL,
                week_end_date DATE NOT NULL,
                status VARCHAR(20) DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'approved')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, week_start_date)
            )
        `);
        
        // Create timesheet_daily_entries table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS timesheet_daily_entries (
                id SERIAL PRIMARY KEY,
                weekly_timesheet_id INTEGER NOT NULL REFERENCES weekly_timesheets(id),
                entry_date DATE NOT NULL,
                timesheet_entry_id INTEGER REFERENCES timesheet_entries(id),
                daily_notes TEXT,
                overnight_away BOOLEAN DEFAULT FALSE,
                regular_hours DECIMAL(10,2) DEFAULT 0,
                overtime_hours DECIMAL(10,2) DEFAULT 0,
                weekend_hours DECIMAL(10,2) DEFAULT 0,
                overnight_hours DECIMAL(10,2) DEFAULT 0,
                total_hours DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(weekly_timesheet_id, entry_date)
            )
        `);
        
        // Migrate timesheet_daily_entries to add day_type column
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_daily_entries' AND column_name='day_type'
                ) THEN
                    ALTER TABLE timesheet_daily_entries ADD COLUMN day_type VARCHAR(20) CHECK(day_type IN ('holiday_paid', 'holiday_unpaid', 'sick_paid', 'sick_unpaid'));
                END IF;
            END $$;
        `);
        console.log('✅ Checked/added day_type column to timesheet_daily_entries');
        
        // Migrate weekly_timesheets to add manager approval columns
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='weekly_timesheets' AND column_name='manager_approved'
                ) THEN
                    ALTER TABLE weekly_timesheets ADD COLUMN manager_approved BOOLEAN DEFAULT FALSE;
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='weekly_timesheets' AND column_name='approved_by'
                ) THEN
                    ALTER TABLE weekly_timesheets ADD COLUMN approved_by INTEGER REFERENCES production_users(id);
                END IF;
                
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='weekly_timesheets' AND column_name='approved_at'
                ) THEN
                    ALTER TABLE weekly_timesheets ADD COLUMN approved_at TIMESTAMP;
                END IF;
            END $$;
        `);
        console.log('✅ Checked/added manager approval columns to weekly_timesheets');
        
        // Create timesheet_amendments table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS timesheet_amendments (
                id SERIAL PRIMARY KEY,
                timesheet_entry_id INTEGER NOT NULL REFERENCES timesheet_entries(id),
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                original_clock_in_time TIMESTAMP NOT NULL,
                original_clock_out_time TIMESTAMP,
                amended_clock_in_time TIMESTAMP NOT NULL,
                amended_clock_out_time TIMESTAMP,
                reason TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
                reviewed_by INTEGER REFERENCES production_users(id),
                reviewed_at TIMESTAMP,
                review_notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create indexes for new tables
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_weekly_timesheets_user ON weekly_timesheets(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_weekly_timesheets_week ON weekly_timesheets(week_start_date)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_entries_weekly ON timesheet_daily_entries(weekly_timesheet_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_entries_date ON timesheet_daily_entries(entry_date)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_amendments_entry ON timesheet_amendments(timesheet_entry_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_amendments_user ON timesheet_amendments(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_amendments_status ON timesheet_amendments(status)`);
        
        // Holiday entitlements table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS holiday_entitlements (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                year INTEGER NOT NULL,
                total_days INTEGER NOT NULL,
                days_used DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, year)
            )
        `);
        
        // Holiday requests table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS holiday_requests (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                days_requested DECIMAL(10,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
                requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                requested_by_user_id INTEGER NOT NULL REFERENCES production_users(id),
                reviewed_by_user_id INTEGER REFERENCES production_users(id),
                reviewed_at TIMESTAMP,
                review_notes TEXT,
                is_company_shutdown BOOLEAN DEFAULT FALSE
            )
        `);
        
        // Company shutdown periods table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS company_shutdown_periods (
                id SERIAL PRIMARY KEY,
                year INTEGER NOT NULL,
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                created_by_user_id INTEGER NOT NULL REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Migrate timesheet_daily_entries to add holiday_request_id column
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='timesheet_daily_entries' AND column_name='holiday_request_id'
                ) THEN
                    ALTER TABLE timesheet_daily_entries ADD COLUMN holiday_request_id INTEGER REFERENCES holiday_requests(id);
                END IF;
            END $$;
        `);
        console.log('✅ Checked/added holiday_request_id column to timesheet_daily_entries');
        
        // Create indexes for holiday tables
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_holiday_entitlements_user ON holiday_entitlements(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_holiday_entitlements_year ON holiday_entitlements(year)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_holiday_requests_user ON holiday_requests(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_holiday_requests_status ON holiday_requests(status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_holiday_requests_dates ON holiday_requests(start_date, end_date)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_shutdown_periods_year ON company_shutdown_periods(year)`);
        
        // Installations table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS installations (
                id SERIAL PRIMARY KEY,
                works_order_id INTEGER REFERENCES product_orders(id),
                installation_date DATE NOT NULL,
                start_time TIME NOT NULL,
                end_time TIME,
                duration_hours DECIMAL(10,2) NOT NULL,
                location VARCHAR(255),
                address TEXT,
                notes TEXT,
                status VARCHAR(50) DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
                created_by INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Installation assignments table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS installation_assignments (
                id SERIAL PRIMARY KEY,
                installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                role VARCHAR(50),
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(installation_id, user_id)
            )
        `);
        
        // Installation days table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS installation_days (
                id SERIAL PRIMARY KEY,
                installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
                day_date DATE NOT NULL,
                start_time TIME,
                end_time TIME,
                duration_hours DECIMAL(10,2),
                notes TEXT,
                UNIQUE(installation_id, day_date)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS installation_checklist_responses (
                id SERIAL PRIMARY KEY,
                installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
                checklist_type VARCHAR(32) NOT NULL CHECK(checklist_type IN ('pre_fitting', 'completion')),
                question_key VARCHAR(100) NOT NULL,
                answer BOOLEAN NOT NULL,
                updated_by INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(installation_id, checklist_type, question_key)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS installation_signoffs (
                id SERIAL PRIMARY KEY,
                installation_id INTEGER NOT NULL UNIQUE REFERENCES installations(id) ON DELETE CASCADE,
                signer_name VARCHAR(255),
                signer_phone VARCHAR(255),
                signature_data_url TEXT,
                social_media_consent BOOLEAN,
                satisfaction_emoji VARCHAR(32),
                signed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS installation_signoff_tokens (
                id SERIAL PRIMARY KEY,
                installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
                token VARCHAR(128) NOT NULL UNIQUE,
                expires_at TIMESTAMP,
                used_at TIMESTAMP,
                created_by INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS installation_photos (
                id SERIAL PRIMARY KEY,
                installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
                stage_label VARCHAR(100) NOT NULL,
                image_url TEXT NOT NULL,
                cloudinary_public_id VARCHAR(255),
                uploaded_by INTEGER REFERENCES production_users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Migrate installations table to support multi-day
        try {
            const startDateCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'installations' AND column_name = 'start_date'
            `);
            const endDateCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'installations' AND column_name = 'end_date'
            `);
            
            if (startDateCheck.rows.length === 0) {
                // Drop old index if it exists
                try {
                    await pool.query(`DROP INDEX IF EXISTS idx_installations_date`);
                } catch (error) {
                    // Index might not exist, ignore
                }
                // Rename installation_date to start_date
                await pool.query(`ALTER TABLE installations RENAME COLUMN installation_date TO start_date`);
                console.log('✅ Renamed installation_date to start_date in installations table');
            }
            
            if (endDateCheck.rows.length === 0) {
                // Add end_date column and set it to start_date for existing records
                await pool.query(`ALTER TABLE installations ADD COLUMN end_date DATE`);
                await pool.query(`UPDATE installations SET end_date = start_date WHERE end_date IS NULL`);
                console.log('✅ Added end_date column to installations table');
            }
        } catch (error) {
            console.log('⚠️ Installations migration check skipped:', error.message);
        }
        
        // Create indexes for installations (after migration)
        try {
            // Check which date column exists
            const dateColCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'installations' AND column_name IN ('start_date', 'installation_date')
            `);
            const hasStartDate = dateColCheck.rows.some(r => r.column_name === 'start_date');
            const dateColumn = hasStartDate ? 'start_date' : 'installation_date';
            
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_installations_date ON installations(${dateColumn})`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_installations_order ON installations(works_order_id)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_installations_status ON installations(status)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_installation_assignments_installation ON installation_assignments(installation_id)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_installation_assignments_user ON installation_assignments(user_id)`);
        } catch (error) {
            console.log('⚠️ Could not create installation indexes:', error.message);
        }
        
        // Create indexes for installation_days
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_installation_days_installation ON installation_days(installation_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_installation_days_date ON installation_days(day_date)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_installation_checklist_installation ON installation_checklist_responses(installation_id, checklist_type)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_installation_signoff_tokens_token ON installation_signoff_tokens(token)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_installation_photos_installation ON installation_photos(installation_id)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS daily_vehicle_inspections (
                id SERIAL PRIMARY KEY,
                inspection_date DATE NOT NULL,
                inspected_by_user_id INTEGER NOT NULL REFERENCES production_users(id),
                vehicle_registration VARCHAR(50),
                trailer_attached BOOLEAN NOT NULL DEFAULT FALSE,
                trailer_registration VARCHAR(50),
                notes TEXT,
                overall_status VARCHAR(32) NOT NULL DEFAULT 'pass' CHECK(overall_status IN ('pass', 'warning')),
                critical_fail_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(inspection_date, inspected_by_user_id)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS daily_vehicle_inspection_responses (
                id SERIAL PRIMARY KEY,
                inspection_id INTEGER NOT NULL REFERENCES daily_vehicle_inspections(id) ON DELETE CASCADE,
                section VARCHAR(20) NOT NULL CHECK(section IN ('vehicle', 'trailer')),
                question_key VARCHAR(100) NOT NULL,
                answer VARCHAR(20) NOT NULL CHECK(answer IN ('pass', 'fail', 'na')),
                is_critical BOOLEAN NOT NULL DEFAULT FALSE,
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(inspection_id, section, question_key)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_vehicle_inspections_date_user ON daily_vehicle_inspections(inspection_date, inspected_by_user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_vehicle_inspections_status ON daily_vehicle_inspections(overall_status, inspection_date)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_vehicle_responses_inspection ON daily_vehicle_inspection_responses(inspection_id, section)`);
        
        await ensurePostgresPendingAmendmentUniqueness();
        
        console.log('✅ Production PostgreSQL database initialized');
    } catch (error) {
        console.error('❌ Error initializing Production PostgreSQL:', error);
        throw error;
    }
}

// Production Database Class
class ProductionDatabase {
    // ============ USER OPERATIONS ============
    
    static async createUser(username, passwordHash, role) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO production_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING *`,
                [username, passwordHash, role]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(`INSERT INTO production_users (username, password_hash, role) VALUES (?, ?, ?)`);
            const info = stmt.run(username, passwordHash, role);
            return this.getUserById(info.lastInsertRowid);
        }
    }
    
    static async getUserByUsername(username) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM production_users WHERE username = $1`, [username]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM production_users WHERE username = ?`).get(username) || null;
        }
    }
    
    static async getUserById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM production_users WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM production_users WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getAllUsers() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT id, username, role, created_at, status FROM production_users ORDER BY created_at DESC`);
            return result.rows;
        } else {
            return db.prepare(`SELECT id, username, role, created_at, status FROM production_users ORDER BY created_at DESC`).all();
        }
    }
    
    static async updateUser(id, username, role) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE production_users SET username = $1, role = $2 WHERE id = $3 RETURNING *`,
                [username, role, id]
            );
            return result.rows[0];
        } else {
            db.prepare(`UPDATE production_users SET username = ?, role = ? WHERE id = ?`).run(username, role, id);
            return this.getUserById(id);
        }
    }
    
    static async setUserStatus(id, status) {
        if (!['active', 'left_company'].includes(status)) {
            throw new Error('Invalid status. Must be "active" or "left_company"');
        }
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE production_users SET status = $1 WHERE id = $2 RETURNING *`,
                [status, id]
            );
            return result.rows[0];
        } else {
            db.prepare(`UPDATE production_users SET status = ? WHERE id = ?`).run(status, id);
            return this.getUserById(id);
        }
    }
    
    static async updateUserPassword(id, passwordHash) {
        if (isPostgreSQL) {
            await pool.query(`UPDATE production_users SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
        } else {
            db.prepare(`UPDATE production_users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
        }
    }
    
    static async deleteUser(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM production_users WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM production_users WHERE id = ?`).run(id);
        }
    }
    
    // ============ STOCK ITEMS OPERATIONS ============
    
    static async createStockItem(data) {
        await this.ensureStockItemsSchema();
        await this.ensureStockItemsSchema();
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO stock_items (name, description, category, unit, current_quantity, min_quantity, location, cost_per_unit_gbp)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [data.name, data.description, data.category || null, data.unit, data.current_quantity || 0, data.min_quantity || 0, data.location, data.cost_per_unit_gbp || 0]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO stock_items (name, description, category, unit, current_quantity, min_quantity, location, cost_per_unit_gbp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.category || null, data.unit, data.current_quantity || 0, data.min_quantity || 0, data.location, data.cost_per_unit_gbp || 0);
            return this.getStockItemById(info.lastInsertRowid);
        }
    }
    
    static async getStockItemById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM stock_items WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM stock_items WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getAllStockItems() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM stock_items ORDER BY name`);
            return result.rows;
        } else {
            return db.prepare(`SELECT * FROM stock_items ORDER BY name`).all();
        }
    }
    
    /** Stock rows at or below minimum quantity (for dashboard alerts). */
    static async getLowStockItemsPreview(limit = 20) {
        const cap = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM stock_items
                 WHERE current_quantity::numeric <= min_quantity::numeric
                 ORDER BY name ASC
                 LIMIT $1`,
                [cap]
            );
            return result.rows;
        }
        return db.prepare(
            `SELECT * FROM stock_items
             WHERE CAST(current_quantity AS REAL) <= CAST(min_quantity AS REAL)
             ORDER BY name ASC
             LIMIT ?`
        ).all(cap);
    }
    
    /**
     * Paginated stock list.
     * @param {object} opts
     * @param {number} opts.page
     * @param {number} opts.pageSize
     * @param {string|null} opts.category exact or null
     * @param {boolean} opts.lowOnly rows where current_quantity <= min_quantity
     */
    static async getStockItemsPaged(opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        const category = opts.category && String(opts.category).trim() ? String(opts.category).trim() : null;
        const lowOnly = !!opts.lowOnly;
        const conds = [];
        const params = [];
        if (category) {
            if (isPostgreSQL) {
                params.push(category);
                conds.push(`category = $${params.length}`);
            } else {
                params.push(category);
                conds.push('category = ?');
            }
        }
        if (lowOnly) {
            if (isPostgreSQL) {
                conds.push('current_quantity::numeric <= min_quantity::numeric');
            } else {
                conds.push('CAST(current_quantity AS REAL) <= CAST(min_quantity AS REAL)');
            }
        }
        const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        let total;
        if (isPostgreSQL) {
            const countRes = await pool.query(
                `SELECT COUNT(*)::int AS c FROM stock_items ${whereSql}`,
                params
            );
            total = countRes.rows[0].c;
        } else {
            const row = db.prepare(`SELECT COUNT(*) AS c FROM stock_items ${whereSql}`).get(...params);
            total = row.c;
        }
        let items;
        if (isPostgreSQL) {
            const limitParam = params.length + 1;
            const offsetParam = params.length + 2;
            const result = await pool.query(
                `SELECT * FROM stock_items ${whereSql}
                 ORDER BY name ASC
                 LIMIT $${limitParam} OFFSET $${offsetParam}`,
                [...params, pageSize, offset]
            );
            items = result.rows;
        } else {
            items = db.prepare(
                `SELECT * FROM stock_items ${whereSql}
                 ORDER BY name ASC
                 LIMIT ? OFFSET ?`
            ).all(...params, pageSize, offset);
        }
        return { items, total, page, page_size: pageSize };
    }
    
    static async getStockCategories() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT DISTINCT category FROM stock_items
                 WHERE category IS NOT NULL AND TRIM(category) <> ''
                 ORDER BY category ASC`
            );
            return result.rows.map(r => r.category);
        }
        const rows = db.prepare(
            `SELECT DISTINCT category FROM stock_items
             WHERE category IS NOT NULL AND TRIM(category) != ''
             ORDER BY category ASC`
        ).all();
        return rows.map(r => r.category);
    }
    
    static async updateStockItem(id, data) {
        await this.ensureStockItemsSchema();
        await this.ensureStockItemsSchema();
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE stock_items SET name = $1, description = $2, category = $3, unit = $4, min_quantity = $5, location = $6, cost_per_unit_gbp = $7
                   WHERE id = $8 RETURNING *`,
                [data.name, data.description, data.category || null, data.unit, data.min_quantity, data.location, data.cost_per_unit_gbp, id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE stock_items SET name = ?, description = ?, category = ?, unit = ?, min_quantity = ?, location = ?, cost_per_unit_gbp = ?
                 WHERE id = ?`
            ).run(data.name, data.description, data.category || null, data.unit, data.min_quantity, data.location, data.cost_per_unit_gbp, id);
            return this.getStockItemById(id);
        }
    }
    
    static async deleteStockItem(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM stock_items WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM stock_items WHERE id = ?`).run(id);
        }
    }
    
    static async updateStockQuantity(id, quantity) {
        if (isPostgreSQL) {
            await pool.query(`UPDATE stock_items SET current_quantity = $1 WHERE id = $2`, [quantity, id]);
        } else {
            db.prepare(`UPDATE stock_items SET current_quantity = ? WHERE id = ?`).run(quantity, id);
        }
    }
    
    static async recordStockMovement(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO stock_movements (stock_item_id, movement_type, quantity, reference, user_id, cost_gbp)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [data.stock_item_id, data.movement_type, data.quantity, data.reference, data.user_id, data.cost_gbp || 0]
            );
            // Update stock quantity
            const stockItem = await this.getStockItemById(data.stock_item_id);
            let newQuantity = parseFloat(stockItem.current_quantity) || 0;
            if (data.movement_type === 'in') {
                newQuantity += parseFloat(data.quantity);
            } else if (data.movement_type === 'out') {
                newQuantity -= parseFloat(data.quantity);
            } else if (data.movement_type === 'adjustment') {
                newQuantity = parseFloat(data.quantity);
            }
            await this.updateStockQuantity(data.stock_item_id, newQuantity);
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO stock_movements (stock_item_id, movement_type, quantity, reference, user_id, cost_gbp)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            stmt.run(data.stock_item_id, data.movement_type, data.quantity, data.reference, data.user_id, data.cost_gbp || 0);
            // Update stock quantity
            const stockItem = this.getStockItemById(data.stock_item_id);
            let newQuantity = parseFloat(stockItem.current_quantity) || 0;
            if (data.movement_type === 'in') {
                newQuantity += parseFloat(data.quantity);
            } else if (data.movement_type === 'out') {
                newQuantity -= parseFloat(data.quantity);
            } else if (data.movement_type === 'adjustment') {
                newQuantity = parseFloat(data.quantity);
            }
            this.updateStockQuantity(data.stock_item_id, newQuantity);
            return db.prepare(`SELECT * FROM stock_movements WHERE id = (SELECT MAX(id) FROM stock_movements)`).get();
        }
    }
    
    static async getStockMovements(stockItemId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT sm.*, u.username as user_name FROM stock_movements sm
                 LEFT JOIN production_users u ON sm.user_id = u.id
                 WHERE sm.stock_item_id = $1 ORDER BY sm.timestamp DESC`,
                [stockItemId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT sm.*, u.username as user_name FROM stock_movements sm
                 LEFT JOIN production_users u ON sm.user_id = u.id
                 WHERE sm.stock_item_id = ? ORDER BY sm.timestamp DESC`
            ).all(stockItemId);
        }
    }
    
    // ============ PANELS OPERATIONS ============
    
    static async createPanel(data) {
        // Cost will be calculated automatically, but allow override for initial creation
        const initialCost = data.cost_gbp || 0;
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO panels (name, description, panel_type, status, cost_gbp, built_quantity, min_stock, max_stock, labour_hours)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [data.name, data.description, data.panel_type, data.status || 'active', initialCost, 
                 data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0]
            );
            const panel = result.rows[0];
            // Recalculate cost after creation - wrap in try-catch so cost update failures don't prevent panel creation
            try {
                await this.updatePanelCost(panel.id);
            } catch (error) {
                console.error(`Error updating panel cost after creation:`, error);
                // Continue - panel was created successfully, cost can be recalculated later
            }
            return await this.getPanelById(panel.id);
        } else {
            const stmt = db.prepare(
                `INSERT INTO panels (name, description, panel_type, status, cost_gbp, built_quantity, min_stock, max_stock, labour_hours)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.panel_type, data.status || 'active', initialCost,
                data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0);
            const panel = await this.getPanelById(info.lastInsertRowid);
            // Recalculate cost after creation - wrap in try-catch so cost update failures don't prevent panel creation
            try {
                await this.updatePanelCost(panel.id);
            } catch (error) {
                console.error(`Error updating panel cost after creation:`, error);
                // Continue - panel was created successfully, cost can be recalculated later
            }
            return await this.getPanelById(panel.id);
        }
    }
    
    static async getPanelById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM panels WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM panels WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getAllPanels() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM panels ORDER BY name`);
            return result.rows;
        } else {
            return db.prepare(`SELECT * FROM panels ORDER BY name`).all();
        }
    }
    
    static async getPanelsPaged(opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        let total;
        if (isPostgreSQL) {
            const c = await pool.query(`SELECT COUNT(*)::int AS c FROM panels`);
            total = c.rows[0].c;
            const r = await pool.query(`SELECT * FROM panels ORDER BY name ASC LIMIT $1 OFFSET $2`, [pageSize, offset]);
            return { panels: r.rows, total, page, page_size: pageSize };
        }
        const row = db.prepare(`SELECT COUNT(*) AS c FROM panels`).get();
        const rows = db.prepare(`SELECT * FROM panels ORDER BY name ASC LIMIT ? OFFSET ?`).all(pageSize, offset);
        return { panels: rows, total: row.c, page, page_size: pageSize };
    }
    
    static async updatePanel(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE panels SET name = $1, description = $2, panel_type = $3, status = $4, 
                 built_quantity = $5, min_stock = $6, max_stock = $7, labour_hours = $8
                 WHERE id = $9 RETURNING *`,
                [data.name, data.description, data.panel_type, data.status, 
                 data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0, id]
            );
            // Recalculate cost automatically (BOM + labour)
            await this.updatePanelCost(id);
            return await this.getPanelById(id);
        } else {
            db.prepare(
                `UPDATE panels SET name = ?, description = ?, panel_type = ?, status = ?,
                 built_quantity = ?, min_stock = ?, max_stock = ?, labour_hours = ?
                 WHERE id = ?`
            ).run(data.name, data.description, data.panel_type, data.status,
                data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0, id);
            // Recalculate cost automatically
            await this.updatePanelCost(id);
            return this.getPanelById(id);
        }
    }
    
    static async deletePanel(id) {
        // Ensure schema is up to date before deletion
        if (isPostgreSQL) {
            try {
                await this.ensureBOMItemsSchema();
            } catch (error) {
                console.error('Error ensuring schema before panel deletion:', error);
                // Continue - schema might already be correct
            }
        }
        
        // Check for dependencies before deletion
        const dependencies = [];
        
        if (isPostgreSQL) {
            // Check for panel movements
            const movementsResult = await pool.query(
                `SELECT COUNT(*)::int as count FROM panel_movements WHERE panel_id = $1`,
                [id]
            );
            if (movementsResult.rows[0]?.count > 0) {
                dependencies.push('movements');
            }
            
            // Check for planner items
            const plannerResult = await pool.query(
                `SELECT COUNT(*)::int as count FROM planner_items WHERE item_type = 'built_item' AND item_id = $1`,
                [id]
            );
            if (plannerResult.rows[0]?.count > 0) {
                dependencies.push('planner items');
            }
            
            // Check for product components
            const productResult = await pool.query(
                `SELECT COUNT(*)::int as count FROM product_components WHERE component_type = 'built_item' AND component_id = $1`,
                [id]
            );
            if (productResult.rows[0]?.count > 0) {
                dependencies.push('product configurations');
            }
            
            // Delete dependencies first to avoid foreign key constraint violations
            // Delete panel movements
            await pool.query(`DELETE FROM panel_movements WHERE panel_id = $1`, [id]);
            
            // Delete planner items that reference this panel
            await pool.query(`DELETE FROM planner_items WHERE item_type = 'built_item' AND item_id = $1`, [id]);
            
            // Delete product components that reference this panel
            await pool.query(`DELETE FROM product_components WHERE component_type = 'built_item' AND component_id = $1`, [id]);
            
            // BOM items will be deleted automatically via ON DELETE CASCADE
            // But first ensure schema is migrated in case CASCADE triggers schema checks
            try {
                // Now delete the panel
                await pool.query(`DELETE FROM panels WHERE id = $1`, [id]);
            } catch (error) {
                // If deletion fails due to missing column, try to migrate and retry
                if (error.message && (error.message.includes('item_type') || error.message.includes('column')) && error.message.includes('does not exist')) {
                    console.log('Schema error during panel deletion, ensuring schema is migrated...');
                    await this.ensureBOMItemsSchema();
                    // Retry deletion after migration
                    await pool.query(`DELETE FROM panels WHERE id = $1`, [id]);
                } else {
                    throw error;
                }
            }
        } else {
            // SQLite version
            const movementsStmt = db.prepare(`SELECT COUNT(*) as count FROM panel_movements WHERE panel_id = ?`);
            const movements = movementsStmt.get(id);
            if (movements && movements.count > 0) {
                dependencies.push('movements');
            }
            
            const plannerStmt = db.prepare(`SELECT COUNT(*) as count FROM planner_items WHERE item_type = 'built_item' AND item_id = ?`);
            const planner = plannerStmt.get(id);
            if (planner && planner.count > 0) {
                dependencies.push('planner items');
            }
            
            const productStmt = db.prepare(`SELECT COUNT(*) as count FROM product_components WHERE component_type = 'built_item' AND component_id = ?`);
            const product = productStmt.get(id);
            if (product && product.count > 0) {
                dependencies.push('product configurations');
            }
            
            // Delete dependencies first to avoid foreign key constraint violations
            db.prepare(`DELETE FROM panel_movements WHERE panel_id = ?`).run(id);
            db.prepare(`DELETE FROM planner_items WHERE item_type = 'built_item' AND item_id = ?`).run(id);
            db.prepare(`DELETE FROM product_components WHERE component_type = 'built_item' AND component_id = ?`).run(id);
            
            // Delete the panel (BOM items will be deleted automatically via CASCADE)
            db.prepare(`DELETE FROM panels WHERE id = ?`).run(id);
        }
    }
    
    static async duplicatePanel(sourcePanelId) {
        const source = await this.getPanelById(sourcePanelId);
        if (!source) {
            return null;
        }
        const allPanels = await this.getAllPanels();
        const baseName = source.name;
        let newName = `${baseName} (Copy)`;
        let copyNumber = 1;
        while (allPanels.some((p) => p.name === newName)) {
            copyNumber++;
            newName = `${baseName} (Copy ${copyNumber})`;
        }
        const duplicate = await this.createPanel({
            name: newName,
            description: source.description || '',
            panel_type: source.panel_type || '',
            status: source.status || 'active',
            built_quantity: 0,
            min_stock: source.min_stock || 0,
            max_stock: source.max_stock || 0,
            labour_hours: source.labour_hours || 0
        });
        const bomItems = await this.getPanelBOM(sourcePanelId);
        for (const row of bomItems) {
            await this.addBOMItem(
                duplicate.id,
                row.item_type,
                row.item_id,
                parseFloat(row.quantity_required),
                row.unit
            );
        }
        return await this.getPanelById(duplicate.id);
    }
    
    // ============ BOM OPERATIONS ============
    
    static async addBOMItem(panelId, itemType, itemId, quantityRequired, unit) {
        if (isPostgreSQL) {
            // Ensure schema is migrated before inserting
            try {
                await this.ensureBOMItemsSchema();
            } catch (error) {
                console.error('Error ensuring bom_items schema before insert:', error);
                // Continue - schema might already be correct, but this will help if it's not
            }
            
            try {
                const result = await pool.query(
                    `INSERT INTO bom_items (panel_id, item_type, item_id, quantity_required, unit)
                     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                    [panelId, itemType, itemId, quantityRequired, unit]
                );
                await this.updatePanelCost(panelId);
                return result.rows[0];
            } catch (error) {
                // If insert fails due to schema issues, try migration again
                if (error.message && (
                    (error.message.includes('item_type') || error.message.includes('item_id')) && error.message.includes('does not exist')
                    || error.message.includes('stock_item_id') && error.message.includes('violates not-null constraint')
                )) {
                    console.log('BOM insert failed due to schema issue, attempting migration...');
                    console.log('Error message:', error.message);
                    await this.ensureBOMItemsSchema();
                    // Retry insert
                    const result = await pool.query(
                        `INSERT INTO bom_items (panel_id, item_type, item_id, quantity_required, unit)
                         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                        [panelId, itemType, itemId, quantityRequired, unit]
                    );
                    await this.updatePanelCost(panelId);
                    return result.rows[0];
                }
                throw error;
            }
        } else {
            const stmt = db.prepare(
                `INSERT INTO bom_items (panel_id, item_type, item_id, quantity_required, unit)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(panelId, itemType, itemId, quantityRequired, unit);
            await this.updatePanelCost(panelId);
            return this.getBOMItemById(info.lastInsertRowid);
        }
    }
    
    static async getBOMItemById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM bom_items WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM bom_items WHERE id = ?`).get(id) || null;
        }
    }
    
    static async ensureStockItemsSchema() {

    
        if (!isPostgreSQL) return;

    
        

    
        try {

    
            await pool.query(`

    
                DO $$

    
                BEGIN

    
                    IF EXISTS (

    
                        SELECT 1 FROM information_schema.tables

    
                        WHERE table_schema = 'public' AND table_name='stock_items'

    
                    ) AND NOT EXISTS (

    
                        SELECT 1 FROM information_schema.columns

    
                        WHERE table_schema = 'public' AND table_name='stock_items' AND column_name='category'

    
                    ) THEN

    
                        ALTER TABLE stock_items ADD COLUMN category VARCHAR(255);

    
                    END IF;

    
                END $$;

    
            `);

    
        } catch (error) {

    
            console.error('Error ensuring stock_items schema:', error);

    
        }

    
    }


    
    static async ensureStockItemsSchema() {



    
        if (!isPostgreSQL) return;



    
        



    
        try {



    
            await pool.query(`



    
                DO $$



    
                BEGIN



    
                    IF EXISTS (



    
                        SELECT 1 FROM information_schema.tables



    
                        WHERE table_schema = 'public' AND table_name='stock_items'



    
                    ) AND NOT EXISTS (



    
                        SELECT 1 FROM information_schema.columns



    
                        WHERE table_schema = 'public' AND table_name='stock_items' AND column_name='category'



    
                    ) THEN



    
                        ALTER TABLE stock_items ADD COLUMN category VARCHAR(255);



    
                    END IF;



    
                END $$;



    
            `);



    
        } catch (error) {



    
            console.error('Error ensuring stock_items schema:', error);



    
        }



    
    }




    
    static async ensureBOMItemsSchema() {
        if (!isPostgreSQL) return;
        
        try {
            await pool.query(`
                DO $$ 
                BEGIN 
                    -- Add new columns if they don't exist
                    IF EXISTS (
                        SELECT 1 FROM information_schema.tables 
                        WHERE table_schema = 'public' AND table_name='bom_items'
                    ) AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='bom_items' AND column_name='item_type'
                    ) THEN
                        -- Add new columns
                        ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(20);
                        ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS item_id INTEGER;
                        
                        -- Migrate existing data from stock_item_id if it exists
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns 
                            WHERE table_schema = 'public' AND table_name='bom_items' AND column_name='stock_item_id'
                        ) THEN
                            UPDATE bom_items SET item_type = 'raw_material', item_id = stock_item_id WHERE item_id IS NULL;
                        END IF;
                        
                        -- Handle any remaining NULLs
                        UPDATE bom_items SET item_type = 'raw_material' WHERE item_type IS NULL;
                        UPDATE bom_items SET item_id = COALESCE(item_id, 0) WHERE item_id IS NULL;
                        
                        -- Make new columns NOT NULL
                        ALTER TABLE bom_items ALTER COLUMN item_type SET NOT NULL;
                        ALTER TABLE bom_items ALTER COLUMN item_id SET NOT NULL;
                        
                        -- Add CHECK constraint
                        IF NOT EXISTS (
                            SELECT 1 FROM information_schema.table_constraints 
                            WHERE table_schema = 'public' AND table_name='bom_items' 
                            AND constraint_name='bom_items_item_type_check'
                        ) THEN
                            ALTER TABLE bom_items ADD CONSTRAINT bom_items_item_type_check 
                                CHECK (item_type IN ('raw_material', 'component'));
                        END IF;
                    END IF;
                    
                    -- Make stock_item_id nullable if it exists (so inserts using new schema don't fail)
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='bom_items' 
                        AND column_name='stock_item_id' AND is_nullable = 'NO'
                    ) THEN
                        ALTER TABLE bom_items ALTER COLUMN stock_item_id DROP NOT NULL;
                    END IF;
                END $$;
            `);
        } catch (error) {
            console.error('Error ensuring bom_items schema:', error);
            throw error;
        }
    }

    static async ensurePlannerItemsSchema() {
        if (!isPostgreSQL) return;
        
        try {
            await pool.query(`
                DO $$ 
                BEGIN 
                    -- Make panel_id nullable if it exists and is NOT NULL
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='planner_items' 
                        AND column_name='panel_id' AND is_nullable = 'NO'
                    ) THEN
                        ALTER TABLE planner_items ALTER COLUMN panel_id DROP NOT NULL;
                    END IF;
                    
                    -- Add item_type and item_id if they don't exist
                    IF EXISTS (
                        SELECT 1 FROM information_schema.tables 
                        WHERE table_schema = 'public' AND table_name='planner_items'
                    ) AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='item_type'
                    ) THEN
                        ALTER TABLE planner_items ADD COLUMN item_type VARCHAR(20);
                        ALTER TABLE planner_items ADD COLUMN item_id INTEGER;
                        -- Migrate existing data
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns 
                            WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='panel_id'
                        ) THEN
                            UPDATE planner_items SET item_type = 'built_item', item_id = panel_id WHERE panel_id IS NOT NULL AND item_type IS NULL;
                        END IF;
                        -- Set default for any remaining NULLs
                        UPDATE planner_items SET item_type = 'built_item' WHERE item_type IS NULL;
                        ALTER TABLE planner_items ALTER COLUMN item_type SET NOT NULL;
                    END IF;
                    
                    -- Add job_name, start_day, end_day if they don't exist
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='job_name'
                    ) THEN
                        ALTER TABLE planner_items ADD COLUMN job_name VARCHAR(255);
                    END IF;
                    
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='start_day'
                    ) THEN
                        ALTER TABLE planner_items ADD COLUMN start_day INTEGER;
                    END IF;
                    
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name='planner_items' AND column_name='end_day'
                    ) THEN
                        ALTER TABLE planner_items ADD COLUMN end_day INTEGER;
                    END IF;
                END $$;
            `);
        } catch (error) {
            console.error('Error ensuring planner_items schema:', error);
            throw error;
        }
    }

    static async getPanelBOM(panelId) {
        if (isPostgreSQL) {
            try {
                const result = await pool.query(
                    `SELECT 
                        bom_items.id,
                        bom_items.panel_id,
                        bom_items.item_type,
                        bom_items.item_id,
                        bom_items.quantity_required,
                        bom_items.unit,
                        COALESCE(
                            CASE WHEN bom_items.item_type = 'raw_material' THEN stock_items.name END,
                            CASE WHEN bom_items.item_type = 'component' THEN components.name END,
                            'Unknown Item'
                        ) as item_name,
                        COALESCE(
                            CASE WHEN bom_items.item_type = 'raw_material' THEN stock_items.unit END,
                            CASE WHEN bom_items.item_type = 'component' THEN 'units' END,
                            bom_items.unit
                        ) as item_unit
                     FROM bom_items
                     LEFT JOIN stock_items ON bom_items.item_type = 'raw_material' AND bom_items.item_id = stock_items.id
                     LEFT JOIN components ON bom_items.item_type = 'component' AND bom_items.item_id = components.id
                     WHERE bom_items.panel_id = $1 
                     ORDER BY bom_items.item_type, COALESCE(
                         CASE WHEN bom_items.item_type = 'raw_material' THEN stock_items.name END,
                         CASE WHEN bom_items.item_type = 'component' THEN components.name END,
                         'Unknown Item'
                     )`,
                    [panelId]
                );
                return result.rows;
            } catch (error) {
                // If column doesn't exist, try to run migration and retry
                if (error.message && (error.message.includes('item_type') || error.message.includes('column')) && error.message.includes('does not exist')) {
                    console.log('item_type column missing, attempting migration...');
                    try {
                        await this.ensureBOMItemsSchema();
                        // Retry the query after migration
                        const result = await pool.query(
                            `SELECT 
                                bom_items.id,
                                bom_items.panel_id,
                                bom_items.item_type,
                                bom_items.item_id,
                                bom_items.quantity_required,
                                bom_items.unit,
                                COALESCE(
                                    CASE WHEN bom_items.item_type = 'raw_material' THEN stock_items.name END,
                                    CASE WHEN bom_items.item_type = 'component' THEN components.name END,
                                    'Unknown Item'
                                ) as item_name,
                                COALESCE(
                                    CASE WHEN bom_items.item_type = 'raw_material' THEN stock_items.unit END,
                                    CASE WHEN bom_items.item_type = 'component' THEN 'units' END,
                                    bom_items.unit
                                ) as item_unit
                             FROM bom_items
                             LEFT JOIN stock_items ON bom_items.item_type = 'raw_material' AND bom_items.item_id = stock_items.id
                             LEFT JOIN components ON bom_items.item_type = 'component' AND bom_items.item_id = components.id
                             WHERE bom_items.panel_id = $1 
                             ORDER BY bom_items.item_type, COALESCE(
                                 CASE WHEN bom_items.item_type = 'raw_material' THEN stock_items.name END,
                                 CASE WHEN bom_items.item_type = 'component' THEN components.name END,
                                 'Unknown Item'
                             )`,
                            [panelId]
                        );
                        return result.rows;
                    } catch (migrationError) {
                        console.error('Migration failed:', migrationError);
                        throw new Error('Database schema is out of date. The item_type column is missing from bom_items table. Please contact support.');
                    }
                }
                throw error;
            }
        } else {
            return db.prepare(
                `SELECT bi.*, 
                 COALESCE(
                     CASE WHEN bi.item_type = 'raw_material' THEN si.name END,
                     CASE WHEN bi.item_type = 'component' THEN c.name END,
                     'Unknown Item'
                 ) as item_name,
                 COALESCE(
                     CASE WHEN bi.item_type = 'raw_material' THEN si.unit END,
                     CASE WHEN bi.item_type = 'component' THEN 'units' END,
                     bi.unit
                 ) as item_unit
                 FROM bom_items bi
                 LEFT JOIN stock_items si ON bi.item_type = 'raw_material' AND bi.item_id = si.id
                 LEFT JOIN components c ON bi.item_type = 'component' AND bi.item_id = c.id
                 WHERE bi.panel_id = ? 
                 ORDER BY bi.item_type, COALESCE(
                     CASE WHEN bi.item_type = 'raw_material' THEN si.name END,
                     CASE WHEN bi.item_type = 'component' THEN c.name END,
                     'Unknown Item'
                 )`
            ).all(panelId);
        }
    }
    
    static async deleteBOMItem(bomId) {
        // Get panel ID before deleting
        const bomItem = await this.getBOMItemById(bomId);
        const panelId = bomItem ? bomItem.panel_id : null;
        
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM bom_items WHERE id = $1`, [bomId]);
        } else {
            db.prepare(`DELETE FROM bom_items WHERE id = ?`).run(bomId);
        }
        
        // Recalculate panel cost after BOM change
        if (panelId) {
            await this.updatePanelCost(panelId);
        }
    }
    
    // Calculate BOM value for a panel (built item)
    static async calculateBOMValue(panelId) {
        const bomItems = await this.getPanelBOM(panelId);
        let totalValue = 0;
        
        for (const bomItem of bomItems) {
            const qty = parseFloat(bomItem.quantity_required || 0);
            if (bomItem.item_type === 'raw_material') {
                const stockItem = await this.getStockItemById(bomItem.item_id);
                if (stockItem) {
                    const itemCost = parseFloat(stockItem.cost_per_unit_gbp || 0) * qty;
                    totalValue += itemCost;
                }
            } else if (bomItem.item_type === 'component') {
                const componentCost = await this.calculateComponentTrueCost(bomItem.item_id);
                totalValue += componentCost * qty;
            }
        }
        
        return totalValue;
    }
    
    // Calculate true cost (BOM + labour)
    static async calculatePanelTrueCost(panelId) {
        const panel = await this.getPanelById(panelId);
        if (!panel) return 0;
        
        const bomValue = await this.calculateBOMValue(panelId);
        const labourHours = parseFloat(panel.labour_hours || 0);
        const labourRate = await this.getSetting('labour_rate_per_hour');
        const labourCost = labourHours * parseFloat(labourRate || 25);
        
        return bomValue + labourCost;
    }
    
    // Calculate product cost from components (raw materials + components + built items) + load time labour
    static async calculateProductCost(productId) {
        const product = await this.getProductById(productId);
        if (!product) return 0;
        
        const components = await this.getProductComponents(productId);
        let totalCost = 0;
        
        for (const comp of components) {
            const compQty = parseFloat(comp.quantity_required || 0);
            
            if (comp.component_type === 'raw_material') {
                const stockItem = await this.getStockItemById(comp.component_id);
                if (stockItem) {
                    const materialCost = parseFloat(stockItem.cost_per_unit_gbp || 0) * compQty;
                    totalCost += materialCost;
                }
            } else if (comp.component_type === 'component') {
                const componentCost = await this.calculateComponentTrueCost(comp.component_id);
                totalCost += componentCost * compQty;
            } else if (comp.component_type === 'built_item') {
                // Built item (panel) true cost (BOM + labour)
                const builtItemCost = await this.calculatePanelTrueCost(comp.component_id);
                totalCost += builtItemCost * compQty;
            }
        }
        
        // Add load time labour cost
        const loadTimeHours = parseFloat(product.estimated_load_time || 0);
        if (loadTimeHours > 0) {
            const labourRate = await this.getSetting('labour_rate_per_hour');
            const loadTimeLabourCost = loadTimeHours * parseFloat(labourRate || 25);
            totalCost += loadTimeLabourCost;
        }
        
        return totalCost;
    }
    
    // Update panel cost automatically (called after BOM or labour changes)
    static async updatePanelCost(panelId) {
        const trueCost = await this.calculatePanelTrueCost(panelId);
        if (isPostgreSQL) {
            await pool.query(`UPDATE panels SET cost_gbp = $1 WHERE id = $2`, [trueCost, panelId]);
        } else {
            db.prepare(`UPDATE panels SET cost_gbp = ? WHERE id = ?`).run(trueCost, panelId);
        }
        // Recalculate all products that use this panel
        // Wrap in try-catch so recalculation failures don't block the main operation
        try {
            await this.recalculateProductsUsingPanel(panelId);
        } catch (error) {
            console.error(`Error recalculating products for panel ${panelId}:`, error);
            // Continue - don't throw, just log
        }
        return trueCost;
    }
    
    // Update product cost automatically (called after components change)
    static async updateProductCost(productId) {
        const productCost = await this.calculateProductCost(productId);
        if (isPostgreSQL) {
            await pool.query(`UPDATE finished_products SET cost_gbp = $1 WHERE id = $2`, [productCost, productId]);
        } else {
            db.prepare(`UPDATE finished_products SET cost_gbp = ? WHERE id = ?`).run(productCost, productId);
        }
        return productCost;
    }
    
    // Recalculate all products that use a specific built item (called when built item cost changes)
    static async recalculateProductsUsingPanel(panelId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT DISTINCT product_id FROM product_components 
                 WHERE component_type = 'built_item' AND component_id = $1`,
                [panelId]
            );
            for (const row of result.rows) {
                await this.updateProductCost(row.product_id);
            }
        } else {
            const products = db.prepare(
                `SELECT DISTINCT product_id FROM product_components 
                 WHERE component_type = 'built_item' AND component_id = ?`
            ).all(panelId);
            for (const product of products) {
                await this.updateProductCost(product.product_id);
            }
        }
    }
    
    // Update panel built quantity
    static async updatePanelQuantity(id, quantity) {
        if (isPostgreSQL) {
            await pool.query(`UPDATE panels SET built_quantity = $1 WHERE id = $2`, [quantity, id]);
        } else {
            db.prepare(`UPDATE panels SET built_quantity = ? WHERE id = ?`).run(quantity, id);
        }
    }
    
    // Record panel movement (built item)
    static async recordPanelMovement(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO panel_movements (panel_id, movement_type, quantity, reference, user_id)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [data.panel_id, data.movement_type, data.quantity, data.reference, data.user_id]
            );
            // Update panel quantity
            const panel = await this.getPanelById(data.panel_id);
            let newQuantity = parseFloat(panel.built_quantity) || 0;
            if (data.movement_type === 'build') {
                newQuantity += parseFloat(data.quantity);
                // Automatically deduct raw materials and components from stock
                await this.deductMaterialsForBuiltItem(data.panel_id, parseFloat(data.quantity), data.user_id, data.reference);
            } else if (data.movement_type === 'use') {
                newQuantity -= parseFloat(data.quantity);
            } else if (data.movement_type === 'adjustment') {
                newQuantity = parseFloat(data.quantity);
            }
            await this.updatePanelQuantity(data.panel_id, newQuantity);
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO panel_movements (panel_id, movement_type, quantity, reference, user_id)
                 VALUES (?, ?, ?, ?, ?)`
            );
            stmt.run(data.panel_id, data.movement_type, data.quantity, data.reference, data.user_id);
            // Update panel quantity
            const panel = this.getPanelById(data.panel_id);
            let newQuantity = parseFloat(panel.built_quantity) || 0;
            if (data.movement_type === 'build') {
                newQuantity += parseFloat(data.quantity);
                await this.deductMaterialsForBuiltItem(data.panel_id, parseFloat(data.quantity), data.user_id, data.reference);
            } else if (data.movement_type === 'use') {
                newQuantity -= parseFloat(data.quantity);
            } else if (data.movement_type === 'adjustment') {
                newQuantity = parseFloat(data.quantity);
            }
            this.updatePanelQuantity(data.panel_id, newQuantity);
            return db.prepare(`SELECT * FROM panel_movements WHERE id = (SELECT MAX(id) FROM panel_movements)`).get();
        }
    }
    
    // Deduct raw materials and components when building a built item
    static async deductMaterialsForBuiltItem(panelId, quantity, userId, reference) {
        const bomItems = await this.getPanelBOM(panelId);
        for (const bomItem of bomItems) {
            const quantityToDeduct = parseFloat(bomItem.quantity_required) * quantity;
            if (bomItem.item_type === 'raw_material') {
                await this.recordStockMovement({
                    stock_item_id: bomItem.item_id,
                    movement_type: 'out',
                    quantity: quantityToDeduct,
                    reference: `Built item build: ${reference || `Panel #${panelId}`}`,
                    user_id: userId,
                    cost_gbp: 0
                });
            } else if (bomItem.item_type === 'component') {
                // Deduct from component stock
                await this.recordComponentMovement({
                    component_id: bomItem.item_id,
                    movement_type: 'use',
                    quantity: quantityToDeduct,
                    reference: `Built item build: ${reference || `Panel #${panelId}`}`,
                    user_id: userId
                });
            }
        }
    }
    
    // Get panel movements
    static async getPanelMovements(panelId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT pm.*, u.username as user_name FROM panel_movements pm
                 LEFT JOIN production_users u ON pm.user_id = u.id
                 WHERE pm.panel_id = $1 ORDER BY pm.timestamp DESC`,
                [panelId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT pm.*, u.username as user_name FROM panel_movements pm
                 LEFT JOIN production_users u ON pm.user_id = u.id
                 WHERE pm.panel_id = ? ORDER BY pm.timestamp DESC`
            ).all(panelId);
        }
    }
    
    // Get WIP data (panels with costs)
    static async getWIPData() {
        const panels = await this.getAllPanels();
        const labourRate = parseFloat(await this.getSetting('labour_rate_per_hour') || 25);
        const wipData = [];
        
        for (const panel of panels) {
            const bomValue = await this.calculateBOMValue(panel.id);
            const labourHours = parseFloat(panel.labour_hours || 0);
            const labourCost = labourHours * labourRate;
            const trueCost = bomValue + labourCost;
            const builtQty = parseFloat(panel.built_quantity || 0);
            const minStock = parseFloat(panel.min_stock || 0);
            const wipValue = trueCost * builtQty;
            const isLowStock = builtQty <= minStock;
            
            wipData.push({
                panel_id: panel.id,
                panel_name: panel.name,
                panel_type: panel.panel_type,
                built_quantity: builtQty,
                min_stock: minStock,
                bom_value: bomValue,
                labour_hours: labourHours,
                labour_cost: labourCost,
                true_cost: trueCost,
                wip_value: wipValue,
                is_low_stock: isLowStock
            });
        }
        
        return wipData;
    }
    
    // ============ COMPONENTS OPERATIONS ============
    
    static async createComponent(data) {
        const initialCost = data.cost_gbp || 0;
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO components (name, description, component_type, status, cost_gbp, built_quantity, min_stock, max_stock, labour_hours)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [data.name, data.description, data.component_type, data.status || 'active', initialCost, 
                 data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0]
            );
            const component = result.rows[0];
            await this.updateComponentCost(component.id);
            return await this.getComponentById(component.id);
        } else {
            const stmt = db.prepare(
                `INSERT INTO components (name, description, component_type, status, cost_gbp, built_quantity, min_stock, max_stock, labour_hours)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.component_type, data.status || 'active', initialCost,
                data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0);
            const component = await this.getComponentById(info.lastInsertRowid);
            await this.updateComponentCost(component.id);
            return await this.getComponentById(component.id);
        }
    }
    
    static async getComponentById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM components WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM components WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getAllComponents() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM components ORDER BY name`);
            return result.rows;
        } else {
            return db.prepare(`SELECT * FROM components ORDER BY name`).all();
        }
    }
    
    static async getComponentsPaged(opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        if (isPostgreSQL) {
            const c = await pool.query(`SELECT COUNT(*)::int AS c FROM components`);
            const total = c.rows[0].c;
            const r = await pool.query(`SELECT * FROM components ORDER BY name ASC LIMIT $1 OFFSET $2`, [pageSize, offset]);
            return { components: r.rows, total, page, page_size: pageSize };
        }
        const row = db.prepare(`SELECT COUNT(*) AS c FROM components`).get();
        const rows = db.prepare(`SELECT * FROM components ORDER BY name ASC LIMIT ? OFFSET ?`).all(pageSize, offset);
        return { components: rows, total: row.c, page, page_size: pageSize };
    }
    
    static async updateComponent(id, data) {
        if (isPostgreSQL) {
            await pool.query(
                `UPDATE components SET name = $1, description = $2, component_type = $3, status = $4, 
                 built_quantity = $5, min_stock = $6, max_stock = $7, labour_hours = $8
                 WHERE id = $9`,
                [data.name, data.description, data.component_type, data.status, 
                 data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0, id]
            );
            await this.updateComponentCost(id);
            return await this.getComponentById(id);
        } else {
            db.prepare(
                `UPDATE components SET name = ?, description = ?, component_type = ?, status = ?,
                 built_quantity = ?, min_stock = ?, max_stock = ?, labour_hours = ?
                 WHERE id = ?`
            ).run(data.name, data.description, data.component_type, data.status,
                data.built_quantity || 0, data.min_stock || 0, data.max_stock || 0, data.labour_hours || 0, id);
            await this.updateComponentCost(id);
            return this.getComponentById(id);
        }
    }
    
    static async deleteComponent(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM components WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM components WHERE id = ?`).run(id);
        }
    }
    
    // ============ COMPONENT BOM OPERATIONS ============
    
    static async addComponentBOMItem(componentId, stockItemId, quantityRequired, unit) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO component_bom_items (component_id, stock_item_id, quantity_required, unit)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [componentId, stockItemId, quantityRequired, unit]
            );
            // Update cost - wrap in try-catch so cost update failures don't prevent BOM item addition
            try {
                await this.updateComponentCost(componentId);
            } catch (error) {
                console.error(`Error updating component cost after adding BOM item:`, error);
                // Continue - BOM item was added successfully, cost can be recalculated later
            }
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO component_bom_items (component_id, stock_item_id, quantity_required, unit)
                 VALUES (?, ?, ?, ?)`
            );
            const info = stmt.run(componentId, stockItemId, quantityRequired, unit);
            // Update cost - wrap in try-catch so cost update failures don't prevent BOM item addition
            try {
                await this.updateComponentCost(componentId);
            } catch (error) {
                console.error(`Error updating component cost after adding BOM item:`, error);
                // Continue - BOM item was added successfully, cost can be recalculated later
            }
            return this.getComponentBOMItemById(info.lastInsertRowid);
        }
    }
    
    static async getComponentBOMItemById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM component_bom_items WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM component_bom_items WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getComponentBOM(componentId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT cbi.*, si.name as stock_item_name, si.unit as stock_item_unit
                 FROM component_bom_items cbi
                 JOIN stock_items si ON cbi.stock_item_id = si.id
                 WHERE cbi.component_id = $1 ORDER BY si.name`,
                [componentId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT cbi.*, si.name as stock_item_name, si.unit as stock_item_unit
                 FROM component_bom_items cbi
                 JOIN stock_items si ON cbi.stock_item_id = si.id
                 WHERE cbi.component_id = ? ORDER BY si.name`
            ).all(componentId);
        }
    }
    
    static async deleteComponentBOMItem(bomId) {
        const bomItem = await this.getComponentBOMItemById(bomId);
        const componentId = bomItem ? bomItem.component_id : null;
        
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM component_bom_items WHERE id = $1`, [bomId]);
        } else {
            db.prepare(`DELETE FROM component_bom_items WHERE id = ?`).run(bomId);
        }
        
        if (componentId) {
            await this.updateComponentCost(componentId);
        }
    }
    
    static async calculateComponentBOMValue(componentId) {
        const bomItems = await this.getComponentBOM(componentId);
        let totalValue = 0;
        
        for (const bomItem of bomItems) {
            const stockItem = await this.getStockItemById(bomItem.stock_item_id);
            if (stockItem) {
                const itemCost = parseFloat(stockItem.cost_per_unit_gbp || 0) * parseFloat(bomItem.quantity_required || 0);
                totalValue += itemCost;
            }
        }
        
        return totalValue;
    }
    
    static async calculateComponentTrueCost(componentId) {
        const component = await this.getComponentById(componentId);
        if (!component) return 0;
        
        const bomValue = await this.calculateComponentBOMValue(componentId);
        const labourHours = parseFloat(component.labour_hours || 0);
        const labourRate = await this.getSetting('labour_rate_per_hour');
        const labourCost = labourHours * parseFloat(labourRate || 25);
        
        return bomValue + labourCost;
    }
    
    static async updateComponentCost(componentId) {
        const trueCost = await this.calculateComponentTrueCost(componentId);
        if (isPostgreSQL) {
            await pool.query(`UPDATE components SET cost_gbp = $1 WHERE id = $2`, [trueCost, componentId]);
        } else {
            db.prepare(`UPDATE components SET cost_gbp = ? WHERE id = ?`).run(trueCost, componentId);
        }
        // Recalculate all built items and products that use this component
        // Wrap in try-catch so recalculation failures don't block the main operation
        try {
            await this.recalculateBuiltItemsUsingComponent(componentId);
        } catch (error) {
            console.error(`Error recalculating built items for component ${componentId}:`, error);
            // Continue - don't throw, just log
        }
        try {
            await this.recalculateProductsUsingComponent(componentId);
        } catch (error) {
            console.error(`Error recalculating products for component ${componentId}:`, error);
            // Continue - don't throw, just log
        }
        return trueCost;
    }
    
    static async updateComponentQuantity(id, quantity) {
        if (isPostgreSQL) {
            await pool.query(`UPDATE components SET built_quantity = $1 WHERE id = $2`, [quantity, id]);
        } else {
            db.prepare(`UPDATE components SET built_quantity = ? WHERE id = ?`).run(quantity, id);
        }
    }
    
    static async recordComponentMovement(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO component_movements (component_id, movement_type, quantity, reference, user_id)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [data.component_id, data.movement_type, data.quantity, data.reference, data.user_id]
            );
            
            // Update component quantity
            const component = await this.getComponentById(data.component_id);
            let newQuantity = parseFloat(component.built_quantity) || 0;
            if (data.movement_type === 'build') {
                newQuantity += parseFloat(data.quantity);
                // Automatically deduct raw materials from stock
                await this.deductRawMaterialsForComponent(data.component_id, parseFloat(data.quantity), data.user_id, data.reference);
            } else if (data.movement_type === 'use') {
                newQuantity -= parseFloat(data.quantity);
            } else if (data.movement_type === 'adjustment') {
                newQuantity = parseFloat(data.quantity);
            }
            await this.updateComponentQuantity(data.component_id, newQuantity);
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO component_movements (component_id, movement_type, quantity, reference, user_id)
                 VALUES (?, ?, ?, ?, ?)`
            );
            stmt.run(data.component_id, data.movement_type, data.quantity, data.reference, data.user_id);
            
            const component = this.getComponentById(data.component_id);
            let newQuantity = parseFloat(component.built_quantity) || 0;
            if (data.movement_type === 'build') {
                newQuantity += parseFloat(data.quantity);
                await this.deductRawMaterialsForComponent(data.component_id, parseFloat(data.quantity), data.user_id, data.reference);
            } else if (data.movement_type === 'use') {
                newQuantity -= parseFloat(data.quantity);
            } else if (data.movement_type === 'adjustment') {
                newQuantity = parseFloat(data.quantity);
            }
            this.updateComponentQuantity(data.component_id, newQuantity);
            return db.prepare(`SELECT * FROM component_movements WHERE id = (SELECT MAX(id) FROM component_movements)`).get();
        }
    }
    
    static async getComponentMovements(componentId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT cm.*, u.username as user_name FROM component_movements cm
                 LEFT JOIN production_users u ON cm.user_id = u.id
                 WHERE cm.component_id = $1 ORDER BY cm.timestamp DESC`,
                [componentId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT cm.*, u.username as user_name FROM component_movements cm
                 LEFT JOIN production_users u ON cm.user_id = u.id
                 WHERE cm.component_id = ? ORDER BY cm.timestamp DESC`
            ).all(componentId);
        }
    }
    
    // Deduct raw materials when building a component
    static async deductRawMaterialsForComponent(componentId, quantity, userId, reference) {
        const bomItems = await this.getComponentBOM(componentId);
        for (const bomItem of bomItems) {
            const quantityToDeduct = parseFloat(bomItem.quantity_required) * quantity;
            await this.recordStockMovement({
                stock_item_id: bomItem.stock_item_id,
                movement_type: 'out',
                quantity: quantityToDeduct,
                reference: `Component build: ${reference || `Component #${componentId}`}`,
                user_id: userId,
                cost_gbp: 0
            });
        }
    }
    
    static async recalculateBuiltItemsUsingComponent(componentId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT DISTINCT panel_id FROM bom_items 
                 WHERE item_type = 'component' AND item_id = $1`,
                [componentId]
            );
            for (const row of result.rows) {
                await this.updatePanelCost(row.panel_id);
            }
        } else {
            const builtItems = db.prepare(
                `SELECT DISTINCT panel_id FROM bom_items 
                 WHERE item_type = 'component' AND item_id = ?`
            ).all(componentId);
            for (const builtItem of builtItems) {
                await this.updatePanelCost(builtItem.panel_id);
            }
        }
    }
    
    static async recalculateProductsUsingComponent(componentId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT DISTINCT product_id FROM product_components 
                 WHERE component_type = 'component' AND component_id = $1`,
                [componentId]
            );
            for (const row of result.rows) {
                await this.updateProductCost(row.product_id);
            }
        } else {
            const products = db.prepare(
                `SELECT DISTINCT product_id FROM product_components 
                 WHERE component_type = 'component' AND component_id = ?`
            ).all(componentId);
            for (const product of products) {
                await this.updateProductCost(product.product_id);
            }
        }
    }
    
    // ============ PLANNER OPERATIONS ============
    
    static async createWeeklyPlanner(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO weekly_planner (week_start_date, staff_available, hours_available, notes)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [data.week_start_date, data.staff_available || 1, data.hours_available || 40, data.notes]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO weekly_planner (week_start_date, staff_available, hours_available, notes)
                 VALUES (?, ?, ?, ?)`
            );
            const info = stmt.run(data.week_start_date, data.staff_available || 1, data.hours_available || 40, data.notes);
            return this.getWeeklyPlannerById(info.lastInsertRowid);
        }
    }
    
    static async getWeeklyPlannerById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM weekly_planner WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM weekly_planner WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getWeeklyPlannerByDate(weekStartDate) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM weekly_planner WHERE week_start_date = $1`, [weekStartDate]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM weekly_planner WHERE week_start_date = ?`).get(weekStartDate) || null;
        }
    }
    
    static async getAllWeeklyPlanners(startDate, endDate) {
        if (isPostgreSQL) {
            if (startDate && endDate) {
                const result = await pool.query(
                    `SELECT * FROM weekly_planner WHERE week_start_date BETWEEN $1 AND $2 ORDER BY week_start_date`,
                    [startDate, endDate]
                );
                return result.rows;
            } else {
                const result = await pool.query(`SELECT * FROM weekly_planner ORDER BY week_start_date DESC LIMIT 12`);
                return result.rows;
            }
        } else {
            if (startDate && endDate) {
                return db.prepare(
                    `SELECT * FROM weekly_planner WHERE week_start_date BETWEEN ? AND ? ORDER BY week_start_date`
                ).all(startDate, endDate);
            } else {
                return db.prepare(`SELECT * FROM weekly_planner ORDER BY week_start_date DESC LIMIT 12`).all();
            }
        }
    }
    
    static async updateWeeklyPlanner(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE weekly_planner SET staff_available = $1, hours_available = $2, notes = $3
                 WHERE id = $4 RETURNING *`,
                [data.staff_available, data.hours_available, data.notes, id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE weekly_planner SET staff_available = ?, hours_available = ?, notes = ?
                 WHERE id = ?`
            ).run(data.staff_available, data.hours_available, data.notes, id);
            return this.getWeeklyPlannerById(id);
        }
    }
    
    static async deleteWeeklyPlanner(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM weekly_planner WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM weekly_planner WHERE id = ?`).run(id);
        }
    }
    
    static async addPlannerItem(plannerId, itemType, itemId, quantityToBuild, priority, status, jobName = null, startDay = null, endDay = null) {
        if (isPostgreSQL) {
            // Check which columns exist
            const columnCheck = await pool.query(`
                SELECT column_name, is_nullable
                FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = 'planner_items' 
                AND column_name IN ('item_type', 'item_id', 'job_name', 'start_day', 'end_day', 'panel_id')
            `);
            const existingColumns = columnCheck.rows.map(r => r.column_name);
            const columnInfo = {};
            columnCheck.rows.forEach(row => {
                columnInfo[row.column_name] = { exists: true, nullable: row.is_nullable === 'YES' };
            });
            
            let hasItemType = existingColumns.includes('item_type');
            let hasItemId = existingColumns.includes('item_id');
            const hasJobName = existingColumns.includes('job_name');
            const hasStartDay = existingColumns.includes('start_day');
            const hasEndDay = existingColumns.includes('end_day');
            const hasPanelId = existingColumns.includes('panel_id');
            const panelIdNullable = hasPanelId && columnInfo['panel_id']?.nullable;
            
            // If old schema (panel_id exists but item_type doesn't), ensure migration runs
            if (hasPanelId && !hasItemType) {
                try {
                    // Run migration to add item_type/item_id and make panel_id nullable
                    await this.ensurePlannerItemsSchema();
                    // Re-check columns after migration
                    const newColumnCheck = await pool.query(`
                        SELECT column_name 
                        FROM information_schema.columns 
                        WHERE table_schema = 'public' AND table_name = 'planner_items' 
                        AND column_name IN ('item_type', 'item_id', 'panel_id')
                    `);
                    const newColumns = newColumnCheck.rows.map(r => r.column_name);
                    if (newColumns.includes('item_type')) {
                        // Migration succeeded, use new schema
                        hasItemType = true;
                        if (newColumns.includes('item_id')) {
                            hasItemId = true;
                        }
                    }
                } catch (migrationError) {
                    console.error('Error migrating planner_items schema:', migrationError);
                    // Continue with old schema handling - ensure panel_id is provided if required
                    if (hasPanelId && !panelIdNullable && itemType === 'built_item' && itemId) {
                        // Can still use panel_id for built_item
                    } else if (hasPanelId && !panelIdNullable) {
                        throw new Error('Database schema needs migration. Cannot add ' + itemType + ' items. Please contact support or restart the server.');
                    }
                }
            }
            
            // Build INSERT statement based on available columns
            let columns = ['planner_id', 'quantity_to_build', 'priority', 'status'];
            let values = [plannerId, quantityToBuild, priority || 'medium', status || 'planned'];
            
            if (hasItemType && itemType) {
                columns.push('item_type');
                values.push(itemType);
            }
            
            if (hasItemId) {
                columns.push('item_id');
                values.push(itemId || null);
            } else if (hasPanelId && itemType === 'built_item' && itemId) {
                // Fallback to panel_id for old schema (if panel_id is nullable or we can provide it)
                columns.push('panel_id');
                values.push(itemId);
            } else if (hasPanelId && !panelIdNullable && itemType === 'job') {
                // For jobs in old schema, we can't use panel_id - this is an error condition
                throw new Error('Cannot add job items: database schema needs migration. Please contact support.');
            }
            
            if (hasJobName) {
                columns.push('job_name');
                values.push(jobName || null);
            }
            
            if (hasStartDay) {
                columns.push('start_day');
                values.push(startDay);
            }
            
            if (hasEndDay) {
                columns.push('end_day');
                values.push(endDay);
            }
            
            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
            const columnsList = columns.join(', ');
            
            const result = await pool.query(
                `INSERT INTO planner_items (${columnsList})
                 VALUES (${placeholders}) RETURNING *`,
                values
            );
            return result.rows[0];
        } else {
            // SQLite - check columns
            const plannerColumns = db.prepare("PRAGMA table_info(planner_items)").all();
            const plannerColumnNames = plannerColumns.map(col => col.name);
            const hasItemType = plannerColumnNames.includes('item_type');
            const hasItemId = plannerColumnNames.includes('item_id');
            const hasJobName = plannerColumnNames.includes('job_name');
            const hasStartDay = plannerColumnNames.includes('start_day');
            const hasEndDay = plannerColumnNames.includes('end_day');
            const hasPanelId = plannerColumnNames.includes('panel_id');
            
            // Build INSERT statement
            let columns = ['planner_id', 'quantity_to_build', 'priority', 'status'];
            let values = [plannerId, quantityToBuild, priority || 'medium', status || 'planned'];
            
            if (hasItemType) {
                columns.push('item_type');
                values.push(itemType);
            }
            
            if (hasItemId) {
                columns.push('item_id');
                values.push(itemId || null);
            } else if (hasPanelId) {
                // For old schema
                if (itemType === 'built_item' && itemId) {
                    columns.push('panel_id');
                    values.push(itemId);
                } else {
                    // For components/jobs, check if panel_id column allows NULL
                    // In SQLite, we can check the column definition
                    const panelIdCol = plannerColumns.find(col => col.name === 'panel_id');
                    const allowsNull = !panelIdCol || panelIdCol.notnull === 0;
                    if (allowsNull) {
                        columns.push('panel_id');
                        values.push(null);
                    }
                    // If NOT NULL, skip it - migration should handle it
                }
            }
            
            if (hasJobName) {
                columns.push('job_name');
                values.push(jobName || null);
            }
            
            if (hasStartDay) {
                columns.push('start_day');
                values.push(startDay);
            }
            
            if (hasEndDay) {
                columns.push('end_day');
                values.push(endDay);
            }
            
            const placeholders = values.map(() => '?').join(', ');
            const columnsList = columns.join(', ');
            
            const stmt = db.prepare(
                `INSERT INTO planner_items (${columnsList})
                 VALUES (${placeholders})`
            );
            const info = stmt.run(...values);
            return this.getPlannerItemById(info.lastInsertRowid);
        }
    }
    
    static async getPlannerItemById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM planner_items WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM planner_items WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getPlannerItems(plannerId) {
        if (isPostgreSQL) {
            // Check which columns exist for backward compatibility
            const columnCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'planner_items' 
                AND column_name IN ('panel_id', 'item_type', 'item_id', 'job_name')
            `);
            const existingColumns = columnCheck.rows.map(r => r.column_name);
            const hasPanelId = existingColumns.includes('panel_id');
            const hasItemType = existingColumns.includes('item_type');
            const hasItemId = existingColumns.includes('item_id');
            const hasJobName = existingColumns.includes('job_name');
            
            // Build query based on what columns exist
            if (!hasItemType) {
                // Old schema - only panel_id exists
                const result = await pool.query(
                    `SELECT pi.*, 
                     p.name as item_name,
                     p.labour_hours,
                     p.min_stock,
                     p.max_stock,
                     p.built_quantity,
                     p.id as item_id_for_movement
                     FROM planner_items pi
                     LEFT JOIN panels p ON pi.panel_id = p.id
                     WHERE pi.planner_id = $1 ORDER BY pi.priority DESC, pi.created_at`,
                    [plannerId]
                );
                // Add default values for new columns
                return result.rows.map(row => ({
                    ...row,
                    item_type: 'built_item',
                    item_id: row.panel_id,
                    job_name: null,
                    start_day: null,
                    end_day: null
                }));
            }
            
            // New schema - build dynamic query
            let itemNameCase = `CASE 
                WHEN pi.item_type = 'component' THEN c.name
                WHEN pi.item_type = 'built_item' THEN p.name`;
            if (hasJobName) {
                itemNameCase += `\n                WHEN pi.item_type = 'job' THEN pi.job_name`;
            }
            if (hasPanelId) {
                itemNameCase += `\n                WHEN pi.item_type IS NULL THEN p.name`;
            }
            itemNameCase += `\n            END as item_name`;
            
            let labourHoursCase = `CASE 
                WHEN pi.item_type = 'component' THEN c.labour_hours
                WHEN pi.item_type = 'built_item' THEN p.labour_hours`;
            if (hasJobName) {
                labourHoursCase += `\n                WHEN pi.item_type = 'job' THEN pi.quantity_to_build`;
            }
            if (hasPanelId) {
                labourHoursCase += `\n                WHEN pi.item_type IS NULL THEN p.labour_hours`;
            }
            labourHoursCase += `\n            END as labour_hours`;
            
            let joinCondition = `pi.item_type = 'built_item' AND pi.item_id = p.id`;
            if (hasPanelId) {
                joinCondition += ` OR (pi.item_type IS NULL AND pi.panel_id = p.id)`;
            }
            
            let query = `SELECT pi.*, 
                ${itemNameCase},
                ${labourHoursCase},
                CASE 
                    WHEN pi.item_type = 'component' THEN c.min_stock
                    WHEN pi.item_type = 'built_item' THEN p.min_stock
                    ${hasPanelId ? `WHEN pi.item_type IS NULL THEN p.min_stock` : ''}
                END as min_stock,
                CASE 
                    WHEN pi.item_type = 'component' THEN c.built_quantity
                    WHEN pi.item_type = 'built_item' THEN p.built_quantity
                    ${hasPanelId ? `WHEN pi.item_type IS NULL THEN p.built_quantity` : ''}
                END as built_quantity,
                CASE 
                    WHEN pi.item_type = 'component' THEN c.max_stock
                    WHEN pi.item_type = 'built_item' THEN p.max_stock
                    ${hasPanelId ? `WHEN pi.item_type IS NULL THEN p.max_stock` : ''}
                END as max_stock,
                CASE 
                    WHEN pi.item_type = 'component' THEN c.id
                    WHEN pi.item_type = 'built_item' THEN p.id
                    ${hasPanelId ? `WHEN pi.item_type IS NULL THEN p.id` : ''}
                END as item_id_for_movement
                FROM planner_items pi
                LEFT JOIN components c ON pi.item_type = 'component' AND pi.item_id = c.id
                LEFT JOIN panels p ON ${joinCondition}
                WHERE pi.planner_id = $1 ORDER BY pi.priority DESC, pi.created_at`;
            
            const result = await pool.query(query, [plannerId]);
            return result.rows;
        } else {
            return db.prepare(
                `SELECT pi.*, 
                 CASE 
                     WHEN pi.item_type = 'component' THEN c.name
                     WHEN pi.item_type = 'built_item' THEN p.name
                     WHEN pi.item_type = 'job' THEN pi.job_name
                     WHEN pi.item_type IS NULL THEN p.name
                 END as item_name,
                 CASE 
                     WHEN pi.item_type = 'component' THEN c.labour_hours
                     WHEN pi.item_type = 'built_item' THEN p.labour_hours
                     WHEN pi.item_type = 'job' THEN pi.quantity_to_build
                     WHEN pi.item_type IS NULL THEN p.labour_hours
                 END as labour_hours,
                 CASE 
                     WHEN pi.item_type = 'component' THEN c.min_stock
                     WHEN pi.item_type = 'built_item' THEN p.min_stock
                     WHEN pi.item_type IS NULL THEN p.min_stock
                 END as min_stock,
                 CASE 
                     WHEN pi.item_type = 'component' THEN c.built_quantity
                     WHEN pi.item_type = 'built_item' THEN p.built_quantity
                     WHEN pi.item_type IS NULL THEN p.built_quantity
                 END as built_quantity,
                 CASE 
                     WHEN pi.item_type = 'component' THEN c.max_stock
                     WHEN pi.item_type = 'built_item' THEN p.max_stock
                     WHEN pi.item_type IS NULL THEN p.max_stock
                 END as max_stock,
                 CASE 
                     WHEN pi.item_type = 'component' THEN c.id
                     WHEN pi.item_type = 'built_item' THEN p.id
                     WHEN pi.item_type IS NULL THEN p.id
                 END as item_id_for_movement
                 FROM planner_items pi
                 LEFT JOIN components c ON pi.item_type = 'component' AND pi.item_id = c.id
                 LEFT JOIN panels p ON (pi.item_type = 'built_item' AND pi.item_id = p.id) OR (pi.item_type IS NULL AND pi.panel_id = p.id)
                 WHERE pi.planner_id = ? ORDER BY pi.priority DESC, pi.created_at`
            ).all(plannerId);
        }
    }
    
    static async updatePlannerItem(id, data) {
        // Get current item to check previous status and item details
        const currentItem = await this.getPlannerItemById(id);
        if (!currentItem) {
            throw new Error('Planner item not found');
        }
        
        const previousStatus = currentItem.status;
        const quantityBuilt = data.quantity_built !== undefined ? data.quantity_built : (currentItem.quantity_built || 0);
        
        // Check if status is changing to completed and we have quantity_built
        const statusChangingToCompleted = data.status === 'completed' && 
            previousStatus !== 'completed' &&
            parseFloat(quantityBuilt) > 0;
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE planner_items SET quantity_to_build = $1, quantity_built = $2, hours_used = $3, priority = $4, status = $5, start_day = $6, end_day = $7
                 WHERE id = $8 RETURNING *`,
                [
                    data.quantity_to_build,
                    data.quantity_built !== undefined ? data.quantity_built : null,
                    data.hours_used !== undefined ? data.hours_used : null,
                    data.priority,
                    data.status,
                    data.start_day !== undefined ? data.start_day : null,
                    data.end_day !== undefined ? data.end_day : null,
                    id
                ]
            );
            const updatedItem = result.rows[0];
            
            // If status changed to completed and quantity_built > 0, depreciate stock
            if (statusChangingToCompleted) {
                // Handle both new schema (item_type/item_id) and old schema (panel_id)
                const itemType = updatedItem.item_type || (updatedItem.panel_id ? 'built_item' : null);
                const itemId = updatedItem.item_id || updatedItem.panel_id;
                const userId = null; // Planner items don't track user_id directly
                
                if (itemType === 'component' && itemId) {
                    // Record component build movement (automatically depreciates raw materials)
                    await this.recordComponentMovement({
                        component_id: itemId,
                        movement_type: 'build',
                        quantity: parseFloat(quantityBuilt),
                        reference: `Planner Item #${id}`,
                        user_id: userId
                    });
                    console.log(`✅ Depreciated stock for component build in planner item #${id} (quantity: ${quantityBuilt})`);
                } else if ((itemType === 'built_item' || updatedItem.panel_id) && itemId) {
                    // Record panel build movement (automatically depreciates materials and components)
                    await this.recordPanelMovement({
                        panel_id: itemId,
                        movement_type: 'build',
                        quantity: parseFloat(quantityBuilt),
                        reference: `Planner Item #${id}`,
                        user_id: userId
                    });
                    console.log(`✅ Depreciated stock for built item build in planner item #${id} (quantity: ${quantityBuilt})`);
                }
            }
            
            return updatedItem;
        } else {
            db.prepare(
                `UPDATE planner_items SET quantity_to_build = ?, quantity_built = ?, hours_used = ?, priority = ?, status = ?, start_day = ?, end_day = ?
                 WHERE id = ?`
            ).run(
                data.quantity_to_build,
                data.quantity_built !== undefined ? data.quantity_built : null,
                data.hours_used !== undefined ? data.hours_used : null,
                data.priority,
                data.status,
                data.start_day !== undefined ? data.start_day : null,
                data.end_day !== undefined ? data.end_day : null,
                id
            );
            const updatedItem = await this.getPlannerItemById(id);
            
            // If status changed to completed and quantity_built > 0, depreciate stock
            if (statusChangingToCompleted) {
                // Handle both new schema (item_type/item_id) and old schema (panel_id)
                const itemType = updatedItem.item_type || (updatedItem.panel_id ? 'built_item' : null);
                const itemId = updatedItem.item_id || updatedItem.panel_id;
                const userId = null; // Planner items don't track user_id directly
                
                if (itemType === 'component' && itemId) {
                    // Record component build movement (automatically depreciates raw materials)
                    await this.recordComponentMovement({
                        component_id: itemId,
                        movement_type: 'build',
                        quantity: parseFloat(quantityBuilt),
                        reference: `Planner Item #${id}`,
                        user_id: userId
                    });
                    console.log(`✅ Depreciated stock for component build in planner item #${id} (quantity: ${quantityBuilt})`);
                } else if ((itemType === 'built_item' || updatedItem.panel_id) && itemId) {
                    // Record panel build movement (automatically depreciates materials and components)
                    await this.recordPanelMovement({
                        panel_id: itemId,
                        movement_type: 'build',
                        quantity: parseFloat(quantityBuilt),
                        reference: `Planner Item #${id}`,
                        user_id: userId
                    });
                    console.log(`✅ Depreciated stock for built item build in planner item #${id} (quantity: ${quantityBuilt})`);
                }
            }
            
            return updatedItem;
        }
    }
    
    static async calculatePlannerEfficiency(plannerId) {
        const planner = await this.getWeeklyPlannerById(plannerId);
        if (!planner) return null;
        
        const items = await this.getPlannerItems(plannerId);
        let totalHoursPlanned = 0;
        let totalHoursUsed = 0;
        let totalPanelsPlanned = 0;
        let totalPanelsBuilt = 0;
        
        for (const item of items) {
            const labourHours = parseFloat(item.labour_hours || 0);
            const qtyPlanned = parseFloat(item.quantity_to_build || 0);
            const qtyBuilt = parseFloat(item.quantity_built || 0);
            const hoursUsed = parseFloat(item.hours_used || 0);
            
            totalHoursPlanned += labourHours * qtyPlanned;
            totalHoursUsed += hoursUsed;
            totalPanelsPlanned += qtyPlanned;
            totalPanelsBuilt += qtyBuilt;
        }
        
        const hoursAvailable = parseFloat(planner.hours_available || 0);
        
        // Calculate expected hours based on what was actually built
        let totalExpectedHours = 0;
        for (const item of items) {
            const labourHours = parseFloat(item.labour_hours || 0);
            const qtyBuilt = parseFloat(item.quantity_built || 0);
            totalExpectedHours += labourHours * qtyBuilt;
        }
        
        // Efficiency calculations
        // Hours efficiency: expected hours (based on built panels) vs actual hours used
        const hoursEfficiency = totalHoursUsed > 0 ? (totalExpectedHours / totalHoursUsed) * 100 : (totalExpectedHours > 0 ? 0 : 100);
        // Panels efficiency: built vs planned
        const panelsEfficiency = totalPanelsPlanned > 0 ? (totalPanelsBuilt / totalPanelsPlanned) * 100 : 0;
        
        // Overall efficiency (average of hours and panels)
        const overallEfficiency = totalHoursUsed > 0 || totalPanelsPlanned > 0 ? (hoursEfficiency + panelsEfficiency) / 2 : 100;
        
        // Determine indicator
        let indicator = 'green';
        let emoji = '😊';
        if (overallEfficiency < 80) {
            indicator = 'red';
            emoji = '😟';
        } else if (overallEfficiency < 95) {
            indicator = 'yellow';
            emoji = '😐';
        }
        
        return {
            hours_available: hoursAvailable,
            hours_planned: totalHoursPlanned,
            hours_used: totalHoursUsed,
            hours_efficiency: hoursEfficiency,
            panels_planned: totalPanelsPlanned,
            panels_built: totalPanelsBuilt,
            panels_efficiency: panelsEfficiency,
            overall_efficiency: overallEfficiency,
            indicator: indicator,
            emoji: emoji
        };
    }
    
    static async deletePlannerItem(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM planner_items WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM planner_items WHERE id = ?`).run(id);
        }
    }
    
    static async calculatePlannerBuildRate(plannerId) {
        const planner = await this.getWeeklyPlannerById(plannerId);
        if (!planner) return null;
        
        const items = await this.getPlannerItems(plannerId);
        let totalHoursRequired = 0;
        
        for (const item of items) {
            if (item.item_type === 'job') {
                // For jobs, quantity_to_build IS the hours required
                totalHoursRequired += parseFloat(item.quantity_to_build || 0);
            } else {
                // For components/built items, multiply labour hours by quantity
                const labourHours = parseFloat(item.labour_hours || 0);
                const quantity = parseFloat(item.quantity_to_build || 0);
                totalHoursRequired += labourHours * quantity;
            }
        }
        
        const hoursAvailable = parseFloat(planner.hours_available || 0);
        // Calculate build rate as hours_required / hours_available * 100
        // This shows what percentage of available hours are being used
        const buildRate = hoursAvailable > 0 ? (totalHoursRequired / hoursAvailable) * 100 : (totalHoursRequired > 0 ? 100 : 0);
        
        // Color logic: under 80% = red (inefficient), above 80% = green (good utilization)
        const indicator = buildRate >= 80 ? 'green' : 'red';
        const emoji = buildRate >= 80 ? '😊' : '😐';
        
        return {
            hours_available: hoursAvailable,
            hours_required: totalHoursRequired,
            hours_shortfall: Math.max(0, totalHoursRequired - hoursAvailable),
            hours_excess: Math.max(0, hoursAvailable - totalHoursRequired),
            build_rate_percent: buildRate,
            is_feasible: totalHoursRequired <= hoursAvailable,
            indicator: indicator,
            emoji: emoji
        };
    }
    
    static async getLowStockPanels() {
        const panels = await this.getAllPanels();
        const lowStockPanels = [];
        
        for (const panel of panels) {
            const builtQty = parseFloat(panel.built_quantity || 0);
            const minStock = parseFloat(panel.min_stock || 0);
            const maxStock = parseFloat(panel.max_stock || 0);
            
            // Include items that are at or below minimum stock, or items with zero stock
            if ((minStock > 0 && builtQty <= minStock) || (minStock === 0 && builtQty === 0)) {
                let shortfall = 0;
                let suggestedQuantity = 0;
                
                if (minStock > 0) {
                    // Item has a minimum stock set - calculate shortfall and suggest quantity
                    shortfall = minStock - builtQty;
                    // Suggest building enough to reach minimum + 20% buffer, but at least 1
                    const baseQuantity = Math.ceil(shortfall * 1.2);
                    suggestedQuantity = Math.max(1, baseQuantity);
                } else {
                    // No minimum stock set but item has zero stock - suggest building at least 1
                    shortfall = 0;
                    suggestedQuantity = 1;
                }
                
                // Cap suggested quantity at max_stock when max_stock is set
                if (maxStock > 0) {
                    const cap = Math.max(0, maxStock - builtQty);
                    suggestedQuantity = Math.min(suggestedQuantity, cap);
                }
                
                // Skip if nothing to build (e.g. already at max_stock)
                if (suggestedQuantity <= 0) continue;
                
                lowStockPanels.push({
                    ...panel,
                    item_type: 'built_item',
                    current_quantity: builtQty,
                    min_stock: minStock,
                    max_stock: maxStock,
                    shortfall: shortfall,
                    suggested_quantity: suggestedQuantity
                });
            }
        }
        
        return lowStockPanels;
    }
    
    static async getLowStockComponents() {
        const components = await this.getAllComponents();
        const lowStockComponents = [];
        
        for (const component of components) {
            const builtQty = parseFloat(component.built_quantity || 0);
            const minStock = parseFloat(component.min_stock || 0);
            const maxStock = parseFloat(component.max_stock || 0);
            
            // Include items that are at or below minimum stock, or items with zero stock
            if ((minStock > 0 && builtQty <= minStock) || (minStock === 0 && builtQty === 0)) {
                let shortfall = 0;
                let suggestedQuantity = 0;
                
                if (minStock > 0) {
                    // Item has a minimum stock set - calculate shortfall and suggest quantity
                    shortfall = minStock - builtQty;
                    // Suggest building enough to reach minimum + 20% buffer, but at least 1
                    const baseQuantity = Math.ceil(shortfall * 1.2);
                    suggestedQuantity = Math.max(1, baseQuantity);
                } else {
                    // No minimum stock set but item has zero stock - suggest building at least 1
                    shortfall = 0;
                    suggestedQuantity = 1;
                }
                
                // Cap suggested quantity at max_stock when max_stock is set
                if (maxStock > 0) {
                    const cap = Math.max(0, maxStock - builtQty);
                    suggestedQuantity = Math.min(suggestedQuantity, cap);
                }
                
                // Skip if nothing to build (e.g. already at max_stock)
                if (suggestedQuantity <= 0) continue;
                
                lowStockComponents.push({
                    ...component,
                    item_type: 'component',
                    current_quantity: builtQty,
                    min_stock: minStock,
                    max_stock: maxStock,
                    shortfall: shortfall,
                    suggested_quantity: suggestedQuantity
                });
            }
        }
        
        return lowStockComponents;
    }
    
    static async getTotalStockValue() {
        const stockItems = await this.getAllStockItems();
        let totalValue = 0;
        
        for (const item of stockItems) {
            const quantity = parseFloat(item.current_quantity || 0);
            const cost = parseFloat(item.cost_per_unit_gbp || 0);
            totalValue += quantity * cost;
        }
        
        return totalValue;
    }
    
    static async getTotalPanelValue() {
        const panels = await this.getAllPanels();
        let totalValue = 0;
        
        for (const panel of panels) {
            const builtQty = parseFloat(panel.built_quantity || 0);
            const trueCost = await this.calculatePanelTrueCost(panel.id);
            totalValue += builtQty * trueCost;
        }
        
        return totalValue;
    }
    
    static async getLastWeekPlannerSummary() {
        const thisMonday = londonMondayYmd(new Date());
        const weekStartStr = londonYmdAddDays(thisMonday, -7);
        const planner = await this.getWeeklyPlannerByDate(weekStartStr);
        
        if (!planner) {
            return null;
        }
        
        const efficiency = await this.calculatePlannerEfficiency(planner.id);
        if (!efficiency) {
            return null;
        }
        
        return {
            week_start: planner.week_start_date,
            efficiency: efficiency.overall_efficiency,
            indicator: efficiency.indicator,
            hours_used: efficiency.hours_used,
            hours_available: efficiency.hours_available,
            panels_built: efficiency.panels_built,
            panels_planned: efficiency.panels_planned
        };
    }
    
    // ============ SETTINGS OPERATIONS ============
    
    static async getSetting(key) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT value FROM production_settings WHERE key = $1`, [key]);
            return result.rows[0] ? result.rows[0].value : null;
        } else {
            const result = db.prepare(`SELECT value FROM production_settings WHERE key = ?`).get(key);
            return result ? result.value : null;
        }
    }
    
    static async setSetting(key, value) {
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO production_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
                [key, value]
            );
        } else {
            db.prepare(
                `INSERT OR REPLACE INTO production_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
            ).run(key, value);
        }
    }
    
    static async getAllSettings() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM production_settings ORDER BY key`);
            return result.rows;
        } else {
            return db.prepare(`SELECT * FROM production_settings ORDER BY key`).all();
        }
    }
    
    // ============ FINISHED PRODUCTS OPERATIONS ============
    
    static async createProduct(data) {
        // Cost will be calculated automatically from components
        const initialCost = data.cost_gbp || 0;
        const category = data.category || 'Other';
        const leadlockCategory = data.leadlock_category || 'sheds';
        const estimatedLoadTime = parseFloat(data.estimated_load_time || 0);
        const estimatedInstallTime = parseFloat(data.estimated_install_time || 0);
        const estimatedTravelTime = parseFloat(data.estimated_travel_time || 0);
        const numberOfBoxes = parseInt(data.number_of_boxes || 1, 10) || 1;
        const isOptionalExtra = !!data.is_optional_extra;
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO finished_products (name, description, product_type, leadlock_category, is_optional_extra, category, status, cost_gbp, estimated_load_time, estimated_install_time, estimated_travel_time, number_of_boxes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
                [data.name, data.description, data.product_type, leadlockCategory, isOptionalExtra, category, data.status || 'active', initialCost, estimatedLoadTime, estimatedInstallTime, estimatedTravelTime, numberOfBoxes]
            );
            const product = result.rows[0];
            // Recalculate cost after creation (will update if components exist and includes load time)
            await this.updateProductCost(product.id);
            return await this.getProductById(product.id);
        } else {
            const stmt = db.prepare(
                `INSERT INTO finished_products (name, description, product_type, leadlock_category, is_optional_extra, category, status, cost_gbp, estimated_load_time, estimated_install_time, estimated_travel_time, number_of_boxes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.product_type, leadlockCategory, isOptionalExtra ? 1 : 0, category, data.status || 'active', initialCost, estimatedLoadTime, estimatedInstallTime, estimatedTravelTime, numberOfBoxes);
            const product = await this.getProductById(info.lastInsertRowid);
            // Recalculate cost after creation (includes load time)
            await this.updateProductCost(product.id);
            return await this.getProductById(product.id);
        }
    }
    
    static async getProductById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM finished_products WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM finished_products WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getAllProducts() {
        const sql = `
            SELECT fp.*,
                (SELECT MAX(s.synced_at) FROM product_sales_sync s WHERE s.product_id = fp.id) AS last_pushed_to_sales_at
            FROM finished_products fp
            ORDER BY name`;
        if (isPostgreSQL) {
            const result = await pool.query(sql);
            return result.rows;
        } else {
            return db.prepare(sql).all();
        }
    }
    
    static async getProductsPaged(opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        const status = opts.status && String(opts.status).trim() ? String(opts.status).trim() : null;
        const category = opts.category && String(opts.category).trim() ? String(opts.category).trim() : null;
        const baseFrom = `FROM finished_products fp`;
        const syncSub = `(SELECT MAX(s.synced_at) FROM product_sales_sync s WHERE s.product_id = fp.id) AS last_pushed_to_sales_at`;
        const condsPg = [];
        const condsLite = [];
        const paramsPg = [];
        const paramsLite = [];
        if (status) {
            condsPg.push(`fp.status = $${paramsPg.length + 1}`);
            paramsPg.push(status);
            condsLite.push('fp.status = ?');
            paramsLite.push(status);
        }
        if (category) {
            condsPg.push(`fp.category = $${paramsPg.length + 1}`);
            paramsPg.push(category);
            condsLite.push('fp.category = ?');
            paramsLite.push(category);
        }
        const whereSql = condsPg.length ? `WHERE ${condsPg.join(' AND ')}` : '';
        const whereSqlLite = condsLite.length ? `WHERE ${condsLite.join(' AND ')}` : '';
        let total;
        if (isPostgreSQL) {
            const cr = await pool.query(`SELECT COUNT(*)::int AS c ${baseFrom} ${whereSql}`, paramsPg);
            total = cr.rows[0].c;
        } else {
            const row = db.prepare(`SELECT COUNT(*) AS c ${baseFrom} ${whereSqlLite}`).get(...paramsLite);
            total = row.c;
        }
        let rows;
        if (isPostgreSQL) {
            const lim = paramsPg.length + 1;
            const off = paramsPg.length + 2;
            const r2 = await pool.query(
                `SELECT fp.*, ${syncSub} ${baseFrom} ${whereSql} ORDER BY fp.name ASC LIMIT $${lim} OFFSET $${off}`,
                [...paramsPg, pageSize, offset]
            );
            rows = r2.rows;
        } else {
            rows = db.prepare(
                `SELECT fp.*, ${syncSub} ${baseFrom} ${whereSqlLite} ORDER BY fp.name ASC LIMIT ? OFFSET ?`
            ).all(...paramsLite, pageSize, offset);
        }
        return { products: rows, total, page, page_size: pageSize };
    }
    
    static async getProductByName(name) {
        if (!name || typeof name !== 'string') return null;
        const trimmed = name.trim();
        if (!trimmed) return null;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM finished_products WHERE LOWER(TRIM(name)) = LOWER($1) LIMIT 1`,
                [trimmed]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT * FROM finished_products WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1`
            ).get(trimmed) || null;
        }
    }
    
    static async updateProduct(id, data) {
        const estimatedLoadTime = data.estimated_load_time !== undefined ? parseFloat(data.estimated_load_time || 0) : null;
        const estimatedInstallTime = data.estimated_install_time !== undefined ? parseFloat(data.estimated_install_time || 0) : null;
        const estimatedTravelTime = data.estimated_travel_time !== undefined ? parseFloat(data.estimated_travel_time || 0) : null;
        const numberOfBoxes = data.number_of_boxes !== undefined ? (parseInt(data.number_of_boxes, 10) || 1) : null;
        const isOptionalExtra = !!data.is_optional_extra;
        const leadlockCategory = data.leadlock_category || 'sheds';
        
        if (isPostgreSQL) {
            let query;
            let params;
            
            if (estimatedLoadTime !== null && estimatedInstallTime !== null && estimatedTravelTime !== null) {
                query = `UPDATE finished_products SET name = $1, description = $2, product_type = $3, leadlock_category = $4, is_optional_extra = $5, category = $6, status = $7, estimated_load_time = $8, estimated_install_time = $9, estimated_travel_time = $10, number_of_boxes = $11
                         WHERE id = $12 RETURNING *`;
                params = [data.name, data.description, data.product_type, leadlockCategory, isOptionalExtra, data.category || 'Other', data.status, estimatedLoadTime, estimatedInstallTime, estimatedTravelTime, numberOfBoxes !== null ? numberOfBoxes : 1, id];
            } else {
                query = `UPDATE finished_products SET name = $1, description = $2, product_type = $3, leadlock_category = $4, is_optional_extra = $5, category = $6, status = $7
                         WHERE id = $8 RETURNING *`;
                params = [data.name, data.description, data.product_type, leadlockCategory, isOptionalExtra, data.category || 'Other', data.status, id];
            }
            
            await pool.query(query, params);
            // Recalculate cost automatically from components (includes load time)
            await this.updateProductCost(id);
            return await this.getProductById(id);
        } else {
            if (estimatedLoadTime !== null && estimatedInstallTime !== null && estimatedTravelTime !== null) {
                const boxes = numberOfBoxes !== null ? numberOfBoxes : 1;
                db.prepare(
                    `UPDATE finished_products SET name = ?, description = ?, product_type = ?, leadlock_category = ?, is_optional_extra = ?, category = ?, status = ?, estimated_load_time = ?, estimated_install_time = ?, estimated_travel_time = ?, number_of_boxes = ?
                     WHERE id = ?`
                ).run(data.name, data.description, data.product_type, leadlockCategory, isOptionalExtra ? 1 : 0, data.category || 'Other', data.status, estimatedLoadTime, estimatedInstallTime, estimatedTravelTime, boxes, id);
            } else {
                db.prepare(
                    `UPDATE finished_products SET name = ?, description = ?, product_type = ?, leadlock_category = ?, is_optional_extra = ?, category = ?, status = ?
                     WHERE id = ?`
                ).run(data.name, data.description, data.product_type, leadlockCategory, isOptionalExtra ? 1 : 0, data.category || 'Other', data.status, id);
            }
            // Recalculate cost automatically (includes load time)
            await this.updateProductCost(id);
            return this.getProductById(id);
        }
    }
    
    static async deleteProduct(id) {
        const product = await this.getProductById(id);
        if (!product) {
            throw new Error('Product not found');
        }
        // Block delete if product is used in any order
        if (isPostgreSQL) {
            const orderProducts = await pool.query(
                `SELECT COUNT(*)::int as count FROM order_products WHERE product_id = $1`,
                [id]
            );
            if (orderProducts.rows[0].count > 0) {
                throw new Error('Cannot delete product because it is used in one or more orders. Remove it from those orders first.');
            }
            const legacyOrders = await pool.query(
                `SELECT COUNT(*)::int as count FROM product_orders WHERE product_id = $1`,
                [id]
            );
            if (legacyOrders.rows[0].count > 0) {
                throw new Error('Cannot delete product because it is used in one or more orders. Remove it from those orders first.');
            }
        } else {
            const orderProducts = db.prepare(`SELECT COUNT(*) as count FROM order_products WHERE product_id = ?`).get(id);
            if (orderProducts && orderProducts.count > 0) {
                throw new Error('Cannot delete product because it is used in one or more orders. Remove it from those orders first.');
            }
            const legacyOrders = db.prepare(`SELECT COUNT(*) as count FROM product_orders WHERE product_id = ?`).get(id);
            if (legacyOrders && legacyOrders.count > 0) {
                throw new Error('Cannot delete product because it is used in one or more orders. Remove it from those orders first.');
            }
        }
        // Remove sales sync rows (audit of pushes to LeadLock) so FK does not block delete
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM product_sales_sync WHERE product_id = $1`, [id]);
            await pool.query(`DELETE FROM product_components WHERE product_id = $1`, [id]);
            await pool.query(`DELETE FROM finished_products WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM product_sales_sync WHERE product_id = ?`).run(id);
            db.prepare(`DELETE FROM product_components WHERE product_id = ?`).run(id);
            db.prepare(`DELETE FROM finished_products WHERE id = ?`).run(id);
        }
        return true;
    }

    // ============ SUPPLIER + PURCHASE ORDER OPERATIONS ============

    static async createSupplier(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO suppliers (name, code, contact_name, email, phone, address, notes, is_active, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
                 RETURNING *`,
                [
                    data.name,
                    data.code || null,
                    data.contact_name || null,
                    data.email || null,
                    data.phone || null,
                    data.address || null,
                    data.notes || null,
                    data.is_active !== false
                ]
            );
            return result.rows[0];
        }
        const info = db.prepare(
            `INSERT INTO suppliers (name, code, contact_name, email, phone, address, notes, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).run(
            data.name,
            data.code || null,
            data.contact_name || null,
            data.email || null,
            data.phone || null,
            data.address || null,
            data.notes || null,
            data.is_active === false ? 0 : 1
        );
        return this.getSupplierById(info.lastInsertRowid);
    }

    static async getSupplierById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
            return result.rows[0] || null;
        }
        return db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id) || null;
    }

    static async getAllSuppliers() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM suppliers ORDER BY name ASC`);
            return result.rows;
        }
        return db.prepare(`SELECT * FROM suppliers ORDER BY name ASC`).all();
    }

    static async updateSupplier(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE suppliers
                 SET name = $1, code = $2, contact_name = $3, email = $4, phone = $5, address = $6, notes = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $9 RETURNING *`,
                [
                    data.name,
                    data.code || null,
                    data.contact_name || null,
                    data.email || null,
                    data.phone || null,
                    data.address || null,
                    data.notes || null,
                    data.is_active !== false,
                    id
                ]
            );
            return result.rows[0] || null;
        }
        db.prepare(
            `UPDATE suppliers
             SET name = ?, code = ?, contact_name = ?, email = ?, phone = ?, address = ?, notes = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(
            data.name,
            data.code || null,
            data.contact_name || null,
            data.email || null,
            data.phone || null,
            data.address || null,
            data.notes || null,
            data.is_active === false ? 0 : 1,
            id
        );
        return this.getSupplierById(id);
    }

    static async deleteSupplier(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
            return;
        }
        db.prepare(`DELETE FROM suppliers WHERE id = ?`).run(id);
    }

    static async setProductSuppliers(productId, supplierIds) {
        const ids = [...new Set((supplierIds || []).map(v => parseInt(v, 10)).filter(v => !Number.isNaN(v) && v > 0))];
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM product_suppliers WHERE product_id = $1`, [productId]);
            for (const supplierId of ids) {
                await pool.query(
                    `INSERT INTO product_suppliers (product_id, supplier_id) VALUES ($1, $2) ON CONFLICT (product_id, supplier_id) DO NOTHING`,
                    [productId, supplierId]
                );
            }
            return this.getProductSuppliers(productId);
        }
        db.prepare(`DELETE FROM product_suppliers WHERE product_id = ?`).run(productId);
        const insertStmt = db.prepare(`INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id) VALUES (?, ?)`);
        for (const supplierId of ids) {
            insertStmt.run(productId, supplierId);
        }
        return this.getProductSuppliers(productId);
    }

    static async getProductSuppliers(productId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT ps.product_id, ps.supplier_id, s.*
                 FROM product_suppliers ps
                 INNER JOIN suppliers s ON s.id = ps.supplier_id
                 WHERE ps.product_id = $1
                 ORDER BY s.name ASC`,
                [productId]
            );
            return result.rows;
        }
        return db.prepare(
            `SELECT ps.product_id, ps.supplier_id, s.*
             FROM product_suppliers ps
             INNER JOIN suppliers s ON s.id = ps.supplier_id
             WHERE ps.product_id = ?
             ORDER BY s.name ASC`
        ).all(productId);
    }

    static async getPurchaseOrderById(id) {
        let po;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT po.*, s.name AS supplier_name, s.code AS supplier_code
                 FROM purchase_orders po
                 INNER JOIN suppliers s ON s.id = po.supplier_id
                 WHERE po.id = $1`,
                [id]
            );
            po = result.rows[0] || null;
            if (!po) return null;
            const itemsResult = await pool.query(
                `SELECT poi.*, si.name AS stock_item_name, si.unit AS stock_item_unit
                 FROM purchase_order_items poi
                 INNER JOIN stock_items si ON si.id = poi.stock_item_id
                 WHERE poi.purchase_order_id = $1
                 ORDER BY poi.id ASC`,
                [id]
            );
            po.items = itemsResult.rows;
            return po;
        }
        po = db.prepare(
            `SELECT po.*, s.name AS supplier_name, s.code AS supplier_code
             FROM purchase_orders po
             INNER JOIN suppliers s ON s.id = po.supplier_id
             WHERE po.id = ?`
        ).get(id) || null;
        if (!po) return null;
        po.items = db.prepare(
            `SELECT poi.*, si.name AS stock_item_name, si.unit AS stock_item_unit
             FROM purchase_order_items poi
             INNER JOIN stock_items si ON si.id = poi.stock_item_id
             WHERE poi.purchase_order_id = ?
             ORDER BY poi.id ASC`
        ).all(id);
        return po;
    }

    static async getPurchaseOrdersPaged(opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        const status = opts.status && String(opts.status).trim() ? String(opts.status).trim() : null;
        let total = 0;
        if (isPostgreSQL) {
            const countParams = [];
            let where = '';
            if (status) {
                countParams.push(status);
                where = ` WHERE po.status = $1`;
            }
            const countResult = await pool.query(`SELECT COUNT(*)::int AS c FROM purchase_orders po${where}`, countParams);
            total = countResult.rows[0].c;
            const rowsResult = await pool.query(
                `SELECT po.*, s.name AS supplier_name, s.code AS supplier_code
                 FROM purchase_orders po
                 INNER JOIN suppliers s ON s.id = po.supplier_id
                 ${where}
                 ORDER BY po.created_at DESC
                 LIMIT $${countParams.length + 1} OFFSET $${countParams.length + 2}`,
                [...countParams, pageSize, offset]
            );
            return { orders: rowsResult.rows, total, page, page_size: pageSize };
        }
        let where = '';
        const params = [];
        if (status) {
            where = ' WHERE po.status = ?';
            params.push(status);
        }
        const countRow = db.prepare(`SELECT COUNT(*) AS c FROM purchase_orders po${where}`).get(...params);
        total = countRow.c;
        const orders = db.prepare(
            `SELECT po.*, s.name AS supplier_name, s.code AS supplier_code
             FROM purchase_orders po
             INNER JOIN suppliers s ON s.id = po.supplier_id
             ${where}
             ORDER BY po.created_at DESC
             LIMIT ? OFFSET ?`
        ).all(...params, pageSize, offset);
        return { orders, total, page, page_size: pageSize };
    }

    static async getNextPurchaseOrderNumber(orderDate) {
        const year = String((orderDate || new Date().toISOString().slice(0, 10)).slice(0, 4));
        const prefix = `PO-${year}-`;
        if (isPostgreSQL) {
            await pool.query(`SELECT pg_advisory_xact_lock($1)`, [13052026]);
            const result = await pool.query(
                `SELECT po_number
                 FROM purchase_orders
                 WHERE po_number LIKE $1
                 ORDER BY po_number DESC
                 LIMIT 1`,
                [`${prefix}%`]
            );
            const last = result.rows[0]?.po_number || null;
            const nextSeq = last ? (parseInt(String(last).split('-')[2], 10) + 1) : 1;
            return `${prefix}${String(nextSeq).padStart(4, '0')}`;
        }
        const row = db.prepare(
            `SELECT po_number
             FROM purchase_orders
             WHERE po_number LIKE ?
             ORDER BY po_number DESC
             LIMIT 1`
        ).get(`${prefix}%`);
        const last = row?.po_number || null;
        const nextSeq = last ? (parseInt(String(last).split('-')[2], 10) + 1) : 1;
        return `${prefix}${String(nextSeq).padStart(4, '0')}`;
    }

    static async createPurchaseOrder(data) {
        const items = Array.isArray(data.items) ? data.items : [];
        const isOneOffPurchase = !!data.is_one_off_purchase;
        if (items.length === 0 && !isOneOffPurchase) {
            throw new Error('At least one purchase order item is required');
        }
        const orderDate = data.order_date || new Date().toISOString().slice(0, 10);
        if (isPostgreSQL) {
            await pool.query('BEGIN');
            try {
                const poNumber = await this.getNextPurchaseOrderNumber(orderDate);
                const poResult = await pool.query(
                    `INSERT INTO purchase_orders (po_number, supplier_id, status, order_date, expected_date, notes, subtotal_gbp, is_one_off_purchase, created_by, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, CURRENT_TIMESTAMP)
                     RETURNING id`,
                    [poNumber, data.supplier_id, data.status || 'draft', orderDate, data.expected_date || null, data.notes || null, isOneOffPurchase, data.created_by || null]
                );
                const poId = poResult.rows[0].id;
                let subtotal = 0;
                for (const item of items) {
                    const qty = parseFloat(item.quantity || 0);
                    const unitCost = parseFloat(item.unit_cost_gbp || 0);
                    const lineTotal = parseFloat((qty * unitCost).toFixed(2));
                    subtotal += lineTotal;
                    await pool.query(
                        `INSERT INTO purchase_order_items (purchase_order_id, stock_item_id, quantity, unit_cost_gbp, line_total_gbp, notes)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [poId, item.stock_item_id, qty, unitCost, lineTotal, item.notes || null]
                    );
                }
                await pool.query(
                    `UPDATE purchase_orders SET subtotal_gbp = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [parseFloat(subtotal.toFixed(2)), poId]
                );
                await pool.query('COMMIT');
                return this.getPurchaseOrderById(poId);
            } catch (error) {
                await pool.query('ROLLBACK');
                throw error;
            }
        }
        const tx = db.transaction((payload) => {
            const year = String(payload.order_date.slice(0, 4));
            const prefix = `PO-${year}-`;
            const lastRow = db.prepare(
                `SELECT po_number
                 FROM purchase_orders
                 WHERE po_number LIKE ?
                 ORDER BY po_number DESC
                 LIMIT 1`
            ).get(`${prefix}%`);
            const last = lastRow?.po_number || null;
            const nextSeq = last ? (parseInt(String(last).split('-')[2], 10) + 1) : 1;
            const poNumber = `${prefix}${String(nextSeq).padStart(4, '0')}`;
            const poInfo = db.prepare(
                `INSERT INTO purchase_orders (po_number, supplier_id, status, order_date, expected_date, notes, subtotal_gbp, is_one_off_purchase, created_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)`
            ).run(
                poNumber,
                payload.supplier_id,
                payload.status || 'draft',
                payload.order_date,
                payload.expected_date || null,
                payload.notes || null,
                payload.is_one_off_purchase ? 1 : 0,
                payload.created_by || null
            );
            const poId = poInfo.lastInsertRowid;
            let subtotal = 0;
            const insertItem = db.prepare(
                `INSERT INTO purchase_order_items (purchase_order_id, stock_item_id, quantity, unit_cost_gbp, line_total_gbp, notes)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            for (const item of payload.items) {
                const qty = parseFloat(item.quantity || 0);
                const unitCost = parseFloat(item.unit_cost_gbp || 0);
                const lineTotal = parseFloat((qty * unitCost).toFixed(2));
                subtotal += lineTotal;
                insertItem.run(poId, item.stock_item_id, qty, unitCost, lineTotal, item.notes || null);
            }
            db.prepare(`UPDATE purchase_orders SET subtotal_gbp = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(parseFloat(subtotal.toFixed(2)), poId);
            return poId;
        });
        const poId = tx({ ...data, order_date: orderDate, items });
        return this.getPurchaseOrderById(poId);
    }

    static async updatePurchaseOrderStatus(id, status) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
                [status, id]
            );
            return result.rows[0] || null;
        }
        db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, id);
        return this.getPurchaseOrderById(id);
    }

    static async addPurchaseOrderItem(purchaseOrderId, item) {
        const qty = parseFloat(item.quantity || 0);
        const unitCost = parseFloat(item.unit_cost_gbp || 0);
        const lineTotal = parseFloat((qty * unitCost).toFixed(2));
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO purchase_order_items (purchase_order_id, stock_item_id, quantity, unit_cost_gbp, line_total_gbp, notes)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [purchaseOrderId, item.stock_item_id, qty, unitCost, lineTotal, item.notes || null]
            );
            const subtotalResult = await pool.query(
                `SELECT COALESCE(SUM(line_total_gbp), 0)::numeric AS subtotal
                 FROM purchase_order_items
                 WHERE purchase_order_id = $1`,
                [purchaseOrderId]
            );
            await pool.query(
                `UPDATE purchase_orders SET subtotal_gbp = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [parseFloat(subtotalResult.rows[0].subtotal || 0), purchaseOrderId]
            );
            return this.getPurchaseOrderById(purchaseOrderId);
        }
        db.prepare(
            `INSERT INTO purchase_order_items (purchase_order_id, stock_item_id, quantity, unit_cost_gbp, line_total_gbp, notes)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(purchaseOrderId, item.stock_item_id, qty, unitCost, lineTotal, item.notes || null);
        const subtotalRow = db.prepare(
            `SELECT COALESCE(SUM(line_total_gbp), 0) AS subtotal
             FROM purchase_order_items
             WHERE purchase_order_id = ?`
        ).get(purchaseOrderId);
        db.prepare(`UPDATE purchase_orders SET subtotal_gbp = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(parseFloat(subtotalRow.subtotal || 0), purchaseOrderId);
        return this.getPurchaseOrderById(purchaseOrderId);
    }

    static async deletePurchaseOrderItem(purchaseOrderId, itemId) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM purchase_order_items WHERE purchase_order_id = $1 AND id = $2`, [purchaseOrderId, itemId]);
            const subtotalResult = await pool.query(
                `SELECT COALESCE(SUM(line_total_gbp), 0)::numeric AS subtotal
                 FROM purchase_order_items
                 WHERE purchase_order_id = $1`,
                [purchaseOrderId]
            );
            await pool.query(
                `UPDATE purchase_orders SET subtotal_gbp = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [parseFloat(subtotalResult.rows[0].subtotal || 0), purchaseOrderId]
            );
            return this.getPurchaseOrderById(purchaseOrderId);
        }
        db.prepare(`DELETE FROM purchase_order_items WHERE purchase_order_id = ? AND id = ?`).run(purchaseOrderId, itemId);
        const subtotalRow = db.prepare(
            `SELECT COALESCE(SUM(line_total_gbp), 0) AS subtotal
             FROM purchase_order_items
             WHERE purchase_order_id = ?`
        ).get(purchaseOrderId);
        db.prepare(`UPDATE purchase_orders SET subtotal_gbp = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(parseFloat(subtotalRow.subtotal || 0), purchaseOrderId);
        return this.getPurchaseOrderById(purchaseOrderId);
    }

    static async deletePurchaseOrder(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`DELETE FROM purchase_orders WHERE id = $1 RETURNING id`, [id]);
            return !!result.rows[0];
        }
        const info = db.prepare(`DELETE FROM purchase_orders WHERE id = ?`).run(id);
        return info.changes > 0;
    }
    
    // ============ PRODUCT COMPONENTS OPERATIONS ============
    
    static async addProductComponent(productId, componentType, componentId, quantityRequired, unit) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO product_components (product_id, component_type, component_id, quantity_required, unit)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [productId, componentType, componentId, quantityRequired, unit]
            );
            // Recalculate product cost after component change
            await this.updateProductCost(productId);
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO product_components (product_id, component_type, component_id, quantity_required, unit)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(productId, componentType, componentId, quantityRequired, unit);
            // Recalculate product cost after component change
            await this.updateProductCost(productId);
            return this.getProductComponentById(info.lastInsertRowid);
        }
    }
    
    static async getProductComponentById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM product_components WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM product_components WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getProductComponents(productId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT pc.*,
                 CASE 
                     WHEN pc.component_type = 'raw_material' THEN si.name
                     WHEN pc.component_type = 'component' THEN c.name
                     WHEN pc.component_type = 'built_item' THEN p.name
                 END as component_name
                 FROM product_components pc
                 LEFT JOIN stock_items si ON pc.component_type = 'raw_material' AND pc.component_id = si.id
                 LEFT JOIN components c ON pc.component_type = 'component' AND pc.component_id = c.id
                 LEFT JOIN panels p ON pc.component_type = 'built_item' AND pc.component_id = p.id
                 WHERE pc.product_id = $1 ORDER BY pc.component_type, component_name`,
                [productId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT pc.*,
                 CASE 
                     WHEN pc.component_type = 'raw_material' THEN si.name
                     WHEN pc.component_type = 'component' THEN c.name
                     WHEN pc.component_type = 'built_item' THEN p.name
                 END as component_name
                 FROM product_components pc
                 LEFT JOIN stock_items si ON pc.component_type = 'raw_material' AND pc.component_id = si.id
                 LEFT JOIN components c ON pc.component_type = 'component' AND pc.component_id = c.id
                 LEFT JOIN panels p ON pc.component_type = 'built_item' AND pc.component_id = p.id
                 WHERE pc.product_id = ? ORDER BY pc.component_type, component_name`
            ).all(productId);
        }
    }
    
    static async updateProductComponent(compId, data) {
        // Get product ID before updating
        const comp = await this.getProductComponentById(compId);
        const productId = comp ? comp.product_id : null;
        
        if (isPostgreSQL) {
            await pool.query(
                `UPDATE product_components 
                 SET component_type = $1, component_id = $2, quantity_required = $3, unit = $4
                 WHERE id = $5`,
                [data.component_type, data.component_id, parseFloat(data.quantity_required), data.unit, compId]
            );
        } else {
            db.prepare(
                `UPDATE product_components 
                 SET component_type = ?, component_id = ?, quantity_required = ?, unit = ?
                 WHERE id = ?`
            ).run(data.component_type, data.component_id, parseFloat(data.quantity_required), data.unit, compId);
        }
        
        // Recalculate product cost after component change
        if (productId) {
            await this.updateProductCost(productId);
        }
        
        return await this.getProductComponentById(compId);
    }
    
    static async deleteProductComponent(compId) {
        // Get product ID before deleting
        const comp = await this.getProductComponentById(compId);
        const productId = comp ? comp.product_id : null;
        
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM product_components WHERE id = $1`, [compId]);
        } else {
            db.prepare(`DELETE FROM product_components WHERE id = ?`).run(compId);
        }
        
        // Recalculate product cost after component change
        if (productId) {
            await this.updateProductCost(productId);
        }
    }
    
    static async getLoadSheet(orderId) {
        // Get the order with all products
        const order = await this.getProductOrderById(orderId);
        if (!order) {
            throw new Error('Order not found');
        }
        
        // Get all products for this order (from order_products table)
        const orderProducts = order.products || [];
        
        // Fallback to old format if no products in order_products
        if (orderProducts.length === 0 && order.product_id) {
            orderProducts.push({
                product_id: order.product_id,
                quantity: order.quantity || 1,
                product_name: order.product_name
            });
        }
        
        // Get spares for this order
        const spares = await this.getOrderSpares(orderId);
        
        // Create a map of spares by item_type and item_id for quick lookup
        const sparesMap = {};
        spares.forEach(spare => {
            const key = `${spare.item_type}_${spare.item_id}`;
            if (!sparesMap[key]) {
                sparesMap[key] = [];
            }
            sparesMap[key].push(spare);
        });
        
        // Aggregate components from all products
        const componentMap = {}; // key: component_type_component_id
        const builtItemMap = {};
        const rawMaterialMap = {};
        const allProductComponents = []; // Track all components for standalone spare matching
        
        // Process each product in the order
        for (const orderProduct of orderProducts) {
            const productId = orderProduct.product_id;
            const productQuantity = parseFloat(orderProduct.quantity || 1);
            
            // Get direct product components (no drilling down into nested materials)
            const productComponents = await this.getProductComponents(productId);
            
            for (const comp of productComponents) {
                const quantity = parseFloat(comp.quantity_required || 0) * productQuantity;
                const key = `${comp.component_type}_${comp.component_id}`;
                
                // Track for standalone spare matching
                allProductComponents.push({
                    component_type: comp.component_type,
                    component_id: comp.component_id
                });
                
                // Get unit from source table if product_components.unit is missing or looks like a number
                let unit = comp.unit || 'unit';
                if (!comp.unit || !isNaN(parseFloat(comp.unit))) {
                    // Unit is missing or is a number, get from source table
                    if (comp.component_type === 'component') {
                        const component = await this.getComponentById(comp.component_id);
                        if (component) {
                            unit = component.unit || 'unit';
                        }
                    } else if (comp.component_type === 'built_item') {
                        const panel = await this.getPanelById(comp.component_id);
                        if (panel) {
                            unit = panel.unit || 'piece';
                        }
                    } else if (comp.component_type === 'raw_material') {
                        const stockItem = await this.getStockItemById(comp.component_id);
                        if (stockItem) {
                            unit = stockItem.unit || 'unit';
                        }
                    }
                }
                
                // Aggregate quantities for same components
                if (comp.component_type === 'component') {
                    if (!componentMap[key]) {
                        componentMap[key] = {
                            id: comp.component_id,
                            name: comp.component_name || 'Unknown',
                            quantity: 0,
                            unit: unit,
                            component_type: comp.component_type,
                            spares: []
                        };
                    }
                    componentMap[key].quantity += quantity;
                } else if (comp.component_type === 'built_item') {
                    if (!builtItemMap[key]) {
                        builtItemMap[key] = {
                            id: comp.component_id,
                            name: comp.component_name || 'Unknown',
                            quantity: 0,
                            unit: unit,
                            component_type: comp.component_type,
                            spares: []
                        };
                    }
                    builtItemMap[key].quantity += quantity;
                } else if (comp.component_type === 'raw_material') {
                    if (!rawMaterialMap[key]) {
                        const stockItem = await this.getStockItemById(comp.component_id);
                        rawMaterialMap[key] = {
                            id: comp.component_id,
                            name: comp.component_name || 'Unknown',
                            quantity: 0,
                            unit: unit,
                            component_type: comp.component_type,
                            location: stockItem ? (stockItem.location || '') : '',
                            spares: []
                        };
                    }
                    rawMaterialMap[key].quantity += quantity;
                }
            }
        }
        
        // Add matching spares to aggregated components
        const components = Object.values(componentMap);
        const builtItems = Object.values(builtItemMap);
        const rawMaterials = Object.values(rawMaterialMap);
        
        for (const item of [...components, ...builtItems, ...rawMaterials]) {
            const key = `${item.component_type}_${item.id}`;
            if (sparesMap[key]) {
                item.spares = sparesMap[key].map(spare => ({
                    id: spare.id,
                    quantity_needed: parseFloat(spare.quantity_needed || 0),
                    quantity_loaded: parseFloat(spare.quantity_loaded || 0),
                    quantity_used: parseFloat(spare.quantity_used || 0),
                    quantity_returned: parseFloat(spare.quantity_returned || 0),
                    notes: spare.notes || ''
                }));
            }
        }
        
        // Add spares that don't match any product component (standalone spares)
        const standaloneSpares = {
            components: [],
            built_items: [],
            raw_materials: []
        };
        
        for (const spare of spares) {
            const foundInComponents = allProductComponents.some(comp => 
                comp.component_type === spare.item_type && comp.component_id === spare.item_id
            );
            
            if (!foundInComponents) {
                // Get unit from source table for standalone spares
                let unit = 'unit';
                if (spare.item_type === 'component') {
                    const component = await this.getComponentById(spare.item_id);
                    if (component) {
                        unit = component.unit || 'unit';
                    }
                } else if (spare.item_type === 'built_item') {
                    const panel = await this.getPanelById(spare.item_id);
                    if (panel) {
                        unit = panel.unit || 'piece';
                    }
                } else if (spare.item_type === 'raw_material') {
                    const stockItem = await this.getStockItemById(spare.item_id);
                    if (stockItem) {
                        unit = stockItem.unit || 'unit';
                    }
                }
                
                const spareItem = {
                    id: spare.item_id,
                    name: spare.item_name || 'Unknown',
                    quantity: 0, // Not part of main requirements
                    unit: unit,
                    component_type: spare.item_type,
                    spares: [{
                        id: spare.id,
                        quantity_needed: parseFloat(spare.quantity_needed || 0),
                        quantity_loaded: parseFloat(spare.quantity_loaded || 0),
                        quantity_used: parseFloat(spare.quantity_used || 0),
                        quantity_returned: parseFloat(spare.quantity_returned || 0),
                        notes: spare.notes || ''
                    }]
                };
                
                if (spare.item_type === 'component') {
                    standaloneSpares.components.push(spareItem);
                } else if (spare.item_type === 'built_item') {
                    standaloneSpares.built_items.push(spareItem);
                } else if (spare.item_type === 'raw_material') {
                    const stockItem = await this.getStockItemById(spare.item_id);
                    if (stockItem) {
                        spareItem.location = stockItem.location || '';
                    }
                    standaloneSpares.raw_materials.push(spareItem);
                }
            }
        }
        
        // Calculate total estimated times from all products
        let totalLoadTime = 0;
        let totalInstallTime = 0;
        let totalTravelTime = 0;
        
        for (const orderProduct of orderProducts) {
            const product = await this.getProductById(orderProduct.product_id);
            if (product) {
                totalLoadTime += parseFloat(product.estimated_load_time || 0) * parseFloat(orderProduct.quantity || 1);
                totalInstallTime += parseFloat(product.estimated_install_time || 0) * parseFloat(orderProduct.quantity || 1);
                totalTravelTime += parseFloat(product.estimated_travel_time || 0);
            }
        }
        
        // Build products list for display
        const productsList = orderProducts.map(op => ({
            product_id: op.product_id,
            product_name: op.product_name || 'Unknown',
            quantity: parseFloat(op.quantity || 1)
        }));
        
        let travelTimeHoursRoundTrip = null;
        if (order.travel_time_hours_round_trip != null && order.travel_time_hours_round_trip !== '') {
            const t = parseFloat(order.travel_time_hours_round_trip);
            if (Number.isFinite(t)) {
                travelTimeHoursRoundTrip = t;
            }
        }
        
        return {
            order_id: orderId,
            products: productsList,
            components,
            built_items: builtItems,
            raw_materials: rawMaterials,
            standalone_spares: standaloneSpares,
            estimated_load_time: totalLoadTime,
            estimated_install_time: totalInstallTime,
            estimated_travel_time: totalTravelTime,
            travel_time_hours_round_trip: travelTimeHoursRoundTrip
        };
    }
    
    // ============ PRODUCT ORDERS OPERATIONS ============
    
    static async createProductOrder(data) {
        // Support both old format (single product_id) and new format (products array)
        const products = data.products || (data.product_id ? [{ product_id: data.product_id, quantity: data.quantity }] : []);
        
        if (products.length === 0) {
            throw new Error('At least one product is required');
        }
        
        // Use first product's ID for backward compatibility (nullable)
        const firstProductId = products[0].product_id;
        const firstQuantity = products[0].quantity;
        
        let orderId;
        const salesOrderRef = data.sales_order_ref || null;
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO product_orders (product_id, quantity, order_date, status, created_by, customer_name, sales_order_ref)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [firstProductId, firstQuantity, data.order_date, data.status || 'pending', data.created_by, data.customer_name || null, salesOrderRef]
            );
            orderId = result.rows[0].id;
        } else {
            const stmt = db.prepare(
                `INSERT INTO product_orders (product_id, quantity, order_date, status, created_by, customer_name, sales_order_ref)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(firstProductId, firstQuantity, data.order_date, data.status || 'pending', data.created_by, data.customer_name || null, salesOrderRef);
            orderId = info.lastInsertRowid;
        }
        
        // Insert all products into order_products table
        if (isPostgreSQL) {
            for (const product of products) {
                await pool.query(
                    `INSERT INTO order_products (order_id, product_id, quantity)
                     VALUES ($1, $2, $3)`,
                    [orderId, product.product_id, product.quantity]
                );
            }
        } else {
            const insertStmt = db.prepare(
                `INSERT INTO order_products (order_id, product_id, quantity)
                 VALUES (?, ?, ?)`
            );
            for (const product of products) {
                insertStmt.run(orderId, product.product_id, product.quantity);
            }
        }
        
        return this.getProductOrderById(orderId);
    }
    
    static async getOrCreateLeadLockProduct() {
        const name = 'LeadLock Order';
        if (isPostgreSQL) {
            const found = await pool.query(
                `SELECT * FROM finished_products WHERE LOWER(name) = LOWER($1) LIMIT 1`,
                [name]
            );
            if (found.rows[0]) return found.rows[0];
            const created = await pool.query(
                `INSERT INTO finished_products (name, description, product_type, leadlock_category, is_optional_extra, category, status, cost_gbp, estimated_load_time, estimated_install_time, estimated_travel_time, number_of_boxes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
                [name, 'Order from LeadLock sales app', 'other', 'sheds', false, 'LeadLock', 'active', 0, 0, 0, 0, 1]
            );
            return created.rows[0];
        } else {
            const found = db.prepare(
                `SELECT * FROM finished_products WHERE LOWER(name) = LOWER(?) LIMIT 1`
            ).get(name);
            if (found) return found;
            const info = db.prepare(
                `INSERT INTO finished_products (name, description, product_type, leadlock_category, is_optional_extra, category, status, cost_gbp, estimated_load_time, estimated_install_time, estimated_travel_time, number_of_boxes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(name, 'Order from LeadLock sales app', 'other', 'sheds', 0, 'LeadLock', 'active', 0, 0, 0, 0, 1);
            return db.prepare(`SELECT * FROM finished_products WHERE id = ?`).get(info.lastInsertRowid);
        }
    }
    
    static async recordProductSalesSync(productId) {
        if (!productId || productId < 1) return null;
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO product_sales_sync (product_id) VALUES ($1) RETURNING *`,
                [productId]
            );
            return result.rows[0];
        } else {
            const info = db.prepare(
                `INSERT INTO product_sales_sync (product_id) VALUES (?)`
            ).run(productId);
            return db.prepare(`SELECT * FROM product_sales_sync WHERE id = ?`).get(info.lastInsertRowid);
        }
    }
    
    static async createLeadLockWorkOrder(payload) {
        const items = Array.isArray(payload.items) ? payload.items : [];
        const labourEstimateHours = items.reduce((sum, i) => sum + (parseFloat(i.install_hours) || 0), 0);
        const shippingBoxesCount = items.reduce((sum, i) => sum + (parseInt(i.number_of_boxes, 10) || 0), 0);
        let travelTimeHoursRoundTrip = null;
        if (payload.travel_time_hours_round_trip !== undefined && payload.travel_time_hours_round_trip !== null && payload.travel_time_hours_round_trip !== '') {
            const t = typeof payload.travel_time_hours_round_trip === 'number'
                ? payload.travel_time_hours_round_trip
                : parseFloat(payload.travel_time_hours_round_trip);
            if (Number.isFinite(t)) {
                travelTimeHoursRoundTrip = t;
            }
        }
        
        let orderDate = (payload.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) orderDate = new Date().toISOString().slice(0, 10);
        
        const leadlockProduct = await this.getOrCreateLeadLockProduct();
        const salesOrderRef = payload.order_number ? `LeadLock-${payload.order_number}` : `LeadLock-${payload.order_id || Date.now()}`;
        const installationBooked = payload.installation_booked === true || payload.installation_booked === 'true';
        const salesNotes = payload.notes == null ? '' : String(payload.notes);
        
        let orderId;
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO product_orders (product_id, quantity, order_date, status, created_by, customer_name, sales_order_ref,
                 customer_postcode, customer_address, customer_email, customer_phone, currency, total_amount, installation_booked, leadlock_order_id, labour_estimate_hours, shipping_boxes_count, travel_time_hours_round_trip, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
                [
                    leadlockProduct.id, 1, orderDate, 'pending', null,
                    payload.customer_name || null, salesOrderRef,
                    payload.customer_postcode || null, payload.customer_address || null,
                    payload.customer_email || null, payload.customer_phone || null, payload.currency || null,
                    parseFloat(payload.total_amount) || null, installationBooked,
                    payload.order_id != null ? String(payload.order_id) : null,
                    labourEstimateHours || null, shippingBoxesCount || null,
                    travelTimeHoursRoundTrip,
                    salesNotes
                ]
            );
            orderId = result.rows[0].id;
        } else {
            const stmt = db.prepare(
                `INSERT INTO product_orders (product_id, quantity, order_date, status, created_by, customer_name, sales_order_ref,
                 customer_postcode, customer_address, customer_email, customer_phone, currency, total_amount, installation_booked, leadlock_order_id, labour_estimate_hours, shipping_boxes_count, travel_time_hours_round_trip, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(
                leadlockProduct.id, 1, orderDate, 'pending', null,
                payload.customer_name || null, salesOrderRef,
                payload.customer_postcode || null, payload.customer_address || null,
                payload.customer_email || null, payload.customer_phone || null, payload.currency || null,
                parseFloat(payload.total_amount) || null, installationBooked ? 1 : 0,
                payload.order_id != null ? String(payload.order_id) : null,
                labourEstimateHours || null, shippingBoxesCount || null,
                travelTimeHoursRoundTrip,
                salesNotes
            );
            orderId = info.lastInsertRowid;
        }
        
        for (const item of items) {
            let matchedProduct = null;
            if (item.product_id != null) {
                const pid = parseInt(item.product_id, 10);
                if (!isNaN(pid) && pid > 0) {
                    matchedProduct = await this.getProductById(pid);
                }
            }
            if (!matchedProduct && item.product_name) {
                matchedProduct = await this.getProductByName(item.product_name);
            }
            const qty = parseInt(item.quantity, 10) || 1;
            const productIdForItem = matchedProduct ? matchedProduct.id : null;
            if (isPostgreSQL) {
                await pool.query(
                    `INSERT INTO leadlock_work_order_items (order_id, product_id, product_name, quantity, description, unit_price, install_hours, number_of_boxes)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        orderId,
                        productIdForItem,
                        item.product_name || null,
                        qty,
                        item.description || null,
                        parseFloat(item.unit_price) || 0,
                        parseFloat(item.install_hours) || 0,
                        parseInt(item.number_of_boxes, 10) || 1
                    ]
                );
                if (matchedProduct) {
                    await pool.query(
                        `INSERT INTO order_products (order_id, product_id, quantity) VALUES ($1, $2, $3)`,
                        [orderId, matchedProduct.id, qty]
                    );
                }
            } else {
                db.prepare(
                    `INSERT INTO leadlock_work_order_items (order_id, product_id, product_name, quantity, description, unit_price, install_hours, number_of_boxes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(
                    orderId,
                    productIdForItem,
                    item.product_name || null,
                    qty,
                    item.description || null,
                    parseFloat(item.unit_price) || 0,
                    parseFloat(item.install_hours) || 0,
                    parseInt(item.number_of_boxes, 10) || 1
                );
                if (matchedProduct) {
                    db.prepare(
                        `INSERT INTO order_products (order_id, product_id, quantity) VALUES (?, ?, ?)`
                    ).run(orderId, matchedProduct.id, qty);
                }
            }
        }
        
        return this.getProductOrderById(orderId);
    }
    
    static async getOrderProducts(orderId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT op.*, fp.name as product_name
                 FROM order_products op
                 LEFT JOIN finished_products fp ON op.product_id = fp.id
                 WHERE op.order_id = $1
                 ORDER BY op.id`,
                [orderId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT op.*, fp.name as product_name
                 FROM order_products op
                 LEFT JOIN finished_products fp ON op.product_id = fp.id
                 WHERE op.order_id = ?
                 ORDER BY op.id`
            ).all(orderId);
        }
    }
    
    /** Batch-load order_products for many order ids (single query). Mutates orders in place: sets .products array. */
    static async attachOrderProductsBatch(orders) {
        if (!orders || orders.length === 0) return;
        const ids = orders.map(o => o.id).filter(id => id != null);
        if (ids.length === 0) return;
        for (const o of orders) {
            o.products = [];
        }
        const byOrderId = new Map();
        for (const o of orders) {
            byOrderId.set(o.id, o);
        }
        let rows;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT op.*, fp.name as product_name
                 FROM order_products op
                 LEFT JOIN finished_products fp ON op.product_id = fp.id
                 WHERE op.order_id = ANY($1::int[])
                 ORDER BY op.order_id, op.id`,
                [ids]
            );
            rows = result.rows;
        } else {
            const placeholders = ids.map(() => '?').join(',');
            rows = db.prepare(
                `SELECT op.*, fp.name as product_name
                 FROM order_products op
                 LEFT JOIN finished_products fp ON op.product_id = fp.id
                 WHERE op.order_id IN (${placeholders})
                 ORDER BY op.order_id, op.id`
            ).all(...ids);
        }
        for (const row of rows) {
            const order = byOrderId.get(row.order_id);
            if (order) order.products.push(row);
        }
    }
    
    /**
     * Lightweight works-order rows for dropdowns (no order_products).
     * @param {number} limit capped at 2000
     */
    static async getProductOrdersForSelectList(limit = 1500) {
        const cap = Math.min(2000, Math.max(1, parseInt(limit, 10) || 1500));
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT po.id, po.customer_name, po.status, po.order_date, po.sales_order_ref,
                        po.labour_estimate_hours, po.travel_time_hours_round_trip,
                        fp.name as product_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 WHERE (po.status IS NULL OR po.status != 'quote')
                 ORDER BY po.created_at DESC
                 LIMIT $1`,
                [cap]
            );
            return result.rows;
        }
        return db.prepare(
            `SELECT po.id, po.customer_name, po.status, po.order_date, po.sales_order_ref,
                    po.labour_estimate_hours, po.travel_time_hours_round_trip,
                    fp.name as product_name
             FROM product_orders po
             LEFT JOIN finished_products fp ON po.product_id = fp.id
             WHERE (po.status IS NULL OR po.status != 'quote')
             ORDER BY po.created_at DESC
             LIMIT ?`
        ).all(cap);
    }
    
    static async addProductToOrder(orderId, productId, quantity) {
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO order_products (order_id, product_id, quantity)
                 VALUES ($1, $2, $3)`,
                [orderId, productId, quantity]
            );
        } else {
            db.prepare(
                `INSERT INTO order_products (order_id, product_id, quantity)
                 VALUES (?, ?, ?)`
            ).run(orderId, productId, quantity);
        }
        return this.getOrderProducts(orderId);
    }
    
    static async removeProductFromOrder(orderId, orderProductId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `DELETE FROM order_products WHERE order_id = $1 AND id = $2`,
                [orderId, orderProductId]
            );
            if (result.rowCount === 0) {
                throw new Error('Product not found in order');
            }
        } else {
            const result = db.prepare(
                `DELETE FROM order_products WHERE order_id = ? AND id = ?`
            ).run(orderId, orderProductId);
            if (result.changes === 0) {
                throw new Error('Product not found in order');
            }
        }
        return this.getOrderProducts(orderId);
    }
    
    static async getProductOrderById(id) {
        let order;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 WHERE po.id = $1`,
                [id]
            );
            order = result.rows[0] || null;
        } else {
            order = db.prepare(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 WHERE po.id = ?`
            ).get(id) || null;
        }
        
        if (order) {
            // Get all products for this order
            order.products = await this.getOrderProducts(id);
        }
        
        return order;
    }
    
    static async getAllProductOrders() {
        let orders;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 ORDER BY po.created_at DESC`
            );
            orders = result.rows;
        } else {
            orders = db.prepare(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 ORDER BY po.created_at DESC`
            ).all();
        }
        await this.attachOrderProductsBatch(orders);
        return orders;
    }
    
    /**
     * Paginated product orders with batched order_products.
     * @param {object} opts
     * @param {number} opts.page 1-based
     * @param {number} opts.pageSize max 100
     * @param {boolean} opts.quoteOnly if true, only status = quote; if false, exclude quotes
     * @param {boolean} opts.includeProducts default true
     */
    static async getProductOrdersPaged(opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        const quoteOnly = !!opts.quoteOnly;
        const includeProducts = opts.includeProducts !== false;
        const whereSql = quoteOnly
            ? `WHERE po.status = 'quote'`
            : `WHERE (po.status IS NULL OR po.status != 'quote')`;
        let total;
        if (isPostgreSQL) {
            const countRes = await pool.query(
                `SELECT COUNT(*)::int AS c FROM product_orders po ${whereSql}`
            );
            total = countRes.rows[0].c;
        } else {
            const row = db.prepare(`SELECT COUNT(*) AS c FROM product_orders po ${whereSql}`).get();
            total = row.c;
        }
        let orders;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 ${whereSql}
                 ORDER BY po.created_at DESC
                 LIMIT $1 OFFSET $2`,
                [pageSize, offset]
            );
            orders = result.rows;
        } else {
            orders = db.prepare(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 ${whereSql}
                 ORDER BY po.created_at DESC
                 LIMIT ? OFFSET ?`
            ).all(pageSize, offset);
        }
        if (includeProducts && orders.length > 0) {
            await this.attachOrderProductsBatch(orders);
        } else {
            for (const o of orders) {
                o.products = [];
            }
        }
        return { orders, total, page, page_size: pageSize };
    }
    
    // Deduct stock for all product components when a product order is completed
    static async deductProductComponents(productId, quantity, userId, reference) {
        const productComponents = await this.getProductComponents(productId);
        for (const comp of productComponents) {
            const quantityToDeduct = parseFloat(comp.quantity_required) * quantity;
            if (comp.component_type === 'raw_material') {
                // Deduct raw material from stock
                await this.recordStockMovement({
                    stock_item_id: comp.component_id,
                    movement_type: 'out',
                    quantity: quantityToDeduct,
                    reference: `Product order: ${reference}`,
                    user_id: userId,
                    cost_gbp: 0
                });
            } else if (comp.component_type === 'component') {
                // Deduct from component stock
                await this.recordComponentMovement({
                    component_id: comp.component_id,
                    movement_type: 'use',
                    quantity: quantityToDeduct,
                    reference: `Product order: ${reference}`,
                    user_id: userId
                });
            } else if (comp.component_type === 'built_item') {
                // Deduct from built item (panel) stock
                await this.recordPanelMovement({
                    panel_id: comp.component_id,
                    movement_type: 'use',
                    quantity: quantityToDeduct,
                    reference: `Product order: ${reference}`,
                    user_id: userId
                });
            }
        }
    }
    
    static async updateProductOrder(id, data) {
        // Get current order to check previous status
        const currentOrder = await this.getProductOrderById(id);
        if (!currentOrder) {
            throw new Error('Product order not found');
        }
        
        const previousStatus = currentOrder.status;
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (data.product_id !== undefined) {
            updates.push(`product_id = $${paramIndex}`);
            values.push(data.product_id);
            paramIndex++;
        }
        if (data.quantity !== undefined) {
            updates.push(`quantity = $${paramIndex}`);
            values.push(data.quantity);
            paramIndex++;
        }
        if (data.order_date !== undefined) {
            updates.push(`order_date = $${paramIndex}`);
            values.push(data.order_date);
            paramIndex++;
        }
        if (data.status !== undefined) {
            updates.push(`status = $${paramIndex}`);
            values.push(data.status);
            paramIndex++;
        }
        if (data.customer_name !== undefined) {
            updates.push(`customer_name = $${paramIndex}`);
            values.push(data.customer_name || null);
            paramIndex++;
        }
        if (data.notes !== undefined) {
            updates.push(`notes = $${paramIndex}`);
            values.push(data.notes == null ? null : String(data.notes));
            paramIndex++;
        }
        
        if (updates.length === 0) {
            return currentOrder;
        }
        
        values.push(id);
        
        // Check if status is changing to complete/completed/finished
        const statusChangingToComplete = data.status !== undefined && 
            ['complete', 'completed', 'finished'].includes(data.status.toLowerCase()) &&
            previousStatus && 
            !['complete', 'completed', 'finished'].includes(previousStatus.toLowerCase());
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE product_orders SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
                values
            );
            const updatedOrder = result.rows[0];
            
            // If status changed to complete, depreciate product components
            if (statusChangingToComplete) {
                const orderQuantity = data.quantity !== undefined ? data.quantity : updatedOrder.quantity;
                const orderProductId = data.product_id !== undefined ? data.product_id : updatedOrder.product_id;
                const userId = updatedOrder.created_by || null;
                await this.deductProductComponents(
                    orderProductId, 
                    orderQuantity, 
                    userId, 
                    `Order #${id}`
                );
                console.log(`✅ Depreciated stock for product order #${id} (quantity: ${orderQuantity})`);
            }
            
            return updatedOrder;
        } else {
            const setClause = updates.map((update, idx) => {
                const field = update.split(' = ')[0];
                return `${field} = ?`;
            }).join(', ');
            db.prepare(`UPDATE product_orders SET ${setClause} WHERE id = ?`).run(...values);
            const updatedOrder = await this.getProductOrderById(id);
            
            // If status changed to complete, depreciate product components
            if (statusChangingToComplete) {
                const orderQuantity = data.quantity !== undefined ? data.quantity : updatedOrder.quantity;
                const orderProductId = data.product_id !== undefined ? data.product_id : updatedOrder.product_id;
                const userId = updatedOrder.created_by || null;
                await this.deductProductComponents(
                    orderProductId, 
                    orderQuantity, 
                    userId, 
                    `Order #${id}`
                );
                console.log(`✅ Depreciated stock for product order #${id} (quantity: ${orderQuantity})`);
            }
            
            return updatedOrder;
        }
    }
    
    static async deleteProductOrder(id) {
        // Block delete if order is linked to installations (FK has no CASCADE)
        if (isPostgreSQL) {
            const inst = await pool.query(
                `SELECT COUNT(*)::int as count FROM installations WHERE works_order_id = $1`,
                [id]
            );
            if (inst.rows[0].count > 0) {
                throw new Error('Cannot delete order because it is linked to one or more installations. Unlink or delete those installations first.');
            }
            const result = await pool.query(
                `DELETE FROM product_orders WHERE id = $1 RETURNING *`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            const inst = db.prepare(`SELECT COUNT(*) as count FROM installations WHERE works_order_id = ?`).get(id);
            if (inst && inst.count > 0) {
                throw new Error('Cannot delete order because it is linked to one or more installations. Unlink or delete those installations first.');
            }
            const order = this.getProductOrderById(id);
            db.prepare(`DELETE FROM product_orders WHERE id = ?`).run(id);
            return order;
        }
    }
    
    // ============ ORDER SPARES OPERATIONS ============
    
    static async createOrderSpare(orderId, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO order_spares (order_id, item_type, item_id, quantity_needed, notes)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [orderId, data.item_type, data.item_id, parseFloat(data.quantity_needed), data.notes || null]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO order_spares (order_id, item_type, item_id, quantity_needed, notes)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(orderId, data.item_type, data.item_id, parseFloat(data.quantity_needed), data.notes || null);
            return this.getOrderSpareById(info.lastInsertRowid);
        }
    }
    
    static async getOrderSpareById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT os.*,
                 CASE 
                     WHEN os.item_type = 'raw_material' THEN si.name
                     WHEN os.item_type = 'component' THEN c.name
                     WHEN os.item_type = 'built_item' THEN p.name
                 END as item_name
                 FROM order_spares os
                 LEFT JOIN stock_items si ON os.item_type = 'raw_material' AND os.item_id = si.id
                 LEFT JOIN components c ON os.item_type = 'component' AND os.item_id = c.id
                 LEFT JOIN panels p ON os.item_type = 'built_item' AND os.item_id = p.id
                 WHERE os.id = $1`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT os.*,
                 CASE 
                     WHEN os.item_type = 'raw_material' THEN si.name
                     WHEN os.item_type = 'component' THEN c.name
                     WHEN os.item_type = 'built_item' THEN p.name
                 END as item_name
                 FROM order_spares os
                 LEFT JOIN stock_items si ON os.item_type = 'raw_material' AND os.item_id = si.id
                 LEFT JOIN components c ON os.item_type = 'component' AND os.item_id = c.id
                 LEFT JOIN panels p ON os.item_type = 'built_item' AND os.item_id = p.id
                 WHERE os.id = ?`
            ).get(id) || null;
        }
    }
    
    static async getOrderSpares(orderId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT os.*,
                 CASE 
                     WHEN os.item_type = 'raw_material' THEN si.name
                     WHEN os.item_type = 'component' THEN c.name
                     WHEN os.item_type = 'built_item' THEN p.name
                 END as item_name
                 FROM order_spares os
                 LEFT JOIN stock_items si ON os.item_type = 'raw_material' AND os.item_id = si.id
                 LEFT JOIN components c ON os.item_type = 'component' AND os.item_id = c.id
                 LEFT JOIN panels p ON os.item_type = 'built_item' AND os.item_id = p.id
                 WHERE os.order_id = $1 ORDER BY os.item_type, item_name`,
                [orderId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT os.*,
                 CASE 
                     WHEN os.item_type = 'raw_material' THEN si.name
                     WHEN os.item_type = 'component' THEN c.name
                     WHEN os.item_type = 'built_item' THEN p.name
                 END as item_name
                 FROM order_spares os
                 LEFT JOIN stock_items si ON os.item_type = 'raw_material' AND os.item_id = si.id
                 LEFT JOIN components c ON os.item_type = 'component' AND os.item_id = c.id
                 LEFT JOIN panels p ON os.item_type = 'built_item' AND os.item_id = p.id
                 WHERE os.order_id = ? ORDER BY os.item_type, item_name`
            ).all(orderId);
        }
    }
    
    static async updateOrderSpare(spareId, data) {
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (data.quantity_needed !== undefined) {
            updates.push(`quantity_needed = $${paramIndex}`);
            values.push(parseFloat(data.quantity_needed));
            paramIndex++;
        }
        if (data.quantity_loaded !== undefined) {
            updates.push(`quantity_loaded = $${paramIndex}`);
            values.push(parseFloat(data.quantity_loaded));
            paramIndex++;
        }
        if (data.quantity_used !== undefined) {
            updates.push(`quantity_used = $${paramIndex}`);
            values.push(parseFloat(data.quantity_used));
            paramIndex++;
        }
        if (data.quantity_returned !== undefined) {
            updates.push(`quantity_returned = $${paramIndex}`);
            values.push(parseFloat(data.quantity_returned));
            paramIndex++;
        }
        if (data.notes !== undefined) {
            updates.push(`notes = $${paramIndex}`);
            values.push(data.notes);
            paramIndex++;
        }
        
        if (updates.length === 0) {
            return this.getOrderSpareById(spareId);
        }
        
        values.push(spareId);
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE order_spares SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
                values
            );
            return result.rows[0];
        } else {
            const setClause = updates.map((update, idx) => {
                const field = update.split(' = ')[0];
                return `${field} = ?`;
            }).join(', ');
            db.prepare(`UPDATE order_spares SET ${setClause} WHERE id = ?`).run(...values);
            return this.getOrderSpareById(spareId);
        }
    }
    
    static async deleteOrderSpare(spareId) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM order_spares WHERE id = $1`, [spareId]);
        } else {
            db.prepare(`DELETE FROM order_spares WHERE id = ?`).run(spareId);
        }
    }
    
    static async returnSpareToStock(spareId, quantity, userId) {
        const spare = await this.getOrderSpareById(spareId);
        if (!spare) {
            throw new Error('Spare not found');
        }
        
        const quantityToReturn = parseFloat(quantity);
        const currentReturned = parseFloat(spare.quantity_returned || 0);
        const availableToReturn = parseFloat(spare.quantity_loaded || 0) - parseFloat(spare.quantity_used || 0) - currentReturned;
        
        if (quantityToReturn > availableToReturn) {
            throw new Error(`Cannot return ${quantityToReturn}. Only ${availableToReturn} available to return.`);
        }
        
        // Update spare quantity_returned
        const newReturned = currentReturned + quantityToReturn;
        await this.updateOrderSpare(spareId, { quantity_returned: newReturned });
        
        // Create stock movement based on item type
        if (spare.item_type === 'raw_material') {
            await this.recordStockMovement({
                stock_item_id: spare.item_id,
                movement_type: 'in',
                quantity: quantityToReturn,
                reference: `Spare return - Order #${spare.order_id}`,
                user_id: userId,
                cost_gbp: 0
            });
        } else if (spare.item_type === 'component') {
            await this.recordComponentMovement({
                component_id: spare.item_id,
                movement_type: 'build',
                quantity: quantityToReturn,
                reference: `Spare return - Order #${spare.order_id}`,
                user_id: userId
            });
        } else if (spare.item_type === 'built_item') {
            await this.recordPanelMovement({
                panel_id: spare.item_id,
                movement_type: 'build',
                quantity: quantityToReturn,
                reference: `Spare return - Order #${spare.order_id}`,
                user_id: userId
            });
        }
        
        return this.getOrderSpareById(spareId);
    }
    
    // ============ INSTALLATION OPERATIONS ============

    static toBooleanValue(value) {
        if (value === true || value === 1 || value === '1') return true;
        if (typeof value === 'string' && value.toLowerCase() === 'true') return true;
        return false;
    }

    static normalizeChecklistResponses(rows = []) {
        const result = {};
        for (const row of rows) {
            result[row.question_key] = this.toBooleanValue(row.answer);
        }
        return result;
    }

    static normalizeInspectionResponses(rows = []) {
        const grouped = { vehicle: {}, trailer: {} };
        for (const row of rows) {
            if (!grouped[row.section]) continue;
            grouped[row.section][row.question_key] = {
                answer: row.answer,
                is_critical: this.toBooleanValue(row.is_critical),
                comment: row.comment || null
            };
        }
        return grouped;
    }
    
    static async createInstallation(data) {
        // Support both old (installation_date) and new (start_date/end_date) formats for backward compatibility
        const startDate = data.start_date || data.installation_date;
        const endDate = data.end_date || data.start_date || data.installation_date;
        
        if (isPostgreSQL) {
            // Calculate end_time if not provided (only if start_time exists)
            let endTime = data.end_time;
            if (!endTime && data.start_time && data.duration_hours) {
                const start = new Date(`2000-01-01 ${data.start_time}`);
                const end = new Date(start.getTime() + parseFloat(data.duration_hours) * 60 * 60 * 1000);
                endTime = end.toTimeString().slice(0, 5);
            }
            
            const result = await pool.query(
                `INSERT INTO installations (works_order_id, start_date, end_date, start_time, end_time, duration_hours, location, address, notes, status, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [
                    data.works_order_id || null,
                    startDate,
                    endDate,
                    data.start_time || null,
                    endTime || null,
                    parseFloat(data.duration_hours),
                    data.location || null,
                    data.address || null,
                    data.notes || null,
                    data.status || 'scheduled',
                    data.created_by
                ]
            );
            const installation = result.rows[0];
            
            // Add user assignments if provided
            if (data.assigned_users && Array.isArray(data.assigned_users) && data.assigned_users.length > 0) {
                for (const assignment of data.assigned_users) {
                    await pool.query(
                        `INSERT INTO installation_assignments (installation_id, user_id, role)
                         VALUES ($1, $2, $3)`,
                        [installation.id, assignment.user_id, assignment.role || null]
                    );
                }
            }
            
            // Add installation_days if provided
            if (data.days && Array.isArray(data.days) && data.days.length > 0) {
                try {
                    for (const day of data.days) {
                        await pool.query(
                            `INSERT INTO installation_days (installation_id, day_date, start_time, end_time, duration_hours, notes)
                             VALUES ($1, $2, $3, $4, $5, $6)
                             ON CONFLICT (installation_id, day_date) DO UPDATE SET
                             start_time = $3, end_time = $4, duration_hours = $5, notes = $6`,
                            [
                                installation.id,
                                day.date,
                                day.start_time || null,
                                day.end_time || null,
                                day.duration_hours ? parseFloat(day.duration_hours) : null,
                                day.notes || null
                            ]
                        );
                    }
                } catch (error) {
                    console.log('Error adding installation_days (table might not exist):', error.message);
                    // Continue without days if table doesn't exist
                }
            }
            
            return this.getInstallationById(installation.id);
        } else {
            // Calculate end_time if not provided
            let endTime = data.end_time;
            if (!endTime && data.start_time && data.duration_hours) {
                const start = new Date(`2000-01-01 ${data.start_time}`);
                const end = new Date(start.getTime() + parseFloat(data.duration_hours) * 60 * 60 * 1000);
                endTime = end.toTimeString().slice(0, 5);
            }
            
            const stmt = db.prepare(
                `INSERT INTO installations (works_order_id, start_date, end_date, start_time, end_time, duration_hours, location, address, notes, status, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(
                data.works_order_id || null,
                startDate,
                endDate,
                data.start_time || null,
                endTime || null,
                parseFloat(data.duration_hours),
                data.location || null,
                data.address || null,
                data.notes || null,
                data.status || 'scheduled',
                data.created_by
            );
            
            const installationId = info.lastInsertRowid;
            
            // Add user assignments if provided
            if (data.assigned_users && Array.isArray(data.assigned_users) && data.assigned_users.length > 0) {
                const assignStmt = db.prepare(
                    `INSERT INTO installation_assignments (installation_id, user_id, role)
                     VALUES (?, ?, ?)`
                );
                for (const assignment of data.assigned_users) {
                    assignStmt.run(installationId, assignment.user_id, assignment.role || null);
                }
            }
            
            // Add installation_days if provided
            if (data.days && Array.isArray(data.days) && data.days.length > 0) {
                try {
                    const dayStmt = db.prepare(
                        `INSERT OR REPLACE INTO installation_days (installation_id, day_date, start_time, end_time, duration_hours, notes)
                         VALUES (?, ?, ?, ?, ?, ?)`
                    );
                    for (const day of data.days) {
                        dayStmt.run(
                            installationId,
                            day.date,
                            day.start_time || null,
                            day.end_time || null,
                            day.duration_hours ? parseFloat(day.duration_hours) : null,
                            day.notes || null
                        );
                    }
                } catch (error) {
                    console.log('Error adding installation_days (table might not exist):', error.message);
                    // Continue without days if table doesn't exist
                }
            }
            
            return this.getInstallationById(installationId);
        }
    }
    
    static async getInstallationById(id) {
        // Use minimal query first so we never 500 on schema/join differences (e.g. Railway).
        let installation = null;
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM installations WHERE id = $1`, [id]);
            installation = result.rows[0] || null;
        } else {
            installation = db.prepare(`SELECT * FROM installations WHERE id = ?`).get(id) || null;
        }
        if (!installation) return null;
        // Normalize date fields for both old (installation_date) and new (start_date/end_date) schema
        installation.start_date = installation.start_date || installation.installation_date;
        installation.end_date = installation.end_date || installation.start_date;
        installation.installation_date = installation.installation_date || installation.start_date;
        installation.order_id = installation.works_order_id || null;
        installation.order_status = null;
        installation.product_name = null;
        installation.created_by_name = null;
        // Optionally enrich with order/product/creator (don't throw)
        if (installation.works_order_id) {
            try {
                if (isPostgreSQL) {
                    const orderResult = await pool.query(
                        `SELECT po.id as order_id, po.product_id, po.quantity, po.status as order_status,
                         fp.name as product_name, po.travel_time_hours_round_trip
                         FROM product_orders po
                         LEFT JOIN finished_products fp ON po.product_id = fp.id
                         WHERE po.id = $1`,
                        [installation.works_order_id]
                    );
                    const row = orderResult.rows[0];
                    if (row) {
                        installation.order_id = row.order_id;
                        installation.order_status = row.order_status;
                        installation.product_name = row.product_name;
                        installation.travel_time_hours_round_trip = row.travel_time_hours_round_trip != null
                            ? Number(row.travel_time_hours_round_trip)
                            : null;
                    }
                } else {
                    const row = db.prepare(
                        `SELECT po.id as order_id, po.product_id, po.quantity, po.status as order_status,
                         fp.name as product_name, po.travel_time_hours_round_trip
                         FROM product_orders po
                         LEFT JOIN finished_products fp ON po.product_id = fp.id
                         WHERE po.id = ?`
                    ).get(installation.works_order_id);
                    if (row) {
                        installation.order_id = row.order_id;
                        installation.order_status = row.order_status;
                        installation.product_name = row.product_name;
                        installation.travel_time_hours_round_trip = row.travel_time_hours_round_trip != null
                            ? Number(row.travel_time_hours_round_trip)
                            : null;
                    }
                }
            } catch (err) {
                console.log('getInstallationById: order lookup failed', err.message);
            }
        }
        if (installation.created_by) {
            try {
                if (isPostgreSQL) {
                    const u = await pool.query(`SELECT username FROM production_users WHERE id = $1`, [installation.created_by]);
                    if (u.rows[0]) installation.created_by_name = u.rows[0].username;
                } else {
                    const u = db.prepare(`SELECT username FROM production_users WHERE id = ?`).get(installation.created_by);
                    if (u) installation.created_by_name = u.username;
                }
            } catch (err) {
                console.log('getInstallationById: creator lookup failed', err.message);
            }
        }
        try {
            installation.assigned_users = await this.getInstallationAssignments(id) || [];
        } catch (err) {
            console.log('getInstallationById: getInstallationAssignments failed', err.message);
            installation.assigned_users = [];
        }
        try {
            installation.installation_days = await this.getInstallationDays(id) || [];
        } catch (err) {
            installation.installation_days = [];
        }
        try {
            installation.checklists = await this.getInstallationChecklists(id);
        } catch (err) {
            installation.checklists = { pre_fitting: {}, completion: {} };
        }
        try {
            installation.signoff = await this.getInstallationSignoff(id);
        } catch (err) {
            installation.signoff = null;
        }
        try {
            installation.photos = await this.getInstallationPhotos(id);
        } catch (err) {
            installation.photos = [];
        }
        return installation;
    }

    static async getInstallationChecklists(installationId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT checklist_type, question_key, answer
                 FROM installation_checklist_responses
                 WHERE installation_id = $1`,
                [installationId]
            );
            const preRows = result.rows.filter(r => r.checklist_type === 'pre_fitting');
            const completionRows = result.rows.filter(r => r.checklist_type === 'completion');
            return {
                pre_fitting: this.normalizeChecklistResponses(preRows),
                completion: this.normalizeChecklistResponses(completionRows)
            };
        }
        const rows = db.prepare(
            `SELECT checklist_type, question_key, answer
             FROM installation_checklist_responses
             WHERE installation_id = ?`
        ).all(installationId);
        const preRows = rows.filter(r => r.checklist_type === 'pre_fitting');
        const completionRows = rows.filter(r => r.checklist_type === 'completion');
        return {
            pre_fitting: this.normalizeChecklistResponses(preRows),
            completion: this.normalizeChecklistResponses(completionRows)
        };
    }

    static async upsertInstallationChecklist(installationId, checklistType, responses, userId = null) {
        const entries = Object.entries(responses || {});
        for (const [questionKey, answer] of entries) {
            const boolAnswer = this.toBooleanValue(answer);
            if (isPostgreSQL) {
                await pool.query(
                    `INSERT INTO installation_checklist_responses
                     (installation_id, checklist_type, question_key, answer, updated_by)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (installation_id, checklist_type, question_key)
                     DO UPDATE SET answer = EXCLUDED.answer, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
                    [installationId, checklistType, questionKey, boolAnswer, userId]
                );
            } else {
                db.prepare(
                    `INSERT INTO installation_checklist_responses
                     (installation_id, checklist_type, question_key, answer, updated_by, updated_at)
                     VALUES (?, ?, ?, ?, ?, datetime('now'))
                     ON CONFLICT(installation_id, checklist_type, question_key)
                     DO UPDATE SET answer = excluded.answer, updated_by = excluded.updated_by, updated_at = datetime('now')`
                ).run(installationId, checklistType, questionKey, boolAnswer ? 1 : 0, userId);
            }
        }
        return this.getInstallationChecklists(installationId);
    }

    static async createInstallationSignoffToken(installationId, token, expiresAt, createdBy = null) {
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO installation_signoff_tokens (installation_id, token, expires_at, created_by)
                 VALUES ($1, $2, $3, $4)`,
                [installationId, token, expiresAt || null, createdBy]
            );
        } else {
            db.prepare(
                `INSERT INTO installation_signoff_tokens (installation_id, token, expires_at, created_by)
                 VALUES (?, ?, ?, ?)`
            ).run(installationId, token, expiresAt || null, createdBy);
        }
        return { token, installation_id: installationId, expires_at: expiresAt || null };
    }

    static async getInstallationSignoffByToken(token) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM installation_signoff_tokens WHERE token = $1`,
                [token]
            );
            return result.rows[0] || null;
        }
        return db.prepare(`SELECT * FROM installation_signoff_tokens WHERE token = ?`).get(token) || null;
    }

    static async markInstallationSignoffTokenUsed(token) {
        if (isPostgreSQL) {
            await pool.query(`UPDATE installation_signoff_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = $1`, [token]);
        } else {
            db.prepare(`UPDATE installation_signoff_tokens SET used_at = datetime('now') WHERE token = ?`).run(token);
        }
    }

    static async saveInstallationSignoff(installationId, data) {
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO installation_signoffs
                 (installation_id, signer_name, signer_phone, signature_data_url, social_media_consent, satisfaction_emoji, signed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                 ON CONFLICT (installation_id)
                 DO UPDATE SET
                    signer_name = EXCLUDED.signer_name,
                    signer_phone = EXCLUDED.signer_phone,
                    signature_data_url = EXCLUDED.signature_data_url,
                    social_media_consent = EXCLUDED.social_media_consent,
                    satisfaction_emoji = EXCLUDED.satisfaction_emoji,
                    signed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    installationId,
                    data.signer_name || null,
                    data.signer_phone || null,
                    data.signature_data_url,
                    this.toBooleanValue(data.social_media_consent),
                    data.satisfaction_emoji
                ]
            );
        } else {
            db.prepare(
                `INSERT INTO installation_signoffs
                 (installation_id, signer_name, signer_phone, signature_data_url, social_media_consent, satisfaction_emoji, signed_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                 ON CONFLICT(installation_id)
                 DO UPDATE SET
                    signer_name = excluded.signer_name,
                    signer_phone = excluded.signer_phone,
                    signature_data_url = excluded.signature_data_url,
                    social_media_consent = excluded.social_media_consent,
                    satisfaction_emoji = excluded.satisfaction_emoji,
                    signed_at = datetime('now'),
                    updated_at = datetime('now')`
            ).run(
                installationId,
                data.signer_name || null,
                data.signer_phone || null,
                data.signature_data_url,
                this.toBooleanValue(data.social_media_consent) ? 1 : 0,
                data.satisfaction_emoji
            );
        }
        return this.getInstallationSignoff(installationId);
    }

    static async getInstallationSignoff(installationId) {
        let row;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM installation_signoffs WHERE installation_id = $1`,
                [installationId]
            );
            row = result.rows[0] || null;
        } else {
            row = db.prepare(`SELECT * FROM installation_signoffs WHERE installation_id = ?`).get(installationId) || null;
        }
        if (!row) return null;
        return {
            ...row,
            social_media_consent: this.toBooleanValue(row.social_media_consent)
        };
    }

    static async addInstallationPhoto(installationId, data) {
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO installation_photos (installation_id, stage_label, image_url, cloudinary_public_id, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5)`,
                [installationId, data.stage_label, data.image_url, data.cloudinary_public_id || null, data.uploaded_by || null]
            );
        } else {
            db.prepare(
                `INSERT INTO installation_photos (installation_id, stage_label, image_url, cloudinary_public_id, uploaded_by)
                 VALUES (?, ?, ?, ?, ?)`
            ).run(installationId, data.stage_label, data.image_url, data.cloudinary_public_id || null, data.uploaded_by || null);
        }
        return this.getInstallationPhotos(installationId);
    }

    static async getInstallationPhotos(installationId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM installation_photos
                 WHERE installation_id = $1
                 ORDER BY created_at ASC`,
                [installationId]
            );
            return result.rows;
        }
        return db.prepare(
            `SELECT * FROM installation_photos
             WHERE installation_id = ?
             ORDER BY created_at ASC`
        ).all(installationId);
    }

    static async getDailyVehicleInspection(userId, inspectionDate) {
        if (isPostgreSQL) {
            const headerResult = await pool.query(
                `SELECT dvi.*, u.username AS inspected_by_username
                 FROM daily_vehicle_inspections dvi
                 LEFT JOIN production_users u ON u.id = dvi.inspected_by_user_id
                 WHERE dvi.inspected_by_user_id = $1 AND dvi.inspection_date = $2`,
                [userId, inspectionDate]
            );
            const header = headerResult.rows[0] || null;
            if (!header) return null;
            const responseResult = await pool.query(
                `SELECT section, question_key, answer, is_critical, comment
                 FROM daily_vehicle_inspection_responses
                 WHERE inspection_id = $1`,
                [header.id]
            );
            return {
                ...header,
                trailer_attached: this.toBooleanValue(header.trailer_attached),
                responses: this.normalizeInspectionResponses(responseResult.rows)
            };
        }

        const header = db.prepare(
            `SELECT dvi.*, u.username AS inspected_by_username
             FROM daily_vehicle_inspections dvi
             LEFT JOIN production_users u ON u.id = dvi.inspected_by_user_id
             WHERE dvi.inspected_by_user_id = ? AND dvi.inspection_date = ?`
        ).get(userId, inspectionDate);
        if (!header) return null;
        const rows = db.prepare(
            `SELECT section, question_key, answer, is_critical, comment
             FROM daily_vehicle_inspection_responses
             WHERE inspection_id = ?`
        ).all(header.id);
        return {
            ...header,
            trailer_attached: this.toBooleanValue(header.trailer_attached),
            responses: this.normalizeInspectionResponses(rows)
        };
    }

    static async upsertDailyVehicleInspection(payload) {
        const {
            inspection_date,
            inspected_by_user_id,
            vehicle_registration,
            trailer_attached,
            trailer_registration,
            notes,
            overall_status,
            critical_fail_count,
            responses = []
        } = payload;

        if (isPostgreSQL) {
            const headerResult = await pool.query(
                `INSERT INTO daily_vehicle_inspections
                 (inspection_date, inspected_by_user_id, vehicle_registration, trailer_attached, trailer_registration, notes, overall_status, critical_fail_count)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (inspection_date, inspected_by_user_id)
                 DO UPDATE SET
                    vehicle_registration = EXCLUDED.vehicle_registration,
                    trailer_attached = EXCLUDED.trailer_attached,
                    trailer_registration = EXCLUDED.trailer_registration,
                    notes = EXCLUDED.notes,
                    overall_status = EXCLUDED.overall_status,
                    critical_fail_count = EXCLUDED.critical_fail_count,
                    updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [
                    inspection_date,
                    inspected_by_user_id,
                    vehicle_registration || null,
                    this.toBooleanValue(trailer_attached),
                    trailer_registration || null,
                    notes || null,
                    overall_status || 'pass',
                    Number(critical_fail_count || 0)
                ]
            );
            const header = headerResult.rows[0];
            for (const response of responses) {
                await pool.query(
                    `INSERT INTO daily_vehicle_inspection_responses
                     (inspection_id, section, question_key, answer, is_critical, comment)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (inspection_id, section, question_key)
                     DO UPDATE SET
                        answer = EXCLUDED.answer,
                        is_critical = EXCLUDED.is_critical,
                        comment = EXCLUDED.comment,
                        updated_at = CURRENT_TIMESTAMP`,
                    [
                        header.id,
                        response.section,
                        response.question_key,
                        response.answer,
                        this.toBooleanValue(response.is_critical),
                        response.comment || null
                    ]
                );
            }
            return this.getDailyVehicleInspection(inspected_by_user_id, inspection_date);
        }

        const upsertHeader = db.prepare(
            `INSERT INTO daily_vehicle_inspections
             (inspection_date, inspected_by_user_id, vehicle_registration, trailer_attached, trailer_registration, notes, overall_status, critical_fail_count, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(inspection_date, inspected_by_user_id)
             DO UPDATE SET
                vehicle_registration = excluded.vehicle_registration,
                trailer_attached = excluded.trailer_attached,
                trailer_registration = excluded.trailer_registration,
                notes = excluded.notes,
                overall_status = excluded.overall_status,
                critical_fail_count = excluded.critical_fail_count,
                updated_at = datetime('now')`
        );
        upsertHeader.run(
            inspection_date,
            inspected_by_user_id,
            vehicle_registration || null,
            this.toBooleanValue(trailer_attached) ? 1 : 0,
            trailer_registration || null,
            notes || null,
            overall_status || 'pass',
            Number(critical_fail_count || 0)
        );
        const header = db.prepare(
            `SELECT * FROM daily_vehicle_inspections WHERE inspection_date = ? AND inspected_by_user_id = ?`
        ).get(inspection_date, inspected_by_user_id);
        for (const response of responses) {
            db.prepare(
                `INSERT INTO daily_vehicle_inspection_responses
                 (inspection_id, section, question_key, answer, is_critical, comment, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(inspection_id, section, question_key)
                 DO UPDATE SET
                    answer = excluded.answer,
                    is_critical = excluded.is_critical,
                    comment = excluded.comment,
                    updated_at = datetime('now')`
            ).run(
                header.id,
                response.section,
                response.question_key,
                response.answer,
                this.toBooleanValue(response.is_critical) ? 1 : 0,
                response.comment || null
            );
        }
        return this.getDailyVehicleInspection(inspected_by_user_id, inspection_date);
    }

    static async getDailyVehicleInspectionHistory(filters = {}) {
        const dateFrom = filters.date_from || londonYmd(new Date());
        const dateTo = filters.date_to || dateFrom;
        const userId = filters.user_id ? Number(filters.user_id) : null;
        const vehicleRegistration = (filters.vehicle_registration || '').trim();
        if (isPostgreSQL) {
            const values = [dateFrom, dateTo];
            const where = ['dvi.inspection_date BETWEEN $1 AND $2'];
            let index = 3;
            if (userId) {
                where.push(`dvi.inspected_by_user_id = $${index++}`);
                values.push(userId);
            }
            if (vehicleRegistration) {
                where.push(`LOWER(COALESCE(dvi.vehicle_registration, '')) LIKE $${index++}`);
                values.push(`%${vehicleRegistration.toLowerCase()}%`);
            }
            const result = await pool.query(
                `SELECT dvi.*, u.username AS inspected_by_username
                 FROM daily_vehicle_inspections dvi
                 LEFT JOIN production_users u ON u.id = dvi.inspected_by_user_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY dvi.inspection_date DESC, u.username ASC`,
                values
            );
            return result.rows.map(row => ({
                ...row,
                trailer_attached: this.toBooleanValue(row.trailer_attached)
            }));
        }

        const params = [dateFrom, dateTo];
        const where = [`dvi.inspection_date BETWEEN ? AND ?`];
        if (userId) {
            where.push(`dvi.inspected_by_user_id = ?`);
            params.push(userId);
        }
        if (vehicleRegistration) {
            where.push(`LOWER(COALESCE(dvi.vehicle_registration, '')) LIKE ?`);
            params.push(`%${vehicleRegistration.toLowerCase()}%`);
        }
        const rows = db.prepare(
            `SELECT dvi.*, u.username AS inspected_by_username
             FROM daily_vehicle_inspections dvi
             LEFT JOIN production_users u ON u.id = dvi.inspected_by_user_id
             WHERE ${where.join(' AND ')}
             ORDER BY dvi.inspection_date DESC, u.username ASC`
        ).all(...params);
        return rows.map(row => ({
            ...row,
            trailer_attached: this.toBooleanValue(row.trailer_attached)
        }));
    }
    
    static async getLeadlockWorkOrderItems(orderId) {
        try {
            if (isPostgreSQL) {
                const result = await pool.query(
                    `SELECT * FROM leadlock_work_order_items WHERE order_id = $1 ORDER BY id`,
                    [orderId]
                );
                return result.rows;
            }
            return db.prepare(
                `SELECT * FROM leadlock_work_order_items WHERE order_id = ? ORDER BY id`
            ).all(orderId);
        } catch (err) {
            console.log('getLeadlockWorkOrderItems failed:', err.message);
            return [];
        }
    }
    
    /** Full installation + linked works order + LeadLock lines for fitter job sheet. */
    static async getInstallationJobSheet(installationId) {
        const installation = await this.getInstallationById(installationId);
        if (!installation) {
            return null;
        }
        let order = null;
        let leadlock_items = [];
        const orderId = installation.works_order_id;
        if (orderId) {
            order = await this.getProductOrderById(orderId);
            if (order && Array.isArray(order.products)) {
                for (const p of order.products) {
                    if (!p.product_id) continue;
                    try {
                        const fp = await this.getProductById(p.product_id);
                        if (fp) {
                            p.product_description = fp.description ?? null;
                            p.estimated_install_time = fp.estimated_install_time ?? null;
                            p.number_of_boxes = fp.number_of_boxes ?? null;
                            p.estimated_travel_time = fp.estimated_travel_time ?? null;
                            p.finished_product_type = fp.product_type ?? null;
                        }
                    } catch (e) {
                        console.log('getInstallationJobSheet: product enrich failed', e.message);
                    }
                }
            }
            leadlock_items = await this.getLeadlockWorkOrderItems(orderId);
        }
        return { installation, order, leadlock_items };
    }
    
    static async getAllInstallations(startDate = null, endDate = null) {
        // Check which columns exist and use appropriate query
        let hasStartDate = false;
        let hasEndDate = false;
        let hasInstallationDate = false;
        
        if (isPostgreSQL) {
            try {
                const colCheck = await pool.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = 'installations' AND column_name IN ('start_date', 'end_date', 'installation_date')
                `);
                hasStartDate = colCheck.rows.some(r => r.column_name === 'start_date');
                hasEndDate = colCheck.rows.some(r => r.column_name === 'end_date');
                hasInstallationDate = colCheck.rows.some(r => r.column_name === 'installation_date');
            } catch (error) {
                console.log('Column check failed, assuming new schema:', error.message);
                // Assume new schema if check fails
                hasStartDate = true;
                hasEndDate = true;
            }
        } else {
            try {
                const tableInfo = db.prepare(`PRAGMA table_info(installations)`).all();
                hasStartDate = tableInfo.some(col => col.name === 'start_date');
                hasEndDate = tableInfo.some(col => col.name === 'end_date');
                hasInstallationDate = tableInfo.some(col => col.name === 'installation_date');
            } catch (error) {
                console.log('Column check failed, assuming new schema:', error.message);
                hasStartDate = true;
                hasEndDate = true;
            }
        }
        
        // Build query based on which columns exist
        let dateSelect = '';
        let dateOrderBy = '';
        
        if (hasStartDate && hasEndDate) {
            // New schema - use start_date and end_date
            dateSelect = 'i.start_date as start_date, i.end_date as end_date';
            dateOrderBy = 'i.start_date';
        } else if (hasInstallationDate) {
            // Old schema - use installation_date
            dateSelect = 'i.installation_date as start_date, i.installation_date as end_date';
            dateOrderBy = 'i.installation_date';
        } else {
            // Fallback - try to use what exists
            dateSelect = 'i.start_date as start_date, COALESCE(i.end_date, i.start_date) as end_date';
            dateOrderBy = 'i.start_date';
        }
        
        try {
            let query = `SELECT i.*, 
                         ${dateSelect},
                         po.id as order_id, po.product_id, po.quantity as order_quantity, po.status as order_status,
                         fp.name as product_name,
                         u.username as created_by_name
                         FROM installations i
                         LEFT JOIN product_orders po ON i.works_order_id = po.id
                         LEFT JOIN finished_products fp ON po.product_id = fp.id
                         LEFT JOIN production_users u ON i.created_by = u.id`;
            const conditions = [];
            const params = [];
            let paramIndex = 1;
            
            if (startDate) {
                if (hasStartDate && hasEndDate) {
                    // New schema
                    if (isPostgreSQL) {
                        conditions.push(`(COALESCE(i.end_date, i.start_date) >= $${paramIndex})`);
                    } else {
                        conditions.push(`(COALESCE(i.end_date, i.start_date) >= ?)`);
                    }
                } else if (hasInstallationDate) {
                    // Old schema
                    if (isPostgreSQL) {
                        conditions.push(`(i.installation_date >= $${paramIndex})`);
                    } else {
                        conditions.push(`(i.installation_date >= ?)`);
                    }
                } else {
                    // Fallback
                    if (isPostgreSQL) {
                        conditions.push(`(i.start_date >= $${paramIndex})`);
                    } else {
                        conditions.push(`(i.start_date >= ?)`);
                    }
                }
                params.push(startDate);
                paramIndex++;
            }
            
            if (endDate) {
                if (hasStartDate) {
                    // New schema or fallback
                    if (isPostgreSQL) {
                        conditions.push(`(i.start_date <= $${paramIndex})`);
                    } else {
                        conditions.push(`(i.start_date <= ?)`);
                    }
                } else if (hasInstallationDate) {
                    // Old schema
                    if (isPostgreSQL) {
                        conditions.push(`(i.installation_date <= $${paramIndex})`);
                    } else {
                        conditions.push(`(i.installation_date <= ?)`);
                    }
                }
                params.push(endDate);
                paramIndex++;
            }
            
            if (conditions.length > 0) {
                query += ` WHERE ${conditions.join(' AND ')}`;
            }
            
            query += ` ORDER BY ${dateOrderBy}, i.start_time`;
            
            console.log('Executing query:', query);
            console.log('With params:', params);
            
            if (isPostgreSQL) {
                const result = await pool.query(query, params);
                const installations = result.rows;
                // Get assignments and days for each installation
                for (const installation of installations) {
                    try {
                        installation.assigned_users = await this.getInstallationAssignments(installation.id) || [];
                    } catch (error) {
                        console.log('Error getting installation assignments:', error.message);
                        installation.assigned_users = [];
                    }
                    try {
                        installation.installation_days = await this.getInstallationDays(installation.id) || [];
                    } catch (error) {
                        console.log('Error getting installation days:', error.message);
                        installation.installation_days = []; // Days table might not exist
                    }
                }
                return installations;
            } else {
                const installations = db.prepare(query).all(...params);
                // Get assignments and days for each installation
                for (const installation of installations) {
                    try {
                        installation.assigned_users = await this.getInstallationAssignments(installation.id) || [];
                    } catch (error) {
                        console.log('Error getting installation assignments:', error.message);
                        installation.assigned_users = [];
                    }
                    try {
                        installation.installation_days = await this.getInstallationDays(installation.id) || [];
                    } catch (error) {
                        console.log('Error getting installation days:', error.message);
                        installation.installation_days = []; // Days table might not exist
                    }
                }
                return installations;
            }
        } catch (error) {
            // Fall back to old schema if new columns don't exist
            console.error('New schema query failed, falling back to old schema:', error.message);
            console.error('Error stack:', error.stack);
            try {
                let query = `SELECT i.*, 
                             i.installation_date as start_date,
                             i.installation_date as end_date,
                             po.id as order_id, po.product_id, po.quantity as order_quantity, po.status as order_status,
                             fp.name as product_name,
                             u.username as created_by_name
                             FROM installations i
                             LEFT JOIN product_orders po ON i.works_order_id = po.id
                             LEFT JOIN finished_products fp ON po.product_id = fp.id
                             LEFT JOIN production_users u ON i.created_by = u.id`;
                const conditions = [];
                const params = [];
                let paramIndex = 1;
                
                if (startDate) {
                    if (isPostgreSQL) {
                        conditions.push(`(i.installation_date >= $${paramIndex})`);
                    } else {
                        conditions.push(`(i.installation_date >= ?)`);
                    }
                    params.push(startDate);
                    paramIndex++;
                }
                
                if (endDate) {
                    if (isPostgreSQL) {
                        conditions.push(`(i.installation_date <= $${paramIndex})`);
                    } else {
                        conditions.push(`(i.installation_date <= ?)`);
                    }
                    params.push(endDate);
                    paramIndex++;
                }
                
                if (conditions.length > 0) {
                    query += ` WHERE ${conditions.join(' AND ')}`;
                }
                
                query += ` ORDER BY i.installation_date, i.start_time`;
                
                if (isPostgreSQL) {
                    const result = await pool.query(query, params);
                    const installations = result.rows;
                    // Get assignments for each installation
                    for (const installation of installations) {
                        installation.assigned_users = await this.getInstallationAssignments(installation.id) || [];
                        installation.installation_days = []; // No days table in old schema
                    }
                    return installations;
                } else {
                    const installations = db.prepare(query).all(...params);
                    // Get assignments for each installation
                    for (const installation of installations) {
                        installation.assigned_users = await this.getInstallationAssignments(installation.id) || [];
                        installation.installation_days = []; // No days table in old schema
                    }
                    return installations;
                }
            } catch (fallbackError) {
                console.error('Fallback query also failed:', fallbackError.message);
                console.error('Fallback error stack:', fallbackError.stack);
                throw fallbackError;
            }
        }
    }
    
    static async getInstallationsByDateRange(startDate, endDate) {
        return this.getAllInstallations(startDate, endDate);
    }
    
    static async updateInstallation(id, data) {
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (data.works_order_id !== undefined) {
            updates.push(`works_order_id = $${paramIndex}`);
            values.push(data.works_order_id || null);
            paramIndex++;
        }
        if (data.start_date !== undefined) {
            updates.push(`start_date = $${paramIndex}`);
            values.push(data.start_date);
            paramIndex++;
        }
        if (data.end_date !== undefined) {
            updates.push(`end_date = $${paramIndex}`);
            values.push(data.end_date);
            paramIndex++;
        }
        // Support old field name for backward compatibility
        if (data.installation_date !== undefined && data.start_date === undefined) {
            updates.push(`start_date = $${paramIndex}`);
            values.push(data.installation_date);
            paramIndex++;
            // Also set end_date if not provided
            if (data.end_date === undefined) {
                updates.push(`end_date = $${paramIndex}`);
                values.push(data.installation_date);
                paramIndex++;
            }
        }
        if (data.start_time !== undefined) {
            updates.push(`start_time = $${paramIndex}`);
            values.push(data.start_time);
            paramIndex++;
        }
        if (data.end_time !== undefined) {
            updates.push(`end_time = $${paramIndex}`);
            values.push(data.end_time || null);
            paramIndex++;
        }
        if (data.duration_hours !== undefined) {
            updates.push(`duration_hours = $${paramIndex}`);
            values.push(parseFloat(data.duration_hours));
            paramIndex++;
        }
        if (data.location !== undefined) {
            updates.push(`location = $${paramIndex}`);
            values.push(data.location || null);
            paramIndex++;
        }
        if (data.address !== undefined) {
            updates.push(`address = $${paramIndex}`);
            values.push(data.address || null);
            paramIndex++;
        }
        if (data.notes !== undefined) {
            updates.push(`notes = $${paramIndex}`);
            values.push(data.notes || null);
            paramIndex++;
        }
        if (data.status !== undefined) {
            updates.push(`status = $${paramIndex}`);
            values.push(data.status);
            paramIndex++;
        }
        
        // Always update updated_at
        if (isPostgreSQL) {
            updates.push(`updated_at = CURRENT_TIMESTAMP`);
        } else {
            updates.push(`updated_at = datetime('now')`);
        }
        
        if (updates.length === 0) {
            return this.getInstallationById(id);
        }
        
        values.push(id);
        
        if (isPostgreSQL) {
            const setClause = updates.map((update, idx) => {
                if (update.includes('CURRENT_TIMESTAMP')) {
                    return update;
                }
                const field = update.split(' = ')[0];
                return `${field} = $${idx + 1}`;
            }).join(', ');
            await pool.query(`UPDATE installations SET ${setClause} WHERE id = $${paramIndex}`, values);
        } else {
            const setClause = updates.map((update, idx) => {
                if (update.includes("datetime('now')")) {
                    return update;
                }
                const field = update.split(' = ')[0];
                return `${field} = ?`;
            }).join(', ');
            db.prepare(`UPDATE installations SET ${setClause} WHERE id = ?`).run(...values);
        }
        
        // Update user assignments if provided
        if (data.assigned_users !== undefined) {
            // Delete existing assignments
            if (isPostgreSQL) {
                await pool.query(`DELETE FROM installation_assignments WHERE installation_id = $1`, [id]);
            } else {
                db.prepare(`DELETE FROM installation_assignments WHERE installation_id = ?`).run(id);
            }
            
            // Add new assignments
            if (Array.isArray(data.assigned_users) && data.assigned_users.length > 0) {
                if (isPostgreSQL) {
                    for (const assignment of data.assigned_users) {
                        await pool.query(
                            `INSERT INTO installation_assignments (installation_id, user_id, role)
                             VALUES ($1, $2, $3)`,
                            [id, assignment.user_id, assignment.role || null]
                        );
                    }
                } else {
                    const assignStmt = db.prepare(
                        `INSERT INTO installation_assignments (installation_id, user_id, role)
                         VALUES (?, ?, ?)`
                    );
                    for (const assignment of data.assigned_users) {
                        assignStmt.run(id, assignment.user_id, assignment.role || null);
                    }
                }
            }
        }
        
        // Update installation_days if provided
        if (data.days !== undefined) {
            // Get current installation to check date range
            const currentInstallation = await this.getInstallationById(id);
            if (currentInstallation) {
                const newStartDate = data.start_date || currentInstallation.start_date;
                const newEndDate = data.end_date || currentInstallation.end_date;
                
                // Delete days outside the new date range
                if (isPostgreSQL) {
                    await pool.query(
                        `DELETE FROM installation_days 
                         WHERE installation_id = $1 AND (day_date < $2 OR day_date > $3)`,
                        [id, newStartDate, newEndDate]
                    );
                } else {
                    db.prepare(
                        `DELETE FROM installation_days 
                         WHERE installation_id = ? AND (day_date < ? OR day_date > ?)`
                    ).run(id, newStartDate, newEndDate);
                }
                
                // Add/update days
                if (Array.isArray(data.days) && data.days.length > 0) {
                    if (isPostgreSQL) {
                        for (const day of data.days) {
                            await pool.query(
                                `INSERT INTO installation_days (installation_id, day_date, start_time, end_time, duration_hours, notes)
                                 VALUES ($1, $2, $3, $4, $5, $6)
                                 ON CONFLICT (installation_id, day_date) DO UPDATE SET
                                 start_time = $3, end_time = $4, duration_hours = $5, notes = $6`,
                                [
                                    id,
                                    day.date,
                                    day.start_time || null,
                                    day.end_time || null,
                                    day.duration_hours ? parseFloat(day.duration_hours) : null,
                                    day.notes || null
                                ]
                            );
                        }
                    } else {
                        const dayStmt = db.prepare(
                            `INSERT OR REPLACE INTO installation_days (installation_id, day_date, start_time, end_time, duration_hours, notes)
                             VALUES (?, ?, ?, ?, ?, ?)`
                        );
                        for (const day of data.days) {
                            dayStmt.run(
                                id,
                                day.date,
                                day.start_time || null,
                                day.end_time || null,
                                day.duration_hours ? parseFloat(day.duration_hours) : null,
                                day.notes || null
                            );
                        }
                    }
                }
            }
        }
        
        return this.getInstallationById(id);
    }
    
    static async deleteInstallation(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM installations WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM installations WHERE id = ?`).run(id);
        }
    }
    
    static async assignUserToInstallation(installationId, userId, role = null) {
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO installation_assignments (installation_id, user_id, role)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (installation_id, user_id) DO UPDATE SET role = $3`,
                [installationId, userId, role]
            );
        } else {
            db.prepare(
                `INSERT OR REPLACE INTO installation_assignments (installation_id, user_id, role)
                 VALUES (?, ?, ?)`
            ).run(installationId, userId, role);
        }
        return this.getInstallationAssignments(installationId);
    }
    
    static async removeUserFromInstallation(installationId, userId) {
        if (isPostgreSQL) {
            await pool.query(
                `DELETE FROM installation_assignments WHERE installation_id = $1 AND user_id = $2`,
                [installationId, userId]
            );
        } else {
            db.prepare(
                `DELETE FROM installation_assignments WHERE installation_id = ? AND user_id = ?`
            ).run(installationId, userId);
        }
    }
    
    static async getInstallationAssignments(installationId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT ia.*, u.username, u.role as user_role
                 FROM installation_assignments ia
                 JOIN production_users u ON ia.user_id = u.id
                 WHERE ia.installation_id = $1
                 ORDER BY ia.assigned_at`,
                [installationId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT ia.*, u.username, u.role as user_role
                 FROM installation_assignments ia
                 JOIN production_users u ON ia.user_id = u.id
                 WHERE ia.installation_id = ?
                 ORDER BY ia.assigned_at`
            ).all(installationId);
        }
    }
    
    static async getInstallationDays(installationId) {
        try {
            if (isPostgreSQL) {
                const result = await pool.query(
                    `SELECT * FROM installation_days
                     WHERE installation_id = $1
                     ORDER BY day_date`,
                    [installationId]
                );
                return result.rows;
            } else {
                return db.prepare(
                    `SELECT * FROM installation_days
                     WHERE installation_id = ?
                     ORDER BY day_date`
                ).all(installationId);
            }
        } catch (error) {
            // Table might not exist yet, return empty array
            console.log('installation_days table not found, returning empty array:', error.message);
            return [];
        }
    }
    
    static async createInstallationDay(installationId, dayData) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO installation_days (installation_id, day_date, start_time, end_time, duration_hours, notes)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (installation_id, day_date) DO UPDATE SET
                 start_time = $3, end_time = $4, duration_hours = $5, notes = $6
                 RETURNING *`,
                [
                    installationId,
                    dayData.date,
                    dayData.start_time || null,
                    dayData.end_time || null,
                    dayData.duration_hours ? parseFloat(dayData.duration_hours) : null,
                    dayData.notes || null
                ]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT OR REPLACE INTO installation_days (installation_id, day_date, start_time, end_time, duration_hours, notes)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            stmt.run(
                installationId,
                dayData.date,
                dayData.start_time || null,
                dayData.end_time || null,
                dayData.duration_hours ? parseFloat(dayData.duration_hours) : null,
                dayData.notes || null
            );
            return db.prepare(
                `SELECT * FROM installation_days WHERE installation_id = ? AND day_date = ?`
            ).get(installationId, dayData.date);
        }
    }
    
    static async deleteInstallationDay(installationId, dayDate) {
        if (isPostgreSQL) {
            await pool.query(
                `DELETE FROM installation_days WHERE installation_id = $1 AND day_date = $2`,
                [installationId, dayDate]
            );
        } else {
            db.prepare(
                `DELETE FROM installation_days WHERE installation_id = ? AND day_date = ?`
            ).run(installationId, dayDate);
        }
    }
    
    static async getInstallationDaysByDateRange(startDate, endDate) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT id.*, i.start_time as default_start_time, i.end_time as default_end_time, 
                 i.duration_hours as default_duration_hours
                 FROM installation_days id
                 JOIN installations i ON id.installation_id = i.id
                 WHERE id.day_date >= $1 AND id.day_date <= $2
                 ORDER BY id.day_date, id.start_time`,
                [startDate, endDate]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT id.*, i.start_time as default_start_time, i.end_time as default_end_time, 
                 i.duration_hours as default_duration_hours
                 FROM installation_days id
                 JOIN installations i ON id.installation_id = i.id
                 WHERE id.day_date >= ? AND id.day_date <= ?
                 ORDER BY id.day_date, id.start_time`
            ).all(startDate, endDate);
        }
    }
    
    static async checkUserAvailability(userId, startDateTime, endDateTime) {
        const conflicts = await this.getUserConflicts(userId, startDateTime, endDateTime);
        return {
            available: conflicts.length === 0,
            conflicts: conflicts
        };
    }
    
    static async checkMultipleUsersAvailability(userIds, startDateTime, endDateTime) {
        const results = {};
        for (const userId of userIds) {
            results[userId] = await this.checkUserAvailability(userId, startDateTime, endDateTime);
        }
        return results;
    }
    
    static async getUserConflicts(userId, startDateTime, endDateTime) {
        const conflicts = [];
        const start = new Date(startDateTime);
        const end = new Date(endDateTime);
        
        // Check timesheet entries
        if (isPostgreSQL) {
            const timesheetResult = await pool.query(
                `SELECT id, clock_in_time, clock_out_time, job_id
                 FROM timesheet_entries
                 WHERE user_id = $1 
                 AND clock_out_time IS NOT NULL
                 AND (
                     (clock_in_time <= $2 AND clock_out_time >= $2) OR
                     (clock_in_time <= $3 AND clock_out_time >= $3) OR
                     (clock_in_time >= $2 AND clock_out_time <= $3)
                 )`,
                [userId, startDateTime, endDateTime]
            );
            for (const entry of timesheetResult.rows) {
                conflicts.push({
                    type: 'timesheet',
                    id: entry.id,
                    start: entry.clock_in_time,
                    end: entry.clock_out_time,
                    description: `Timesheet entry (Job ID: ${entry.job_id})`
                });
            }
            
            // Check holiday requests
            const holidayResult = await pool.query(
                `SELECT id, start_date, end_date, status
                 FROM holiday_requests
                 WHERE user_id = $1
                 AND status = 'approved'
                 AND (
                     (start_date <= $2::date AND end_date >= $2::date) OR
                     (start_date <= $3::date AND end_date >= $3::date) OR
                     (start_date >= $2::date AND end_date <= $3::date)
                 )`,
                [userId, londonYmd(start), londonYmd(end)]
            );
            for (const holiday of holidayResult.rows) {
                conflicts.push({
                    type: 'holiday',
                    id: holiday.id,
                    start: holiday.start_date,
                    end: holiday.end_date,
                    description: `Approved holiday`
                });
            }
            
            // Check existing installations - handle multi-day installations
            const checkDate = londonYmd(start);
            
            // Check which columns exist
            let hasStartDate = false;
            let hasEndDate = false;
            let hasInstallationDate = false;
            try {
                const colCheck = await pool.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = 'installations' AND column_name IN ('start_date', 'end_date', 'installation_date')
                `);
                hasStartDate = colCheck.rows.some(r => r.column_name === 'start_date');
                hasEndDate = colCheck.rows.some(r => r.column_name === 'end_date');
                hasInstallationDate = colCheck.rows.some(r => r.column_name === 'installation_date');
            } catch (error) {
                console.log('Column check failed in getUserConflicts, assuming new schema:', error.message);
                hasStartDate = true;
                hasEndDate = true;
            }
            
            // Build query based on which columns exist
            let dateSelect = '';
            let dateWhere = '';
            if (hasStartDate && hasEndDate) {
                dateSelect = 'i.start_date as start_date, i.end_date as end_date';
                dateWhere = `$2::date >= i.start_date AND $2::date <= i.end_date`;
            } else if (hasInstallationDate) {
                dateSelect = 'i.installation_date as start_date, i.installation_date as end_date';
                dateWhere = `$2::date = i.installation_date`;
            } else {
                dateSelect = 'i.start_date as start_date, COALESCE(i.end_date, i.start_date) as end_date';
                dateWhere = `$2::date >= i.start_date AND $2::date <= COALESCE(i.end_date, i.start_date)`;
            }
            
            const installationResult = await pool.query(
                `SELECT i.id, 
                 ${dateSelect},
                 i.start_time, i.end_time, i.duration_hours
                 FROM installations i
                 JOIN installation_assignments ia ON i.id = ia.installation_id
                 WHERE ia.user_id = $1
                 AND i.status NOT IN ('cancelled', 'completed')
                 AND ${dateWhere}`,
                [userId, checkDate]
            );
            
            for (const inst of installationResult.rows) {
                // Get day-specific times if override exists
                let dayOverride = null;
                try {
                    const dayOverrideResult = await pool.query(
                        `SELECT start_time, end_time, duration_hours
                         FROM installation_days
                         WHERE installation_id = $1 AND day_date = $2`,
                        [inst.id, checkDate]
                    );
                    dayOverride = dayOverrideResult.rows[0];
                } catch (error) {
                    console.log('Error fetching installation_days (table might not exist):', error.message);
                    // Continue without day override
                }
                const dayStartTime = dayOverride?.start_time || inst.start_time;
                const dayEndTime = dayOverride?.end_time || inst.end_time;
                const dayDuration = dayOverride?.duration_hours || inst.duration_hours;
                
                // Check if times overlap
                const instStartDateTime = `${checkDate}T${dayStartTime}:00`;
                let instEndDateTime;
                if (dayEndTime) {
                    instEndDateTime = `${checkDate}T${dayEndTime}:00`;
                } else {
                    const instStart = new Date(instStartDateTime);
                    instEndDateTime = new Date(instStart.getTime() + parseFloat(dayDuration) * 60 * 60 * 1000).toISOString();
                }
                
                const checkStart = new Date(startDateTime);
                const checkEnd = new Date(endDateTime);
                const instStart = new Date(instStartDateTime);
                const instEnd = new Date(instEndDateTime);
                
                // Check for overlap
                if ((instStart <= checkStart && instEnd >= checkStart) ||
                    (instStart <= checkEnd && instEnd >= checkEnd) ||
                    (instStart >= checkStart && instEnd <= checkEnd)) {
                    conflicts.push({
                        type: 'installation',
                        id: inst.id,
                        start: instStartDateTime,
                        end: instEndDateTime,
                        description: `Installation #${inst.id}${inst.start_date !== inst.end_date ? ' (multi-day)' : ''}`
                    });
                }
            }
        } else {
            // SQLite version
            const startDateStr = londonYmd(start);
            const endDateStr = londonYmd(end);
            const startTimeStr = start.toTimeString().slice(0, 5);
            const endTimeStr = end.toTimeString().slice(0, 5);
            
            // Check timesheet entries
            const timesheetEntries = db.prepare(
                `SELECT id, clock_in_time, clock_out_time, job_id
                 FROM timesheet_entries
                 WHERE user_id = ? 
                 AND clock_out_time IS NOT NULL
                 AND (
                     (clock_in_time <= ? AND clock_out_time >= ?) OR
                     (clock_in_time <= ? AND clock_out_time >= ?) OR
                     (clock_in_time >= ? AND clock_out_time <= ?)
                 )`
            ).all(userId, startDateTime, startDateTime, endDateTime, endDateTime, startDateTime, endDateTime);
            
            for (const entry of timesheetEntries) {
                conflicts.push({
                    type: 'timesheet',
                    id: entry.id,
                    start: entry.clock_in_time,
                    end: entry.clock_out_time,
                    description: `Timesheet entry (Job ID: ${entry.job_id})`
                });
            }
            
            // Check holiday requests
            const holidays = db.prepare(
                `SELECT id, start_date, end_date, status
                 FROM holiday_requests
                 WHERE user_id = ?
                 AND status = 'approved'
                 AND (
                     (start_date <= ? AND end_date >= ?) OR
                     (start_date <= ? AND end_date >= ?) OR
                     (start_date >= ? AND end_date <= ?)
                 )`
            ).all(userId, startDateStr, startDateStr, endDateStr, endDateStr, startDateStr, endDateStr);
            
            for (const holiday of holidays) {
                conflicts.push({
                    type: 'holiday',
                    id: holiday.id,
                    start: holiday.start_date,
                    end: holiday.end_date,
                    description: `Approved holiday`
                });
            }
            
            // Check existing installations - handle multi-day installations
            // Check which columns exist
            let hasStartDate = false;
            let hasEndDate = false;
            let hasInstallationDate = false;
            try {
                const tableInfo = db.prepare(`PRAGMA table_info(installations)`).all();
                hasStartDate = tableInfo.some(col => col.name === 'start_date');
                hasEndDate = tableInfo.some(col => col.name === 'end_date');
                hasInstallationDate = tableInfo.some(col => col.name === 'installation_date');
            } catch (error) {
                console.log('Column check failed in getUserConflicts (SQLite), assuming new schema:', error.message);
                hasStartDate = true;
                hasEndDate = true;
            }
            
            // Build query based on which columns exist
            let dateSelect = '';
            let dateWhere = '';
            if (hasStartDate && hasEndDate) {
                dateSelect = 'i.start_date as start_date, i.end_date as end_date';
                dateWhere = `? >= i.start_date AND ? <= i.end_date`;
            } else if (hasInstallationDate) {
                dateSelect = 'i.installation_date as start_date, i.installation_date as end_date';
                dateWhere = `? = i.installation_date`;
            } else {
                dateSelect = 'i.start_date as start_date, COALESCE(i.end_date, i.start_date) as end_date';
                dateWhere = `? >= i.start_date AND ? <= COALESCE(i.end_date, i.start_date)`;
            }
            
            const installations = db.prepare(
                `SELECT i.id, 
                 ${dateSelect},
                 i.start_time, i.end_time, i.duration_hours
                 FROM installations i
                 JOIN installation_assignments ia ON i.id = ia.installation_id
                 WHERE ia.user_id = ?
                 AND i.status NOT IN ('cancelled', 'completed')
                 AND ${dateWhere}`
            ).all(userId, startDateStr, startDateStr);
            
            for (const inst of installations) {
                // Get day-specific times if override exists
                let dayOverride = null;
                try {
                    dayOverride = db.prepare(
                        `SELECT start_time, end_time, duration_hours
                         FROM installation_days
                         WHERE installation_id = ? AND day_date = ?`
                    ).get(inst.id, startDateStr);
                } catch (error) {
                    console.log('Error fetching installation_days (table might not exist):', error.message);
                    // Continue without day override
                }
                
                const dayStartTime = dayOverride?.start_time || inst.start_time;
                const dayEndTime = dayOverride?.end_time || inst.end_time;
                const dayDuration = dayOverride?.duration_hours || inst.duration_hours;
                
                // Check if times overlap
                const instStartDateTime = `${startDateStr}T${dayStartTime}:00`;
                let instEndDateTime;
                if (dayEndTime) {
                    instEndDateTime = `${startDateStr}T${dayEndTime}:00`;
                } else {
                    const instStart = new Date(instStartDateTime);
                    instEndDateTime = new Date(instStart.getTime() + parseFloat(dayDuration) * 60 * 60 * 1000).toISOString();
                }
                
                const checkStart = new Date(startDateTime);
                const checkEnd = new Date(endDateTime);
                const instStart = new Date(instStartDateTime);
                const instEnd = new Date(instEndDateTime);
                
                // Check for overlap
                if ((instStart <= checkStart && instEnd >= checkStart) ||
                    (instStart <= checkEnd && instEnd >= checkEnd) ||
                    (instStart >= checkStart && instEnd <= checkEnd)) {
                    conflicts.push({
                        type: 'installation',
                        id: inst.id,
                        start: instStartDateTime,
                        end: instEndDateTime,
                        description: `Installation #${inst.id}${inst.start_date !== inst.end_date ? ' (multi-day)' : ''}`
                    });
                }
            }
        }
        
        return conflicts;
    }
    
    // ============ TIMESHEET OPERATIONS ============
    
    // Job/Site operations
    static async createJob(name, description) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO jobs (name, description) VALUES ($1, $2) RETURNING *`,
                [name, description]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(`INSERT INTO jobs (name, description) VALUES (?, ?)`);
            const info = stmt.run(name, description);
            return this.getJobById(info.lastInsertRowid);
        }
    }
    
    static async getAllJobs() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM jobs WHERE status = 'active' ORDER BY name`);
            return result.rows;
        } else {
            return db.prepare(`SELECT * FROM jobs WHERE status = 'active' ORDER BY name`).all();
        }
    }
    
    static async getAllJobsIncludingInactive() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM jobs ORDER BY status DESC, name`);
            return result.rows;
        } else {
            return db.prepare(`SELECT * FROM jobs ORDER BY status DESC, name`).all();
        }
    }
    
    static async getJobById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) || null;
        }
    }
    
    static async updateJob(id, name, description, status) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE jobs SET name = $1, description = $2, status = $3 WHERE id = $4 RETURNING *`,
                [name, description, status, id]
            );
            return result.rows[0];
        } else {
            db.prepare(`UPDATE jobs SET name = ?, description = ?, status = ? WHERE id = ?`).run(name, description, status, id);
            return this.getJobById(id);
        }
    }
    
    static async deleteJob(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`DELETE FROM jobs WHERE id = $1 RETURNING *`, [id]);
            return result.rows[0] || null;
        } else {
            const job = this.getJobById(id);
            db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
            return job;
        }
    }
    
    // ============ NFC CLOCK (cards + readers) ============
    
    static async getNfcReaderByToken(readerId, readerToken) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT id, reader_id, job_id, name FROM nfc_readers WHERE reader_id = $1 AND reader_token = $2`,
                [readerId, readerToken]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT id, reader_id, job_id, name FROM nfc_readers WHERE reader_id = ? AND reader_token = ?`
            ).get(readerId, readerToken) || null;
        }
    }
    
    static async getNfcUserByCardUid(cardUid) {
        if (!cardUid || typeof cardUid !== 'string') return null;
        const uid = String(cardUid).trim();
        if (!uid) return null;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT user_id FROM nfc_cards WHERE card_uid = $1`,
                [uid]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT user_id FROM nfc_cards WHERE card_uid = ?`).get(uid) || null;
        }
    }
    
    static async listNfcCards() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT c.id, c.user_id, c.card_uid, c.label, c.created_at, u.username
                 FROM nfc_cards c
                 LEFT JOIN production_users u ON c.user_id = u.id
                 ORDER BY u.username, c.card_uid`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT c.id, c.user_id, c.card_uid, c.label, c.created_at, u.username
                 FROM nfc_cards c
                 LEFT JOIN production_users u ON c.user_id = u.id
                 ORDER BY u.username, c.card_uid`
            ).all();
        }
    }
    
    static async listNfcReaders() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT r.id, r.reader_id, r.job_id, r.name, r.created_at, j.name as job_name
                 FROM nfc_readers r
                 LEFT JOIN jobs j ON r.job_id = j.id
                 ORDER BY r.reader_id`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT r.id, r.reader_id, r.job_id, r.name, r.created_at, j.name as job_name
                 FROM nfc_readers r
                 LEFT JOIN jobs j ON r.job_id = j.id
                 ORDER BY r.reader_id`
            ).all();
        }
    }
    
    static async createNfcCard(userId, cardUid, label = null) {
        const uid = String(cardUid).trim();
        if (!uid) throw new Error('card_uid is required');
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO nfc_cards (user_id, card_uid, label) VALUES ($1, $2, $3) RETURNING *`,
                [userId, uid, label]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(`INSERT INTO nfc_cards (user_id, card_uid, label) VALUES (?, ?, ?)`);
            const info = stmt.run(userId, uid, label);
            return db.prepare(`SELECT * FROM nfc_cards WHERE id = ?`).get(info.lastInsertRowid);
        }
    }
    
    static async createNfcReader(readerId, jobId, name = null) {
        const crypto = require('crypto');
        const readerToken = crypto.randomBytes(32).toString('hex');
        const rid = String(readerId).trim();
        if (!rid) throw new Error('reader_id is required');
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO nfc_readers (reader_id, reader_token, job_id, name) VALUES ($1, $2, $3, $4) RETURNING *`,
                [rid, readerToken, jobId, name]
            );
            return { ...result.rows[0], reader_token: readerToken };
        } else {
            const stmt = db.prepare(`INSERT INTO nfc_readers (reader_id, reader_token, job_id, name) VALUES (?, ?, ?, ?)`);
            const info = stmt.run(rid, readerToken, jobId, name);
            const row = db.prepare(`SELECT * FROM nfc_readers WHERE id = ?`).get(info.lastInsertRowid);
            return { ...row, reader_token: readerToken };
        }
    }
    
    static async deleteNfcCard(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM nfc_cards WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM nfc_cards WHERE id = ?`).run(id);
        }
    }
    
    static async deleteNfcReader(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM nfc_readers WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM nfc_readers WHERE id = ?`).run(id);
        }
    }
    
    static async getNfcReaderById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM nfc_readers WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM nfc_readers WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getProductionUsersForDropdown() {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT id, username FROM production_users WHERE status IS NULL OR status = 'active' ORDER BY username`);
            return result.rows;
        } else {
            return db.prepare(`SELECT id, username FROM production_users WHERE status IS NULL OR status = 'active' ORDER BY username`).all();
        }
    }
    
    // Timesheet entry operations
    static async getCurrentClockStatus(userId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT te.*, j.name as job_name, u.username 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 LEFT JOIN production_users u ON te.user_id = u.id
                 WHERE te.user_id = $1 AND te.clock_out_time IS NULL
                 ORDER BY te.clock_in_time DESC
                 LIMIT 1`,
                [userId]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT te.*, j.name as job_name, u.username 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 LEFT JOIN production_users u ON te.user_id = u.id
                 WHERE te.user_id = ? AND te.clock_out_time IS NULL
                 ORDER BY te.clock_in_time DESC
                 LIMIT 1`
            ).get(userId) || null;
        }
    }
    
    static async clockIn(userId, jobId, latitude, longitude, clockInTime = null) {
        // Use provided clockInTime or default to current time
        const timeToUse = clockInTime ? (clockInTime instanceof Date ? clockInTime.toISOString() : clockInTime) : new Date().toISOString();
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO timesheet_entries (user_id, job_id, clock_in_time, clock_in_latitude, clock_in_longitude)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [userId, jobId, timeToUse, latitude, longitude]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO timesheet_entries (user_id, job_id, clock_in_time, clock_in_latitude, clock_in_longitude)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(userId, jobId, timeToUse, latitude, longitude);
            return this.getTimesheetEntryById(info.lastInsertRowid);
        }
    }
    
    // Cleanup all old unclosed entries (one-time cleanup for historical data)
    // This fixes entries that were created before the auto-clock-out feature was added
    static async cleanupAllOldUnclosedEntries() {
        if (isPostgreSQL) {
            // Find ALL entries that don't have a clock_out_time (regardless of date)
            const entriesToUpdate = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE clock_out_time IS NULL
                 ORDER BY clock_in_time ASC`
            );
            
            if (entriesToUpdate.rows.length === 0) {
                return [];
            }
            
            // Update each entry separately to set clock-out to midnight of clock-in date
            const updatedEntries = [];
            for (const entry of entriesToUpdate.rows) {
                const ymd = londonYmd(new Date(entry.clock_in_time));
                const clockOutTime = londonDayEndInclusiveIso(ymd);
                
                const updateResult = await pool.query(
                    `UPDATE timesheet_entries 
                     SET clock_out_time = $1, updated_at = $1
                     WHERE id = $2
                     RETURNING *`,
                    [clockOutTime, entry.id]
                );
                
                if (updateResult.rows.length > 0) {
                    updatedEntries.push(updateResult.rows[0]);
                }
            }
            
            // For each auto-clocked-out entry, we need to recalculate hours
            for (const entry of updatedEntries) {
                try {
                    // Get clock-in date
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = londonYmd(clockInDate);
                    
                    // Find Monday of that week
                    const weekStartDate = londonMondayYmd(clockInDate);
                    
                    // Get or create weekly timesheet
                    const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                    
                    // Get or create daily entry
                    const dailyEntry = await this.getOrCreateDailyEntry(
                        weeklyTimesheet.id,
                        clockInDateStr,
                        entry.id
                    );
                    
                    // Check if overnight away for this day
                    const overnightAway = dailyEntry.overnight_away || false;
                    
                    // Aggregate hours from ALL entries for this day
                    const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                    
                    // Calculate final hours based on day_type (unpaid days override aggregated hours)
                    const finalHours = await this.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, entry.user_id, clockInDateStr);
                    
                    // Update daily entry with final hours
                    await this.updateDailyEntry(dailyEntry.id, {
                        timesheet_entry_id: entry.id,
                        regular_hours: finalHours.regular_hours,
                        overtime_hours: finalHours.overtime_hours,
                        weekend_hours: finalHours.weekend_hours,
                        overnight_hours: finalHours.overnight_hours,
                        total_hours: finalHours.total_hours
                    });
                } catch (error) {
                    console.error(`Error recalculating hours for auto-clocked-out entry ${entry.id}:`, error);
                }
            }
            
            return updatedEntries;
        } else {
            // SQLite version — only entries from before today's London calendar date
            const todayStart = londonDayStartUtc(londonYmd(new Date()));
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE clock_out_time IS NULL
                AND clock_in_time < ?
                ${userId ? 'AND user_id = ?' : ''}
            `).all(userId ? [todayStart, userId] : [todayStart]);
            
            const updatedEntries = [];
            
            for (const entry of entries) {
                const clockInDate = new Date(entry.clock_in_time);
                const ymd = londonYmd(clockInDate);
                const clockOutTime = londonDayEndInclusiveIso(ymd);
                
                db.prepare(`
                    UPDATE timesheet_entries 
                    SET clock_out_time = ?, updated_at = ?
                    WHERE id = ?
                `).run(clockOutTime, clockOutTime, entry.id);
                
                // Recalculate hours (similar to PostgreSQL version)
                try {
                    const clockInDateStr = londonYmd(clockInDate);
                    const weekStartDate = londonMondayYmd(clockInDate);
                    
                    const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                    const dailyEntry = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entry.id);
                    const overnightAway = dailyEntry.overnight_away || false;
                    const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                    
                    await this.updateDailyEntry(dailyEntry.id, {
                        timesheet_entry_id: entry.id,
                        regular_hours: aggregatedHours.regular_hours,
                        overtime_hours: aggregatedHours.overtime_hours,
                        weekend_hours: aggregatedHours.weekend_hours,
                        overnight_hours: aggregatedHours.overnight_hours,
                        total_hours: aggregatedHours.total_hours
                    });
                } catch (error) {
                    console.error(`Error recalculating hours for auto-clocked-out entry ${entry.id}:`, error);
                }
                
                updatedEntries.push({ ...entry, clock_out_time: clockOutTime });
            }
            
            return updatedEntries;
        }
    }
    
    // Cleanup all old unclosed entries (one-time cleanup for historical data)
    // This fixes entries that were created before the auto-clock-out feature was added
    static async cleanupAllOldUnclosedEntries() {
        console.log('Starting cleanup of all old unclosed timesheet entries...');
        
        if (isPostgreSQL) {
            // Only close entries from BEFORE today in Europe/London
            const todayStartLondon = londonDayStartUtc(londonYmd(new Date()));
            const entriesToUpdate = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE clock_out_time IS NULL
                 AND clock_in_time < $1
                 ORDER BY clock_in_time ASC`,
                [todayStartLondon]
            );
            
            if (entriesToUpdate.rows.length === 0) {
                console.log('No old unclosed entries to cleanup');
                return { count: 0, entries: [], errors: 0 };
            }
            
            console.log(`Found ${entriesToUpdate.rows.length} old unclosed entries to cleanup`);
            
            const updatedEntries = [];
            let successCount = 0;
            let errorCount = 0;
            
            // Process in batches to avoid timeout
            const batchSize = 50;
            for (let i = 0; i < entriesToUpdate.rows.length; i += batchSize) {
                const batch = entriesToUpdate.rows.slice(i, i + batchSize);
                
                for (const entry of batch) {
                    try {
                        const ymd = londonYmd(new Date(entry.clock_in_time));
                        const clockOutTime = londonDayEndInclusiveIso(ymd);
                        
                        const updateResult = await pool.query(
                            `UPDATE timesheet_entries 
                             SET clock_out_time = $1, updated_at = $1
                             WHERE id = $2
                             RETURNING *`,
                            [clockOutTime, entry.id]
                        );
                        
                        if (updateResult.rows.length > 0) {
                            updatedEntries.push(updateResult.rows[0]);
                            successCount++;
                        }
                    } catch (error) {
                        console.error(`Error cleaning up entry ${entry.id}:`, error);
                        errorCount++;
                    }
                }
            }
            
            console.log(`Cleanup complete: ${successCount} entries updated, ${errorCount} errors`);
            return { count: successCount, entries: updatedEntries, errors: errorCount };
        } else {
            // SQLite — before today's London date
            const todayStart = londonDayStartUtc(londonYmd(new Date()));
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE clock_out_time IS NULL
                AND clock_in_time < ?
                ORDER BY clock_in_time ASC
            `).all(todayStart);
            
            if (entries.length === 0) {
                console.log('No old unclosed entries to cleanup');
                return { count: 0, entries: [], errors: 0 };
            }
            
            console.log(`Found ${entries.length} old unclosed entries to cleanup`);
            
            const updatedEntries = [];
            let successCount = 0;
            let errorCount = 0;
            
            for (const entry of entries) {
                try {
                    const ymd = londonYmd(new Date(entry.clock_in_time));
                    const clockOutTime = londonDayEndInclusiveIso(ymd);
                    
                    db.prepare(`
                        UPDATE timesheet_entries 
                        SET clock_out_time = ?, updated_at = ?
                        WHERE id = ?
                    `).run(clockOutTime, clockOutTime, entry.id);
                    
                    updatedEntries.push({ ...entry, clock_out_time: clockOutTime });
                    successCount++;
                } catch (error) {
                    console.error(`Error cleaning up entry ${entry.id}:`, error);
                    errorCount++;
                }
            }
            
            console.log(`Cleanup complete: ${successCount} entries updated, ${errorCount} errors`);
            return { count: successCount, entries: updatedEntries, errors: errorCount };
        }
    }
    
    // Reopen entries for a date: set clock_out_time = NULL so staff show as on clock and can clock out normally
    static async reopenTimesheetEntriesForDate(dateStr) {
        const now = new Date().toISOString();
        if (isPostgreSQL) {
            const updateResult = await pool.query(
                `UPDATE timesheet_entries
                 SET clock_out_time = NULL, updated_at = $1
                 WHERE ((clock_in_time AT TIME ZONE 'Europe/London')::date) = $2::date
                 AND clock_out_time IS NOT NULL
                 RETURNING id, user_id, clock_in_time, job_id`,
                [now, dateStr]
            );
            const entries = updateResult.rows;
            return { count: entries.length, entries };
        } else {
            const startIso = londonDayStartUtc(dateStr);
            const endIso = londonNextDayStartUtc(dateStr);
            const entries = db.prepare(`
                SELECT id, user_id, clock_in_time, job_id FROM timesheet_entries
                WHERE clock_in_time >= ? AND clock_in_time < ?
                AND clock_out_time IS NOT NULL
            `).all(startIso, endIso);
            for (const entry of entries) {
                db.prepare(`
                    UPDATE timesheet_entries
                    SET clock_out_time = NULL, updated_at = ?
                    WHERE id = ?
                `).run(now, entry.id);
            }
            return { count: entries.length, entries };
        }
    }
    
    // Auto-clock-out entries for a specific date (handles entries that might span into the date)
    static async autoClockOutEntriesForDate(userId, targetDateStr) {
        if (isPostgreSQL) {
            // Find entries that:
            // 1. Don't have a clock_out_time
            // 2. Start before or on the target date
            // 3. Are for this user
            // Limit to prevent processing too many entries
            const entries = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE user_id = $1
                 AND clock_out_time IS NULL
                 AND ((clock_in_time AT TIME ZONE 'Europe/London')::date) <= $2::date
                 ORDER BY clock_in_time DESC
                 LIMIT 10`,
                [userId, targetDateStr]
            );
            
            if (entries.rows.length === 0) {
                return [];
            }
            
            const updatedEntries = [];
            // Process entries in batch to avoid timeout
            for (const entry of entries.rows) {
                try {
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = londonYmd(clockInDate);
                    const clockOutTime = londonDayEndInclusiveIso(clockInDateStr);
                    
                    const updateResult = await pool.query(
                        `UPDATE timesheet_entries 
                         SET clock_out_time = $1, updated_at = $1
                         WHERE id = $2
                         RETURNING *`,
                        [clockOutTime, entry.id]
                    );
                    
                    if (updateResult.rows.length > 0) {
                        updatedEntries.push(updateResult.rows[0]);
                        
                        // Recalculate hours for this entry (skip if it fails - don't block)
                        try {
                            const weekStartDate = londonMondayYmd(clockInDate);
                            
                            const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                            const dailyEntry = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entry.id);
                            const overnightAway = dailyEntry.overnight_away || false;
                            const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                            
                            await this.updateDailyEntry(dailyEntry.id, {
                                timesheet_entry_id: entry.id,
                                regular_hours: aggregatedHours.regular_hours,
                                overtime_hours: aggregatedHours.overtime_hours,
                                weekend_hours: aggregatedHours.weekend_hours,
                                overnight_hours: aggregatedHours.overnight_hours,
                                total_hours: aggregatedHours.total_hours
                            });
                        } catch (error) {
                            console.error(`Error recalculating hours for auto-clocked-out entry ${entry.id}:`, error);
                            // Continue - don't fail the whole operation
                        }
                    }
                } catch (error) {
                    console.error(`Error auto-clocking-out entry ${entry.id}:`, error);
                    // Continue with next entry
                }
            }
            
            return updatedEntries;
        } else {
            const nextAfterTarget = londonNextDayStartUtc(targetDateStr);
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE user_id = ?
                AND clock_out_time IS NULL
                AND clock_in_time < ?
            `).all(userId, nextAfterTarget);
            
            const updatedEntries = [];
            for (const entry of entries) {
                const clockInDate = new Date(entry.clock_in_time);
                const clockInDateStr = londonYmd(clockInDate);
                const clockOutTime = londonDayEndInclusiveIso(clockInDateStr);
                
                db.prepare(`
                    UPDATE timesheet_entries 
                    SET clock_out_time = ?, updated_at = ?
                    WHERE id = ?
                `).run(clockOutTime, clockOutTime, entry.id);
                
                // Recalculate hours
                try {
                    const weekStartDate = londonMondayYmd(clockInDate);
                    
                    const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                    const dailyEntry = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entry.id);
                    const overnightAway = dailyEntry.overnight_away || false;
                    const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                    
                    await this.updateDailyEntry(dailyEntry.id, {
                        timesheet_entry_id: entry.id,
                        regular_hours: aggregatedHours.regular_hours,
                        overtime_hours: aggregatedHours.overtime_hours,
                        weekend_hours: aggregatedHours.weekend_hours,
                        overnight_hours: aggregatedHours.overnight_hours,
                        total_hours: aggregatedHours.total_hours
                    });
                } catch (error) {
                    console.error(`Error recalculating hours for auto-clocked-out entry ${entry.id}:`, error);
                }
                
                updatedEntries.push({ ...entry, clock_out_time: clockOutTime });
            }
            
            return updatedEntries;
        }
    }
    
    // Auto-clock-out old entries for a specific user (entries from previous days)
    static async autoClockOutOldEntries(userId) {
        if (isPostgreSQL) {
            const todayStartLondon = londonDayStartUtc(londonYmd(new Date()));
            
            const entries = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE user_id = $1
                 AND clock_out_time IS NULL
                 AND clock_in_time < $2
                 ORDER BY clock_in_time DESC`,
                [userId, todayStartLondon]
            );
            
            if (entries.rows.length === 0) {
                return [];
            }
            
            const updatedEntries = [];
            for (const entry of entries.rows) {
                try {
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = londonYmd(clockInDate);
                    const clockOutTime = londonDayEndInclusiveIso(clockInDateStr);
                    
                    const updateResult = await pool.query(
                        `UPDATE timesheet_entries 
                         SET clock_out_time = $1, updated_at = $1
                         WHERE id = $2
                         RETURNING *`,
                        [clockOutTime, entry.id]
                    );
                    
                    if (updateResult.rows.length > 0) {
                        updatedEntries.push(updateResult.rows[0]);
                        
                        // Recalculate hours for this entry
                        try {
                            const weekStartDate = londonMondayYmd(clockInDate);
                            
                            const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                            const dailyEntry = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entry.id);
                            const overnightAway = dailyEntry.overnight_away || false;
                            const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                            
                            await this.updateDailyEntry(dailyEntry.id, {
                                timesheet_entry_id: entry.id,
                                regular_hours: aggregatedHours.regular_hours,
                                overtime_hours: aggregatedHours.overtime_hours,
                                weekend_hours: aggregatedHours.weekend_hours,
                                overnight_hours: aggregatedHours.overnight_hours,
                                total_hours: aggregatedHours.total_hours
                            });
                        } catch (error) {
                            console.error(`Error recalculating hours for auto-clocked-out entry ${entry.id}:`, error);
                        }
                    }
                } catch (error) {
                    console.error(`Error auto-clocking-out entry ${entry.id}:`, error);
                }
            }
            
            return updatedEntries;
        } else {
            // SQLite — before start of today in London
            const todayStart = londonDayStartUtc(londonYmd(new Date()));
            
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE user_id = ?
                AND clock_out_time IS NULL
                AND clock_in_time < ?
                ORDER BY clock_in_time DESC
            `).all(userId, todayStart);
            
            if (entries.length === 0) {
                return [];
            }
            
            const updatedEntries = [];
            for (const entry of entries) {
                try {
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = londonYmd(clockInDate);
                    const clockOutTime = londonDayEndInclusiveIso(clockInDateStr);
                    
                    db.prepare(`
                        UPDATE timesheet_entries 
                        SET clock_out_time = ?, updated_at = ?
                        WHERE id = ?
                    `).run(clockOutTime, clockOutTime, entry.id);
                    
                    // Recalculate hours
                    try {
                        const weekStartDate = londonMondayYmd(clockInDate);
                        
                        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                        const dailyEntry = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entry.id);
                        const overnightAway = dailyEntry.overnight_away || false;
                        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                        
                        await this.updateDailyEntry(dailyEntry.id, {
                            timesheet_entry_id: entry.id,
                            regular_hours: aggregatedHours.regular_hours,
                            overtime_hours: aggregatedHours.overtime_hours,
                            weekend_hours: aggregatedHours.weekend_hours,
                            overnight_hours: aggregatedHours.overnight_hours,
                            total_hours: aggregatedHours.total_hours
                        });
                    } catch (error) {
                        console.error(`Error recalculating hours for auto-clocked-out entry ${entry.id}:`, error);
                    }
                    
                    updatedEntries.push({ ...entry, clock_out_time: clockOutTime });
                } catch (error) {
                    console.error(`Error auto-clocking-out entry ${entry.id}:`, error);
                }
            }
            
            return updatedEntries;
        }
    }
    
    // Auto-clock-out all entries at midnight (for all users)
    // This should be called by a scheduled task at midnight
    static async autoClockOutAllAtMidnight() {
        console.log('🕛 Running midnight auto-clock-out for all users...');
        
        if (isPostgreSQL) {
            const todayStartLondon = londonDayStartUtc(londonYmd(new Date()));
            
            const entries = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE clock_out_time IS NULL
                 AND clock_in_time < $1
                 ORDER BY clock_in_time ASC`,
                [todayStartLondon]
            );
            
            if (entries.rows.length === 0) {
                console.log('   No entries to auto-clock-out at midnight');
                return { count: 0, errors: 0 };
            }
            
            console.log(`   Found ${entries.rows.length} entries to auto-clock-out`);
            
            let successCount = 0;
            let errorCount = 0;
            
            for (const entry of entries.rows) {
                try {
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = londonYmd(clockInDate);
                    const clockOutTime = londonDayEndInclusiveIso(clockInDateStr);
                    
                    const updateResult = await pool.query(
                        `UPDATE timesheet_entries 
                         SET clock_out_time = $1, updated_at = $1
                         WHERE id = $2
                         RETURNING *`,
                        [clockOutTime, entry.id]
                    );
                    
                    if (updateResult.rows.length > 0) {
                        successCount++;
                        
                        // Recalculate hours for this entry
                        try {
                            const weekStartDate = londonMondayYmd(clockInDate);
                            
                            const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                            const dailyEntry = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entry.id);
                            const overnightAway = dailyEntry.overnight_away || false;
                            const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                            
                            await this.updateDailyEntry(dailyEntry.id, {
                                timesheet_entry_id: entry.id,
                                regular_hours: aggregatedHours.regular_hours,
                                overtime_hours: aggregatedHours.overtime_hours,
                                weekend_hours: aggregatedHours.weekend_hours,
                                overnight_hours: aggregatedHours.overnight_hours,
                                total_hours: aggregatedHours.total_hours
                            });
                        } catch (error) {
                            console.error(`   Error recalculating hours for entry ${entry.id}:`, error);
                        }
                    }
                } catch (error) {
                    console.error(`   Error auto-clocking-out entry ${entry.id}:`, error);
                    errorCount++;
                }
            }
            
            console.log(`   ✅ Midnight auto-clock-out complete: ${successCount} entries updated, ${errorCount} errors`);
            return { count: successCount, errors: errorCount };
        } else {
            const todayStart = londonDayStartUtc(londonYmd(new Date()));
            
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE clock_out_time IS NULL
                AND clock_in_time < ?
                ORDER BY clock_in_time ASC
            `).all(todayStart);
            
            if (entries.length === 0) {
                console.log('   No entries to auto-clock-out at midnight');
                return { count: 0, errors: 0 };
            }
            
            console.log(`   Found ${entries.length} entries to auto-clock-out`);
            
            let successCount = 0;
            let errorCount = 0;
            
            for (const entry of entries) {
                try {
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = londonYmd(clockInDate);
                    const clockOutTime = londonDayEndInclusiveIso(clockInDateStr);
                    
                    db.prepare(`
                        UPDATE timesheet_entries 
                        SET clock_out_time = ?, updated_at = ?
                        WHERE id = ?
                    `).run(clockOutTime, clockOutTime, entry.id);
                    
                    // Recalculate hours
                    try {
                        const weekStartDate = londonMondayYmd(clockInDate);
                        
                        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
                        const dailyEntry = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entry.id);
                        const overnightAway = dailyEntry.overnight_away || false;
                        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
                        
                        await this.updateDailyEntry(dailyEntry.id, {
                            timesheet_entry_id: entry.id,
                            regular_hours: aggregatedHours.regular_hours,
                            overtime_hours: aggregatedHours.overtime_hours,
                            weekend_hours: aggregatedHours.weekend_hours,
                            overnight_hours: aggregatedHours.overnight_hours,
                            total_hours: aggregatedHours.total_hours
                        });
                    } catch (error) {
                        console.error(`   Error recalculating hours for entry ${entry.id}:`, error);
                    }
                    
                    successCount++;
                } catch (error) {
                    console.error(`   Error auto-clocking-out entry ${entry.id}:`, error);
                    errorCount++;
                }
            }
            
            console.log(`   ✅ Midnight auto-clock-out complete: ${successCount} entries updated, ${errorCount} errors`);
            return { count: successCount, errors: errorCount };
        }
    }
    
    static async clockOut(userId, latitude, longitude) {
        const clockOutTime = new Date().toISOString();
        let updatedEntry;
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE timesheet_entries 
                 SET clock_out_time = $1, clock_out_latitude = $2, clock_out_longitude = $3, updated_at = $1
                 WHERE user_id = $4 AND clock_out_time IS NULL
                 RETURNING *`,
                [clockOutTime, latitude, longitude, userId]
            );
            updatedEntry = result.rows[0] || null;
        } else {
            // Get the entry before updating
            const currentEntry = this.getCurrentClockStatus(userId);
            if (!currentEntry) {
                return null;
            }
            db.prepare(
                `UPDATE timesheet_entries 
                 SET clock_out_time = ?, clock_out_latitude = ?, clock_out_longitude = ?, updated_at = ?
                 WHERE user_id = ? AND clock_out_time IS NULL`
            ).run(clockOutTime, latitude, longitude, clockOutTime, userId);
            // Return the updated entry
            updatedEntry = this.getTimesheetEntryById(currentEntry.id);
        }
        
        if (!updatedEntry) {
            return null;
        }
        
        // Calculate hours and create/update daily entry
        try {
            // Get clock-in date to determine which week
            const clockInDate = new Date(updatedEntry.clock_in_time);
            const clockInDateStr = londonYmd(clockInDate);
            
            const weekStartDate = londonMondayYmd(clockInDate);
            
            // Get or create weekly timesheet
            const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(userId, weekStartDate);
            
            // Get or create daily entry
            const dailyEntry = await this.getOrCreateDailyEntry(
                weeklyTimesheet.id,
                clockInDateStr,
                updatedEntry.id
            );
            
            // Check if overnight away for this day
            const overnightAway = dailyEntry.overnight_away || false;
            
            // Calculate hours for this specific entry
            const calculatedHours = await this.calculateTimesheetHours(updatedEntry.id, overnightAway);
            
            // Aggregate hours from ALL entries for this day
            const aggregatedHours = await this.aggregateDailyHours(userId, clockInDateStr, overnightAway);
            
            // Calculate final hours based on day_type (unpaid days override aggregated hours)
            const finalHours = await this.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, userId, clockInDateStr);
            
            // Update daily entry with final hours
            await this.updateDailyEntry(dailyEntry.id, {
                timesheet_entry_id: updatedEntry.id, // Keep reference to most recent entry
                regular_hours: finalHours.regular_hours,
                overtime_hours: finalHours.overtime_hours,
                weekend_hours: finalHours.weekend_hours,
                overnight_hours: finalHours.overnight_hours,
                total_hours: finalHours.total_hours
            });
        } catch (error) {
            console.error('Error calculating hours or updating daily entry:', error);
            // Don't fail clock out if calculation fails
        }
        
        return updatedEntry;
    }
    
    static async getTimesheetEntryById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT te.*, j.name as job_name, u.username 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 LEFT JOIN production_users u ON te.user_id = u.id
                 WHERE te.id = $1`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT te.*, j.name as job_name, u.username 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 LEFT JOIN production_users u ON te.user_id = u.id
                 WHERE te.id = ?`
            ).get(id) || null;
        }
    }
    
    static async deleteTimesheetEntry(id) {
        if (isPostgreSQL) {
            // First get the entry to find associated daily entry
            const entry = await this.getTimesheetEntryById(id);
            if (!entry) {
                return null;
            }
            
            // First delete related amendments
            await pool.query(
                `DELETE FROM timesheet_amendments WHERE timesheet_entry_id = $1`,
                [id]
            );
            
            // Update daily entries to remove reference to this entry
            await pool.query(
                `UPDATE timesheet_daily_entries SET timesheet_entry_id = NULL WHERE timesheet_entry_id = $1`,
                [id]
            );
            
            // Delete the timesheet entry
            const result = await pool.query(
                `DELETE FROM timesheet_entries WHERE id = $1 RETURNING *`,
                [id]
            );
            
            // If there's a daily entry linked to this, recalculate hours for that day
            if (entry.clock_out_time) {
                const clockInDate = new Date(entry.clock_in_time);
                const clockInDateStr = londonYmd(clockInDate);
                
                const weekStartDate = londonMondayYmd(clockInDate);
                
                const weeklyTimesheet = await this.getWeeklyTimesheet(entry.user_id, weekStartDate);
                if (weeklyTimesheet) {
                    const dailyEntry = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
                    if (dailyEntry) {
                        // Recalculate hours for remaining entries on this day
                        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, dailyEntry.overnight_away);
                        // Calculate final hours based on day_type (unpaid days override aggregated hours)
                        const finalHours = await this.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, entry.user_id, clockInDateStr);
                        await this.updateDailyEntry(dailyEntry.id, {
                            regular_hours: finalHours.regular_hours,
                            overtime_hours: finalHours.overtime_hours,
                            weekend_hours: finalHours.weekend_hours,
                            overnight_hours: finalHours.overnight_hours,
                            total_hours: finalHours.total_hours
                        });
                    }
                }
            }
            
            return result.rows[0] || null;
        } else {
            // First get the entry to find associated daily entry
            const entry = await this.getTimesheetEntryById(id);
            if (!entry) {
                return null;
            }
            
            // First delete related amendments
            db.prepare(`DELETE FROM timesheet_amendments WHERE timesheet_entry_id = ?`).run(id);
            
            // Update daily entries to remove reference to this entry
            db.prepare(`UPDATE timesheet_daily_entries SET timesheet_entry_id = NULL WHERE timesheet_entry_id = ?`).run(id);
            
            // Delete the timesheet entry
            const stmt = db.prepare(`DELETE FROM timesheet_entries WHERE id = ?`);
            stmt.run(id);
            
            // If there's a daily entry linked to this, recalculate hours for that day
            if (entry.clock_out_time) {
                const clockInDate = new Date(entry.clock_in_time);
                const clockInDateStr = londonYmd(clockInDate);
                
                const weekStartDate = londonMondayYmd(clockInDate);
                
                const weeklyTimesheet = await this.getWeeklyTimesheet(entry.user_id, weekStartDate);
                if (weeklyTimesheet) {
                    const dailyEntry = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
                    if (dailyEntry) {
                        // Recalculate hours for remaining entries on this day
                        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, dailyEntry.overnight_away);
                        // Calculate final hours based on day_type (unpaid days override aggregated hours)
                        const finalHours = await this.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, entry.user_id, clockInDateStr);
                        await this.updateDailyEntry(dailyEntry.id, {
                            regular_hours: finalHours.regular_hours,
                            overtime_hours: finalHours.overtime_hours,
                            weekend_hours: finalHours.weekend_hours,
                            overnight_hours: finalHours.overnight_hours,
                            total_hours: finalHours.total_hours
                        });
                    }
                }
            }
            
            return entry;
        }
    }
    
    static async getActiveClockIns() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT te.*, j.name as job_name, u.username 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 LEFT JOIN production_users u ON te.user_id = u.id
                 WHERE te.clock_out_time IS NULL
                 ORDER BY te.clock_in_time DESC`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT te.*, j.name as job_name, u.username 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 LEFT JOIN production_users u ON te.user_id = u.id
                 WHERE te.clock_out_time IS NULL
                 ORDER BY te.clock_in_time DESC`
            ).all();
        }
    }
    
    static async getTimesheetHistory(userId, startDate, endDate) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT te.*, j.name as job_name 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 WHERE te.user_id = $1 
                 AND ((te.clock_in_time AT TIME ZONE 'Europe/London')::date) >= $2::date
                 AND ((te.clock_in_time AT TIME ZONE 'Europe/London')::date) <= $3::date
                 ORDER BY te.clock_in_time DESC`,
                [userId, startDate, endDate]
            );
            return result.rows;
        } else {
            const startIso = londonDayStartUtc(startDate);
            const endExclusive = londonNextDayStartUtc(endDate);
            return db.prepare(
                `SELECT te.*, j.name as job_name 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 WHERE te.user_id = ? 
                 AND te.clock_in_time >= ? 
                 AND te.clock_in_time < ?
                 ORDER BY te.clock_in_time DESC`
            ).all(userId, startIso, endExclusive);
        }
    }
    
    // Count completed timesheet entries for a specific date (London calendar day)
    static async countEntriesForDate(userId, dateStr) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT COUNT(*) as count
                 FROM timesheet_entries
                 WHERE user_id = $1 
                 AND ((clock_in_time AT TIME ZONE 'Europe/London')::date) = $2::date
                 AND clock_out_time IS NOT NULL`,
                [userId, dateStr]
            );
            return parseInt(result.rows[0].count) || 0;
        } else {
            const startIso = londonDayStartUtc(dateStr);
            const endIso = londonNextDayStartUtc(dateStr);
            const result = db.prepare(
                `SELECT COUNT(*) as count
                 FROM timesheet_entries
                 WHERE user_id = ? 
                 AND clock_in_time >= ? AND clock_in_time < ?
                 AND clock_out_time IS NOT NULL`
            ).get(userId, startIso, endIso);
            return parseInt(result.count) || 0;
        }
    }
    
    // Helper function to detect if an entry was auto-clocked-out
    static isAutoClockedOutEntry(entry) {
        if (!entry || !entry.clock_out_time) return false;
        
        const clockIn = new Date(entry.clock_in_time);
        const clockOut = new Date(entry.clock_out_time);
        
        const ymd = londonYmd(clockIn);
        const endOfDayMs = Date.parse(londonDayEndInclusiveIso(ymd));
        const nextDayMs = Date.parse(londonNextDayStartUtc(ymd));
        
        const endOfDayDiff = Math.abs(clockOut.getTime() - endOfDayMs);
        const midnightDiff = Math.abs(clockOut.getTime() - nextDayMs);
        
        return endOfDayDiff < 1000 || midnightDiff < 1000;
    }
    
    // Check for duplicate or overlapping timesheet entries
    static async checkDuplicateTimes(userId, clockInTime, clockOutTime, excludeEntryId = null) {
        if (isPostgreSQL) {
            let query = `
                SELECT te.* 
                FROM timesheet_entries te
                WHERE te.user_id = $1 
                AND te.clock_out_time IS NOT NULL
                AND (
                    -- Exact duplicate times
                    (te.clock_in_time = $2 AND te.clock_out_time = $3)
                    OR
                    -- Overlapping: new entry starts during existing entry
                    (te.clock_in_time <= $2 AND te.clock_out_time > $2)
                    OR
                    -- Overlapping: new entry ends during existing entry
                    (te.clock_in_time < $3 AND te.clock_out_time >= $3)
                    OR
                    -- Overlapping: new entry completely contains existing entry
                    (te.clock_in_time >= $2 AND te.clock_out_time <= $3)
                    OR
                    -- Overlapping: existing entry completely contains new entry
                    (te.clock_in_time <= $2 AND te.clock_out_time >= $3)
                )
            `;
            const params = [userId, clockInTime, clockOutTime];
            
            if (excludeEntryId) {
                query += ` AND te.id != $4`;
                params.push(excludeEntryId);
            }
            
            const result = await pool.query(query, params);
            return result.rows;
        } else {
            let query = `
                SELECT te.* 
                FROM timesheet_entries te
                WHERE te.user_id = ? 
                AND te.clock_out_time IS NOT NULL
                AND (
                    -- Exact duplicate times
                    (te.clock_in_time = ? AND te.clock_out_time = ?)
                    OR
                    -- Overlapping: new entry starts during existing entry
                    (te.clock_in_time <= ? AND te.clock_out_time > ?)
                    OR
                    -- Overlapping: new entry ends during existing entry
                    (te.clock_in_time < ? AND te.clock_out_time >= ?)
                    OR
                    -- Overlapping: new entry completely contains existing entry
                    (te.clock_in_time >= ? AND te.clock_out_time <= ?)
                    OR
                    -- Overlapping: existing entry completely contains new entry
                    (te.clock_in_time <= ? AND te.clock_out_time >= ?)
                )
            `;
            
            const params = [
                userId, 
                clockInTime, clockOutTime,  // exact duplicate (2 params)
                clockInTime, clockInTime,   // starts during (2 params)
                clockOutTime, clockOutTime, // ends during (2 params)
                clockInTime, clockOutTime, // contains (2 params)
                clockInTime, clockOutTime   // contained by (2 params)
            ];
            
            if (excludeEntryId) {
                query += ` AND te.id != ?`;
                params.push(excludeEntryId);
            }
            
            return db.prepare(query).all(...params);
        }
    }
    
    // Check for duplicate or overlapping timesheet entries for a specific date
    // This is used for "add missing times" to avoid false positives from entries on other days
    static async checkDuplicateTimesForDate(userId, clockInTime, clockOutTime, dateStr, excludeEntryId = null) {
        if (isPostgreSQL) {
            // First, ensure we're only looking at entries on the target date
            // Convert dateStr to a proper date for comparison
            // dateStr should be in format 'YYYY-MM-DD'
            let query = `
                SELECT te.* 
                FROM timesheet_entries te
                WHERE te.user_id = $1 
                AND te.clock_out_time IS NOT NULL
                AND (
                    -- Primary check: Entry starts on the same date (most common case)
                    DATE(te.clock_in_time)::text = $4
                    OR
                    -- Overnight entry that ends on this date (entry started previous day, ended on target date)
                    DATE(te.clock_out_time)::text = $4
                    OR
                    -- Overnight entry that spans across this entire date (rare but possible)
                    (DATE(te.clock_in_time)::text < $4 AND DATE(te.clock_out_time)::text > $4)
                )
                AND (
                    -- Now check for actual time overlaps (only after date filter)
                    -- Exact duplicate times
                    (te.clock_in_time = $2 AND te.clock_out_time = $3)
                    OR
                    -- Overlapping: new entry starts during existing entry
                    (te.clock_in_time <= $2 AND te.clock_out_time > $2)
                    OR
                    -- Overlapping: new entry ends during existing entry
                    (te.clock_in_time < $3 AND te.clock_out_time >= $3)
                    OR
                    -- Overlapping: new entry completely contains existing entry
                    (te.clock_in_time >= $2 AND te.clock_out_time <= $3)
                    OR
                    -- Overlapping: existing entry completely contains new entry
                    (te.clock_in_time <= $2 AND te.clock_out_time >= $3)
                )
            `;
            // Use dateStr as a date parameter - PostgreSQL will handle conversion
            const params = [userId, clockInTime, clockOutTime, dateStr];
            
            if (excludeEntryId) {
                query += ` AND te.id != $5`;
                params.push(excludeEntryId);
            }
            
            const result = await pool.query(query, params);
            return result.rows;
        } else {
            let query = `
                SELECT te.* 
                FROM timesheet_entries te
                WHERE te.user_id = ? 
                AND te.clock_out_time IS NOT NULL
                AND (
                    -- Entry starts on the same date (compare dates only, ignore time)
                    DATE(te.clock_in_time) = DATE(?)
                    OR
                    -- Overnight entry that ends on this date (spans into the date)
                    DATE(te.clock_out_time) = DATE(?)
                    OR
                    -- Overnight entry that spans across this entire date
                    (DATE(te.clock_in_time) < DATE(?) AND DATE(te.clock_out_time) > DATE(?))
                )
                AND (
                    -- Exact duplicate times
                    (te.clock_in_time = ? AND te.clock_out_time = ?)
                    OR
                    -- Overlapping: new entry starts during existing entry
                    (te.clock_in_time <= ? AND te.clock_out_time > ?)
                    OR
                    -- Overlapping: new entry ends during existing entry
                    (te.clock_in_time < ? AND te.clock_out_time >= ?)
                    OR
                    -- Overlapping: new entry completely contains existing entry
                    (te.clock_in_time >= ? AND te.clock_out_time <= ?)
                    OR
                    -- Overlapping: existing entry completely contains new entry
                    (te.clock_in_time <= ? AND te.clock_out_time >= ?)
                )
            `;
            
            const params = [
                userId,
                dateStr, dateStr, dateStr, dateStr,  // date checks (4 params)
                clockInTime, clockOutTime,  // exact duplicate (2 params)
                clockInTime, clockInTime,   // starts during (2 params)
                clockOutTime, clockOutTime, // ends during (2 params)
                clockInTime, clockOutTime, // contains (2 params)
                clockInTime, clockOutTime   // contained by (2 params)
            ];
            
            if (excludeEntryId) {
                query += ` AND te.id != ?`;
                params.push(excludeEntryId);
            }
            
            return db.prepare(query).all(...params);
        }
    }
    
    // Timesheet notices operations
    static async createTimesheetNotice(title, message, priority, expiresAt, createdBy) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO timesheet_notices (title, message, priority, expires_at, created_by)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [title, message, priority, expiresAt, createdBy]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO timesheet_notices (title, message, priority, expires_at, created_by)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(title, message, priority, expiresAt, createdBy);
            return this.getTimesheetNoticeById(info.lastInsertRowid);
        }
    }
    
    static async getActiveTimesheetNotices() {
        const now = new Date().toISOString();
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT tn.*, u.username as created_by_name
                 FROM timesheet_notices tn
                 LEFT JOIN production_users u ON tn.created_by = u.id
                 WHERE tn.status = 'active' 
                 AND (tn.expires_at IS NULL OR tn.expires_at > $1)
                 ORDER BY 
                 CASE tn.priority 
                     WHEN 'urgent' THEN 1
                     WHEN 'high' THEN 2
                     WHEN 'normal' THEN 3
                     WHEN 'low' THEN 4
                 END,
                 tn.created_at DESC`,
                [now]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT tn.*, u.username as created_by_name
                 FROM timesheet_notices tn
                 LEFT JOIN production_users u ON tn.created_by = u.id
                 WHERE tn.status = 'active' 
                 AND (tn.expires_at IS NULL OR tn.expires_at > ?)
                 ORDER BY 
                 CASE tn.priority 
                     WHEN 'urgent' THEN 1
                     WHEN 'high' THEN 2
                     WHEN 'normal' THEN 3
                     WHEN 'low' THEN 4
                 END,
                 tn.created_at DESC`
            ).all(now);
        }
    }
    
    static async getAllTimesheetNotices() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT tn.*, u.username as created_by_name
                 FROM timesheet_notices tn
                 LEFT JOIN production_users u ON tn.created_by = u.id
                 ORDER BY tn.created_at DESC`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT tn.*, u.username as created_by_name
                 FROM timesheet_notices tn
                 LEFT JOIN production_users u ON tn.created_by = u.id
                 ORDER BY tn.created_at DESC`
            ).all();
        }
    }
    
    static async getTimesheetNoticeById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM timesheet_notices WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM timesheet_notices WHERE id = ?`).get(id) || null;
        }
    }
    
    static async updateTimesheetNotice(id, data) {
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (data.title !== undefined) {
            updates.push(`title = $${paramIndex}`);
            values.push(data.title);
            paramIndex++;
        }
        if (data.message !== undefined) {
            updates.push(`message = $${paramIndex}`);
            values.push(data.message);
            paramIndex++;
        }
        if (data.priority !== undefined) {
            updates.push(`priority = $${paramIndex}`);
            values.push(data.priority);
            paramIndex++;
        }
        if (data.status !== undefined) {
            updates.push(`status = $${paramIndex}`);
            values.push(data.status);
            paramIndex++;
        }
        if (data.expires_at !== undefined) {
            updates.push(`expires_at = $${paramIndex}`);
            values.push(data.expires_at);
            paramIndex++;
        }
        
        if (updates.length === 0) {
            return this.getTimesheetNoticeById(id);
        }
        
        values.push(id);
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE timesheet_notices SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
                values
            );
            return result.rows[0];
        } else {
            const setClause = updates.map((update, idx) => {
                const field = update.split(' = ')[0];
                return `${field} = ?`;
            }).join(', ');
            db.prepare(`UPDATE timesheet_notices SET ${setClause} WHERE id = ?`).run(...values);
            return this.getTimesheetNoticeById(id);
        }
    }
    
    static async deleteTimesheetNotice(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`DELETE FROM timesheet_notices WHERE id = $1 RETURNING *`, [id]);
            return result.rows[0] || null;
        } else {
            const notice = this.getTimesheetNoticeById(id);
            db.prepare(`DELETE FROM timesheet_notices WHERE id = ?`).run(id);
            return notice;
        }
    }
    
    // ============ HOUR CALCULATION AND WEEKLY TIMESHEETS ============
    
    // Calculate hours for a timesheet entry
    // Aggregate hours from all timesheet entries for a specific date
    static async aggregateDailyHours(userId, entryDate, overnightAway = false) {
        const dateStr = entryDate instanceof Date ? londonYmd(entryDate) : entryDate;
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT 
                    SUM(regular_hours) as total_regular,
                    SUM(overtime_hours) as total_overtime,
                    SUM(weekend_hours) as total_weekend,
                    SUM(overnight_hours) as total_overnight,
                    SUM(total_hours) as total_hours
                 FROM timesheet_entries
                 WHERE user_id = $1 
                   AND ((clock_in_time AT TIME ZONE 'Europe/London')::date) = $2::date
                   AND clock_out_time IS NOT NULL`,
                [userId, dateStr]
            );
            
            return {
                regular_hours: parseFloat(result.rows[0]?.total_regular || 0),
                overtime_hours: parseFloat(result.rows[0]?.total_overtime || 0),
                weekend_hours: parseFloat(result.rows[0]?.total_weekend || 0),
                overnight_hours: parseFloat(result.rows[0]?.total_overnight || 0),
                total_hours: parseFloat(result.rows[0]?.total_hours || 0)
            };
        } else {
            const startIso = londonDayStartUtc(dateStr);
            const endIso = londonNextDayStartUtc(dateStr);
            const result = db.prepare(
                `SELECT 
                    SUM(regular_hours) as total_regular,
                    SUM(overtime_hours) as total_overtime,
                    SUM(weekend_hours) as total_weekend,
                    SUM(overnight_hours) as total_overnight,
                    SUM(total_hours) as total_hours
                 FROM timesheet_entries
                 WHERE user_id = ? 
                   AND clock_in_time >= ? AND clock_in_time < ?
                   AND clock_out_time IS NOT NULL`
            ).get(userId, startIso, endIso);
            
            return {
                regular_hours: parseFloat(result?.total_regular || 0),
                overtime_hours: parseFloat(result?.total_overtime || 0),
                weekend_hours: parseFloat(result?.total_weekend || 0),
                overnight_hours: parseFloat(result?.total_overnight || 0),
                total_hours: parseFloat(result?.total_hours || 0)
            };
        }
    }
    
    // Helper function to calculate hours based on day_type, overriding aggregated hours if needed
    // Always fetches the latest daily entry from database to ensure day_type is current
    static async calculateHoursForDailyEntry(dailyEntry, aggregatedHours, userId, entryDate) {
        // Always fetch the latest daily entry from database to ensure we have the most current day_type
        // This ensures admin-set day_type always overrides any clock entry hours
        let currentDailyEntry = dailyEntry;
        try {
            const weekStartDate = londonMondayYmdFromYmd(
                typeof entryDate === 'string' ? entryDate.slice(0, 10) : londonYmd(entryDate)
            );
            
            // Get weekly timesheet
            const weeklyTimesheet = await this.getWeeklyTimesheet(userId, weekStartDate);
            if (weeklyTimesheet) {
                // Fetch fresh daily entry from database
                const freshDailyEntry = await this.getDailyEntryByDate(weeklyTimesheet.id, entryDate);
                if (freshDailyEntry) {
                    currentDailyEntry = freshDailyEntry;
                }
            }
        } catch (error) {
            console.error('Error fetching fresh daily entry for day_type check:', error);
            // Fall back to passed-in dailyEntry if fetch fails
        }
        
        // If day_type is set, use day_type rules instead of aggregated hours
        if (currentDailyEntry && currentDailyEntry.day_type) {
            if (currentDailyEntry.day_type === 'holiday_unpaid' || currentDailyEntry.day_type === 'sick_unpaid') {
                // Unpaid days: 0 hours
                return {
                    regular_hours: 0,
                    overtime_hours: 0,
                    weekend_hours: 0,
                    overnight_hours: 0,
                    total_hours: 0
                };
            } else if (currentDailyEntry.day_type === 'sick_paid') {
                // Paid sick: 8 hours Mon-Thu, 6 hours Friday
                const ymd = typeof entryDate === 'string' ? entryDate.slice(0, 10) : londonYmd(entryDate);
                const dayOfWeek = londonWeekdaySun0FromYmd(ymd);
                const hours = (dayOfWeek === 5) ? 6 : 8; // Friday = 6, Mon-Thu = 8
                return {
                    regular_hours: hours,
                    overtime_hours: 0,
                    weekend_hours: 0,
                    overnight_hours: 0,
                    total_hours: hours
                };
            } else if (currentDailyEntry.day_type === 'holiday_paid') {
                // Paid holiday: Friday = 6 hours, Mon-Thu = 8; half day = 4 or 3 (Friday)
                const ymd = typeof entryDate === 'string' ? entryDate.slice(0, 10) : londonYmd(entryDate);
                const dayOfWeek = londonWeekdaySun0FromYmd(ymd);
                let hours = (dayOfWeek === 5) ? 6 : 8;
                try {
                    const allRequests = await this.getHolidayRequestsByUser(userId);
                    const holidayRequest = allRequests.find(req => {
                        if (req.status !== 'approved') return false;
                        const start = new Date(req.start_date);
                        const end = new Date(req.end_date);
                        const mid = new Date(londonDayStartMs(ymd) + 12 * 60 * 60 * 1000);
                        return mid >= start && mid <= end;
                    });
                    if (holidayRequest && holidayRequest.days_requested === 0.5) {
                        hours = (dayOfWeek === 5) ? 3 : 4; // half day
                    }
                } catch (error) {
                    console.error('Error getting holiday request for hours calculation:', error);
                }
                return {
                    regular_hours: hours,
                    overtime_hours: 0,
                    weekend_hours: 0,
                    overnight_hours: 0,
                    total_hours: hours
                };
            }
        }
        
        // No day_type or day_type is null: use aggregated hours from clock entries
        return aggregatedHours;
    }
    
    static async calculateTimesheetHours(entryId, overnightAway = false) {
        const entry = await this.getTimesheetEntryById(entryId);
        if (!entry || !entry.clock_out_time) {
            return null;
        }
        
        let clockIn = new Date(entry.clock_in_time);
        let clockOut = new Date(entry.clock_out_time);
        
        const dayOfWeek = londonWeekdaySun0(clockIn);
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isFriday = dayOfWeek === 5;
        
        if (isFriday || isWeekend) {
            clockIn = roundClockUpLondon15(clockIn);
            clockOut = roundClockDownLondon15(clockOut);
        }
        
        const totalHours = (clockOut - clockIn) / (1000 * 60 * 60); // Convert to hours
        
        let regularHours = 0;
        let overtimeHours = 0;
        let weekendHours = 0;
        let overnightHours = 0;
        let calculatedTotal = 0;
        
        if (overnightAway) {
            // All hours are overnight (1.25x) - but still deduct normal 1hr break
            const netHours = Math.max(0, totalHours - 1);
            overnightHours = netHours;
            calculatedTotal = netHours;
        } else if (isWeekend) {
            // All hours are weekend (1.5x)
            weekendHours = totalHours;
            calculatedTotal = totalHours;
        } else if (isFriday) {
            // Friday: Standard hours only between 8am and 3pm London (45min break)
            const ymd = londonYmd(clockIn);
            const standardStart = londonLocalTimeToUtc(ymd, 8, 0, 0);
            const standardEnd = londonLocalTimeToUtc(ymd, 15, 0, 0);
            
            // Calculate hours within standard window (8am-3pm)
            const clockInInWindow = clockIn > standardStart ? clockIn : standardStart;
            const clockOutInWindow = clockOut < standardEnd ? clockOut : standardEnd;
            const hoursInWindow = Math.max(0, (clockOutInWindow - clockInInWindow) / (1000 * 60 * 60));
            
            // Calculate hours before 8am
            const hoursBefore8am = clockIn < standardStart ? Math.max(0, (standardStart - clockIn) / (1000 * 60 * 60)) : 0;
            
            // Calculate hours after 3pm
            const hoursAfter3pm = clockOut > standardEnd ? Math.max(0, (clockOut - standardEnd) / (1000 * 60 * 60)) : 0;
            
            // Standard hours: time within 8am-3pm window minus 45 minute break
            regularHours = Math.max(0, hoursInWindow - 0.75); // 45 minutes = 0.75 hours
            
            // Overtime: hours before 8am + hours after 3pm
            overtimeHours = hoursBefore8am + hoursAfter3pm;
            
            // Total calculated hours (net of break)
            calculatedTotal = regularHours + overtimeHours;
        } else {
            // Monday-Thursday: subtract 1 hour break, then calculate
            const netHours = Math.max(0, totalHours - 1);
            if (netHours <= 8) {
                regularHours = netHours;
            } else {
                regularHours = 8;
                overtimeHours = netHours - 8;
            }
            calculatedTotal = netHours;
        }
        
        const calculatedAt = new Date().toISOString();
        
        if (isPostgreSQL) {
            await pool.query(
                `UPDATE timesheet_entries 
                 SET regular_hours = $1, overtime_hours = $2, weekend_hours = $3, 
                     overnight_hours = $4, total_hours = $5, calculated_at = $6
                 WHERE id = $7`,
                [regularHours, overtimeHours, weekendHours, overnightHours, calculatedTotal, calculatedAt, entryId]
            );
        } else {
            db.prepare(
                `UPDATE timesheet_entries 
                 SET regular_hours = ?, overtime_hours = ?, weekend_hours = ?, 
                     overnight_hours = ?, total_hours = ?, calculated_at = ?
                 WHERE id = ?`
            ).run(regularHours, overtimeHours, weekendHours, overnightHours, calculatedTotal, calculatedAt, entryId);
        }
        
        return {
            regular_hours: regularHours,
            overtime_hours: overtimeHours,
            weekend_hours: weekendHours,
            overnight_hours: overnightHours,
            total_hours: calculatedTotal
        };
    }
    
    // Weekly timesheet operations
    static async getOrCreateWeeklyTimesheet(userId, weekStartDate) {
        try {
            // weekStartDate should be a Monday date in YYYY-MM-DD format (London calendar)
            const weekStartStr = weekStartDate;
            const weekEndStr = londonYmdAddDays(weekStartDate, 6);
            
            if (isPostgreSQL) {
                // Try to get existing
                let result = await pool.query(
                    `SELECT * FROM weekly_timesheets 
                     WHERE user_id = $1 AND week_start_date = $2`,
                    [userId, weekStartStr]
                );
                
                if (result.rows.length > 0) {
                    return result.rows[0];
                }
                
                // Create new
                result = await pool.query(
                    `INSERT INTO weekly_timesheets (user_id, week_start_date, week_end_date)
                     VALUES ($1, $2, $3) RETURNING *`,
                    [userId, weekStartStr, weekEndStr]
                );
                return result.rows[0];
            } else {
                let existing = db.prepare(
                    `SELECT * FROM weekly_timesheets 
                     WHERE user_id = ? AND week_start_date = ?`
                ).get(userId, weekStartStr);
                
                if (existing) {
                    return existing;
                }
                
                const stmt = db.prepare(
                    `INSERT INTO weekly_timesheets (user_id, week_start_date, week_end_date)
                     VALUES (?, ?, ?)`
                );
                const info = stmt.run(userId, weekStartStr, weekEndStr);
                return db.prepare(`SELECT * FROM weekly_timesheets WHERE id = ?`).get(info.lastInsertRowid);
            }
        } catch (error) {
            console.error('Error in getOrCreateWeeklyTimesheet:', error);
            if (error.code === '42P01') { // Table doesn't exist
                throw new Error('Database tables not initialized. Please restart the server.');
            }
            throw error;
        }
    }
    
    static async getWeeklyTimesheet(userId, weekStartDate) {
        try {
            if (isPostgreSQL) {
                const result = await pool.query(
                    `SELECT wt.*, u.username,
                     (SELECT COUNT(*) FROM timesheet_daily_entries WHERE weekly_timesheet_id = wt.id) as day_count
                     FROM weekly_timesheets wt
                     LEFT JOIN production_users u ON wt.user_id = u.id
                     WHERE wt.user_id = $1 AND wt.week_start_date = $2`,
                    [userId, weekStartDate]
                );
                return result.rows[0] || null;
            } else {
                return db.prepare(
                    `SELECT wt.*, u.username,
                     (SELECT COUNT(*) FROM timesheet_daily_entries WHERE weekly_timesheet_id = wt.id) as day_count
                     FROM weekly_timesheets wt
                     LEFT JOIN production_users u ON wt.user_id = u.id
                     WHERE wt.user_id = ? AND wt.week_start_date = ?`
                ).get(userId, weekStartDate) || null;
            }
        } catch (error) {
            console.error('Error in getWeeklyTimesheet:', error);
            if (error.code === '42P01') { // Table doesn't exist
                throw new Error('Database tables not initialized. Please restart the server.');
            }
            throw error;
        }
    }
    
    static async updateWeeklyTimesheet(id, data) {
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (data.status !== undefined) {
            updates.push(isPostgreSQL ? `status = $${paramIndex}` : `status = ?`);
            values.push(data.status);
            paramIndex++;
        }
        
        if (data.manager_approved !== undefined) {
            updates.push(isPostgreSQL ? `manager_approved = $${paramIndex}` : `manager_approved = ?`);
            values.push(data.manager_approved ? 1 : 0);
            paramIndex++;
            
            // If approving, set approved_by and approved_at
            if (data.manager_approved) {
                if (data.approved_by !== undefined) {
                    updates.push(isPostgreSQL ? `approved_by = $${paramIndex}` : `approved_by = ?`);
                    values.push(data.approved_by);
                    paramIndex++;
                }
                updates.push(isPostgreSQL ? `approved_at = CURRENT_TIMESTAMP` : `approved_at = CURRENT_TIMESTAMP`);
            } else {
                // If unapproving, clear approved_by and approved_at
                updates.push(`approved_by = NULL`);
                updates.push(`approved_at = NULL`);
            }
        }
        
        if (updates.length === 0) {
            return this.getWeeklyTimesheetById(id);
        }
        
        if (isPostgreSQL) {
            values.push(id);
            const result = await pool.query(
                `UPDATE weekly_timesheets SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
                values
            );
            return result.rows[0];
        } else {
            // Build set clause and values array separately for SQLite
            // Need to match placeholders with values, skipping NULL and CURRENT_TIMESTAMP
            const setParts = [];
            const sqliteValues = [];
            let valueIndex = 0; // Track position in values array
            
            for (const update of updates) {
                if (update.includes('NULL')) {
                    // NULL values don't need a placeholder
                    setParts.push(update);
                    // Don't increment valueIndex - no value needed
                } else if (update.includes('CURRENT_TIMESTAMP')) {
                    // CURRENT_TIMESTAMP doesn't need a placeholder
                    setParts.push(update);
                    // Don't increment valueIndex - no value needed
                } else {
                    // Extract field name and add placeholder
                    const field = update.split(' = ')[0];
                    setParts.push(`${field} = ?`);
                    // Add corresponding value from values array
                    sqliteValues.push(values[valueIndex]);
                    valueIndex++; // Move to next value
                }
            }
            
            sqliteValues.push(id); // Add id at the end for WHERE clause
            const setClause = setParts.join(', ');
            db.prepare(`UPDATE weekly_timesheets SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...sqliteValues);
            return this.getWeeklyTimesheetById(id);
        }
    }
    
    static async getWeeklyTimesheetById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT wt.*, u.username FROM weekly_timesheets wt
                 LEFT JOIN production_users u ON wt.user_id = u.id
                 WHERE wt.id = $1`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT wt.*, u.username FROM weekly_timesheets wt
                 LEFT JOIN production_users u ON wt.user_id = u.id
                 WHERE wt.id = ?`
            ).get(id) || null;
        }
    }
    
    // Daily entry operations
    static async getOrCreateDailyEntry(weeklyTimesheetId, entryDate, timesheetEntryId = null) {
        if (isPostgreSQL) {
            let result = await pool.query(
                `SELECT * FROM timesheet_daily_entries 
                 WHERE weekly_timesheet_id = $1 AND entry_date = $2`,
                [weeklyTimesheetId, entryDate]
            );
            
            if (result.rows.length > 0) {
                return result.rows[0];
            }
            
            result = await pool.query(
                `INSERT INTO timesheet_daily_entries (weekly_timesheet_id, entry_date, timesheet_entry_id)
                 VALUES ($1, $2, $3) RETURNING *`,
                [weeklyTimesheetId, entryDate, timesheetEntryId]
            );
            return result.rows[0];
        } else {
            let existing = db.prepare(
                `SELECT * FROM timesheet_daily_entries 
                 WHERE weekly_timesheet_id = ? AND entry_date = ?`
            ).get(weeklyTimesheetId, entryDate);
            
            if (existing) {
                return existing;
            }
            
            const stmt = db.prepare(
                `INSERT INTO timesheet_daily_entries (weekly_timesheet_id, entry_date, timesheet_entry_id)
                 VALUES (?, ?, ?)`
            );
            const info = stmt.run(weeklyTimesheetId, entryDate, timesheetEntryId);
            return db.prepare(`SELECT * FROM timesheet_daily_entries WHERE id = ?`).get(info.lastInsertRowid);
        }
    }
    
    static async updateDailyEntry(id, data) {
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (data.daily_notes !== undefined) {
            updates.push(isPostgreSQL ? `daily_notes = $${paramIndex}` : `daily_notes = ?`);
            values.push(data.daily_notes);
            paramIndex++;
        }
        if (data.overnight_away !== undefined) {
            updates.push(isPostgreSQL ? `overnight_away = $${paramIndex}` : `overnight_away = ?`);
            values.push(data.overnight_away ? (isPostgreSQL ? true : 1) : (isPostgreSQL ? false : 0));
            paramIndex++;
        }
        if (data.regular_hours !== undefined) {
            updates.push(isPostgreSQL ? `regular_hours = $${paramIndex}` : `regular_hours = ?`);
            values.push(data.regular_hours);
            paramIndex++;
        }
        if (data.overtime_hours !== undefined) {
            updates.push(isPostgreSQL ? `overtime_hours = $${paramIndex}` : `overtime_hours = ?`);
            values.push(data.overtime_hours);
            paramIndex++;
        }
        if (data.weekend_hours !== undefined) {
            updates.push(isPostgreSQL ? `weekend_hours = $${paramIndex}` : `weekend_hours = ?`);
            values.push(data.weekend_hours);
            paramIndex++;
        }
        if (data.overnight_hours !== undefined) {
            updates.push(isPostgreSQL ? `overnight_hours = $${paramIndex}` : `overnight_hours = ?`);
            values.push(data.overnight_hours);
            paramIndex++;
        }
        if (data.total_hours !== undefined) {
            updates.push(isPostgreSQL ? `total_hours = $${paramIndex}` : `total_hours = ?`);
            values.push(data.total_hours);
            paramIndex++;
        }
        if (data.day_type !== undefined) {
            updates.push(isPostgreSQL ? `day_type = $${paramIndex}` : `day_type = ?`);
            values.push(data.day_type || null);
            paramIndex++;
        }
        
        if (updates.length === 0) {
            return this.getDailyEntryById(id);
        }
        
        if (isPostgreSQL) {
            values.push(id);
            const result = await pool.query(
                `UPDATE timesheet_daily_entries SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
                values
            );
            return result.rows[0];
        } else {
            values.push(id);
            const setClause = updates.map((update, idx) => {
                const field = update.split(' = ')[0];
                return `${field} = ?`;
            }).join(', ');
            db.prepare(`UPDATE timesheet_daily_entries SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
            return this.getDailyEntryById(id);
        }
    }
    
    static async getDailyEntryById(id) {
        let entry;
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM timesheet_daily_entries WHERE id = $1`, [id]);
            entry = result.rows[0] || null;
        } else {
            entry = db.prepare(`SELECT * FROM timesheet_daily_entries WHERE id = ?`).get(id) || null;
        }
        
        // Normalize overnight_away to boolean
        if (entry) {
            entry.overnight_away = entry.overnight_away === true || entry.overnight_away === 1 || entry.overnight_away === '1';
        }
        
        return entry;
    }
    
    static async getDailyEntriesForWeek(weeklyTimesheetId) {
        try {
            let entries;
            if (isPostgreSQL) {
                const result = await pool.query(
                    `SELECT tde.*, te.clock_in_time, te.clock_out_time
                     FROM timesheet_daily_entries tde
                     LEFT JOIN timesheet_entries te ON tde.timesheet_entry_id = te.id
                     WHERE tde.weekly_timesheet_id = $1
                     ORDER BY tde.entry_date`,
                    [weeklyTimesheetId]
                );
                entries = result.rows || [];
            } else {
                entries = db.prepare(
                    `SELECT tde.*, te.clock_in_time, te.clock_out_time
                     FROM timesheet_daily_entries tde
                     LEFT JOIN timesheet_entries te ON tde.timesheet_entry_id = te.id
                     WHERE tde.weekly_timesheet_id = ?
                     ORDER BY tde.entry_date`
                ).all(weeklyTimesheetId) || [];
            }
            
            // Normalize overnight_away to boolean for consistency (SQLite returns 0/1, PostgreSQL returns true/false)
            return entries.map(entry => ({
                ...entry,
                overnight_away: entry.overnight_away === true || entry.overnight_away === 1 || entry.overnight_away === '1'
            }));
        } catch (error) {
            console.error('Error in getDailyEntriesForWeek:', error);
            if (error.code === '42P01') { // Table doesn't exist
                throw new Error('Database tables not initialized. Please restart the server.');
            }
            // Return empty array on error rather than throwing
            console.warn('Returning empty array for daily entries due to error');
            return [];
        }
    }
    
    static async getDailyEntryByDate(weeklyTimesheetId, date) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT tde.*, te.clock_in_time, te.clock_out_time
                 FROM timesheet_daily_entries tde
                 LEFT JOIN timesheet_entries te ON tde.timesheet_entry_id = te.id
                 WHERE tde.weekly_timesheet_id = $1 AND tde.entry_date = $2`,
                [weeklyTimesheetId, date]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT tde.*, te.clock_in_time, te.clock_out_time
                 FROM timesheet_daily_entries tde
                 LEFT JOIN timesheet_entries te ON tde.timesheet_entry_id = te.id
                 WHERE tde.weekly_timesheet_id = ? AND tde.entry_date = ?`
            ).get(weeklyTimesheetId, date) || null;
        }
    }
    
    // Create missing timesheet entry (for days they forgot to clock in)
    static async createMissingTimesheetEntry(userId, jobId, clockInTime, clockOutTime, reason) {
        // First create the timesheet entry
        let entryId;
        if (isPostgreSQL) {
            const entryResult = await pool.query(
                `INSERT INTO timesheet_entries 
                 (user_id, job_id, clock_in_time, clock_out_time, clock_in_latitude, clock_in_longitude, clock_out_latitude, clock_out_longitude)
                 VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL) RETURNING id`,
                [userId, jobId, clockInTime, clockOutTime]
            );
            entryId = entryResult.rows[0].id;
        } else {
            const entryStmt = db.prepare(
                `INSERT INTO timesheet_entries 
                 (user_id, job_id, clock_in_time, clock_out_time, clock_in_latitude, clock_in_longitude, clock_out_latitude, clock_out_longitude)
                 VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)`
            );
            const entryInfo = entryStmt.run(userId, jobId, clockInTime, clockOutTime);
            entryId = entryInfo.lastInsertRowid;
        }
        
        // Then create an amendment request for it (original times = created times, amended times = same, but needs approval)
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [entryId, userId, clockInTime, clockOutTime, clockInTime, clockOutTime, reason]
            );
            return { entry: await this.getTimesheetEntryById(entryId), amendment: result.rows[0] };
        } else {
            const stmt = db.prepare(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(entryId, userId, clockInTime, clockOutTime, clockInTime, clockOutTime, reason);
            return { 
                entry: await this.getTimesheetEntryById(entryId), 
                amendment: db.prepare(`SELECT * FROM timesheet_amendments WHERE id = ?`).get(info.lastInsertRowid) 
            };
        }
    }
    
    // Admin-only: Directly create timesheet entry (applies immediately, no approval needed)
    static async adminCreateTimesheetEntry(userId, adminId, jobId, clockInTime, clockOutTime, reason, overnightAway) {
        const now = new Date().toISOString();
        
        console.log(`Admin creating timesheet entry for user ${userId}:`, {
            job_id: jobId,
            clock_in: clockInTime,
            clock_out: clockOutTime,
            overnight_away: overnightAway,
            adminId
        });
        
        // Create the timesheet entry directly with admin edit tracking
        let entryId;
        if (isPostgreSQL) {
            const entryResult = await pool.query(
                `INSERT INTO timesheet_entries 
                 (user_id, job_id, clock_in_time, clock_out_time, clock_in_latitude, clock_in_longitude, 
                  clock_out_latitude, clock_out_longitude, edited_by_admin_id, edited_by_admin_at, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, $6, $6, $6) RETURNING id`,
                [userId, jobId, clockInTime, clockOutTime, adminId, now]
            );
            entryId = entryResult.rows[0].id;
        } else {
            const entryStmt = db.prepare(
                `INSERT INTO timesheet_entries 
                 (user_id, job_id, clock_in_time, clock_out_time, clock_in_latitude, clock_in_longitude, 
                  clock_out_latitude, clock_out_longitude, edited_by_admin_id, edited_by_admin_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`
            );
            const entryInfo = entryStmt.run(userId, jobId, clockInTime, clockOutTime, adminId, now, now, now);
            entryId = entryInfo.lastInsertRowid;
        }
        
        // Get clock-in date to determine which week
        const clockInDate = new Date(clockInTime);
        const clockInDateStr = londonYmd(clockInDate);
        
        const weekStartDate = londonMondayYmd(clockInDate);
        
        // Get or create weekly timesheet
        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(userId, weekStartDate);
        
        // Get or create daily entry
        let dailyEntryRecord = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        if (!dailyEntryRecord) {
            dailyEntryRecord = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entryId);
        }
        
        // Update overnight_away if provided
        if (overnightAway !== undefined) {
            await this.updateDailyEntry(dailyEntryRecord.id, {
                overnight_away: overnightAway
            });
        }
        
        // Get the current overnight_away value (either from update or existing)
        const updatedDailyEntry = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        const finalOvernightAway = overnightAway !== undefined ? overnightAway : (updatedDailyEntry ? updatedDailyEntry.overnight_away : false);
        
        // Calculate hours for the new entry
        await this.calculateTimesheetHours(entryId, finalOvernightAway);
        
        // Aggregate hours from ALL entries for this day
        const aggregatedHours = await this.aggregateDailyHours(userId, clockInDateStr, finalOvernightAway);
        
        // Get the daily entry to check day_type
        const dailyEntryForCheck = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        
        // Calculate final hours based on day_type (unpaid days override aggregated hours)
        const finalHours = await this.calculateHoursForDailyEntry(dailyEntryForCheck || dailyEntryRecord, aggregatedHours, userId, clockInDateStr);
        
        // Update daily entry with final hours
        await this.updateDailyEntry(dailyEntryRecord.id, {
            timesheet_entry_id: entryId,
            regular_hours: finalHours.regular_hours,
            overtime_hours: finalHours.overtime_hours,
            weekend_hours: finalHours.weekend_hours,
            overnight_hours: finalHours.overnight_hours,
            total_hours: finalHours.total_hours
        });
        
        // Create an amendment record for audit trail (marked as approved/admin)
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason, status, reviewed_by, reviewed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9)`,
                [entryId, userId, clockInTime, clockOutTime,
                 clockInTime, clockOutTime, reason || 'Created by admin', adminId, now]
            );
        } else {
            db.prepare(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason, status, reviewed_by, reviewed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`
            ).run(entryId, userId, clockInTime, clockOutTime,
                 clockInTime, clockOutTime, reason || 'Created by admin', adminId, now);
        }
        
        // Return the created entry
        return await this.getTimesheetEntryById(entryId);
    }
    
    // Amendment operations
    static async getPendingAmendmentForEntry(entryId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM timesheet_amendments WHERE timesheet_entry_id = $1 AND status = 'pending' LIMIT 1`,
                [entryId]
            );
            return result.rows[0] || null;
        }
        return db.prepare(
            `SELECT * FROM timesheet_amendments WHERE timesheet_entry_id = ? AND status = 'pending' LIMIT 1`
        ).get(entryId) || null;
    }
    
    static async requestTimeAmendment(entryId, userId, amendedClockIn, amendedClockOut, reason) {
        const entry = await this.getTimesheetEntryById(entryId);
        if (!entry) {
            throw new Error('Timesheet entry not found');
        }
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [entryId, userId, entry.clock_in_time, entry.clock_out_time, 
                 amendedClockIn, amendedClockOut, reason]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(entryId, userId, entry.clock_in_time, entry.clock_out_time,
                                 amendedClockIn, amendedClockOut, reason);
            return db.prepare(`SELECT * FROM timesheet_amendments WHERE id = ?`).get(info.lastInsertRowid);
        }
    }
    
    static async getPendingAmendments() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT ta.*, u.username, te.clock_in_time as current_clock_in, te.clock_out_time as current_clock_out
                 FROM timesheet_amendments ta
                 LEFT JOIN production_users u ON ta.user_id = u.id
                 LEFT JOIN timesheet_entries te ON ta.timesheet_entry_id = te.id
                 WHERE ta.status = 'pending'
                 ORDER BY ta.created_at DESC`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT ta.*, u.username, te.clock_in_time as current_clock_in, te.clock_out_time as current_clock_out
                 FROM timesheet_amendments ta
                 LEFT JOIN production_users u ON ta.user_id = u.id
                 LEFT JOIN timesheet_entries te ON ta.timesheet_entry_id = te.id
                 WHERE ta.status = 'pending'
                 ORDER BY ta.created_at DESC`
            ).all();
        }
    }
    
    static async getUserAmendments(userId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT ta.*, te.clock_in_time as current_clock_in, te.clock_out_time as current_clock_out
                 FROM timesheet_amendments ta
                 LEFT JOIN timesheet_entries te ON ta.timesheet_entry_id = te.id
                 WHERE ta.user_id = $1
                 ORDER BY ta.created_at DESC`,
                [userId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT ta.*, te.clock_in_time as current_clock_in, te.clock_out_time as current_clock_out
                 FROM timesheet_amendments ta
                 LEFT JOIN timesheet_entries te ON ta.timesheet_entry_id = te.id
                 WHERE ta.user_id = ?
                 ORDER BY ta.created_at DESC`
            ).all(userId);
        }
    }
    
    static async reviewAmendment(amendmentId, reviewerId, status, reviewNotes, approvedClockIn = null, approvedClockOut = null) {
        const reviewedAt = new Date().toISOString();
        
        if (isPostgreSQL) {
            // If approved and approved times provided, update the amended times
            if (status === 'approved' && approvedClockIn && approvedClockOut) {
                const result = await pool.query(
                    `UPDATE timesheet_amendments 
                     SET status = $1, reviewed_by = $2, reviewed_at = $3, review_notes = $4,
                         amended_clock_in_time = $5, amended_clock_out_time = $6
                     WHERE id = $7 RETURNING *`,
                    [status, reviewerId, reviewedAt, reviewNotes, approvedClockIn, approvedClockOut, amendmentId]
                );
                return result.rows[0];
            } else {
                const result = await pool.query(
                    `UPDATE timesheet_amendments 
                     SET status = $1, reviewed_by = $2, reviewed_at = $3, review_notes = $4
                     WHERE id = $5 RETURNING *`,
                    [status, reviewerId, reviewedAt, reviewNotes, amendmentId]
                );
                return result.rows[0];
            }
        } else {
            // If approved and approved times provided, update the amended times
            if (status === 'approved' && approvedClockIn && approvedClockOut) {
                db.prepare(
                    `UPDATE timesheet_amendments 
                     SET status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ?,
                         amended_clock_in_time = ?, amended_clock_out_time = ?
                     WHERE id = ?`
                ).run(status, reviewerId, reviewedAt, reviewNotes, approvedClockIn, approvedClockOut, amendmentId);
            } else {
                db.prepare(
                    `UPDATE timesheet_amendments 
                     SET status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ?
                     WHERE id = ?`
                ).run(status, reviewerId, reviewedAt, reviewNotes, amendmentId);
            }
            return db.prepare(`SELECT * FROM timesheet_amendments WHERE id = ?`).get(amendmentId);
        }
    }
    
    static async applyAmendment(amendmentId, approvedClockIn = null, approvedClockOut = null) {
        const amendment = await this.getAmendmentById(amendmentId);
        if (!amendment || amendment.status !== 'approved') {
            throw new Error('Amendment not found or not approved');
        }
        
        // Use approved times if provided (manager modified), otherwise use requested times
        const finalClockIn = approvedClockIn || amendment.amended_clock_in_time;
        const finalClockOut = approvedClockOut || amendment.amended_clock_out_time;
        
        // Get the entry to find user_id
        const entry = await this.getTimesheetEntryById(amendment.timesheet_entry_id);
        if (!entry) {
            throw new Error('Timesheet entry not found');
        }
        
        // Update the timesheet entry
        if (isPostgreSQL) {
            await pool.query(
                `UPDATE timesheet_entries 
                 SET clock_in_time = $1, clock_out_time = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [finalClockIn, finalClockOut, amendment.timesheet_entry_id]
            );
        } else {
            db.prepare(
                `UPDATE timesheet_entries 
                 SET clock_in_time = ?, clock_out_time = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            ).run(finalClockIn, finalClockOut, amendment.timesheet_entry_id);
        }
        
        // Recalculate hours for this entry
        const dailyEntry = await this.getDailyEntryByTimesheetEntryId(amendment.timesheet_entry_id);
        const overnightAway = dailyEntry ? dailyEntry.overnight_away : false;
        await this.calculateTimesheetHours(amendment.timesheet_entry_id, overnightAway);
        
        // Get clock-in date to determine which week
        const clockInDate = new Date(finalClockIn);
        const clockInDateStr = londonYmd(clockInDate);
        
        const weekStartDate = londonMondayYmd(clockInDate);
        
        // Get or create weekly timesheet
        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
        
        // Get or create daily entry
        let dailyEntryRecord = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        if (!dailyEntryRecord) {
            dailyEntryRecord = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, amendment.timesheet_entry_id);
        }
        
        // Aggregate hours from ALL entries for this day
        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
        
        // Calculate final hours based on day_type (unpaid days override aggregated hours)
        const finalHours = await this.calculateHoursForDailyEntry(dailyEntryRecord, aggregatedHours, entry.user_id, clockInDateStr);
        
        // Update daily entry with final hours
        await this.updateDailyEntry(dailyEntryRecord.id, {
            timesheet_entry_id: amendment.timesheet_entry_id,
            regular_hours: finalHours.regular_hours,
            overtime_hours: finalHours.overtime_hours,
            weekend_hours: finalHours.weekend_hours,
            overnight_hours: finalHours.overnight_hours,
            total_hours: finalHours.total_hours
        });
        
        return amendment;
    }
    
    // Admin-only: Directly amend timesheet entry (applies immediately, no approval needed)
    static async adminAmendTimesheetEntry(entryId, adminId, amendedClockIn, amendedClockOut, reason, overnightAway) {
        const entry = await this.getTimesheetEntryById(entryId);
        if (!entry) {
            throw new Error('Timesheet entry not found');
        }
        
        console.log(`Admin amending timesheet entry ${entryId}:`, {
            original: { clock_in: entry.clock_in_time, clock_out: entry.clock_out_time },
            amended: { clock_in: amendedClockIn, clock_out: amendedClockOut },
            overnight_away: overnightAway,
            adminId
        });
        
        const now = new Date().toISOString();
        
        // Update the timesheet entry directly with admin edit tracking
        if (isPostgreSQL) {
            const updateResult = await pool.query(
                `UPDATE timesheet_entries 
                 SET clock_in_time = $1, clock_out_time = $2, 
                     edited_by_admin_id = $3, edited_by_admin_at = $4,
                     updated_at = $4
                 WHERE id = $5
                 RETURNING *`,
                [amendedClockIn, amendedClockOut, adminId, now, entryId]
            );
            
            if (updateResult.rows.length === 0) {
                throw new Error('Failed to update timesheet entry - no rows affected');
            }
            
            console.log('Timesheet entry updated successfully:', updateResult.rows[0]);
        } else {
            const updateStmt = db.prepare(
                `UPDATE timesheet_entries 
                 SET clock_in_time = ?, clock_out_time = ?, 
                     edited_by_admin_id = ?, edited_by_admin_at = ?,
                     updated_at = ?
                 WHERE id = ?`
            );
            const updateInfo = updateStmt.run(amendedClockIn, amendedClockOut, adminId, now, now, entryId);
            
            if (updateInfo.changes === 0) {
                throw new Error('Failed to update timesheet entry - no rows affected');
            }
            
            console.log('Timesheet entry updated successfully, changes:', updateInfo.changes);
        }
        
        // Create an amendment record for audit trail (marked as approved/admin)
        if (isPostgreSQL) {
            await pool.query(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason, status, reviewed_by, reviewed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9)`,
                [entryId, entry.user_id, entry.clock_in_time, entry.clock_out_time,
                 amendedClockIn, amendedClockOut, reason || 'Amended by admin', adminId, now]
            );
        } else {
            db.prepare(
                `INSERT INTO timesheet_amendments 
                 (timesheet_entry_id, user_id, original_clock_in_time, original_clock_out_time,
                  amended_clock_in_time, amended_clock_out_time, reason, status, reviewed_by, reviewed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`
            ).run(entryId, entry.user_id, entry.clock_in_time, entry.clock_out_time,
                 amendedClockIn, amendedClockOut, reason || 'Amended by admin', adminId, now);
        }
        
        // Get clock-in date to determine which week
        const clockInDate = new Date(amendedClockIn);
        const clockInDateStr = londonYmd(clockInDate);
        
        const weekStartDate = londonMondayYmd(clockInDate);
        
        // Get or create weekly timesheet
        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
        
        // Get or create daily entry
        let dailyEntryRecord = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        if (!dailyEntryRecord) {
            dailyEntryRecord = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entryId);
        }
        
        // Update overnight_away if provided
        if (overnightAway !== undefined) {
            await this.updateDailyEntry(dailyEntryRecord.id, {
                overnight_away: overnightAway
            });
        }
        
        // Get the current overnight_away value (either from update or existing)
        const updatedDailyEntry = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        const finalOvernightAway = overnightAway !== undefined ? overnightAway : (updatedDailyEntry ? updatedDailyEntry.overnight_away : false);
        
        // Recalculate hours for ALL entries for this day with the correct overnight_away value
        const weekEndStr = londonYmdAddDays(weekStartDate, 6);
        const allEntries = await this.getTimesheetHistory(entry.user_id, weekStartDate, weekEndStr);
        const dayEntries = allEntries.filter(te => {
            const teDate = londonYmd(new Date(te.clock_in_time));
            return teDate === clockInDateStr && te.clock_out_time;
        });
        
        // Recalculate hours for each entry on this day
        for (const dayEntry of dayEntries) {
            await this.calculateTimesheetHours(dayEntry.id, finalOvernightAway);
        }
        
        // Aggregate hours from ALL entries for this day
        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, finalOvernightAway);
        
        // Calculate final hours based on day_type (unpaid days override aggregated hours)
        const finalHours = await this.calculateHoursForDailyEntry(dailyEntryRecord, aggregatedHours, entry.user_id, clockInDateStr);
        
        // Update daily entry with final hours
        await this.updateDailyEntry(dailyEntryRecord.id, {
            timesheet_entry_id: entryId,
            regular_hours: finalHours.regular_hours,
            overtime_hours: finalHours.overtime_hours,
            weekend_hours: finalHours.weekend_hours,
            overnight_hours: finalHours.overnight_hours,
            total_hours: finalHours.total_hours
        });
        
        // Return the updated entry
        return await this.getTimesheetEntryById(entryId);
    }
    
    static async getAmendmentById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM timesheet_amendments WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM timesheet_amendments WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getDailyEntryByTimesheetEntryId(timesheetEntryId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM timesheet_daily_entries WHERE timesheet_entry_id = $1`,
                [timesheetEntryId]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM timesheet_daily_entries WHERE timesheet_entry_id = ?`).get(timesheetEntryId) || null;
        }
    }
    
    // Payroll operations
    static async getPayrollSummary(weekStartDate) {
        if (isPostgreSQL) {
            // Use ONLY daily entries as source of truth (they already aggregate all timesheet entries per day)
            const result = await pool.query(
                `SELECT 
                    u.id as user_id,
                    u.username,
                    $1::date as week_start_date,
                    COALESCE(SUM(tde.regular_hours), 0) as total_regular_hours,
                    COALESCE(SUM(tde.overtime_hours), 0) as total_overtime_hours,
                    COALESCE(SUM(tde.weekend_hours), 0) as total_weekend_hours,
                    COALESCE(SUM(tde.overnight_hours), 0) as total_overnight_hours,
                    COALESCE(SUM(tde.total_hours), 0) as total_hours,
                    COUNT(DISTINCT tde.entry_date) as days_worked,
                    wt.manager_approved,
                    wt.approved_by,
                    wt.approved_at,
                    approver.username as approved_by_username
                 FROM production_users u
                 INNER JOIN weekly_timesheets wt ON u.id = wt.user_id AND wt.week_start_date = $1::date
                 INNER JOIN timesheet_daily_entries tde ON wt.id = tde.weekly_timesheet_id
                 LEFT JOIN production_users approver ON wt.approved_by = approver.id
                 WHERE (u.role = 'staff' OR u.role = 'office' OR u.role = 'admin' OR u.role = 'manager')
                   AND (u.status IS NULL OR u.status = 'active')
                   AND tde.total_hours > 0
                 GROUP BY u.id, u.username, wt.manager_approved, wt.approved_by, wt.approved_at, approver.username
                 ORDER BY u.username`,
                [weekStartDate]
            );
            return result.rows;
        } else {
            // Use ONLY daily entries as source of truth (they already aggregate all timesheet entries per day)
            const result = db.prepare(
                `SELECT 
                    u.id as user_id,
                    u.username,
                    wt.week_start_date,
                    COALESCE(SUM(tde.regular_hours), 0) as total_regular_hours,
                    COALESCE(SUM(tde.overtime_hours), 0) as total_overtime_hours,
                    COALESCE(SUM(tde.weekend_hours), 0) as total_weekend_hours,
                    COALESCE(SUM(tde.overnight_hours), 0) as total_overnight_hours,
                    COALESCE(SUM(tde.total_hours), 0) as total_hours,
                    COUNT(DISTINCT tde.entry_date) as days_worked,
                    wt.manager_approved,
                    wt.approved_by,
                    wt.approved_at,
                    approver.username as approved_by_username
                 FROM weekly_timesheets wt
                 INNER JOIN production_users u ON wt.user_id = u.id
                 INNER JOIN timesheet_daily_entries tde ON wt.id = tde.weekly_timesheet_id
                 LEFT JOIN production_users approver ON wt.approved_by = approver.id
                 WHERE wt.week_start_date = ?
                   AND (u.role = 'staff' OR u.role = 'office' OR u.role = 'admin' OR u.role = 'manager')
                   AND (u.status IS NULL OR u.status = 'active')
                   AND tde.total_hours > 0
                 GROUP BY u.id, u.username, wt.week_start_date, wt.manager_approved, wt.approved_by, wt.approved_at, approver.username
                 ORDER BY u.username`
            ).all(weekStartDate);
            
            return result;
        }
    }
    
    // Get daily payroll breakdown for a specific user
    static async getPayrollDailyBreakdown(userId, weekStartDate) {
        const weekEndStr = londonYmdAddDays(weekStartDate, 6);
        
        if (isPostgreSQL) {
            // Get all timesheet entries for the week, grouped by date
            const entriesResult = await pool.query(
                `SELECT 
                    te.id,
                    ((te.clock_in_time AT TIME ZONE 'Europe/London')::date) as entry_date,
                    te.clock_in_time,
                    te.clock_out_time,
                    te.clock_in_latitude,
                    te.clock_in_longitude,
                    te.clock_out_latitude,
                    te.clock_out_longitude,
                    te.regular_hours,
                    te.overtime_hours,
                    te.weekend_hours,
                    te.overnight_hours,
                    te.total_hours,
                    te.edited_by_admin_id,
                    te.edited_by_admin_at,
                    tde.day_type,
                    j.name as job_name
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 LEFT JOIN weekly_timesheets wt ON wt.user_id = te.user_id AND wt.week_start_date = $2::date
                 LEFT JOIN timesheet_daily_entries tde ON tde.weekly_timesheet_id = wt.id AND ((te.clock_in_time AT TIME ZONE 'Europe/London')::date) = tde.entry_date
                 WHERE te.user_id = $1 
                   AND te.clock_out_time IS NOT NULL
                   AND ((te.clock_in_time AT TIME ZONE 'Europe/London')::date) >= $2::date
                   AND ((te.clock_in_time AT TIME ZONE 'Europe/London')::date) <= $3::date
                 ORDER BY ((te.clock_in_time AT TIME ZONE 'Europe/London')::date), te.clock_in_time`,
                [userId, weekStartDate, weekEndStr]
            );
            
            // Get daily notes and day_type for the week
            const weeklyTimesheet = await pool.query(
                `SELECT id FROM weekly_timesheets 
                 WHERE user_id = $1 
                 AND week_start_date = $2`,
                [userId, weekStartDate]
            );
            
            let dailyDataMap = {};
            if (weeklyTimesheet.rows.length > 0) {
                const dailyDataResult = await pool.query(
                    `SELECT entry_date, daily_notes, day_type, overnight_away 
                     FROM timesheet_daily_entries 
                     WHERE weekly_timesheet_id = $1 
                     AND entry_date >= $2::date 
                     AND entry_date <= $3::date`,
                    [weeklyTimesheet.rows[0].id, weekStartDate, weekEndStr]
                );
                
                dailyDataResult.rows.forEach(row => {
                    const normalizedDate = ymdFromDbOrInstant(row.entry_date);
                    if (normalizedDate) {
                        dailyDataMap[normalizedDate] = {
                            daily_notes: row.daily_notes,
                            day_type: row.day_type,
                            overnight_away: row.overnight_away === true || row.overnight_away === 1 || row.overnight_away === '1'
                        };
                    }
                });
            }
            
            // Merge daily notes, day_type, and overnight_away into entries
            // Normalize entry_date to YYYY-MM-DD format for consistency
            const entries = entriesResult.rows.map(entry => {
                const entryDate = ymdFromDbOrInstant(entry.entry_date);
                const dailyData = entryDate ? (dailyDataMap[entryDate] || {}) : {};
                return {
                    ...entry,
                    entry_date: entryDate, // Normalized date
                    daily_notes: dailyData.daily_notes || entry.daily_notes || null,
                    day_type: entry.day_type || dailyData.day_type || null,
                    overnight_away: dailyData.overnight_away !== undefined ? dailyData.overnight_away : (entry.overnight_away === true || entry.overnight_away === 1 || entry.overnight_away === '1')
                };
            });
            
            // Get all dates that have entries (normalized)
            const datesWithEntries = new Set(entries.map(e => e.entry_date).filter(d => d));
            
            // Add entries for days with day_type but no clock entries
            if (weeklyTimesheet.rows.length > 0) {
                Object.keys(dailyDataMap).forEach(date => {
                    // Date is already normalized from dailyDataMap keys
                    const normalizedDate = date;
                    
                    if (!normalizedDate) return;
                    
                    const dailyData = dailyDataMap[normalizedDate];
                    // If this date has a day_type but no clock entries, create a synthetic entry
                    if (dailyData && dailyData.day_type && !datesWithEntries.has(normalizedDate)) {
                        // Calculate hours based on day_type
                        let regularHours = 0;
                        let totalHours = 0;
                        
                        if (dailyData.day_type === 'holiday_unpaid' || dailyData.day_type === 'sick_unpaid') {
                            regularHours = 0;
                            totalHours = 0;
                        } else if (dailyData.day_type === 'sick_paid') {
                            const dayOfWeek = londonWeekdaySun0FromYmd(normalizedDate);
                            if (dayOfWeek === 5) {
                                regularHours = 6;
                                totalHours = 6;
                            } else {
                                regularHours = 8;
                                totalHours = 8;
                            }
                        } else if (dailyData.day_type === 'holiday_paid') {
                            const dayOfWeek = londonWeekdaySun0FromYmd(normalizedDate);
                            if (dayOfWeek === 5) {
                                regularHours = 6;
                                totalHours = 6;
                            } else {
                                regularHours = 8;
                                totalHours = 8;
                            }
                        }
                        
                        entries.push({
                            id: null,
                            entry_date: normalizedDate,
                            clock_in_time: null,
                            clock_out_time: null,
                            clock_in_latitude: null,
                            clock_in_longitude: null,
                            clock_out_latitude: null,
                            clock_out_longitude: null,
                            regular_hours: regularHours,
                            overtime_hours: 0,
                            weekend_hours: 0,
                            overnight_hours: 0,
                            total_hours: totalHours,
                            edited_by_admin_id: null,
                            edited_by_admin_at: null,
                            day_type: dailyData.day_type,
                            job_name: null,
                            daily_notes: dailyData.daily_notes || null,
                            overnight_away: dailyData.overnight_away || false
                        });
                    }
                });
            }
            
            // Return all entries (no deduplication needed - we want all entries per day)
            return entries.sort((a, b) => {
                const dateCompare = new Date(a.entry_date) - new Date(b.entry_date);
                if (dateCompare !== 0) return dateCompare;
                // For entries without clock_in_time, put them first (or handle null)
                if (!a.clock_in_time && b.clock_in_time) return -1;
                if (a.clock_in_time && !b.clock_in_time) return 1;
                if (!a.clock_in_time && !b.clock_in_time) return 0;
                return new Date(a.clock_in_time) - new Date(b.clock_in_time);
            });
        } else {
            const weekStartUtc = londonDayStartUtc(weekStartDate);
            const afterWeekUtc = londonNextDayStartUtc(weekEndStr);
            const entriesResult = db.prepare(
                `SELECT 
                    te.id,
                    te.clock_in_time,
                    te.clock_out_time,
                    te.clock_in_latitude,
                    te.clock_in_longitude,
                    te.clock_out_latitude,
                    te.clock_out_longitude,
                    te.regular_hours,
                    te.overtime_hours,
                    te.weekend_hours,
                    te.overnight_hours,
                    te.total_hours,
                    te.edited_by_admin_id,
                    te.edited_by_admin_at,
                    j.name as job_name
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 WHERE te.user_id = ? 
                   AND te.clock_out_time IS NOT NULL
                   AND te.clock_in_time >= ?
                   AND te.clock_in_time < ?
                 ORDER BY te.clock_in_time`
            ).all(userId, weekStartUtc, afterWeekUtc);
            
            // Get daily notes and day_type for the week
            const weeklyTimesheet = db.prepare(
                `SELECT id FROM weekly_timesheets 
                 WHERE user_id = ? 
                 AND week_start_date = ?`
            ).get(userId, weekStartDate);
            
            let dailyDataMap = {};
            if (weeklyTimesheet) {
                const dailyDataResult = db.prepare(
                    `SELECT entry_date, daily_notes, day_type, overnight_away 
                     FROM timesheet_daily_entries 
                     WHERE weekly_timesheet_id = ? 
                     AND entry_date >= ? 
                     AND entry_date <= ?`
                ).all(weeklyTimesheet.id, weekStartDate, weekEndStr);
                
                dailyDataResult.forEach(row => {
                    const normalizedDate = ymdFromDbOrInstant(row.entry_date);
                    if (normalizedDate) {
                        dailyDataMap[normalizedDate] = {
                            daily_notes: row.daily_notes,
                            day_type: row.day_type,
                            overnight_away: row.overnight_away === true || row.overnight_away === 1 || row.overnight_away === '1'
                        };
                    }
                });
            }
            
            const entries = entriesResult.map(entry => {
                const entryDate = londonYmd(new Date(entry.clock_in_time));
                const dailyData = entryDate ? (dailyDataMap[entryDate] || {}) : {};
                return {
                    ...entry,
                    entry_date: entryDate, // Normalized date
                    daily_notes: dailyData.daily_notes || entry.daily_notes || null,
                    day_type: entry.day_type || dailyData.day_type || null,
                    overnight_away: dailyData.overnight_away !== undefined ? dailyData.overnight_away : (entry.overnight_away === true || entry.overnight_away === 1 || entry.overnight_away === '1')
                };
            });
            
            // Get all dates that have entries (normalized)
            const datesWithEntries = new Set(entries.map(e => e.entry_date).filter(d => d));
            
            // Add entries for days with day_type but no clock entries
            if (weeklyTimesheet) {
                Object.keys(dailyDataMap).forEach(date => {
                    // Date is already normalized from dailyDataMap keys
                    const normalizedDate = date;
                    
                    if (!normalizedDate) return;
                    
                    const dailyData = dailyDataMap[normalizedDate];
                    // If this date has a day_type but no clock entries, create a synthetic entry
                    if (dailyData && dailyData.day_type && !datesWithEntries.has(normalizedDate)) {
                        // Calculate hours based on day_type
                        let regularHours = 0;
                        let totalHours = 0;
                        
                        if (dailyData.day_type === 'holiday_unpaid' || dailyData.day_type === 'sick_unpaid') {
                            regularHours = 0;
                            totalHours = 0;
                        } else if (dailyData.day_type === 'sick_paid') {
                            const dayOfWeek = londonWeekdaySun0FromYmd(normalizedDate);
                            if (dayOfWeek === 5) {
                                regularHours = 6;
                                totalHours = 6;
                            } else {
                                regularHours = 8;
                                totalHours = 8;
                            }
                        } else if (dailyData.day_type === 'holiday_paid') {
                            const dayOfWeek = londonWeekdaySun0FromYmd(normalizedDate);
                            if (dayOfWeek === 5) {
                                regularHours = 6;
                                totalHours = 6;
                            } else {
                                regularHours = 8;
                                totalHours = 8;
                            }
                        }
                        
                        entries.push({
                            id: null,
                            entry_date: normalizedDate,
                            clock_in_time: null,
                            clock_out_time: null,
                            clock_in_latitude: null,
                            clock_in_longitude: null,
                            clock_out_latitude: null,
                            clock_out_longitude: null,
                            regular_hours: regularHours,
                            overtime_hours: 0,
                            weekend_hours: 0,
                            overnight_hours: 0,
                            total_hours: totalHours,
                            edited_by_admin_id: null,
                            edited_by_admin_at: null,
                            day_type: dailyData.day_type,
                            job_name: null,
                            daily_notes: dailyData.daily_notes || null,
                            overnight_away: dailyData.overnight_away || false
                        });
                    }
                });
            }
            
            // Return all entries (no deduplication needed - we want all entries per day)
            return entries.sort((a, b) => {
                const dateCompare = new Date(a.entry_date) - new Date(b.entry_date);
                if (dateCompare !== 0) return dateCompare;
                // For entries without clock_in_time, put them first (or handle null)
                if (!a.clock_in_time && b.clock_in_time) return -1;
                if (a.clock_in_time && !b.clock_in_time) return 1;
                if (!a.clock_in_time && !b.clock_in_time) return 0;
                return new Date(a.clock_in_time) - new Date(b.clock_in_time);
            });
        }
    }
    
    // ============ MATERIAL REQUIREMENTS CALCULATION ============
    
    static async calculateMaterialRequirements(orders) {
        // orders: array of {product_id, quantity}
        const panelsRequired = {};
        const componentsRequired = {};
        const rawMaterialsRequired = {};
        let totalLabourHours = 0;
        const breakdown = {
            by_product: [],
            by_panel: []
        };
        
        for (const order of orders) {
            const product = await this.getProductById(order.product_id);
            if (!product) continue;
            
            const components = await this.getProductComponents(order.product_id);
            const productBreakdown = {
                product_id: product.id,
                product_name: product.name,
                quantity: order.quantity,
                panels: [],
                materials: []
            };
            
            for (const comp of components) {
                const totalQty = parseFloat(comp.quantity_required) * order.quantity;
                
                if (comp.component_type === 'built_item') {
                    const panelId = comp.component_id;
                    if (!panelsRequired[panelId]) {
                        panelsRequired[panelId] = 0;
                    }
                    panelsRequired[panelId] += totalQty;
                    
                    // Get panel to calculate labour hours
                    const panel = await this.getPanelById(panelId);
                    if (panel) {
                        const labourHours = parseFloat(panel.labour_hours || 0) * totalQty;
                        totalLabourHours += labourHours;
                    }
                    
                    productBreakdown.panels.push({
                        panel_id: panelId,
                        panel_name: comp.component_name,
                        quantity: totalQty
                    });
                    
                    // Get BOM for this panel
                    const bomItems = await this.getPanelBOM(panelId);
                    for (const bomItem of bomItems) {
                        const bomItemQty = parseFloat(bomItem.quantity_required) * totalQty;
                        
                        if (bomItem.item_type === 'raw_material') {
                            const stockItemId = bomItem.item_id; // Use item_id, not stock_item_id
                            // Skip if stockItemId is invalid
                            if (!stockItemId || stockItemId === null || stockItemId === undefined) {
                                console.warn(`Skipping panel BOM item with invalid item_id:`, bomItem);
                                continue;
                            }
                            
                            if (!rawMaterialsRequired[stockItemId]) {
                                const stockItem = await this.getStockItemById(stockItemId);
                                rawMaterialsRequired[stockItemId] = {
                                    stock_item_id: stockItemId,
                                    name: bomItem.item_name || (stockItem ? stockItem.name : 'Unknown'),
                                    unit: bomItem.item_unit || bomItem.unit,
                                    total_quantity: 0
                                };
                            }
                            rawMaterialsRequired[stockItemId].total_quantity += bomItemQty;
                            
                        } else if (bomItem.item_type === 'component') {
                            // Component in panel BOM - get its BOM and process raw materials
                            try {
                                const componentBomItems = await this.getComponentBOM(bomItem.item_id);
                                if (componentBomItems && componentBomItems.length > 0) {
                                    for (const componentBomItem of componentBomItems) {
                                        const stockItemId = componentBomItem.stock_item_id;
                                        // Skip if stockItemId is invalid
                                        if (!stockItemId || stockItemId === null || stockItemId === undefined) {
                                            console.warn(`Skipping component BOM item with invalid stock_item_id:`, componentBomItem);
                                            continue;
                                        }
                                        // Multiply: component_bom_qty * panel_bom_qty * order_qty
                                        const materialQty = parseFloat(componentBomItem.quantity_required) * bomItemQty;
                                        
                                        if (!rawMaterialsRequired[stockItemId]) {
                                            const stockItem = await this.getStockItemById(stockItemId);
                                            rawMaterialsRequired[stockItemId] = {
                                                stock_item_id: stockItemId,
                                                name: componentBomItem.stock_item_name || (stockItem ? stockItem.name : 'Unknown'),
                                                unit: componentBomItem.unit || componentBomItem.stock_item_unit || 'unit',
                                                total_quantity: 0
                                            };
                                        }
                                        rawMaterialsRequired[stockItemId].total_quantity += materialQty;
                                    }
                                }
                            } catch (error) {
                                console.error(`Error processing component ${bomItem.item_id} in panel BOM:`, error);
                                // Continue processing other BOM items even if one fails
                            }
                        }
                    }
                } else if (comp.component_type === 'component') {
                    // Component can be direct product component - track it and process BOM
                    const componentId = comp.component_id;
                    
                    // Track component separately (only direct product components, not components in built item BOMs)
                    if (!componentsRequired[componentId]) {
                        componentsRequired[componentId] = 0;
                    }
                    componentsRequired[componentId] += totalQty;
                    
                    // Calculate labour hours and process BOM for raw materials
                    try {
                        const component = await this.getComponentById(componentId);
                        if (component) {
                            const labourHours = parseFloat(component.labour_hours || 0) * totalQty;
                            totalLabourHours += labourHours;
                            
                            // Get BOM for this component to process raw materials
                            const bomItems = await this.getComponentBOM(componentId);
                            if (bomItems && bomItems.length > 0) {
                                for (const bomItem of bomItems) {
                                    const stockItemId = bomItem.stock_item_id;
                                    // Skip if stockItemId is invalid
                                    if (!stockItemId || stockItemId === null || stockItemId === undefined) {
                                        console.warn(`Skipping BOM item with invalid stock_item_id:`, bomItem);
                                        continue;
                                    }
                                    const materialQty = parseFloat(bomItem.quantity_required) * totalQty;
                                    
                                    if (!rawMaterialsRequired[stockItemId]) {
                                        const stockItem = await this.getStockItemById(stockItemId);
                                        rawMaterialsRequired[stockItemId] = {
                                            stock_item_id: stockItemId,
                                            name: bomItem.stock_item_name || (stockItem ? stockItem.name : 'Unknown'),
                                            unit: bomItem.unit || bomItem.stock_item_unit || 'unit',
                                            total_quantity: 0
                                        };
                                    }
                                    rawMaterialsRequired[stockItemId].total_quantity += materialQty;
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing component ${componentId}:`, error);
                        // Continue processing other components even if one fails
                    }
                } else if (comp.component_type === 'raw_material') {
                    const stockItemId = comp.component_id;
                    // Skip if stockItemId is invalid
                    if (!stockItemId || stockItemId === null || stockItemId === undefined) {
                        console.warn(`Skipping raw material component with invalid component_id:`, comp);
                        continue;
                    }
                    if (!rawMaterialsRequired[stockItemId]) {
                        const stockItem = await this.getStockItemById(stockItemId);
                        rawMaterialsRequired[stockItemId] = {
                            stock_item_id: stockItemId,
                            name: stockItem ? stockItem.name : 'Unknown',
                            unit: comp.unit,
                            total_quantity: 0
                        };
                    }
                    rawMaterialsRequired[stockItemId].total_quantity += totalQty;
                    
                    productBreakdown.materials.push({
                        stock_item_id: stockItemId,
                        name: rawMaterialsRequired[stockItemId].name,
                        quantity: totalQty,
                        unit: comp.unit
                    });
                }
            }
            
            breakdown.by_product.push(productBreakdown);
        }
        
        // Get panel details and calculate panel-level breakdown
        for (const [panelId, totalQty] of Object.entries(panelsRequired)) {
            const panel = await this.getPanelById(panelId);
            const bomItems = await this.getPanelBOM(panelId);
            
            const panelBreakdown = {
                panel_id: parseInt(panelId),
                panel_name: panel ? panel.name : 'Unknown',
                quantity_needed: totalQty,
                materials: []
            };
            
            for (const bomItem of bomItems) {
                const materialQty = parseFloat(bomItem.quantity_required) * totalQty;
                panelBreakdown.materials.push({
                    stock_item_id: bomItem.stock_item_id,
                    name: bomItem.stock_item_name,
                    quantity: materialQty,
                    unit: bomItem.unit
                });
            }
            
            breakdown.by_panel.push(panelBreakdown);
        }
        
        // Convert panelsRequired to array with detailed information
        const panelsArray = [];
        for (const [panelId, totalQty] of Object.entries(panelsRequired)) {
            const panel = await this.getPanelById(panelId);
            const available = parseFloat(panel ? panel.built_quantity : 0);
            const shortfall = Math.max(0, totalQty - available);
            const cost = parseFloat(panel ? panel.cost_gbp : 0) * totalQty;
            
            panelsArray.push({
                panel_id: parseInt(panelId),
                panel_name: panel ? panel.name : 'Unknown',
                total_quantity: totalQty,
                available: available,
                shortfall: shortfall,
                cost_gbp: cost,
                type: 'Built Item'
            });
        }
        
        // Convert componentsRequired to array with detailed information
        const componentsArray = [];
        for (const [componentId, totalQty] of Object.entries(componentsRequired)) {
            const component = await this.getComponentById(componentId);
            const available = parseFloat(component ? component.built_quantity : 0);
            const shortfall = Math.max(0, totalQty - available);
            const cost = parseFloat(component ? component.cost_gbp : 0) * totalQty;
            
            componentsArray.push({
                component_id: parseInt(componentId),
                component_name: component ? component.name : 'Unknown',
                total_quantity: totalQty,
                available: available,
                shortfall: shortfall,
                cost_gbp: cost,
                type: 'Component'
            });
        }
        
        // Get stock availability and calculate costs
        const materialsArray = [];
        let totalCost = 0;
        for (const [stockItemId, data] of Object.entries(rawMaterialsRequired)) {
            // Skip invalid stock item IDs
            if (!stockItemId || stockItemId === 'undefined' || stockItemId === 'null') {
                console.warn(`Skipping invalid stockItemId:`, stockItemId);
                continue;
            }
            const stockItem = await this.getStockItemById(parseInt(stockItemId));
            const available = parseFloat(stockItem ? stockItem.current_quantity : 0);
            const shortfall = Math.max(0, data.total_quantity - available);
            const cost = parseFloat(stockItem ? stockItem.cost_per_unit_gbp : 0) * data.total_quantity;
            totalCost += cost;
            
            materialsArray.push({
                stock_item_id: parseInt(stockItemId),
                name: data.name,
                total_quantity: data.total_quantity,
                unit: data.unit,
                available: available,
                shortfall: shortfall,
                cost_gbp: cost
            });
        }
        
        return {
            panels_required: panelsArray,
            components_required: componentsArray,
            raw_materials_required: materialsArray,
            breakdown: breakdown,
            total_cost_gbp: totalCost,
            labour_hours_required: totalLabourHours
        };
    }
    
    // ============ STOCK CHECK REMINDERS OPERATIONS ============
    
    static async createReminder(data) {
        const reminderType = data.reminder_type || 'stock_check';
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO stock_check_reminders (stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active, user_id, target_role, created_by_user_id, reminder_text, reminder_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [
                    data.stock_item_id || null, 
                    data.check_frequency_days || null, 
                    data.last_checked_date || null, 
                    data.next_check_date, 
                    data.is_active !== false,
                    data.user_id || null,
                    data.target_role || null,
                    data.created_by_user_id || null,
                    data.reminder_text || null,
                    reminderType
                ]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO stock_check_reminders (stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active, user_id, target_role, created_by_user_id, reminder_text, reminder_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(
                data.stock_item_id || null, 
                data.check_frequency_days || null, 
                data.last_checked_date || null, 
                data.next_check_date, 
                data.is_active !== false ? 1 : 0,
                data.user_id || null,
                data.target_role || null,
                data.created_by_user_id || null,
                data.reminder_text || null,
                reminderType
            );
            return this.getReminderById(info.lastInsertRowid);
        }
    }
    
    static async getReminderById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM stock_check_reminders WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM stock_check_reminders WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getReminderWithJoinsById(id) {
        const sel = `SELECT r.*, si.name as stock_item_name,
                u.username as assigned_user_name,
                creator.username as created_by_username
         FROM stock_check_reminders r
         LEFT JOIN stock_items si ON r.stock_item_id = si.id
         LEFT JOIN production_users u ON r.user_id = u.id
         LEFT JOIN production_users creator ON r.created_by_user_id = creator.id
         WHERE r.id = `;
        if (isPostgreSQL) {
            const result = await pool.query(`${sel}$1`, [id]);
            return result.rows[0] || null;
        }
        return db.prepare(`${sel}?`).get(id) || null;
    }
    
    static async getAllReminders(userId = null, userRole = null) {
        // Build WHERE clause based on user permissions
        let whereClause = '';
        const params = [];
        let paramIndex = 1;
        
        if (userId && userRole) {
            // Filter reminders: show if user_id matches, target_role matches, both NULL (global - admin only), or created by user
            if (userRole === 'admin') {
                // Admins see all reminders they created OR all global reminders (both NULL)
                whereClause = `(r.created_by_user_id = $${paramIndex} OR (r.user_id IS NULL AND r.target_role IS NULL))`;
                params.push(userId);
                paramIndex++;
            } else {
                // Regular users see: their own reminders, role-based reminders, or reminders they created
                whereClause = `(r.user_id = $${paramIndex} OR r.target_role = $${paramIndex + 1} OR r.created_by_user_id = $${paramIndex})`;
                params.push(userId, userRole, userId);
                paramIndex += 3;
            }
        }
        
        const whereSQL = whereClause ? `WHERE ${whereClause}` : '';
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT r.*, si.name as stock_item_name,
                        u.username as assigned_user_name,
                        creator.username as created_by_username
                 FROM stock_check_reminders r
                 LEFT JOIN stock_items si ON r.stock_item_id = si.id
                 LEFT JOIN production_users u ON r.user_id = u.id
                 LEFT JOIN production_users creator ON r.created_by_user_id = creator.id
                 ${whereSQL}
                 ORDER BY r.next_check_date ASC`,
                params
            );
            return result.rows;
        } else {
            const query = `SELECT r.*, si.name as stock_item_name,
                                  u.username as assigned_user_name,
                                  creator.username as created_by_username
                           FROM stock_check_reminders r
                           LEFT JOIN stock_items si ON r.stock_item_id = si.id
                           LEFT JOIN production_users u ON r.user_id = u.id
                           LEFT JOIN production_users creator ON r.created_by_user_id = creator.id
                           ${whereSQL}
                           ORDER BY r.next_check_date ASC`;
            
            if (params.length > 0) {
                return db.prepare(query).all(...params);
            } else {
                return db.prepare(query).all();
            }
        }
    }
    
    static async getRemindersPaged(userId = null, userRole = null, opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        let whereClause = '';
        const params = [];
        let paramIndex = 1;
        if (userId && userRole) {
            if (userRole === 'admin') {
                whereClause = `(r.created_by_user_id = $${paramIndex} OR (r.user_id IS NULL AND r.target_role IS NULL))`;
                params.push(userId);
                paramIndex++;
            } else {
                whereClause = `(r.user_id = $${paramIndex} OR r.target_role = $${paramIndex + 1} OR r.created_by_user_id = $${paramIndex})`;
                params.push(userId, userRole, userId);
                paramIndex += 3;
            }
        }
        const whereSQL = whereClause ? `WHERE ${whereClause}` : '';
        const baseJoin = `FROM stock_check_reminders r
                 LEFT JOIN stock_items si ON r.stock_item_id = si.id
                 LEFT JOIN production_users u ON r.user_id = u.id
                 LEFT JOIN production_users creator ON r.created_by_user_id = creator.id`;
        const sel = `SELECT r.*, si.name as stock_item_name,
                        u.username as assigned_user_name,
                        creator.username as created_by_username `;
        if (isPostgreSQL) {
            const countRes = await pool.query(`SELECT COUNT(*)::int AS c ${baseJoin} ${whereSQL}`, params);
            const total = countRes.rows[0].c;
            const lim = params.length + 1;
            const off = params.length + 2;
            const r = await pool.query(
                `${sel} ${baseJoin} ${whereSQL} ORDER BY r.next_check_date ASC LIMIT $${lim} OFFSET $${off}`,
                [...params, pageSize, offset]
            );
            return { reminders: r.rows, total, page, page_size: pageSize };
        }
        let sqliteWhere = '';
        const sp = [];
        if (userId && userRole) {
            if (userRole === 'admin') {
                sqliteWhere = `WHERE (r.created_by_user_id = ? OR (r.user_id IS NULL AND r.target_role IS NULL))`;
                sp.push(userId);
            } else {
                sqliteWhere = `WHERE (r.user_id = ? OR r.target_role = ? OR r.created_by_user_id = ?)`;
                sp.push(userId, userRole, userId);
            }
        }
        const qBase = `${sel} ${baseJoin} ${sqliteWhere}`;
        const row = db.prepare(`SELECT COUNT(*) AS c ${baseJoin} ${sqliteWhere}`).get(...sp);
        const rows = db.prepare(`${qBase} ORDER BY r.next_check_date ASC LIMIT ? OFFSET ?`).all(...sp, pageSize, offset);
        return { reminders: rows, total: row.c, page, page_size: pageSize };
    }
    
    static async getOverdueReminders(userId = null, userRole = null) {
        try {
            const today = new Date().toISOString().split('T')[0];
            
            // Ensure userId is an integer if provided
            const userIdInt = userId ? parseInt(userId) : null;
            
            // Build WHERE clause based on user permissions
            let whereClause = isPostgreSQL ? 'r.is_active = TRUE' : 'r.is_active = 1';
            const params = [today];
            let paramIndex = 2;
            
            if (userIdInt && userRole) {
                if (userRole === 'admin') {
                    // Admins see all overdue reminders they created OR all global reminders
                    whereClause += isPostgreSQL 
                        ? ` AND (r.created_by_user_id = $${paramIndex} OR (r.user_id IS NULL AND r.target_role IS NULL))`
                        : ` AND (r.created_by_user_id = ? OR (r.user_id IS NULL AND r.target_role IS NULL))`;
                    params.push(userIdInt);
                    paramIndex++;
                } else {
                    // Regular users see: their own reminders, role-based reminders, or reminders they created
                    if (isPostgreSQL) {
                        whereClause += ` AND (r.user_id = $${paramIndex} OR r.target_role = $${paramIndex + 1} OR r.created_by_user_id = $${paramIndex + 2})`;
                        params.push(userIdInt, userRole, userIdInt);
                        paramIndex += 3;
                    } else {
                        whereClause += ` AND (r.user_id = ? OR r.target_role = ? OR r.created_by_user_id = ?)`;
                        params.push(userIdInt, userRole, userIdInt);
                    }
                }
            }
            
            if (isPostgreSQL) {
                const result = await pool.query(
                    `SELECT r.*, si.name as stock_item_name,
                            u.username as assigned_user_name,
                            creator.username as created_by_username
                     FROM stock_check_reminders r
                     LEFT JOIN stock_items si ON r.stock_item_id = si.id
                     LEFT JOIN production_users u ON r.user_id = u.id
                     LEFT JOIN production_users creator ON r.created_by_user_id = creator.id
                     WHERE ${whereClause} AND r.next_check_date < $1
                     ORDER BY r.next_check_date ASC`,
                    params
                );
                return result.rows;
            } else {
                const query = `SELECT r.*, si.name as stock_item_name,
                                      u.username as assigned_user_name,
                                      creator.username as created_by_username
                               FROM stock_check_reminders r
                               LEFT JOIN stock_items si ON r.stock_item_id = si.id
                               LEFT JOIN production_users u ON r.user_id = u.id
                               LEFT JOIN production_users creator ON r.created_by_user_id = creator.id
                               WHERE ${whereClause} AND r.next_check_date < ?
                               ORDER BY r.next_check_date ASC`;
                return db.prepare(query).all(...params);
            }
        } catch (error) {
            console.error('getOverdueReminders error:', error);
            console.error('Error stack:', error.stack);
            console.error('Parameters - userId:', userId, 'userRole:', userRole);
            throw error;
        }
    }
    
    // Get unapproved timesheet weeks (for reminders)
    // Returns weeks that have ended and still have unapproved timesheets
    // Only returns complete weeks (weeks that have finished)
    // Only counts timesheets with actual hours worked (matching getPayrollSummary logic)
    static async getUnapprovedTimesheetWeeks() {
        const today = new Date();
        const dayOfWeek = today.getDay(); // 0 = Sunday, 6 = Saturday
        
        // Calculate current week's Monday
        const currentWeekMonday = new Date(today);
        currentWeekMonday.setDate(currentWeekMonday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
        currentWeekMonday.setHours(0, 0, 0, 0);
        const currentWeekStartStr = currentWeekMonday.toISOString().split('T')[0];
        
        // Only get weeks that are complete (week_start_date < current week start)
        // Only count timesheets with actual hours (matching getPayrollSummary filter)
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT wt.week_start_date, COUNT(DISTINCT wt.user_id) as unapproved_count
                 FROM weekly_timesheets wt
                 INNER JOIN production_users u ON wt.user_id = u.id
                 INNER JOIN timesheet_daily_entries tde ON wt.id = tde.weekly_timesheet_id
                 WHERE wt.week_start_date < $1
                   AND (wt.manager_approved IS NULL OR wt.manager_approved = FALSE)
                   AND (u.role = 'staff' OR u.role = 'office' OR u.role = 'admin' OR u.role = 'manager')
                   AND tde.total_hours > 0
                 GROUP BY wt.week_start_date
                 HAVING COUNT(DISTINCT wt.user_id) > 0
                 ORDER BY wt.week_start_date DESC
                 LIMIT 2`,
                [currentWeekStartStr]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT wt.week_start_date, COUNT(DISTINCT wt.user_id) as unapproved_count
                 FROM weekly_timesheets wt
                 INNER JOIN production_users u ON wt.user_id = u.id
                 INNER JOIN timesheet_daily_entries tde ON wt.id = tde.weekly_timesheet_id
                 WHERE wt.week_start_date < ?
                   AND (wt.manager_approved IS NULL OR wt.manager_approved = 0)
                   AND (u.role = 'staff' OR u.role = 'office' OR u.role = 'admin' OR u.role = 'manager')
                   AND tde.total_hours > 0
                 GROUP BY wt.week_start_date
                 HAVING COUNT(DISTINCT wt.user_id) > 0
                 ORDER BY wt.week_start_date DESC
                 LIMIT 2`
            ).all(currentWeekStartStr);
        }
    }
    
    static async updateReminder(id, data) {
        const updates = [];
        const values = [];
        let paramIndex = 1;
        
        if (data.check_frequency_days !== undefined) {
            updates.push(isPostgreSQL ? `check_frequency_days = $${paramIndex}` : `check_frequency_days = ?`);
            values.push(data.check_frequency_days);
            paramIndex++;
        }
        
        if (data.is_active !== undefined) {
            updates.push(isPostgreSQL ? `is_active = $${paramIndex}` : `is_active = ?`);
            values.push(data.is_active !== false ? (isPostgreSQL ? true : 1) : (isPostgreSQL ? false : 0));
            paramIndex++;
        }
        
        if (data.user_id !== undefined) {
            updates.push(isPostgreSQL ? `user_id = $${paramIndex}` : `user_id = ?`);
            values.push(data.user_id || null);
            paramIndex++;
        }
        
        if (data.target_role !== undefined) {
            updates.push(isPostgreSQL ? `target_role = $${paramIndex}` : `target_role = ?`);
            values.push(data.target_role || null);
            paramIndex++;
        }
        
        if (data.reminder_text !== undefined) {
            updates.push(isPostgreSQL ? `reminder_text = $${paramIndex}` : `reminder_text = ?`);
            values.push(data.reminder_text || null);
            paramIndex++;
        }
        
        if (data.reminder_type !== undefined) {
            updates.push(isPostgreSQL ? `reminder_type = $${paramIndex}` : `reminder_type = ?`);
            values.push(data.reminder_type);
            paramIndex++;
        }
        
        if (updates.length === 0) {
            return this.getReminderById(id);
        }
        
        values.push(id);
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE stock_check_reminders SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
                values
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE stock_check_reminders SET ${updates.join(', ')} WHERE id = ?`
            ).run(...values);
            return this.getReminderById(id);
        }
    }
    
    static async markReminderChecked(id) {
        const today = new Date().toISOString().split('T')[0];
        const reminder = await this.getReminderById(id);
        if (!reminder) return null;
        
        const frequencyDays = parseInt(reminder.check_frequency_days);
        const nextCheckDate = new Date();
        nextCheckDate.setDate(nextCheckDate.getDate() + frequencyDays);
        const nextCheckDateStr = nextCheckDate.toISOString().split('T')[0];
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE stock_check_reminders SET last_checked_date = $1, next_check_date = $2 WHERE id = $3 RETURNING *`,
                [today, nextCheckDateStr, id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE stock_check_reminders SET last_checked_date = ?, next_check_date = ? WHERE id = ?`
            ).run(today, nextCheckDateStr, id);
            return this.getReminderById(id);
        }
    }
    
    static async deleteReminder(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM stock_check_reminders WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM stock_check_reminders WHERE id = ?`).run(id);
        }
    }
    
    // ============ COMPLIANCE INSPECTIONS ============
    
    static INSPECTION_ASSET_TYPES = ['ladder', 'emergency_lighting', 'lev'];
    
    static async createInspectionAsset(data) {
        const assetType = data.asset_type;
        if (!this.INSPECTION_ASSET_TYPES.includes(assetType)) {
            throw new Error('Invalid asset_type');
        }
        const assetName = (data.asset_name || '').trim();
        if (!assetName) throw new Error('asset_name is required');
        const frequencyDays = Math.max(1, parseInt(String(data.frequency_days || 30), 10) || 30);
        let nextDate = data.next_inspection_date;
        if (!nextDate) {
            const d = new Date();
            d.setDate(d.getDate() + frequencyDays);
            nextDate = d.toISOString().split('T')[0];
        }
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [
                    assetType,
                    assetName,
                    data.location || null,
                    data.identifier || null,
                    frequencyDays,
                    data.last_inspection_date || null,
                    nextDate,
                    data.is_active !== false,
                    data.created_by_user_id || null
                ]
            );
            return result.rows[0];
        }
        const stmt = db.prepare(
            `INSERT INTO inspection_assets (asset_type, asset_name, location, identifier, frequency_days, last_inspection_date, next_inspection_date, is_active, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const info = stmt.run(
            assetType,
            assetName,
            data.location || null,
            data.identifier || null,
            frequencyDays,
            data.last_inspection_date || null,
            nextDate,
            data.is_active !== false ? 1 : 0,
            data.created_by_user_id || null
        );
        return this.getInspectionAssetById(info.lastInsertRowid);
    }
    
    static async getInspectionAssetById(id) {
        const aid = parseInt(id, 10);
        if (Number.isNaN(aid)) return null;
        if (isPostgreSQL) {
            const r = await pool.query(`SELECT * FROM inspection_assets WHERE id = $1`, [aid]);
            return r.rows[0] || null;
        }
        return db.prepare(`SELECT * FROM inspection_assets WHERE id = ?`).get(aid) || null;
    }
    
    static async updateInspectionAsset(id, data) {
        const existing = await this.getInspectionAssetById(id);
        if (!existing) return null;
        const updates = [];
        const values = [];
        let pi = 1;
        const push = (col, val) => {
            if (isPostgreSQL) {
                updates.push(`${col} = $${pi++}`);
            } else {
                updates.push(`${col} = ?`);
            }
            values.push(val);
        };
        if (data.asset_type !== undefined) {
            if (!this.INSPECTION_ASSET_TYPES.includes(data.asset_type)) throw new Error('Invalid asset_type');
            push('asset_type', data.asset_type);
        }
        if (data.asset_name !== undefined) push('asset_name', String(data.asset_name).trim());
        if (data.location !== undefined) push('location', data.location || null);
        if (data.identifier !== undefined) push('identifier', data.identifier || null);
        if (data.frequency_days !== undefined) {
            push('frequency_days', Math.max(1, parseInt(String(data.frequency_days), 10) || 30));
        }
        if (data.last_inspection_date !== undefined) push('last_inspection_date', data.last_inspection_date || null);
        if (data.next_inspection_date !== undefined) push('next_inspection_date', data.next_inspection_date);
        if (data.is_active !== undefined) {
            push('is_active', isPostgreSQL ? !!data.is_active : data.is_active ? 1 : 0);
        }
        if (updates.length === 0) return existing;
        if (isPostgreSQL) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(parseInt(id, 10));
            const result = await pool.query(
                `UPDATE inspection_assets SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
                values
            );
            return result.rows[0] || null;
        }
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(parseInt(id, 10));
        db.prepare(`UPDATE inspection_assets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        return this.getInspectionAssetById(id);
    }
    
    /** Soft delete: set is_active false */
    static async deleteInspectionAsset(id) {
        return this.updateInspectionAsset(id, { is_active: false });
    }
    
    static async getInspectionAssets(filters = {}) {
        const onlyActive = filters.only_active !== false;
        const assetType = filters.asset_type;
        const onlyOverdue = filters.only_overdue === true;
        const onlyDueSoon = filters.only_due_soon === true;
        const today = new Date().toISOString().split('T')[0];
        const soon = new Date();
        soon.setDate(soon.getDate() + 7);
        const soonStr = soon.toISOString().split('T')[0];
        
        let where = [];
        const params = [];
        let idx = 1;
        if (onlyActive) {
            where.push(isPostgreSQL ? 'a.is_active = TRUE' : 'a.is_active = 1');
        }
        if (assetType) {
            where.push(isPostgreSQL ? `a.asset_type = $${idx}` : 'a.asset_type = ?');
            params.push(assetType);
            idx++;
        }
        if (onlyOverdue) {
            where.push(isPostgreSQL ? `a.next_inspection_date <= $${idx}` : 'a.next_inspection_date <= ?');
            params.push(today);
            idx++;
        }
        if (onlyDueSoon) {
            where.push(
                isPostgreSQL
                    ? `(a.next_inspection_date > $${idx} AND a.next_inspection_date <= $${idx + 1})`
                    : '(a.next_inspection_date > ? AND a.next_inspection_date <= ?)'
            );
            params.push(today, soonStr);
            idx += 2;
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const q = `SELECT a.*, u.username AS created_by_username
                   FROM inspection_assets a
                   LEFT JOIN production_users u ON a.created_by_user_id = u.id
                   ${whereSql}
                   ORDER BY a.next_inspection_date ASC, a.asset_name ASC`;
        if (isPostgreSQL) {
            const r = await pool.query(q, params);
            return r.rows;
        }
        return params.length ? db.prepare(q).all(...params) : db.prepare(q).all();
    }
    
    static async getOverdueInspections() {
        const today = new Date().toISOString().split('T')[0];
        const active = isPostgreSQL ? 'a.is_active = TRUE' : 'a.is_active = 1';
        const sql = `SELECT a.*, u.username AS created_by_username
                     FROM inspection_assets a
                     LEFT JOIN production_users u ON a.created_by_user_id = u.id
                     WHERE ${active} AND a.next_inspection_date <= `;
        if (isPostgreSQL) {
            const r = await pool.query(`${sql}$1`, [today]);
            return r.rows;
        }
        return db.prepare(`${sql}?`).all(today);
    }
    
    /** Overdue (next <= today) and due within 7 days (today < next <= today+7), active only */
    static async getInspectionsDashboardDue() {
        const today = new Date().toISOString().split('T')[0];
        const soon = new Date();
        soon.setDate(soon.getDate() + 7);
        const soonStr = soon.toISOString().split('T')[0];
        const active = isPostgreSQL ? 'a.is_active = TRUE' : 'a.is_active = 1';
        if (isPostgreSQL) {
            const r = await pool.query(
                `SELECT a.*, u.username AS created_by_username,
                        CASE WHEN a.next_inspection_date <= $1::date THEN 'overdue'
                             WHEN a.next_inspection_date <= $2::date THEN 'due_soon'
                             ELSE 'ok' END AS urgency
                 FROM inspection_assets a
                 LEFT JOIN production_users u ON a.created_by_user_id = u.id
                 WHERE ${active}
                   AND (
                     a.next_inspection_date <= $1::date
                     OR (a.next_inspection_date > $1::date AND a.next_inspection_date <= $2::date)
                   )
                 ORDER BY a.next_inspection_date ASC, a.asset_name ASC`,
                [today, soonStr]
            );
            return r.rows;
        }
        const rows = db
            .prepare(
                `SELECT a.*, u.username AS created_by_username
                 FROM inspection_assets a
                 LEFT JOIN production_users u ON a.created_by_user_id = u.id
                 WHERE ${active}
                   AND (
                     a.next_inspection_date <= ?
                     OR (a.next_inspection_date > ? AND a.next_inspection_date <= ?)
                   )
                 ORDER BY a.next_inspection_date ASC, a.asset_name ASC`
            )
            .all(today, today, soonStr);
        return rows.map((row) => ({
            ...row,
            urgency: row.next_inspection_date <= today ? 'overdue' : 'due_soon'
        }));
    }
    
    static async getInspectionRecordsForAsset(assetId, opts = {}) {
        const limit = Math.min(500, Math.max(1, parseInt(String(opts.limit || 100), 10) || 100));
        const aid = parseInt(assetId, 10);
        if (isPostgreSQL) {
            const r = await pool.query(
                `SELECT r.*, u.username AS inspector_username
                 FROM inspection_records r
                 LEFT JOIN production_users u ON r.inspector_user_id = u.id
                 WHERE r.asset_id = $1
                 ORDER BY r.inspection_date DESC, r.created_at DESC
                 LIMIT $2`,
                [aid, limit]
            );
            return r.rows;
        }
        return db
            .prepare(
                `SELECT r.*, u.username AS inspector_username
                 FROM inspection_records r
                 LEFT JOIN production_users u ON r.inspector_user_id = u.id
                 WHERE r.asset_id = ?
                 ORDER BY r.inspection_date DESC, r.created_at DESC
                 LIMIT ?`
            )
            .all(aid, limit);
    }
    
    static async createInspectionRecord(assetId, data) {
        const asset = await this.getInspectionAssetById(assetId);
        if (!asset || !(isPostgreSQL ? asset.is_active : asset.is_active === 1)) {
            throw new Error('Asset not found or inactive');
        }
        const status = data.status === 'fail' ? 'fail' : 'pass';
        let defects = data.defects != null ? String(data.defects).trim() : '';
        const notes = data.notes != null ? String(data.notes).trim() : null;
        if (status === 'fail' && !defects) {
            throw new Error('defects are required when status is fail');
        }
        if (status === 'pass') defects = defects || null;
        let inspectionDate = data.inspection_date || new Date().toISOString().split('T')[0];
        const inspectorUserId = data.inspector_user_id != null ? parseInt(data.inspector_user_id, 10) : null;
        const inspectorName = data.inspector_name || null;
        const freq = Math.max(1, parseInt(String(asset.frequency_days || 30), 10) || 30);
        
        const nextD = new Date(inspectionDate + 'T12:00:00');
        nextD.setDate(nextD.getDate() + freq);
        const nextInspectionDate = nextD.toISOString().split('T')[0];
        
        if (isPostgreSQL) {
            await pool.query('BEGIN');
            try {
                const ins = await pool.query(
                    `INSERT INTO inspection_records (asset_id, inspector_user_id, inspector_name, inspection_date, status, defects, notes)
                     VALUES ($1, $2, $3, $4::date, $5, $6, $7)
                     RETURNING *`,
                    [parseInt(assetId, 10), inspectorUserId, inspectorName, inspectionDate, status, defects || null, notes]
                );
                await pool.query(
                    `UPDATE inspection_assets
                     SET last_inspection_date = $1::date,
                         next_inspection_date = $2::date,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [inspectionDate, nextInspectionDate, parseInt(assetId, 10)]
                );
                await pool.query('COMMIT');
                return ins.rows[0];
            } catch (e) {
                await pool.query('ROLLBACK');
                throw e;
            }
        }
        const rid = db.transaction(() => {
            const rec = db
                .prepare(
                    `INSERT INTO inspection_records (asset_id, inspector_user_id, inspector_name, inspection_date, status, defects, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    parseInt(assetId, 10),
                    inspectorUserId,
                    inspectorName,
                    inspectionDate,
                    status,
                    defects || null,
                    notes
                );
            db.prepare(
                `UPDATE inspection_assets
                 SET last_inspection_date = ?, next_inspection_date = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            ).run(inspectionDate, nextInspectionDate, parseInt(assetId, 10));
            return rec.lastInsertRowid;
        })();
        const row = db.prepare(`SELECT * FROM inspection_records WHERE id = ?`).get(rid);
        return row;
    }
    
    // ============ HOLIDAY OPERATIONS ============
    
    // Helper function to calculate working days (weekdays only, excluding weekends)
    static calculateWorkingDays(startDate, endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        let count = 0;
        
        // Ensure start date is before or equal to end date
        if (start > end) {
            return 0;
        }
        
        const currentDate = new Date(start);
        while (currentDate <= end) {
            const dayOfWeek = currentDate.getDay(); // 0 = Sunday, 6 = Saturday
            // Only count weekdays (Monday-Friday, i.e., 1-5)
            if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                count++;
            }
            currentDate.setDate(currentDate.getDate() + 1);
        }
        
        return count;
    }
    
    // Calculate holiday entitlement days: Mon-Thu = 1, Friday = 0.75 (6hrs). Half day = 0.5 (or 0.375 for Friday).
    static calculateHolidayDaysRequested(startDate, endDate, dayType) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (start > end) return 0;
        if (dayType === 'half') {
            if (startDate !== endDate) return 0;
            const dayOfWeek = start.getDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) return 0; // weekend
            return dayOfWeek === 5 ? 0.375 : 0.5; // Friday half = 3hrs = 0.375, else 0.5
        }
        let total = 0;
        const current = new Date(start);
        while (current <= end) {
            const d = current.getDay();
            if (d >= 1 && d <= 5) {
                total += d === 5 ? 0.75 : 1; // Friday = 0.75, Mon-Thu = 1
            }
            current.setDate(current.getDate() + 1);
        }
        return Math.round(total * 100) / 100;
    }
    
    // Holiday Entitlement Methods
    static async createHolidayEntitlement(userId, year, totalDays) {
        // Ensure all values are integers
        const userIdInt = parseInt(userId);
        const yearInt = parseInt(year);
        const totalDaysInt = parseInt(totalDays);
        
        console.log('createHolidayEntitlement called with:', { userId: userIdInt, year: yearInt, totalDays: totalDaysInt });
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO holiday_entitlements (user_id, year, total_days, days_used)
                 VALUES ($1, $2, $3, 0)
                 ON CONFLICT (user_id, year) 
                 DO UPDATE SET total_days = $3, updated_at = CURRENT_TIMESTAMP
                 RETURNING *`,
                [userIdInt, yearInt, totalDaysInt]
            );
            console.log('Created/updated entitlement (PostgreSQL):', result.rows[0]);
            return result.rows[0];
        } else {
            // Check if entitlement exists first
            const existing = await this.getHolidayEntitlement(userIdInt, yearInt);
            if (existing) {
                // Update existing
                console.log('Updating existing entitlement:', { userId: userIdInt, year: yearInt, totalDays: totalDaysInt });
                db.prepare(
                    `UPDATE holiday_entitlements 
                     SET total_days = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = ? AND year = ?`
                ).run(totalDaysInt, userIdInt, yearInt);
            } else {
                // Insert new
                console.log('Inserting new entitlement:', { userId: userIdInt, year: yearInt, totalDays: totalDaysInt });
                const stmt = db.prepare(
                    `INSERT INTO holiday_entitlements (user_id, year, total_days, days_used)
                     VALUES (?, ?, ?, 0)`
                );
                const info = stmt.run(userIdInt, yearInt, totalDaysInt);
                console.log('Inserted entitlement (SQLite), lastInsertRowid:', info.lastInsertRowid);
            }
            const result = await this.getHolidayEntitlement(userIdInt, yearInt);
            console.log('Retrieved entitlement after save:', result);
            return result;
        }
    }
    
    static async getHolidayEntitlement(userId, year) {
        // Ensure userId and year are integers
        const userIdInt = parseInt(userId);
        const yearInt = parseInt(year);
        console.log('getHolidayEntitlement called with userId:', userIdInt, 'type:', typeof userIdInt, 'year:', yearInt, 'type:', typeof yearInt);
        
        let entitlement;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT *, (total_days - days_used) as days_remaining 
                 FROM holiday_entitlements WHERE user_id = $1 AND year = $2`,
                [userIdInt, yearInt]
            );
            entitlement = result.rows[0] || null;
            // Also try a broader query to see what's in the database
            if (!entitlement) {
                const allForUser = await pool.query(
                    `SELECT * FROM holiday_entitlements WHERE user_id = $1`,
                    [userIdInt]
                );
                console.log('All entitlements for user', userIdInt, ':', allForUser.rows);
                const allForYear = await pool.query(
                    `SELECT * FROM holiday_entitlements WHERE year = $1`,
                    [yearInt]
                );
                console.log('All entitlements for year', yearInt, ':', allForYear.rows);
            }
        } else {
            const row = db.prepare(
                `SELECT *, (total_days - days_used) as days_remaining 
                 FROM holiday_entitlements WHERE user_id = ? AND year = ?`
            ).get(userIdInt, yearInt);
            entitlement = row || null;
            // Also try a broader query to see what's in the database
            if (!entitlement) {
                const allForUser = db.prepare(
                    `SELECT * FROM holiday_entitlements WHERE user_id = ?`
                ).all(userIdInt);
                console.log('All entitlements for user', userIdInt, ':', allForUser);
                const allForYear = db.prepare(
                    `SELECT * FROM holiday_entitlements WHERE year = ?`
                ).all(yearInt);
                console.log('All entitlements for year', yearInt, ':', allForYear);
            }
        }
        console.log('getHolidayEntitlement result:', entitlement);
        if (entitlement) {
            // Normalize types to ensure consistency
            entitlement.user_id = parseInt(entitlement.user_id);
            entitlement.year = parseInt(entitlement.year);
            if (entitlement.days_remaining !== undefined) {
                entitlement.days_remaining = parseFloat(entitlement.days_remaining);
            }
        }
        return entitlement;
    }
    
    static async getUserHolidayEntitlements(userId) {
        // Ensure userId is an integer
        const userIdInt = parseInt(userId);
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT *, (total_days - days_used) as days_remaining 
                 FROM holiday_entitlements WHERE user_id = $1 ORDER BY year DESC`,
                [userIdInt]
            );
            return result.rows.map(row => ({
                ...row,
                user_id: parseInt(row.user_id),
                year: parseInt(row.year),
                days_remaining: parseFloat(row.days_remaining || 0)
            }));
        } else {
            const rows = db.prepare(
                `SELECT *, (total_days - days_used) as days_remaining 
                 FROM holiday_entitlements WHERE user_id = ? ORDER BY year DESC`
            ).all(userIdInt);
            return rows.map(row => ({
                ...row,
                user_id: parseInt(row.user_id),
                year: parseInt(row.year),
                days_remaining: parseFloat(row.days_remaining || 0)
            }));
        }
    }
    
    static async deductHolidayDays(userId, year, days) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE holiday_entitlements 
                 SET days_used = days_used + $1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $2 AND year = $3
                 RETURNING *`,
                [days, userId, year]
            );
            return result.rows[0] || null;
        } else {
            db.prepare(
                `UPDATE holiday_entitlements 
                 SET days_used = days_used + ?, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ? AND year = ?`
            ).run(days, userId, year);
            return this.getHolidayEntitlement(userId, year);
        }
    }
    
    static async addHolidayDays(userId, year, days) {
        // Get current entitlement first
        const entitlement = await this.getHolidayEntitlement(userId, year);
        if (!entitlement) return null;
        
        const newDaysUsed = Math.max(0, parseFloat(entitlement.days_used || 0) - days);
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE holiday_entitlements 
                 SET days_used = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $2 AND year = $3
                 RETURNING *`,
                [newDaysUsed, userId, year]
            );
            return result.rows[0] || null;
        } else {
            db.prepare(
                `UPDATE holiday_entitlements 
                 SET days_used = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ? AND year = ?`
            ).run(newDaysUsed, userId, year);
            return this.getHolidayEntitlement(userId, year);
        }
    }
    
    // Recalculate days_used based on all approved holiday requests and shutdown periods for a user/year
    // This ensures accuracy and includes future approved holidays and shutdown deductions
    static async recalculateHolidayDaysUsed(userId, year) {
        const userIdInt = parseInt(userId);
        const yearInt = parseInt(year);
        
        // Get all approved holiday requests for this user and year
        let approvedRequests;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT * FROM holiday_requests 
                 WHERE user_id = $1 
                 AND status = 'approved'
                 AND EXTRACT(YEAR FROM start_date) = $2`,
                [userIdInt, yearInt]
            );
            approvedRequests = result.rows;
        } else {
            approvedRequests = db.prepare(
                `SELECT * FROM holiday_requests 
                 WHERE user_id = ? 
                 AND status = 'approved'
                 AND strftime('%Y', start_date) = ?`
            ).all(userIdInt, yearInt.toString());
        }
        
        // Sum up all days from approved requests
        let totalDaysUsed = 0;
        for (const request of approvedRequests) {
            totalDaysUsed += parseFloat(request.days_requested || 0);
        }
        
        // Get active shutdown periods and calculate days for this specific year
        const shutdownPeriods = await this.getActiveShutdownPeriods();
        let shutdownDaysForYear = 0;
        
        for (const period of shutdownPeriods) {
            const start = new Date(period.start_date);
            const end = new Date(period.end_date);
            const startYear = start.getFullYear();
            const endYear = end.getFullYear();
            
            // Calculate weekdays for this shutdown period in the target year
            if (startYear === endYear && startYear === yearInt) {
                // Single year shutdown that matches our target year
                const weekdays = this.calculateWorkingDays(period.start_date, period.end_date);
                shutdownDaysForYear += weekdays;
            } else if (startYear <= yearInt && endYear >= yearInt) {
                // Cross-year shutdown that includes our target year
                if (startYear === yearInt) {
                    // Target year is the start year - calculate from start_date to end of year
                    const yearEnd = new Date(yearInt, 11, 31).toISOString().split('T')[0];
                    const weekdays = this.calculateWorkingDays(period.start_date, yearEnd);
                    if (weekdays > 0) {
                        shutdownDaysForYear += weekdays;
                    }
                } else if (endYear === yearInt) {
                    // Target year is the end year - calculate from start of year to end_date
                    const yearStart = new Date(yearInt, 0, 1).toISOString().split('T')[0];
                    const weekdays = this.calculateWorkingDays(yearStart, period.end_date);
                    if (weekdays > 0) {
                        shutdownDaysForYear += weekdays;
                    }
                } else if (startYear < yearInt && endYear > yearInt) {
                    // Target year is in between - calculate full year weekdays
                    const yearStart = new Date(yearInt, 0, 1).toISOString().split('T')[0];
                    const yearEnd = new Date(yearInt, 11, 31).toISOString().split('T')[0];
                    const weekdays = this.calculateWorkingDays(yearStart, yearEnd);
                    if (weekdays > 0) {
                        shutdownDaysForYear += weekdays;
                    }
                }
            }
        }
        
        // Add shutdown days to total days used
        totalDaysUsed += shutdownDaysForYear;
        
        // Update the entitlement with the recalculated value
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE holiday_entitlements 
                 SET days_used = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $2 AND year = $3
                 RETURNING *`,
                [totalDaysUsed, userIdInt, yearInt]
            );
            return result.rows[0] || null;
        } else {
            db.prepare(
                `UPDATE holiday_entitlements 
                 SET days_used = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ? AND year = ?`
            ).run(totalDaysUsed, userIdInt, yearInt);
            return this.getHolidayEntitlement(userIdInt, yearInt);
        }
    }
    
    static async getAllHolidayEntitlements() {
        let rows;
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT he.*, 
                 (he.total_days - he.days_used) as days_remaining,
                 u.username 
                 FROM holiday_entitlements he
                 JOIN production_users u ON he.user_id = u.id
                 ORDER BY he.year DESC, u.username`
            );
            rows = result.rows;
        } else {
            rows = db.prepare(
                `SELECT he.*, 
                 (he.total_days - he.days_used) as days_remaining,
                 u.username 
                 FROM holiday_entitlements he
                 JOIN production_users u ON he.user_id = u.id
                 ORDER BY he.year DESC, u.username`
            ).all();
        }
        // Normalize types to ensure consistency
        return rows.map(row => ({
            ...row,
            user_id: parseInt(row.user_id),
            year: parseInt(row.year),
            days_remaining: parseFloat(row.days_remaining || 0)
        }));
    }
    
    static async getHolidayEntitlementWithRemaining(userId, year) {
        const entitlement = await this.getHolidayEntitlement(userId, year);
        if (!entitlement) return null;
        
        return {
            ...entitlement,
            days_remaining: parseFloat(entitlement.total_days || 0) - parseFloat(entitlement.days_used || 0)
        };
    }
    
    // Holiday Request Methods
    static async createHolidayRequest(data) {
        const { user_id, start_date, end_date, requested_by_user_id, is_company_shutdown, status, reviewed_by_user_id, review_notes, days_requested } = data;
        // Use provided days_requested if available (e.g., for half days), otherwise calculate
        const weekdays = days_requested !== undefined ? parseFloat(days_requested) : this.calculateWorkingDays(start_date, end_date);
        const requestStatus = status || 'pending';
        const now = requestStatus === 'approved' ? new Date().toISOString() : null;
        
        console.log(`Creating holiday request with status="${requestStatus}":`, { user_id, start_date, end_date, weekdays, days_requested_provided: days_requested !== undefined });
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO holiday_requests 
                 (user_id, start_date, end_date, days_requested, requested_by_user_id, is_company_shutdown, status, reviewed_by_user_id, reviewed_at, review_notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [user_id, start_date, end_date, weekdays, requested_by_user_id, is_company_shutdown || false, requestStatus, reviewed_by_user_id || null, now, review_notes || null]
            );
            console.log(`Created holiday request (PostgreSQL) with status="${requestStatus}":`, result.rows[0]);
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO holiday_requests 
                 (user_id, start_date, end_date, days_requested, requested_by_user_id, is_company_shutdown, status, reviewed_by_user_id, reviewed_at, review_notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(user_id, start_date, end_date, weekdays, requested_by_user_id, is_company_shutdown ? 1 : 0, requestStatus, reviewed_by_user_id || null, now, review_notes || null);
            const created = await this.getHolidayRequestById(info.lastInsertRowid);
            console.log(`Created holiday request (SQLite) with status="${requestStatus}":`, created);
            return created;
        }
    }
    
    static async getHolidayRequestById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT hr.*, 
                 u1.username as user_name,
                 u2.username as requested_by_name,
                 u3.username as reviewed_by_name
                 FROM holiday_requests hr
                 LEFT JOIN production_users u1 ON hr.user_id = u1.id
                 LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                 LEFT JOIN production_users u3 ON hr.reviewed_by_user_id = u3.id
                 WHERE hr.id = $1`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT hr.*, 
                 u1.username as user_name,
                 u2.username as requested_by_name,
                 u3.username as reviewed_by_name
                 FROM holiday_requests hr
                 LEFT JOIN production_users u1 ON hr.user_id = u1.id
                 LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                 LEFT JOIN production_users u3 ON hr.reviewed_by_user_id = u3.id
                 WHERE hr.id = ?`
            ).get(id) || null;
        }
    }
    
    static async getHolidayRequestsByUser(userId, year = null) {
        // Ensure userId is an integer for proper comparison
        const userIdInt = parseInt(userId);
        const yearInt = year ? parseInt(year) : null;
        
        if (isPostgreSQL) {
            let query = `SELECT hr.*, 
                u1.username as user_name,
                u2.username as requested_by_name,
                u3.username as reviewed_by_name
                FROM holiday_requests hr
                LEFT JOIN production_users u1 ON hr.user_id = u1.id
                LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                LEFT JOIN production_users u3 ON hr.reviewed_by_user_id = u3.id
                WHERE hr.user_id = $1`;
            const params = [userIdInt];
            
            if (yearInt) {
                query += ` AND EXTRACT(YEAR FROM hr.start_date) = $2 ORDER BY hr.start_date DESC`;
                params.push(yearInt);
            } else {
                query += ` ORDER BY hr.start_date DESC`;
            }
            
            const result = await pool.query(query, params);
            return result.rows;
        } else {
            let query = `SELECT hr.*, 
                u1.username as user_name,
                u2.username as requested_by_name,
                u3.username as reviewed_by_name
                FROM holiday_requests hr
                LEFT JOIN production_users u1 ON hr.user_id = u1.id
                LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                LEFT JOIN production_users u3 ON hr.reviewed_by_user_id = u3.id
                WHERE hr.user_id = ?`;
            
            if (yearInt) {
                query += ` AND strftime('%Y', hr.start_date) = ? ORDER BY hr.start_date DESC`;
                return db.prepare(query).all(userIdInt, yearInt.toString());
            } else {
                query += ` ORDER BY hr.start_date DESC`;
                return db.prepare(query).all(userIdInt);
            }
        }
    }
    
    static async getAllHolidayRequests(year = null) {
        if (isPostgreSQL) {
            let query = `SELECT hr.*, 
                u1.username as user_name,
                u2.username as requested_by_name,
                u3.username as reviewed_by_name
                FROM holiday_requests hr
                LEFT JOIN production_users u1 ON hr.user_id = u1.id
                LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                LEFT JOIN production_users u3 ON hr.reviewed_by_user_id = u3.id`;
            
            const params = [];
            if (year) {
                query += ` WHERE EXTRACT(YEAR FROM hr.start_date) = $1 ORDER BY hr.start_date DESC`;
                params.push(year);
            } else {
                query += ` ORDER BY hr.start_date DESC`;
            }
            
            const result = await pool.query(query, params);
            return result.rows;
        } else {
            let query = `SELECT hr.*, 
                u1.username as user_name,
                u2.username as requested_by_name,
                u3.username as reviewed_by_name
                FROM holiday_requests hr
                LEFT JOIN production_users u1 ON hr.user_id = u1.id
                LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                LEFT JOIN production_users u3 ON hr.reviewed_by_user_id = u3.id`;
            
            if (year) {
                query += ` WHERE strftime('%Y', hr.start_date) = ? ORDER BY hr.start_date DESC`;
                return db.prepare(query).all(year.toString());
            } else {
                query += ` ORDER BY hr.start_date DESC`;
                return db.prepare(query).all();
            }
        }
    }
    
    static async getAllHolidayRequestsPaged(year = null, opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        const baseJoin = `FROM holiday_requests hr
                LEFT JOIN production_users u1 ON hr.user_id = u1.id
                LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                LEFT JOIN production_users u3 ON hr.reviewed_by_user_id = u3.id`;
        const sel = `SELECT hr.*, 
                u1.username as user_name,
                u2.username as requested_by_name,
                u3.username as reviewed_by_name `;
        if (isPostgreSQL) {
            const w = year ? `WHERE EXTRACT(YEAR FROM hr.start_date) = $1` : '';
            const p = year ? [year] : [];
            const countRes = await pool.query(
                `SELECT COUNT(*)::int AS c ${baseJoin} ${w}`,
                p
            );
            const total = countRes.rows[0].c;
            if (year) {
                const r = await pool.query(
                    `${sel} ${baseJoin} ${w} ORDER BY hr.start_date DESC LIMIT $2 OFFSET $3`,
                    [year, pageSize, offset]
                );
                return { requests: r.rows, total, page, page_size: pageSize };
            }
            const r = await pool.query(
                `${sel} ${baseJoin} ORDER BY hr.start_date DESC LIMIT $1 OFFSET $2`,
                [pageSize, offset]
            );
            return { requests: r.rows, total, page, page_size: pageSize };
        }
        if (year) {
            const row = db.prepare(`SELECT COUNT(*) AS c ${baseJoin} WHERE strftime('%Y', hr.start_date) = ?`).get(year.toString());
            const rows = db.prepare(
                `${sel} ${baseJoin} WHERE strftime('%Y', hr.start_date) = ? ORDER BY hr.start_date DESC LIMIT ? OFFSET ?`
            ).all(year.toString(), pageSize, offset);
            return { requests: rows, total: row.c, page, page_size: pageSize };
        }
        const row = db.prepare(`SELECT COUNT(*) AS c ${baseJoin}`).get();
        const rows = db.prepare(
            `${sel} ${baseJoin} ORDER BY hr.start_date DESC LIMIT ? OFFSET ?`
        ).all(pageSize, offset);
        return { requests: rows, total: row.c, page, page_size: pageSize };
    }
    
    static async getPendingHolidayRequests() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT hr.*, 
                 u1.username as user_name,
                 u2.username as requested_by_name
                 FROM holiday_requests hr
                 LEFT JOIN production_users u1 ON hr.user_id = u1.id
                 LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                 WHERE hr.status = 'pending'
                 ORDER BY hr.requested_at ASC`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT hr.*, 
                 u1.username as user_name,
                 u2.username as requested_by_name
                 FROM holiday_requests hr
                 LEFT JOIN production_users u1 ON hr.user_id = u1.id
                 LEFT JOIN production_users u2 ON hr.requested_by_user_id = u2.id
                 WHERE hr.status = 'pending'
                 ORDER BY hr.requested_at ASC`
            ).all();
        }
    }
    
    static async updateHolidayRequestStatus(id, status, reviewedBy, reviewNotes = null) {
        const now = new Date().toISOString();
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE holiday_requests 
                 SET status = $1, reviewed_by_user_id = $2, reviewed_at = $3, review_notes = $4
                 WHERE id = $5
                 RETURNING *`,
                [status, reviewedBy, now, reviewNotes, id]
            );
            return result.rows[0] || null;
        } else {
            db.prepare(
                `UPDATE holiday_requests 
                 SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_notes = ?
                 WHERE id = ?`
            ).run(status, reviewedBy, now, reviewNotes, id);
            return this.getHolidayRequestById(id);
        }
    }
    
    // Delete timesheet entries associated with a holiday request
    static async deleteTimesheetEntriesByHolidayRequest(holidayRequestId) {
        const requestId = parseInt(holidayRequestId);
        
        if (isPostgreSQL) {
            // First, get the daily entries to find any associated amendments
            const dailyEntries = await pool.query(
                `SELECT id FROM timesheet_daily_entries WHERE holiday_request_id = $1`,
                [requestId]
            );
            
            // Delete amendments for any timesheet entries linked to these daily entries
            // (Note: amendments are linked to timesheet_entry_id, not daily entries directly)
            // But we need to check if daily entries have timesheet_entry_id references
            
            // Delete the daily entries
            await pool.query(
                `DELETE FROM timesheet_daily_entries WHERE holiday_request_id = $1`,
                [requestId]
            );
            
            return { deletedCount: dailyEntries.rows.length };
        } else {
            // Get daily entries first
            const dailyEntries = db.prepare(
                `SELECT id FROM timesheet_daily_entries WHERE holiday_request_id = ?`
            ).all(requestId);
            
            // Delete the daily entries
            db.prepare(
                `DELETE FROM timesheet_daily_entries WHERE holiday_request_id = ?`
            ).run(requestId);
            
            return { deletedCount: dailyEntries.length };
        }
    }
    
    // Delete a holiday request
    static async deleteHolidayRequest(id) {
        const requestId = parseInt(id);
        
        // First get the request to return it
        const request = await this.getHolidayRequestById(requestId);
        if (!request) {
            return null;
        }
        
        if (isPostgreSQL) {
            // Delete the holiday request
            await pool.query(
                `DELETE FROM holiday_requests WHERE id = $1`,
                [requestId]
            );
        } else {
            db.prepare(
                `DELETE FROM holiday_requests WHERE id = ?`
            ).run(requestId);
        }
        
        return request;
    }
    
    static async getApprovedHolidaysInDateRange(startDate, endDate, userId = null) {
        if (isPostgreSQL) {
            let query = `SELECT * FROM holiday_requests 
                WHERE status = 'approved'
                AND start_date <= $2 
                AND end_date >= $1`;
            const params = [startDate, endDate];
            
            if (userId) {
                query += ` AND user_id = $3`;
                params.push(userId);
            }
            
            query += ` ORDER BY start_date`;
            const result = await pool.query(query, params);
            return result.rows;
        } else {
            let query = `SELECT * FROM holiday_requests 
                WHERE status = 'approved'
                AND start_date <= ? 
                AND end_date >= ?`;
            
            if (userId) {
                query += ` AND user_id = ? ORDER BY start_date`;
                return db.prepare(query).all(endDate, startDate, userId);
            } else {
                query += ` ORDER BY start_date`;
                return db.prepare(query).all(endDate, startDate);
            }
        }
    }
    
    // Company Shutdown Methods
    static async createCompanyShutdownPeriod(data) {
        const { year, start_date, end_date, description, created_by_user_id } = data;
        
        try {
            if (isPostgreSQL) {
                const result = await pool.query(
                    `INSERT INTO company_shutdown_periods (year, start_date, end_date, description, created_by_user_id, is_active)
                     VALUES ($1, $2, $3, $4, $5, TRUE)
                     RETURNING *`,
                    [year, start_date, end_date, description, created_by_user_id]
                );
                console.log('Created shutdown period (PostgreSQL):', result.rows[0]);
                return result.rows[0];
            } else {
                const stmt = db.prepare(
                    `INSERT INTO company_shutdown_periods (year, start_date, end_date, description, created_by_user_id, is_active)
                     VALUES (?, ?, ?, ?, ?, 1)`
                );
                const info = stmt.run(year, start_date, end_date, description, created_by_user_id);
                console.log('Inserted shutdown period (SQLite), lastInsertRowid:', info.lastInsertRowid);
                const created = await this.getCompanyShutdownPeriodById(info.lastInsertRowid);
                console.log('Retrieved created shutdown period:', created);
                return created;
            }
        } catch (error) {
            console.error('Error in createCompanyShutdownPeriod:', error);
            throw error;
        }
    }
    
    static async getCompanyShutdownPeriodById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT csp.*, u.username as created_by_name
                 FROM company_shutdown_periods csp
                 LEFT JOIN production_users u ON csp.created_by_user_id = u.id
                 WHERE csp.id = $1`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT csp.*, u.username as created_by_name
                 FROM company_shutdown_periods csp
                 LEFT JOIN production_users u ON csp.created_by_user_id = u.id
                 WHERE csp.id = ?`
            ).get(id) || null;
        }
    }
    
    static async getActiveShutdownPeriods() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT csp.*, u.username as created_by_name
                 FROM company_shutdown_periods csp
                 LEFT JOIN production_users u ON csp.created_by_user_id = u.id
                 WHERE csp.is_active = TRUE
                 ORDER BY csp.year DESC, csp.start_date`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT csp.*, u.username as created_by_name
                 FROM company_shutdown_periods csp
                 LEFT JOIN production_users u ON csp.created_by_user_id = u.id
                 WHERE csp.is_active = 1
                 ORDER BY csp.year DESC, csp.start_date`
            ).all();
        }
    }
    
    static async getShutdownPeriodsByYear(year) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT csp.*, u.username as created_by_name
                 FROM company_shutdown_periods csp
                 LEFT JOIN production_users u ON csp.created_by_user_id = u.id
                 WHERE csp.year = $1
                 ORDER BY csp.start_date`,
                [year]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT csp.*, u.username as created_by_name
                 FROM company_shutdown_periods csp
                 LEFT JOIN production_users u ON csp.created_by_user_id = u.id
                 WHERE csp.year = ?
                 ORDER BY csp.start_date`
            ).all(year);
        }
    }
    
    static async updateCompanyShutdownPeriod(id, data) {
        const { year, start_date, end_date, description, is_active } = data;
        
        try {
            if (isPostgreSQL) {
                const result = await pool.query(
                    `UPDATE company_shutdown_periods 
                     SET year = $1, start_date = $2, end_date = $3, description = $4, is_active = $5
                     WHERE id = $6
                     RETURNING *`,
                    [year, start_date, end_date, description || null, is_active !== undefined ? is_active : true, id]
                );
                if (result.rows.length === 0) {
                    return null;
                }
                const updated = await this.getCompanyShutdownPeriodById(id);
                return updated;
            } else {
                const stmt = db.prepare(
                    `UPDATE company_shutdown_periods 
                     SET year = ?, start_date = ?, end_date = ?, description = ?, is_active = ?
                     WHERE id = ?`
                );
                stmt.run(year, start_date, end_date, description || null, is_active !== undefined ? (is_active ? 1 : 0) : 1, id);
                return await this.getCompanyShutdownPeriodById(id);
            }
        } catch (error) {
            console.error('Error in updateCompanyShutdownPeriod:', error);
            throw error;
        }
    }
    
    static async deleteCompanyShutdownPeriod(id) {
        try {
            if (isPostgreSQL) {
                const result = await pool.query(
                    `DELETE FROM company_shutdown_periods WHERE id = $1 RETURNING *`,
                    [id]
                );
                return result.rows.length > 0;
            } else {
                const stmt = db.prepare(`DELETE FROM company_shutdown_periods WHERE id = ?`);
                const info = stmt.run(id);
                return info.changes > 0;
            }
        } catch (error) {
            console.error('Error in deleteCompanyShutdownPeriod:', error);
            throw error;
        }
    }
    
    static async applyShutdownToEntitlements(startDate, endDate) {
        // Calculate which years the shutdown period spans
        const start = new Date(startDate);
        const end = new Date(endDate);
        const startYear = start.getFullYear();
        const endYear = end.getFullYear();
        
        const yearAllocations = {};
        
        // If it's a single year, process it normally
        if (startYear === endYear) {
            const weekdays = this.calculateWorkingDays(startDate, endDate);
            yearAllocations[startYear] = weekdays;
        } else {
            // Cross-year shutdown: calculate weekdays for each year separately
            // First year: from start_date to end of that year
            const firstYearEnd = new Date(startYear, 11, 31).toISOString().split('T')[0];
            const firstYearWeekdays = this.calculateWorkingDays(startDate, firstYearEnd);
            if (firstYearWeekdays > 0) {
                yearAllocations[startYear] = firstYearWeekdays;
            }
            
            // Last year: from start of that year to end_date
            const lastYearStart = new Date(endYear, 0, 1).toISOString().split('T')[0];
            const lastYearWeekdays = this.calculateWorkingDays(lastYearStart, endDate);
            if (lastYearWeekdays > 0) {
                yearAllocations[endYear] = lastYearWeekdays;
            }
            
            // If there are years in between, count full year weekdays
            for (let year = startYear + 1; year < endYear; year++) {
                const yearStart = new Date(year, 0, 1).toISOString().split('T')[0];
                const yearEnd = new Date(year, 11, 31).toISOString().split('T')[0];
                const yearWeekdays = this.calculateWorkingDays(yearStart, yearEnd);
                if (yearWeekdays > 0) {
                    yearAllocations[year] = yearWeekdays;
                }
            }
        }
        
        // Get all entitlements
        const entitlements = await this.getAllHolidayEntitlements();
        
        // Deduct weekdays from each year's entitlements
        for (const [year, weekdays] of Object.entries(yearAllocations)) {
            const yearNum = parseInt(year);
            const yearEntitlements = entitlements.filter(e => e.year === yearNum);
            
            for (const entitlement of yearEntitlements) {
                await this.deductHolidayDays(entitlement.user_id, yearNum, weekdays);
            }
        }
        
        return {
            totalWeekdays: Object.values(yearAllocations).reduce((sum, days) => sum + days, 0),
            yearBreakdown: yearAllocations
        };
    }
    
    static async recalculateAllEntitlements() {
        // Get all entitlements, active shutdown periods, and approved holiday requests
        const entitlements = await this.getAllHolidayEntitlements();
        const shutdownPeriods = await this.getActiveShutdownPeriods();
        const approvedRequests = await this.getAllHolidayRequests();
        const approvedRequestsList = approvedRequests.filter(req => req.status === 'approved');
        
        // Build a map of shutdown periods by year for quick lookup
        const shutdownByYear = {};
        for (const period of shutdownPeriods) {
            const start = new Date(period.start_date);
            const end = new Date(period.end_date);
            const startYear = start.getFullYear();
            const endYear = end.getFullYear();
            
            // Calculate weekday allocation for this shutdown period
            if (startYear === endYear) {
                const weekdays = this.calculateWorkingDays(period.start_date, period.end_date);
                if (!shutdownByYear[startYear]) shutdownByYear[startYear] = 0;
                shutdownByYear[startYear] += weekdays;
            } else {
                // Cross-year shutdown
                const firstYearEnd = new Date(startYear, 11, 31).toISOString().split('T')[0];
                const firstYearWeekdays = this.calculateWorkingDays(period.start_date, firstYearEnd);
                if (firstYearWeekdays > 0) {
                    if (!shutdownByYear[startYear]) shutdownByYear[startYear] = 0;
                    shutdownByYear[startYear] += firstYearWeekdays;
                }
                
                const lastYearStart = new Date(endYear, 0, 1).toISOString().split('T')[0];
                const lastYearWeekdays = this.calculateWorkingDays(lastYearStart, period.end_date);
                if (lastYearWeekdays > 0) {
                    if (!shutdownByYear[endYear]) shutdownByYear[endYear] = 0;
                    shutdownByYear[endYear] += lastYearWeekdays;
                }
                
                // Years in between
                for (let year = startYear + 1; year < endYear; year++) {
                    const yearStart = new Date(year, 0, 1).toISOString().split('T')[0];
                    const yearEnd = new Date(year, 11, 31).toISOString().split('T')[0];
                    const yearWeekdays = this.calculateWorkingDays(yearStart, yearEnd);
                    if (yearWeekdays > 0) {
                        if (!shutdownByYear[year]) shutdownByYear[year] = 0;
                        shutdownByYear[year] += yearWeekdays;
                    }
                }
            }
        }
        
        // Build a map of approved requests by user_id and year
        const requestsByUserAndYear = {};
        for (const request of approvedRequestsList) {
            const userId = parseInt(request.user_id);
            const year = new Date(request.start_date).getFullYear();
            const key = `${userId}_${year}`;
            if (!requestsByUserAndYear[key]) {
                requestsByUserAndYear[key] = 0;
            }
            requestsByUserAndYear[key] += parseFloat(request.days_requested || 0);
        }
        
        // Recalculate each entitlement
        let updatedCount = 0;
        for (const entitlement of entitlements) {
            const userId = parseInt(entitlement.user_id);
            const year = parseInt(entitlement.year);
            
            // Start with approved holiday requests
            const requestKey = `${userId}_${year}`;
            let daysUsed = requestsByUserAndYear[requestKey] || 0;
            
            // Add shutdown period days for this year
            if (shutdownByYear[year]) {
                daysUsed += shutdownByYear[year];
            }
            
            // Update the entitlement
            if (isPostgreSQL) {
                await pool.query(
                    `UPDATE holiday_entitlements 
                     SET days_used = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = $2 AND year = $3`,
                    [daysUsed, userId, year]
                );
            } else {
                db.prepare(
                    `UPDATE holiday_entitlements 
                     SET days_used = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = ? AND year = ?`
                ).run(daysUsed, userId, year);
            }
            
            updatedCount++;
        }
        
        return {
            updated: updatedCount,
            totalEntitlements: entitlements.length,
            shutdownPeriodsCount: shutdownPeriods.length,
            approvedRequestsCount: approvedRequestsList.length
        };
    }
    
    // Timesheet Integration Methods
    static async populateHolidayTimesheetEntry(userId, date, holidayRequestId) {
        // Verify the holiday request is approved before populating timesheet
        const holidayRequest = await this.getHolidayRequestById(holidayRequestId);
        if (!holidayRequest || holidayRequest.status !== 'approved') {
            console.warn(`Cannot populate timesheet entry: holiday request ${holidayRequestId} is not approved (status: ${holidayRequest?.status || 'not found'})`);
            return null;
        }
        
        const ymd = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())
            ? String(date).trim()
            : londonYmd(new Date(date));
        const dayOfWeek = londonWeekdaySun0FromYmd(ymd);
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return null;
        }
        
        const weekStartDate = londonMondayYmdFromYmd(ymd);
        
        // Get or create weekly timesheet
        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(userId, weekStartDate);
        
        // Get or create daily entry
        const dailyEntry = await this.getOrCreateDailyEntry(
            weeklyTimesheet.id,
            ymd,
            null // No timesheet_entry_id for holidays
        );
        
        // Friday = 6 hours, Mon-Thu = 8 hours (default working day)
        const hours = (dayOfWeek === 5) ? 6 : 8;
        // Update daily entry with holiday information
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE timesheet_daily_entries 
                 SET day_type = 'holiday_paid',
                     regular_hours = $1,
                     total_hours = $1,
                     holiday_request_id = $2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3
                 RETURNING *`,
                [hours, holidayRequestId, dailyEntry.id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE timesheet_daily_entries 
                 SET day_type = 'holiday_paid',
                     regular_hours = ?,
                     total_hours = ?,
                     holiday_request_id = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            ).run(hours, hours, holidayRequestId, dailyEntry.id);
            return this.getDailyEntryById(dailyEntry.id);
        }
    }
    
    static async checkAndPopulateApprovedHolidays(userId, weekStartDate) {
        const weekEndStr = londonYmdAddDays(weekStartDate, 6);
        
        // Get approved holidays for this week
        const holidays = await this.getApprovedHolidaysInDateRange(weekStartDate, weekEndStr, userId);
        
        for (const holiday of holidays) {
            const startYmd = ymdFromDbOrInstant(holiday.start_date);
            const endYmd = ymdFromDbOrInstant(holiday.end_date);
            let cur = startYmd > weekStartDate ? startYmd : weekStartDate;
            const last = endYmd < weekEndStr ? endYmd : weekEndStr;
            while (cur <= last) {
                await this.populateHolidayTimesheetEntry(userId, cur, holiday.id);
                cur = londonYmdAddDays(cur, 1);
            }
        }
        
        return holidays;
    }
    
    // ============ TASKS OPERATIONS ============
    
    static async createTask(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO tasks (title, description, assigned_to_user_id, created_by_user_id, status, due_date)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [data.title, data.description, data.assigned_to_user_id, data.created_by_user_id, data.status || 'pending', data.due_date]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO tasks (title, description, assigned_to_user_id, created_by_user_id, status, due_date)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.title, data.description, data.assigned_to_user_id, data.created_by_user_id, data.status || 'pending', data.due_date);
            return this.getTaskById(info.lastInsertRowid);
        }
    }
    
    static async getTaskById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT t.*, 
                 u1.username as assigned_to_name,
                 u2.username as created_by_name,
                 u3.username as completed_by_name
                 FROM tasks t
                 LEFT JOIN production_users u1 ON t.assigned_to_user_id = u1.id
                 LEFT JOIN production_users u2 ON t.created_by_user_id = u2.id
                 LEFT JOIN production_users u3 ON t.completed_by_user_id = u3.id
                 WHERE t.id = $1`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT t.*, 
                 u1.username as assigned_to_name,
                 u2.username as created_by_name,
                 u3.username as completed_by_name
                 FROM tasks t
                 LEFT JOIN production_users u1 ON t.assigned_to_user_id = u1.id
                 LEFT JOIN production_users u2 ON t.created_by_user_id = u2.id
                 LEFT JOIN production_users u3 ON t.completed_by_user_id = u3.id
                 WHERE t.id = ?`
            ).get(id) || null;
        }
    }
    
    static async getAllTasks(filters = {}) {
        let query = `SELECT t.*, 
                     u1.username as assigned_to_name,
                     u2.username as created_by_name,
                     u3.username as completed_by_name
                     FROM tasks t
                     LEFT JOIN production_users u1 ON t.assigned_to_user_id = u1.id
                     LEFT JOIN production_users u2 ON t.created_by_user_id = u2.id
                     LEFT JOIN production_users u3 ON t.completed_by_user_id = u3.id
                     WHERE 1=1`;
        const params = [];
        
        if (filters.status) {
            query += ` AND t.status = $${params.length + 1}`;
            params.push(filters.status);
        }
        if (filters.assigned_to_user_id) {
            query += ` AND t.assigned_to_user_id = $${params.length + 1}`;
            params.push(filters.assigned_to_user_id);
        }
        if (filters.overdue) {
            const today = new Date().toISOString().split('T')[0];
            query += ` AND t.due_date < $${params.length + 1} AND t.status != 'completed'`;
            params.push(today);
        }
        
        query += ` ORDER BY t.due_date ASC, t.created_at DESC`;
        
        if (isPostgreSQL) {
            const result = await pool.query(query, params);
            return result.rows;
        } else {
            // SQLite - build query with ? placeholders
            let sqliteQuery = `SELECT t.*, 
                     u1.username as assigned_to_name,
                     u2.username as created_by_name,
                     u3.username as completed_by_name
                     FROM tasks t
                     LEFT JOIN production_users u1 ON t.assigned_to_user_id = u1.id
                     LEFT JOIN production_users u2 ON t.created_by_user_id = u2.id
                     LEFT JOIN production_users u3 ON t.completed_by_user_id = u3.id
                     WHERE 1=1`;
            const sqliteParams = [];
            
            if (filters.status) {
                sqliteQuery += ` AND t.status = ?`;
                sqliteParams.push(filters.status);
            }
            if (filters.assigned_to_user_id) {
                sqliteQuery += ` AND t.assigned_to_user_id = ?`;
                sqliteParams.push(filters.assigned_to_user_id);
            }
            if (filters.overdue) {
                const today = new Date().toISOString().split('T')[0];
                sqliteQuery += ` AND t.due_date < ? AND t.status != 'completed'`;
                sqliteParams.push(today);
            }
            
            sqliteQuery += ` ORDER BY t.due_date ASC, t.created_at DESC`;
            return db.prepare(sqliteQuery).all(...sqliteParams);
        }
    }
    
    static async getTasksPaged(filters = {}, opts = {}) {
        const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(String(opts.pageSize), 10) || 25));
        const offset = (page - 1) * pageSize;
        const baseJoin = `FROM tasks t
                     LEFT JOIN production_users u1 ON t.assigned_to_user_id = u1.id
                     LEFT JOIN production_users u2 ON t.created_by_user_id = u2.id
                     LEFT JOIN production_users u3 ON t.completed_by_user_id = u3.id`;
        const selCols = `SELECT t.*, 
                     u1.username as assigned_to_name,
                     u2.username as created_by_name,
                     u3.username as completed_by_name `;
        if (isPostgreSQL) {
            const p = [];
            let w = 'WHERE 1=1';
            let i = 1;
            if (filters.status) {
                w += ` AND t.status = $${i++}`;
                p.push(filters.status);
            }
            if (filters.assigned_to_user_id) {
                w += ` AND t.assigned_to_user_id = $${i++}`;
                p.push(filters.assigned_to_user_id);
            }
            if (filters.overdue) {
                const today = new Date().toISOString().split('T')[0];
                w += ` AND t.due_date < $${i++} AND t.status != 'completed'`;
                p.push(today);
            }
            const countRes = await pool.query(`SELECT COUNT(*)::int AS c ${baseJoin} ${w}`, p);
            const total = countRes.rows[0].c;
            const r = await pool.query(
                `${selCols} ${baseJoin} ${w} ORDER BY t.due_date ASC, t.created_at DESC LIMIT $${i++} OFFSET $${i++}`,
                [...p, pageSize, offset]
            );
            return { tasks: r.rows, total, page, page_size: pageSize };
        }
        const sp = [];
        let w = 'WHERE 1=1';
        if (filters.status) {
            w += ' AND t.status = ?';
            sp.push(filters.status);
        }
        if (filters.assigned_to_user_id) {
            w += ' AND t.assigned_to_user_id = ?';
            sp.push(filters.assigned_to_user_id);
        }
        if (filters.overdue) {
            const today = new Date().toISOString().split('T')[0];
            w += ` AND t.due_date < ? AND t.status != 'completed'`;
            sp.push(today);
        }
        const row = db.prepare(`SELECT COUNT(*) AS c ${baseJoin} ${w}`).get(...sp);
        const rows = db.prepare(
            `${selCols} ${baseJoin} ${w} ORDER BY t.due_date ASC, t.created_at DESC LIMIT ? OFFSET ?`
        ).all(...sp, pageSize, offset);
        return { tasks: rows, total: row.c, page, page_size: pageSize };
    }
    
    static async updateTask(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE tasks SET title = $1, description = $2, assigned_to_user_id = $3, status = $4, due_date = $5
                 WHERE id = $6 RETURNING *`,
                [data.title, data.description, data.assigned_to_user_id, data.status, data.due_date, id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE tasks SET title = ?, description = ?, assigned_to_user_id = ?, status = ?, due_date = ?
                 WHERE id = ?`
            ).run(data.title, data.description, data.assigned_to_user_id, data.status, data.due_date, id);
            return this.getTaskById(id);
        }
    }
    
    static async completeTask(id, userId) {
        const now = new Date().toISOString();
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE tasks SET status = 'completed', completed_at = $1, completed_by_user_id = $2 WHERE id = $3 RETURNING *`,
                [now, userId, id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE tasks SET status = 'completed', completed_at = ?, completed_by_user_id = ? WHERE id = ?`
            ).run(now, userId, id);
            return this.getTaskById(id);
        }
    }
    
    static async deleteTask(id) {
        if (isPostgreSQL) {
            await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
        } else {
            db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
        }
    }
    
    // ============ TASK COMMENTS OPERATIONS ============
    
    static async addTaskComment(taskId, userId, comment) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1, $2, $3) RETURNING *`,
                [taskId, userId, comment]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(`INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, ?, ?)`);
            const info = stmt.run(taskId, userId, comment);
            return this.getTaskCommentById(info.lastInsertRowid);
        }
    }
    
    static async getTaskCommentById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM task_comments WHERE id = $1`, [id]);
            return result.rows[0] || null;
        } else {
            return db.prepare(`SELECT * FROM task_comments WHERE id = ?`).get(id) || null;
        }
    }
    
    static async getTaskComments(taskId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT tc.*, u.username as user_name
                 FROM task_comments tc
                 JOIN production_users u ON tc.user_id = u.id
                 WHERE tc.task_id = $1 ORDER BY tc.created_at ASC`,
                [taskId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT tc.*, u.username as user_name
                 FROM task_comments tc
                 JOIN production_users u ON tc.user_id = u.id
                 WHERE tc.task_id = ? ORDER BY tc.created_at ASC`
            ).all(taskId);
        }
    }
}

// Initialize database on module load
if (isPostgreSQL) {
    initializePostgreSQL().catch(console.error);
} else {
    initializeSQLite();
}

module.exports = { ProductionDatabase, initializeProductionDatabase };

