/**
 * Grok bot role: read and edit catalog basics, nothing else.
 * Run: node test/bot-role.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    requireAdminOfficeOrSupervisor,
    requireBasicsEditor,
    restrictBotToBasics,
    isBotBasicsAllowed
} = require('../production-auth');

function mockRes() {
    return {
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
}

function runMiddleware(mw, role, method, reqPath) {
    const req = {
        method: method || 'GET',
        path: reqPath || '/products',
        session: role ? { production_user: { id: 1, username: 'grok', role } } : {}
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

test('bot can read and edit catalog basics', () => {
    const allowed = [
        ['GET', '/me'],
        ['POST', '/logout'],
        ['GET', '/wip'],
        ['GET', '/settings/labour_rate_per_hour'],
        ['GET', '/stock'],
        ['POST', '/stock'],
        ['PUT', '/stock/4'],
        ['DELETE', '/stock/4'],
        ['GET', '/stock/4/movements'],
        ['PUT', '/stock/4/suppliers'],
        ['GET', '/components'],
        ['POST', '/components'],
        ['POST', '/components/2/bom'],
        ['DELETE', '/components/2/bom/9'],
        ['GET', '/panels'],
        ['POST', '/panels/3/duplicate'],
        ['GET', '/products'],
        ['GET', '/products/export'],
        ['PUT', '/products/8'],
        ['POST', '/products/8/components'],
        ['POST', '/products/8/cost/refresh'],
        ['POST', '/suppliers'],
        ['DELETE', '/suppliers/1']
    ];
    for (const [method, reqPath] of allowed) {
        assert.strictEqual(isBotBasicsAllowed(method, reqPath), true, method + ' ' + reqPath);
        const { nextCalled, res } = runMiddleware(restrictBotToBasics, 'bot', method, reqPath);
        assert.strictEqual(nextCalled, true, method + ' ' + reqPath);
        assert.strictEqual(res.statusCode, 200);
    }
});

test('bot cannot reach payroll, users, orders, movements, or sales push', () => {
    const denied = [
        ['GET', '/users'],
        ['GET', '/clock/payroll/2026-11-16'],
        ['POST', '/orders'],
        ['PUT', '/orders/338'],
        ['PATCH', '/orders/338/flags'],
        ['POST', '/orders/338/acknowledge'],
        ['POST', '/orders/338/spares'],
        ['GET', '/orders/338/leadlock/status-sync'],
        ['GET', '/orders/338/install-cost'],
        ['GET', '/orders/338/installations'],
        ['POST', '/purchase-orders'],
        ['POST', '/stock/4/movement'],
        ['POST', '/components/2/movement'],
        ['POST', '/panels/3/movement'],
        ['POST', '/products/8/push-to-sales'],
        ['POST', '/products/push-to-sales-bulk'],
        ['PUT', '/products/8/management-checked'],
        ['GET', '/settings'],
        ['POST', '/installations']
    ];
    for (const [method, reqPath] of denied) {
        assert.strictEqual(isBotBasicsAllowed(method, reqPath), false, method + ' ' + reqPath);
        const { nextCalled, res } = runMiddleware(restrictBotToBasics, 'bot', method, reqPath);
        assert.strictEqual(nextCalled, false, method + ' ' + reqPath);
        assert.strictEqual(res.statusCode, 403);
    }
});

test('bot can GET order read endpoints only', () => {
    const allowed = ['/orders', '/orders/for-select', '/orders/338', '/orders/338/products',
        '/orders/338/load-sheet', '/orders/338/production-setup', '/orders/338/spares'];
    for (const reqPath of allowed) {
        assert.strictEqual(isBotBasicsAllowed('GET', reqPath), true, reqPath);
        const { nextCalled } = runMiddleware(restrictBotToBasics, 'bot', 'GET', reqPath);
        assert.strictEqual(nextCalled, true, reqPath);
    }
});

test('restrictBotToBasics leaves other roles alone', () => {
    for (const role of ['admin', 'office', 'supervisor', 'staff', 'installer']) {
        const { nextCalled } = runMiddleware(restrictBotToBasics, role, 'GET', '/users');
        assert.strictEqual(nextCalled, true, role);
    }
});

test('requireBasicsEditor allows bot and existing catalog editors', () => {
    for (const role of ['admin', 'office', 'supervisor', 'bot']) {
        const { nextCalled, res } = runMiddleware(requireBasicsEditor, role);
        assert.strictEqual(nextCalled, true, role);
        assert.strictEqual(res.statusCode, 200);
    }
});

test('requireBasicsEditor denies staff and installer', () => {
    for (const role of ['staff', 'installer']) {
        const { nextCalled, res } = runMiddleware(requireBasicsEditor, role);
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 403);
    }
});

test('payroll middleware still denies bot', () => {
    const { nextCalled, res } = runMiddleware(requireAdminOfficeOrSupervisor, 'bot');
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
});

test('user form offers Grok Bot and routes accept the role', () => {
    const root = path.join(__dirname, '..');
    const users = fs.readFileSync(path.join(root, 'public', 'production', 'users.html'), 'utf8');
    const routes = fs.readFileSync(path.join(root, 'production-routes.js'), 'utf8');
    const db = fs.readFileSync(path.join(root, 'production-database.js'), 'utf8');
    assert.ok(users.includes('value="bot"'), 'users form should offer bot');
    assert.ok(users.includes('Grok Bot'), 'users form should label the role');
    assert.ok(routes.includes("'bot'"), 'routes should accept bot');
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(server.includes("role === 'bot'"), 'server should special-case the bot role');
    assert.ok(server.includes("redirect('/production/products.html')"), 'bot should land on products');
    assert.ok(db.includes("'bot'"), 'database constraint should include bot');
    assert.ok(
        /router\.post\('\/products',\s*requireProductionAuth,\s*requireBasicsEditor/.test(routes),
        'product create should allow the bot editor'
    );
    assert.ok(
        /router\.get\('\/clock\/payroll\/:weekStart',\s*requireProductionAuth,\s*requireAdminOfficeOrSupervisor/.test(routes),
        'payroll must stay closed to the bot'
    );
    assert.ok(
        /router\.post\('\/products\/:id\/push-to-sales',\s*requireProductionAuth,\s*requireAdminOfficeOrSupervisor/.test(routes),
        'sales push must stay closed to the bot'
    );
});

test('catalog pages let the bot edit basics and hide movements', () => {
    const root = path.join(__dirname, '..', 'public', 'production');
    const common = fs.readFileSync(path.join(root, 'common.js'), 'utf8');
    const products = fs.readFileSync(path.join(root, 'products.html'), 'utf8');
    const stock = fs.readFileSync(path.join(root, 'stock.html'), 'utf8');
    const components = fs.readFileSync(path.join(root, 'components.html'), 'utf8');
    const panels = fs.readFileSync(path.join(root, 'panels.html'), 'utf8');
    assert.ok(common.includes("role === 'bot'"), 'common.js should know the bot role');
    assert.ok(common.includes('function canEditBasics'), 'basics edit helper');
    assert.ok(products.includes('basics-edit'), 'add product visible to bot');
    assert.ok(products.includes('hide-from-bot'), 'bulk sales push hidden from bot');
    assert.ok(stock.includes("currentUser.role !== 'bot'"), 'stock movements hidden from bot');
    assert.ok(components.includes('canEditBuiltBasics'), 'component edits include bot');
    assert.ok(panels.includes('canEditBuiltBasics'), 'built item edits include bot');
    assert.ok(
        /function canAccessPayroll\(user\)[\s\S]*?return user\.role === 'admin' \|\| user\.role === 'supervisor'/.test(common),
        'payroll helper must not include bot'
    );
});
