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
            role TEXT NOT NULL CHECK(role IN ('admin', 'manager')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Stock items table
    db.exec(`
        CREATE TABLE IF NOT EXISTS stock_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
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
    
    // BOM items table
    db.exec(`
        CREATE TABLE IF NOT EXISTS bom_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            panel_id INTEGER NOT NULL,
            stock_item_id INTEGER NOT NULL,
            quantity_required REAL NOT NULL,
            unit TEXT NOT NULL,
            FOREIGN KEY (panel_id) REFERENCES panels(id) ON DELETE CASCADE,
            FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE
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
            component_type TEXT NOT NULL CHECK(component_type IN ('panel', 'raw_material')),
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
            FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE
        )
    `);
    
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
    
    // Create indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bom_panel ON bom_items(panel_id);
        CREATE INDEX IF NOT EXISTS idx_bom_stock ON bom_items(stock_item_id);
        CREATE INDEX IF NOT EXISTS idx_product_components_product ON product_components(product_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_user ON stock_movements(user_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to_user_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_panel_movements_panel ON panel_movements(panel_id);
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
    
    // Insert default labour rate if not exists
    const settingCheck = db.prepare('SELECT COUNT(*) as count FROM production_settings WHERE key = ?').get('labour_rate_per_hour');
    if (settingCheck.count === 0) {
        db.prepare('INSERT INTO production_settings (key, value) VALUES (?, ?)').run('labour_rate_per_hour', '25.00');
    }
    
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
                role VARCHAR(20) NOT NULL CHECK(role IN ('admin', 'manager')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Stock items
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
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
        
        // BOM items
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bom_items (
                id SERIAL PRIMARY KEY,
                panel_id INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
                stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
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
                component_type VARCHAR(20) NOT NULL CHECK(component_type IN ('panel', 'raw_material')),
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
                is_active BOOLEAN DEFAULT TRUE
            )
        `);
        
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
        
        // Create indexes
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_bom_panel ON bom_items(panel_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_bom_stock ON bom_items(stock_item_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_components_product ON product_components(product_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_user ON stock_movements(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to_user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_panel_movements_panel ON panel_movements(panel_id)`);
        
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
        
        // Insert default labour rate if not exists
        const settingCheck = await pool.query(`SELECT COUNT(*) as count FROM production_settings WHERE key = 'labour_rate_per_hour'`);
        if (parseInt(settingCheck.rows[0].count) === 0) {
            await pool.query(`INSERT INTO production_settings (key, value) VALUES ('labour_rate_per_hour', '25.00')`);
        }
        
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
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO stock_items (name, description, unit, current_quantity, min_quantity, location, cost_per_unit_gbp)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [data.name, data.description, data.unit, data.current_quantity || 0, data.min_quantity || 0, data.location, data.cost_per_unit_gbp || 0]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO stock_items (name, description, unit, current_quantity, min_quantity, location, cost_per_unit_gbp)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.unit, data.current_quantity || 0, data.min_quantity || 0, data.location, data.cost_per_unit_gbp || 0);
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
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE stock_items SET name = $1, description = $2, unit = $3, min_quantity = $4, location = $5, cost_per_unit_gbp = $6
                 WHERE id = $7 RETURNING *`,
                [data.name, data.description, data.unit, data.min_quantity, data.location, data.cost_per_unit_gbp, id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE stock_items SET name = ?, description = ?, unit = ?, min_quantity = ?, location = ?, cost_per_unit_gbp = ?
                 WHERE id = ?`
            ).run(data.name, data.description, data.unit, data.min_quantity, data.location, data.cost_per_unit_gbp, id);
            return this.getStockItemById(id);
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
            // Recalculate cost after creation (will update if BOM exists)
            await this.updatePanelCost(panel.id);
            return await this.getPanelById(panel.id);
        } else {
            const stmt = db.prepare(
                `INSERT INTO panels (name, description, panel_type, status, cost_gbp, built_quantity, min_stock, labour_hours)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.name, data.description, data.panel_type, data.status || 'active', initialCost,
                data.built_quantity || 0, data.min_stock || 0, data.labour_hours || 0);
            const panel = await this.getPanelById(info.lastInsertRowid);
            // Recalculate cost after creation
            await this.updatePanelCost(panel.id);
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
    
    // ============ BOM OPERATIONS ============
    
    static async addBOMItem(panelId, stockItemId, quantityRequired, unit) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `INSERT INTO bom_items (panel_id, stock_item_id, quantity_required, unit)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [panelId, stockItemId, quantityRequired, unit]
            );
            // Recalculate panel cost after BOM change
            await this.updatePanelCost(panelId);
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO bom_items (panel_id, stock_item_id, quantity_required, unit)
                 VALUES (?, ?, ?, ?)`
            );
            const info = stmt.run(panelId, stockItemId, quantityRequired, unit);
            // Recalculate panel cost after BOM change
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
    
    static async getPanelBOM(panelId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT bi.*, si.name as stock_item_name, si.unit as stock_item_unit
                 FROM bom_items bi
                 JOIN stock_items si ON bi.stock_item_id = si.id
                 WHERE bi.panel_id = $1 ORDER BY si.name`,
                [panelId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT bi.*, si.name as stock_item_name, si.unit as stock_item_unit
                 FROM bom_items bi
                 JOIN stock_items si ON bi.stock_item_id = si.id
                 WHERE bi.panel_id = ? ORDER BY si.name`
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
    
    // Calculate BOM value for a panel
    static async calculateBOMValue(panelId) {
        const bomItems = await this.getPanelBOM(panelId);
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
    
    // Calculate product cost from components (panels + raw materials)
    static async calculateProductCost(productId) {
        const components = await this.getProductComponents(productId);
        let totalCost = 0;
        
        for (const comp of components) {
            const compQty = parseFloat(comp.quantity_required || 0);
            
            if (comp.component_type === 'panel') {
                // Get panel's true cost (BOM + labour)
                const panelCost = await this.calculatePanelTrueCost(comp.component_id);
                totalCost += panelCost * compQty;
            } else if (comp.component_type === 'raw_material') {
                // Get raw material cost
                const stockItem = await this.getStockItemById(comp.component_id);
                if (stockItem) {
                    const materialCost = parseFloat(stockItem.cost_per_unit_gbp || 0) * compQty;
                    totalCost += materialCost;
                }
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
        await this.recalculateProductsUsingPanel(panelId);
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
    
    // Recalculate all products that use a specific panel (called when panel cost changes)
    static async recalculateProductsUsingPanel(panelId) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT DISTINCT product_id FROM product_components 
                 WHERE component_type = 'panel' AND component_id = $1`,
                [panelId]
            );
            for (const row of result.rows) {
                await this.updateProductCost(row.product_id);
            }
        } else {
            const products = db.prepare(
                `SELECT DISTINCT product_id FROM product_components 
                 WHERE component_type = 'panel' AND component_id = ?`
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
    
    // Record panel movement
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
            } else if (data.movement_type === 'use') {
                newQuantity -= parseFloat(data.quantity);
            } else if (data.movement_type === 'adjustment') {
                newQuantity = parseFloat(data.quantity);
            }
            this.updatePanelQuantity(data.panel_id, newQuantity);
            return db.prepare(`SELECT * FROM panel_movements WHERE id = (SELECT MAX(id) FROM panel_movements)`).get();
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
                     WHEN pc.component_type = 'panel' THEN p.name
                     WHEN pc.component_type = 'raw_material' THEN si.name
                 END as component_name
                 FROM product_components pc
                 LEFT JOIN panels p ON pc.component_type = 'panel' AND pc.component_id = p.id
                 LEFT JOIN stock_items si ON pc.component_type = 'raw_material' AND pc.component_id = si.id
                 WHERE pc.product_id = $1 ORDER BY pc.component_type, component_name`,
                [productId]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT pc.*,
                 CASE 
                     WHEN pc.component_type = 'panel' THEN p.name
                     WHEN pc.component_type = 'raw_material' THEN si.name
                 END as component_name
                 FROM product_components pc
                 LEFT JOIN panels p ON pc.component_type = 'panel' AND pc.component_id = p.id
                 LEFT JOIN stock_items si ON pc.component_type = 'raw_material' AND pc.component_id = si.id
                 WHERE pc.product_id = ? ORDER BY pc.component_type, component_name`
            ).all(productId);
        }
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
    
    static async updateProductOrder(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE product_orders SET status = $1 WHERE id = $2 RETURNING *`,
                [data.status, id]
            );
            return result.rows[0];
        } else {
            db.prepare(`UPDATE product_orders SET status = ? WHERE id = ?`).run(data.status, id);
            return this.getProductOrderById(id);
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
                `INSERT INTO stock_check_reminders (stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [data.stock_item_id, data.check_frequency_days, data.last_checked_date, data.next_check_date, data.is_active !== false]
            );
            return result.rows[0];
        } else {
            const stmt = db.prepare(
                `INSERT INTO stock_check_reminders (stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active)
                 VALUES (?, ?, ?, ?, ?)`
            );
            const info = stmt.run(data.stock_item_id, data.check_frequency_days, data.last_checked_date, data.next_check_date, data.is_active !== false ? 1 : 0);
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
    
    static async getAllReminders() {
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT r.*, si.name as stock_item_name
                 FROM stock_check_reminders r
                 JOIN stock_items si ON r.stock_item_id = si.id
                 ORDER BY r.next_check_date ASC`
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT r.*, si.name as stock_item_name
                 FROM stock_check_reminders r
                 JOIN stock_items si ON r.stock_item_id = si.id
                 ORDER BY r.next_check_date ASC`
            ).all();
        }
    }
    
    static async getOverdueReminders() {
        const today = new Date().toISOString().split('T')[0];
        if (isPostgreSQL) {
            const result = await pool.query(
                `SELECT r.*, si.name as stock_item_name
                 FROM stock_check_reminders r
                 JOIN stock_items si ON r.stock_item_id = si.id
                 WHERE r.is_active = TRUE AND r.next_check_date < $1
                 ORDER BY r.next_check_date ASC`,
                [today]
            );
            return result.rows;
        } else {
            return db.prepare(
                `SELECT r.*, si.name as stock_item_name
                 FROM stock_check_reminders r
                 JOIN stock_items si ON r.stock_item_id = si.id
                 WHERE r.is_active = 1 AND r.next_check_date < ?
                 ORDER BY r.next_check_date ASC`
            ).all(today);
        }
    }
    
    static async updateReminder(id, data) {
        if (isPostgreSQL) {
            const result = await pool.query(
                `UPDATE stock_check_reminders SET check_frequency_days = $1, is_active = $2 WHERE id = $3 RETURNING *`,
                [data.check_frequency_days, data.is_active !== false, id]
            );
            return result.rows[0];
        } else {
            db.prepare(
                `UPDATE stock_check_reminders SET check_frequency_days = ?, is_active = ? WHERE id = ?`
            ).run(data.check_frequency_days, data.is_active !== false ? 1 : 0, id);
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

