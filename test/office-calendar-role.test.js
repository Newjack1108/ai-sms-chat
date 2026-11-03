/**
 * Smoke checks for office calendar-only access.
 * Run: node test/office-calendar-role.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    restrictOfficeToCalendarBooking,
    isOfficeCalendarAllowed,
    requireAdminOfficeOrSupervisor
} = require('../production-auth');

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
    return res;
}

function runMiddleware(mw, role, method = 'GET', reqPath = '/') {
    const req = {
        method,
        path: reqPath,
        session: role
            ? { production_user: { id: 1, username: 'u', role } }
            : {}
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
        nextCalled = true;
    });
    return { res, nextCalled };
}

function test(name, fn) {
    try {
        fn();
        console.log('✓', name);
    } catch (e) {
        console.error('✗', name);
        console.error(e.message);
        process.exitCode = 1;
    }
}

test('isOfficeCalendarAllowed allows calendar booking endpoints', () => {
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/me'), true);
    assert.strictEqual(isOfficeCalendarAllowed('POST', '/logout'), true);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/installations'), true);
    assert.strictEqual(isOfficeCalendarAllowed('POST', '/installations'), true);
    assert.strictEqual(isOfficeCalendarAllowed('POST', '/installations/check-availability'), true);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/orders/for-select'), true);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/users'), true);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/holidays/calendar'), true);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/installations/42'), true);
});

test('isOfficeCalendarAllowed denies payroll and nested installation routes', () => {
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/clock/payroll/2026-01-05'), false);
    assert.strictEqual(isOfficeCalendarAllowed('PUT', '/installations/42'), false);
    assert.strictEqual(isOfficeCalendarAllowed('DELETE', '/installations/42'), false);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/installations/42/checklists'), false);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/installations/42/documents'), false);
    assert.strictEqual(isOfficeCalendarAllowed('POST', '/installations/42/documents'), false);
    assert.strictEqual(isOfficeCalendarAllowed('DELETE', '/installations/42/documents/7'), false);
    assert.strictEqual(isOfficeCalendarAllowed('GET', '/orders/1/load-sheet'), false);
    assert.strictEqual(isOfficeCalendarAllowed('POST', '/stock'), false);
});

test('restrictOfficeToCalendarBooking allows office on calendar create path', () => {
    const { nextCalled, res } = runMiddleware(
        restrictOfficeToCalendarBooking,
        'office',
        'POST',
        '/installations'
    );
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, 200);
});

test('restrictOfficeToCalendarBooking blocks office from payroll path', () => {
    const { nextCalled, res } = runMiddleware(
        restrictOfficeToCalendarBooking,
        'office',
        'GET',
        '/clock/payroll/2026-01-05'
    );
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.body && /calendar/i.test(res.body.error || ''));
});

test('restrictOfficeToCalendarBooking does not affect admin or supervisor', () => {
    for (const role of ['admin', 'supervisor', 'staff']) {
        const { nextCalled, res } = runMiddleware(
            restrictOfficeToCalendarBooking,
            role,
            'GET',
            '/clock/payroll/2026-01-05'
        );
        assert.strictEqual(nextCalled, true, role + ' should pass allowlist middleware');
        assert.strictEqual(res.statusCode, 200);
    }
});

test('admin still passes payroll route middleware (requireAdminOfficeOrSupervisor)', () => {
    const { nextCalled, res } = runMiddleware(requireAdminOfficeOrSupervisor, 'admin');
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, 200);
});

test('supervisor still passes payroll route middleware', () => {
    const { nextCalled } = runMiddleware(requireAdminOfficeOrSupervisor, 'supervisor');
    assert.strictEqual(nextCalled, true);
});

test('production-routes mounts office allowlist and payroll still uses supervisor middleware', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'production-routes.js'), 'utf8');
    assert.ok(src.includes('restrictOfficeToCalendarBooking'), 'routes should mount office allowlist');
    assert.ok(
        /router\.get\('\/clock\/payroll\/:weekStart',\s*requireProductionAuth,\s*requireAdminOfficeOrSupervisor/.test(src),
        'payroll week should still use requireAdminOfficeOrSupervisor (admin/supervisor; office blocked by allowlist)'
    );
    assert.ok(
        /router\.post\('\/installations',\s*requireProductionAuth,\s*requireManager/.test(src),
        'POST /installations should remain requireManager so office can create'
    );
});

test('common.js excludes office from payroll and clock/holiday admin helpers', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'production', 'common.js'), 'utf8');
    assert.ok(src.includes('function canAccessPayroll'), 'canAccessPayroll helper exists');
    assert.ok(
        /function canAccessPayroll\(user\)[\s\S]*?return user\.role === 'admin' \|\| user\.role === 'supervisor'/.test(src),
        'canAccessPayroll must be admin or supervisor only'
    );
    assert.ok(
        /function isClockHolidayAdmin\(user\)[\s\S]*?return user\.role === 'admin'/.test(src),
        'isClockHolidayAdmin must be admin only'
    );
    assert.ok(src.includes('restrictOfficeAccess'), 'client office redirect helper exists');
});

test('login.html sends office to installations calendar', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'production', 'login.html'),
        'utf8'
    );
    assert.ok(html.includes("role === 'office'"), 'login should branch on office role');
    assert.ok(html.includes('installations.html'), 'office login should land on calendar');
});

test('server.js redirects office HTML to installations calendar', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(src.includes("role === 'office'"), 'server should special-case office');
    assert.ok(src.includes("redirect('/production/installations.html')"), 'office should redirect to calendar');
});

test('installations.html splits canAddInstallations from canManageInstallations', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'production', 'installations.html'),
        'utf8'
    );
    assert.ok(html.includes('canAddInstallations'), 'add flag for office create');
    assert.ok(
        /canManageInstallations\s*=\s*[\s\S]*?role === 'admin'[\s\S]*?role === 'supervisor'/.test(html),
        'manage flag should not grant office full edit'
    );
    assert.ok(!/canManageInstallations\s*=\s*[\s\S]{0,200}role === 'office'/.test(html),
        'office must not be in canManageInstallations assignment');
});

if (!process.exitCode) {
    console.log('\nAll office calendar-only smoke checks passed.');
}
