const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadProductionDatabase() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-wo-bespoke-'));
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

describe('LeadLock production setup', () => {

    it('reports sales-only lines until bespoke product is linked', async () => {
        const catalog = await ProductionDatabase.createProduct({
            name: 'Test Stable WO',
            description: 'Catalog',
            product_type: 'stables',
            leadlock_category: 'stables'
        });

        const order = await ProductionDatabase.createLeadLockWorkOrder({
            order_number: 'TST-001',
            order_id: 'll-bespoke-001',
            customer_name: 'Test Customer',
            items: [
                {
                    product_id: catalog.id,
                    product_name: 'Test Stable WO',
                    quantity: 1,
                    description: 'Matched',
                    unit_price: 100,
                    install_hours: 1,
                    number_of_boxes: 1
                },
                {
                    product_name: 'Custom Bespoke Field Shelter',
                    quantity: 2,
                    description: 'One-off',
                    unit_price: 5000,
                    install_hours: 4,
                    number_of_boxes: 2
                }
            ],
            total_amount: 5100,
            currency: 'GBP'
        });

        let setup = await ProductionDatabase.getOrderProductionSetup(order.id);
        assert.equal(setup.sales_only_count, 1);
        assert.equal(setup.leadlock_items.length, 2);
        const salesOnly = setup.leadlock_items.find((i) => i.is_sales_only);
        assert.ok(salesOnly);

        const loadBefore = await ProductionDatabase.getLoadSheet(order.id);
        assert.equal(loadBefore.sales_only_lines.length, 1);

        const bespoke = await ProductionDatabase.createBespokeProductFromLeadlockItem(
            order.id,
            salesOnly.id,
            { name: 'Custom Bespoke Field Shelter', description: 'One-off' }
        );
        assert.ok(bespoke.product.id);

        setup = await ProductionDatabase.getOrderProductionSetup(order.id);
        assert.equal(setup.sales_only_count, 0);

        const loadAfter = await ProductionDatabase.getLoadSheet(order.id);
        assert.equal(loadAfter.sales_only_lines.length, 0);

        setup = await ProductionDatabase.getOrderProductionSetup(order.id);
        assert.ok(setup.order_products.length >= 2);
    });

    it('upserts order_products by product_id', async () => {
        const p = await ProductionDatabase.createProduct({
            name: 'Upsert Product',
            product_type: 'sheds',
            leadlock_category: 'sheds'
        });
        const order = await ProductionDatabase.createProductOrder({
            order_date: '2026-05-27',
            products: [{ product_id: p.id, quantity: 1 }]
        });

        await ProductionDatabase.addProductToOrder(order.id, p.id, 3);
        const lines = await ProductionDatabase.getOrderProducts(order.id);
        const forProduct = lines.filter((r) => parseInt(r.product_id, 10) === p.id);
        assert.equal(forProduct.length, 1);
        assert.equal(parseInt(forProduct[0].quantity, 10), 3);
    });

    it('deducts stock for all order_products when order completes', async () => {
        const stock = await ProductionDatabase.createStockItem({
            name: 'WO Test Timber',
            unit: 'm',
            current_quantity: 100,
            min_quantity: 0,
            location: 'Yard'
        });

        const productA = await ProductionDatabase.createProduct({
            name: 'WO Product A',
            product_type: 'sheds',
            leadlock_category: 'sheds'
        });
        const productB = await ProductionDatabase.createProduct({
            name: 'WO Product B',
            product_type: 'sheds',
            leadlock_category: 'sheds'
        });

        await ProductionDatabase.addProductComponent(
            productA.id,
            'raw_material',
            stock.id,
            2,
            'm'
        );
        await ProductionDatabase.addProductComponent(
            productB.id,
            'raw_material',
            stock.id,
            3,
            'm'
        );

        const order = await ProductionDatabase.createProductOrder({
            order_date: '2026-05-27',
            status: 'pending',
            products: [
                { product_id: productA.id, quantity: 2 },
                { product_id: productB.id, quantity: 1 }
            ]
        });

        const beforeQty = parseFloat(stock.current_quantity);
        const lines = await ProductionDatabase.getOrderProducts(order.id);
        assert.equal(lines.length, 2);

        await ProductionDatabase.deductStockForCompletedOrder(order.id, null);

        const updatedStock = await ProductionDatabase.getStockItemById(stock.id);
        const remaining = parseFloat(updatedStock.current_quantity);
        const expectedDeducted = 2 * 2 + 3 * 1; // (BOM per A × order qty 2) + (BOM per B × order qty 1)
        assert.ok(
            Math.abs(remaining - (beforeQty - expectedDeducted)) < 0.01,
            `Expected ${beforeQty - expectedDeducted} remaining, got ${remaining} (deducted ${beforeQty - remaining})`
        );
    });

    it('updateProductOrder completed status triggers multi-line stock deduction', async () => {
        const stock = await ProductionDatabase.createStockItem({
            name: 'WO Complete Trigger Timber',
            unit: 'm',
            current_quantity: 50,
            min_quantity: 0,
            location: 'Yard'
        });
        const product = await ProductionDatabase.createProduct({
            name: 'WO Complete Trigger Product',
            product_type: 'sheds',
            leadlock_category: 'sheds'
        });
        await ProductionDatabase.addProductComponent(
            product.id,
            'raw_material',
            stock.id,
            5,
            'm'
        );
        const order = await ProductionDatabase.createProductOrder({
            order_date: '2026-05-28',
            status: 'pending',
            products: [{ product_id: product.id, quantity: 2 }]
        });
        const beforeQty = parseFloat(stock.current_quantity);
        await ProductionDatabase.updateProductOrder(order.id, { status: 'completed' });
        const after = parseFloat((await ProductionDatabase.getStockItemById(stock.id)).current_quantity);
        assert.ok(Math.abs(after - (beforeQty - 10)) < 0.01, `Expected ${beforeQty - 10}, got ${after}`);
    });
});
