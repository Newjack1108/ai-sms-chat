const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { toE164Phone, buildSignoffSmsBody } = require('../signoff-sms');

describe('toE164Phone', () => {
    it('returns null for empty values', () => {
        assert.equal(toE164Phone(null), null);
        assert.equal(toE164Phone(''), null);
        assert.equal(toE164Phone('   '), null);
        assert.equal(toE164Phone('abc'), null);
    });

    it('converts UK mobiles that start with 0', () => {
        assert.equal(toE164Phone('07809 505864'), '+447809505864');
        assert.equal(toE164Phone('07809505864'), '+447809505864');
    });

    it('accepts numbers that already include a country code', () => {
        assert.equal(toE164Phone('+447809505864'), '+447809505864');
        assert.equal(toE164Phone('447809505864'), '+447809505864');
        assert.equal(toE164Phone('00447809505864'), '+447809505864');
    });

    it('adds +44 to a mobile written without the leading 0', () => {
        assert.equal(toE164Phone('7809505864'), '+447809505864');
    });

    it('rejects numbers that are too short to text', () => {
        assert.equal(toE164Phone('12345'), null);
        assert.equal(toE164Phone('07'), null);
    });
});

describe('buildSignoffSmsBody', () => {
    it('includes the sign-off link', () => {
        const url = 'https://example.com/production/installation-completion-signoff.html?token=abc';
        assert.equal(buildSignoffSmsBody(url), `Please sign off your installation: ${url}`);
    });
});
