// Production API Routes
const express = require('express');
const router = express.Router();
const { ProductionDatabase } = require('./production-database');
const { requireProductionAuth, requireAdmin, requireAdminOrOffice, requireManager, hashPassword } = require('./production-auth');
const BackupService = require('./backup-service');

// ============ AUTHENTICATION ROUTES ============

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log('=== LOGIN REQUEST ===');
        console.log('Username received:', username);
        console.log('Password received:', password ? '***' : 'MISSING');
        console.log('Session ID:', req.sessionID);
        
        if (!username || !password) {
            console.log('Missing username or password in request');
            return res.status(401).json({ success: false, error: 'Username and password are required' });
        }
        
        const { loginProductionUser } = require('./production-auth');
        const result = await loginProductionUser(username, password);
        
        console.log('Login result:', result.success ? 'SUCCESS' : 'FAILED', result.error || '');
        
        if (result.success) {
            req.session.production_authenticated = true;
            req.session.production_user = result.user;
            console.log('Session set - authenticated:', req.session.production_authenticated);
            console.log('Session user:', req.session.production_user);
            res.json({ success: true, user: result.user });
        } else {
            console.log('Login failed:', result.error);
            res.status(401).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Login route error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Login failed: ' + error.message });
    }
});

router.post('/logout', (req, res) => {
    req.session.production_authenticated = false;
    req.session.production_user = null;
    res.json({ success: true });
});

// LeadLock webhook auth - Bearer token for work order webhook (no session)
function validateLeadLockWebhook(req, res, next) {
    const apiKey = process.env.LEADLOCK_WEBHOOK_API_KEY || process.env.SALES_APP_WEBHOOK_API_KEY;
    if (!apiKey || !apiKey.trim()) {
        return res.status(503).json({ success: false, error: 'LeadLock webhook not configured' });
    }
    const authHeader = req.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token || token !== apiKey.trim()) {
        return res.status(401).json({ success: false, error: 'Invalid or missing Bearer token' });
    }
    next();
}

// Sales webhook auth - shared secret for server-to-server calls (no session)
function validateSalesWebhook(req, res, next) {
    const secret = process.env.SALES_APP_API_KEY || process.env.SALES_APP_WEBHOOK_SECRET;
    if (!secret || !secret.trim()) {
        return res.status(503).json({ success: false, error: 'Sales webhook not configured' });
    }
    const authHeader = req.get('Authorization');
    const webhookSecret = req.get('X-Webhook-Secret');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : webhookSecret?.trim();
    if (!token || token !== secret.trim()) {
        return res.status(401).json({ success: false, error: 'Invalid or missing webhook authorization' });
    }
    next();
}

// Sales app webhook - create works order when product is sold (no session auth)
router.post('/sales/product-sold', validateSalesWebhook, async (req, res) => {
    try {
        const { product_id, quantity, customer_name, order_date, sales_order_ref } = req.body;
        if (!product_id || quantity == null) {
            return res.status(400).json({ success: false, error: 'product_id and quantity are required' });
        }
        const productId = parseInt(product_id, 10);
        const qty = parseInt(quantity, 10) || 1;
        if (isNaN(productId) || productId < 1 || qty < 1) {
            return res.status(400).json({ success: false, error: 'product_id and quantity must be positive integers' });
        }
        const product = await ProductionDatabase.getProductById(productId);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        const orderDate = order_date || new Date().toISOString().slice(0, 10);
        const order = await ProductionDatabase.createProductOrder({
            products: [{ product_id: productId, quantity: qty }],
            order_date: orderDate,
            status: 'pending',
            customer_name: customer_name || null,
            created_by: null,
            sales_order_ref: sales_order_ref || null
        });
        console.log(`Sales webhook: created works order #${order.id} for product ${productId} x${qty}`);
        res.json({ success: true, order_id: order.id });
    } catch (error) {
        console.error('Sales product-sold webhook error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to create works order' });
    }
});

// LeadLock work order webhook - receive full orders from LeadLock sales app (no session auth)
router.post('/webhooks/work-orders', validateLeadLockWebhook, async (req, res) => {
    try {
        const body = req.body;
        if (!body || typeof body !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid or empty JSON body' });
        }
        if (!Array.isArray(body.items) || body.items.length === 0) {
            return res.status(400).json({ success: false, error: 'items array is required and must not be empty' });
        }
        const order = await ProductionDatabase.createLeadLockWorkOrder({
            order_number: body.order_number,
            order_id: body.order_id,
            customer_name: body.customer_name,
            customer_postcode: body.customer_postcode,
            customer_address: body.customer_address,
            customer_email: body.customer_email,
            customer_phone: body.customer_phone,
            items: body.items,
            total_amount: body.total_amount,
            currency: body.currency,
            installation_booked: body.installation_booked,
            created_at: body.created_at
        });
        console.log(`LeadLock webhook: created work order #${order.id} for ${body.order_number || body.order_id || 'unknown'}`);
        res.status(200).json({ success: true, work_order_id: String(order.id) });
    } catch (error) {
        console.error('LeadLock work order webhook error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to create work order' });
    }
});

router.get('/me', requireProductionAuth, (req, res) => {
    res.json({ success: true, user: req.session.production_user });
});

// Manual admin creation endpoint (for troubleshooting - remove in production if desired)
router.post('/create-admin', async (req, res) => {
    try {
        const { password = 'admin123' } = req.body;
        const { hashPassword } = require('./production-auth');
        const users = await ProductionDatabase.getAllUsers();
        
        // Check if admin already exists
        const adminExists = users.some(u => u.username === 'admin');
        if (adminExists) {
            return res.json({ 
                success: false, 
                message: 'Admin user already exists',
                users: users.length 
            });
        }
        
        // Create admin user
        const passwordHash = await hashPassword(password);
        const user = await ProductionDatabase.createUser('admin', passwordHash, 'admin');
        
        res.json({ 
            success: true, 
            message: 'Admin user created successfully',
            user: { id: user.id, username: user.username, role: user.role }
        });
    } catch (error) {
        console.error('Create admin error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ USER MANAGEMENT ROUTES (Admin only) ============

router.get('/users', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const users = await ProductionDatabase.getAllUsers();
        res.json({ success: true, users });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ success: false, error: 'Failed to get users' });
    }
});

router.post('/users', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;
        if (!username || !password || !role) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        if (!['admin', 'office', 'staff'].includes(role)) {
            return res.status(400).json({ success: false, error: 'Invalid role' });
        }
        
        const passwordHash = await hashPassword(password);
        const user = await ProductionDatabase.createUser(username, passwordHash, role);
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) {
        console.error('Create user error:', error);
        console.error('Error details:', error.message);
        console.error('Error stack:', error.stack);
        if (error.message && (error.message.includes('UNIQUE') || error.message.includes('duplicate'))) {
            res.status(400).json({ success: false, error: 'Username already exists' });
        } else if (error.message && error.message.includes('CHECK constraint')) {
            res.status(400).json({ 
                success: false, 
                error: 'Invalid role. The database may need to be migrated. Please contact support or restart the server.' 
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to create user',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
});

router.put('/users/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { username, role, password } = req.body;
        const userId = parseInt(req.params.id);
        
        if (role && !['admin', 'office', 'staff'].includes(role)) {
            return res.status(400).json({ success: false, error: 'Invalid role' });
        }
        
        if (password) {
            const passwordHash = await hashPassword(password);
            await ProductionDatabase.updateUserPassword(userId, passwordHash);
        }
        
        if (username || role) {
            const user = await ProductionDatabase.getUserById(userId);
            const updatedUser = await ProductionDatabase.updateUser(
                userId,
                username || user.username,
                role || user.role
            );
            res.json({ success: true, user: { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role } });
        } else {
            res.json({ success: true });
        }
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ success: false, error: 'Failed to update user' });
    }
});

router.delete('/users/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (userId === req.session.production_user.id) {
            return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
        }
        await ProductionDatabase.deleteUser(userId);
        res.json({ success: true });
    } catch (error) {
        // PostgreSQL foreign key violation: user is referenced by other tables (timesheets, orders, etc.)
        if (error.code === '23503') {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete user: they have linked records (timesheets, orders, tasks, etc.). Reassign or remove those first.'
            });
        }
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete user' });
    }
});

// ============ STOCK MANAGEMENT ROUTES ============

router.get('/stock', requireProductionAuth, async (req, res) => {
    try {
        const items = await ProductionDatabase.getAllStockItems();
        res.json({ success: true, items });
    } catch (error) {
        console.error('Get stock error:', error);
        res.status(500).json({ success: false, error: 'Failed to get stock items' });
    }
});

router.post('/stock', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { name, description, unit, current_quantity, min_quantity, location, cost_per_unit_gbp, category } = req.body;
        if (!name || !unit) {
            return res.status(400).json({ success: false, error: 'Name and unit are required' });
        }
        
        const item = await ProductionDatabase.createStockItem({
            name,
            description,
            unit,
            current_quantity: parseFloat(current_quantity) || 0,
            min_quantity: parseFloat(min_quantity) || 0,
            location,
            category: category && category.trim() ? category.trim() : null,
            cost_per_unit_gbp: parseFloat(cost_per_unit_gbp) || 0
        });
        res.json({ success: true, item });
    } catch (error) {
        console.error('Create stock item error:', error);
        res.status(500).json({ success: false, error: 'Failed to create stock item' });
    }
});

router.put('/stock/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        const { name, description, unit, min_quantity, location, cost_per_unit_gbp, category } = req.body;
        
        const item = await ProductionDatabase.updateStockItem(itemId, {
            name,
            description,
            unit,
            min_quantity: parseFloat(min_quantity) || 0,
            location,
            category: category && category.trim() ? category.trim() : null,
            cost_per_unit_gbp: parseFloat(cost_per_unit_gbp) || 0
        });
        res.json({ success: true, item });
    } catch (error) {
        console.error('Update stock item error:', error);
        res.status(500).json({ success: false, error: 'Failed to update stock item' });
    }
});

router.delete('/stock/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        await ProductionDatabase.deleteStockItem(itemId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete stock item error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete stock item' });
    }
});

router.get('/stock/:id/movements', requireProductionAuth, async (req, res) => {
    try {
        const stockItemId = parseInt(req.params.id);
        const movements = await ProductionDatabase.getStockMovements(stockItemId);
        res.json({ success: true, movements });
    } catch (error) {
        console.error('Get stock movements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get stock movements' });
    }
});

router.post('/stock/:id/movement', requireProductionAuth, async (req, res) => {
    try {
        const stockItemId = parseInt(req.params.id);
        const { movement_type, quantity, reference, cost_gbp } = req.body;
        
        if (!movement_type || !quantity) {
            return res.status(400).json({ success: false, error: 'Movement type and quantity are required' });
        }
        
        if (!['in', 'out', 'adjustment'].includes(movement_type)) {
            return res.status(400).json({ success: false, error: 'Invalid movement type' });
        }
        
        const movement = await ProductionDatabase.recordStockMovement({
            stock_item_id: stockItemId,
            movement_type,
            quantity: parseFloat(quantity),
            reference,
            user_id: req.session.production_user.id,
            cost_gbp: parseFloat(cost_gbp) || 0
        });
        res.json({ success: true, movement });
    } catch (error) {
        console.error('Record stock movement error:', error);
        res.status(500).json({ success: false, error: 'Failed to record stock movement' });
    }
});

// ============ PANELS & BOM ROUTES ============

router.get('/panels', requireProductionAuth, async (req, res) => {
    try {
        const panels = await ProductionDatabase.getAllPanels();
        res.json({ success: true, panels });
    } catch (error) {
        console.error('Get panels error:', error);
        res.status(500).json({ success: false, error: 'Failed to get panels' });
    }
});

router.post('/panels', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { name, description, panel_type, status, built_quantity, min_stock, labour_hours } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        
        // Cost is calculated automatically from BOM + labour
        const panel = await ProductionDatabase.createPanel({
            name,
            description,
            panel_type,
            status,
            built_quantity: parseFloat(built_quantity) || 0,
            min_stock: parseFloat(min_stock) || 0,
            labour_hours: parseFloat(labour_hours) || 0
        });
        res.json({ success: true, panel });
    } catch (error) {
        console.error('Create panel error:', error);
        console.error('Error stack:', error.stack);
        console.error('Request body:', req.body);
        
        // Provide more detailed error messages
        let errorMessage = 'Failed to create built item';
        if (error.message) {
            if (error.message.includes('FOREIGN KEY') || error.message.includes('foreign key constraint')) {
                errorMessage = 'Database constraint error. Please check all fields are valid.';
            } else if (error.message.includes('UNIQUE') || error.message.includes('duplicate')) {
                errorMessage = 'A built item with this name may already exist.';
            } else if (error.message.includes('NOT NULL') || error.message.includes('null value')) {
                errorMessage = 'Missing required field. Please check all required fields are filled.';
            } else {
                errorMessage = error.message;
            }
        }
        
        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

router.put('/panels/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const { name, description, panel_type, status, built_quantity, min_stock, labour_hours } = req.body;
        
        // Cost is calculated automatically from BOM + labour
        const panel = await ProductionDatabase.updatePanel(panelId, {
            name,
            description,
            panel_type,
            status,
            built_quantity: parseFloat(built_quantity) || 0,
            min_stock: parseFloat(min_stock) || 0,
            labour_hours: parseFloat(labour_hours) || 0
        });
        res.json({ success: true, panel });
    } catch (error) {
        console.error('Update panel error:', error);
        res.status(500).json({ success: false, error: 'Failed to update panel' });
    }
});

router.delete('/panels/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        await ProductionDatabase.deletePanel(panelId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete panel error:', error);
        console.error('Error stack:', error.stack);
        
        // Provide more detailed error messages
        let errorMessage = 'Failed to delete built item';
        if (error.message) {
            if (error.message.includes('FOREIGN KEY') || error.message.includes('foreign key constraint')) {
                errorMessage = 'Cannot delete built item because it is still referenced by other records (movements, planner items, or products). Please remove all references first.';
            } else if (error.message.includes('constraint') || error.message.includes('violates')) {
                errorMessage = 'Cannot delete built item due to database constraints. It may be in use by other parts of the system.';
            } else {
                errorMessage = error.message;
            }
        }
        
        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

router.get('/panels/:id/bom', requireProductionAuth, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const bom = await ProductionDatabase.getPanelBOM(panelId);
        
        // Enrich BOM items with cost information
        const bomWithCosts = await Promise.all(bom.map(async (item) => {
            const qty = parseFloat(item.quantity_required || 0);
            let itemCost = 0;
            
            if (item.item_type === 'raw_material') {
                const stockItem = await ProductionDatabase.getStockItemById(item.item_id);
                if (stockItem) {
                    itemCost = parseFloat(stockItem.cost_per_unit_gbp || 0) * qty;
                }
            } else if (item.item_type === 'component') {
                const componentCost = await ProductionDatabase.calculateComponentTrueCost(item.item_id);
                itemCost = componentCost * qty;
            }
            
            return {
                ...item,
                item_cost_gbp: itemCost
            };
        }));
        
        res.json({ success: true, bom: bomWithCosts });
    } catch (error) {
        console.error('Get panel BOM error:', error);
        console.error('Error stack:', error.stack);
        console.error('Panel ID:', req.params.id);

        // Provide more detailed error messages
        let errorMessage = 'Failed to get panel BOM';
        if (error.message) {
            if (error.message.includes('relation') || error.message.includes('table')) {
                errorMessage = 'Database table error. Please contact support.';
            } else if (error.message.includes('syntax') || error.message.includes('SQL')) {
                errorMessage = 'Database query error. Please contact support.';
            } else {
                errorMessage = error.message;
            }
        }
        
        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

router.post('/panels/:id/bom', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const { item_type, item_id, quantity_required, unit } = req.body;
        
        if (!item_type || !item_id || !quantity_required || !unit) {
            return res.status(400).json({ success: false, error: 'Item type, item ID, quantity, and unit are required' });
        }
        
        if (!['raw_material', 'component'].includes(item_type)) {
            return res.status(400).json({ success: false, error: 'Item type must be raw_material or component' });
        }
        
        const bomItem = await ProductionDatabase.addBOMItem(
            panelId,
            item_type,
            parseInt(item_id),
            parseFloat(quantity_required),
            unit
        );
        res.json({ success: true, bomItem });
    } catch (error) {
        console.error('Add BOM item error:', error);
        console.error('Error stack:', error.stack);
        console.error('Request body:', req.body);
        
        let errorMessage = 'Failed to add BOM item';
        if (error.message && error.message.includes('does not exist')) {
            errorMessage = 'Database schema needs migration. Please contact support or restart the server.';
        } else if (error.message && error.message.includes('FOREIGN KEY')) {
            errorMessage = 'Invalid item ID. Please ensure the selected item exists.';
        } else if (error.message && error.message.includes('duplicate')) {
            errorMessage = 'This item is already in the BOM.';
        } else if (error.message) {
            errorMessage = `Failed to add BOM item: ${error.message}`;
        }
        
        res.status(500).json({ success: false, error: errorMessage, detail: error.message });
    }
});

router.delete('/panels/:id/bom/:bomId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const bomId = parseInt(req.params.bomId);
        await ProductionDatabase.deleteBOMItem(bomId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete BOM item error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete BOM item' });
    }
});

router.get('/panels/:id/bom-value', requireProductionAuth, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const bomValue = await ProductionDatabase.calculateBOMValue(panelId);
        res.json({ success: true, bom_value: bomValue });
    } catch (error) {
        console.error('Calculate BOM value error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate BOM value' });
    }
});

router.get('/panels/:id/true-cost', requireProductionAuth, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const trueCost = await ProductionDatabase.calculatePanelTrueCost(panelId);
        res.json({ success: true, true_cost: trueCost });
    } catch (error) {
        console.error('Calculate true cost error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate true cost' });
    }
});

router.get('/panels/:id/movements', requireProductionAuth, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const movements = await ProductionDatabase.getPanelMovements(panelId);
        res.json({ success: true, movements });
    } catch (error) {
        console.error('Get panel movements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get panel movements' });
    }
});

router.post('/panels/:id/movement', requireProductionAuth, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const { movement_type, quantity, reference } = req.body;
        
        if (!movement_type || !quantity) {
            return res.status(400).json({ success: false, error: 'Movement type and quantity are required' });
        }
        
        if (!['build', 'use', 'adjustment'].includes(movement_type)) {
            return res.status(400).json({ success: false, error: 'Invalid movement type' });
        }
        
        const movement = await ProductionDatabase.recordPanelMovement({
            panel_id: panelId,
            movement_type,
            quantity: parseFloat(quantity),
            reference,
            user_id: req.session.production_user.id
        });
        res.json({ success: true, movement });
    } catch (error) {
        console.error('Record panel movement error:', error);
        res.status(500).json({ success: false, error: 'Failed to record panel movement' });
    }
});

// ============ COMPONENTS ROUTES ============

router.get('/components', requireProductionAuth, async (req, res) => {
    try {
        const components = await ProductionDatabase.getAllComponents();
        res.json({ success: true, components });
    } catch (error) {
        console.error('Get components error:', error);
        res.status(500).json({ success: false, error: 'Failed to get components' });
    }
});

router.post('/components', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { name, description, component_type, status, built_quantity, min_stock, labour_hours } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        
        const component = await ProductionDatabase.createComponent({
            name,
            description,
            component_type,
            status,
            built_quantity: parseFloat(built_quantity) || 0,
            min_stock: parseFloat(min_stock) || 0,
            labour_hours: parseFloat(labour_hours) || 0
        });
        res.json({ success: true, component });
    } catch (error) {
        console.error('Create component error:', error);
        res.status(500).json({ success: false, error: 'Failed to create component' });
    }
});

router.put('/components/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        const { name, description, component_type, status, built_quantity, min_stock, labour_hours } = req.body;
        
        const component = await ProductionDatabase.updateComponent(componentId, {
            name,
            description,
            component_type,
            status,
            built_quantity: parseFloat(built_quantity) || 0,
            min_stock: parseFloat(min_stock) || 0,
            labour_hours: parseFloat(labour_hours) || 0
        });
        res.json({ success: true, component });
    } catch (error) {
        console.error('Update component error:', error);
        res.status(500).json({ success: false, error: 'Failed to update component' });
    }
});

router.delete('/components/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        await ProductionDatabase.deleteComponent(componentId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete component error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete component' });
    }
});

router.get('/components/:id/bom', requireProductionAuth, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        const bom = await ProductionDatabase.getComponentBOM(componentId);
        
        // Enrich BOM items with cost information
        const bomWithCosts = await Promise.all(bom.map(async (item) => {
            const stockItem = await ProductionDatabase.getStockItemById(item.stock_item_id);
            const qty = parseFloat(item.quantity_required || 0);
            const itemCost = stockItem ? parseFloat(stockItem.cost_per_unit_gbp || 0) * qty : 0;
            
            return {
                ...item,
                item_cost_gbp: itemCost
            };
        }));
        
        res.json({ success: true, bom: bomWithCosts });
    } catch (error) {
        console.error('Get component BOM error:', error);
        res.status(500).json({ success: false, error: 'Failed to get component BOM' });
    }
});

router.post('/components/:id/bom', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        const { stock_item_id, quantity_required, unit } = req.body;
        
        if (!stock_item_id || !quantity_required || !unit) {
            return res.status(400).json({ success: false, error: 'Stock item, quantity, and unit are required' });
        }
        
        const bomItem = await ProductionDatabase.addComponentBOMItem(
            componentId,
            parseInt(stock_item_id),
            parseFloat(quantity_required),
            unit
        );
        res.json({ success: true, bomItem });
    } catch (error) {
        console.error('Add component BOM item error:', error);
        console.error('Error stack:', error.stack);
        console.error('Request body:', req.body);
        console.error('Component ID:', req.params.id);
        
        // Provide more detailed error messages
        let errorMessage = 'Failed to add component BOM item';
        if (error.message) {
            if (error.message.includes('FOREIGN KEY') || error.message.includes('foreign key constraint')) {
                errorMessage = 'Cannot add BOM item. The raw material or component may not exist.';
            } else if (error.message.includes('UNIQUE') || error.message.includes('duplicate')) {
                errorMessage = 'This BOM item already exists for this component.';
            } else if (error.message.includes('NOT NULL') || error.message.includes('null value')) {
                errorMessage = 'Missing required field. Please check all fields are filled.';
            } else {
                errorMessage = error.message;
            }
        }
        
        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

router.delete('/components/:id/bom/:bomId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const bomId = parseInt(req.params.bomId);
        await ProductionDatabase.deleteComponentBOMItem(bomId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete component BOM item error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete component BOM item' });
    }
});

router.get('/components/:id/cost', requireProductionAuth, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        const bomValue = await ProductionDatabase.calculateComponentBOMValue(componentId);
        res.json({ success: true, bom_value: bomValue });
    } catch (error) {
        console.error('Calculate component BOM value error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate component BOM value' });
    }
});

router.get('/components/:id/true-cost', requireProductionAuth, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        const trueCost = await ProductionDatabase.calculateComponentTrueCost(componentId);
        res.json({ success: true, true_cost: trueCost });
    } catch (error) {
        console.error('Calculate component true cost error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate component true cost' });
    }
});

router.get('/components/:id/movements', requireProductionAuth, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        const movements = await ProductionDatabase.getComponentMovements(componentId);
        res.json({ success: true, movements });
    } catch (error) {
        console.error('Get component movements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get component movements' });
    }
});

router.post('/components/:id/movement', requireProductionAuth, async (req, res) => {
    try {
        const componentId = parseInt(req.params.id);
        const { movement_type, quantity, reference } = req.body;
        
        if (!movement_type || !quantity) {
            return res.status(400).json({ success: false, error: 'Movement type and quantity are required' });
        }
        
        if (!['build', 'use', 'adjustment'].includes(movement_type)) {
            return res.status(400).json({ success: false, error: 'Invalid movement type' });
        }
        
        const movement = await ProductionDatabase.recordComponentMovement({
            component_id: componentId,
            movement_type,
            quantity: parseFloat(quantity),
            reference,
            user_id: req.session.production_user.id
        });
        res.json({ success: true, movement });
    } catch (error) {
        console.error('Record component movement error:', error);
        res.status(500).json({ success: false, error: 'Failed to record component movement' });
    }
});

router.get('/wip', requireProductionAuth, async (req, res) => {
    try {
        const wipData = await ProductionDatabase.getWIPData();
        res.json({ success: true, wip: wipData });
    } catch (error) {
        console.error('Get WIP data error:', error);
        res.status(500).json({ success: false, error: 'Failed to get WIP data' });
    }
});

router.get('/dashboard/summary', requireProductionAuth, async (req, res) => {
    try {
        const wipData = await ProductionDatabase.getWIPData();
        const totalWIPValue = wipData.reduce((sum, panel) => sum + parseFloat(panel.wip_value || 0), 0);
        
        const totalStockValue = await ProductionDatabase.getTotalStockValue();
        const totalPanelValue = await ProductionDatabase.getTotalPanelValue();
        const lastWeekSummary = await ProductionDatabase.getLastWeekPlannerSummary();
        
        res.json({
            success: true,
            summary: {
                total_wip_value: totalWIPValue,
                total_stock_value: totalStockValue,
                total_panel_value: totalPanelValue,
                last_week: lastWeekSummary
            }
        });
    } catch (error) {
        console.error('Get dashboard summary error:', error);
        res.status(500).json({ success: false, error: 'Failed to get dashboard summary' });
    }
});

// ============ SETTINGS ROUTES ============

router.get('/settings', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await ProductionDatabase.getAllSettings();
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ success: false, error: 'Failed to get settings' });
    }
});

router.get('/settings/:key', requireProductionAuth, async (req, res) => {
    try {
        const value = await ProductionDatabase.getSetting(req.params.key);
        res.json({ success: true, value });
    } catch (error) {
        console.error('Get setting error:', error);
        res.status(500).json({ success: false, error: 'Failed to get setting' });
    }
});

router.put('/settings/:key', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { value } = req.body;
        await ProductionDatabase.setSetting(req.params.key, value);
        res.json({ success: true });
    } catch (error) {
        console.error('Set setting error:', error);
        res.status(500).json({ success: false, error: 'Failed to set setting' });
    }
});

// ============ FINISHED PRODUCTS ROUTES ============

router.get('/products', requireProductionAuth, async (req, res) => {
    try {
        const products = await ProductionDatabase.getAllProducts();
        res.json({ success: true, products });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ success: false, error: 'Failed to get products' });
    }
});

router.post('/products', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { name, description, product_type, category, status, estimated_load_time, estimated_install_time, estimated_travel_time, number_of_boxes } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        
        // Cost is calculated automatically from components (panels + materials) + load time labour
        const product = await ProductionDatabase.createProduct({
            name,
            description,
            product_type,
            category,
            status,
            estimated_load_time,
            estimated_install_time,
            estimated_travel_time,
            number_of_boxes
        });
        res.json({ success: true, product });
    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({ success: false, error: 'Failed to create product' });
    }
});

router.put('/products/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const { name, description, product_type, category, status, estimated_load_time, estimated_install_time, estimated_travel_time, number_of_boxes } = req.body;
        
        // Cost is calculated automatically from components + load time labour
        const product = await ProductionDatabase.updateProduct(productId, {
            name,
            description,
            product_type,
            category,
            status,
            estimated_load_time,
            estimated_install_time,
            estimated_travel_time,
            number_of_boxes
        });
        res.json({ success: true, product });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ success: false, error: 'Failed to update product' });
    }
});

router.delete('/products/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        await ProductionDatabase.deleteProduct(productId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete product error:', error);
        const msg = error.message || 'Failed to delete product';
        const isInUse = msg.includes('used in one or more orders');
        res.status(isInUse ? 409 : 500).json({ success: false, error: msg });
    }
});

router.get('/products/:id/components', requireProductionAuth, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const components = await ProductionDatabase.getProductComponents(productId);
        res.json({ success: true, components });
    } catch (error) {
        console.error('Get product components error:', error);
        res.status(500).json({ success: false, error: 'Failed to get product components' });
    }
});

router.get('/products/:id/cost', requireProductionAuth, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const productCost = await ProductionDatabase.calculateProductCost(productId);
        res.json({ success: true, cost: productCost });
    } catch (error) {
        console.error('Calculate product cost error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate product cost' });
    }
});

router.post('/products/:id/push-to-sales', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const salesApiUrl = process.env.SALES_APP_API_URL;
        const salesApiKey = process.env.SALES_APP_API_KEY;

        if (!salesApiUrl || !salesApiUrl.trim()) {
            return res.status(503).json({ success: false, error: 'Sales app not configured. Set SALES_APP_API_URL in environment.' });
        }

        const product = await ProductionDatabase.getProductById(productId);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        const costData = await ProductionDatabase.calculateProductCost(productId);
        const priceExVat = parseFloat(costData ?? product.cost_gbp ?? 0) || 0;
        const numberOfBoxes = parseInt(product.number_of_boxes ?? 1, 10) || 1;

        const payload = {
            product_id: productId,
            name: product.name,
            description: product.description || '',
            price_ex_vat: priceExVat,
            install_hours: parseFloat(product.estimated_install_time ?? 0) || 0,
            number_of_boxes: numberOfBoxes
        };

        const headers = {
            'Content-Type': 'application/json',
            ...(salesApiKey && salesApiKey.trim() && { 'Authorization': `Bearer ${salesApiKey.trim()}` })
        };

        const response = await fetch(salesApiUrl.trim(), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('Sales app push failed:', response.status, text);
            return res.status(502).json({
                success: false,
                error: `Sales app returned ${response.status}: ${text || response.statusText}`
            });
        }

        const result = await response.json().catch(() => ({}));
        await ProductionDatabase.recordProductSalesSync(productId);
        res.json({ success: true, message: 'Product pushed to sales app', result });
    } catch (error) {
        console.error('Push to sales error:', error);
        const msg = error.message || 'Failed to push product to sales app';
        if (error.cause?.code === 'ENOTFOUND' || error.cause?.code === 'ECONNREFUSED') {
            return res.status(503).json({ success: false, error: 'Cannot reach sales app. Check SALES_APP_API_URL.' });
        }
        res.status(500).json({ success: false, error: msg });
    }
});

router.post('/products/:id/components', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const { component_type, component_id, quantity_required, unit } = req.body;
        
        if (!component_type || !component_id || !quantity_required || !unit) {
            return res.status(400).json({ success: false, error: 'All component fields are required' });
        }
        
        if (!['raw_material', 'component', 'built_item'].includes(component_type)) {
            return res.status(400).json({ success: false, error: 'Invalid component type. Must be raw_material, component, or built_item' });
        }
        
        const component = await ProductionDatabase.addProductComponent(
            productId,
            component_type,
            parseInt(component_id),
            parseFloat(quantity_required),
            unit
        );
        res.json({ success: true, component });
    } catch (error) {
        console.error('Add product component error:', error);
        res.status(500).json({ success: false, error: 'Failed to add product component' });
    }
});

router.put('/products/:id/components/:compId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const compId = parseInt(req.params.compId);
        const { component_type, component_id, quantity_required, unit } = req.body;
        
        if (!component_type || !component_id || !quantity_required || !unit) {
            return res.status(400).json({ success: false, error: 'All component fields are required' });
        }
        
        if (!['raw_material', 'component', 'built_item'].includes(component_type)) {
            return res.status(400).json({ success: false, error: 'Invalid component type. Must be raw_material, component, or built_item' });
        }
        
        const component = await ProductionDatabase.updateProductComponent(compId, {
            component_type,
            component_id: parseInt(component_id),
            quantity_required: parseFloat(quantity_required),
            unit
        });
        res.json({ success: true, component });
    } catch (error) {
        console.error('Update product component error:', error);
        res.status(500).json({ success: false, error: 'Failed to update product component' });
    }
});

router.delete('/products/:id/components/:compId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const compId = parseInt(req.params.compId);
        await ProductionDatabase.deleteProductComponent(compId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete product component error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete product component' });
    }
});

router.post('/products/:id/duplicate', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const originalProduct = await ProductionDatabase.getProductById(productId);
        
        if (!originalProduct) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        
        // Get all products to check for existing copies
        const allProducts = await ProductionDatabase.getAllProducts();
        const baseName = originalProduct.name;
        let newName = `${baseName} (Copy)`;
        let copyNumber = 1;
        
        // Check if a copy already exists and increment the number
        while (allProducts.some(p => p.name === newName)) {
            copyNumber++;
            newName = `${baseName} (Copy ${copyNumber})`;
        }
        
        // Create the duplicate product
        const duplicateProduct = await ProductionDatabase.createProduct({
            name: newName,
            description: originalProduct.description || '',
            product_type: originalProduct.product_type || '',
            category: originalProduct.category || 'Other',
            status: originalProduct.status || 'active',
            estimated_load_time: originalProduct.estimated_load_time ?? 0,
            estimated_install_time: originalProduct.estimated_install_time ?? 0,
            estimated_travel_time: originalProduct.estimated_travel_time ?? 0,
            number_of_boxes: originalProduct.number_of_boxes ?? 1
        });
        
        // Copy all components from the original product
        const originalComponents = await ProductionDatabase.getProductComponents(productId);
        for (const comp of originalComponents) {
            await ProductionDatabase.addProductComponent(
                duplicateProduct.id,
                comp.component_type,
                comp.component_id,
                parseFloat(comp.quantity_required),
                comp.unit
            );
        }
        
        // Get the final product with all components
        const finalProduct = await ProductionDatabase.getProductById(duplicateProduct.id);
        res.json({ success: true, product: finalProduct });
    } catch (error) {
        console.error('Duplicate product error:', error);
        res.status(500).json({ success: false, error: 'Failed to duplicate product' });
    }
});

// ============ MATERIAL REQUIREMENTS ROUTES ============

router.post('/requirements/calculate', requireProductionAuth, async (req, res) => {
    try {
        const { orders, order_id } = req.body;
        
        let orderList = [];
        if (order_id) {
            const order = await ProductionDatabase.getProductOrderById(parseInt(order_id));
            if (!order) {
                return res.status(404).json({ success: false, error: 'Order not found' });
            }
            if (order.products && order.products.length > 0) {
                orderList = order.products.map(p => ({ product_id: p.product_id, quantity: p.quantity }));
            } else {
                orderList = [{ product_id: order.product_id, quantity: order.quantity || 1 }];
            }
        } else if (orders && Array.isArray(orders)) {
            orderList = orders;
        } else {
            return res.status(400).json({ success: false, error: 'Orders array or order_id required' });
        }
        
        const requirements = await ProductionDatabase.calculateMaterialRequirements(orderList);
        res.json({ success: true, requirements });
    } catch (error) {
        console.error('Calculate requirements error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate requirements' });
    }
});

router.get('/products/:id/requirements', requireProductionAuth, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const orders = [{ product_id: productId, quantity: 1 }];
        const requirements = await ProductionDatabase.calculateMaterialRequirements(orders);
        res.json({ success: true, requirements });
    } catch (error) {
        console.error('Get product requirements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get product requirements' });
    }
});

router.post('/orders/:id/requirements', requireProductionAuth, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const order = await ProductionDatabase.getProductOrderById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        
        let orderList = [];
        if (order.products && order.products.length > 0) {
            orderList = order.products.map(p => ({ product_id: p.product_id, quantity: p.quantity }));
        } else if (order.product_id) {
            orderList = [{ product_id: order.product_id, quantity: order.quantity || 1 }];
        }
        const requirements = await ProductionDatabase.calculateMaterialRequirements(orderList);
        res.json({ success: true, requirements });
    } catch (error) {
        console.error('Get order requirements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get order requirements' });
    }
});

router.get('/orders/:id/load-sheet', requireProductionAuth, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const loadSheet = await ProductionDatabase.getLoadSheet(orderId);
        res.json({ success: true, load_sheet: loadSheet });
    } catch (error) {
        console.error('Get load sheet error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to get load sheet' });
    }
});

// ============ ORDER PRODUCTS ROUTES ============

router.get('/orders/:id/products', requireProductionAuth, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const products = await ProductionDatabase.getOrderProducts(orderId);
        res.json({ success: true, products });
    } catch (error) {
        console.error('Get order products error:', error);
        res.status(500).json({ success: false, error: 'Failed to get order products' });
    }
});

router.post('/orders/:id/products', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const { product_id, quantity } = req.body;
        
        if (!product_id || !quantity) {
            return res.status(400).json({ success: false, error: 'Product ID and quantity are required' });
        }
        
        // Check if order exists
        const order = await ProductionDatabase.getProductOrderById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        
        const products = await ProductionDatabase.addProductToOrder(orderId, parseInt(product_id), parseInt(quantity));
        res.json({ success: true, products });
    } catch (error) {
        console.error('Add order product error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to add product to order' });
    }
});

router.delete('/orders/:id/products/:productId', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const orderProductId = parseInt(req.params.productId);
        
        // Check if order exists
        const order = await ProductionDatabase.getProductOrderById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        
        const products = await ProductionDatabase.removeProductFromOrder(orderId, orderProductId);
        res.json({ success: true, products });
    } catch (error) {
        console.error('Delete order product error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to remove product from order' });
    }
});

// ============ ORDER SPARES ROUTES ============

router.get('/orders/:id/spares', requireProductionAuth, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const spares = await ProductionDatabase.getOrderSpares(orderId);
        res.json({ success: true, spares });
    } catch (error) {
        console.error('Get order spares error:', error);
        res.status(500).json({ success: false, error: 'Failed to get order spares' });
    }
});

router.post('/orders/:id/spares', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const { item_type, item_id, quantity_needed, notes } = req.body;
        
        if (!item_type || !item_id || !quantity_needed) {
            return res.status(400).json({ success: false, error: 'Item type, item ID, and quantity needed are required' });
        }
        
        if (!['component', 'built_item', 'raw_material'].includes(item_type)) {
            return res.status(400).json({ success: false, error: 'Invalid item type. Must be component, built_item, or raw_material' });
        }
        
        const spare = await ProductionDatabase.createOrderSpare(orderId, {
            item_type,
            item_id: parseInt(item_id),
            quantity_needed: parseFloat(quantity_needed),
            notes: notes || null
        });
        res.json({ success: true, spare });
    } catch (error) {
        console.error('Create order spare error:', error);
        res.status(500).json({ success: false, error: 'Failed to create order spare' });
    }
});

router.put('/orders/:id/spares/:spareId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const spareId = parseInt(req.params.spareId);
        const { quantity_needed, quantity_loaded, quantity_used, quantity_returned, notes } = req.body;
        
        const updateData = {};
        if (quantity_needed !== undefined) updateData.quantity_needed = quantity_needed;
        if (quantity_loaded !== undefined) updateData.quantity_loaded = quantity_loaded;
        if (quantity_used !== undefined) updateData.quantity_used = quantity_used;
        if (quantity_returned !== undefined) updateData.quantity_returned = quantity_returned;
        if (notes !== undefined) updateData.notes = notes;
        
        const spare = await ProductionDatabase.updateOrderSpare(spareId, updateData);
        res.json({ success: true, spare });
    } catch (error) {
        console.error('Update order spare error:', error);
        res.status(500).json({ success: false, error: 'Failed to update order spare' });
    }
});

router.post('/orders/:id/spares/:spareId/return', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const spareId = parseInt(req.params.spareId);
        const { quantity } = req.body;
        
        if (!quantity || parseFloat(quantity) <= 0) {
            return res.status(400).json({ success: false, error: 'Valid quantity is required' });
        }
        
        const userId = req.session.production_user ? req.session.production_user.id : null;
        const spare = await ProductionDatabase.returnSpareToStock(spareId, parseFloat(quantity), userId);
        res.json({ success: true, spare, message: 'Spare returned to stock successfully' });
    } catch (error) {
        console.error('Return spare to stock error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to return spare to stock' });
    }
});

router.delete('/orders/:id/spares/:spareId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const spareId = parseInt(req.params.spareId);
        await ProductionDatabase.deleteOrderSpare(spareId);
        res.json({ success: true, message: 'Spare deleted successfully' });
    } catch (error) {
        console.error('Delete order spare error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete order spare' });
    }
});

// ============ QUOTES ROUTES ============

router.get('/quotes', requireProductionAuth, async (req, res) => {
    try {
        const orders = await ProductionDatabase.getAllProductOrders();
        // Filter to only return quotes (status = 'quote')
        const quotes = orders.filter(order => order.status === 'quote');
        res.json({ success: true, quotes });
    } catch (error) {
        console.error('Get quotes error:', error);
        res.status(500).json({ success: false, error: 'Failed to get quotes' });
    }
});

router.post('/quotes', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const { product_id, quantity, order_date } = req.body;
        if (!product_id || !quantity) {
            return res.status(400).json({ success: false, error: 'Product ID and quantity are required' });
        }
        
        // Create quote with status 'quote'
        const quote = await ProductionDatabase.createProductOrder({
            product_id: parseInt(product_id),
            quantity: parseInt(quantity),
            order_date,
            status: 'quote',
            created_by: req.session.production_user.id
        });
        res.json({ success: true, quote });
    } catch (error) {
        console.error('Create quote error:', error);
        res.status(500).json({ success: false, error: 'Failed to create quote' });
    }
});

router.post('/quotes/:id/convert-to-order', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const quoteId = parseInt(req.params.id);
        const quote = await ProductionDatabase.getProductOrderById(quoteId);
        
        if (!quote) {
            return res.status(404).json({ success: false, error: 'Quote not found' });
        }
        
        if (quote.status !== 'quote') {
            return res.status(400).json({ success: false, error: 'This is not a quote. Only quotes can be converted to orders.' });
        }
        
        // Convert quote to order by changing status to 'pending'
        const order = await ProductionDatabase.updateProductOrder(quoteId, {
            status: 'pending'
        });
        res.json({ success: true, order, message: 'Quote converted to order successfully' });
    } catch (error) {
        console.error('Convert quote to order error:', error);
        res.status(500).json({ success: false, error: 'Failed to convert quote to order' });
    }
});

// ============ PRODUCT ORDERS ROUTES ============

router.get('/orders', requireProductionAuth, async (req, res) => {
    try {
        const orders = await ProductionDatabase.getAllProductOrders();
        // Filter out quotes - only return actual orders
        const actualOrders = orders.filter(order => order.status !== 'quote');
        res.json({ success: true, orders: actualOrders });
    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({ success: false, error: 'Failed to get orders' });
    }
});

router.post('/orders', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const { products, product_id, quantity, order_date, status, customer_name } = req.body;
        
        // Support both new format (products array) and old format (single product_id)
        let productsArray = products;
        if (!productsArray && product_id && quantity) {
            // Old format - convert to new format
            productsArray = [{ product_id: parseInt(product_id), quantity: parseInt(quantity) }];
        }
        
        if (!productsArray || productsArray.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one product is required' });
        }
        
        // Validate products array
        for (const product of productsArray) {
            if (!product.product_id || !product.quantity) {
                return res.status(400).json({ success: false, error: 'Each product must have product_id and quantity' });
            }
        }
        
        // Ensure we don't create quotes through the orders endpoint
        const orderStatus = status && status !== 'quote' ? status : 'pending';
        
        const order = await ProductionDatabase.createProductOrder({
            products: productsArray.map(p => ({
                product_id: parseInt(p.product_id),
                quantity: parseInt(p.quantity)
            })),
            order_date,
            status: orderStatus,
            customer_name: customer_name || null,
            created_by: req.session.production_user.id
        });
        res.json({ success: true, order });
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to create order' });
    }
});

router.get('/orders/:id', requireProductionAuth, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const order = await ProductionDatabase.getProductOrderById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        res.json({ success: true, order });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ success: false, error: 'Failed to get order' });
    }
});

router.put('/orders/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const { product_id, quantity, order_date, status, customer_name } = req.body;
        
        const updateData = {};
        if (product_id !== undefined) updateData.product_id = parseInt(product_id);
        if (quantity !== undefined) updateData.quantity = parseInt(quantity);
        if (order_date !== undefined) updateData.order_date = order_date;
        if (status !== undefined) updateData.status = status;
        if (customer_name !== undefined) updateData.customer_name = customer_name;
        
        const order = await ProductionDatabase.updateProductOrder(orderId, updateData);
        res.json({ success: true, order });
    } catch (error) {
        console.error('Update order error:', error);
        res.status(500).json({ success: false, error: 'Failed to update order' });
    }
});

router.delete('/orders/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const order = await ProductionDatabase.deleteProductOrder(orderId);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        res.json({ success: true, message: 'Order deleted successfully' });
    } catch (error) {
        console.error('Delete order error:', error);
        const msg = error.message || 'Failed to delete order';
        const isBlocked = msg.includes('linked to one or more installations');
        res.status(isBlocked ? 409 : 500).json({ success: false, error: msg });
    }
});

// Get installations linked to a works order
router.get('/orders/:id/installations', requireProductionAuth, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const installations = await ProductionDatabase.getAllInstallations();
        const orderInstallations = installations.filter(inst => inst.works_order_id === orderId);
        res.json({ success: true, installations: orderInstallations });
    } catch (error) {
        console.error('Get order installations error:', error);
        res.status(500).json({ success: false, error: 'Failed to get installations' });
    }
});

// Create installation from works order
router.post('/orders/:id/installations', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const { installation_date, start_time, end_time, duration_hours, location, address, notes, status, assigned_users } = req.body;
        
        if (!installation_date || !start_time || !duration_hours) {
            return res.status(400).json({ success: false, error: 'Installation date, start time, and duration are required' });
        }
        
        const installation = await ProductionDatabase.createInstallation({
            works_order_id: orderId,
            installation_date,
            start_time,
            end_time,
            duration_hours,
            location,
            address,
            notes,
            status,
            assigned_users: assigned_users || [],
            created_by: req.session.production_user.id
        });
        
        res.json({ success: true, installation });
    } catch (error) {
        console.error('Create installation from order error:', error);
        res.status(500).json({ success: false, error: 'Failed to create installation' });
    }
});

// ============ INSTALLATION ROUTES ============

router.get('/installations', requireProductionAuth, async (req, res) => {
    try {
        const startDate = req.query.start_date || null;
        const endDate = req.query.end_date || null;
        console.log('Getting installations with start_date:', startDate, 'end_date:', endDate);
        const installations = await ProductionDatabase.getAllInstallations(startDate, endDate);
        console.log('Successfully retrieved', installations.length, 'installations');
        res.json({ success: true, installations });
    } catch (error) {
        console.error('Get installations error:', error);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to get installations', details: error.message });
    }
});

router.get('/installations/:id', requireProductionAuth, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const installation = await ProductionDatabase.getInstallationById(installationId);
        if (!installation) {
            return res.status(404).json({ success: false, error: 'Installation not found' });
        }
        res.json({ success: true, installation });
    } catch (error) {
        console.error('Get installation error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to get installation' });
    }
});

router.post('/installations', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const { works_order_id, installation_date, start_date, end_date, start_time, end_time, duration_hours, location, address, notes, status, assigned_users, days } = req.body;
        
        // Support both old (installation_date) and new (start_date/end_date) formats
        const startDate = start_date || installation_date;
        const endDate = end_date || start_date || installation_date;
        
        if (!startDate || !duration_hours) {
            return res.status(400).json({ success: false, error: 'Start date and duration are required' });
        }
        
        if (endDate < startDate) {
            return res.status(400).json({ success: false, error: 'End date must be greater than or equal to start date' });
        }
        
        const installation = await ProductionDatabase.createInstallation({
            works_order_id: works_order_id || null,
            start_date: startDate,
            end_date: endDate,
            start_time,
            end_time,
            duration_hours,
            location,
            address,
            notes,
            status,
            assigned_users: assigned_users || [],
            days: days || [],
            created_by: req.session.production_user.id
        });
        
        res.json({ success: true, installation });
    } catch (error) {
        console.error('Create installation error:', error);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to create installation', details: error.message });
    }
});

router.put('/installations/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const { works_order_id, installation_date, start_date, end_date, start_time, end_time, duration_hours, location, address, notes, status, assigned_users, days } = req.body;
        
        const updateData = {};
        if (works_order_id !== undefined) updateData.works_order_id = works_order_id;
        if (start_date !== undefined) updateData.start_date = start_date;
        if (end_date !== undefined) updateData.end_date = end_date;
        // Support old field name for backward compatibility
        if (installation_date !== undefined && start_date === undefined) {
            updateData.start_date = installation_date;
            if (end_date === undefined) {
                updateData.end_date = installation_date;
            }
        }
        if (start_time !== undefined) updateData.start_time = start_time;
        if (end_time !== undefined) updateData.end_time = end_time;
        if (duration_hours !== undefined) updateData.duration_hours = duration_hours;
        if (location !== undefined) updateData.location = location;
        if (address !== undefined) updateData.address = address;
        if (notes !== undefined) updateData.notes = notes;
        if (status !== undefined) updateData.status = status;
        if (assigned_users !== undefined) updateData.assigned_users = assigned_users;
        if (days !== undefined) updateData.days = days;
        
        // Validate date range if both dates are provided
        if (updateData.start_date && updateData.end_date && updateData.end_date < updateData.start_date) {
            return res.status(400).json({ success: false, error: 'End date must be greater than or equal to start date' });
        }
        
        const installation = await ProductionDatabase.updateInstallation(installationId, updateData);
        res.json({ success: true, installation });
    } catch (error) {
        console.error('Update installation error:', error);
        res.status(500).json({ success: false, error: 'Failed to update installation' });
    }
});

router.delete('/installations/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        await ProductionDatabase.deleteInstallation(installationId);
        res.json({ success: true, message: 'Installation deleted successfully' });
    } catch (error) {
        console.error('Delete installation error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete installation' });
    }
});

// Assignment routes
router.post('/installations/:id/assign', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const { user_id, role } = req.body;
        
        if (!user_id) {
            return res.status(400).json({ success: false, error: 'User ID is required' });
        }
        
        await ProductionDatabase.assignUserToInstallation(installationId, user_id, role || null);
        const installation = await ProductionDatabase.getInstallationById(installationId);
        res.json({ success: true, installation });
    } catch (error) {
        console.error('Assign user error:', error);
        res.status(500).json({ success: false, error: 'Failed to assign user' });
    }
});

router.delete('/installations/:id/assign/:userId', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const userId = parseInt(req.params.userId);
        await ProductionDatabase.removeUserFromInstallation(installationId, userId);
        const installation = await ProductionDatabase.getInstallationById(installationId);
        res.json({ success: true, installation });
    } catch (error) {
        console.error('Remove user assignment error:', error);
        res.status(500).json({ success: false, error: 'Failed to remove user assignment' });
    }
});

// Availability routes
router.post('/installations/check-availability', requireProductionAuth, async (req, res) => {
    try {
        const { user_ids, start_datetime, end_datetime } = req.body;
        
        if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
            return res.status(400).json({ success: false, error: 'User IDs array is required' });
        }
        if (!start_datetime || !end_datetime) {
            return res.status(400).json({ success: false, error: 'Start and end datetime are required' });
        }
        
        const availability = await ProductionDatabase.checkMultipleUsersAvailability(user_ids, start_datetime, end_datetime);
        res.json({ success: true, availability });
    } catch (error) {
        console.error('Check availability error:', error);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to check availability', details: error.message });
    }
});

router.get('/installations/:id/conflicts', requireProductionAuth, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const installation = await ProductionDatabase.getInstallationById(installationId);
        
        if (!installation) {
            return res.status(404).json({ success: false, error: 'Installation not found' });
        }
        
        if (!installation.assigned_users || installation.assigned_users.length === 0) {
            return res.json({ success: true, conflicts: {} });
        }
        
        const conflicts = {};
        const startDate = installation.start_date || installation.installation_date;
        const endDate = installation.end_date || startDate;
        
        // Check conflicts for each day in the date range
        const start = new Date(startDate);
        const end = new Date(endDate);
        const current = new Date(start);
        
        while (current <= end) {
            const dateStr = current.toISOString().split('T')[0];
            
            // Get day-specific times or use defaults
            const dayOverride = installation.installation_days?.find(d => d.day_date === dateStr);
            const dayStartTime = dayOverride?.start_time || installation.start_time;
            const dayEndTime = dayOverride?.end_time || installation.end_time;
            const dayDuration = dayOverride?.duration_hours || installation.duration_hours;
            
            const startDateTime = `${dateStr}T${dayStartTime}:00`;
            let endDateTime;
            if (dayEndTime) {
                endDateTime = `${dateStr}T${dayEndTime}:00`;
            } else {
                const start = new Date(startDateTime);
                const end = new Date(start.getTime() + parseFloat(dayDuration) * 60 * 60 * 1000);
                endDateTime = end.toISOString();
            }
            
            for (const assignment of installation.assigned_users) {
                if (!conflicts[assignment.user_id]) {
                    conflicts[assignment.user_id] = {};
                }
                const userConflicts = await ProductionDatabase.getUserConflicts(assignment.user_id, startDateTime, endDateTime);
                // Filter out conflicts with this installation itself
                conflicts[assignment.user_id][dateStr] = userConflicts.filter(c => c.type !== 'installation' || c.id !== installationId);
            }
            
            current.setDate(current.getDate() + 1);
        }
        
        res.json({ success: true, conflicts });
    } catch (error) {
        console.error('Get conflicts error:', error);
        res.status(500).json({ success: false, error: 'Failed to get conflicts' });
    }
});

// Installation days routes
router.post('/installations/:id/days', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const { date, start_time, end_time, duration_hours, notes } = req.body;
        
        if (!date) {
            return res.status(400).json({ success: false, error: 'Date is required' });
        }
        
        const day = await ProductionDatabase.createInstallationDay(installationId, {
            date,
            start_time,
            end_time,
            duration_hours,
            notes
        });
        
        res.json({ success: true, day });
    } catch (error) {
        console.error('Create installation day error:', error);
        res.status(500).json({ success: false, error: 'Failed to create installation day' });
    }
});

router.put('/installations/:id/days/:date', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const dayDate = req.params.date;
        const { start_time, end_time, duration_hours, notes } = req.body;
        
        const day = await ProductionDatabase.createInstallationDay(installationId, {
            date: dayDate,
            start_time,
            end_time,
            duration_hours,
            notes
        });
        
        res.json({ success: true, day });
    } catch (error) {
        console.error('Update installation day error:', error);
        res.status(500).json({ success: false, error: 'Failed to update installation day' });
    }
});

router.delete('/installations/:id/days/:date', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const installationId = parseInt(req.params.id);
        const dayDate = req.params.date;
        
        await ProductionDatabase.deleteInstallationDay(installationId, dayDate);
        res.json({ success: true, message: 'Installation day deleted successfully' });
    } catch (error) {
        console.error('Delete installation day error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete installation day' });
    }
});

// ============ TIMESHEET ROUTES ============

// Job Management
router.get('/timesheet/jobs', requireProductionAuth, async (req, res) => {
    try {
        const includeInactive = req.query.all === 'true';
        const jobs = includeInactive 
            ? await ProductionDatabase.getAllJobsIncludingInactive()
            : await ProductionDatabase.getAllJobs();
        res.json({ success: true, jobs });
    } catch (error) {
        console.error('Get jobs error:', error);
        res.status(500).json({ success: false, error: 'Failed to get jobs' });
    }
});

router.post('/timesheet/jobs', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Job name is required' });
        }
        const job = await ProductionDatabase.createJob(name, description);
        res.json({ success: true, job });
    } catch (error) {
        console.error('Create job error:', error);
        res.status(500).json({ success: false, error: 'Failed to create job' });
    }
});

router.put('/timesheet/jobs/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const jobId = parseInt(req.params.id);
        const { name, description, status } = req.body;
        const job = await ProductionDatabase.updateJob(jobId, name, description, status);
        res.json({ success: true, job });
    } catch (error) {
        console.error('Update job error:', error);
        res.status(500).json({ success: false, error: 'Failed to update job' });
    }
});

router.delete('/timesheet/jobs/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const jobId = parseInt(req.params.id);
        const job = await ProductionDatabase.deleteJob(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }
        res.json({ success: true, message: 'Job deleted successfully' });
    } catch (error) {
        console.error('Delete job error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete job' });
    }
});

// Staff Clocking
router.get('/timesheet/status', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const status = await ProductionDatabase.getCurrentClockStatus(userId);
        res.json({ success: true, status });
    } catch (error) {
        console.error('Get clock status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get clock status' });
    }
});

router.post('/timesheet/clock-in', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { job_id, latitude, longitude } = req.body;
        
        if (!job_id) {
            return res.status(400).json({ success: false, error: 'Job ID is required' });
        }
        
        // Check if user already has a completed entry for today
        const today = new Date().toISOString().split('T')[0];
        const completedEntriesCount = await ProductionDatabase.countEntriesForDate(userId, today);
        
        if (completedEntriesCount >= 1) {
            return res.status(400).json({ 
                success: false, 
                error: 'You have already clocked in and out today. Only one clock in/out per day is allowed. If you need to clock in again, please contact an admin to delete the existing entry first.' 
            });
        }
        
        // Check if user is already clocked in (has an active entry)
        const currentStatus = await ProductionDatabase.getCurrentClockStatus(userId);
        if (currentStatus) {
            return res.status(400).json({ 
                success: false, 
                error: 'You are already clocked in. Please clock out first.' 
            });
        }
        
        // Check if this is a Workshop job and adjust clock-in time to 8am if before 8am
        let adjustedClockInTime = null;
        const job = await ProductionDatabase.getJobById(parseInt(job_id));
        if (job && job.name && job.name.toLowerCase().includes('workshop')) {
            const now = new Date();
            const hours = now.getHours();
            
            // If before 8am (hours < 8), set to 8am on the same date
            if (hours < 8) {
                const clockInTime = new Date(now);
                clockInTime.setHours(8, 0, 0, 0); // Set to 8:00:00 AM
                adjustedClockInTime = clockInTime;
                console.log(`Workshop job detected: Adjusting clock-in time from ${now.toISOString()} to ${clockInTime.toISOString()}`);
            }
        }
        
        const entry = await ProductionDatabase.clockIn(userId, parseInt(job_id), latitude, longitude, adjustedClockInTime);
        res.json({ success: true, entry });
    } catch (error) {
        console.error('Clock in error:', error);
        res.status(500).json({ success: false, error: 'Failed to clock in' });
    }
});

router.post('/timesheet/clock-out', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { latitude, longitude } = req.body;
        
        // Check if clocked in
        const currentStatus = await ProductionDatabase.getCurrentClockStatus(userId);
        if (!currentStatus) {
            return res.status(400).json({ success: false, error: 'You are not clocked in' });
        }
        
        const entry = await ProductionDatabase.clockOut(userId, latitude, longitude);
        if (!entry) {
            return res.status(400).json({ success: false, error: 'Failed to clock out' });
        }
        res.json({ success: true, entry });
    } catch (error) {
        console.error('Clock out error:', error);
        res.status(500).json({ success: false, error: 'Failed to clock out' });
    }
});

// Admin Views
router.get('/timesheet/active', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const activeClockIns = await ProductionDatabase.getActiveClockIns();
        res.json({ success: true, clockIns: activeClockIns });
    } catch (error) {
        console.error('Get active clock ins error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to get active clock ins',
            details: error.message 
        });
    }
});

// Notices/Reminders
router.get('/timesheet/notices', requireProductionAuth, async (req, res) => {
    try {
        const notices = await ProductionDatabase.getActiveTimesheetNotices();
        res.json({ success: true, notices });
    } catch (error) {
        console.error('Get notices error:', error);
        res.status(500).json({ success: false, error: 'Failed to get notices' });
    }
});

router.get('/timesheet/notices/all', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const notices = await ProductionDatabase.getAllTimesheetNotices();
        res.json({ success: true, notices });
    } catch (error) {
        console.error('Get all notices error:', error);
        res.status(500).json({ success: false, error: 'Failed to get notices' });
    }
});

router.post('/timesheet/notices', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { title, message, priority, expires_at } = req.body;
        if (!title || !message) {
            return res.status(400).json({ success: false, error: 'Title and message are required' });
        }
        const createdBy = req.session.production_user.id;
        const notice = await ProductionDatabase.createTimesheetNotice(title, message, priority || 'normal', expires_at || null, createdBy);
        res.json({ success: true, notice });
    } catch (error) {
        console.error('Create notice error:', error);
        res.status(500).json({ success: false, error: 'Failed to create notice' });
    }
});

router.put('/timesheet/notices/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const noticeId = parseInt(req.params.id);
        const { title, message, priority, status, expires_at } = req.body;
        const updateData = {};
        if (title !== undefined) updateData.title = title;
        if (message !== undefined) updateData.message = message;
        if (priority !== undefined) updateData.priority = priority;
        if (status !== undefined) updateData.status = status;
        if (expires_at !== undefined) updateData.expires_at = expires_at;
        
        const notice = await ProductionDatabase.updateTimesheetNotice(noticeId, updateData);
        res.json({ success: true, notice });
    } catch (error) {
        console.error('Update notice error:', error);
        res.status(500).json({ success: false, error: 'Failed to update notice' });
    }
});

router.delete('/timesheet/notices/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const noticeId = parseInt(req.params.id);
        const notice = await ProductionDatabase.deleteTimesheetNotice(noticeId);
        if (!notice) {
            return res.status(404).json({ success: false, error: 'Notice not found' });
        }
        res.json({ success: true, message: 'Notice deleted successfully' });
    } catch (error) {
        console.error('Delete notice error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete notice' });
    }
});

// ============ CLOCK ON/OFF ROUTES (Weekly Timesheet System) ============

// Clock in/out (aliases for backward compatibility, also available as /clock/clock-in and /clock/clock-out)
router.post('/clock/clock-in', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { job_id, latitude, longitude } = req.body;
        
        if (!job_id) {
            return res.status(400).json({ success: false, error: 'Job/site is required' });
        }
        
        // FIRST: Auto-clock-out any old entries that weren't clocked out (prevents cross-day overlaps)
        // This must happen before checking for duplicates to ensure old entries are closed
        try {
            await ProductionDatabase.autoClockOutOldEntries(userId);
        } catch (error) {
            console.error('Error auto-clocking-out old entries:', error);
            // Continue anyway - don't block the request
        }
        
        // Check if user is already clocked in (has an active entry for today)
        const currentStatus = await ProductionDatabase.getCurrentClockStatus(userId);
        if (currentStatus) {
            // Check if this is an entry from a previous day that should have been auto-clocked-out
            const clockInDate = new Date(currentStatus.clock_in_time);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const clockInDateOnly = new Date(clockInDate);
            clockInDateOnly.setHours(0, 0, 0, 0);
            
            if (clockInDateOnly.getTime() < today.getTime()) {
                // This is from a previous day - try to auto-clock-out again
                try {
                    await ProductionDatabase.autoClockOutOldEntries(userId);
                    // Re-check status
                    const newStatus = await ProductionDatabase.getCurrentClockStatus(userId);
                    if (newStatus) {
                        return res.status(400).json({ 
                            success: false, 
                            error: 'You are already clocked in. Please clock out first.' 
                        });
                    }
                } catch (error) {
                    console.error('Error auto-clocking-out old entry:', error);
                    return res.status(400).json({ 
                        success: false, 
                        error: 'You have an open timesheet entry from a previous day. Please contact an admin to resolve this issue.' 
                    });
                }
            } else {
                return res.status(400).json({ 
                    success: false, 
                    error: 'You are already clocked in. Please clock out first.' 
                });
            }
        }
        
        // Check if user already has a completed entry for today (after auto-clock-out)
        const today = new Date().toISOString().split('T')[0];
        const completedEntriesCount = await ProductionDatabase.countEntriesForDate(userId, today);
        
        if (completedEntriesCount >= 1) {
            return res.status(400).json({ 
                success: false, 
                error: 'You have already clocked in and out today. Only one clock in/out per day is allowed. If you need to clock in again, please contact an admin to delete the existing entry first.' 
            });
        }
        
        // Check if this is a Workshop job and adjust clock-in time to 8am if before 8am
        let adjustedClockInTime = null;
        const job = await ProductionDatabase.getJobById(job_id);
        if (job && job.name && job.name.toLowerCase().includes('workshop')) {
            const now = new Date();
            const hours = now.getHours();
            
            // If before 8am (hours < 8), set to 8am on the same date
            if (hours < 8) {
                const clockInTime = new Date(now);
                clockInTime.setHours(8, 0, 0, 0); // Set to 8:00:00 AM
                adjustedClockInTime = clockInTime;
                console.log(`Workshop job detected: Adjusting clock-in time from ${now.toISOString()} to ${clockInTime.toISOString()}`);
            }
        }
        
        const entry = await ProductionDatabase.clockIn(userId, job_id, latitude, longitude, adjustedClockInTime);
        res.json({ success: true, entry });
    } catch (error) {
        console.error('Clock in error:', error);
        res.status(500).json({ success: false, error: 'Failed to clock in' });
    }
});

router.post('/clock/clock-out', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { latitude, longitude } = req.body;
        
        const entry = await ProductionDatabase.clockOut(userId, latitude, longitude);
        if (!entry) {
            return res.status(400).json({ success: false, error: 'No active clock-in found' });
        }
        res.json({ success: true, entry });
    } catch (error) {
        console.error('Clock out error:', error);
        res.status(500).json({ success: false, error: 'Failed to clock out' });
    }
});

// NFC punch: no session; auth via reader token + card UID (for tablet kiosk)
router.post('/clock/nfc-punch', async (req, res) => {
    try {
        const { reader_id, reader_token, card_uid } = req.body || {};
        if (!reader_id || !reader_token || !card_uid) {
            return res.status(400).json({ success: false, error: 'reader_id, reader_token and card_uid are required' });
        }
        
        const reader = await ProductionDatabase.getNfcReaderByToken(reader_id, reader_token);
        if (!reader) {
            return res.status(401).json({ success: false, error: 'Invalid reader' });
        }
        
        const cardUser = await ProductionDatabase.getNfcUserByCardUid(card_uid);
        if (!cardUser) {
            return res.status(404).json({ success: false, error: 'Card not recognised' });
        }
        const userId = cardUser.user_id;
        const jobId = reader.job_id;
        
        // Auto-clock-out any old entries (same as normal clock-in flow)
        try {
            await ProductionDatabase.autoClockOutOldEntries(userId);
        } catch (err) {
            console.error('Error auto-clocking-out old entries:', err);
        }
        
        const currentStatus = await ProductionDatabase.getCurrentClockStatus(userId);
        if (currentStatus) {
            const entry = await ProductionDatabase.clockOut(userId, null, null);
            return res.json({ success: true, action: 'out', message: 'Clocked out', entry });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const completedCount = await ProductionDatabase.countEntriesForDate(userId, today);
        if (completedCount >= 1) {
            return res.status(400).json({
                success: false,
                error: 'Already clocked in and out today. Only one clock in/out per day is allowed.'
            });
        }
        
        let adjustedClockInTime = null;
        const job = await ProductionDatabase.getJobById(jobId);
        if (job && job.name && job.name.toLowerCase().includes('workshop')) {
            const now = new Date();
            if (now.getHours() < 8) {
                const clockInTime = new Date(now);
                clockInTime.setHours(8, 0, 0, 0);
                adjustedClockInTime = clockInTime;
            }
        }
        
        const entry = await ProductionDatabase.clockIn(userId, jobId, null, null, adjustedClockInTime);
        res.json({ success: true, action: 'in', message: 'Clocked in', entry });
    } catch (error) {
        console.error('NFC punch error:', error);
        res.status(500).json({ success: false, error: 'Failed to process punch' });
    }
});

// NFC admin (cards and readers) - require admin or office
router.get('/clock/nfc/users', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const users = await ProductionDatabase.getProductionUsersForDropdown();
        res.json({ success: true, users });
    } catch (error) {
        console.error('List users for NFC error:', error);
        res.status(500).json({ success: false, error: 'Failed to list users' });
    }
});

router.get('/clock/nfc/cards', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const cards = await ProductionDatabase.listNfcCards();
        res.json({ success: true, cards });
    } catch (error) {
        console.error('List NFC cards error:', error);
        res.status(500).json({ success: false, error: 'Failed to list NFC cards' });
    }
});

router.post('/clock/nfc/cards', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { user_id, card_uid, label } = req.body || {};
        if (!user_id || !card_uid) {
            return res.status(400).json({ success: false, error: 'user_id and card_uid are required' });
        }
        const card = await ProductionDatabase.createNfcCard(parseInt(user_id), card_uid, label || null);
        res.json({ success: true, card });
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE')) {
            return res.status(400).json({ success: false, error: 'This card is already registered' });
        }
        console.error('Create NFC card error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to create NFC card' });
    }
});

router.delete('/clock/nfc/cards/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        await ProductionDatabase.deleteNfcCard(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        console.error('Delete NFC card error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete NFC card' });
    }
});

router.get('/clock/nfc/readers', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const readers = await ProductionDatabase.listNfcReaders();
        res.json({ success: true, readers });
    } catch (error) {
        console.error('List NFC readers error:', error);
        res.status(500).json({ success: false, error: 'Failed to list NFC readers' });
    }
});

router.post('/clock/nfc/readers', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { reader_id, job_id, name } = req.body || {};
        if (!reader_id || !job_id) {
            return res.status(400).json({ success: false, error: 'reader_id and job_id are required' });
        }
        const reader = await ProductionDatabase.createNfcReader(reader_id, parseInt(job_id), name || null);
        res.json({ success: true, reader });
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE')) {
            return res.status(400).json({ success: false, error: 'This reader ID is already registered' });
        }
        console.error('Create NFC reader error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to create NFC reader' });
    }
});

router.delete('/clock/nfc/readers/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        await ProductionDatabase.deleteNfcReader(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        console.error('Delete NFC reader error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete NFC reader' });
    }
});

router.get('/clock/status', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const status = await ProductionDatabase.getCurrentClockStatus(userId);
        
        // Check if user has already completed a clock in/out cycle today
        const today = new Date().toISOString().split('T')[0];
        const completedEntriesCount = await ProductionDatabase.countEntriesForDate(userId, today);
        const hasCompletedToday = completedEntriesCount >= 1;
        
        res.json({ 
            success: true, 
            status,
            hasCompletedToday: hasCompletedToday
        });
    } catch (error) {
        console.error('Get clock status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get clock status' });
    }
});

// Admin route to cleanup all old unclosed entries (one-time cleanup)
// Supports both GET and POST for easier access
router.get('/clock/cleanup-old-entries', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        console.log('Admin cleanup of old unclosed entries requested (GET)');
        const result = await ProductionDatabase.cleanupAllOldUnclosedEntries();
        res.json({ 
            success: true, 
            message: `Cleanup complete: ${result.count} entries updated, ${result.errors} errors`,
            count: result.count,
            errors: result.errors
        });
    } catch (error) {
        console.error('Cleanup old entries error:', error);
        res.status(500).json({ success: false, error: 'Failed to cleanup old entries: ' + error.message });
    }
});

router.post('/clock/cleanup-old-entries', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        console.log('Admin cleanup of old unclosed entries requested (POST)');
        const result = await ProductionDatabase.cleanupAllOldUnclosedEntries();
        res.json({ 
            success: true, 
            message: `Cleanup complete: ${result.count} entries updated, ${result.errors} errors`,
            count: result.count,
            errors: result.errors
        });
    } catch (error) {
        console.error('Cleanup old entries error:', error);
        res.status(500).json({ success: false, error: 'Failed to cleanup old entries: ' + error.message });
    }
});

// Admin route to reopen entries for a date (remove clock_out_time so staff can clock out normally)
router.post('/clock/reopen-entries', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        let dateStr = req.body && req.body.date ? req.body.date.trim() : null;
        if (!dateStr) {
            const today = new Date();
            dateStr = today.toISOString().split('T')[0];
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return res.status(400).json({ success: false, error: 'Invalid date; use YYYY-MM-DD' });
        }
        const date = new Date(dateStr);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        date.setHours(0, 0, 0, 0);
        if (date.getTime() > today.getTime()) {
            return res.status(400).json({ success: false, error: 'Cannot reopen entries for a future date' });
        }
        const result = await ProductionDatabase.reopenTimesheetEntriesForDate(dateStr);
        const message = result.count === 0
            ? 'No entries to reopen for this date.'
            : `Reopened ${result.count} entries for ${dateStr}. Staff will show as on clock and can clock out as normal.`;
        res.json({
            success: true,
            message,
            count: result.count,
            entries: result.entries
        });
    } catch (error) {
        console.error('Reopen entries error:', error);
        res.status(500).json({ success: false, error: 'Failed to reopen entries: ' + error.message });
    }
});

// Weekly timesheet routes
router.get('/clock/weekly/current', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const today = new Date();
        const dayOfWeek = today.getDay();
        const monday = new Date(today);
        monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
        monday.setHours(0, 0, 0, 0);
        const weekStartDate = monday.toISOString().split('T')[0];
        
        const weeklyTimesheet = await ProductionDatabase.getWeeklyTimesheet(userId, weekStartDate);
        if (!weeklyTimesheet) {
            // Create if doesn't exist
            const created = await ProductionDatabase.getOrCreateWeeklyTimesheet(userId, weekStartDate);
            // Check and populate approved holidays for this week
            await ProductionDatabase.checkAndPopulateApprovedHolidays(userId, weekStartDate);
            const dailyEntries = await ProductionDatabase.getDailyEntriesForWeek(created.id);
            return res.json({ success: true, weeklyTimesheet: created, dailyEntries });
        }
        
        // Check and populate approved holidays for this week
        await ProductionDatabase.checkAndPopulateApprovedHolidays(userId, weekStartDate);
        const dailyEntries = await ProductionDatabase.getDailyEntriesForWeek(weeklyTimesheet.id);
        res.json({ success: true, weeklyTimesheet, dailyEntries });
    } catch (error) {
        console.error('Get current weekly timesheet error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to get weekly timesheet',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.get('/clock/weekly/:weekStart', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const weekStartDate = req.params.weekStart;
        
        // Calculate week end date
        const weekStart = new Date(weekStartDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const weekEndStr = weekEnd.toISOString().split('T')[0];
        
        const weeklyTimesheet = await ProductionDatabase.getWeeklyTimesheet(userId, weekStartDate);
        if (!weeklyTimesheet) {
            const created = await ProductionDatabase.getOrCreateWeeklyTimesheet(userId, weekStartDate);
            // Check and populate approved holidays for this week
            await ProductionDatabase.checkAndPopulateApprovedHolidays(userId, weekStartDate);
            const dailyEntries = await ProductionDatabase.getDailyEntriesForWeek(created.id);
            
            // Also get all timesheet entries for this week
            const timesheetEntries = await ProductionDatabase.getTimesheetHistory(userId, weekStartDate, weekEndStr);
            
            return res.json({ success: true, weeklyTimesheet: created, dailyEntries, timesheetEntries });
        }
        
        // Check and populate approved holidays for this week
        await ProductionDatabase.checkAndPopulateApprovedHolidays(userId, weekStartDate);
        const dailyEntries = await ProductionDatabase.getDailyEntriesForWeek(weeklyTimesheet.id);
        
        // Also get all timesheet entries for this week
        const timesheetEntries = await ProductionDatabase.getTimesheetHistory(userId, weekStartDate, weekEndStr);
        
        res.json({ success: true, weeklyTimesheet, dailyEntries, timesheetEntries });
    } catch (error) {
        console.error('Get weekly timesheet error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to get weekly timesheet',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

router.put('/clock/weekly/:weekStart/day/:date', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const weekStartDate = req.params.weekStart;
        const entryDate = req.params.date;
        const { daily_notes, overnight_away, day_type } = req.body;
        
        const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(userId, weekStartDate);
        const dailyEntry = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, entryDate);
        
        const updateData = {};
        if (daily_notes !== undefined) updateData.daily_notes = daily_notes;
        if (overnight_away !== undefined) updateData.overnight_away = overnight_away;
        if (day_type !== undefined) {
            // Validate day_type value
            const validDayTypes = ['holiday_paid', 'holiday_unpaid', 'sick_paid', 'sick_unpaid', null];
            if (day_type === '' || day_type === 'null') {
                updateData.day_type = null;
            } else if (validDayTypes.includes(day_type)) {
                updateData.day_type = day_type;
            } else {
                return res.status(400).json({ success: false, error: 'Invalid day_type value' });
            }
        }
        
        const updated = await ProductionDatabase.updateDailyEntry(dailyEntry.id, updateData);
        
        // Normalize overnight_away in response
        if (updated) {
            updated.overnight_away = updated.overnight_away === true || updated.overnight_away === 1 || updated.overnight_away === '1';
        }
        
        // If overnight_away changed, recalculate hours for ALL entries for this day
        if (overnight_away !== undefined) {
            // Get all timesheet entries for this date
            const weekStart = new Date(weekStartDate);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 6);
            const weekEndStr = weekEnd.toISOString().split('T')[0];
            
            const allEntries = await ProductionDatabase.getTimesheetHistory(userId, weekStartDate, weekEndStr);
            const dayEntries = allEntries.filter(te => {
                const teDate = new Date(te.clock_in_time).toISOString().split('T')[0];
                return teDate === entryDate && te.clock_out_time;
            });
            
            // Recalculate hours for each entry
            for (const entry of dayEntries) {
                await ProductionDatabase.calculateTimesheetHours(entry.id, overnight_away);
            }
            
            // Aggregate hours from all entries for this day
            const aggregatedHours = await ProductionDatabase.aggregateDailyHours(userId, entryDate, overnight_away);
            
            // Calculate final hours based on day_type (unpaid days override aggregated hours)
            const finalHours = await ProductionDatabase.calculateHoursForDailyEntry(updated || dailyEntry, aggregatedHours, userId, entryDate);
            
            // Update daily entry with final hours
            await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                regular_hours: finalHours.regular_hours,
                overtime_hours: finalHours.overtime_hours,
                weekend_hours: finalHours.weekend_hours,
                overnight_hours: finalHours.overnight_hours,
                total_hours: finalHours.total_hours
            });
        }
        
        res.json({ success: true, dailyEntry: updated });
    } catch (error) {
        console.error('Update daily entry error:', error);
        res.status(500).json({ success: false, error: 'Failed to update daily entry' });
    }
});

// Admin endpoint to update day_type for any user
router.put('/clock/weekly/:weekStart/day/:date/user/:targetUserId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const targetUserId = parseInt(req.params.targetUserId);
        const weekStartDate = req.params.weekStart;
        const entryDate = req.params.date;
        const { day_type } = req.body;
        
        const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(targetUserId, weekStartDate);
        const dailyEntry = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, entryDate);
        
        const updateData = {};
        if (day_type !== undefined) {
            // Validate day_type value
            const validDayTypes = ['holiday_paid', 'holiday_unpaid', 'sick_paid', 'sick_unpaid', null];
            if (day_type === '' || day_type === 'null') {
                updateData.day_type = null;
            } else if (validDayTypes.includes(day_type)) {
                updateData.day_type = day_type;
            } else {
                return res.status(400).json({ success: false, error: 'Invalid day_type value' });
            }
        }
        
        // Calculate hours based on day_type
        if (updateData.day_type !== undefined) {
            let regularHours = 0;
            let totalHours = 0;
            
            if (updateData.day_type === 'holiday_unpaid' || updateData.day_type === 'sick_unpaid') {
                regularHours = 0;
                totalHours = 0;
            } else if (updateData.day_type === 'sick_paid') {
                // Paid sick: 8 hours Mon-Thu, 6 hours Friday
                const dateObj = new Date(entryDate);
                const dayOfWeek = dateObj.getDay(); // 0 = Sunday, 5 = Friday
                if (dayOfWeek === 5) {
                    // Friday
                    regularHours = 6;
                    totalHours = 6;
                } else {
                    // Monday to Thursday
                    regularHours = 8;
                    totalHours = 8;
                }
            } else if (updateData.day_type === 'holiday_paid') {
                // Try to find approved holiday request for this date and user
                let holidayRequest = null;
                const allRequests = await ProductionDatabase.getHolidayRequestsByUser(targetUserId);
                const dateObj = new Date(entryDate);
                holidayRequest = allRequests.find(req => {
                    if (req.status !== 'approved') return false;
                    const start = new Date(req.start_date);
                    const end = new Date(req.end_date);
                    return dateObj >= start && dateObj <= end;
                });
                
                if (holidayRequest && holidayRequest.days_requested) {
                    // If it's a half day (0.5), set 4 hours, otherwise 8 hours
                    totalHours = holidayRequest.days_requested === 0.5 ? 4 : 8;
                    regularHours = totalHours;
                } else {
                    // Default to 8 hours for full day
                    regularHours = 8;
                    totalHours = 8;
                }
            } else if (updateData.day_type === null) {
                // If day_type is cleared, recalculate from timesheet entries if they exist
                const aggregatedHours = await ProductionDatabase.aggregateDailyHours(targetUserId, entryDate, dailyEntry.overnight_away || false);
                regularHours = aggregatedHours.regular_hours;
                totalHours = aggregatedHours.total_hours;
            }
            
            // Always update hours when day_type changes (either set to a value or cleared to null)
            updateData.regular_hours = regularHours;
            updateData.total_hours = totalHours;
            updateData.overtime_hours = 0; // Reset overtime when day_type is set
            updateData.weekend_hours = 0; // Reset weekend when day_type is set
            updateData.overnight_hours = 0; // Reset overnight when day_type is set
        }
        
        const updated = await ProductionDatabase.updateDailyEntry(dailyEntry.id, updateData);
        
        res.json({ success: true, dailyEntry: updated });
    } catch (error) {
        console.error('Admin update daily entry error:', error);
        res.status(500).json({ success: false, error: 'Failed to update daily entry' });
    }
});

// Missing times route (for days they forgot to clock in)
router.post('/clock/missing-times', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { job_id, clock_in_time, clock_out_time, reason, overnight_away } = req.body;
        
        if (!job_id || !clock_in_time || !clock_out_time || !reason) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        // Check if within allowed time window (up to 10 days back, but not future dates)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tenDaysAgo = new Date(today);
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        tenDaysAgo.setHours(0, 0, 0, 0);
        
        const entryDate = new Date(clock_in_time);
        entryDate.setHours(0, 0, 0, 0);
        
        // Prevent future dates
        if (entryDate > today) {
            return res.status(400).json({ 
                success: false, 
                error: 'Cannot add missing times for future dates. You can only add times for past dates that were forgotten.' 
            });
        }
        
        // Prevent dates older than 10 days
        if (entryDate < tenDaysAgo) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing times can only be added for dates up to 10 days back. Please contact a manager for older entries.' 
            });
        }
        
        // Also check clock_out_time is not in the future
        const clockOutDate = new Date(clock_out_time);
        clockOutDate.setHours(0, 0, 0, 0);
        if (clockOutDate > today) {
            return res.status(400).json({ 
                success: false, 
                error: 'Clock out time cannot be in the future. Please use a past date.' 
            });
        }
        
        // Get date string for the entry date
        const dateStr = entryDate.toISOString().split('T')[0];
        
        // Auto-clock-out any old entries that weren't clocked out (prevents cross-day overlaps)
        // Only do this for entries that might conflict with the target date
        // Run this asynchronously without blocking - if it fails or times out, the duplicate check will still work
        // because incomplete entries (no clock_out_time) are excluded from duplicate checks
        ProductionDatabase.autoClockOutEntriesForDate(userId, dateStr).catch(error => {
            console.error('Error auto-clocking-out entries for date (non-blocking):', error);
        });
        
        // Check if user already has entries for this date
        const existingEntries = await ProductionDatabase.getTimesheetHistory(userId, dateStr, dateStr);
        const entriesForDate = existingEntries.filter(te => {
            const teDate = new Date(te.clock_in_time).toISOString().split('T')[0];
            return teDate === dateStr && te.clock_out_time; // Only completed entries
        });
        
        // Check if there's a non-auto-clocked-out entry (should block)
        const hasRegularEntry = entriesForDate.some(te => !ProductionDatabase.isAutoClockedOutEntry(te));
        
        if (hasRegularEntry) {
            return res.status(400).json({ 
                success: false, 
                error: 'You already have a clock in/out entry for this date. Only one entry per day is allowed. Please use "Edit Times" to amend it.' 
            });
        }
        
        // If only auto-clocked-out entries exist, we'll allow adding missing times (it will replace them)
        // But first check for duplicate or overlapping times with other entries (excluding auto-clocked-out)
        // For "add missing times", we want to check:
        // 1. Entries that start on the same date
        // 2. Overnight entries that might span into this date
        // But exclude auto-clocked-out entries from duplicate check
        const duplicates = await ProductionDatabase.checkDuplicateTimesForDate(userId, clock_in_time, clock_out_time, dateStr);
        
        // Filter out auto-clocked-out entries from duplicates
        const realDuplicates = duplicates.filter(d => !ProductionDatabase.isAutoClockedOutEntry(d));
        
        // Log for debugging
        if (realDuplicates && realDuplicates.length > 0) {
            console.log('Found duplicate/overlapping entries (excluding auto-clocked-out):', {
                userId,
                targetDate: dateStr,
                clock_in_time: clock_in_time,
                clock_out_time: clock_out_time,
                duplicates: realDuplicates.map(d => ({
                    id: d.id,
                    clock_in_time: d.clock_in_time,
                    clock_out_time: d.clock_out_time,
                    date: d.clock_in_time ? new Date(d.clock_in_time).toISOString().split('T')[0] : null
                }))
            });
        }
        
        if (realDuplicates && realDuplicates.length > 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'A timesheet entry with overlapping or duplicate times already exists for this period. Please use "Edit Times" to amend the existing entry.' 
            });
        }
        
        // If there are auto-clocked-out entries for this date, delete them first (they'll be replaced)
        if (entriesForDate.length > 0) {
            const autoClockedOutEntries = entriesForDate.filter(te => ProductionDatabase.isAutoClockedOutEntry(te));
            for (const oldEntry of autoClockedOutEntries) {
                try {
                    // Verify the entry belongs to the user before deleting
                    if (oldEntry.user_id === userId) {
                        await ProductionDatabase.deleteTimesheetEntry(oldEntry.id);
                        console.log(`Deleted auto-clocked-out entry ${oldEntry.id} to be replaced with missing times entry`);
                    }
                } catch (error) {
                    console.error(`Error deleting auto-clocked-out entry ${oldEntry.id}:`, error);
                    // Continue anyway - the new entry will still be created
                }
            }
        }
        
        const result = await ProductionDatabase.createMissingTimesheetEntry(
            userId,
            job_id,
            clock_in_time,
            clock_out_time,
            reason
        );
        
        // Handle overnight_away if provided
        if (overnight_away !== undefined) {
            // Get clock-in date to determine which week
            const clockInDate = new Date(clock_in_time);
            const clockInDateStr = clockInDate.toISOString().split('T')[0];
            
            // Find Monday of that week
            const dayOfWeek = clockInDate.getDay();
            const monday = new Date(clockInDate);
            monday.setDate(monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
            monday.setHours(0, 0, 0, 0);
            const weekStartDate = monday.toISOString().split('T')[0];
            
            // Get or create weekly timesheet
            const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(userId, weekStartDate);
            
            // Get or create daily entry
            let dailyEntryRecord = await ProductionDatabase.getDailyEntryByDate(weeklyTimesheet.id, clockInDateStr);
            if (!dailyEntryRecord) {
                dailyEntryRecord = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, clockInDateStr, result.entry.id);
            }
            
            // Update overnight_away
            await ProductionDatabase.updateDailyEntry(dailyEntryRecord.id, {
                overnight_away: overnight_away
            });
            
            // Recalculate hours for the entry with the correct overnight_away value
            await ProductionDatabase.calculateTimesheetHours(result.entry.id, overnight_away);
            
            // Aggregate hours from all entries for this day
            const aggregatedHours = await ProductionDatabase.aggregateDailyHours(userId, clockInDateStr, overnight_away);
            
            // Calculate final hours based on day_type (if day_type exists, it overrides)
            const finalHours = await ProductionDatabase.calculateHoursForDailyEntry(dailyEntryRecord, aggregatedHours, userId, clockInDateStr);
            
            // Update daily entry with final hours
            await ProductionDatabase.updateDailyEntry(dailyEntryRecord.id, {
                timesheet_entry_id: result.entry.id,
                regular_hours: finalHours.regular_hours,
                overtime_hours: finalHours.overtime_hours,
                weekend_hours: finalHours.weekend_hours,
                overnight_hours: finalHours.overnight_hours,
                total_hours: finalHours.total_hours
            });
        }
        
        res.json({ success: true, entry: result.entry, amendment: result.amendment });
    } catch (error) {
        console.error('Create missing times error:', error);
        console.error('Error stack:', error.stack);
        
        // Safely access variables that might not be defined if error occurred early
        try {
            console.error('Request details:', {
                userId: req.session?.production_user?.id || 'unknown',
                job_id: req.body?.job_id || 'unknown',
                clock_in_time: req.body?.clock_in_time || 'unknown',
                clock_out_time: req.body?.clock_out_time || 'unknown',
                reason: req.body?.reason ? 'provided' : 'missing'
            });
        } catch (logError) {
            console.error('Error logging request details:', logError);
        }
        
        // Provide more detailed error message
        let errorMessage = 'Failed to create missing times entry';
        if (error.message) {
            if (error.message.includes('FOREIGN KEY') || error.message.includes('foreign key')) {
                errorMessage = 'Invalid job ID. Please select a valid job/site.';
            } else if (error.message.includes('UNIQUE') || error.message.includes('duplicate')) {
                errorMessage = 'A duplicate entry already exists. Please use "Edit Times" to amend it.';
            } else {
                errorMessage = `Failed to create missing times entry: ${error.message}`;
            }
        }
        
        res.status(500).json({ success: false, error: errorMessage, detail: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
});

// Time amendment routes
router.post('/clock/amendments', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { entry_id, amended_clock_in_time, amended_clock_out_time, reason } = req.body;
        
        if (!entry_id || (!amended_clock_in_time && !amended_clock_out_time) || !reason) {
            return res.status(400).json({ 
                success: false, 
                error: 'At least one time (clock in or clock out) and a reason are required' 
            });
        }
        
        // Check if amendment is within allowed time window (up to 10 days back)
        const entry = await ProductionDatabase.getTimesheetEntryById(entry_id);
        if (!entry) {
            return res.status(404).json({ success: false, error: 'Timesheet entry not found' });
        }
        
        // Verify the entry belongs to the user
        if (entry.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'You can only amend your own timesheet entries' });
        }
        
        // Calculate the cutoff date (10 days back from today, but not future dates)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tenDaysAgo = new Date(today);
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        tenDaysAgo.setHours(0, 0, 0, 0);
        
        const entryDate = new Date(entry.clock_in_time);
        entryDate.setHours(0, 0, 0, 0);
        
        // Prevent future dates
        if (entryDate > today) {
            return res.status(400).json({ 
                success: false, 
                error: 'Cannot amend entries for future dates. You can only edit past times that were wrongly inserted.' 
            });
        }
        
        // Prevent dates older than 10 days
        if (entryDate < tenDaysAgo) {
            return res.status(400).json({ 
                success: false, 
                error: 'Amendments are only allowed for entries up to 10 days back. Please contact a manager for older entries.' 
            });
        }
        
        // Check if amended times are in the future (only validate if provided)
        if (amended_clock_in_time) {
            const amendedClockInDate = new Date(amended_clock_in_time);
            amendedClockInDate.setHours(0, 0, 0, 0);
            if (amendedClockInDate > today) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Amended clock in time cannot be in the future. Please use a past date.' 
                });
            }
        }
        
        if (amended_clock_out_time) {
            const amendedClockOutDate = new Date(amended_clock_out_time);
            amendedClockOutDate.setHours(0, 0, 0, 0);
            if (amendedClockOutDate > today) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Amended clock out time cannot be in the future. Please use a past date.' 
                });
            }
        }
        
        // Check if this is an auto-clocked-out entry - if so, always allow amendment
        const isAutoClockedOut = ProductionDatabase.isAutoClockedOutEntry(entry);
        
        // Check for duplicate or overlapping times (excluding the current entry being amended)
        // Only run duplicate check if both times are provided (need both for comparison)
        // Skip duplicate check for auto-clocked-out entries (they should always be amendable)
        if (amended_clock_in_time && amended_clock_out_time && !isAutoClockedOut) {
            const duplicates = await ProductionDatabase.checkDuplicateTimes(
                userId, 
                amended_clock_in_time, 
                amended_clock_out_time, 
                entry_id // Exclude the current entry
            );
            
            // Filter out auto-clocked-out entries from duplicates (they can be replaced)
            const realDuplicates = duplicates.filter(d => !ProductionDatabase.isAutoClockedOutEntry(d));
            
            if (realDuplicates && realDuplicates.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'The amended times would create a duplicate or overlap with an existing timesheet entry. Please choose different times.' 
                });
            }
        }
        
        const amendment = await ProductionDatabase.requestTimeAmendment(
            entry_id,
            userId,
            amended_clock_in_time,
            amended_clock_out_time,
            reason
        );
        
        res.json({ success: true, amendment });
    } catch (error) {
        console.error('Request amendment error:', error);
        res.status(500).json({ success: false, error: 'Failed to request amendment' });
    }
});

// Admin-only: Directly amend staff timesheet entry (applies immediately, no approval needed)
router.post('/clock/amendments/admin', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const adminId = req.session.production_user.id;
        const { entry_id, amended_clock_in_time, amended_clock_out_time, reason, overnight_away, day_type, date, user_id, week_start } = req.body;
        
        if (!entry_id) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        const isHolidayOrSick = day_type === 'holiday_paid' || day_type === 'holiday_unpaid' || 
                                day_type === 'sick_paid' || day_type === 'sick_unpaid';
        
        // Clock times only required if not holiday/sick
        if (!isHolidayOrSick) {
            if (!amended_clock_in_time || !amended_clock_out_time) {
                return res.status(400).json({ success: false, error: 'Missing required fields' });
            }
        }
        
        // Get the entry
        const entry = await ProductionDatabase.getTimesheetEntryById(entry_id);
        if (!entry) {
            return res.status(404).json({ success: false, error: 'Timesheet entry not found' });
        }
        
        let updatedEntry = null;
        
        // If times are provided, validate and amend the entry
        if (amended_clock_in_time && amended_clock_out_time) {
            // Check if amended times are in the future
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const amendedClockInDate = new Date(amended_clock_in_time);
            amendedClockInDate.setHours(0, 0, 0, 0);
            if (amendedClockInDate > today) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Amended clock in time cannot be in the future. Please use a past date.' 
                });
            }
            
            const amendedClockOutDate = new Date(amended_clock_out_time);
            amendedClockOutDate.setHours(0, 0, 0, 0);
            if (amendedClockOutDate > today) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Amended clock out time cannot be in the future. Please use a past date.' 
                });
            }
            
            // Check for duplicate or overlapping times (excluding the current entry being amended)
            const duplicates = await ProductionDatabase.checkDuplicateTimes(
                entry.user_id, 
                amended_clock_in_time, 
                amended_clock_out_time, 
                entry_id // Exclude the current entry
            );
            
            // Filter out auto-clocked-out entries from duplicates (they can be replaced)
            const realDuplicates = duplicates.filter(d => !ProductionDatabase.isAutoClockedOutEntry(d));
            
            if (realDuplicates && realDuplicates.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'The amended times would create a duplicate or overlap with an existing timesheet entry. Please choose different times.' 
                });
            }
            
            // Apply the amendment immediately
            updatedEntry = await ProductionDatabase.adminAmendTimesheetEntry(
                entry_id,
                adminId,
                amended_clock_in_time,
                amended_clock_out_time,
                reason || 'Amended by admin',
                overnight_away !== undefined ? overnight_away : undefined
            );
        } else {
            // No times provided, just get the entry
            updatedEntry = entry;
        }
        
        // Handle day_type - update daily entry
        if (day_type) {
            // Validate day_type value
            const validDayTypes = ['holiday_paid', 'holiday_unpaid', 'sick_paid', 'sick_unpaid'];
            if (!validDayTypes.includes(day_type)) {
                return res.status(400).json({ success: false, error: 'Invalid day_type value' });
            }
            
            // Get date from entry or use provided date
            let entryDate = date;
            if (!entryDate && updatedEntry.clock_in_time) {
                entryDate = new Date(updatedEntry.clock_in_time).toISOString().split('T')[0];
            } else if (!entryDate) {
                return res.status(400).json({ success: false, error: 'Date is required when setting day_type without clock times' });
            }
            
            // Get week start from provided value or calculate from date
            let weekStartDate = week_start;
            if (!weekStartDate) {
                const dateObj = new Date(entryDate);
                const dayOfWeek = dateObj.getDay();
                const monday = new Date(dateObj);
                monday.setDate(dateObj.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
                monday.setHours(0, 0, 0, 0);
                weekStartDate = monday.toISOString().split('T')[0];
            }
            
            // Get user_id from entry or provided value
            const targetUserId = user_id ? parseInt(user_id) : entry.user_id;
            
            // Get or create weekly timesheet
            const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(targetUserId, weekStartDate);
            const dailyEntry = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, entryDate, updatedEntry ? updatedEntry.id : null);
            
            // Calculate hours based on day_type
            let regularHours = 0;
            let totalHours = 0;
            
            if (day_type === 'holiday_unpaid' || day_type === 'sick_unpaid') {
                regularHours = 0;
                totalHours = 0;
            } else if (day_type === 'sick_paid') {
                // Paid sick: 8 hours Mon-Thu, 6 hours Friday
                const dateObjForSick = new Date(entryDate);
                const dayOfWeek = dateObjForSick.getDay(); // 0 = Sunday, 5 = Friday
                if (dayOfWeek === 5) {
                    // Friday
                    regularHours = 6;
                    totalHours = 6;
                } else {
                    // Monday to Thursday
                    regularHours = 8;
                    totalHours = 8;
                }
            } else if (day_type === 'holiday_paid') {
                // Check for linked holiday request to get hours
                let holidayRequest = null;
                if (dailyEntry.holiday_request_id) {
                    holidayRequest = await ProductionDatabase.getHolidayRequestById(dailyEntry.holiday_request_id);
                }
                
                // If no linked request, try to find approved request for this date and user
                if (!holidayRequest) {
                    const allRequests = await ProductionDatabase.getHolidayRequestsByUser(targetUserId);
                    const dateObj = new Date(entryDate);
                    holidayRequest = allRequests.find(req => {
                        if (req.status !== 'approved') return false;
                        const start = new Date(req.start_date);
                        const end = new Date(req.end_date);
                        return dateObj >= start && dateObj <= end;
                    });
                }
                
                if (holidayRequest && holidayRequest.days_requested) {
                    // If it's a half day (0.5), set 4 hours, otherwise 8 hours
                    totalHours = holidayRequest.days_requested === 0.5 ? 4 : 8;
                    regularHours = totalHours;
                } else {
                    // Default to 8 hours for full day
                    regularHours = 8;
                    totalHours = 8;
                }
            }
            
            // If times were amended, we need to recalculate and ensure day_type overrides
            if (updatedEntry && updatedEntry.clock_out_time) {
                // Recalculate hours for the amended entry
                await ProductionDatabase.calculateTimesheetHours(updatedEntry.id, dailyEntry.overnight_away || false);
                
                // Aggregate hours from all entries for this day
                const aggregatedHours = await ProductionDatabase.aggregateDailyHours(targetUserId, entryDate, dailyEntry.overnight_away || false);
                
                // Calculate final hours based on day_type (day_type always overrides aggregated hours)
                const finalHours = await ProductionDatabase.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, targetUserId, entryDate);
                
                // Update daily entry with day_type and final hours (day_type takes precedence)
                await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                    day_type: day_type,
                    regular_hours: finalHours.regular_hours,
                    overtime_hours: finalHours.overtime_hours,
                    weekend_hours: finalHours.weekend_hours,
                    overnight_hours: finalHours.overnight_hours,
                    total_hours: finalHours.total_hours
                });
            } else {
                // No times amended, just set day_type and calculated hours
                await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                    day_type: day_type,
                    regular_hours: regularHours,
                    overtime_hours: 0,
                    weekend_hours: 0,
                    overnight_hours: 0,
                    total_hours: totalHours
                });
            }
        } else if (updatedEntry && updatedEntry.clock_out_time) {
            // Day_type not set, but times were amended - still need to check for existing day_type
            const entryDate = new Date(updatedEntry.clock_in_time).toISOString().split('T')[0];
            const dateObj = new Date(entryDate);
            const dayOfWeek = dateObj.getDay();
            const monday = new Date(dateObj);
            monday.setDate(dateObj.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
            monday.setHours(0, 0, 0, 0);
            const weekStartDate = monday.toISOString().split('T')[0];
            
            const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(entry.user_id, weekStartDate);
            const dailyEntry = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, entryDate, updatedEntry.id);
            
            // Recalculate hours for the amended entry
            await ProductionDatabase.calculateTimesheetHours(updatedEntry.id, dailyEntry.overnight_away || false);
            
            // Aggregate hours from all entries for this day
            const aggregatedHours = await ProductionDatabase.aggregateDailyHours(entry.user_id, entryDate, dailyEntry.overnight_away || false);
            
            // Calculate final hours based on day_type (if day_type exists, it overrides)
            const finalHours = await ProductionDatabase.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, entry.user_id, entryDate);
            
            // Update daily entry with final hours
            await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                regular_hours: finalHours.regular_hours,
                overtime_hours: finalHours.overtime_hours,
                weekend_hours: finalHours.weekend_hours,
                overnight_hours: finalHours.overnight_hours,
                total_hours: finalHours.total_hours
            });
        }
        
        res.json({ success: true, entry: updatedEntry, message: 'Timesheet entry amended successfully by admin' });
    } catch (error) {
        console.error('Admin amend timesheet error:', error);
        res.status(500).json({ success: false, error: 'Failed to amend timesheet entry: ' + error.message });
    }
});

// Admin-only: Directly create timesheet entry for a user (applies immediately, no approval needed)
router.post('/clock/entries/admin/create', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const adminId = req.session.production_user.id;
        const { user_id, job_id, clock_in_time, clock_out_time, reason, overnight_away, day_type } = req.body;
        
        // Validate required fields
        if (!user_id || !reason) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        const isHolidayOrSick = day_type === 'holiday_paid' || day_type === 'holiday_unpaid' || 
                                day_type === 'sick_paid' || day_type === 'sick_unpaid';
        
        // Clock times and job are only required if not holiday/sick
        if (!isHolidayOrSick) {
            if (!job_id || !clock_in_time || !clock_out_time) {
                return res.status(400).json({ success: false, error: 'Missing required fields' });
            }
        }
        
        // Validate user exists
        const user = await ProductionDatabase.getUserById(parseInt(user_id));
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        // Validate job exists (if provided)
        if (job_id) {
            const job = await ProductionDatabase.getJobById(parseInt(job_id));
            if (!job) {
                return res.status(404).json({ success: false, error: 'Job/Site not found' });
            }
        }
        
        let entry = null;
        let entryDate = null;
        
        // If times are provided, validate and create timesheet entry
        if (clock_in_time && clock_out_time) {
            // Check if times are in the past
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const clockInDate = new Date(clock_in_time);
            clockInDate.setHours(0, 0, 0, 0);
            if (clockInDate > today) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Clock in time cannot be in the future. Please use a past date.' 
                });
            }
            
            const clockOutDate = new Date(clock_out_time);
            clockOutDate.setHours(0, 0, 0, 0);
            if (clockOutDate > today) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Clock out time cannot be in the future. Please use a past date.' 
                });
            }
            
            // Validate clock out is after clock in
            if (new Date(clock_out_time) <= new Date(clock_in_time)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Clock out time must be after clock in time.' 
                });
            }
            
            // Check for duplicate or overlapping times
            const duplicates = await ProductionDatabase.checkDuplicateTimes(
                parseInt(user_id), 
                clock_in_time, 
                clock_out_time, 
                null // No entry to exclude (creating new entry)
            );
            
            // Filter out auto-clocked-out entries from duplicates (they can be replaced)
            const realDuplicates = duplicates.filter(d => !ProductionDatabase.isAutoClockedOutEntry(d));
            
            if (realDuplicates && realDuplicates.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'The times would create a duplicate or overlap with an existing timesheet entry. Please choose different times.' 
                });
            }
            
            // Create the entry directly
            entry = await ProductionDatabase.adminCreateTimesheetEntry(
                parseInt(user_id),
                adminId,
                parseInt(job_id),
                clock_in_time,
                clock_out_time,
                reason,
                overnight_away !== undefined ? overnight_away : undefined
            );
            
            entryDate = new Date(clock_in_time).toISOString().split('T')[0];
        }
        
        // Handle day_type - update/create daily entry
        if (day_type) {
            // Validate day_type value
            const validDayTypes = ['holiday_paid', 'holiday_unpaid', 'sick_paid', 'sick_unpaid'];
            if (!validDayTypes.includes(day_type)) {
                return res.status(400).json({ success: false, error: 'Invalid day_type value' });
            }
            
            // Get date from entry or use clock_in_time date, or require date in request
            if (!entryDate && clock_in_time) {
                entryDate = new Date(clock_in_time).toISOString().split('T')[0];
            } else if (!entryDate) {
                // If no times provided, we need the date from request
                const { date } = req.body;
                if (!date) {
                    return res.status(400).json({ success: false, error: 'Date is required when creating holiday/sick day without clock times' });
                }
                entryDate = date;
            }
            
            // Find Monday of the week for this date
            const dateObj = new Date(entryDate);
            const dayOfWeek = dateObj.getDay();
            const monday = new Date(dateObj);
            monday.setDate(dateObj.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
            monday.setHours(0, 0, 0, 0);
            const weekStartDate = monday.toISOString().split('T')[0];
            
            // Get or create weekly timesheet
            const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(parseInt(user_id), weekStartDate);
            
            // Calculate hours based on day_type
            let regularHours = 0;
            let totalHours = 0;
            
            if (day_type === 'holiday_unpaid' || day_type === 'sick_unpaid') {
                regularHours = 0;
                totalHours = 0;
            } else if (day_type === 'sick_paid') {
                // Paid sick: 8 hours Mon-Thu, 6 hours Friday
                const dateObjForSick = new Date(entryDate);
                const dayOfWeek = dateObjForSick.getDay(); // 0 = Sunday, 5 = Friday
                if (dayOfWeek === 5) {
                    // Friday
                    regularHours = 6;
                    totalHours = 6;
                } else {
                    // Monday to Thursday
                    regularHours = 8;
                    totalHours = 8;
                }
            } else if (day_type === 'holiday_paid') {
                // Try to find approved holiday request for this date and user
                let holidayRequest = null;
                const allRequests = await ProductionDatabase.getHolidayRequestsByUser(parseInt(user_id));
                const dateObj = new Date(entryDate);
                holidayRequest = allRequests.find(req => {
                    if (req.status !== 'approved') return false;
                    const start = new Date(req.start_date);
                    const end = new Date(req.end_date);
                    return dateObj >= start && dateObj <= end;
                });
                
                if (holidayRequest && holidayRequest.days_requested) {
                    // If it's a half day (0.5), set 4 hours, otherwise 8 hours
                    totalHours = holidayRequest.days_requested === 0.5 ? 4 : 8;
                    regularHours = totalHours;
                } else {
                    // Default to 8 hours for full day
                    regularHours = 8;
                    totalHours = 8;
                }
            }
            
            // Get or create daily entry
            const dailyEntry = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, entryDate, entry ? entry.id : null);
            
            // If entry was created with times, recalculate and ensure day_type overrides
            if (entry && entry.clock_out_time) {
                // Recalculate hours for the created entry
                await ProductionDatabase.calculateTimesheetHours(entry.id, dailyEntry.overnight_away || false);
                
                // Aggregate hours from all entries for this day
                const aggregatedHours = await ProductionDatabase.aggregateDailyHours(parseInt(user_id), entryDate, dailyEntry.overnight_away || false);
                
                // Calculate final hours based on day_type (day_type always overrides aggregated hours)
                const finalHours = await ProductionDatabase.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, parseInt(user_id), entryDate);
                
                // Update daily entry with day_type and final hours (day_type takes precedence)
                await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                    day_type: day_type,
                    regular_hours: finalHours.regular_hours,
                    overtime_hours: finalHours.overtime_hours,
                    weekend_hours: finalHours.weekend_hours,
                    overnight_hours: finalHours.overnight_hours,
                    total_hours: finalHours.total_hours
                });
            } else {
                // No times provided, just set day_type and calculated hours
                await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                    day_type: day_type,
                    regular_hours: regularHours,
                    overtime_hours: 0,
                    weekend_hours: 0,
                    overnight_hours: 0,
                    total_hours: totalHours
                });
            }
        } else if (entry && entry.clock_out_time) {
            // No day_type set, but entry was created - check for existing day_type
            const entryDate = new Date(entry.clock_in_time).toISOString().split('T')[0];
            const dateObj = new Date(entryDate);
            const dayOfWeek = dateObj.getDay();
            const monday = new Date(dateObj);
            monday.setDate(dateObj.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
            monday.setHours(0, 0, 0, 0);
            const weekStartDate = monday.toISOString().split('T')[0];
            
            const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(parseInt(user_id), weekStartDate);
            const dailyEntry = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, entryDate, entry.id);
            
            // Recalculate hours for the created entry
            await ProductionDatabase.calculateTimesheetHours(entry.id, dailyEntry.overnight_away || false);
            
            // Aggregate hours from all entries for this day
            const aggregatedHours = await ProductionDatabase.aggregateDailyHours(parseInt(user_id), entryDate, dailyEntry.overnight_away || false);
            
            // Calculate final hours based on day_type (if day_type exists, it overrides)
            const finalHours = await ProductionDatabase.calculateHoursForDailyEntry(dailyEntry, aggregatedHours, parseInt(user_id), entryDate);
            
            // Update daily entry with final hours
            await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                regular_hours: finalHours.regular_hours,
                overtime_hours: finalHours.overtime_hours,
                weekend_hours: finalHours.weekend_hours,
                overnight_hours: finalHours.overnight_hours,
                total_hours: finalHours.total_hours
            });
        }
        
        res.json({ success: true, entry, message: 'Timesheet entry created successfully by admin' });
    } catch (error) {
        console.error('Admin create timesheet error:', error);
        res.status(500).json({ success: false, error: 'Failed to create timesheet entry: ' + error.message });
    }
});

router.get('/clock/amendments/pending', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const amendments = await ProductionDatabase.getPendingAmendments();
        res.json({ success: true, amendments });
    } catch (error) {
        console.error('Get pending amendments error:', error);
        res.status(500).json({ success: false, error: 'Failed to get pending amendments' });
    }
});

router.get('/clock/amendments/my', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const amendments = await ProductionDatabase.getUserAmendments(userId);
        res.json({ success: true, amendments });
    } catch (error) {
        console.error('Get user amendments error:', error);
        res.status(500).json({ success: false, error: 'Failed to get amendments' });
    }
});

router.put('/clock/amendments/:id/review', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const amendmentId = parseInt(req.params.id);
        const reviewerId = req.session.production_user.id;
        const { status, review_notes, approved_clock_in_time, approved_clock_out_time } = req.body;
        
        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }
        
        // If approved, require the approved times
        if (status === 'approved' && (!approved_clock_in_time || !approved_clock_out_time)) {
            return res.status(400).json({ success: false, error: 'Approved clock in and out times are required' });
        }
        
        // Get the amendment to find the entry and user
        const amendment = await ProductionDatabase.getAmendmentById(amendmentId);
        if (!amendment) {
            return res.status(404).json({ success: false, error: 'Amendment not found' });
        }
        
        // If approved, check for duplicate or overlapping times (excluding the current entry being amended)
        if (status === 'approved') {
            const entry = await ProductionDatabase.getTimesheetEntryById(amendment.timesheet_entry_id);
            if (entry) {
                const duplicates = await ProductionDatabase.checkDuplicateTimes(
                    entry.user_id, 
                    approved_clock_in_time, 
                    approved_clock_out_time, 
                    amendment.timesheet_entry_id // Exclude the current entry
                );
                if (duplicates && duplicates.length > 0) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'The approved times would create a duplicate or overlap with an existing timesheet entry. Please choose different times.' 
                    });
                }
            }
        }
        
        const reviewedAmendment = await ProductionDatabase.reviewAmendment(
            amendmentId, 
            reviewerId, 
            status, 
            review_notes,
            status === 'approved' ? approved_clock_in_time : null,
            status === 'approved' ? approved_clock_out_time : null
        );
        
        // If approved, apply the amendment with the approved times
        if (status === 'approved') {
            await ProductionDatabase.applyAmendment(amendmentId, approved_clock_in_time, approved_clock_out_time);
        }
        
        res.json({ success: true, amendment: reviewedAmendment });
    } catch (error) {
        console.error('Review amendment error:', error);
        res.status(500).json({ success: false, error: 'Failed to review amendment' });
    }
});

// Delete timesheet entry (admin only)
router.delete('/clock/entries/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const entryId = parseInt(req.params.id);
        const entry = await ProductionDatabase.deleteTimesheetEntry(entryId);
        
        if (!entry) {
            return res.status(404).json({ success: false, error: 'Timesheet entry not found' });
        }
        
        res.json({ success: true, message: 'Timesheet entry deleted successfully' });
    } catch (error) {
        console.error('Delete timesheet entry error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to delete timesheet entry',
            details: error.message 
        });
    }
});

// Payroll routes
router.get('/clock/payroll/:weekStart', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const weekStartDate = req.params.weekStart;
        const summary = await ProductionDatabase.getPayrollSummary(weekStartDate);
        res.json({ success: true, summary });
    } catch (error) {
        console.error('Get payroll summary error:', error);
        res.status(500).json({ success: false, error: 'Failed to get payroll summary' });
    }
});

router.put('/clock/weekly/:weekStart/approve/:userId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const weekStartDate = req.params.weekStart;
        const userId = parseInt(req.params.userId);
        const adminId = req.session.production_user.id;
        
        // Check if week is complete (only allow approval of completed weeks)
        const today = new Date();
        const dayOfWeek = today.getDay();
        const currentWeekMonday = new Date(today);
        currentWeekMonday.setDate(currentWeekMonday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
        currentWeekMonday.setHours(0, 0, 0, 0);
        const currentWeekStartStr = currentWeekMonday.toISOString().split('T')[0];
        
        // Week is complete if its start date is before current week's start
        if (weekStartDate >= currentWeekStartStr) {
            return res.status(400).json({ 
                success: false, 
                error: 'Cannot approve timesheet for week in progress. Week must be complete before approval.' 
            });
        }
        
        // Get or create weekly timesheet
        const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(userId, weekStartDate);
        
        // Toggle approval status
        const currentApproved = weeklyTimesheet.manager_approved || false;
        const newApproved = !currentApproved;
        
        // Update approval status
        const updated = await ProductionDatabase.updateWeeklyTimesheet(weeklyTimesheet.id, {
            manager_approved: newApproved,
            approved_by: newApproved ? adminId : null
        });
        
        res.json({ 
            success: true, 
            weeklyTimesheet: updated,
            message: newApproved ? 'Timesheet approved' : 'Timesheet approval removed'
        });
    } catch (error) {
        console.error('Toggle manager approval error:', error);
        res.status(500).json({ success: false, error: 'Failed to update manager approval' });
    }
});

router.get('/clock/payroll/:weekStart/user/:userId/daily', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const weekStartDate = req.params.weekStart;
        const userId = parseInt(req.params.userId);
        const dailyBreakdown = await ProductionDatabase.getPayrollDailyBreakdown(userId, weekStartDate);
        res.json({ success: true, dailyBreakdown });
    } catch (error) {
        console.error('Get payroll daily breakdown error:', error);
        res.status(500).json({ success: false, error: 'Failed to get daily breakdown' });
    }
});

router.get('/clock/payroll/:weekStart/export', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const weekStartDate = req.params.weekStart;
        const summary = await ProductionDatabase.getPayrollSummary(weekStartDate);
        
        // Helper function to round to 15-minute intervals (0.25 hour increments)
        const roundToQuarterHour = (hours) => {
            if (!hours || isNaN(hours)) return 0;
            return Math.round(parseFloat(hours) * 4) / 4;
        };
        
        // Generate CSV
        const csvRows = [];
        csvRows.push('Staff Name,Week Start,Regular Hours,Overtime Hours (1.25x),Weekend Hours (1.5x),Overnight Hours (1.25x),Total Hours,Days Worked');
        
        summary.forEach(row => {
            const regular = roundToQuarterHour(row.total_regular_hours || 0);
            const overtime = roundToQuarterHour(row.total_overtime_hours || 0);
            const weekend = roundToQuarterHour(row.total_weekend_hours || 0);
            const overnight = roundToQuarterHour(row.total_overnight_hours || 0);
            const total = roundToQuarterHour(row.total_hours || 0);
            
            csvRows.push([
                row.username || '',
                row.week_start_date || '',
                regular.toFixed(2),
                overtime.toFixed(2),
                weekend.toFixed(2),
                overnight.toFixed(2),
                total.toFixed(2),
                row.days_worked || 0
            ].join(','));
        });
        
        const csv = csvRows.join('\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="payroll-${weekStartDate}.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Export payroll error:', error);
        res.status(500).json({ success: false, error: 'Failed to export payroll' });
    }
});

// Admin routes for viewing all staff timesheets
router.get('/clock/weekly/all/:weekStart', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const weekStartDate = req.params.weekStart;
        const payroll = await ProductionDatabase.getPayrollSummary(weekStartDate);
        res.json({ success: true, payroll });
    } catch (error) {
        console.error('Get all weekly timesheets error:', error);
        res.status(500).json({ success: false, error: 'Failed to get weekly timesheets' });
    }
});

router.get('/clock/weekly/user/:userId/:weekStart', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const weekStartDate = req.params.weekStart;
        
        const weeklyTimesheet = await ProductionDatabase.getWeeklyTimesheet(userId, weekStartDate);
        if (!weeklyTimesheet) {
            return res.json({ success: true, weeklyTimesheet: null, dailyEntries: [] });
        }
        
        const dailyEntries = await ProductionDatabase.getDailyEntriesForWeek(weeklyTimesheet.id);
        res.json({ success: true, weeklyTimesheet, dailyEntries });
    } catch (error) {
        console.error('Get user weekly timesheet error:', error);
        res.status(500).json({ success: false, error: 'Failed to get weekly timesheet' });
    }
});

// ============ STOCK CHECK REMINDERS ROUTES ============

router.get('/reminders', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const userRole = req.session.production_user.role;
        const reminders = await ProductionDatabase.getAllReminders(userId, userRole);
        res.json({ success: true, reminders });
    } catch (error) {
        console.error('Get reminders error:', error);
        res.status(500).json({ success: false, error: 'Failed to get reminders' });
    }
});

router.get('/reminders/overdue', requireProductionAuth, async (req, res) => {
    try {
        const userId = parseInt(req.session.production_user.id);
        const userRole = req.session.production_user.role;
        
        console.log('Getting overdue reminders for user:', userId, 'role:', userRole);
        
        let stockReminders = [];
        try {
            stockReminders = await ProductionDatabase.getOverdueReminders(userId, userRole);
            console.log('Stock reminders found:', stockReminders.length);
        } catch (stockError) {
            console.error('Error getting stock reminders:', stockError);
            console.error('Stack:', stockError.stack);
            // Continue with empty array instead of failing completely
        }
        
        // Get timesheet approval reminders (only for admin/office roles)
        let timesheetReminders = [];
        if (req.session.production_user && (req.session.production_user.role === 'admin' || req.session.production_user.role === 'office')) {
            try {
                const unapprovedWeeks = await ProductionDatabase.getUnapprovedTimesheetWeeks();
                timesheetReminders = unapprovedWeeks.map(week => ({
                    type: 'timesheet_approval',
                    week_start_date: week.week_start_date,
                    unapproved_count: week.unapproved_count,
                    reminder_text: `${week.unapproved_count} timesheet${week.unapproved_count > 1 ? 's' : ''} need${week.unapproved_count === 1 ? 's' : ''} approval`
                }));
                console.log('Timesheet reminders found:', timesheetReminders.length);
            } catch (timesheetError) {
                console.error('Error getting timesheet reminders:', timesheetError);
                console.error('Stack:', timesheetError.stack);
                // Continue with empty array instead of failing completely
            }
        }
        
        // Combine both types of reminders
        const allReminders = [
            ...stockReminders.map(r => ({ ...r, type: 'stock_check' })),
            ...timesheetReminders
        ];
        
        res.json({ success: true, reminders: allReminders });
    } catch (error) {
        console.error('Get overdue reminders error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to get overdue reminders: ' + error.message });
    }
});

router.post('/reminders', requireProductionAuth, async (req, res) => {
    try {
        const { stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active, user_id, target_role, assign_to, reminder_text, reminder_type } = req.body;
        
        const reminderType = reminder_type || 'stock_check';
        
        // Validation based on reminder type
        if (reminderType === 'stock_check') {
            if (!stock_item_id || !check_frequency_days) {
                return res.status(400).json({ success: false, error: 'Stock item ID and frequency are required for stock check reminders' });
            }
        } else if (reminderType === 'text') {
            if (!reminder_text || !reminder_text.trim()) {
                return res.status(400).json({ success: false, error: 'Reminder text is required for text reminders' });
            }
            if (!next_check_date) {
                return res.status(400).json({ success: false, error: 'Due date (next check date) is required for text reminders' });
            }
        } else {
            return res.status(400).json({ success: false, error: 'Invalid reminder type. Must be "stock_check" or "text"' });
        }
        
        const currentUser = req.session.production_user;
        const currentUserId = currentUser.id;
        const currentUserRole = currentUser.role;
        
        // Determine assignment based on assign_to field
        let finalUserId = null;
        let finalTargetRole = null;
        
        if (assign_to === 'myself') {
            // User creating reminder for themselves
            finalUserId = currentUserId;
        } else if (assign_to === 'user' && user_id) {
            // Admin assigning to specific user
            if (currentUserRole !== 'admin') {
                return res.status(403).json({ success: false, error: 'Only admins can assign reminders to specific users' });
            }
            finalUserId = parseInt(user_id);
        } else if (assign_to === 'role' && target_role) {
            // Admin assigning to role
            if (currentUserRole !== 'admin') {
                return res.status(403).json({ success: false, error: 'Only admins can assign reminders to roles' });
            }
            finalTargetRole = target_role;
        } else if (assign_to === 'all') {
            // Admin assigning to all users (global)
            if (currentUserRole !== 'admin') {
                return res.status(403).json({ success: false, error: 'Only admins can create global reminders' });
            }
            // Both null = global reminder
            finalUserId = null;
            finalTargetRole = null;
        } else {
            // Default: assign to self for non-admins
            if (currentUserRole !== 'admin') {
                finalUserId = currentUserId;
            } else {
                return res.status(400).json({ success: false, error: 'Invalid assignment. Please specify assign_to, user_id, or target_role' });
            }
        }
        
        const reminder = await ProductionDatabase.createReminder({
            stock_item_id: stock_item_id ? parseInt(stock_item_id) : null,
            check_frequency_days: check_frequency_days ? parseInt(check_frequency_days) : null,
            last_checked_date,
            next_check_date,
            is_active,
            user_id: finalUserId,
            target_role: finalTargetRole,
            created_by_user_id: currentUserId,
            reminder_text: reminder_text || null,
            reminder_type: reminderType
        });
        res.json({ success: true, reminder });
    } catch (error) {
        console.error('Create reminder error:', error);
        res.status(500).json({ success: false, error: 'Failed to create reminder' });
    }
});

router.put('/reminders/:id', requireProductionAuth, async (req, res) => {
    try {
        const reminderId = parseInt(req.params.id);
        const currentUser = req.session.production_user;
        const currentUserId = currentUser.id;
        const currentUserRole = currentUser.role;
        
        // Check permission: user must own the reminder OR be admin
        const reminder = await ProductionDatabase.getReminderById(reminderId);
        if (!reminder) {
            return res.status(404).json({ success: false, error: 'Reminder not found' });
        }
        
        if (reminder.created_by_user_id !== currentUserId && currentUserRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'You can only edit reminders you created' });
        }
        
        const { check_frequency_days, is_active, user_id, target_role, assign_to, reminder_text, reminder_type } = req.body;
        const updateData = {
            check_frequency_days: check_frequency_days !== undefined ? parseInt(check_frequency_days) : undefined,
            is_active
        };
        
        // Handle reminder type and text
        if (reminder_type !== undefined) {
            updateData.reminder_type = reminder_type;
        }
        if (reminder_text !== undefined) {
            updateData.reminder_text = reminder_text;
        }
        
        // Validate based on reminder type
        const finalReminderType = reminder_type !== undefined ? reminder_type : (reminder.reminder_type || 'stock_check');
        if (finalReminderType === 'text' && updateData.reminder_text !== undefined && !updateData.reminder_text?.trim()) {
            return res.status(400).json({ success: false, error: 'Reminder text is required for text reminders' });
        }
        
        // Handle assignment updates (only if provided)
        if (assign_to) {
            if (assign_to === 'myself') {
                updateData.user_id = currentUserId;
                updateData.target_role = null;
            } else if (assign_to === 'user' && user_id) {
                if (currentUserRole !== 'admin') {
                    return res.status(403).json({ success: false, error: 'Only admins can assign reminders to specific users' });
                }
                updateData.user_id = parseInt(user_id);
                updateData.target_role = null;
            } else if (assign_to === 'role' && target_role) {
                if (currentUserRole !== 'admin') {
                    return res.status(403).json({ success: false, error: 'Only admins can assign reminders to roles' });
                }
                updateData.user_id = null;
                updateData.target_role = target_role;
            } else if (assign_to === 'all') {
                if (currentUserRole !== 'admin') {
                    return res.status(403).json({ success: false, error: 'Only admins can create global reminders' });
                }
                updateData.user_id = null;
                updateData.target_role = null;
            }
        }
        
        const updatedReminder = await ProductionDatabase.updateReminder(reminderId, updateData);
        res.json({ success: true, reminder: updatedReminder });
    } catch (error) {
        console.error('Update reminder error:', error);
        res.status(500).json({ success: false, error: 'Failed to update reminder' });
    }
});

router.post('/reminders/:id/check', requireProductionAuth, async (req, res) => {
    try {
        const reminderId = parseInt(req.params.id);
        const reminder = await ProductionDatabase.markReminderChecked(reminderId);
        res.json({ success: true, reminder });
    } catch (error) {
        console.error('Mark reminder checked error:', error);
        res.status(500).json({ success: false, error: 'Failed to mark reminder as checked' });
    }
});

router.delete('/reminders/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const reminderId = parseInt(req.params.id);
        await ProductionDatabase.deleteReminder(reminderId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete reminder error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete reminder' });
    }
});

// ============ PLANNER ROUTES ============

router.get('/planner', requireProductionAuth, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const planners = await ProductionDatabase.getAllWeeklyPlanners(start_date, end_date);
        res.json({ success: true, planners });
    } catch (error) {
        console.error('Get planners error:', error);
        res.status(500).json({ success: false, error: 'Failed to get planners' });
    }
});

router.get('/planner/low-stock-panels', requireProductionAuth, async (req, res) => {
    try {
        const panels = await ProductionDatabase.getLowStockPanels();
        res.json({ success: true, panels });
    } catch (error) {
        console.error('Get low stock panels error:', error);
        res.status(500).json({ success: false, error: 'Failed to get low stock panels' });
    }
});

router.get('/planner/low-stock-components', requireProductionAuth, async (req, res) => {
    try {
        const components = await ProductionDatabase.getLowStockComponents();
        res.json({ success: true, components });
    } catch (error) {
        console.error('Get low stock components error:', error);
        res.status(500).json({ success: false, error: 'Failed to get low stock components' });
    }
});

router.post('/planner', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const { week_start_date, staff_available, hours_available, notes } = req.body;
        if (!week_start_date) {
            return res.status(400).json({ success: false, error: 'Week start date is required' });
        }
        
        const planner = await ProductionDatabase.createWeeklyPlanner({
            week_start_date,
            staff_available: parseInt(staff_available) || 1,
            hours_available: parseFloat(hours_available) || 40,
            notes
        });
        res.json({ success: true, planner });
    } catch (error) {
        console.error('Create planner error:', error);
        
        // Check for duplicate week_start_date error
        if (error.message && (error.message.includes('UNIQUE') || error.message.includes('duplicate') || error.message.includes('unique constraint'))) {
            return res.status(409).json({ success: false, error: 'A planner already exists for this week. Please edit the existing planner instead.' });
        }
        
        // Return more specific error message if available
        const errorMessage = error.message || 'Failed to create planner';
        res.status(500).json({ success: false, error: errorMessage });
    }
});

router.get('/planner/:id', requireProductionAuth, async (req, res) => {
    try {
        const plannerId = parseInt(req.params.id);
        const planner = await ProductionDatabase.getWeeklyPlannerById(plannerId);
        if (!planner) {
            return res.status(404).json({ success: false, error: 'Planner not found' });
        }
        
        const items = await ProductionDatabase.getPlannerItems(plannerId);
        let buildRate = await ProductionDatabase.calculatePlannerBuildRate(plannerId);
        
        // Ensure buildRate is never null
        if (!buildRate) {
            buildRate = {
                hours_available: parseFloat(planner.hours_available || 0),
                hours_required: 0,
                hours_shortfall: 0,
                hours_excess: parseFloat(planner.hours_available || 0),
                build_rate_percent: 100,
                is_feasible: true,
                indicator: 'green',
                emoji: '😊'
            };
        }
        
        res.json({ success: true, planner, items, build_rate: buildRate });
    } catch (error) {
        console.error('Get planner error:', error);
        console.error('Error details:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to get planner: ' + (error.message || 'Unknown error') });
    }
});

router.put('/planner/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const plannerId = parseInt(req.params.id);
        const { staff_available, hours_available, notes } = req.body;
        
        const planner = await ProductionDatabase.updateWeeklyPlanner(plannerId, {
            staff_available: parseInt(staff_available),
            hours_available: parseFloat(hours_available),
            notes
        });
        res.json({ success: true, planner });
    } catch (error) {
        console.error('Update planner error:', error);
        res.status(500).json({ success: false, error: 'Failed to update planner' });
    }
});

router.delete('/planner/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const plannerId = parseInt(req.params.id);
        await ProductionDatabase.deleteWeeklyPlanner(plannerId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete planner error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete planner' });
    }
});

router.get('/planner/:id/build-rate', requireProductionAuth, async (req, res) => {
    try {
        const plannerId = parseInt(req.params.id);
        const buildRate = await ProductionDatabase.calculatePlannerBuildRate(plannerId);
        if (!buildRate) {
            return res.status(404).json({ success: false, error: 'Planner not found' });
        }
        res.json({ success: true, build_rate: buildRate });
    } catch (error) {
        console.error('Calculate build rate error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate build rate' });
    }
});

router.post('/planner/:id/items', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const plannerId = parseInt(req.params.id);
        const { item_type, item_id, panel_id, job_name, quantity_to_build, priority, status, start_day, end_day } = req.body;
        
        // Support both old format (panel_id) and new format (item_type + item_id/job_name)
        let finalItemType, finalItemId, finalJobName;
        if (item_type === 'job') {
            // Job type - requires job_name and quantity_to_build (hours)
            if (!job_name || !quantity_to_build) {
                return res.status(400).json({ success: false, error: 'Job name and hours are required for job items' });
            }
            finalItemType = 'job';
            finalItemId = null;
            finalJobName = job_name;
        } else if (item_type && item_id) {
            // New format for components/built items
            if (!['component', 'built_item'].includes(item_type)) {
                return res.status(400).json({ success: false, error: 'Invalid item_type. Must be component, built_item, or job' });
            }
            finalItemType = item_type;
            finalItemId = parseInt(item_id);
            finalJobName = null;
        } else if (panel_id) {
            // Old format (backward compatibility)
            finalItemType = 'built_item';
            finalItemId = parseInt(panel_id);
            finalJobName = null;
        } else {
            return res.status(400).json({ success: false, error: 'Item type and ID (or panel_id) and quantity are required' });
        }
        
        if (!quantity_to_build) {
            return res.status(400).json({ success: false, error: 'Quantity/hours is required' });
        }
        
        // Validate day assignments (0-5, where 0=Monday, 5=Saturday)
        let finalStartDay = start_day !== undefined && start_day !== null ? parseInt(start_day) : null;
        let finalEndDay = end_day !== undefined && end_day !== null ? parseInt(end_day) : null;
        
        if (finalStartDay !== null && (finalStartDay < 0 || finalStartDay > 5)) {
            return res.status(400).json({ success: false, error: 'start_day must be between 0 (Monday) and 5 (Saturday)' });
        }
        if (finalEndDay !== null && (finalEndDay < 0 || finalEndDay > 5)) {
            return res.status(400).json({ success: false, error: 'end_day must be between 0 (Monday) and 5 (Saturday)' });
        }
        if (finalStartDay !== null && finalEndDay !== null && finalStartDay > finalEndDay) {
            return res.status(400).json({ success: false, error: 'start_day cannot be greater than end_day' });
        }
        
        const item = await ProductionDatabase.addPlannerItem(
            plannerId,
            finalItemType,
            finalItemId,
            parseFloat(quantity_to_build),
            priority || 'medium',
            status || 'planned',
            finalJobName,
            finalStartDay,
            finalEndDay
        );
        res.json({ success: true, item });
    } catch (error) {
        console.error('Add planner item error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to add planner item: ' + (error.message || 'Unknown error') });
    }
});

router.put('/planner/items/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        const { quantity_to_build, quantity_built, hours_used, priority, status, start_day, end_day } = req.body;
        
        // Validate day assignments if provided
        let finalStartDay = start_day !== undefined && start_day !== null ? parseInt(start_day) : undefined;
        let finalEndDay = end_day !== undefined && end_day !== null ? parseInt(end_day) : undefined;
        
        if (finalStartDay !== undefined && (finalStartDay < 0 || finalStartDay > 5)) {
            return res.status(400).json({ success: false, error: 'start_day must be between 0 (Monday) and 5 (Saturday)' });
        }
        if (finalEndDay !== undefined && (finalEndDay < 0 || finalEndDay > 5)) {
            return res.status(400).json({ success: false, error: 'end_day must be between 0 (Monday) and 5 (Saturday)' });
        }
        if (finalStartDay !== undefined && finalEndDay !== undefined && finalStartDay > finalEndDay) {
            return res.status(400).json({ success: false, error: 'start_day cannot be greater than end_day' });
        }
        
        const item = await ProductionDatabase.updatePlannerItem(itemId, {
            quantity_to_build: parseFloat(quantity_to_build),
            quantity_built: quantity_built !== undefined ? parseFloat(quantity_built) : undefined,
            hours_used: hours_used !== undefined ? parseFloat(hours_used) : undefined,
            priority,
            status,
            start_day: finalStartDay,
            end_day: finalEndDay
        });
        res.json({ success: true, item });
    } catch (error) {
        console.error('Update planner item error:', error);
        res.status(500).json({ success: false, error: 'Failed to update planner item' });
    }
});

router.get('/planner/:id/efficiency', requireProductionAuth, async (req, res) => {
    try {
        const plannerId = parseInt(req.params.id);
        const efficiency = await ProductionDatabase.calculatePlannerEfficiency(plannerId);
        if (!efficiency) {
            return res.status(404).json({ success: false, error: 'Planner not found' });
        }
        res.json({ success: true, efficiency });
    } catch (error) {
        console.error('Calculate efficiency error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate efficiency' });
    }
});

router.delete('/planner/items/:id', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        await ProductionDatabase.deletePlannerItem(itemId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete planner item error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete planner item' });
    }
});

// ============ TASK MANAGEMENT ROUTES ============

router.get('/tasks', requireProductionAuth, async (req, res) => {
    try {
        const filters = {};
        if (req.query.status) filters.status = req.query.status;
        if (req.query.assigned_to_user_id) filters.assigned_to_user_id = parseInt(req.query.assigned_to_user_id);
        if (req.query.overdue === 'true') filters.overdue = true;
        
        const tasks = await ProductionDatabase.getAllTasks(filters);
        res.json({ success: true, tasks });
    } catch (error) {
        console.error('Get tasks error:', error);
        res.status(500).json({ success: false, error: 'Failed to get tasks' });
    }
});

router.get('/tasks/my', requireProductionAuth, async (req, res) => {
    try {
        const filters = { assigned_to_user_id: req.session.production_user.id };
        if (req.query.status) filters.status = req.query.status;
        if (req.query.overdue === 'true') filters.overdue = true;
        
        const tasks = await ProductionDatabase.getAllTasks(filters);
        res.json({ success: true, tasks });
    } catch (error) {
        console.error('Get my tasks error:', error);
        res.status(500).json({ success: false, error: 'Failed to get my tasks' });
    }
});

router.post('/tasks', requireProductionAuth, async (req, res) => {
    try {
        const { title, description, assigned_to_user_id, due_date, status } = req.body;
        if (!title) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }
        
        const task = await ProductionDatabase.createTask({
            title,
            description,
            assigned_to_user_id: assigned_to_user_id ? parseInt(assigned_to_user_id) : null,
            created_by_user_id: req.session.production_user.id,
            due_date,
            status
        });
        res.json({ success: true, task });
    } catch (error) {
        console.error('Create task error:', error);
        res.status(500).json({ success: false, error: 'Failed to create task' });
    }
});

router.put('/tasks/:id', requireProductionAuth, async (req, res) => {
    try {
        const taskId = parseInt(req.params.id);
        const { title, description, assigned_to_user_id, status, due_date } = req.body;
        
        const task = await ProductionDatabase.updateTask(taskId, {
            title,
            description,
            assigned_to_user_id: assigned_to_user_id ? parseInt(assigned_to_user_id) : null,
            status,
            due_date
        });
        res.json({ success: true, task });
    } catch (error) {
        console.error('Update task error:', error);
        res.status(500).json({ success: false, error: 'Failed to update task' });
    }
});

router.post('/tasks/:id/complete', requireProductionAuth, async (req, res) => {
    try {
        const taskId = parseInt(req.params.id);
        const task = await ProductionDatabase.completeTask(taskId, req.session.production_user.id);
        res.json({ success: true, task });
    } catch (error) {
        console.error('Complete task error:', error);
        res.status(500).json({ success: false, error: 'Failed to complete task' });
    }
});

router.delete('/tasks/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const taskId = parseInt(req.params.id);
        await ProductionDatabase.deleteTask(taskId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete task' });
    }
});

router.get('/tasks/:id/comments', requireProductionAuth, async (req, res) => {
    try {
        const taskId = parseInt(req.params.id);
        const comments = await ProductionDatabase.getTaskComments(taskId);
        res.json({ success: true, comments });
    } catch (error) {
        console.error('Get task comments error:', error);
        res.status(500).json({ success: false, error: 'Failed to get task comments' });
    }
});

router.post('/tasks/:id/comments', requireProductionAuth, async (req, res) => {
    try {
        const taskId = parseInt(req.params.id);
        const { comment } = req.body;
        if (!comment) {
            return res.status(400).json({ success: false, error: 'Comment is required' });
        }
        
        const taskComment = await ProductionDatabase.addTaskComment(taskId, req.session.production_user.id, comment);
        res.json({ success: true, comment: taskComment });
    } catch (error) {
        console.error('Add task comment error:', error);
        res.status(500).json({ success: false, error: 'Failed to add task comment' });
    }
});

// ============ HOLIDAY ROUTES ============

// Holiday Entitlement Routes
router.get('/holidays/entitlements', requireProductionAuth, async (req, res) => {
    try {
        const user = req.session.production_user;
        console.log('Getting entitlements for user:', user.id, 'role:', user.role);
        if (user.role === 'admin' || user.role === 'office') {
            const entitlements = await ProductionDatabase.getAllHolidayEntitlements();
            console.log('Admin/Office - All entitlements:', entitlements);
            res.json({ success: true, entitlements });
        } else {
            const userId = parseInt(user.id);
            console.log('Regular user - Getting entitlements for userId:', userId);
            const entitlements = await ProductionDatabase.getUserHolidayEntitlements(userId);
            console.log('User entitlements:', entitlements);
            res.json({ success: true, entitlements });
        }
    } catch (error) {
        console.error('Get holiday entitlements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get holiday entitlements' });
    }
});

router.get('/holidays/entitlements/:userId', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const entitlements = await ProductionDatabase.getUserHolidayEntitlements(userId);
        res.json({ success: true, entitlements });
    } catch (error) {
        console.error('Get user holiday entitlements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get user holiday entitlements' });
    }
});

router.get('/holidays/entitlements/:userId/:year', requireProductionAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const year = parseInt(req.params.year);
        const user = req.session.production_user;
        
        // Users can only see their own entitlements unless they're admin/office
        if (user.role !== 'admin' && user.role !== 'office' && parseInt(user.id) !== userId) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }
        
        const entitlement = await ProductionDatabase.getHolidayEntitlement(userId, year);
        res.json({ success: true, entitlement });
    } catch (error) {
        console.error('Get holiday entitlement error:', error);
        res.status(500).json({ success: false, error: 'Failed to get holiday entitlement' });
    }
});

router.post('/holidays/entitlements/recalculate', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        console.log('Recalculating all holiday entitlements...');
        const result = await ProductionDatabase.recalculateAllEntitlements();
        
        res.json({
            success: true,
            message: `Recalculated ${result.updated} entitlements based on ${result.shutdownPeriodsCount} shutdown periods and ${result.approvedRequestsCount} approved requests.`,
            result
        });
    } catch (error) {
        console.error('Recalculate entitlements error:', error);
        res.status(500).json({ success: false, error: 'Failed to recalculate entitlements: ' + error.message });
    }
});

router.post('/holidays/entitlements', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { user_id, year, total_days } = req.body;
        if (!user_id || !year || total_days === undefined) {
            return res.status(400).json({ success: false, error: 'User ID, year, and total days are required' });
        }
        
        console.log('Creating holiday entitlement:', { user_id, year, total_days });
        
        const entitlement = await ProductionDatabase.createHolidayEntitlement(parseInt(user_id), parseInt(year), parseInt(total_days));
        
        console.log('Created holiday entitlement:', entitlement);
        
        if (!entitlement) {
            console.error('createHolidayEntitlement returned null/undefined');
            return res.status(500).json({ success: false, error: 'Failed to create holiday entitlement - database returned null' });
        }
        
        res.json({ success: true, entitlement });
    } catch (error) {
        console.error('Create holiday entitlement error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to create holiday entitlement: ' + error.message });
    }
});

router.put('/holidays/entitlements/:userId/:year', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const year = parseInt(req.params.year);
        const { total_days } = req.body;
        
        if (total_days === undefined) {
            return res.status(400).json({ success: false, error: 'Total days is required' });
        }
        
        const entitlement = await ProductionDatabase.createHolidayEntitlement(userId, year, parseInt(total_days));
        res.json({ success: true, entitlement });
    } catch (error) {
        console.error('Update holiday entitlement error:', error);
        res.status(500).json({ success: false, error: 'Failed to update holiday entitlement' });
    }
});

// Holiday Request Routes
router.get('/holidays/requests', requireProductionAuth, async (req, res) => {
    try {
        const user = req.session.production_user;
        const year = req.query.year ? parseInt(req.query.year) : null;
        
        if (user.role === 'admin' || user.role === 'office') {
            const requests = await ProductionDatabase.getAllHolidayRequests(year);
            res.json({ success: true, requests });
        } else {
            // Ensure user ID is parsed as integer for proper filtering
            const userId = parseInt(user.id);
            console.log('Getting holiday requests for user ID:', userId, 'type:', typeof userId);
            const requests = await ProductionDatabase.getHolidayRequestsByUser(userId, year);
            console.log('Found', requests.length, 'requests for user', userId);
            res.json({ success: true, requests });
        }
    } catch (error) {
        console.error('Get holiday requests error:', error);
        res.status(500).json({ success: false, error: 'Failed to get holiday requests' });
    }
});

router.get('/holidays/requests/pending', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const requests = await ProductionDatabase.getPendingHolidayRequests();
        res.json({ success: true, requests });
    } catch (error) {
        console.error('Get pending holiday requests error:', error);
        res.status(500).json({ success: false, error: 'Failed to get pending holiday requests' });
    }
});

router.post('/holidays/requests', requireProductionAuth, async (req, res) => {
    try {
        const { start_date, end_date, day_type, is_company_shutdown } = req.body;
        const user = req.session.production_user;
        
        if (!user || !user.id) {
            console.error('No user in session or user.id is missing');
            return res.status(401).json({ success: false, error: 'User not authenticated' });
        }
        
        if (!start_date || !end_date) {
            return res.status(400).json({ success: false, error: 'Start date and end date are required' });
        }
        
        // Validate day_type (default to 'full' if not provided for backward compatibility)
        const dayType = day_type || 'full';
        if (dayType !== 'half' && dayType !== 'full') {
            return res.status(400).json({ success: false, error: 'day_type must be either "half" or "full"' });
        }
        
        // For half day, start and end dates must be the same
        if (dayType === 'half' && start_date !== end_date) {
            return res.status(400).json({ success: false, error: 'For half day, start date and end date must be the same' });
        }
        
        // Calculate holiday days (Fri = 0.75, Mon-Thu = 1, half = 0.5 or 0.375 Fri)
        const weekdays = ProductionDatabase.calculateHolidayDaysRequested(start_date, end_date, dayType);
        if (weekdays <= 0) {
            return res.status(400).json({ success: false, error: 'Date range must include at least one weekday' });
        }
        
        // Check entitlement
        const currentYear = new Date(start_date).getFullYear();
        const userId = parseInt(user.id);
        console.log('=== HOLIDAY REQUEST SUBMISSION ===');
        console.log('User object:', JSON.stringify(user, null, 2));
        console.log('User ID from session:', user.id, 'type:', typeof user.id);
        console.log('Parsed user ID:', userId, 'type:', typeof userId);
        console.log('Request year:', currentYear, 'type:', typeof currentYear);
        console.log('Start date:', start_date, 'End date:', end_date);
        
        const entitlement = await ProductionDatabase.getHolidayEntitlement(userId, currentYear);
        console.log('Entitlement lookup result:', entitlement);
        
        if (!entitlement) {
            // Check if entitlement exists for any year or user
            const allEntitlements = await ProductionDatabase.getAllHolidayEntitlements();
            console.log('All entitlements in database:', JSON.stringify(allEntitlements, null, 2));
            const userEntitlements = allEntitlements.filter(e => parseInt(e.user_id) === userId);
            console.log('Entitlements for this user (userId=' + userId + '):', JSON.stringify(userEntitlements, null, 2));
            
            // Also check what user_ids exist in entitlements
            const uniqueUserIds = [...new Set(allEntitlements.map(e => e.user_id))];
            console.log('Unique user_ids in entitlements table:', uniqueUserIds);
            
            return res.status(400).json({ 
                success: false, 
                error: `No holiday entitlement found for year ${currentYear}`,
                debug: {
                    userId: userId,
                    year: currentYear,
                    userEntitlements: userEntitlements,
                    allUserIds: uniqueUserIds
                }
            });
        }
        
        // Calculate days remaining (can be negative if shutdown periods have been applied)
        const daysRemaining = parseFloat(entitlement.total_days || 0) - parseFloat(entitlement.days_used || 0);
        // Allow negative balances - shutdown periods can cause this
        // Just log a warning if going negative
        if (daysRemaining < weekdays) {
            console.log(`Warning: User ${userId} requesting ${weekdays} days but only has ${daysRemaining.toFixed(1)} days remaining (will go negative)`);
        }
        
        const request = await ProductionDatabase.createHolidayRequest({
            user_id: user.id,
            start_date,
            end_date,
            requested_by_user_id: user.id,
            is_company_shutdown: is_company_shutdown || false,
            days_requested: weekdays // Override calculated weekdays with actual days (0.5 for half day)
        });
        
        console.log('Created holiday request:', request);
        console.log('Request status:', request?.status);
        
        if (request && request.status !== 'pending') {
            console.warn('WARNING: Holiday request was created with status:', request.status, 'instead of pending');
        }
        
        res.json({ success: true, request });
    } catch (error) {
        console.error('Create holiday request error:', error);
        res.status(500).json({ success: false, error: 'Failed to create holiday request' });
    }
});

router.put('/holidays/requests/:id', requireProductionAuth, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { action, review_notes } = req.body;
        const user = req.session.production_user;
        
        const request = await ProductionDatabase.getHolidayRequestById(requestId);
        if (!request) {
            return res.status(404).json({ success: false, error: 'Holiday request not found' });
        }
        
        // Users can cancel their own pending or approved requests
        if (action === 'cancel') {
            if (request.status !== 'pending' && request.status !== 'approved') {
                return res.status(400).json({ success: false, error: 'Can only cancel pending or approved requests' });
            }
            
            if (user.role !== 'admin' && user.role !== 'office' && request.user_id !== user.id) {
                return res.status(403).json({ success: false, error: 'You can only cancel your own requests' });
            }
            
            // If cancelling an approved request, restore the days to entitlement
            if (request.status === 'approved') {
                // Delete associated timesheet entries first
                await ProductionDatabase.deleteTimesheetEntriesByHolidayRequest(requestId);
                
                const currentYear = new Date(request.start_date).getFullYear();
                // Recalculate days_used to ensure accuracy (includes all approved requests)
                await ProductionDatabase.recalculateHolidayDaysUsed(request.user_id, currentYear);
            }
            
            const updated = await ProductionDatabase.updateHolidayRequestStatus(requestId, 'cancelled', user.id, review_notes);
            res.json({ success: true, request: updated });
        } else if (action === 'approve' || action === 'reject') {
            // Only admins/office can approve/reject
            if (user.role !== 'admin' && user.role !== 'office') {
                return res.status(403).json({ success: false, error: 'Only admins can approve/reject requests' });
            }
            
            if (action === 'approve') {
                // Check entitlement again before approving
                const currentYear = new Date(request.start_date).getFullYear();
                
                // Recalculate days_used first to ensure we have accurate count (includes all currently approved holidays)
                await ProductionDatabase.recalculateHolidayDaysUsed(request.user_id, currentYear);
                const entitlement = await ProductionDatabase.getHolidayEntitlement(request.user_id, currentYear);
                const daysRemaining = parseFloat(entitlement.total_days || 0) - parseFloat(entitlement.days_used || 0);
                
                // Allow negative balances - shutdown periods can cause this
                // Just log a warning if going negative
                if (daysRemaining < parseFloat(request.days_requested)) {
                    console.log(`Warning: Approving request that will result in negative entitlement. User will have ${(daysRemaining - parseFloat(request.days_requested)).toFixed(1)} days remaining`);
                }
                
                // Update status first, then recalculate to include this new approved request
                const status = 'approved';
                const updated = await ProductionDatabase.updateHolidayRequestStatus(requestId, status, user.id, review_notes);
                
                // Recalculate days_used to include the newly approved request
                await ProductionDatabase.recalculateHolidayDaysUsed(request.user_id, currentYear);
                
                // Populate timesheet entries for approved holidays
                const start = new Date(request.start_date);
                const end = new Date(request.end_date);
                const current = new Date(start);
                
                while (current <= end) {
                    const dateStr = current.toISOString().split('T')[0];
                    await ProductionDatabase.populateHolidayTimesheetEntry(request.user_id, dateStr, requestId);
                    current.setDate(current.getDate() + 1);
                }
                
                res.json({ success: true, request: updated });
            } else {
                // Reject - just update status
                const status = 'rejected';
                const updated = await ProductionDatabase.updateHolidayRequestStatus(requestId, status, user.id, review_notes);
                res.json({ success: true, request: updated });
            }
        } else {
            return res.status(400).json({ success: false, error: 'Invalid action. Must be "cancel", "approve", or "reject"' });
        }
    } catch (error) {
        console.error('Update holiday request error:', error);
        res.status(500).json({ success: false, error: 'Failed to update holiday request' });
    }
});

router.put('/holidays/requests/:id/approve', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { review_notes } = req.body;
        const user = req.session.production_user;
        
        const request = await ProductionDatabase.getHolidayRequestById(requestId);
        if (!request) {
            return res.status(404).json({ success: false, error: 'Holiday request not found' });
        }
        
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Request is not pending' });
        }
        
        // Check entitlement
        const currentYear = new Date(request.start_date).getFullYear();
        
        // Recalculate days_used first to ensure we have accurate count (includes future approved holidays)
        await ProductionDatabase.recalculateHolidayDaysUsed(request.user_id, currentYear);
        const entitlement = await ProductionDatabase.getHolidayEntitlement(request.user_id, currentYear);
        const daysRemaining = parseFloat(entitlement.total_days || 0) - parseFloat(entitlement.days_used || 0);
        
        // Allow negative balances - shutdown periods can cause this
        // Just log a warning if going negative
        if (daysRemaining < parseFloat(request.days_requested)) {
            console.log(`Warning: Approving request that will result in negative entitlement. User will have ${(daysRemaining - parseFloat(request.days_requested)).toFixed(1)} days remaining`);
        }
        
        // Update status first, then recalculate to include this new approved request
        const updated = await ProductionDatabase.updateHolidayRequestStatus(requestId, 'approved', user.id, review_notes);
        
        // Recalculate days_used to include the newly approved request
        await ProductionDatabase.recalculateHolidayDaysUsed(request.user_id, currentYear);
        
        // Populate timesheet entries for approved holidays
        const start = new Date(request.start_date);
        const end = new Date(request.end_date);
        const current = new Date(start);
        
        while (current <= end) {
            const dateStr = current.toISOString().split('T')[0];
            await ProductionDatabase.populateHolidayTimesheetEntry(request.user_id, dateStr, requestId);
            current.setDate(current.getDate() + 1);
        }
        
        res.json({ success: true, request: updated });
    } catch (error) {
        console.error('Approve holiday request error:', error);
        res.status(500).json({ success: false, error: 'Failed to approve holiday request' });
    }
});

// Admin endpoint to add approved holiday for a user
router.post('/holidays/add', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { user_id, start_date, end_date, day_type, review_notes } = req.body;
        const adminUser = req.session.production_user;
        
        if (!user_id || !start_date || !end_date) {
            return res.status(400).json({ success: false, error: 'User ID, start date, and end date are required' });
        }
        
        // Validate day_type (default to 'full' if not provided for backward compatibility)
        const dayType = day_type || 'full';
        if (dayType !== 'half' && dayType !== 'full') {
            return res.status(400).json({ success: false, error: 'day_type must be either "half" or "full"' });
        }
        
        // For half day, start and end dates must be the same
        if (dayType === 'half' && start_date !== end_date) {
            return res.status(400).json({ success: false, error: 'For half day, start date and end date must be the same' });
        }
        
        // Calculate holiday days (Fri = 0.75, Mon-Thu = 1, half = 0.5 or 0.375 Fri)
        const weekdays = ProductionDatabase.calculateHolidayDaysRequested(start_date, end_date, dayType);
        if (weekdays <= 0) {
            return res.status(400).json({ success: false, error: 'Date range must include at least one weekday' });
        }
        
        // Check entitlement
        const currentYear = new Date(start_date).getFullYear();
        const userId = parseInt(user_id);
        const entitlement = await ProductionDatabase.getHolidayEntitlement(userId, currentYear);
        
        if (!entitlement) {
            return res.status(400).json({ 
                success: false, 
                error: `No holiday entitlement found for user for year ${currentYear}` 
            });
        }
        
        // Calculate days remaining (can be negative if shutdown periods have been applied)
        await ProductionDatabase.recalculateHolidayDaysUsed(userId, currentYear);
        const updatedEntitlement = await ProductionDatabase.getHolidayEntitlement(userId, currentYear);
        const daysRemaining = parseFloat(updatedEntitlement.total_days || 0) - parseFloat(updatedEntitlement.days_used || 0);
        
        // Allow negative balances - shutdown periods can cause this
        // Just log a warning if going negative
        if (daysRemaining < weekdays) {
            console.log(`Warning: Adding holiday that will result in negative entitlement. User will have ${(daysRemaining - weekdays).toFixed(1)} days remaining`);
        }
        
        // Create holiday request with status 'approved'
        const request = await ProductionDatabase.createHolidayRequest({
            user_id: userId,
            start_date,
            end_date,
            requested_by_user_id: adminUser.id,
            is_company_shutdown: false,
            status: 'approved',
            reviewed_by_user_id: adminUser.id,
            review_notes: review_notes || null,
            days_requested: weekdays // Override calculated weekdays with actual days (0.5 for half day)
        });
        
        // Recalculate days_used to include the newly created approved request
        await ProductionDatabase.recalculateHolidayDaysUsed(userId, currentYear);
        
        // Populate timesheet entries for approved holidays
        // For half day, only populate the single date
        const start = new Date(start_date);
        const end = new Date(end_date);
        const current = new Date(start);
        
        while (current <= end) {
            const dateStr = current.toISOString().split('T')[0];
            await ProductionDatabase.populateHolidayTimesheetEntry(userId, dateStr, request.id);
            current.setDate(current.getDate() + 1);
        }
        
        res.json({ success: true, request, message: 'Holiday added and approved successfully' });
    } catch (error) {
        console.error('Add holiday error:', error);
        res.status(500).json({ success: false, error: 'Failed to add holiday: ' + (error.message || 'Unknown error') });
    }
});

router.put('/holidays/requests/:id/reject', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { review_notes } = req.body;
        const user = req.session.production_user;
        
        const request = await ProductionDatabase.getHolidayRequestById(requestId);
        if (!request) {
            return res.status(404).json({ success: false, error: 'Holiday request not found' });
        }
        
        const updated = await ProductionDatabase.updateHolidayRequestStatus(requestId, 'rejected', user.id, review_notes);
        res.json({ success: true, request: updated });
    } catch (error) {
        console.error('Reject holiday request error:', error);
        res.status(500).json({ success: false, error: 'Failed to reject holiday request' });
    }
});

// Admin endpoint to delete a holiday request
router.delete('/holidays/requests/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        
        const request = await ProductionDatabase.getHolidayRequestById(requestId);
        if (!request) {
            return res.status(404).json({ success: false, error: 'Holiday request not found' });
        }
        
        // If the request was approved, we need to clean up timesheet entries and recalculate entitlement
        if (request.status === 'approved') {
            // Delete associated timesheet entries
            await ProductionDatabase.deleteTimesheetEntriesByHolidayRequest(requestId);
            
            // Recalculate entitlement to return the days
            const currentYear = new Date(request.start_date).getFullYear();
            await ProductionDatabase.recalculateHolidayDaysUsed(request.user_id, currentYear);
        }
        
        // Delete the holiday request
        const deleted = await ProductionDatabase.deleteHolidayRequest(requestId);
        
        res.json({ success: true, request: deleted, message: 'Holiday request deleted successfully' });
    } catch (error) {
        console.error('Delete holiday request error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete holiday request: ' + (error.message || 'Unknown error') });
    }
});

// Company Shutdown Routes
router.get('/holidays/shutdown-periods', requireProductionAuth, async (req, res) => {
    try {
        const year = req.query.year ? parseInt(req.query.year) : null;
        
        if (year) {
            const periods = await ProductionDatabase.getShutdownPeriodsByYear(year);
            res.json({ success: true, periods });
        } else {
            const periods = await ProductionDatabase.getActiveShutdownPeriods();
            res.json({ success: true, periods });
        }
    } catch (error) {
        console.error('Get shutdown periods error:', error);
        res.status(500).json({ success: false, error: 'Failed to get shutdown periods' });
    }
});

router.post('/holidays/shutdown-periods', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const { year, start_date, end_date, description } = req.body;
        
        if (!year || !start_date || !end_date) {
            return res.status(400).json({ success: false, error: 'Year, start date, and end date are required' });
        }
        
        console.log('Creating shutdown period:', { year, start_date, end_date, description, user_id: req.session.production_user.id });
        
        const period = await ProductionDatabase.createCompanyShutdownPeriod({
            year: parseInt(year),
            start_date,
            end_date,
            description: description || null,
            created_by_user_id: req.session.production_user.id
        });
        
        console.log('Created shutdown period:', period);
        
        if (!period) {
            console.error('createCompanyShutdownPeriod returned null/undefined');
            return res.status(500).json({ success: false, error: 'Failed to create shutdown period - database returned null' });
        }
        
        res.json({ success: true, period });
    } catch (error) {
        console.error('Create shutdown period error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ success: false, error: 'Failed to create shutdown period: ' + error.message });
    }
});

router.put('/holidays/shutdown-periods/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const periodId = parseInt(req.params.id);
        const { year, start_date, end_date, description, is_active } = req.body;
        
        if (!year || !start_date || !end_date) {
            return res.status(400).json({ success: false, error: 'Year, start date, and end date are required' });
        }
        
        const period = await ProductionDatabase.updateCompanyShutdownPeriod(periodId, {
            year: parseInt(year),
            start_date,
            end_date,
            description: description || null,
            is_active: is_active !== undefined ? is_active : true
        });
        
        if (!period) {
            return res.status(404).json({ success: false, error: 'Shutdown period not found' });
        }
        
        res.json({ success: true, period });
    } catch (error) {
        console.error('Update shutdown period error:', error);
        res.status(500).json({ success: false, error: 'Failed to update shutdown period: ' + error.message });
    }
});

router.delete('/holidays/shutdown-periods/:id', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const periodId = parseInt(req.params.id);
        
        const deleted = await ProductionDatabase.deleteCompanyShutdownPeriod(periodId);
        
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Shutdown period not found' });
        }
        
        res.json({ success: true, message: 'Shutdown period deleted successfully' });
    } catch (error) {
        console.error('Delete shutdown period error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete shutdown period: ' + error.message });
    }
});

router.post('/holidays/shutdown-periods/:id/apply', requireProductionAuth, requireAdminOrOffice, async (req, res) => {
    try {
        const periodId = parseInt(req.params.id);
        const period = await ProductionDatabase.getCompanyShutdownPeriodById(periodId);
        
        if (!period) {
            return res.status(404).json({ success: false, error: 'Shutdown period not found' });
        }
        
        // Apply shutdown to all user entitlements (now handles cross-year automatically)
        const result = await ProductionDatabase.applyShutdownToEntitlements(
            period.start_date,
            period.end_date
        );
        
        // Build message based on year breakdown
        const yearMessages = Object.entries(result.yearBreakdown)
            .map(([year, days]) => `${days} days from ${year}`)
            .join(', ');
        
        res.json({ 
            success: true, 
            message: `Shutdown applied. ${result.totalWeekdays} weekdays deducted from all user entitlements (${yearMessages}).`,
            breakdown: result.yearBreakdown
        });
    } catch (error) {
        console.error('Apply shutdown period error:', error);
        res.status(500).json({ success: false, error: 'Failed to apply shutdown period: ' + error.message });
    }
});

// ============ BACKUP AND RESTORE ROUTES (Admin only) ============

const backupService = new BackupService();

// Create a new backup
router.post('/backups/create', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        console.log('📦 Backup creation requested by:', req.session.production_user.username);
        const backup = await backupService.createBackup();
        res.json({ success: true, backup });
    } catch (error) {
        console.error('Create backup error:', error);
        res.status(500).json({ success: false, error: 'Failed to create backup: ' + error.message });
    }
});

// List all backups
router.get('/backups', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const backups = await backupService.listBackups();
        res.json({ success: true, backups });
    } catch (error) {
        console.error('List backups error:', error);
        res.status(500).json({ success: false, error: 'Failed to list backups: ' + error.message });
    }
});

// Download backup file
router.get('/backups/:id/download', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const backupId = req.params.id;
        const backupPath = backupService.getBackupPath(backupId);
        
        // Check if file exists
        if (!require('fs').existsSync(backupPath)) {
            return res.status(404).json({ success: false, error: 'Backup file not found' });
        }
        
        const fileName = backupId.endsWith('.tar.gz') ? backupId : `${backupId}.tar.gz`;
        res.download(backupPath, fileName, (err) => {
            if (err) {
                console.error('Download error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: 'Failed to download backup' });
                }
            }
        });
    } catch (error) {
        console.error('Download backup error:', error);
        res.status(500).json({ success: false, error: 'Failed to download backup: ' + error.message });
    }
});

// Restore from backup
router.post('/backups/:id/restore', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const backupId = req.params.id;
        const { confirm } = req.body;
        
        if (!confirm) {
            return res.status(400).json({ 
                success: false, 
                error: 'Restore confirmation required. Set confirm: true in request body.' 
            });
        }
        
        console.log('🔄 Restore requested by:', req.session.production_user.username, 'for backup:', backupId);
        
        const result = await backupService.restoreBackup(backupId);
        
        res.json({ 
            success: true, 
            message: 'Backup restored successfully. A safety backup was created before restore.',
            result 
        });
    } catch (error) {
        console.error('Restore backup error:', error);
        res.status(500).json({ success: false, error: 'Failed to restore backup: ' + error.message });
    }
});

// Delete backup
router.delete('/backups/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const backupId = req.params.id;
        await backupService.deleteBackup(backupId);
        res.json({ success: true, message: 'Backup deleted successfully' });
    } catch (error) {
        console.error('Delete backup error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete backup: ' + error.message });
    }
});

// Get backup schedule configuration
router.get('/backups/schedule', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { getScheduler } = require('./backup-scheduler');
        const scheduler = getScheduler();
        const schedule = scheduler.getSchedule();
        
        res.json({ 
            success: true, 
            schedule
        });
    } catch (error) {
        console.error('Get backup schedule error:', error);
        res.status(500).json({ success: false, error: 'Failed to get backup schedule' });
    }
});

// Set backup schedule configuration
router.post('/backups/schedule', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { enabled, frequency, time, day_of_week } = req.body;
        
        const { getScheduler } = require('./backup-scheduler');
        const scheduler = getScheduler();
        
        scheduler.updateSchedule({
            enabled: enabled || false,
            frequency: frequency || 'daily',
            time: time || '02:00',
            day_of_week: day_of_week || 0
        });
        
        res.json({ 
            success: true, 
            message: 'Backup schedule updated',
            schedule: scheduler.getSchedule()
        });
    } catch (error) {
        console.error('Set backup schedule error:', error);
        res.status(500).json({ success: false, error: 'Failed to set backup schedule' });
    }
});

module.exports = router;

