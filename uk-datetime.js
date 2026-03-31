'use strict';

/** IANA timezone for UK civil dates and wall times (GMT / BST). */
const UK_TZ = 'Europe/London';

/**
 * Calendar date YYYY-MM-DD in Europe/London for an instant.
 * @param {Date|string|number} date
 * @returns {string}
 */
function londonYmd(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: UK_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
}

function londonWeekdayOffsetFromMonday(date) {
    const long = new Intl.DateTimeFormat('en-GB', {
        timeZone: UK_TZ,
        weekday: 'long'
    }).format(date instanceof Date ? date : new Date(date));
    const map = {
        Monday: 0,
        Tuesday: 1,
        Wednesday: 2,
        Thursday: 3,
        Friday: 4,
        Saturday: 5,
        Sunday: 6
    };
    const o = map[long];
    if (o === undefined) {
        throw new Error(`Unknown weekday from Intl: ${long}`);
    }
    return o;
}

/**
 * Monday (week start) YYYY-MM-DD in Europe/London for the week containing `date`.
 * @param {Date|string|number} date
 * @returns {string}
 */
function londonMondayYmd(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const ymd = londonYmd(d);
    const [y, m, day] = ymd.split('-').map(Number);
    const wd = londonWeekdayOffsetFromMonday(d);
    const t = new Date(Date.UTC(y, m - 1, day));
    t.setUTCDate(t.getUTCDate() - wd);
    const yy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(t.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

function londonYmdAddDays(ymd, delta) {
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() + delta);
    const yy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(t.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

/**
 * UTC millisecond timestamp of the first instant of London calendar day `ymd`.
 * @param {string} ymd YYYY-MM-DD
 */
function londonDayStartMs(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    let low = Date.UTC(y, m - 1, d - 1, 0, 0, 0, 0);
    let high = Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0);
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (londonYmd(new Date(mid)) < ymd) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

function londonDayStartUtc(ymd) {
    return new Date(londonDayStartMs(ymd)).toISOString();
}

function londonNextDayStartUtc(ymd) {
    return londonDayStartUtc(londonYmdAddDays(ymd, 1));
}

/** Last millisecond of London civil day `ymd` (ISO string). */
function londonDayEndInclusiveIso(ymd) {
    const nextMs = Date.parse(londonNextDayStartUtc(ymd));
    return new Date(nextMs - 1).toISOString();
}

/**
 * UTC Date for a London wall-clock time on a London calendar day (handles DST).
 * @param {string} ymd YYYY-MM-DD
 * @param {number} hour 0–23
 * @param {number} minute
 * @param {number} [second]
 */
function londonLocalTimeToUtc(ymd, hour, minute, second = 0) {
    let t = londonDayStartMs(ymd);
    const end = t + 26 * 60 * 60 * 1000;
    while (t < end) {
        if (londonYmd(new Date(t)) !== ymd) {
            t += 1000;
            continue;
        }
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: UK_TZ,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).formatToParts(new Date(t));
        const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
        const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
        const s = parseInt(parts.find((p) => p.type === 'second').value, 10);
        if (h === hour && m === minute && s === second) {
            return new Date(t);
        }
        t += 1000;
    }
    throw new Error(`Could not resolve London local time ${ymd} ${hour}:${minute}:${second}`);
}

/**
 * Hour (0–23) in Europe/London for an instant.
 * @param {Date} date
 */
function londonHour(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: UK_TZ,
        hour: '2-digit',
        hour12: false
    }).formatToParts(date instanceof Date ? date : new Date(date));
    return parseInt(parts.find((p) => p.type === 'hour').value, 10);
}

/** Same convention as Date#getDay(): 0=Sunday … 6=Saturday, for the London calendar instant. */
/** Weekday for a London YYYY-MM-DD civil date (uses noon to avoid boundary issues). */
function londonWeekdaySun0FromYmd(ymd) {
    return londonWeekdaySun0(new Date(londonDayStartMs(ymd) + 12 * 60 * 60 * 1000));
}

/** Monday week start YYYY-MM-DD for a London calendar date string. */
function londonMondayYmdFromYmd(ymd) {
    return londonMondayYmd(new Date(londonDayStartMs(ymd) + 12 * 60 * 60 * 1000));
}

function londonWeekdaySun0(date) {
    const short = new Intl.DateTimeFormat('en-GB', {
        timeZone: UK_TZ,
        weekday: 'short'
    }).format(date instanceof Date ? date : new Date(date));
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const idx = map[short];
    if (idx === undefined) {
        throw new Error(`Unknown weekday: ${short}`);
    }
    return idx;
}

/**
 * Round London wall-clock time to 15-minute boundary (ceil).
 * @returns {Date}
 */
function roundClockUpLondon15(date) {
    const d = date instanceof Date ? date : new Date(date);
    const ymd = londonYmd(d);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: UK_TZ,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(d);
    let h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    let m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    let s = parseInt(parts.find((p) => p.type === 'second').value, 10);
    const rem = m % 15;
    if (rem > 0) {
        m += 15 - rem;
        s = 0;
    } else {
        s = 0;
    }
    if (m >= 60) {
        m -= 60;
        h += 1;
    }
    let ymdUse = ymd;
    if (h >= 24) {
        ymdUse = londonYmdAddDays(ymd, 1);
        h -= 24;
    }
    return londonLocalTimeToUtc(ymdUse, h, m, s);
}

/**
 * Round London wall-clock time to 15-minute boundary (floor).
 * @returns {Date}
 */
function roundClockDownLondon15(date) {
    const d = date instanceof Date ? date : new Date(date);
    const ymd = londonYmd(d);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: UK_TZ,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(d);
    let h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    let m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    m -= m % 15;
    return londonLocalTimeToUtc(ymd, h, m, 0);
}

/**
 * PostgreSQL `date` / plain `YYYY-MM-DD` stays as-is; timestamps use London calendar date.
 * @param {string|Date|import('pg').Date} val
 */
function ymdFromDbOrInstant(val) {
    if (val == null || val === '') {
        return null;
    }
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val.trim())) {
        return val.trim();
    }
    return londonYmd(new Date(val));
}

module.exports = {
    UK_TZ,
    londonYmd,
    londonMondayYmd,
    londonWeekdayOffsetFromMonday,
    londonYmdAddDays,
    londonDayStartMs,
    londonDayStartUtc,
    londonNextDayStartUtc,
    londonDayEndInclusiveIso,
    londonLocalTimeToUtc,
    londonHour,
    londonWeekdaySun0,
    londonWeekdaySun0FromYmd,
    londonMondayYmdFromYmd,
    roundClockUpLondon15,
    roundClockDownLondon15,
    ymdFromDbOrInstant
};
