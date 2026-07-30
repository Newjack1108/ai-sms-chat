/**
 * Push install booked / completed status from production → LeadLock.
 */

function optionalString(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    return s === '' ? null : s;
}

/**
 * Normalize a date/datetime value to an ISO string LeadLock accepts.
 * Date-only values (YYYY-MM-DD) become midnight UTC.
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function normalizeLeadLockDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        return value.toISOString();
    }
    const s = String(value).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return `${s}T00:00:00`;
    }
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) {
        // Pass through if already ISO-like; LeadLock will validate.
        return s;
    }
    // Keep local date-time string form without forcing Z when input had no offset
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
        return s.replace(' ', 'T');
    }
    return parsed.toISOString();
}

/**
 * Build the status webhook payload.
 * @param {{
 *   orderId: number|string,
 *   installationBooked?: boolean,
 *   installationScheduledAt?: string|Date|null,
 *   installationScheduledEndAt?: string|Date|null,
 *   installationCompleted?: boolean,
 *   depositPaid?: boolean,
 *   balancePaid?: boolean,
 *   paidInFull?: boolean
 * }} opts
 */
function buildStatusPayload(opts) {
    const orderIdRaw = opts && opts.orderId;
    const orderId = Number(orderIdRaw);
    if (!Number.isFinite(orderId) || orderId < 1) {
        const err = new Error('LeadLock order_id is required');
        err.code = 'MISSING_ORDER_ID';
        throw err;
    }

    const payload = { order_id: orderId };

    if (opts.installationBooked !== undefined) {
        payload.installation_booked = !!opts.installationBooked;
    }
    if (opts.installationScheduledAt !== undefined) {
        const start = normalizeLeadLockDate(opts.installationScheduledAt);
        if (start) payload.installation_scheduled_at = start;
    }
    if (opts.installationScheduledEndAt !== undefined) {
        const end = normalizeLeadLockDate(opts.installationScheduledEndAt);
        if (end) payload.installation_scheduled_end_at = end;
    }
    if (opts.installationCompleted !== undefined) {
        payload.installation_completed = !!opts.installationCompleted;
    }
    if (opts.depositPaid !== undefined) {
        payload.deposit_paid = !!opts.depositPaid;
    }
    if (opts.balancePaid !== undefined) {
        payload.balance_paid = !!opts.balancePaid;
    }
    if (opts.paidInFull !== undefined) {
        payload.paid_in_full = !!opts.paidInFull;
    }

    // Sending a date implies booked unless explicitly false
    if (
        payload.installation_scheduled_at &&
        opts.installationBooked === undefined
    ) {
        payload.installation_booked = true;
    }

    // Balance paid / paid in full imply the full paid set (matches LeadLock reconcile)
    if (payload.balance_paid === true || payload.paid_in_full === true) {
        payload.deposit_paid = true;
        payload.balance_paid = true;
        payload.paid_in_full = true;
    } else if (payload.deposit_paid === true && payload.balance_paid === true) {
        payload.paid_in_full = true;
    }

    return payload;
}

function resolveLeadLockConfig(env = process.env) {
    const baseUrl = optionalString(env.LEADLOCK_API_URL);
    const apiKey = optionalString(env.LEADLOCK_WEBHOOK_API_KEY)
        || optionalString(env.SALES_APP_WEBHOOK_API_KEY);
    return { baseUrl, apiKey };
}

/**
 * POST status update to LeadLock.
 * @param {object} opts Same as buildStatusPayload
 * @param {{ fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [options]
 */
async function pushStatusToLeadLock(opts, options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || fetch;
    const { baseUrl, apiKey } = resolveLeadLockConfig(env);

    if (!baseUrl) {
        const err = new Error('LeadLock not configured. Set LEADLOCK_API_URL in environment.');
        err.code = 'NOT_CONFIGURED';
        err.statusCode = 503;
        throw err;
    }
    if (!apiKey) {
        const err = new Error('LeadLock not configured. Set LEADLOCK_WEBHOOK_API_KEY in environment.');
        err.code = 'NOT_CONFIGURED';
        err.statusCode = 503;
        throw err;
    }

    const payload = buildStatusPayload(opts);
    const url = `${baseUrl.replace(/\/+$/, '')}/api/webhooks/work-orders/status`;

    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        const err = new Error(
            error?.cause?.code === 'ENOTFOUND' || error?.cause?.code === 'ECONNREFUSED'
                ? 'Cannot reach LeadLock. Check LEADLOCK_API_URL.'
                : (error.message || 'Failed to reach LeadLock')
        );
        err.code = 'NETWORK';
        err.statusCode = 503;
        err.cause = error;
        throw err;
    }

    const text = await response.text().catch(() => '');
    let result = {};
    try {
        result = text ? JSON.parse(text) : {};
    } catch {
        result = { raw: text };
    }

    if (!response.ok) {
        const detail = result.detail || result.error || text || response.statusText;
        const err = new Error(`LeadLock returned ${response.status}: ${detail}`);
        err.code = 'LEADLOCK_HTTP';
        err.statusCode = 502;
        err.leadlockStatus = response.status;
        err.leadlockBody = result;
        throw err;
    }

    return { payload, result, status: response.status };
}

module.exports = {
    normalizeLeadLockDate,
    buildStatusPayload,
    resolveLeadLockConfig,
    pushStatusToLeadLock,
};
