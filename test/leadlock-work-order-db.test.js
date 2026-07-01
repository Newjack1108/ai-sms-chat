const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    normalizeLeadLockWebhookPayload,
    handleLeadLockWorkOrderWebhook
} = require('../leadlock-work-order');

function loadProductionDatabase() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadlock-wh-db-'));
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

describe('LeadLock work order database ingest', () => {
    it('persists payment, alternate delivery, and travel time on create', async () => {
        const body = {
            order_number: 'ORD-DB-001',
            order_id: 9001,
            fulfillment_method: 'delivery',
            customer_name: 'DB Test',
            customer_postcode: 'CH1 1AA',
            customer_address: 'Site Lane',
            items: [],
            total_amount: 1000,
            currency: 'GBP',
            deposit_paid: true,
            balance_paid: false,
            paid_in_full: false,
            deposit_amount: 500,
            balance_amount: 500,
            invoice_number: 'INV-DB-001',
            travel_time_hours_round_trip: 3,
            address_is_delivery_location: true,
            delivery_location_notes: 'Gate code 1234',
            crm_customer_address: '1 CRM Street'
        };
        const payload = normalizeLeadLockWebhookPayload(body);
        const { order, updated } = await handleLeadLockWorkOrderWebhook(payload, ProductionDatabase);
        assert.equal(updated, false);

        const row = await ProductionDatabase.getProductOrderById(order.id);
        assert.equal(row.fulfillment_method, 'delivery');
        assert.equal(row.invoice_number, 'INV-DB-001');
        assert.equal(parseFloat(row.travel_time_hours_round_trip), 3);
        assert.equal(row.address_is_delivery_location, 1);
        assert.equal(row.delivery_location_notes, 'Gate code 1234');
        assert.equal(row.crm_customer_address, '1 CRM Street');
    });

    it('persists what3words on create and update', async () => {
        const body = {
            order_number: 'ORD-DB-W3W',
            order_id: 9003,
            fulfillment_method: 'delivery',
            customer_name: 'W3W Test',
            customer_postcode: 'CH3 3CC',
            customer_address: 'Field Lane',
            items: [],
            total_amount: 1500,
            currency: 'GBP',
            what3words: '///index.home.raft'
        };
        const payload = normalizeLeadLockWebhookPayload(body);
        const { order, updated } = await handleLeadLockWorkOrderWebhook(payload, ProductionDatabase);
        assert.equal(updated, false);
        let row = await ProductionDatabase.getProductOrderById(order.id);
        assert.equal(row.what3words, 'index.home.raft');

        const updatePayload = normalizeLeadLockWebhookPayload({
            ...body,
            what3words: 'filled.count.soap'
        });
        const { updated: updatedAgain } = await handleLeadLockWorkOrderWebhook(updatePayload, ProductionDatabase);
        assert.equal(updatedAgain, true);
        row = await ProductionDatabase.getProductOrderByLeadlockOrderId(9003);
        assert.equal(row.what3words, 'filled.count.soap');
    });

    it('clears travel time when upserted as collection', async () => {
        const deliveryBody = {
            order_number: 'ORD-DB-002',
            order_id: 9002,
            fulfillment_method: 'delivery',
            customer_name: 'Collection Test',
            customer_postcode: 'CH2 2BB',
            customer_address: 'Farm Road',
            items: [],
            total_amount: 2000,
            currency: 'GBP',
            deposit_paid: true,
            travel_time_hours_round_trip: 4
        };
        const deliveryPayload = normalizeLeadLockWebhookPayload(deliveryBody);
        await handleLeadLockWorkOrderWebhook(deliveryPayload, ProductionDatabase);

        const collectionPayload = normalizeLeadLockWebhookPayload({
            ...deliveryBody,
            fulfillment_method: 'collection',
            travel_time_hours_round_trip: 99
        });
        const { updated } = await handleLeadLockWorkOrderWebhook(collectionPayload, ProductionDatabase);
        assert.equal(updated, true);

        const row = await ProductionDatabase.getProductOrderByLeadlockOrderId(9002);
        assert.equal(row.fulfillment_method, 'collection');
        assert.equal(row.travel_time_hours_round_trip, null);
    });
});
