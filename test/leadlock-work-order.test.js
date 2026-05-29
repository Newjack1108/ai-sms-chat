const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    validateLeadLockWebhookBody,
    normalizeLeadLockWebhookPayload,
    deriveLeadLockPaymentStatusLabel,
    resolveTravelTimeHoursRoundTrip
} = require('../leadlock-work-order');

const basePayload = {
    order_number: 'ORD-2026-042',
    order_id: 42,
    fulfillment_method: 'delivery',
    customer_name: 'Jane Smith',
    customer_postcode: 'CW1 2AB',
    customer_address: '1 High Street, Chester',
    customer_email: 'jane@example.com',
    customer_phone: '07700900123',
    items: [{
        product_name: 'Stable',
        description: 'Stable',
        quantity: 1,
        unit_price: 10000,
        install_hours: 8,
        number_of_boxes: 4
    }],
    total_amount: 10000,
    currency: 'GBP',
    installation_booked: false,
    created_at: '2026-05-27T10:00:00',
    notes: 'Oak finish',
    deposit_paid: true,
    balance_paid: false,
    paid_in_full: false,
    deposit_amount: 6000,
    balance_amount: 6000,
    invoice_number: 'INV-2026-042'
};

describe('validateLeadLockWebhookBody', () => {
    it('accepts empty items array', () => {
        const body = { ...basePayload, items: [] };
        assert.equal(validateLeadLockWebhookBody(body).ok, true);
    });

    it('rejects non-array items', () => {
        const body = { ...basePayload, items: {} };
        assert.equal(validateLeadLockWebhookBody(body).ok, false);
    });
});

describe('normalizeLeadLockWebhookPayload', () => {
    it('applies payment defaults when fields omitted (backward compatible)', () => {
        const legacy = normalizeLeadLockWebhookPayload({
            order_number: 'ORD-1',
            order_id: 1,
            items: [{ product_name: 'X', quantity: 1, unit_price: 1, install_hours: 0, number_of_boxes: 1 }]
        });
        assert.equal(legacy.deposit_paid, false);
        assert.equal(legacy.balance_paid, false);
        assert.equal(legacy.paid_in_full, false);
        assert.equal(legacy.deposit_amount, 0);
        assert.equal(legacy.balance_amount, 0);
        assert.equal(legacy.invoice_number, null);

        const full = normalizeLeadLockWebhookPayload(basePayload);
        assert.equal(full.deposit_paid, true);
        assert.equal(full.balance_paid, false);
        assert.equal(full.paid_in_full, false);
        assert.equal(full.deposit_amount, 6000);
        assert.equal(full.balance_amount, 6000);
        assert.equal(full.invoice_number, 'INV-2026-042');
    });

    it('normalizes alternate delivery location fields', () => {
        const p = normalizeLeadLockWebhookPayload({
            ...basePayload,
            items: [],
            address_is_delivery_location: true,
            delivery_location_notes: 'Use rear gate',
            crm_customer_address: '1 High Street, Chester',
            customer_address: 'Farm Lane, Shrewsbury',
            balance_paid: true
        });
        assert.equal(p.address_is_delivery_location, true);
        assert.equal(p.delivery_location_notes, 'Use rear gate');
        assert.equal(p.crm_customer_address, '1 High Street, Chester');
        assert.equal(p.customer_address, 'Farm Lane, Shrewsbury');
    });

    it('normalizes collection fulfillment', () => {
        const p = normalizeLeadLockWebhookPayload({
            ...basePayload,
            fulfillment_method: 'collection',
            items: [],
            customer_address: '',
            customer_postcode: ''
        });
        assert.equal(p.fulfillment_method, 'collection');
        assert.deepEqual(p.items, []);
    });
});

describe('resolveTravelTimeHoursRoundTrip', () => {
    it('returns round trip for delivery when set', () => {
        assert.equal(
            resolveTravelTimeHoursRoundTrip({ fulfillment_method: 'delivery', travel_time_hours_round_trip: 2.5 }),
            2.5
        );
    });

    it('returns null for collection even when travel is present', () => {
        assert.equal(
            resolveTravelTimeHoursRoundTrip({ fulfillment_method: 'collection', travel_time_hours_round_trip: 2.5 }),
            null
        );
    });

    it('returns null when travel omitted', () => {
        assert.equal(resolveTravelTimeHoursRoundTrip({ fulfillment_method: 'delivery' }), null);
    });
});

describe('deriveLeadLockPaymentStatusLabel', () => {
    it('returns expected labels', () => {
        assert.equal(deriveLeadLockPaymentStatusLabel({ paid_in_full: true }), 'Paid in full');
        assert.equal(
            deriveLeadLockPaymentStatusLabel({ deposit_paid: true, balance_paid: true }),
            'Deposit and balance paid'
        );
        assert.equal(
            deriveLeadLockPaymentStatusLabel({ deposit_paid: true, balance_paid: false }),
            'Deposit paid — balance outstanding'
        );
        assert.equal(deriveLeadLockPaymentStatusLabel({}), 'Payment pending');
    });
});
