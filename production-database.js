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
            role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'staff')),
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
        
        // Panels
        db.exec(`
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
        db.exec(`
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
        db.exec(`
            CREATE TABLE IF NOT EXISTS component_bom_items (
                id SERIAL PRIMARY KEY,
                component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
                stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
                quantity_required DECIMAL(10,2) NOT NULL,
                unit VARCHAR(50) NOT NULL
            )
        `);
        
        // Component movements
        db.exec(`
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
        db.exec(`
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
        db.exec(`
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
        db.exec(`
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
        db.exec(`
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
        db.exec(`
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
        db.exec(`
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
        db.exec(`
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
        db.exec(`
            CREATE TABLE IF NOT EXISTS task_comments (
                id SERIAL PRIMARY KEY,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES production_users(id),
                comment TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Panel movements table
        db.exec(`
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
        db.exec(`
            CREATE TABLE IF NOT EXISTS production_settings (
                key VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Weekly planner table
        db.exec(`
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
        db.exec(`
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
        db.exec(`
            CREATE TABLE IF NOT EXISTS jobs (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                status VARCHAR(20) DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Timesheet entries table
        db.exec(`
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
        db.exec(`
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
            db.exec(`
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
        db.exec(`CREATE INDEX IF NOT EXISTS idx_bom_panel ON bom_items(panel_id)`);
        
        // Check if item_id column exists before creating index
        const itemIdColumnCheck = db.exec(`
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name='bom_items' AND column_name='item_id'
        `);
        if (itemIdColumnCheck.rows.length > 0) {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_bom_item ON bom_items(item_id)`);
        }
        
        db.exec(`CREATE INDEX IF NOT EXISTS idx_component_bom_component ON component_bom_items(component_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_component_bom_stock ON component_bom_items(stock_item_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_component_movements_component ON component_movements(component_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_product_components_product ON product_components(product_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_movements_user ON stock_movements(user_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to_user_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_panel_movements_panel ON panel_movements(panel_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_planner_items_planner ON planner_items(planner_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_planner_items_panel ON planner_items(panel_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_weekly_planner_date ON weekly_planner(week_start_date)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_timesheet_entries_user ON timesheet_entries(user_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_timesheet_entries_job ON timesheet_entries(job_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_timesheet_entries_clock_in ON timesheet_entries(clock_in_time)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_timesheet_notices_status ON timesheet_notices(status)`);
        
        // Migrate production_users role constraint to include 'staff'
        try {
            // Check if constraint needs updating by trying to find existing constraint
            const constraintCheck = db.exec(`
                SELECT constraint_name 
                FROM information_schema.table_constraints 
                WHERE table_name = 'production_users' 
                AND constraint_type = 'CHECK'
            `);
            
            if (constraintCheck.rows.length > 0) {
                // Try to drop and recreate constraint
                for (const constraint of constraintCheck.rows) {
                    try {
                        db.exec(`ALTER TABLE production_users DROP CONSTRAINT IF EXISTS ${constraint.constraint_name}`);
                    } catch (e) {
                        // Constraint might be named differently or already dropped
                        console.log('⚠️ Could not drop constraint:', constraint.constraint_name, e.message);
                    }
                }
            }
            
            // Add new constraint with staff role (will fail silently if already exists with correct values)
            try {
                db.exec(`
                    ALTER TABLE production_users 
                    DROP CONSTRAINT IF EXISTS production_users_role_check
                `);
                db.exec(`
                    ALTER TABLE production_users 
                    ADD CONSTRAINT production_users_role_check 
                    CHECK (role IN ('admin', 'manager', 'staff'))
                `);
                console.log('✅ Updated production_users role constraint to include staff');
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
        db.exec(`
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
        db.exec(`
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
        const settingCheck = db.exec(`SELECT COUNT(*) as count FROM production_settings WHERE key = 'labour_rate_per_hour'`);
        if (parseInt(settingCheck.rows[0].count) === 0) {
            db.exec(`INSERT INTO production_settings (key, value) VALUES ('labour_rate_per_hour', '25.00')`);
        }
        
        // Migrate timesheet_entries to add hour calculation columns
        db.exec(`
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
            END $$;
        `);
        
        // Create weekly_timesheets table
        db.exec(`
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
        db.exec(`
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
        
        // Create timesheet_amendments table
        db.exec(`
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
        db.exec(`CREATE INDEX IF NOT EXISTS idx_weekly_timesheets_user ON weekly_timesheets(user_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_weekly_timesheets_week ON weekly_timesheets(week_start_date)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_entries_weekly ON timesheet_daily_entries(weekly_timesheet_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_entries_date ON timesheet_daily_entries(entry_date)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_amendments_entry ON timesheet_amendments(timesheet_entry_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_amendments_user ON timesheet_amendments(user_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_amendments_status ON timesheet_amendments(status)`);
        
        console.log(' Production SQLite database initialized');
}
