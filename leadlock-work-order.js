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

/** First non-empty scalar from a list (for webhook field aliases). */
function firstPresentString(...values) {
    for (const value of values) {
        const s = optionalString(value);
        if (s) return s;
    }
    return null;
}

/**
 * Explicit alternate-delivery flag from webhook, or null if not sent.
 * @param {object} body
 * @returns {boolean|null}
 */
function resolveAddressIsDeliveryLocationFlag(body) {
    const explicitKeys = [
        'address_is_delivery_location',
        'address_is_delivery',
        'use_alternate_delivery_address',
        'alternate_delivery_address_set',
        'has_alternate_delivery'
    ];
    for (const key of explicitKeys) {
        if (body[key] !== undefined && body[key] !== null) {
            return parseBool(body[key], false);
        }
    }
    const delivery = body.delivery;
    if (delivery && typeof delivery === 'object') {
        if (delivery.address_is_delivery_location !== undefined && delivery.address_is_delivery_location !== null) {
            return parseBool(delivery.address_is_delivery_location, false);
        }
        if (delivery.is_alternate !== undefined && delivery.is_alternate !== null) {
            return parseBool(delivery.is_alternate, false);
        }
    }
    return null;
}

/**
 * Round-trip drive hours from LeadLock payload, or null when not applicable.
 * Collection orders never store travel time (LeadLock omits the field).
 * @param {object} payload Normalized or raw webhook payload
 * @returns {number|null}
 */
function resolveTravelTimeHoursRoundTrip(payload) {
    const fulfillment = payload.fulfillment_method != null
        ? String(payload.fulfillment_method).trim().toLowerCase()
        : '';
    if (fulfillment === 'collection') {
        return null;
    }
    const raw = payload.travel_time_hours_round_trip;
    if (raw === undefined || raw === null || raw === '') {
        return null;
    }
    const t = typeof raw === 'number' ? raw : parseFloat(raw);
    return Number.isFinite(t) ? t : null;
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

    const deliveryBlock = body.delivery && typeof body.delivery === 'object' ? body.delivery : null;
    const crmCustomerAddress = firstPresentString(
        body.crm_customer_address,
        body.billing_address,
        body.customer_billing_address,
        body.bill_to_address,
        deliveryBlock && deliveryBlock.crm_address
    );
    const deliveryLocationNotes = firstPresentString(
        body.delivery_location_notes,
        body.delivery_notes,
        body.delivery_access_notes,
        deliveryBlock && deliveryBlock.notes
    );
    const deliverySiteAddress = firstPresentString(
        body.delivery_address,
        body.delivery_location_address,
        body.alternate_delivery_address,
        deliveryBlock && deliveryBlock.address
    );
    const deliverySitePostcode = firstPresentString(
        body.delivery_postcode,
        body.delivery_location_postcode,
        deliveryBlock && deliveryBlock.postcode
    );

    let addressIsDeliveryLocation = resolveAddressIsDeliveryLocationFlag(body);
    if (addressIsDeliveryLocation === null) {
        addressIsDeliveryLocation = !!(
            crmCustomerAddress ||
            deliverySiteAddress ||
            deliverySitePostcode ||
            deliveryLocationNotes
        );
    }

    let customerAddress = body.customer_address;
    let customerPostcode = body.customer_postcode;
    if (addressIsDeliveryLocation) {
        if (deliverySiteAddress) {
            customerAddress = deliverySiteAddress;
        }
        if (deliverySitePostcode) {
            customerPostcode = deliverySitePostcode;
        }
    }

    return {
        order_number: body.order_number,
        order_id: body.order_id,
        fulfillment_method: fulfillment || null,
        customer_name: body.customer_name,
        customer_postcode: customerPostcode,
        customer_address: customerAddress,
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
        address_is_delivery_location: addressIsDeliveryLocation,
        delivery_location_notes: deliveryLocationNotes,
        crm_customer_address: crmCustomerAddress
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
    resolveTravelTimeHoursRoundTrip,
    handleLeadLockWorkOrderWebhook
};
