const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadProductionDatabase() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-wo-ack-'));
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

describe('Product order production acknowledgment', () => {

    it('new order has is_new until acknowledged', async () => {
        const product = await ProductionDatabase.createProduct({
            name: 'Ack Test Product',
            description: 'Test',
            product_type: 'stables',
            leadlock_category: 'stables'
        });

        const order = await ProductionDatabase.createProductOrder({
            products: [{ product_id: product.id, quantity: 1 }],
            order_date: '2026-05-29',
            status: 'pending',
            customer_name: 'Ack Customer'
        });

        const fresh = await ProductionDatabase.getProductOrderById(order.id);
        assert.equal(fresh.is_new, true);

        const { orders } = await ProductionDatabase.getProductOrdersPaged({
            page: 1,
            pageSize: 25,
            quoteOnly: false
        });
        const listed = orders.find((o) => o.id === order.id);
        assert.ok(listed);
        assert.equal(listed.is_new, true);
    });

    it('acknowledgeProductOrder clears is_new', async () => {
        const product = await ProductionDatabase.createProduct({
            name: 'Ack Test Product 2',
            description: 'Test',
            product_type: 'stables',
            leadlock_category: 'stables'
        });

        const order = await ProductionDatabase.createProductOrder({
            products: [{ product_id: product.id, quantity: 1 }],
            order_date: '2026-05-29',
            status: 'pending',
            customer_name: 'Ack Customer 2'
        });

        await ProductionDatabase.acknowledgeProductOrder(order.id);
        const after = await ProductionDatabase.getProductOrderById(order.id);
        assert.equal(after.is_new, false);
        assert.ok(after.production_acknowledged_at);

        await ProductionDatabase.acknowledgeProductOrder(order.id);
        const again = await ProductionDatabase.getProductOrderById(order.id);
        assert.equal(again.production_acknowledged_at, after.production_acknowledged_at);
    });

    it('updateProductOrder acknowledges the order', async () => {
        const product = await ProductionDatabase.createProduct({
            name: 'Ack Test Product 3',
            description: 'Test',
            product_type: 'stables',
            leadlock_category: 'stables'
        });

        const order = await ProductionDatabase.createProductOrder({
            products: [{ product_id: product.id, quantity: 1 }],
            order_date: '2026-05-29',
            status: 'pending',
            customer_name: 'Ack Customer 3'
        });

        assert.equal((await ProductionDatabase.getProductOrderById(order.id)).is_new, true);

        await ProductionDatabase.updateProductOrder(order.id, {
            workflow_flags: ['on_hold']
        });

        const updated = await ProductionDatabase.getProductOrderById(order.id);
        assert.equal(updated.is_new, false);
    });
});
