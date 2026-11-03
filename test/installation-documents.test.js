const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    canManageInstallationDocuments,
    validateInstallationDocumentUpload,
    sanitizeDocumentFileName
} = require('../installation-documents');

function dataUrl(mime, payload = 'hello') {
    return `data:${mime};base64,${Buffer.from(payload).toString('base64')}`;
}

describe('canManageInstallationDocuments', () => {
    it('allows managers who schedule and run jobs', () => {
        assert.equal(canManageInstallationDocuments('admin'), true);
        assert.equal(canManageInstallationDocuments('supervisor'), true);
        assert.equal(canManageInstallationDocuments('manager'), true);
    });

    it('keeps upload off for office, installers, and staff', () => {
        assert.equal(canManageInstallationDocuments('office'), false);
        assert.equal(canManageInstallationDocuments('installer'), false);
        assert.equal(canManageInstallationDocuments('staff'), false);
        assert.equal(canManageInstallationDocuments(undefined), false);
    });
});

describe('validateInstallationDocumentUpload', () => {
    it('accepts a PDF plan and keeps a safe file name', () => {
        const result = validateInstallationDocumentUpload({
            category: 'plan',
            file_name: 'Site plan (rev 2).pdf',
            file_data_url: dataUrl('application/pdf', '%PDF-1.4')
        });
        assert.equal(result.ok, true);
        assert.equal(result.mimeType, 'application/pdf');
        assert.equal(result.fileName, 'Site plan (rev 2).pdf');
    });

    it('accepts a site picture', () => {
        const result = validateInstallationDocumentUpload({
            category: 'site_picture',
            file_name: 'gate.jpg',
            file_data_url: dataUrl('image/jpeg', 'jpeg-bytes')
        });
        assert.equal(result.ok, true);
        assert.equal(result.fileName, 'gate.jpg');
    });

    it('rejects a PDF uploaded as a site picture', () => {
        const result = validateInstallationDocumentUpload({
            category: 'site_picture',
            file_name: 'plan.pdf',
            file_data_url: dataUrl('application/pdf', '%PDF')
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /image/i);
    });

    it('rejects an unknown category and a non-data URL', () => {
        assert.equal(validateInstallationDocumentUpload({
            category: 'other',
            file_name: 'a.pdf',
            file_data_url: dataUrl('application/pdf')
        }).ok, false);
        assert.equal(validateInstallationDocumentUpload({
            category: 'plan',
            file_name: 'a.pdf',
            file_data_url: 'https://example.com/a.pdf'
        }).ok, false);
    });

    it('rejects files over 12 MB', () => {
        const tooBig = Buffer.alloc(12 * 1024 * 1024 + 1, 1);
        const result = validateInstallationDocumentUpload({
            category: 'plan',
            file_name: 'huge.pdf',
            file_data_url: `data:application/pdf;base64,${tooBig.toString('base64')}`
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /12 MB/);
    });

    it('strips path characters from the stored name', () => {
        assert.equal(sanitizeDocumentFileName('C:\\plans\\layout.pdf', 'application/pdf'), 'layout.pdf');
        assert.equal(sanitizeDocumentFileName('', 'image/png'), 'document.png');
    });
});
