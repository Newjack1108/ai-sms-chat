const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeLeadLockDate,
    buildStatusPayload,
    resolveLeadLockConfig,
    pushStatusToLeadLock,
} = require('../leadlock-status-push');

describe('normalizeLeadLockDate', () => {
    it('returns null for empty values', () => {
        assert.equal(normalizeLeadLockDate(null), null);
        assert.equal(normalizeLeadLockDate(''), null);
        assert.equal(normalizeLeadLockDate(undefined), null);
    });

    it('keeps date-only values as midnight local ISO-like strings', () => {
        assert.equal(normalizeLeadLockDate('2026-08-15'), '2026-08-15T00:00:00');
    });

    it('normalizes space-separated datetime to T separator', () => {
        assert.equal(normalizeLeadLockDate('2026-08-15 09:30:00'), '2026-08-15T09:30:00');
    });
});

describe('buildStatusPayload', () => {
    it('requires a numeric order id', () => {
        assert.throws(() => buildStatusPayload({}), /order_id is required/);
        assert.throws(() => buildStatusPayload({ orderId: 'abc' }), /order_id is required/);
    });

    it('builds booked payload and implies installation_booked', () => {
        const payload = buildStatusPayload({
            orderId: '42',
            installationScheduledAt: '2026-08-15',
            installationScheduledEndAt: '2026-08-16',
        });
        assert.deepEqual(payload, {
            order_id: 42,
            installation_booked: true,
            installation_scheduled_at: '2026-08-15T00:00:00',
            installation_scheduled_end_at: '2026-08-16T00:00:00',
        });
    });

    it('builds completed payload', () => {
        const payload = buildStatusPayload({
            orderId: 7,
            installationCompleted: true,
        });
        assert.deepEqual(payload, {
            order_id: 7,
            installation_completed: true,
        });
    });

    it('respects explicit installation_booked false with a date', () => {
        const payload = buildStatusPayload({
            orderId: 1,
            installationBooked: false,
            installationScheduledAt: '2026-08-15',
        });
        assert.equal(payload.installation_booked, false);
        assert.equal(payload.installation_scheduled_at, '2026-08-15T00:00:00');
    });
});

describe('resolveLeadLockConfig', () => {
    it('reads base URL and shared key', () => {
        const cfg = resolveLeadLockConfig({
            LEADLOCK_API_URL: 'https://leadlock.example/',
            LEADLOCK_WEBHOOK_API_KEY: 'secret',
        });
        assert.equal(cfg.baseUrl, 'https://leadlock.example/');
        assert.equal(cfg.apiKey, 'secret');
    });
});

describe('pushStatusToLeadLock', () => {
    it('fails clearly when not configured', async () => {
        await assert.rejects(
            () => pushStatusToLeadLock(
                { orderId: 1, installationCompleted: true },
                { env: {} }
            ),
            (err) => err.code === 'NOT_CONFIGURED' && err.statusCode === 503
        );
    });

    it('posts payload with bearer auth', async () => {
        let seen;
        const fakeFetch = async (url, options) => {
            seen = { url, options };
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ success: true, updated: true }),
            };
        };
        const result = await pushStatusToLeadLock(
            { orderId: 99, installationCompleted: true },
            {
                fetchImpl: fakeFetch,
                env: {
                    LEADLOCK_API_URL: 'https://leadlock.example',
                    LEADLOCK_WEBHOOK_API_KEY: 'shared-key',
                },
            }
        );
        assert.equal(seen.url, 'https://leadlock.example/api/webhooks/work-orders/status');
        assert.equal(seen.options.method, 'POST');
        assert.equal(seen.options.headers.Authorization, 'Bearer shared-key');
        assert.deepEqual(JSON.parse(seen.options.body), {
            order_id: 99,
            installation_completed: true,
        });
        assert.equal(result.result.updated, true);
    });

    it('maps non-2xx to LEADLOCK_HTTP error', async () => {
        const fakeFetch = async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: async () => JSON.stringify({ detail: 'Order 99 not found' }),
        });
        await assert.rejects(
            () => pushStatusToLeadLock(
                { orderId: 99, installationCompleted: true },
                {
                    fetchImpl: fakeFetch,
                    env: {
                        LEADLOCK_API_URL: 'https://leadlock.example',
                        LEADLOCK_WEBHOOK_API_KEY: 'shared-key',
                    },
                }
            ),
            (err) => err.code === 'LEADLOCK_HTTP' && err.statusCode === 502
        );
    });
});
