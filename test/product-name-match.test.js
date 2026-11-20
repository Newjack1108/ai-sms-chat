const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadProductionDatabase() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'name-match-db-'));
    process.env.DATABASE_PATH = path.join(tmpDir, 'leads.db');
    for (const mod of ['../database-pg', '../production-database']) {
        try { delete require.cache[require.resolve(mod)]; } catch (e) { /* first load */ }
    }
    return require('../production-database').ProductionDatabase;
}

const ProductionDatabase = loadProductionDatabase();

describe('LeadLock product name matching', () => {
    it('matches active products by name but never inactive ones', async () => {
        const active = await ProductionDatabase.createProduct({ name: 'Name Match Active', status: 'active' });
        const inactive = await ProductionDatabase.createProduct({ name: 'Name Match Inactive', status: 'inactive' });
        const a = await ProductionDatabase.getProductByName('name match active');
        assert.equal(a && a.id, active.id);
        assert.equal(await ProductionDatabase.getProductByName('Name Match Inactive'), null);
        const byId = await ProductionDatabase.resolveProductFromLeadlockItem({ product_id: inactive.id });
        assert.equal(byId && byId.id, inactive.id);
    });
});
