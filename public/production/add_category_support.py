#!/usr/bin/env python3
import re

# Read the file
with open('production-database.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add category to SQLite CREATE TABLE
content = re.sub(
    r'(description TEXT,\s+)(unit TEXT NOT NULL,)',
    r'\1category TEXT,\n            \2',
    content,
    count=1
)

# 2. Add category to PostgreSQL CREATE TABLE
content = re.sub(
    r'(description TEXT,\s+)(unit VARCHAR\(50\) NOT NULL,)',
    r'\1category VARCHAR(255),\n                \2',
    content,
    count=1
)

# 3. Update INSERT statements to include category
content = re.sub(
    r'INSERT INTO stock_items \(name, description, unit,',
    'INSERT INTO stock_items (name, description, category, unit,',
    content
)

# 4. Update PostgreSQL VALUES to include category parameter
content = re.sub(
    r'VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\) RETURNING',
    r'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING',
    content
)

# 5. Update SQLite VALUES to include category parameter
content = re.sub(
    r'VALUES \(\?, \?, \?, \?, \?, \?, \?\)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    content
)

# 6. Update PostgreSQL parameter array to include category
content = re.sub(
    r'\[data\.name, data\.description, data\.unit,',
    '[data.name, data.description, data.category || null, data.unit,',
    content
)

# 7. Update SQLite run to include category
content = re.sub(
    r'\.run\(data\.name, data\.description, data\.unit,',
    '.run(data.name, data.description, data.category || null, data.unit,',
    content
)

# 8. Update PostgreSQL UPDATE to include category
content = re.sub(
    r'UPDATE stock_items SET name = \$1, description = \$2, unit = \$3,',
    'UPDATE stock_items SET name = $1, description = $2, category = $3, unit = $4,',
    content
)

# 9. Update PostgreSQL UPDATE WHERE clause parameter numbers
content = re.sub(
    r'min_quantity = \$4, location = \$5, cost_per_unit_gbp = \$6\s+WHERE id = \$7',
    'min_quantity = $5, location = $6, cost_per_unit_gbp = $7\n                   WHERE id = $8',
    content
)

# 10. Update SQLite UPDATE to include category
content = re.sub(
    r'UPDATE stock_items SET name = \?, description = \?, unit = \?,',
    'UPDATE stock_items SET name = ?, description = ?, category = ?, unit = ?,',
    content
)

# 11. Update UPDATE parameter arrays
content = re.sub(
    r'\[data\.name, data\.description, data\.unit, data\.min_quantity,',
    '[data.name, data.description, data.category || null, data.unit, data.min_quantity,',
    content
)

# 12. Update UPDATE run
content = re.sub(
    r'\)\.run\(data\.name, data\.description, data\.unit, data\.min_quantity,',
    ').run(data.name, data.description, data.category || null, data.unit, data.min_quantity,',
    content
)

# Write back
with open('production-database.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Added category support to database')



