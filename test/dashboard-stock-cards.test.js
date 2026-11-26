/**
 * Dashboard stock card tests - verify cards show separate categories.
 * Run: node test/dashboard-stock-cards.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
    try {
        fn();
        console.log('✓', name);
    } catch (e) {
        console.error('✗', name);
        console.error(e.message);
        process.exitCode = 1;
    }
}

test('dashboard HTML displays three separate stock categories', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'production', 'dashboard.html'),
        'utf8'
    );
    
    // Check card 1: Components
    assert.ok(html.includes('id="totalComponentValue"'), 'First card should use totalComponentValue ID');
    assert.ok(html.includes('<div class="kpi-label">Components</div>'), 'First card should be labeled Components');
    
    // Check card 2: Raw Materials
    assert.ok(html.includes('id="totalRawStockValue"'), 'Second card should use totalRawStockValue ID');
    assert.ok(html.includes('<div class="kpi-label">Raw Materials</div>'), 'Second card should be labeled Raw Materials');
    
    // Check card 3: Built Panels
    assert.ok(html.includes('id="totalPanelValue"'), 'Third card should use totalPanelValue ID');
    assert.ok(html.includes('<div class="kpi-label">Built Panels</div>'), 'Third card should be labeled Built Panels');
});

test('dashboard JS assigns correct API values to each card', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'production', 'dashboard.html'),
        'utf8'
    );
    
    // Check that the script assigns the right values from the API response
    assert.ok(
        html.includes("document.getElementById('totalComponentValue').textContent = formatCurrency(summary.total_component_value)"),
        'Components card should display total_component_value from API'
    );
    assert.ok(
        html.includes("document.getElementById('totalRawStockValue').textContent = formatCurrency(summary.total_raw_stock_value)"),
        'Raw Materials card should display total_raw_stock_value from API'
    );
    assert.ok(
        html.includes("document.getElementById('totalPanelValue').textContent = formatCurrency(summary.total_panel_value)"),
        'Built Panels card should display total_panel_value from API'
    );
});

test('dashboard cards no longer aggregate values incorrectly', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'production', 'dashboard.html'),
        'utf8'
    );
    
    // Ensure old combined values are not used
    assert.ok(!html.includes('total_wip_value'), 'Should not use combined WIP value');
    assert.ok(!html.includes('total_stock_value'), 'Should not use combined stock value that includes WIP');
    assert.ok(!html.includes('Raw materials plus WIP'), 'Should not have old note about combined values');
});

test('API provides separate values for all three categories', () => {
    const routes = fs.readFileSync(
        path.join(__dirname, '..', 'production-routes.js'),
        'utf8'
    );
    
    // Verify the API returns all three separate values
    const summaryRoute = routes.substring(
        routes.indexOf("router.get('/dashboard/summary'"),
        routes.indexOf("router.get('/dashboard/summary'") + 2000
    );
    
    assert.ok(summaryRoute.includes('total_component_value:'), 'API should return total_component_value');
    assert.ok(summaryRoute.includes('total_raw_stock_value:'), 'API should return total_raw_stock_value');
    assert.ok(summaryRoute.includes('total_panel_value:'), 'API should return total_panel_value');
});

if (!process.exitCode) {
    console.log('\nAll dashboard stock card tests passed.');
}
