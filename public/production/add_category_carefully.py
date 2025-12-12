#!/usr/bin/env python3
import re
import sys

# Read the file
with open('production-database.js', 'r', encoding='utf-8') as f:
    content = f.read()

original_content = content

print("Step 1: Add category to SQLite CREATE TABLE...")
# Add category after description in SQLite
content = re.sub(
    r'(description TEXT,\s+)(unit TEXT NOT NULL,)',
    r'\1category TEXT,\n            \2',
    content,
    count=1  # Only replace first occurrence (SQLite)
)

print("Step 2: Add category to PostgreSQL CREATE TABLE...")
# Add category after description in PostgreSQL  
content = re.sub(
    r'(description TEXT,\s+)(unit VARCHAR\(50\) NOT NULL,)',
    r'\1category VARCHAR(255),\n                \2',
    content,
    count=1  # Only replace after SQLite is done
)

print("Step 3: Add migration function...")
# Find where to insert (before ensureBOMItemsSchema)
bom_match = re.search(r'(\s+)static async ensureBOMItemsSchema\(\)', content)
if bom_match:
    indent = bom_match.group(1)
    migration_func = f'''{indent}static async ensureStockItemsSchema() {{
{indent}    if (!isPostgreSQL) return;
{indent}    
{indent}    try {{
{indent}        await pool.query(`
{indent}            DO $$
{indent}            BEGIN
{indent}                IF EXISTS (
{indent}                    SELECT 1 FROM information_schema.tables
{indent}                    WHERE table_schema = 'public' AND table_name='stock_items'
{indent}                ) AND NOT EXISTS (
{indent}                    SELECT 1 FROM information_schema.columns
{indent}                    WHERE table_schema = 'public' AND table_name='stock_items' AND column_name='category'
{indent}                ) THEN
{indent}                    ALTER TABLE stock_items ADD COLUMN category VARCHAR(255);
{indent}                END IF;
{indent}            END $$;
{indent}        `);
{indent}    }} catch (error) {{
{indent}        console.error('Error ensuring stock_items schema:', error);
{indent}    }}
{indent}}}

'''
    content = content[:bom_match.start()] + migration_func + content[bom_match.start():]
    print("   Migration function inserted")
else:
    print("   ERROR: Could not find ensureBOMItemsSchema function")
    sys.exit(1)

print("Step 4: Update INSERT statements...")
# Update INSERT to include category
content = re.sub(
    r'INSERT INTO stock_items \(name, description, unit,',
    'INSERT INTO stock_items (name, description, category, unit,',
    content
)

# Update PostgreSQL VALUES
content = re.sub(
    r'VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\) RETURNING',
    r'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING',
    content
)

# Update SQLite VALUES
content = re.sub(
    r'VALUES \(\?, \?, \?, \?, \?, \?, \?\)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    content
)

print("Step 5: Update INSERT parameter arrays...")
# Update parameter arrays
content = re.sub(
    r'\[data\.name, data\.description, data\.unit,',
    '[data.name, data.description, data.category || null, data.unit,',
    content
)

content = re.sub(
    r'\.run\(data\.name, data\.description, data\.unit,',
    '.run(data.name, data.description, data.category || null, data.unit,',
    content
)

print("Step 6: Update UPDATE statements...")
# Update PostgreSQL UPDATE
content = re.sub(
    r'UPDATE stock_items SET name = \$1, description = \$2, unit = \$3,',
    'UPDATE stock_items SET name = $1, description = $2, category = $3, unit = $4,',
    content
)

content = re.sub(
    r'min_quantity = \$4, location = \$5, cost_per_unit_gbp = \$6\s+WHERE id = \$7',
    'min_quantity = $5, location = $6, cost_per_unit_gbp = $7\n                   WHERE id = $8',
    content
)

# Update SQLite UPDATE
content = re.sub(
    r'UPDATE stock_items SET name = \?, description = \?, unit = \?,',
    'UPDATE stock_items SET name = ?, description = ?, category = ?, unit = ?,',
    content
)

print("Step 7: Update UPDATE parameter arrays...")
content = re.sub(
    r'\[data\.name, data\.description, data\.unit, data\.min_quantity,',
    '[data.name, data.description, data.category || null, data.unit, data.min_quantity,',
    content
)

content = re.sub(
    r'\)\.run\(data\.name, data\.description, data\.unit, data\.min_quantity,',
    ').run(data.name, data.description, data.category || null, data.unit, data.min_quantity,',
    content
)

print("Step 8: Add migration calls...")
# Add call in createStockItem
content = re.sub(
    r'(static async createStockItem\(data\) \{)',
    r'\1\n        await this.ensureStockItemsSchema();',
    content
)

# Add call in updateStockItem
content = re.sub(
    r'(static async updateStockItem\(id, data\) \{)',
    r'\1\n        await this.ensureStockItemsSchema();',
    content
)

# Write back
with open('production-database.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("\n✓ All steps completed!")
print("Please run: node -c production-database.js to verify syntax")



