function toE164Phone(phone) {
    if (phone == null) return null;
    const raw = String(phone).trim();
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;

    let e164 = null;
    if (raw.startsWith('+')) {
        e164 = `+${digits}`;
    } else if (digits.startsWith('00') && digits.length > 4) {
        e164 = `+${digits.slice(2)}`;
    } else if (digits.startsWith('44')) {
        e164 = `+${digits}`;
    } else if (digits.startsWith('0') && (digits.length === 10 || digits.length === 11)) {
        e164 = `+44${digits.slice(1)}`;
    } else if (digits.length === 10 && digits.startsWith('7')) {
        e164 = `+44${digits}`;
    }

    if (!e164 || !/^\+[1-9]\d{9,14}$/.test(e164)) return null;
    return e164;
}

function buildSignoffSmsBody(signoffUrl) {
    return `Please sign off your installation: ${signoffUrl}`;
}

module.exports = { toE164Phone, buildSignoffSmsBody };
