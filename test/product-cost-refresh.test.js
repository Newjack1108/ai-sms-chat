const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadProductionDatabase() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-cost-refresh-'));
    process.env.DATABASE_PATH = path.join(tmpDir, 'leads.db');
    for (const mod of ['../database-pg', '../production-database']) {
        try {
            delete require.cache[require.resolve(mod)];
        } catch (e) {
            /* first load */
        }
    }
    return require('../production-database').ProductionDatabase;
}

const ProductionDatabase = loadProductionDatabase();

describe('product cost refresh from raw-material prices', () => {
    it('updateProductCost recalculates from current stock unit price', async () => {
        const stock = await ProductionDatabase.createStockItem({
            name: 'Test Timber Board',
            description: 'For cost refresh test',
            unit: 'each',
            current_quantity: 100,
            min_quantity: 0,
            location: 'A1',
            cost_per_unit_gbp: 10
        });

        const product = await ProductionDatabase.createProduct({
            name: 'Cost Refresh Product',
            description: 'BOM cost refresh test',
            product_type: 'other',
            leadlock_category: 'sheds',
            category: 'Other',
            status: 'active',
            estimated_load_time: 0,
            estimated_install_time: 0,
            estimated_travel_time: 0,
            number_of_boxes: 1
        });

        await ProductionDatabase.addProductComponent(
            product.id,
            'raw_material',
            stock.id,
            2,
            'each'
        );

        let refreshed = await ProductionDatabase.getProductById(product.id);
        assert.equal(parseFloat(refreshed.cost_gbp), 20);

        // Editing stock price does not automatically refresh product cost_gbp
        await ProductionDatabase.updateStockItem(stock.id, {
            name: stock.name,
            description: stock.description,
            unit: stock.unit,
            min_quantity: stock.min_quantity,
            location: stock.location,
            category: stock.category || null,
            cost_per_unit_gbp: 15
        });

        const stale = await ProductionDatabase.getProductById(product.id);
        assert.equal(parseFloat(stale.cost_gbp), 20);

        const newCost = await ProductionDatabase.updateProductCost(product.id);
        assert.equal(parseFloat(newCost), 30);

        refreshed = await ProductionDatabase.getProductById(product.id);
        assert.equal(parseFloat(refreshed.cost_gbp), 30);
    });
});
