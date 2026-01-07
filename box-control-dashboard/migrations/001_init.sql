-- Box Control Dashboard - Initial Schema
-- All prices ex-VAT

-- Settings table (single row with all business constants)
-- Note: Using box_control_settings to avoid conflict with ai-sms-chat settings table
CREATE TABLE IF NOT EXISTS box_control_settings (
    id SERIAL PRIMARY KEY,
    monthly_contribution_target NUMERIC NOT NULL DEFAULT 55000,
    survival_contribution NUMERIC NOT NULL DEFAULT 41900,
    target_boxes_per_month INTEGER NOT NULL DEFAULT 86,
    target_boxes_per_week INTEGER NOT NULL DEFAULT 21,
    target_install_pct NUMERIC NOT NULL DEFAULT 0.80,
    target_extras_pct NUMERIC NOT NULL DEFAULT 0.15,
    contribution_per_box NUMERIC NOT NULL DEFAULT 640,
    cost_compliance_target NUMERIC NOT NULL DEFAULT 0.95,
    right_first_time_target NUMERIC NOT NULL DEFAULT 0.95,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sales weekly table
CREATE TABLE IF NOT EXISTS sales_weekly (
    id SERIAL PRIMARY KEY,
    week_commencing DATE UNIQUE NOT NULL,
    boxes_sold INTEGER NOT NULL,
    installs_sold INTEGER NOT NULL,
    box_revenue NUMERIC DEFAULT 0,
    extras_revenue NUMERIC DEFAULT 0,
    install_revenue NUMERIC DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Production weekly table
CREATE TABLE IF NOT EXISTS production_weekly (
    id SERIAL PRIMARY KEY,
    week_commencing DATE UNIQUE NOT NULL,
    boxes_produced INTEGER NOT NULL,
    installs_completed INTEGER NOT NULL,
    boxes_over_cost INTEGER NOT NULL DEFAULT 0,
    rework_hours NUMERIC NOT NULL DEFAULT 0,
    right_first_time_pct NUMERIC DEFAULT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sales_week_commencing ON sales_weekly(week_commencing);
CREATE INDEX IF NOT EXISTS idx_production_week_commencing ON production_weekly(week_commencing);

-- Seed settings table with default values if empty
INSERT INTO settings (
    monthly_contribution_target,
    survival_contribution,
    target_boxes_per_month,
    target_boxes_per_week,
    target_install_pct,
    target_extras_pct,
    contribution_per_box,
    cost_compliance_target,
    right_first_time_target
)
SELECT 
    55000,
    41900,
    86,
    21,
    0.80,
    0.15,
    640,
    0.95,
    0.95
WHERE NOT EXISTS (SELECT 1 FROM box_control_settings);

