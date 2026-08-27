/**
 * Smoke checks for supervisor role middleware and access helpers.
 * Run: node test/supervisor-role.test.js
 */
const assert = require('assert');
const {
    requireAdmin,
    requireAdminOrOffice,
    requireAdminOfficeOrSupervisor,
    denySupervisor,
    requireManager
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

function runMiddleware(mw, role) {
    const req = {
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

test('requireAdminOfficeOrSupervisor allows admin, office, supervisor', () => {
    for (const role of ['admin', 'office', 'supervisor']) {
        const { nextCalled, res } = runMiddleware(requireAdminOfficeOrSupervisor, role);
        assert.strictEqual(nextCalled, true, role + ' should pass');
        assert.strictEqual(res.statusCode, 200);
    }
});

test('requireAdminOfficeOrSupervisor denies staff and installer', () => {
    for (const role of ['staff', 'installer']) {
        const { nextCalled, res } = runMiddleware(requireAdminOfficeOrSupervisor, role);
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 403);
    }
});

test('requireAdminOrOffice denies supervisor (clock/holiday admin)', () => {
    const { nextCalled, res } = runMiddleware(requireAdminOrOffice, 'supervisor');
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
});

test('requireAdminOrOffice allows admin and office', () => {
    for (const role of ['admin', 'office']) {
        const { nextCalled } = runMiddleware(requireAdminOrOffice, role);
        assert.strictEqual(nextCalled, true);
    }
});

test('requireAdmin denies supervisor', () => {
    const { nextCalled, res } = runMiddleware(requireAdmin, 'supervisor');
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
});

test('denySupervisor blocks supervisor only', () => {
    const blocked = runMiddleware(denySupervisor, 'supervisor');
    assert.strictEqual(blocked.nextCalled, false);
    assert.strictEqual(blocked.res.statusCode, 403);

    for (const role of ['admin', 'office', 'staff', 'installer']) {
        const { nextCalled } = runMiddleware(denySupervisor, role);
        assert.strictEqual(nextCalled, true, role + ' should pass denySupervisor');
    }
});

test('requireManager includes supervisor', () => {
    const { nextCalled } = runMiddleware(requireManager, 'supervisor');
    assert.strictEqual(nextCalled, true);
});

test('production-routes role lists include supervisor', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'production-routes.js'), 'utf8');
    assert.ok(src.includes("'supervisor'"), 'routes should mention supervisor');
    assert.ok(src.includes('requireAdminOfficeOrSupervisor'), 'should use new middleware');
    assert.ok(src.includes('denySupervisor'), 'should deny supervisor on tasks/reminders');
    // Payroll gated for supervisor
    assert.ok(
        /router\.get\('\/clock\/payroll\/:weekStart',\s*requireProductionAuth,\s*requireAdminOfficeOrSupervisor/.test(src),
        'payroll week should allow supervisor'
    );
    // Holiday approve stays admin/office
    assert.ok(
        /router\.put\('\/holidays\/requests\/:id\/approve',\s*requireProductionAuth,\s*requireAdminOrOffice/.test(src),
        'holiday approve must stay admin/office'
    );
    // NFC stays admin/office
    assert.ok(
        /router\.get\('\/clock\/nfc\/cards',\s*requireProductionAuth,\s*requireAdminOrOffice/.test(src),
        'NFC cards must stay admin/office'
    );
});

test('users.html includes supervisor option', () => {
    const fs = require('fs');
    const html = fs.readFileSync(
        require('path').join(__dirname, '..', 'public', 'production', 'users.html'),
        'utf8'
    );
    assert.ok(html.includes('value="supervisor"'), 'users form should offer supervisor');
});

test('timesheet-admin has clock-holiday-admin sections and payrollSection', () => {
    const fs = require('fs');
    const html = fs.readFileSync(
        require('path').join(__dirname, '..', 'public', 'production', 'timesheet-admin.html'),
        'utf8'
    );
    assert.ok(html.includes('clock-holiday-admin'), 'clock admin cards should be classed');
    assert.ok(html.includes('id="payrollSection"'), 'payroll section id for deep link');
    assert.ok(html.includes('canAccessPayroll'), 'init should use canAccessPayroll');
});

test('dashboard has Payroll nav and hide-from-supervisor', () => {
    const fs = require('fs');
    const html = fs.readFileSync(
        require('path').join(__dirname, '..', 'public', 'production', 'dashboard.html'),
        'utf8'
    );
    assert.ok(html.includes('payroll-access'), 'payroll nav class');
    assert.ok(html.includes('timesheet-admin.html#payroll'), 'payroll deep link');
    assert.ok(html.includes('clock-holiday-admin'), 'clock/holiday admin class');
    assert.ok(html.includes('hide-from-supervisor'), 'hide tasks/reminders');
});

test('server.js redirects supervisor from denied pages', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(src.includes("role === 'supervisor'"), 'server should special-case supervisor');
    assert.ok(src.includes('holidays-admin.html'), 'should deny holidays-admin');
    assert.ok(src.includes('nfc-admin.html'), 'should deny nfc-admin');
});

test('GET /users allows supervisor (calendar); mutations stay admin', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'production-routes.js'), 'utf8');
    assert.ok(
        /router\.get\('\/users',\s*requireProductionAuth,\s*requireAdminOfficeOrSupervisor/.test(src),
        'GET /users must allow supervisor so calendar load does not 403/logout'
    );
    assert.ok(
        /router\.post\('\/users',\s*requireProductionAuth,\s*requireAdmin/.test(src),
        'POST /users must remain admin-only'
    );
});

if (!process.exitCode) {
    console.log('\nAll supervisor role smoke checks passed.');
}
