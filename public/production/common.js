// Common JavaScript functions for production system

const API_BASE = '/production/api';

/** UK civil dates / week boundaries (Europe/London, GMT/BST). */
const UK_TIMEZONE = 'Europe/London';

function londonYmd(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: UK_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
}

function londonWeekdayOffsetFromMonday(date) {
    const long = new Intl.DateTimeFormat('en-GB', {
        timeZone: UK_TIMEZONE,
        weekday: 'long'
    }).format(date instanceof Date ? date : new Date(date));
    const map = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };
    return map[long];
}

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

/** Monday week start YYYY-MM-DD for any London calendar date string. */
function londonMondayYmdFromYmd(ymd) {
    if (!ymd) return '';
    const normalized = String(ymd).split('T')[0];
    return londonMondayYmd(new Date(`${normalized}T12:00:00`));
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

/** Plain YYYY-MM-DD or timestamp → London calendar date string. */
function ymdFromDbOrInstant(val) {
    if (val == null || val === '') {
        return null;
    }
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val.trim())) {
        return val.trim();
    }
    return londonYmd(new Date(val));
}

// API helper function
async function apiCall(endpoint, options = {}) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            credentials: 'same-origin', // Include cookies for session
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...options.headers
            }
        });
        
        // Handle authentication errors first
        if (response.status === 401 || response.status === 403) {
            // Don't try to parse, just redirect
            window.location.href = '/production/login.html';
            return null;
        }
        
        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        let data;
        let text;
        
        // Clone response to read as text first (in case we need to check if it's HTML)
        if (!contentType || !contentType.includes('application/json')) {
            text = await response.text();
            console.error('Non-JSON response from', endpoint, 'Status:', response.status, 'Content:', text.substring(0, 200));
            
            // Try to parse as JSON anyway (some servers don't set content-type correctly)
            try {
                data = JSON.parse(text);
            } catch (e) {
                // If it's HTML, it's likely a 404 or error page
                if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
                    throw new Error(`Server returned HTML page (${response.status}): ${response.statusText}. The API endpoint may not exist or there was a server error.`);
                }
                throw new Error(`Server returned non-JSON response (${response.status}): ${response.statusText}`);
            }
        } else {
            // Read as JSON
            try {
                data = await response.json();
            } catch (e) {
                // If JSON parsing fails, try reading as text
                text = await response.clone().text();
                console.error('JSON parse failed, response text:', text.substring(0, 200));
                throw new Error(`Failed to parse JSON response: ${e.message}`);
            }
        }
        
        if (!response.ok) {
            // Check if it's an auth error in the JSON response
            if (data && (data.requiresLogin || response.status === 401 || response.status === 403)) {
                window.location.href = '/production/login.html';
                return null;
            }
            
            // Extract error message - check multiple possible fields
            let errorMessage = data?.error || data?.message || data?.detail;
            if (!errorMessage && response.status === 500) {
                errorMessage = 'Internal server error occurred';
            }
            if (!errorMessage) {
                errorMessage = `Request failed with status ${response.status}: ${response.statusText}`;
            }
            
            throw new Error(errorMessage);
        }
        
        return data;
    } catch (error) {
        console.error('API call error:', error);
        throw error;
    }
}

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/me`);
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                window.location.href = '/production/login.html';
                return null;
            }
            // For other errors, try to parse JSON
            try {
                const data = await response.json();
                if (data.requiresLogin) {
                    window.location.href = '/production/login.html';
                    return null;
                }
            } catch (e) {
                // If not JSON, just redirect
                window.location.href = '/production/login.html';
                return null;
            }
        }
        const data = await response.json();
        return data.user;
    } catch (error) {
        // Only redirect on network/auth errors, not on JSON parse errors
        if (error.message && error.message.includes('JSON')) {
            console.error('Auth check failed:', error);
            return null;
        }
        window.location.href = '/production/login.html';
        return null;
    }
}

// Logout
async function logout() {
    try {
        await apiCall('/logout', { method: 'POST' });
        window.location.href = '/production/login.html';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/production/login.html';
    }
}

// Format currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP'
    }).format(amount || 0);
}

// Format date
function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-GB', {
        timeZone: UK_TIMEZONE,
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

/** Company details for PDFs and supplier-facing documents. */
const COMPANY_DETAILS = {
    name: 'Cheshire Sheds and Garden Buildings Ltd (CSGB)',
    tradingAs: 'T/A Cheshire Stables',
    addressLines: ['Ibex House', 'Off Nat Lane', 'Winsford, Cheshire', 'CW7 3BS'],
    phone: '01606 653653',
    email: 'sales@csgbgroup.co.uk'
};

function renderCompanyDetailsHtml() {
    const lines = [
        `<p style="margin: 0 0 4px 0; font-size: 14px;"><strong>${escapeHtml(COMPANY_DETAILS.name)}</strong></p>`,
        `<p style="margin: 0 0 4px 0; font-size: 12px;">${escapeHtml(COMPANY_DETAILS.tradingAs)}</p>`,
        ...COMPANY_DETAILS.addressLines.map((line) => `<p style="margin: 0 0 4px 0; font-size: 12px;">${escapeHtml(line)}</p>`),
        `<p style="margin: 0 0 4px 0; font-size: 12px;">Tel: ${escapeHtml(COMPANY_DETAILS.phone)}</p>`,
        `<p style="margin: 0; font-size: 12px;">${escapeHtml(COMPANY_DETAILS.email)}</p>`
    ];
    return lines.join('');
}

// Format datetime
function formatDateTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('en-GB', {
        timeZone: UK_TIMEZONE,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Escape HTML to prevent XSS attacks
function escapeHtml(text) {
    if (text == null || text === undefined) {
        return '';
    }
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function formatCustomerName(name) {
    const trimmed = (name || '').trim();
    return trimmed || '—';
}

/** Calendar block label: customer name primary, product in tooltip/subtitle. */
function formatInstallationBlockLabel(inst) {
    const name = (inst && inst.customer_name || '').trim();
    const product = (inst && inst.product_name) || 'Installation';
    if (name) {
        return { primary: name, secondary: product, title: `${name} — ${product}` };
    }
    return { primary: product, secondary: '', title: product };
}

function isLeadLockOrder(order) {
    return order && order.leadlock_order_id != null && String(order.leadlock_order_id).trim() !== '';
}

/** Prominent LeadLock sales order reference for load sheets and detail views. */
function renderLeadLockOrderRefHtml(order) {
    if (!isLeadLockOrder(order)) {
        return '';
    }
    const ref = escapeHtml(String(order.leadlock_order_id).trim());
    return `<div style="margin-bottom: 12px; padding: 12px 16px; background: #e8f4e8; border: 1px solid #a8d4a8; border-radius: 8px;">
<p style="margin: 0; font-size: 18px;"><strong>LeadLock order:</strong> ${ref}</p>
</div>`;
}

/** Order ID line for load sheet modal subtitle and print header. */
function formatLoadSheetOrderIdsLine(loadSheet, worksOrderId) {
    const parts = [];
    if (isLeadLockOrder(loadSheet)) {
        parts.push(`<strong>LeadLock order:</strong> ${escapeHtml(String(loadSheet.leadlock_order_id).trim())}`);
    }
    parts.push(`<strong>Works order:</strong> ${escapeHtml(String(worksOrderId))}`);
    parts.push(`<strong>Date:</strong> ${escapeHtml(new Date().toLocaleDateString())}`);
    return parts.join(' · ');
}

/** Customer + phone header for load sheets (modal, print, embed). */
function renderLoadSheetCustomerHeader(loadSheet) {
    if (!loadSheet) {
        return '';
    }
    const leadlockRef = renderLeadLockOrderRefHtml(loadSheet);
    const nameRaw = (loadSheet.customer_name || '').trim();
    const nameDisplay = nameRaw ? escapeHtml(nameRaw) : '—';
    const phoneRaw = (loadSheet.customer_phone || '').trim();
    const phoneDisplay = phoneRaw ? escapeHtml(phoneRaw) : '—';
    return `${leadlockRef}<div style="margin-bottom: 16px; padding: 12px 16px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px;">
<p style="margin: 0 0 6px 0; font-size: 16px;"><strong>Customer:</strong> ${nameDisplay}</p>
<p style="margin: 0; font-size: 16px;"><strong>Phone:</strong> ${phoneDisplay}</p>
</div>`;
}

/** Product line for load sheet heading (matches production-orders display). */
function getLoadSheetProductsDisplay(loadSheet) {
    if (!loadSheet) {
        return '';
    }
    const products = loadSheet.products;
    if (products && products.length > 0) {
        return products
            .map((p) => {
                const prefix = p.is_optional_extra ? '[Extra] ' : '';
                return `${prefix}${p.product_name || 'Unknown'} (x${p.quantity})`;
            })
            .join(', ');
    }
    return `${loadSheet.product_name || 'Unknown'} (x${loadSheet.quantity || 1})`;
}

/** LeadLock lines with no production BOM — display-only on load sheets. */
function renderLoadSheetSalesOnlyLinesHtml(loadSheet) {
    const lines = loadSheet && loadSheet.sales_only_lines;
    if (!lines || !lines.length) {
        return '';
    }
    const rows = lines
        .map((line) => {
            const install =
                line.install_hours != null && !Number.isNaN(parseFloat(line.install_hours))
                    ? parseFloat(line.install_hours).toFixed(2)
                    : '—';
            const boxes =
                line.number_of_boxes != null && !Number.isNaN(parseInt(line.number_of_boxes, 10))
                    ? String(line.number_of_boxes)
                    : '—';
            return `<tr>
<td><strong>${escapeHtml(line.product_name || 'Unknown')}</strong></td>
<td>${escapeHtml(String(line.quantity ?? 1))}</td>
<td>${line.description ? escapeHtml(line.description) : '—'}</td>
<td>${install}</td>
<td>${escapeHtml(boxes)}</td>
</tr>`;
        })
        .join('');
    return `<h4>Sales lines pending production setup</h4>
<p class="text-muted" style="font-size: 0.9rem; margin: 0 0 10px 0;">These LeadLock items are not linked to a production product with a BOM. Use <strong>Production setup</strong> on the works order to create or link a product.</p>
<table class="table">
<thead><tr>
<th>Item</th><th>Qty</th><th>Description</th><th>Install hrs</th><th>Boxes</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** Whether the user may edit product BOM lines (matches API requireAdminOrOffice). */
function canEditProductBom(user) {
    if (!user || !user.role) return false;
    return user.role === 'admin' || user.role === 'office';
}

/** Whether the user may add/remove/edit quantities on order production lines (matches API requireManager). */
function canManageOrderProducts(user) {
    if (!user || !user.role) return false;
    return user.role === 'admin' || user.role === 'office' || user.role === 'manager';
}

const ProductBomCatalog = {
    stockItems: [],
    components: [],
    panels: [],
    loaded: false,
    async ensureLoaded() {
        if (this.loaded) return;
        const [stockData, compData, panelData] = await Promise.all([
            apiCall('/stock?all=1'),
            apiCall('/components?all=1'),
            apiCall('/panels?all=1')
        ]);
        this.stockItems = stockData.items || stockData.stock || [];
        this.components = compData.components || [];
        this.panels = panelData.panels || [];
        this.loaded = true;
    }
};

/**
 * Render editable product BOM into a container element.
 * @param {number} productId
 * @param {HTMLElement} container
 * @param {{ user?: object, productName?: string, onChange?: () => void }} options
 */
async function renderProductBomPanel(productId, container, options = {}) {
    const user = options.user || null;
    const canEdit = canEditProductBom(user);
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const productName = options.productName || `Product #${productId}`;

    container.innerHTML = '<div class="loading">Loading BOM…</div>';
    await ProductBomCatalog.ensureLoaded();

    const state = { productId, canEdit, onChange, productName };

    async function reload() {
        const [componentsData, costData] = await Promise.all([
            apiCall(`/products/${productId}/components`),
            apiCall(`/products/${productId}/cost`)
        ]);
        const totalCost = costData && typeof costData.cost === 'number' ? costData.cost : 0;
        const comps = componentsData.components || [];
        const totalCostId = `productBomTotalCost_${productId}`;

        container.innerHTML = `
            <div class="product-bom-panel" data-product-id="${productId}">
                <div style="margin-bottom: 16px;">
                    <h4 style="margin-bottom: 10px; color: #333;">${escapeHtml(productName)}</h4>
                    <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px;">
                        <div>
                            <strong>Total product cost:</strong>
                            <span id="${totalCostId}" style="font-size: 1.1em; margin-left: 8px;">${formatCurrency(totalCost)}</span>
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm product-bom-refresh-cost">Refresh total</button>
                        ${canEdit ? '<button type="button" class="btn btn-primary btn-sm product-bom-add">Add line</button>' : ''}
                    </div>
                </div>
                <table class="table">
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Item</th>
                            <th>Quantity</th>
                            <th>Unit</th>
                            ${canEdit ? '<th>Actions</th>' : ''}
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            comps.length === 0
                                ? `<tr><td colspan="${canEdit ? 5 : 4}">No BOM lines yet</td></tr>`
                                : comps
                                      .map((comp) => {
                                          const typeLabel =
                                              comp.component_type === 'raw_material'
                                                  ? 'Raw Material'
                                                  : comp.component_type === 'component'
                                                    ? 'Component'
                                                    : 'Built Item';
                                          return `<tr id="product-bom-row-${comp.id}">
<td><span class="badge badge-info">${escapeHtml(typeLabel)}</span></td>
<td>${escapeHtml(comp.component_name || 'Unknown')}</td>
<td>${
                                              canEdit
                                                  ? `<input type="number" step="0.01" class="form-input product-bom-qty" data-comp-id="${comp.id}" value="${comp.quantity_required}" style="width: 100px;" data-original="${comp.quantity_required}" data-type="${escapeHtml(comp.component_type)}" data-cid="${comp.component_id}" data-unit="${escapeHtml(comp.unit)}">`
                                                  : escapeHtml(String(comp.quantity_required))
                                          }</td>
<td>${escapeHtml(comp.unit)}</td>
${
    canEdit
        ? `<td>
<button type="button" class="btn btn-primary btn-sm product-bom-save-qty" data-comp-id="${comp.id}" style="display:none; margin-right:4px;">Save</button>
<button type="button" class="btn btn-danger btn-sm product-bom-delete" data-comp-id="${comp.id}">Delete</button>
</td>`
        : ''
}
</tr>`;
                                      })
                                      .join('')
                        }
                    </tbody>
                </table>
            </div>`;

        container.querySelector('.product-bom-refresh-cost')?.addEventListener('click', async () => {
            const el = document.getElementById(totalCostId);
            if (!el) return;
            try {
                el.textContent = '…';
                const cd = await apiCall(`/products/${productId}/cost`);
                el.textContent = formatCurrency(cd && typeof cd.cost === 'number' ? cd.cost : 0);
            } catch (err) {
                el.textContent = '—';
                showAlert(err.message || 'Failed to refresh total', 'error');
            }
        });

        container.querySelector('.product-bom-add')?.addEventListener('click', () => {
            showProductBomAddForm(container, state, reload);
        });

        container.querySelectorAll('.product-bom-qty').forEach((input) => {
            input.addEventListener('input', () => {
                const compId = input.dataset.compId;
                const saveBtn = container.querySelector(`.product-bom-save-qty[data-comp-id="${compId}"]`);
                if (!saveBtn) return;
                const orig = parseFloat(input.dataset.original);
                const cur = parseFloat(input.value);
                saveBtn.style.display = !isNaN(cur) && cur !== orig ? 'inline-block' : 'none';
            });
        });

        container.querySelectorAll('.product-bom-save-qty').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const compId = btn.dataset.compId;
                const input = container.querySelector(`.product-bom-qty[data-comp-id="${compId}"]`);
                if (!input) return;
                const newQty = parseFloat(input.value);
                if (isNaN(newQty) || newQty < 0) {
                    showAlert('Invalid quantity', 'error');
                    return;
                }
                try {
                    await apiCall(`/products/${productId}/components/${compId}`, {
                        method: 'PUT',
                        body: JSON.stringify({
                            component_type: input.dataset.type,
                            component_id: parseInt(input.dataset.cid, 10),
                            quantity_required: newQty,
                            unit: input.dataset.unit
                        })
                    });
                    showAlert('Quantity updated');
                    await reload();
                    if (onChange) onChange();
                } catch (err) {
                    showAlert(err.message || 'Failed to update', 'error');
                }
            });
        });

        container.querySelectorAll('.product-bom-delete').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this BOM line?')) return;
                try {
                    await apiCall(`/products/${productId}/components/${btn.dataset.compId}`, { method: 'DELETE' });
                    showAlert('BOM line deleted');
                    await reload();
                    if (onChange) onChange();
                } catch (err) {
                    showAlert(err.message || 'Failed to delete', 'error');
                }
            });
        });
    }

    await reload();
}

function showProductBomAddForm(container, state, reloadCallback) {
    const { productId, canEdit } = state;
    if (!canEdit) return;
    const panel = container.querySelector('.product-bom-panel');
    if (!panel) return;

    const formWrap = document.createElement('div');
    formWrap.className = 'product-bom-add-form';
    formWrap.style.marginTop = '16px';
    formWrap.style.padding = '12px';
    formWrap.style.border = '1px solid #dee2e6';
    formWrap.style.borderRadius = '6px';
    formWrap.innerHTML = `
        <h4 style="margin-top:0;">Add BOM line</h4>
        <div class="form-group">
            <label class="form-label">Type *</label>
            <select class="form-select product-bom-new-type">
                <option value="">Select type</option>
                <option value="raw_material">Raw Material</option>
                <option value="component">Component</option>
                <option value="built_item">Built Item</option>
            </select>
        </div>
        <div class="form-group">
            <label class="form-label">Item *</label>
            <select class="form-select product-bom-new-item"><option value="">Select item</option></select>
        </div>
        <div class="form-group">
            <label class="form-label">Quantity *</label>
            <input type="number" step="0.01" class="form-input product-bom-new-qty" required>
        </div>
        <div class="form-group">
            <label class="form-label">Unit *</label>
            <input type="text" class="form-input product-bom-new-unit" required>
        </div>
        <div class="text-right">
            <button type="button" class="btn btn-secondary btn-sm product-bom-add-cancel">Cancel</button>
            <button type="button" class="btn btn-primary btn-sm product-bom-add-submit">Add</button>
        </div>`;

    panel.appendChild(formWrap);

    const typeSelect = formWrap.querySelector('.product-bom-new-type');
    const itemSelect = formWrap.querySelector('.product-bom-new-item');

    typeSelect.addEventListener('change', () => {
        const type = typeSelect.value;
        itemSelect.innerHTML = '<option value="">Select item</option>';
        if (type === 'raw_material') {
            ProductBomCatalog.stockItems.forEach((item) => {
                itemSelect.innerHTML += `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.unit || '')})</option>`;
            });
        } else if (type === 'component') {
            ProductBomCatalog.components.forEach((c) => {
                itemSelect.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
            });
        } else if (type === 'built_item') {
            ProductBomCatalog.panels.forEach((p) => {
                itemSelect.innerHTML += `<option value="${p.id}">${escapeHtml(p.name)}</option>`;
            });
        }
    });

    formWrap.querySelector('.product-bom-add-cancel').addEventListener('click', () => formWrap.remove());

    formWrap.querySelector('.product-bom-add-submit').addEventListener('click', async () => {
        const component_type = typeSelect.value;
        const component_id = itemSelect.value;
        const quantity_required = formWrap.querySelector('.product-bom-new-qty').value;
        const unit = formWrap.querySelector('.product-bom-new-unit').value;
        if (!component_type || !component_id || !quantity_required || !unit) {
            showAlert('All fields are required', 'error');
            return;
        }
        try {
            await apiCall(`/products/${productId}/components`, {
                method: 'POST',
                body: JSON.stringify({
                    component_type,
                    component_id: parseInt(component_id, 10),
                    quantity_required: parseFloat(quantity_required),
                    unit
                })
            });
            showAlert('BOM line added');
            formWrap.remove();
            await reloadCallback();
            if (state.onChange) state.onChange();
        } catch (err) {
            showAlert(err.message || 'Failed to add BOM line', 'error');
        }
    });
}

/**
 * Read-only HTML for load sheet tables and estimated times (no checkboxes / PDF).
 * Used e.g. in installations.html Installation Details modal.
 */
function renderLoadSheetReadOnlyHtml(loadSheet) {
    if (!loadSheet) {
        return '';
    }
    let html = renderLoadSheetCustomerHeader(loadSheet);
    html += renderLeadLockWorkOrderDetailsHtml(loadSheet);
    html += renderLoadSheetSalesOnlyLinesHtml(loadSheet);
    const components = loadSheet.components || [];
    const builtItems = loadSheet.built_items || [];
    const rawMaterials = loadSheet.raw_materials || [];
    const standalone = loadSheet.standalone_spares || {
        components: [],
        built_items: [],
        raw_materials: []
    };
    const standaloneComps = standalone.components || [];
    const standaloneBuilt = standalone.built_items || [];
    const standaloneRaw = standalone.raw_materials || [];

    const compHasSparesCol = components.some(c => c.spares && c.spares.length > 0);
    const builtHasSparesCol = builtItems.some(bi => bi.spares && bi.spares.length > 0);
    const rawHasLocCol = rawMaterials.some(rm => rm.location);
    const rawHasSparesCol = rawMaterials.some(rm => rm.spares && rm.spares.length > 0);

    if (components.length > 0) {
        html += `<h4>Components Required</h4>
<table class="table">
<thead><tr>
<th>Component</th><th>Quantity</th><th>Unit</th>${compHasSparesCol ? '<th>Spares</th>' : ''}
</tr></thead><tbody>`;
        html += components.map((c) => {
            const spareRows =
                c.spares && c.spares.length > 0
                    ? c.spares
                          .map((spare) => {
                              const loaded = parseFloat(spare.quantity_loaded || 0);
                              const used = parseFloat(spare.quantity_used || 0);
                              const returned = parseFloat(spare.quantity_returned || 0);
                              return `<tr style="background: #fff3cd;">
<td><em>Spare: ${escapeHtml(c.name)}</em></td>
<td>${parseFloat(spare.quantity_needed || 0).toFixed(2)} (L:${loaded.toFixed(2)} U:${used.toFixed(2)} R:${returned.toFixed(2)})</td>
<td>${escapeHtml(c.unit)}</td>
${compHasSparesCol ? '<td></td>' : ''}
</tr>`;
                          })
                          .join('')
                    : '';
            return `<tr>
<td><strong>${escapeHtml(c.name)}</strong></td>
<td>${parseFloat(c.quantity).toFixed(2)}</td>
<td>${escapeHtml(c.unit)}</td>
${compHasSparesCol ? '<td></td>' : ''}
</tr>${spareRows}`;
        }).join('');
        html += `</tbody></table>`;
    }

    if (builtItems.length > 0) {
        html += `<h4>Built Items Required</h4>
<table class="table">
<thead><tr>
<th>Built Item</th><th>Quantity</th><th>Unit</th>${builtHasSparesCol ? '<th>Spares</th>' : ''}
</tr></thead><tbody>`;
        html += builtItems.map((bi) => {
            const spareRows =
                bi.spares && bi.spares.length > 0
                    ? bi.spares
                          .map((spare) => {
                              const loaded = parseFloat(spare.quantity_loaded || 0);
                              const used = parseFloat(spare.quantity_used || 0);
                              const returned = parseFloat(spare.quantity_returned || 0);
                              return `<tr style="background: #fff3cd;">
<td><em>Spare: ${escapeHtml(bi.name)}</em></td>
<td>${parseFloat(spare.quantity_needed || 0).toFixed(2)} (L:${loaded.toFixed(2)} U:${used.toFixed(2)} R:${returned.toFixed(2)})</td>
<td>${escapeHtml(bi.unit)}</td>
${builtHasSparesCol ? '<td></td>' : ''}
</tr>`;
                          })
                          .join('')
                    : '';
            return `<tr>
<td><strong>${escapeHtml(bi.name)}</strong></td>
<td>${parseFloat(bi.quantity).toFixed(2)}</td>
<td>${escapeHtml(bi.unit)}</td>
${builtHasSparesCol ? '<td></td>' : ''}
</tr>${spareRows}`;
        }).join('');
        html += `</tbody></table>`;
    }

    if (rawMaterials.length > 0) {
        html += `<h4>Raw Materials Required</h4>
<table class="table">
<thead><tr>
<th>Material</th><th>Quantity</th><th>Unit</th>
${rawHasLocCol ? '<th>Location</th>' : ''}
${rawHasSparesCol ? '<th>Spares</th>' : ''}
</tr></thead><tbody>`;
        html += rawMaterials.map((rm) => {
            const spareRows =
                rm.spares && rm.spares.length > 0
                    ? rm.spares
                          .map((spare) => {
                              const loaded = parseFloat(spare.quantity_loaded || 0);
                              const used = parseFloat(spare.quantity_used || 0);
                              const returned = parseFloat(spare.quantity_returned || 0);
                              return `<tr style="background: #fff3cd;">
<td><em>Spare: ${escapeHtml(rm.name)}</em></td>
<td>${parseFloat(spare.quantity_needed || 0).toFixed(2)} (L:${loaded.toFixed(2)} U:${used.toFixed(2)} R:${returned.toFixed(2)})</td>
<td>${escapeHtml(rm.unit)}</td>
${rawHasLocCol ? `<td>${escapeHtml(rm.location || '-')}</td>` : ''}
${rawHasSparesCol ? '<td></td>' : ''}
</tr>`;
                          })
                          .join('')
                    : '';
            return `<tr>
<td><strong>${escapeHtml(rm.name)}</strong></td>
<td>${parseFloat(rm.quantity).toFixed(2)}</td>
<td>${escapeHtml(rm.unit)}</td>
${rawHasLocCol ? `<td>${escapeHtml(rm.location || '-')}</td>` : ''}
${rawHasSparesCol ? '<td></td>' : ''}
</tr>${spareRows}`;
        }).join('');
        html += `</tbody></table>`;
    } else {
        html += '<p>No raw materials required</p>';
    }

    if (
        standaloneComps.length > 0 ||
        standaloneBuilt.length > 0 ||
        standaloneRaw.length > 0
    ) {
        html += `<h4>Standalone Spares (Not in Main Requirements)</h4>`;
        if (standaloneComps.length > 0) {
            html += `<h5>Components</h5>
<table class="table">
<thead><tr><th>Component</th><th>Spare Quantity</th><th>Unit</th></tr></thead><tbody>`;
            html += standaloneComps
                .map((c) => {
                    const spare = c.spares && c.spares[0];
                    if (!spare) {
                        return `<tr style="background: #fff3cd;">
<td><strong>${escapeHtml(c.name)}</strong></td><td>—</td><td>${escapeHtml(c.unit)}</td>
</tr>`;
                    }
                    const loaded = parseFloat(spare.quantity_loaded || 0);
                    const used = parseFloat(spare.quantity_used || 0);
                    const returned = parseFloat(spare.quantity_returned || 0);
                    return `<tr style="background: #fff3cd;">
<td><strong>${escapeHtml(c.name)}</strong></td>
<td>${parseFloat(spare.quantity_needed || 0).toFixed(2)} (L:${loaded.toFixed(2)} U:${used.toFixed(2)} R:${returned.toFixed(2)})</td>
<td>${escapeHtml(c.unit)}</td>
</tr>`;
                })
                .join('');
            html += `</tbody></table>`;
        }
        if (standaloneBuilt.length > 0) {
            html += `<h5>Built Items</h5>
<table class="table">
<thead><tr><th>Built Item</th><th>Spare Quantity</th><th>Unit</th></tr></thead><tbody>`;
            html += standaloneBuilt
                .map((bi) => {
                    const spare = bi.spares && bi.spares[0];
                    if (!spare) {
                        return `<tr style="background: #fff3cd;">
<td><strong>${escapeHtml(bi.name)}</strong></td><td>—</td><td>${escapeHtml(bi.unit)}</td>
</tr>`;
                    }
                    const loaded = parseFloat(spare.quantity_loaded || 0);
                    const used = parseFloat(spare.quantity_used || 0);
                    const returned = parseFloat(spare.quantity_returned || 0);
                    return `<tr style="background: #fff3cd;">
<td><strong>${escapeHtml(bi.name)}</strong></td>
<td>${parseFloat(spare.quantity_needed || 0).toFixed(2)} (L:${loaded.toFixed(2)} U:${used.toFixed(2)} R:${returned.toFixed(2)})</td>
<td>${escapeHtml(bi.unit)}</td>
</tr>`;
                })
                .join('');
            html += `</tbody></table>`;
        }
        if (standaloneRaw.length > 0) {
            const stRawLoc = standaloneRaw.some((rm) => rm.location);
            html += `<h5>Raw Materials</h5>
<table class="table">
<thead><tr>
<th>Material</th><th>Spare Quantity</th><th>Unit</th>
${stRawLoc ? '<th>Location</th>' : ''}
</tr></thead><tbody>`;
            html += standaloneRaw
                .map((rm) => {
                    const spare = rm.spares && rm.spares[0];
                    if (!spare) {
                        return `<tr style="background: #fff3cd;">
<td><strong>${escapeHtml(rm.name)}</strong></td><td>—</td><td>${escapeHtml(rm.unit)}</td>
${stRawLoc ? `<td>${escapeHtml(rm.location || '-')}</td>` : ''}
</tr>`;
                    }
                    const loaded = parseFloat(spare.quantity_loaded || 0);
                    const used = parseFloat(spare.quantity_used || 0);
                    const returned = parseFloat(spare.quantity_returned || 0);
                    return `<tr style="background: #fff3cd;">
<td><strong>${escapeHtml(rm.name)}</strong></td>
<td>${parseFloat(spare.quantity_needed || 0).toFixed(2)} (L:${loaded.toFixed(2)} U:${used.toFixed(2)} R:${returned.toFixed(2)})</td>
<td>${escapeHtml(rm.unit)}</td>
${stRawLoc ? `<td>${escapeHtml(rm.location || '-')}</td>` : ''}
</tr>`;
                })
                .join('');
            html += `</tbody></table>`;
        }
    }

    html += `<div style="padding: 15px; margin-top: 20px; background: #f0f7ff; border: 2px solid #4a90e2; border-radius: 8px;">
<h4 style="margin: 0 0 10px 0; color: #2c5aa0;">Estimated Times</h4>`;
    if (loadSheet.estimated_load_time && loadSheet.estimated_load_time > 0) {
        html += `<p style="margin: 5px 0; font-size: 16px;"><strong>Estimated Load Time:</strong> ${parseFloat(loadSheet.estimated_load_time).toFixed(2)} hours</p>`;
    }
    if (loadSheet.estimated_install_time && loadSheet.estimated_install_time > 0) {
        html += `<p style="margin: 5px 0; font-size: 16px;"><strong>Estimated Install Time:</strong> ${parseFloat(loadSheet.estimated_install_time).toFixed(2)} hours <em style="color: #666;">(for reference only)</em></p>`;
    }
    html += `<p style="margin: 5px 0; font-size: 16px;"><strong>Estimated Travel Time:</strong> `;
    if (loadSheet.estimated_travel_time && loadSheet.estimated_travel_time > 0) {
        html += `${parseFloat(loadSheet.estimated_travel_time).toFixed(2)} hours`;
    } else {
        html += `<span style="border-bottom: 2px dashed #666; padding: 0 30px; display: inline-block; min-width: 100px;">&nbsp;</span> <em style="color: #666;">(for reference only)</em>`;
    }
    html += `</p>`;
    if (
        loadSheet.travel_time_hours_round_trip != null &&
        loadSheet.travel_time_hours_round_trip !== '' &&
        !Number.isNaN(parseFloat(loadSheet.travel_time_hours_round_trip))
    ) {
        html += `<p style="margin: 5px 0; font-size: 16px;"><strong>LeadLock drive time (round trip):</strong> ${parseFloat(loadSheet.travel_time_hours_round_trip).toFixed(2)} hours</p>`;
    }
    html += `</div>`;

    return html;
}

// Show alert
function showAlert(message, type = 'success') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    
    const container = document.querySelector('.container') || document.body;
    container.insertBefore(alertDiv, container.firstChild);
    
    setTimeout(() => {
        alertDiv.remove();
    }, 5000);
}

// Show modal
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
    }
}

// Hide modal
function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

/** Reduce mobile keyboard predictions and browser autofill on free-text fields. */
const SUGGESTION_SKIP_AUTOCOMPLETE = new Set(['username', 'current-password']);

function disableInputSuggestions(root) {
    const container = root || document;
    const nodes = [];
    if (container.matches && (container.matches('input') || container.matches('textarea'))) {
        nodes.push(container);
    }
    if (container.querySelectorAll) {
        nodes.push(...container.querySelectorAll('input, textarea'));
    }
    nodes.forEach((el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'date', 'number'].includes(type)) {
            return;
        }
        const ac = el.getAttribute('autocomplete');
        if (ac && SUGGESTION_SKIP_AUTOCOMPLETE.has(ac)) {
            return;
        }
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('autocorrect', 'off');
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('spellcheck', 'false');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    disableInputSuggestions(document);
});

// Close modal on outside click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('show');
    }
});

// Staff-like field roles: same nav restrictions; installers also get installation calendar
function isRestrictedFieldStaff(user) {
    return user && (user.role === 'staff' || user.role === 'installer');
}

function restrictedFieldStaffAllowedPages(user) {
    const base = ['timesheet.html', 'tasks.html', 'reminders.html', 'holidays.html', 'login.html'];
    if (user.role === 'installer') {
        return [...base, 'installations.html'];
    }
    return base;
}

// Redirect staff-like users when they open pages outside their allowlist
async function restrictStaffAccess() {
    const user = await checkAuth();
    if (isRestrictedFieldStaff(user)) {
        const allowedPages = restrictedFieldStaffAllowedPages(user);
        const currentPage = window.location.pathname.split('/').pop();
        
        if (!allowedPages.includes(currentPage) && !window.location.pathname.includes('login.html')) {
            window.location.href = '/production/timesheet.html';
            return true;
        }
    }
    return false;
}

// Initialize navbar
async function initNavbar() {
    const user = await checkAuth();
    if (user) {
        const userInfo = document.getElementById('userInfo');
        if (userInfo) {
            userInfo.textContent = `${user.username} (${user.role})`;
        }
        
        // Hide admin-only menu items for non-admin users
        if (user.role !== 'admin') {
            const adminItems = document.querySelectorAll('.admin-only');
            adminItems.forEach(item => item.style.display = 'none');
        }
        
        // Hide admin-or-office items for staff and installers (including items within dropdowns)
        if (isRestrictedFieldStaff(user)) {
            const adminOrOfficeItems = document.querySelectorAll('.admin-or-office');
            adminOrOfficeItems.forEach(item => {
                // Check if it's a dropdown container - if so, hide the whole dropdown
                if (item.classList.contains('navbar-dropdown')) {
                    item.style.display = 'none';
                } else {
                    // Otherwise hide the individual item
                    item.style.display = 'none';
                }
            });
        }
        
        // Hide manager-only items for staff and installers (legacy support)
        if (isRestrictedFieldStaff(user)) {
            const managerItems = document.querySelectorAll('.manager-only');
            managerItems.forEach(item => item.style.display = 'none');
        }
        
        // Show installer-only nav links for installers only
        if (user.role === 'installer') {
            document.querySelectorAll('.installer-only').forEach(item => {
                item.style.display = '';
            });
        }
        
        // Show office-only items only for office and admin
        if (user.role !== 'admin' && user.role !== 'office') {
            const officeOnlyItems = document.querySelectorAll('.office-only');
            officeOnlyItems.forEach(item => item.style.display = 'none');
        }
    }
}

// Dropdown functionality
function toggleDropdown(event, button) {
    event.stopPropagation();
    
    // Close all other dropdowns
    const allDropdowns = document.querySelectorAll('.dropdown-menu');
    const allButtons = document.querySelectorAll('.dropdown-toggle');
    
    allDropdowns.forEach(menu => {
        if (menu !== button.nextElementSibling) {
            menu.classList.remove('show');
        }
    });
    
    allButtons.forEach(btn => {
        if (btn !== button) {
            btn.classList.remove('open');
        }
    });
    
    // Toggle current dropdown
    const menu = button.nextElementSibling;
    if (menu && menu.classList.contains('dropdown-menu')) {
        menu.classList.toggle('show');
        button.classList.toggle('open');
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(event) {
    if (!event.target.closest('.navbar-dropdown')) {
        const allDropdowns = document.querySelectorAll('.dropdown-menu');
        const allButtons = document.querySelectorAll('.dropdown-toggle');
        
        allDropdowns.forEach(menu => menu.classList.remove('show'));
        allButtons.forEach(btn => btn.classList.remove('open'));
    }
});

/** Works order workflow flag definitions (slug, label, icon, badge tone). */
const WORK_ORDER_FLAGS = [
    { slug: 'on_hold', label: 'On Hold', icon: 'fa-pause-circle', tone: 'warning' },
    { slug: 'collection', label: 'Collection', icon: 'fa-truck', tone: 'info' },
    { slug: 'waiting_access_sheet', label: 'Waiting for access sheet', icon: 'fa-file-lines', tone: 'info' },
    { slug: 'booked_out', label: 'Booked out', icon: 'fa-calendar-check', tone: 'primary' },
    { slug: 'on_hold_weather', label: 'On Hold (Weather)', icon: 'fa-cloud-rain', tone: 'warning' },
    { slug: 'on_hold_planning', label: 'On Hold (Planning)', icon: 'fa-clipboard-list', tone: 'warning' },
    { slug: 'activity_timeline', label: 'See activity timeline', icon: 'fa-clock-rotate-left', tone: 'secondary' },
    { slug: 'do_not_contact', label: 'Do not Contact', icon: 'fa-phone-slash', tone: 'danger' }
];

const WORK_ORDER_FLAG_BY_SLUG = Object.fromEntries(WORK_ORDER_FLAGS.map(f => [f.slug, f]));

function parseWorkflowFlags(orderOrFlags) {
    let raw = orderOrFlags;
    if (orderOrFlags && typeof orderOrFlags === 'object' && !Array.isArray(orderOrFlags)) {
        raw = orderOrFlags.workflow_flags;
    }
    if (raw == null || raw === '') return [];
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(parsed)) return [];
    const slugs = new Set(WORK_ORDER_FLAGS.map(f => f.slug));
    return parsed
        .map(s => String(s).trim())
        .filter(slug => slugs.has(slug))
        .filter((slug, i, arr) => arr.indexOf(slug) === i);
}

function renderWorkOrderFlagBadges(flags, options = {}) {
    const compact = !!options.compact;
    const list = parseWorkflowFlags(flags);
    if (!list.length) return '';
    return list.map(slug => {
        const def = WORK_ORDER_FLAG_BY_SLUG[slug];
        if (!def) return '';
        const shortLabel = compact && def.label.length > 18
            ? def.label.slice(0, 16) + '…'
            : def.label;
        return `<span class="wo-flag-badge wo-flag-badge--${def.tone}${compact ? ' wo-flag-badge--compact' : ''}" title="${escapeHtml(def.label)}">` +
            `<i class="fa-solid ${def.icon}" aria-hidden="true"></i>` +
            `<span class="wo-flag-badge__label">${escapeHtml(shortLabel)}</span>` +
            `</span>`;
    }).join('');
}

function renderWorkOrderFlagCheckboxes(selectedFlags, inputName = 'workflow_flag') {
    const selected = new Set(parseWorkflowFlags(selectedFlags));
    return WORK_ORDER_FLAGS.map(def => {
        const checked = selected.has(def.slug) ? ' checked' : '';
        return `<label class="wo-flag-checkbox">` +
            `<input type="checkbox" name="${inputName}" value="${def.slug}"${checked}>` +
            `<span class="wo-flag-badge wo-flag-badge--${def.tone}">` +
            `<i class="fa-solid ${def.icon}" aria-hidden="true"></i>` +
            `<span class="wo-flag-badge__label">${escapeHtml(def.label)}</span>` +
            `</span>` +
            `</label>`;
    }).join('');
}

function collectWorkflowFlagsFromContainer(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('input[name="workflow_flag"]:checked'))
        .map(el => el.value);
}

// Default working hours: 8am start; 5pm end Mon-Thu/Sat/Sun, 3pm end Friday
function getDefaultWorkTimes(date) {
    const d = date instanceof Date ? date : new Date(date);
    const isFriday = d.getDay() === 5;
    return { start: '08:00', end: isFriday ? '15:00' : '17:00' };
}

function leadlockTruthy(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

/** Align LeadLock payment flags for display (matches server reconcileLeadLockPaymentFlags). */
function reconcileLeadLockPaymentFlagsForDisplay(order) {
    const depositAmt = parseFloat(order && order.deposit_amount);
    let depositPaid = leadlockTruthy(order && order.deposit_paid);
    let balancePaid = leadlockTruthy(order && order.balance_paid);
    let paidInFull = leadlockTruthy(order && order.paid_in_full);
    if (paidInFull) {
        depositPaid = true;
        balancePaid = true;
    } else if (depositPaid && balancePaid) {
        paidInFull = true;
    } else if (balancePaid && (depositPaid || !Number.isFinite(depositAmt) || depositAmt <= 0)) {
        paidInFull = true;
        depositPaid = true;
    }
    return { deposit_paid: depositPaid, balance_paid: balancePaid, paid_in_full: paidInFull };
}

/** Human-readable LeadLock payment status (browser). */
function deriveLeadLockPaymentStatusLabel(data) {
    const flags = reconcileLeadLockPaymentFlagsForDisplay(data || {});
    if (flags.paid_in_full) return 'Paid in full';
    if (flags.deposit_paid && flags.balance_paid) return 'Deposit and balance paid';
    if (flags.deposit_paid) return 'Deposit paid — balance outstanding';
    return 'Payment pending';
}

function formatLeadLockPaidLabel(paid) {
    return leadlockTruthy(paid) ? 'Paid' : 'Not paid';
}

function buildGoogleMapsSearchUrl(query) {
    const q = (query || '').trim();
    if (!q) return null;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function buildWhat3WordsUrl(words) {
    const w = (words || '').trim().replace(/^\/\/\//, '');
    if (!w) return null;
    return `https://what3words.com/${encodeURIComponent(w)}`;
}

function resolveInstallationSiteMapsQuery(installation, order) {
    const instAddr = (installation && installation.address || '').trim();
    const instLoc = (installation && installation.location || '').trim();
    if (instAddr) {
        const parts = [instAddr];
        if (instLoc && !instAddr.toLowerCase().includes(instLoc.toLowerCase())) {
            parts.push(instLoc);
        }
        return parts.join(', ');
    }
    if (order) {
        const combined = [(order.customer_address || '').trim(), (order.customer_postcode || '').trim()]
            .filter(Boolean).join(', ');
        if (combined) return combined;
    }
    return instLoc || '';
}

function resolveInstallationWhat3Words(order) {
    const w = (order && order.what3words || '').trim();
    return w || null;
}

function formatWhat3WordsDisplay(words) {
    const w = (words || '').trim().replace(/^\/\/\//, '');
    if (!w) return '';
    return `///${w}`;
}

/**
 * Address + delivery notes block for LeadLock work orders (load sheet, job sheet, detail).
 * @param {object} order or loadSheet row with customer_* and delivery fields
 */
function renderLeadLockWorkOrderAddressHtml(order) {
    if (!order) return '';
    const isDelivery = leadlockTruthy(order.address_is_delivery_location);
    const fulfillment = (order.fulfillment_method || '').toLowerCase();
    const isCollection = fulfillment === 'collection';
    const deliveryNotes = (order.delivery_location_notes || '').trim();
    const crmAddress = (order.crm_customer_address || '').trim();
    const hasAlternateDelivery = isDelivery || !!crmAddress || !!deliveryNotes;
    const addrLabel = hasAlternateDelivery ? 'Delivery location' : 'Customer address';
    const postcodeLabel = hasAlternateDelivery ? 'Delivery postcode' : 'Postcode';
    const address = (order.customer_address || '').trim();
    const postcode = (order.customer_postcode || '').trim();

    let html = '<div style="margin-bottom: 12px;">';
    if (fulfillment) {
        html += `<p style="margin: 0 0 8px 0;"><strong>Fulfilment:</strong> ${escapeHtml(fulfillment)}</p>`;
    }
    if (hasAlternateDelivery && (crmAddress || deliveryNotes)) {
        html += '<p style="margin: 0 0 8px 0; font-size: 14px; color: #555;"><strong>Alternate delivery</strong> (delivery site differs from CRM / bill-to)</p>';
    }
    if (!isCollection || address || postcode) {
        html += `<p style="margin: 0 0 6px 0;"><strong>${escapeHtml(addrLabel)}:</strong> ${address ? escapeHtml(address) : '—'}</p>`;
        html += `<p style="margin: 0 0 6px 0;"><strong>${escapeHtml(postcodeLabel)}:</strong> ${postcode ? escapeHtml(postcode) : '—'}</p>`;
    }
    if (deliveryNotes) {
        html += `<p style="margin: 0 0 6px 0; padding: 8px 10px; background: #fff8e6; border-left: 3px solid #f0ad4e;"><strong>Delivery access notes:</strong> ${escapeHtml(deliveryNotes)}</p>`;
    }
    if (crmAddress) {
        html += `<p style="margin: 0; font-size: 14px; color: #555;"><strong>Bill to / CRM address:</strong> ${escapeHtml(crmAddress)}</p>`;
    }
    const w3w = resolveInstallationWhat3Words(order);
    if (w3w) {
        const w3wUrl = buildWhat3WordsUrl(w3w);
        const w3wLabel = escapeHtml(formatWhat3WordsDisplay(w3w));
        const w3wLink = w3wUrl
            ? ` <a href="${escapeHtml(w3wUrl)}" target="_blank" rel="noopener noreferrer" class="w3w-link">Open in what3words</a>`
            : '';
        html += `<p style="margin: 8px 0 0 0;"><strong>what3words:</strong> ${w3wLabel}${w3wLink}</p>`;
    }
    html += '</div>';
    return html;
}

/**
 * Payment summary for LeadLock work orders.
 */
function renderLeadLockPaymentSummaryHtml(order) {
    if (!order || order.leadlock_order_id == null || String(order.leadlock_order_id).trim() === '') {
        return '';
    }
    const depositAmt = parseFloat(order.deposit_amount);
    const balanceAmt = parseFloat(order.balance_amount);
    const pay = reconcileLeadLockPaymentFlagsForDisplay(order);
    const statusLabel = deriveLeadLockPaymentStatusLabel(pay);
    const invoice = (order.invoice_number || '').trim();
    return `<div style="margin-bottom: 16px; padding: 12px 16px; background: #eef6ff; border: 1px solid #b8d4f0; border-radius: 8px;">
<h4 style="margin: 0 0 10px 0; font-size: 15px;">Payment</h4>
<p style="margin: 0 0 6px 0;"><strong>Status:</strong> ${escapeHtml(statusLabel)}</p>
<p style="margin: 0 0 6px 0;"><strong>Deposit:</strong> ${escapeHtml(formatLeadLockPaidLabel(pay.deposit_paid))} — ${formatCurrency(Number.isFinite(depositAmt) ? depositAmt : 0)}</p>
<p style="margin: 0 0 6px 0;"><strong>Balance:</strong> ${escapeHtml(formatLeadLockPaidLabel(pay.balance_paid))} — ${formatCurrency(Number.isFinite(balanceAmt) ? balanceAmt : 0)}</p>
<p style="margin: 0 0 6px 0;"><strong>Paid in full:</strong> ${pay.paid_in_full ? 'Yes' : 'No'}</p>
<p style="margin: 0;"><strong>Invoice:</strong> ${invoice ? escapeHtml(invoice) : '—'}</p>
</div>`;
}

/** Combined LeadLock address and payment block (ref banner is on load sheet customer header). */
function renderLeadLockWorkOrderDetailsHtml(order, options = {}) {
    if (!isLeadLockOrder(order)) return '';
    const includePayment = options.includePayment !== false;
    return renderLeadLockWorkOrderAddressHtml(order) + (includePayment ? renderLeadLockPaymentSummaryHtml(order) : '');
}