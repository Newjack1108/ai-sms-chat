/**
 * LeadLock work-order webhook payload normalization and validation.
 * Shared by API routes and tests.
 */

function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return defaultValue;
}

function parseAmount(value, defaultValue = 0) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? n : defaultValue;
}

function optionalString(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    return s === '' ? null : s;
}

/**
 * @param {object} body Raw JSON body
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateLeadLockWebhookBody(body) {
    if (!body || typeof body !== 'object') {
        return { ok: false, error: 'Invalid or empty JSON body' };
    }
    if (!Array.isArray(body.items)) {
        return { ok: false, error: 'items must be an array' };
    }
    return { ok: true };
}

/**
 * Normalize webhook body with defaults for backward compatibility.
 * @param {object} body
 * @returns {object}
 */
function normalizeLeadLockWebhookPayload(body) {
    const fulfillment = body.fulfillment_method != null
        ? String(body.fulfillment_method).trim().toLowerCase()
        : null;

    return {
        order_number: body.order_number,
        order_id: body.order_id,
        fulfillment_method: fulfillment || null,
        customer_name: body.customer_name,
        customer_postcode: body.customer_postcode,
        customer_address: body.customer_address,
        customer_email: body.customer_email,
        customer_phone: body.customer_phone,
        items: Array.isArray(body.items) ? body.items : [],
        total_amount: body.total_amount,
        currency: body.currency,
        installation_booked: body.installation_booked,
        created_at: body.created_at,
        notes: body.notes == null ? '' : String(body.notes),
        travel_time_hours_round_trip: body.travel_time_hours_round_trip,
        deposit_paid: parseBool(body.deposit_paid, false),
        balance_paid: parseBool(body.balance_paid, false),
        paid_in_full: parseBool(body.paid_in_full, false),
        deposit_amount: parseAmount(body.deposit_amount, 0),
        balance_amount: parseAmount(body.balance_amount, 0),
        invoice_number: optionalString(body.invoice_number),
        address_is_delivery_location: parseBool(body.address_is_delivery_location, false),
        delivery_location_notes: body.delivery_location_notes != null ? String(body.delivery_location_notes) : null,
        crm_customer_address: optionalString(body.crm_customer_address)
    };
}

/**
 * Human-readable payment status from normalized payload or order row.
 * @param {{ deposit_paid?: boolean, balance_paid?: boolean, paid_in_full?: boolean }} data
 */
function deriveLeadLockPaymentStatusLabel(data) {
    const paidInFull = parseBool(data.paid_in_full, false);
    const depositPaid = parseBool(data.deposit_paid, false);
    const balancePaid = parseBool(data.balance_paid, false);
    if (paidInFull) return 'Paid in full';
    if (depositPaid && balancePaid) return 'Deposit and balance paid';
    if (depositPaid) return 'Deposit paid — balance outstanding';
    return 'Payment pending';
}

/**
 * @param {object} payload Normalized payload
 * @param {typeof import('./production-database.js')} ProductionDatabase
 */
async function handleLeadLockWorkOrderWebhook(payload, ProductionDatabase) {
    const existingBefore = payload.order_id != null && String(payload.order_id).trim() !== ''
        ? await ProductionDatabase.getProductOrderByLeadlockOrderId(payload.order_id)
        : null;
    const order = await ProductionDatabase.createLeadLockWorkOrder(payload);
    return {
        order,
        updated: !!existingBefore
    };
}

module.exports = {
    parseBool,
    parseAmount,
    validateLeadLockWebhookBody,
    normalizeLeadLockWebhookPayload,
    deriveLeadLockPaymentStatusLabel,
    handleLeadLockWorkOrderWebhook
};
