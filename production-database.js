// Production Database for Stock Control System
// Supports both SQLite and PostgreSQL

const { isPostgreSQL, pool } = require('./database-pg');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
            role TEXT NOT NULL CHECK(role IN ('admin', 'office', 'staff')),
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
            status TEXT DEFAULT 'active',
            cost_gbp REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
            stock_item_id INTEGER NOT NULL,
            check_frequency_days INTEGER NOT NULL,
            last_checked_date TEXT,
            next_check_date TEXT,
            is_active INTEGER DEFAULT 1,
            user_id INTEGER,
            target_role TEXT,
            created_by_user_id INTEGER,
            FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES production_users(id),
            FOREIGN KEY (created_by_user_id) REFERENCES production_users(id)
        )
    `);
    
    // Migrate stock_check_reminders to add user assignment columns
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
    } catch (error) {
        console.log('⚠️ Stock check reminders migration check skipped:', error.message);
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
    } catch (error) {
        console.log('⚠️ Migration check skipped:', error.message);
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
                    role TEXT NOT NULL CHECK(role IN ('admin', 'office', 'staff')),
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
    
    console.log('✅ Production SQLite database initialized');
}

async function initializePostgreSQL() {
    if (!isPostgreSQL) return;
    
    console.log('🗄️ Initializing Production PostgreSQL database...');
    
    try {
        // Production users
        await pool.query(`
            CREATE TABLE IF NOT EXISTS production_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL CHECK(role IN ('admin', 'office', 'staff')),
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
                stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
                check_frequency_days INTEGER NOT NULL,
                last_checked_date DATE,
                next_check_date DATE,
                is_active BOOLEAN DEFAULT TRUE,
                user_id INTEGER REFERENCES production_users(id),
                target_role VARCHAR(20),
                created_by_user_id INTEGER REFERENCES production_users(id)
            )
        `);
        
        // Migrate stock_check_reminders to add user assignment columns
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
            END $$;
        `);
        console.log('✅ Checked/added user assignment columns to stock_check_reminders');
        
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
        
        // Migrate production_users role constraint to include 'office' role
        try {
            // Check if constraint needs updating by trying to find existing constraint
            const constraintCheck = await pool.query(`
                SELECT constraint_name 
                FROM information_schema.table_constraints 
                WHERE table_name = 'production_users' 
                AND constraint_type = 'CHECK'
            `);
            
            if (constraintCheck.rows.length > 0) {
                // Try to drop and recreate constraint
                for (const constraint of constraintCheck.rows) {
                    try {
                        await pool.query(`ALTER TABLE production_users DROP CONSTRAINT IF EXISTS ${constraint.constraint_name}`);
                    } catch (e) {
                        // Constraint might be named differently or already dropped
                        console.log('⚠️ Could not drop constraint:', constraint.constraint_name, e.message);
                    }
                }
            }
            
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
                    CHECK (role IN ('admin', 'office', 'staff'))
                `);
                console.log('✅ Updated production_users role constraint to include office role');
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
            const result = await pool.query(`SELECT id, username, role, created_at FROM production_users ORDER BY created_at DESC`);
            return result.rows;
        } else {
            return db.prepare(`SELECT id, username, role, created_at FROM production_users ORDER BY created_at DESC`).all();
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
                `INSERT INTO panels (name, description, panel_type, status, cost_gbp, built_quantity, min_stock, labour_hours)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [data.name, data.description, data.panel_type, data.status || 'active', initialCost, 
                 data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0]
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
                `INSERT INTO panels (name, description, panel_type, status, cost_gbp, built_quantity, min_stock, labour_hours)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.panel_type, data.status || 'active', initialCost,
                data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0);
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
    
    static async updatePanel(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE panels SET name = $1, description = $2, panel_type = $3, status = $4, 
                 built_quantity = $5, min_stock = $6, labour_hours = $7
                 WHERE id = $8 RETURNING *`,
                [data.name, data.description, data.panel_type, data.status, 
                 data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0, id]
            );
            // Recalculate cost automatically (BOM + labour)
            await this.updatePanelCost(id);
            return await this.getPanelById(id);
        } else {
            db.prepare(
                `UPDATE panels SET name = ?, description = ?, panel_type = ?, status = ?,
                 built_quantity = ?, min_stock = ?, labour_hours = ?
                 WHERE id = ?`
            ).run(data.name, data.description, data.panel_type, data.status,
                data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0, id);
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
    
    // Calculate product cost from components (raw materials + components + built items)
    static async calculateProductCost(productId) {
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
                `INSERT INTO components (name, description, component_type, status, cost_gbp, built_quantity, min_stock, labour_hours)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [data.name, data.description, data.component_type, data.status || 'active', initialCost, 
                 data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0]
            );
            const component = result.rows[0];
            await this.updateComponentCost(component.id);
            return await this.getComponentById(component.id);
        } else {
            const stmt = db.prepare(
                `INSERT INTO components (name, description, component_type, status, cost_gbp, built_quantity, min_stock, labour_hours)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.component_type, data.status || 'active', initialCost,
                data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0);
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
    
    static async updateComponent(id, data) {
        if (isPostgreSQL) {
            await pool.query(
                `UPDATE components SET name = $1, description = $2, component_type = $3, status = $4, 
                 built_quantity = $5, min_stock = $6, labour_hours = $7
                 WHERE id = $8`,
                [data.name, data.description, data.component_type, data.status, 
                 data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0, id]
            );
            await this.updateComponentCost(id);
            return await this.getComponentById(id);
        } else {
            db.prepare(
                `UPDATE components SET name = ?, description = ?, component_type = ?, status = ?,
                 built_quantity = ?, min_stock = ?, labour_hours = ?
                 WHERE id = ?`
            ).run(data.name, data.description, data.component_type, data.status,
                data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0, id);
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
                
                lowStockPanels.push({
                    ...panel,
                    item_type: 'built_item',
                    current_quantity: builtQty,
                    min_stock: minStock,
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
                
                lowStockComponents.push({
                    ...component,
                    item_type: 'component',
                    current_quantity: builtQty,
                    min_stock: minStock,
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
        // Get last week's Monday (7 days ago)
        const today = new Date();
        const dayOfWeek = today.getDay();
        const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const lastMonday = new Date(today);
        lastMonday.setDate(today.getDate() - daysToMonday - 7);
        lastMonday.setHours(0, 0, 0, 0);
        
        const weekStartStr = lastMonday.toISOString().split('T')[0];
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
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO finished_products (name, description, product_type, status, cost_gbp)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [data.name, data.description, data.product_type, data.status || 'active', initialCost]
            );
            const product = result.rows[0];
            // Recalculate cost after creation (will update if components exist)
            await this.updateProductCost(product.id);
            return await this.getProductById(product.id);
        } else {
            const stmt = db.prepare(
                `INSERT INTO finished_products (name, description, product_type, status, cost_gbp)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.product_type, data.status || 'active', initialCost);
            const product = await this.getProductById(info.lastInsertRowid);
            // Recalculate cost after creation
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
        if (isPostgreSQL) {
            const result = await pool.query(`SELECT * FROM finished_products ORDER BY name`);
            return result.rows;
        } else {
            return db.prepare(`SELECT * FROM finished_products ORDER BY name`).all();
        }
    }
    
    static async updateProduct(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE finished_products SET name = $1, description = $2, product_type = $3, status = $4
                 WHERE id = $5 RETURNING *`,
                [data.name, data.description, data.product_type, data.status, id]
            );
            // Recalculate cost automatically from components
            await this.updateProductCost(id);
            return await this.getProductById(id);
        } else {
            db.prepare(
                `UPDATE finished_products SET name = ?, description = ?, product_type = ?, status = ?
                 WHERE id = ?`
            ).run(data.name, data.description, data.product_type, data.status, id);
            // Recalculate cost automatically
            await this.updateProductCost(id);
            return this.getProductById(id);
        }
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
    
    // ============ PRODUCT ORDERS OPERATIONS ============
    
    static async createProductOrder(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO product_orders (product_id, quantity, order_date, status, created_by)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [data.product_id, data.quantity, data.order_date, data.status || 'pending', data.created_by]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO product_orders (product_id, quantity, order_date, status, created_by)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.product_id, data.quantity, data.order_date, data.status || 'pending', data.created_by);
            return this.getProductOrderById(info.lastInsertRowid);
        }
    }
    
    static async getProductOrderById(id) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 WHERE po.id = $1`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            return db.prepare(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 WHERE po.id = ?`
            ).get(id) || null;
        }
    }
    
    static async getAllProductOrders() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 ORDER BY po.created_at DESC`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT po.*, fp.name as product_name, u.username as created_by_name
                 FROM product_orders po
                 LEFT JOIN finished_products fp ON po.product_id = fp.id
                 LEFT JOIN production_users u ON po.created_by = u.id
                 ORDER BY po.created_at DESC`
            ).all();
        }
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
        if (isPostgreSQL) {
            const result = await pool.query(
                `DELETE FROM product_orders WHERE id = $1 RETURNING *`,
                [id]
            );
            return result.rows[0] || null;
        } else {
            const order = this.getProductOrderById(id);
            db.prepare(`DELETE FROM product_orders WHERE id = ?`).run(id);
            return order;
        }
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
    
    static async clockIn(userId, jobId, latitude, longitude) {
        const clockInTime = new Date().toISOString();
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO timesheet_entries (user_id, job_id, clock_in_time, clock_in_latitude, clock_in_longitude)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [userId, jobId, clockInTime, latitude, longitude]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO timesheet_entries (user_id, job_id, clock_in_time, clock_in_latitude, clock_in_longitude)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(userId, jobId, clockInTime, latitude, longitude);
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
                const clockInDate = new Date(entry.clock_in_time);
                // Set to end of the clock-in date (23:59:59.999)
                const midnight = new Date(clockInDate);
                midnight.setHours(23, 59, 59, 999);
                const clockOutTime = midnight.toISOString();
                
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
                    const clockInDateStr = clockInDate.toISOString().split('T')[0];
                    
                    // Find Monday of that week
                    const dayOfWeek = clockInDate.getDay();
                    const monday = new Date(clockInDate);
                    monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                    monday.setHours(0, 0, 0, 0);
                    const weekStartDate = monday.toISOString().split('T')[0];
                    
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
                    
                    // Update daily entry with aggregated hours
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
            
            return updatedEntries;
        } else {
            // SQLite version
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE clock_out_time IS NULL
                AND DATE(clock_in_time) < DATE('now')
                ${userId ? 'AND user_id = ?' : ''}
            `).all(userId ? [userId] : []);
            
            const updatedEntries = [];
            
            for (const entry of entries) {
                const clockInDate = new Date(entry.clock_in_time);
                const midnight = new Date(clockInDate);
                midnight.setHours(23, 59, 59, 999);
                const clockOutTime = midnight.toISOString();
                
                db.prepare(`
                    UPDATE timesheet_entries 
                    SET clock_out_time = ?, updated_at = ?
                    WHERE id = ?
                `).run(clockOutTime, clockOutTime, entry.id);
                
                // Recalculate hours (similar to PostgreSQL version)
                try {
                    const clockInDateStr = clockInDate.toISOString().split('T')[0];
                    const dayOfWeek = clockInDate.getDay();
                    const monday = new Date(clockInDate);
                    monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                    monday.setHours(0, 0, 0, 0);
                    const weekStartDate = monday.toISOString().split('T')[0];
                    
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
            // Find ALL entries that don't have a clock_out_time (regardless of date)
            const entriesToUpdate = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE clock_out_time IS NULL
                 ORDER BY clock_in_time ASC`
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
                        const clockInDate = new Date(entry.clock_in_time);
                        // Set to end of the clock-in date (23:59:59.999)
                        const midnight = new Date(clockInDate);
                        midnight.setHours(23, 59, 59, 999);
                        const clockOutTime = midnight.toISOString();
                        
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
            // SQLite version
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE clock_out_time IS NULL
                ORDER BY clock_in_time ASC
            `).all();
            
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
                    const clockInDate = new Date(entry.clock_in_time);
                    const midnight = new Date(clockInDate);
                    midnight.setHours(23, 59, 59, 999);
                    const clockOutTime = midnight.toISOString();
                    
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
                 AND DATE(clock_in_time) <= $2::date
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
                    const clockInDateStr = clockInDate.toISOString().split('T')[0];
                    
                    // Set clock-out to end of the clock-in date (23:59:59.999)
                    const midnight = new Date(clockInDate);
                    midnight.setHours(23, 59, 59, 999);
                    const clockOutTime = midnight.toISOString();
                    
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
                            const dayOfWeek = clockInDate.getDay();
                            const monday = new Date(clockInDate);
                            monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                            monday.setHours(0, 0, 0, 0);
                            const weekStartDate = monday.toISOString().split('T')[0];
                            
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
            // SQLite version
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE user_id = ?
                AND clock_out_time IS NULL
                AND DATE(clock_in_time) <= DATE(?)
            `).all(userId, targetDateStr);
            
            const updatedEntries = [];
            for (const entry of entries) {
                const clockInDate = new Date(entry.clock_in_time);
                const clockInDateStr = clockInDate.toISOString().split('T')[0];
                const midnight = new Date(clockInDate);
                midnight.setHours(23, 59, 59, 999);
                const clockOutTime = midnight.toISOString();
                
                db.prepare(`
                    UPDATE timesheet_entries 
                    SET clock_out_time = ?, updated_at = ?
                    WHERE id = ?
                `).run(clockOutTime, clockOutTime, entry.id);
                
                // Recalculate hours
                try {
                    const dayOfWeek = clockInDate.getDay();
                    const monday = new Date(clockInDate);
                    monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                    monday.setHours(0, 0, 0, 0);
                    const weekStartDate = monday.toISOString().split('T')[0];
                    
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
            // Find entries that:
            // 1. Don't have a clock_out_time
            // 2. Are for this user
            // 3. Started before today (clock_in_time is before today's date)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayStr = today.toISOString().split('T')[0];
            
            const entries = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE user_id = $1
                 AND clock_out_time IS NULL
                 AND DATE(clock_in_time) < $2::date
                 ORDER BY clock_in_time DESC`,
                [userId, todayStr]
            );
            
            if (entries.rows.length === 0) {
                return [];
            }
            
            const updatedEntries = [];
            for (const entry of entries.rows) {
                try {
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = clockInDate.toISOString().split('T')[0];
                    
                    // Set clock-out to end of the clock-in date (23:59:59.999)
                    const midnight = new Date(clockInDate);
                    midnight.setHours(23, 59, 59, 999);
                    const clockOutTime = midnight.toISOString();
                    
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
                            const dayOfWeek = clockInDate.getDay();
                            const monday = new Date(clockInDate);
                            monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                            monday.setHours(0, 0, 0, 0);
                            const weekStartDate = monday.toISOString().split('T')[0];
                            
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
            // SQLite version
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayStr = today.toISOString().split('T')[0];
            
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE user_id = ?
                AND clock_out_time IS NULL
                AND DATE(clock_in_time) < DATE(?)
                ORDER BY clock_in_time DESC
            `).all(userId, todayStr);
            
            if (entries.length === 0) {
                return [];
            }
            
            const updatedEntries = [];
            for (const entry of entries) {
                try {
                    const clockInDate = new Date(entry.clock_in_time);
                    const clockInDateStr = clockInDate.toISOString().split('T')[0];
                    const midnight = new Date(clockInDate);
                    midnight.setHours(23, 59, 59, 999);
                    const clockOutTime = midnight.toISOString();
                    
                    db.prepare(`
                        UPDATE timesheet_entries 
                        SET clock_out_time = ?, updated_at = ?
                        WHERE id = ?
                    `).run(clockOutTime, clockOutTime, entry.id);
                    
                    // Recalculate hours
                    try {
                        const dayOfWeek = clockInDate.getDay();
                        const monday = new Date(clockInDate);
                        monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                        monday.setHours(0, 0, 0, 0);
                        const weekStartDate = monday.toISOString().split('T')[0];
                        
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
            // Find all entries that don't have a clock_out_time and started before today
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayStr = today.toISOString().split('T')[0];
            
            const entries = await pool.query(
                `SELECT * FROM timesheet_entries
                 WHERE clock_out_time IS NULL
                 AND DATE(clock_in_time) < $1::date
                 ORDER BY clock_in_time ASC`,
                [todayStr]
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
                    const clockInDateStr = clockInDate.toISOString().split('T')[0];
                    
                    // Set clock-out to end of the clock-in date (23:59:59.999)
                    const midnight = new Date(clockInDate);
                    midnight.setHours(23, 59, 59, 999);
                    const clockOutTime = midnight.toISOString();
                    
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
                            const dayOfWeek = clockInDate.getDay();
                            const monday = new Date(clockInDate);
                            monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                            monday.setHours(0, 0, 0, 0);
                            const weekStartDate = monday.toISOString().split('T')[0];
                            
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
            // SQLite version
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayStr = today.toISOString().split('T')[0];
            
            const entries = db.prepare(`
                SELECT * FROM timesheet_entries
                WHERE clock_out_time IS NULL
                AND DATE(clock_in_time) < DATE(?)
                ORDER BY clock_in_time ASC
            `).all(todayStr);
            
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
                    const clockInDateStr = clockInDate.toISOString().split('T')[0];
                    const midnight = new Date(clockInDate);
                    midnight.setHours(23, 59, 59, 999);
                    const clockOutTime = midnight.toISOString();
                    
                    db.prepare(`
                        UPDATE timesheet_entries 
                        SET clock_out_time = ?, updated_at = ?
                        WHERE id = ?
                    `).run(clockOutTime, clockOutTime, entry.id);
                    
                    // Recalculate hours
                    try {
                        const dayOfWeek = clockInDate.getDay();
                        const monday = new Date(clockInDate);
                        monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                        monday.setHours(0, 0, 0, 0);
                        const weekStartDate = monday.toISOString().split('T')[0];
                        
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
            const clockInDateStr = clockInDate.toISOString().split('T')[0];
            
            // Find Monday of that week
            const dayOfWeek = clockInDate.getDay();
            const diff = clockInDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust when day is Sunday
            const monday = new Date(clockInDate);
            monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
            monday.setHours(0, 0, 0, 0);
            const weekStartDate = monday.toISOString().split('T')[0];
            
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
            
            // Update daily entry with aggregated hours from all entries
            await this.updateDailyEntry(dailyEntry.id, {
                timesheet_entry_id: updatedEntry.id, // Keep reference to most recent entry
                regular_hours: aggregatedHours.regular_hours,
                overtime_hours: aggregatedHours.overtime_hours,
                weekend_hours: aggregatedHours.weekend_hours,
                overnight_hours: aggregatedHours.overnight_hours,
                total_hours: aggregatedHours.total_hours
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
                const clockInDateStr = clockInDate.toISOString().split('T')[0];
                
                // Find the weekly timesheet for this date
                const dayOfWeek = clockInDate.getDay();
                const diff = clockInDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
                const monday = new Date(clockInDate);
                monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                monday.setHours(0, 0, 0, 0);
                const weekStartDate = monday.toISOString().split('T')[0];
                
                const weeklyTimesheet = await this.getWeeklyTimesheet(entry.user_id, weekStartDate);
                if (weeklyTimesheet) {
                    const dailyEntry = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
                    if (dailyEntry) {
                        // Recalculate hours for remaining entries on this day
                        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, dailyEntry.overnight_away);
                        await this.updateDailyEntry(dailyEntry.id, {
                            regular_hours: aggregatedHours.regular_hours,
                            overtime_hours: aggregatedHours.overtime_hours,
                            weekend_hours: aggregatedHours.weekend_hours,
                            overnight_hours: aggregatedHours.overnight_hours,
                            total_hours: aggregatedHours.total_hours
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
                const clockInDateStr = clockInDate.toISOString().split('T')[0];
                
                // Find the weekly timesheet for this date
                const dayOfWeek = clockInDate.getDay();
                const diff = clockInDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
                const monday = new Date(clockInDate);
                monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                monday.setHours(0, 0, 0, 0);
                const weekStartDate = monday.toISOString().split('T')[0];
                
                const weeklyTimesheet = await this.getWeeklyTimesheet(entry.user_id, weekStartDate);
                if (weeklyTimesheet) {
                    const dailyEntry = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
                    if (dailyEntry) {
                        // Recalculate hours for remaining entries on this day
                        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, dailyEntry.overnight_away);
                        await this.updateDailyEntry(dailyEntry.id, {
                            regular_hours: aggregatedHours.regular_hours,
                            overtime_hours: aggregatedHours.overtime_hours,
                            weekend_hours: aggregatedHours.weekend_hours,
                            overnight_hours: aggregatedHours.overnight_hours,
                            total_hours: aggregatedHours.total_hours
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
                 AND DATE(te.clock_in_time) >= $2 
                 AND DATE(te.clock_in_time) <= $3
                 ORDER BY te.clock_in_time DESC`,
                [userId, startDate, endDate]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT te.*, j.name as job_name 
                 FROM timesheet_entries te
                 LEFT JOIN jobs j ON te.job_id = j.id
                 WHERE te.user_id = ? 
                 AND DATE(te.clock_in_time) >= ? 
                 AND DATE(te.clock_in_time) <= ?
                 ORDER BY te.clock_in_time DESC`
            ).all(userId, startDate, endDate);
        }
    }
    
    // Count completed timesheet entries for a specific date
    static async countEntriesForDate(userId, dateStr) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT COUNT(*) as count
                 FROM timesheet_entries
                 WHERE user_id = $1 
                 AND DATE(clock_in_time) = $2
                 AND clock_out_time IS NOT NULL`,
                [userId, dateStr]
            );
            return parseInt(result.rows[0].count) || 0;
        } else {
            const result = db.prepare(
                `SELECT COUNT(*) as count
                 FROM timesheet_entries
                 WHERE user_id = ? 
                 AND DATE(clock_in_time) = ?
                 AND clock_out_time IS NOT NULL`
            ).get(userId, dateStr);
            return parseInt(result.count) || 0;
        }
    }
    
    // Helper function to detect if an entry was auto-clocked-out
    static isAutoClockedOutEntry(entry) {
        if (!entry || !entry.clock_out_time) return false;
        
        const clockIn = new Date(entry.clock_in_time);
        const clockOut = new Date(entry.clock_out_time);
        
        // Check if clock-out is at end of clock-in day (23:59:59.999)
        const clockInDayEnd = new Date(clockIn);
        clockInDayEnd.setHours(23, 59, 59, 999);
        
        // Check if clock-out is at midnight of next day (00:00:00)
        const nextDay = new Date(clockIn);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        
        // Allow small margin for timestamp precision (within 1 second)
        const endOfDayDiff = Math.abs(clockOut.getTime() - clockInDayEnd.getTime());
        const midnightDiff = Math.abs(clockOut.getTime() - nextDay.getTime());
        
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
        const dateStr = entryDate instanceof Date ? entryDate.toISOString().split('T')[0] : entryDate;
        
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
                   AND DATE(clock_in_time) = $2::date
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
            const result = db.prepare(
                `SELECT 
                    SUM(regular_hours) as total_regular,
                    SUM(overtime_hours) as total_overtime,
                    SUM(weekend_hours) as total_weekend,
                    SUM(overnight_hours) as total_overnight,
                    SUM(total_hours) as total_hours
                 FROM timesheet_entries
                 WHERE user_id = ? 
                   AND DATE(clock_in_time) = ?
                   AND clock_out_time IS NOT NULL`
            ).get(userId, dateStr);
            
            return {
                regular_hours: parseFloat(result?.total_regular || 0),
                overtime_hours: parseFloat(result?.total_overtime || 0),
                weekend_hours: parseFloat(result?.total_weekend || 0),
                overnight_hours: parseFloat(result?.total_overnight || 0),
                total_hours: parseFloat(result?.total_hours || 0)
            };
        }
    }
    
    static async calculateTimesheetHours(entryId, overnightAway = false) {
        const entry = await this.getTimesheetEntryById(entryId);
        if (!entry || !entry.clock_out_time) {
            return null;
        }
        
        const clockIn = new Date(entry.clock_in_time);
        const clockOut = new Date(entry.clock_out_time);
        const totalHours = (clockOut - clockIn) / (1000 * 60 * 60); // Convert to hours
        
        const clockInDate = new Date(clockIn);
        const dayOfWeek = clockInDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday
        
        let regularHours = 0;
        let overtimeHours = 0;
        let weekendHours = 0;
        let overnightHours = 0;
        let calculatedTotal = 0;
        
        if (overnightAway) {
            // All hours are overnight (1.25x)
            overnightHours = totalHours;
            calculatedTotal = totalHours;
        } else if (isWeekend) {
            // All hours are weekend (1.5x)
            weekendHours = totalHours;
            calculatedTotal = totalHours;
        } else {
            // Monday-Friday: subtract 1 hour break, then calculate
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
            // weekStartDate should be a Monday date in YYYY-MM-DD format
            const weekStart = new Date(weekStartDate);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 6); // Sunday
            
            const weekStartStr = weekStart.toISOString().split('T')[0];
            const weekEndStr = weekEnd.toISOString().split('T')[0];
            
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
    
    // Amendment operations
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
        const clockInDateStr = clockInDate.toISOString().split('T')[0];
        
        // Find Monday of that week
        const dayOfWeek = clockInDate.getDay();
        const diff = clockInDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const monday = new Date(clockInDate);
        monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
        monday.setHours(0, 0, 0, 0);
        const weekStartDate = monday.toISOString().split('T')[0];
        
        // Get or create weekly timesheet
        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
        
        // Get or create daily entry
        let dailyEntryRecord = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        if (!dailyEntryRecord) {
            dailyEntryRecord = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, amendment.timesheet_entry_id);
        }
        
        // Aggregate hours from ALL entries for this day
        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
        
        // Update daily entry with aggregated hours from all entries
        await this.updateDailyEntry(dailyEntryRecord.id, {
            timesheet_entry_id: amendment.timesheet_entry_id,
            regular_hours: aggregatedHours.regular_hours,
            overtime_hours: aggregatedHours.overtime_hours,
            weekend_hours: aggregatedHours.weekend_hours,
            overnight_hours: aggregatedHours.overnight_hours,
            total_hours: aggregatedHours.total_hours
        });
        
        return amendment;
    }
    
    // Admin-only: Directly amend timesheet entry (applies immediately, no approval needed)
    static async adminAmendTimesheetEntry(entryId, adminId, amendedClockIn, amendedClockOut, reason) {
        const entry = await this.getTimesheetEntryById(entryId);
        if (!entry) {
            throw new Error('Timesheet entry not found');
        }
        
        console.log(`Admin amending timesheet entry ${entryId}:`, {
            original: { clock_in: entry.clock_in_time, clock_out: entry.clock_out_time },
            amended: { clock_in: amendedClockIn, clock_out: amendedClockOut },
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
        
        // Recalculate hours for this entry
        const dailyEntry = await this.getDailyEntryByTimesheetEntryId(entryId);
        const overnightAway = dailyEntry ? dailyEntry.overnight_away : false;
        await this.calculateTimesheetHours(entryId, overnightAway);
        
        // Get clock-in date to determine which week
        const clockInDate = new Date(amendedClockIn);
        const clockInDateStr = clockInDate.toISOString().split('T')[0];
        
        // Find Monday of that week
        const dayOfWeek = clockInDate.getDay();
        const monday = new Date(clockInDate);
        monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
        monday.setHours(0, 0, 0, 0);
        const weekStartDate = monday.toISOString().split('T')[0];
        
        // Get or create weekly timesheet
        const weeklyTimesheet = await this.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
        
        // Get or create daily entry
        let dailyEntryRecord = await this.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
        if (!dailyEntryRecord) {
            dailyEntryRecord = await this.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, entryId);
        }
        
        // Aggregate hours from ALL entries for this day
        const aggregatedHours = await this.aggregateDailyHours(entry.user_id, clockInDateStr, overnightAway);
        
        // Update daily entry with aggregated hours from all entries
        await this.updateDailyEntry(dailyEntryRecord.id, {
            timesheet_entry_id: entryId,
            regular_hours: aggregatedHours.regular_hours,
            overtime_hours: aggregatedHours.overtime_hours,
            weekend_hours: aggregatedHours.weekend_hours,
            overnight_hours: aggregatedHours.overnight_hours,
            total_hours: aggregatedHours.total_hours
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
                   AND tde.total_hours > 0
                 GROUP BY u.id, u.username, wt.week_start_date, wt.manager_approved, wt.approved_by, wt.approved_at, approver.username
                 ORDER BY u.username`
            ).all(weekStartDate);
            
            return result;
        }
    }
    
    // Get daily payroll breakdown for a specific user
    static async getPayrollDailyBreakdown(userId, weekStartDate) {
        // Calculate week end date
        const weekStart = new Date(weekStartDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const weekEndStr = weekEnd.toISOString().split('T')[0];
        
        if (isPostgreSQL) {
            // Get all timesheet entries for the week, grouped by date
            const entriesResult = await pool.query(
                `SELECT 
                    te.id,
                    DATE(te.clock_in_time) as entry_date,
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
                 LEFT JOIN timesheet_daily_entries tde ON tde.weekly_timesheet_id = wt.id AND DATE(te.clock_in_time) = tde.entry_date
                 WHERE te.user_id = $1 
                   AND te.clock_out_time IS NOT NULL
                   AND DATE(te.clock_in_time) >= $2::date
                   AND DATE(te.clock_in_time) <= $3::date
                 ORDER BY DATE(te.clock_in_time), te.clock_in_time`,
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
                    `SELECT entry_date, daily_notes, day_type 
                     FROM timesheet_daily_entries 
                     WHERE weekly_timesheet_id = $1 
                     AND entry_date >= $2::date 
                     AND entry_date <= $3::date`,
                    [weeklyTimesheet.rows[0].id, weekStartDate, weekEndStr]
                );
                
                dailyDataResult.rows.forEach(row => {
                    dailyDataMap[row.entry_date] = {
                        daily_notes: row.daily_notes,
                        day_type: row.day_type
                    };
                });
            }
            
            // Merge daily notes and day_type into entries
            const entries = entriesResult.rows.map(entry => {
                const entryDate = entry.entry_date;
                const dailyData = dailyDataMap[entryDate] || {};
                return {
                    ...entry,
                    daily_notes: dailyData.daily_notes || entry.daily_notes || null,
                    day_type: entry.day_type || dailyData.day_type || null
                };
            });
            
            // Return all entries (no deduplication needed - we want all entries per day)
            return entries.sort((a, b) => {
                const dateCompare = new Date(a.entry_date) - new Date(b.entry_date);
                if (dateCompare !== 0) return dateCompare;
                return new Date(a.clock_in_time) - new Date(b.clock_in_time);
            });
        } else {
            // Get all timesheet entries for the week, grouped by date
            const entriesResult = db.prepare(
                `SELECT 
                    te.id,
                    DATE(te.clock_in_time) as entry_date,
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
                 LEFT JOIN weekly_timesheets wt ON wt.user_id = te.user_id AND wt.week_start_date = ?
                 LEFT JOIN timesheet_daily_entries tde ON tde.weekly_timesheet_id = wt.id AND DATE(te.clock_in_time) = tde.entry_date
                 WHERE te.user_id = ? 
                   AND te.clock_out_time IS NOT NULL
                   AND DATE(te.clock_in_time) >= ?
                   AND DATE(te.clock_in_time) <= ?
                 ORDER BY DATE(te.clock_in_time), te.clock_in_time`
            ).all(weekStartDate, userId, weekStartDate, weekEndStr);
            
            // Get daily notes and day_type for the week
            const weeklyTimesheet = db.prepare(
                `SELECT id FROM weekly_timesheets 
                 WHERE user_id = ? 
                 AND week_start_date = ?`
            ).get(userId, weekStartDate);
            
            let dailyDataMap = {};
            if (weeklyTimesheet) {
                const dailyDataResult = db.prepare(
                    `SELECT entry_date, daily_notes, day_type 
                     FROM timesheet_daily_entries 
                     WHERE weekly_timesheet_id = ? 
                     AND entry_date >= ? 
                     AND entry_date <= ?`
                ).all(weeklyTimesheet.id, weekStartDate, weekEndStr);
                
                dailyDataResult.forEach(row => {
                    dailyDataMap[row.entry_date] = {
                        daily_notes: row.daily_notes,
                        day_type: row.day_type
                    };
                });
            }
            
            // Merge daily notes and day_type into entries
            const entries = entriesResult.map(entry => {
                const entryDate = entry.entry_date;
                const dailyData = dailyDataMap[entryDate] || {};
                return {
                    ...entry,
                    daily_notes: dailyData.daily_notes || entry.daily_notes || null,
                    day_type: entry.day_type || dailyData.day_type || null
                };
            });
            
            // Return all entries (no deduplication needed - we want all entries per day)
            return entries.sort((a, b) => {
                const dateCompare = new Date(a.entry_date) - new Date(b.entry_date);
                if (dateCompare !== 0) return dateCompare;
                return new Date(a.clock_in_time) - new Date(b.clock_in_time);
            });
        }
    }
    
    // ============ MATERIAL REQUIREMENTS CALCULATION ============
    
    static async calculateMaterialRequirements(orders) {
        // orders: array of {product_id, quantity}
        const panelsRequired = {};
        const rawMaterialsRequired = {};
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
                
                if (comp.component_type === 'panel') {
                    const panelId = comp.component_id;
                    if (!panelsRequired[panelId]) {
                        panelsRequired[panelId] = 0;
                    }
                    panelsRequired[panelId] += totalQty;
                    
                    productBreakdown.panels.push({
                        panel_id: panelId,
                        panel_name: comp.component_name,
                        quantity: totalQty
                    });
                    
                    // Get BOM for this panel
                    const bomItems = await this.getPanelBOM(panelId);
                    for (const bomItem of bomItems) {
                        const stockItemId = bomItem.stock_item_id;
                        const materialQty = parseFloat(bomItem.quantity_required) * totalQty;
                        
                        if (!rawMaterialsRequired[stockItemId]) {
                            rawMaterialsRequired[stockItemId] = {
                                stock_item_id: stockItemId,
                                name: bomItem.stock_item_name,
                                unit: bomItem.unit,
                                total_quantity: 0
                            };
                        }
                        rawMaterialsRequired[stockItemId].total_quantity += materialQty;
                    }
                } else if (comp.component_type === 'raw_material') {
                    const stockItemId = comp.component_id;
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
        
        // Convert panelsRequired to array
        const panelsArray = [];
        for (const [panelId, totalQty] of Object.entries(panelsRequired)) {
            const panel = await this.getPanelById(panelId);
            panelsArray.push({
                panel_id: parseInt(panelId),
                panel_name: panel ? panel.name : 'Unknown',
                total_quantity: totalQty
            });
        }
        
        // Get stock availability and calculate costs
        const materialsArray = [];
        let totalCost = 0;
        for (const [stockItemId, data] of Object.entries(rawMaterialsRequired)) {
            const stockItem = await this.getStockItemById(stockItemId);
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
            raw_materials_required: materialsArray,
            breakdown: breakdown,
            total_cost_gbp: totalCost
        };
    }
    
    // ============ STOCK CHECK REMINDERS OPERATIONS ============
    
    static async createReminder(data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO stock_check_reminders (stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active, user_id, target_role, created_by_user_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [
                    data.stock_item_id, 
                    data.check_frequency_days, 
                    data.last_checked_date, 
                    data.next_check_date, 
                    data.is_active !== false,
                    data.user_id || null,
                    data.target_role || null,
                    data.created_by_user_id || null
                ]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO stock_check_reminders (stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active, user_id, target_role, created_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(
                data.stock_item_id, 
                data.check_frequency_days, 
                data.last_checked_date, 
                data.next_check_date, 
                data.is_active !== false ? 1 : 0,
                data.user_id || null,
                data.target_role || null,
                data.created_by_user_id || null
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
                 JOIN stock_items si ON r.stock_item_id = si.id
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
                           JOIN stock_items si ON r.stock_item_id = si.id
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
    
    static async getOverdueReminders(userId = null, userRole = null) {
        const today = new Date().toISOString().split('T')[0];
        
        // Build WHERE clause based on user permissions
        let whereClause = isPostgreSQL ? 'r.is_active = TRUE' : 'r.is_active = 1';
        const params = [today];
        let paramIndex = 2;
        
        if (userId && userRole) {
            if (userRole === 'admin') {
                // Admins see all overdue reminders they created OR all global reminders
                whereClause += ` AND (r.created_by_user_id = $${paramIndex} OR (r.user_id IS NULL AND r.target_role IS NULL))`;
                params.push(userId);
                paramIndex++;
            } else {
                // Regular users see: their own reminders, role-based reminders, or reminders they created
                whereClause += ` AND (r.user_id = $${paramIndex} OR r.target_role = $${paramIndex + 1} OR r.created_by_user_id = $${paramIndex})`;
                params.push(userId, userRole, userId);
                paramIndex += 3;
            }
        }
        
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT r.*, si.name as stock_item_name,
                        u.username as assigned_user_name,
                        creator.username as created_by_username
                 FROM stock_check_reminders r
                 JOIN stock_items si ON r.stock_item_id = si.id
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
                           JOIN stock_items si ON r.stock_item_id = si.id
                           LEFT JOIN production_users u ON r.user_id = u.id
                           LEFT JOIN production_users creator ON r.created_by_user_id = creator.id
                           WHERE ${whereClause} AND r.next_check_date < ?
                           ORDER BY r.next_check_date ASC`;
            return db.prepare(query).all(...params);
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

