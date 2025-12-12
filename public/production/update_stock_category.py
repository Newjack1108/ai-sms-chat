#!/usr/bin/env python3
import re

# Read the database file
with open('production-database.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Add category to SQLite CREATE TABLE if not present
if 'CREATE TABLE IF NOT EXISTS stock_items' in content and 'category TEXT' not in content.split('CREATE TABLE IF NOT EXISTS stock_items')[1].split(')')[0]:
    content = re.sub(
        r'(description TEXT,\s+)(unit TEXT NOT NULL,)',
        r'\1category TEXT,\n            \2',
        content,
        count=1
    )

# Update PostgreSQL INSERT to include category
content = re.sub(
    r'INSERT INTO stock_items \(name, description, unit,\s+current_quantity, min_quantity, location, cost_per_unit_gbp\)',
    'INSERT INTO stock_items (name, description, category, unit,\n                current_quantity, min_quantity, location, cost_per_unit_gbp)',
    content
)

# Update SQLite INSERT to include category (if different format)
content = re.sub(
    r'INSERT INTO stock_items \(name, description, unit,\s+current_quantity, min_quantity, location, cost_per_unit_gbp\)',
    'INSERT INTO stock_items (name, description, category, unit,\n                current_quantity, min_quantity, location, cost_per_unit_gbp)',
    content
)

# Update PostgreSQL VALUES to include category parameter
content = re.sub(
    r'VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\) RETURNING \*',
    r'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
    content
)

# Update SQLite VALUES to include category parameter
content = re.sub(
    r'VALUES \(\?, \?, \?, \?, \?, \?, \?\)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    content
)

# Update PostgreSQL parameter array to include category
content = re.sub(
    r'\[data\.name, data\.description, data\.unit,(\s+)data\.current_quantity \|\| 0, data\.min_quantity \|\| 0, data\.location,(\s+)data\.cost_per_unit_gbp \|\| 0\]',
    r'[data.name, data.description, data.category || null, data.unit,\1data.current_quantity || 0, data.min_quantity || 0, data.location,\2data.cost_per_unit_gbp || 0]',
    content
)

# Update SQLite run to include category
content = re.sub(
    r'\.run\(data\.name, data\.description, data\.unit, data\.current_quantity \|\| 0, data\.min_quantity \|\| 0, data\.location,(\s+)data\.cost_per_unit_gbp \|\| 0\)',
    r'.run(data.name, data.description, data.category || null, data.unit, data.current_quantity || 0, data.min_quantity || 0, data.location,\1data.cost_per_unit_gbp || 0)',
    content
)

# Update PostgreSQL UPDATE to include category
content = re.sub(
    r'UPDATE stock_items SET name = \$1, description = \$2, unit = \$3, min_quantity = \$4, location = \$5, cost_per_unit_gbp = \$6\s+WHERE id = \$7 RETURNING \*',
    'UPDATE stock_items SET name = $1, description = $2, category = $3, unit = $4, min_quantity = $5, location = $6, cost_per_unit_gbp = $7\n                   WHERE id = $8 RETURNING *',
    content
)

# Update SQLite UPDATE to include category
content = re.sub(
    r'UPDATE stock_items SET name = \?, description = \?, unit = \?, min_quantity = \?, location = \?, cost_per_unit_gbp = \?',
    'UPDATE stock_items SET name = ?, description = ?, category = ?, unit = ?, min_quantity = ?, location = ?, cost_per_unit_gbp = ?',
    content
)

# Update PostgreSQL UPDATE parameter array
content = re.sub(
    r'\[data\.name, data\.description, data\.unit, data\.min_quantity, data\.location,(\s+)data\.cost_per_unit_gbp, id\]',
    r'[data.name, data.description, data.category || null, data.unit, data.min_quantity, data.location,\1data.cost_per_unit_gbp, id]',
    content
)

# Update SQLite UPDATE run
content = re.sub(
    r'\)\.run\(data\.name, data\.description, data\.unit, data\.min_quantity, data\.location,(\s+)data\.cost_per_unit_gbp, id\)',
    r').run(data.name, data.description, data.category || null, data.unit, data.min_quantity, data.location,\1data.cost_per_unit_gbp, id)',
    content
)

# Write back
with open('production-database.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Updated production-database.js with category support')

