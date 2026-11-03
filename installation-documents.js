const MAX_INSTALLATION_DOCUMENT_BYTES = 12 * 1024 * 1024;

const INSTALLATION_DOCUMENT_MIME_TYPES = {
    plan: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    site_picture: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
};

const DOCUMENT_MANAGER_ROLES = new Set(['admin', 'supervisor', 'manager']);

const EXTENSION_BY_MIME = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
};

function canManageInstallationDocuments(role) {
    return DOCUMENT_MANAGER_ROLES.has(role);
}

function parseInstallationDocumentDataUrl(fileDataUrl) {
    if (typeof fileDataUrl !== 'string') return null;
    const match = /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([a-z0-9+/=\r\n]+)$/i.exec(fileDataUrl.trim());
    if (!match) return null;
    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s/g, '');
    if (!base64 || base64.length % 4 === 1) return null;
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((base64.length * 3) / 4) - padding;
    if (bytes < 0) return null;
    return { mimeType, bytes };
}

function sanitizeDocumentFileName(fileName, mimeType) {
    let name = String(fileName || '').replace(/\\/g, '/').split('/').pop().trim();
    name = name.replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 180);
    if (!name) {
        name = `document${EXTENSION_BY_MIME[mimeType] || ''}`;
    }
    return name;
}

function validateInstallationDocumentUpload({ category, file_name, file_data_url }) {
    const allowed = INSTALLATION_DOCUMENT_MIME_TYPES[category];
    if (!allowed) {
        return { ok: false, error: 'Choose plans or site pictures' };
    }
    const parsed = parseInstallationDocumentDataUrl(file_data_url);
    if (!parsed) {
        return { ok: false, error: 'File data is missing or not a supported upload' };
    }
    if (!allowed.includes(parsed.mimeType)) {
        return {
            ok: false,
            error: category === 'plan'
                ? 'Plans must be a PDF or an image (JPG, PNG, or WEBP)'
                : 'Site pictures must be an image (JPG, PNG, WEBP, or GIF)'
        };
    }
    if (parsed.bytes <= 0 || parsed.bytes > MAX_INSTALLATION_DOCUMENT_BYTES) {
        return { ok: false, error: 'Each file must be 12 MB or smaller' };
    }
    return {
        ok: true,
        mimeType: parsed.mimeType,
        bytes: parsed.bytes,
        fileName: sanitizeDocumentFileName(file_name, parsed.mimeType)
    };
}

module.exports = {
    MAX_INSTALLATION_DOCUMENT_BYTES,
    INSTALLATION_DOCUMENT_MIME_TYPES,
    canManageInstallationDocuments,
    parseInstallationDocumentDataUrl,
    sanitizeDocumentFileName,
    validateInstallationDocumentUpload
};
