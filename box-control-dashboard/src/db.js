// PostgreSQL Database Module for Box Control Dashboard
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Initialize PostgreSQL connection pool
let pool;
let isInitialized = false;

function initializePool() {
    if (pool) return pool;

    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL environment variable is required');
    }

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });

    pool.on('error', (err) => {
        console.error('❌ Unexpected PostgreSQL pool error:', err);
    });

    console.log('✅ PostgreSQL connection pool created');
    return pool;
}

// Initialize database schema
async function initializeSchema() {
    if (isInitialized) return;

    const db = initializePool();
    
    try {
        // Read and execute migration SQL
        const migrationPath = path.join(__dirname, '..', 'migrations', '001_init.sql');
        const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
        
        await db.query(migrationSQL);
        console.log('✅ Database schema initialized');
        isInitialized = true;
    } catch (error) {
        console.error('❌ Error initializing database schema:', error);
        throw error;
    }
}

// Generic query helper
async function query(text, params) {
    const db = initializePool();
    try {
        const result = await db.query(text, params);
        return result;
    } catch (error) {
        console.error('❌ Database query error:', error);
        throw error;
    }
}

// Settings operations
async function getSettings() {
    const result = await query('SELECT * FROM box_control_settings LIMIT 1');
    if (result.rows.length === 0) {
        // If no settings exist, initialize with defaults
        await initializeSchema();
        const result2 = await query('SELECT * FROM box_control_settings LIMIT 1');
        return result2.rows[0];
    }
    return result.rows[0];
}

async function updateSettings(updates) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedFields = [
        'monthly_contribution_target',
        'survival_contribution',
        'target_boxes_per_month',
        'target_boxes_per_week',
        'target_install_pct',
        'target_extras_pct',
        'contribution_per_box',
        'cost_compliance_target',
        'right_first_time_target'
    ];

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            fields.push(`${key} = $${paramIndex}`);
            values.push(value);
            paramIndex++;
        }
    }

    if (fields.length === 0) {
        throw new Error('No valid fields to update');
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(1); // Dummy value for paramIndex

    const sql = `UPDATE box_control_settings SET ${fields.join(', ')} WHERE id = 1`;
    await query(sql, values.slice(0, -1)); // Remove the dummy value
    return await getSettings();
}

// Sales weekly operations
async function getSalesWeekly(weekCommencing = null) {
    if (weekCommencing) {
        const result = await query(
            'SELECT * FROM sales_weekly WHERE week_commencing = $1',
            [weekCommencing]
        );
        return result.rows[0] || null;
    }
    const result = await query(
        'SELECT * FROM sales_weekly ORDER BY week_commencing DESC'
    );
    return result.rows;
}

async function upsertSalesWeekly(data) {
    const sql = `
        INSERT INTO sales_weekly (
            week_commencing, boxes_sold, installs_sold, 
            box_revenue, extras_revenue, install_revenue, notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (week_commencing) 
        DO UPDATE SET
            boxes_sold = EXCLUDED.boxes_sold,
            installs_sold = EXCLUDED.installs_sold,
            box_revenue = EXCLUDED.box_revenue,
            extras_revenue = EXCLUDED.extras_revenue,
            install_revenue = EXCLUDED.install_revenue,
            notes = EXCLUDED.notes
        RETURNING *
    `;
    const result = await query(sql, [
        data.week_commencing,
        data.boxes_sold,
        data.installs_sold,
        data.box_revenue || 0,
        data.extras_revenue || 0,
        data.install_revenue || 0,
        data.notes || null
    ]);
    return result.rows[0];
}

// Production weekly operations
async function getProductionWeekly(weekCommencing = null) {
    if (weekCommencing) {
        const result = await query(
            'SELECT * FROM production_weekly WHERE week_commencing = $1',
            [weekCommencing]
        );
        return result.rows[0] || null;
    }
    const result = await query(
        'SELECT * FROM production_weekly ORDER BY week_commencing DESC'
    );
    return result.rows;
}

async function upsertProductionWeekly(data) {
    const sql = `
        INSERT INTO production_weekly (
            week_commencing, boxes_produced, installs_completed,
            boxes_over_cost, rework_hours, right_first_time_pct, notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (week_commencing) 
        DO UPDATE SET
            boxes_produced = EXCLUDED.boxes_produced,
            installs_completed = EXCLUDED.installs_completed,
            boxes_over_cost = EXCLUDED.boxes_over_cost,
            rework_hours = EXCLUDED.rework_hours,
            right_first_time_pct = EXCLUDED.right_first_time_pct,
            notes = EXCLUDED.notes
        RETURNING *
    `;
    const result = await query(sql, [
        data.week_commencing,
        data.boxes_produced,
        data.installs_completed,
        data.boxes_over_cost || 0,
        data.rework_hours || 0,
        data.right_first_time_pct || null,
        data.notes || null
    ]);
    return result.rows[0];
}

// Get sales data for MTD calculation (current month)
async function getSalesMTD() {
    const sql = `
        SELECT 
            COALESCE(SUM(boxes_sold), 0) as boxes_sold,
            COALESCE(SUM(installs_sold), 0) as installs_sold,
            COALESCE(SUM(box_revenue), 0) as box_revenue,
            COALESCE(SUM(extras_revenue), 0) as extras_revenue,
            COALESCE(SUM(install_revenue), 0) as install_revenue
        FROM sales_weekly
        WHERE DATE_TRUNC('month', week_commencing) = DATE_TRUNC('month', CURRENT_DATE)
    `;
    const result = await query(sql);
    return result.rows[0];
}

// Get production data for MTD calculation (current month)
async function getProductionMTD() {
    const sql = `
        SELECT 
            COALESCE(SUM(boxes_produced), 0) as boxes_produced,
            COALESCE(SUM(installs_completed), 0) as installs_completed,
            COALESCE(SUM(boxes_over_cost), 0) as boxes_over_cost,
            COALESCE(SUM(rework_hours), 0) as rework_hours
        FROM production_weekly
        WHERE DATE_TRUNC('month', week_commencing) = DATE_TRUNC('month', CURRENT_DATE)
    `;
    const result = await query(sql);
    return result.rows[0];
}

// Get last 4 weeks of sales data
async function getSalesLast4Weeks() {
    const sql = `
        SELECT *
        FROM sales_weekly
        ORDER BY week_commencing DESC
        LIMIT 4
    `;
    const result = await query(sql);
    return result.rows;
}

// Get last 4 weeks of production data
async function getProductionLast4Weeks() {
    const sql = `
        SELECT *
        FROM production_weekly
        ORDER BY week_commencing DESC
        LIMIT 4
    `;
    const result = await query(sql);
    return result.rows;
}

// Get forward look data (next 4 weeks from today)
async function getForwardLook() {
    const sql = `
        SELECT *
        FROM sales_weekly
        WHERE week_commencing >= CURRENT_DATE
        ORDER BY week_commencing ASC
        LIMIT 4
    `;
    const result = await query(sql);
    return result.rows;
}

module.exports = {
    initializePool,
    initializeSchema,
    query,
    getSettings,
    updateSettings,
    getSalesWeekly,
    upsertSalesWeekly,
    getProductionWeekly,
    upsertProductionWeekly,
    getSalesMTD,
    getProductionMTD,
    getSalesLast4Weeks,
    getProductionLast4Weeks,
    getForwardLook
};

