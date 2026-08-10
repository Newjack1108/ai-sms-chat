/**
 * CSV helpers for finished-products export.
 */

function csvEscapeCell(value) {
    if (value === undefined || value === null) return '';
    const s = String(value);
    if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function formatProductSyncAt(value) {
    if (value === undefined || value === null || value === '') return '';
    try {
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        return d.toISOString();
    } catch (e) {
        return String(value);
    }
}

function productsToCsv(products) {
    const headers = [
        'id',
        'name',
        'description',
        'category',
        'product_type',
        'leadlock_category',
        'is_optional_extra',
        'management_checked',
        'status',
        'cost_gbp',
        'number_of_boxes',
        'estimated_load_time',
        'estimated_install_time',
        'estimated_travel_time',
        'last_pushed_to_sales_at'
    ];
    const rows = [headers.join(',')];
    for (const p of products || []) {
        const isExtra = p.is_optional_extra === true || p.is_optional_extra === 1
            || (typeof p.is_optional_extra === 'string'
                && (p.is_optional_extra === '1' || p.is_optional_extra.toLowerCase() === 'true'));
        const isManagementChecked = p.management_checked === true || p.management_checked === 1
            || (typeof p.management_checked === 'string'
                && (p.management_checked === '1' || p.management_checked.toLowerCase() === 'true'));
        rows.push([
            csvEscapeCell(p.id),
            csvEscapeCell(p.name),
            csvEscapeCell(p.description),
            csvEscapeCell(p.category),
            csvEscapeCell(p.product_type),
            csvEscapeCell(p.leadlock_category),
            csvEscapeCell(isExtra ? 'true' : 'false'),
            csvEscapeCell(isManagementChecked ? 'true' : 'false'),
            csvEscapeCell(p.status),
            csvEscapeCell(p.cost_gbp != null ? p.cost_gbp : ''),
            csvEscapeCell(p.number_of_boxes != null ? p.number_of_boxes : ''),
            csvEscapeCell(p.estimated_load_time != null ? p.estimated_load_time : ''),
            csvEscapeCell(p.estimated_install_time != null ? p.estimated_install_time : ''),
            csvEscapeCell(p.estimated_travel_time != null ? p.estimated_travel_time : ''),
            csvEscapeCell(formatProductSyncAt(p.last_pushed_to_sales_at))
        ].join(','));
    }
    return rows.join('\n') + '\n';
}

module.exports = {
    csvEscapeCell,
    formatProductSyncAt,
    productsToCsv
};
