# Script to add category support to stock items
$routesFile = "production-routes.js"
$dbFile = "production-database.js"

# Read routes file
$routesContent = Get-Content $routesFile -Raw

# Update POST route - add category to destructuring and createStockItem call
$routesContent = $routesContent -replace "(const \{ name, description, unit, current_quantity, min_quantity, location, cost_per_unit_gbp \} = req\.body;)","const { name, description, unit, current_quantity, min_quantity, location, cost_per_unit_gbp, category } = req.body;"

# Update PUT route - add category to destructuring  
$routesContent = $routesContent -replace "(const \{ name, description, unit, min_quantity, location, cost_per_unit_gbp \} = req\.body;)","const { name, description, unit, min_quantity, location, cost_per_unit_gbp, category } = req.body;"

# Add category to createStockItem call (after location, before cost_per_unit_gbp)
$routesContent = $routesContent -replace "(location,`r?`n\s+cost_per_unit_gbp: parseFloat\(cost_per_unit_gbp\) \|\| 0)","location,`n            category: category && category.trim() ? category.trim() : null,`n            cost_per_unit_gbp: parseFloat(cost_per_unit_gbp) || 0"

# Add category to updateStockItem call
$routesContent = $routesContent -replace "(location,`r?`n\s+cost_per_unit_gbp: parseFloat\(cost_per_unit_gbp\) \|\| 0)","location,`n            category: category && category.trim() ? category.trim() : null,`n            cost_per_unit_gbp: parseFloat(cost_per_unit_gbp) || 0"

Set-Content $routesFile -Value $routesContent -NoNewline

Write-Host "Updated production-routes.js"

# Read database file
$dbContent = Get-Content $dbFile -Raw

# Add category to SQLite CREATE TABLE
$dbContent = $dbContent -replace "(description TEXT,`r?`n\s+unit TEXT NOT NULL,)","description TEXT,`n            category TEXT,`n            unit TEXT NOT NULL,"

# Add category to PostgreSQL CREATE TABLE  
$dbContent = $dbContent -replace "(description TEXT,`r?`n\s+unit VARCHAR\(50\) NOT NULL,)","description TEXT,`n                category VARCHAR(255),`n                unit VARCHAR(50) NOT NULL,"

# Add category to SQLite INSERT
$dbContent = $dbContent -replace "(INSERT INTO stock_items \(name, description, unit,`r?`n\s+current_quantity, min_quantity, location, cost_per_unit_gbp\))","INSERT INTO stock_items (name, description, category, unit,`n                current_quantity, min_quantity, location, cost_per_unit_gbp)"

# Add category to PostgreSQL INSERT
$dbContent = $dbContent -replace "(INSERT INTO stock_items \(name, description, unit,`r?`n\s+current_quantity, min_quantity, location, cost_per_unit_gbp\))","INSERT INTO stock_items (name, description, category, unit,`n                current_quantity, min_quantity, location, cost_per_unit_gbp)"

# Add category to INSERT VALUES (SQLite)
$dbContent = $dbContent -replace "(VALUES \(\?, \?, \?, \?, \?, \?, \?\))","VALUES (?, ?, ?, ?, ?, ?, ?, ?)"

# Add category to INSERT VALUES (PostgreSQL)
$dbContent = $dbContent -replace "(VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\))","VALUES (`$1, `$2, `$3, `$4, `$5, `$6, `$7, `$8)"

# Add category to INSERT parameter arrays
$dbContent = $dbContent -replace "(\[data\.name, data\.description, data\.unit,`r?`n\s+data\.current_quantity \|\| 0, data\.min_quantity \|\| 0, data\.location,`r?`n\s+data\.cost_per_unit_gbp \|\| 0\])","[data.name, data.description, data.category || null, data.unit,`n                data.current_quantity || 0, data.min_quantity || 0, data.location,`n                data.cost_per_unit_gbp || 0]"

# Add category to SQLite INSERT run
$dbContent = $dbContent -replace "(\.run\(data\.name, data\.description, data\.unit, data\.current_quantity \|\| 0, data\.min_quantity \|\| 0, data\.location,`r?`n\s+data\.cost_per_unit_gbp \|\| 0\))",".run(data.name, data.description, data.category || null, data.unit, data.current_quantity || 0, data.min_quantity || 0, data.location,`n                data.cost_per_unit_gbp || 0)"

# Add category to UPDATE statements
$dbContent = $dbContent -replace "(UPDATE stock_items SET name = \$1, description = \$2, unit = \$3, min_quantity = \$4, location = \$5, cost_per_unit_gbp = \$6)","UPDATE stock_items SET name = `$1, description = `$2, category = `$3, unit = `$4, min_quantity = `$5, location = `$6, cost_per_unit_gbp = `$7"

$dbContent = $dbContent -replace "(UPDATE stock_items SET name = \?, description = \?, unit = \?, min_quantity = \?, location = \?, cost_per_unit_gbp = \?)","UPDATE stock_items SET name = ?, description = ?, category = ?, unit = ?, min_quantity = ?, location = ?, cost_per_unit_gbp = ?"

# Update WHERE clause parameter numbers for PostgreSQL
$dbContent = $dbContent -replace "(WHERE id = \$7 RETURNING \*)","WHERE id = `$8 RETURNING *"

# Update UPDATE parameter arrays
$dbContent = $dbContent -replace "(\[data\.name, data\.description, data\.unit, data\.min_quantity, data\.location,`r?`n\s+data\.cost_per_unit_gbp, id\])","[data.name, data.description, data.category || null, data.unit, data.min_quantity, data.location,`n                data.cost_per_unit_gbp, id]"

$dbContent = $dbContent -replace "(\.run\(data\.name, data\.description, data\.unit, data\.min_quantity, data\.location,`r?`n\s+data\.cost_per_unit_gbp, id\))",".run(data.name, data.description, data.category || null, data.unit, data.min_quantity, data.location,`n                data.cost_per_unit_gbp, id)"

Set-Content $dbFile -Value $dbContent -NoNewline

Write-Host "Updated production-database.js"

