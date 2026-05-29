const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const WEBHOOK_KEY = 'test-leadlock-http-key';

function loadApp() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadlock-wh-http-'));
    process.env.DATABASE_PATH = path.join(tmpDir, 'leads.db');
    process.env.LEADLOCK_WEBHOOK_API_KEY = WEBHOOK_KEY;
    for (const mod of ['../database-pg', '../production-database', '../production-routes']) {
        try {
            delete require.cache[require.resolve(mod)];
        } catch (e) {
            /* first load */
        }
    }
    const app = express();
    app.use(express.json());
    app.use('/production/api', require('../production-routes'));
    return app;
}

describe('POST /production/api/webhooks/work-orders', () => {
    /** @type {import('http').Server} */
    let server;
    let baseUrl;

    before(async () => {
        const app = loadApp();
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}/production/api/webhooks/work-orders`;
    });

    after(async () => {
        if (!server) return;
        await new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });

    it('returns 401 without Bearer token', async () => {
        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [] })
        });
        assert.equal(res.status, 401);
    });

    it('returns 400 when items is not an array', async () => {
        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${WEBHOOK_KEY}`
            },
            body: JSON.stringify({ order_id: 1, items: {} })
        });
        assert.equal(res.status, 400);
    });

    it('creates work order with 200 and work_order_id', async () => {
        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${WEBHOOK_KEY}`
            },
            body: JSON.stringify({
                order_number: 'ORD-HTTP-001',
                order_id: 88001,
                fulfillment_method: 'collection',
                customer_name: 'HTTP Test',
                customer_postcode: '',
                customer_address: '',
                items: [],
                total_amount: 500,
                currency: 'GBP',
                deposit_paid: true,
                balance_paid: false,
                paid_in_full: false,
                deposit_amount: 250,
                balance_amount: 250,
                invoice_number: null
            })
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(data.work_order_id);
        assert.equal(data.updated, false);
    });
});
