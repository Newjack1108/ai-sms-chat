const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { csvEscapeCell, productsToCsv } = require('../product-csv-export');

function loadProductionDatabase() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-csv-'));
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

describe('product CSV export helpers', () => {
    it('escapes commas and quotes in cells', () => {
        assert.equal(csvEscapeCell('plain'), 'plain');
        assert.equal(csvEscapeCell('a,b'), '"a,b"');
        assert.equal(csvEscapeCell('say "hi"'), '"say ""hi"""');
    });

    it('includes id header and product row', () => {
        const csv = productsToCsv([
            {
                id: 42,
                name: 'Field Shelter, Deluxe',
                description: 'With "extra" kit',
                category: 'Standard Product',
                product_type: 'sheds',
                leadlock_category: 'sheds',
                is_optional_extra: 0,
                management_checked: 1,
                status: 'active',
                cost_gbp: 1200.5,
                number_of_boxes: 2,
                estimated_load_time: 1,
                estimated_install_time: 3,
                estimated_travel_time: 0,
                last_pushed_to_sales_at: null
            }
        ]);
        assert.match(csv, /^id,name,description,/);
        assert.match(csv, /management_checked/);
        assert.match(csv, /42,/);
        assert.match(csv, /"Field Shelter, Deluxe"/);
        assert.match(csv, /false,true,active/);
        assert.match(csv, /1200\.5/);
    });
});

describe('getProductsForExport', () => {
    it('returns products with ids matching filters', async () => {
        const main = await ProductionDatabase.createProduct({
            name: 'CSV Main Stable',
            product_type: 'stables',
            leadlock_category: 'stables',
            category: 'Standard Product',
            is_optional_extra: false
        });
        const extra = await ProductionDatabase.createProduct({
            name: 'CSV Extra Mat',
            product_type: 'other',
            leadlock_category: 'stables',
            category: 'Standard Product',
            is_optional_extra: true
        });

        const all = await ProductionDatabase.getProductsForExport({ status: 'active' });
        const ids = all.map((p) => parseInt(p.id, 10));
        assert.ok(ids.includes(main.id));
        assert.ok(ids.includes(extra.id));

        const extrasOnly = await ProductionDatabase.getProductsForExport({
            status: 'active',
            is_optional_extra: true
        });
        const extraIds = extrasOnly.map((p) => parseInt(p.id, 10));
        assert.ok(extraIds.includes(extra.id));
        assert.ok(!extraIds.includes(main.id));

        const csv = productsToCsv(extrasOnly);
        assert.match(csv, /^id,name,/);
        assert.match(csv, new RegExp(String(extra.id)));
        assert.match(csv, /CSV Extra Mat/);
    });
});
