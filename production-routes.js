// Production API Routes
const express = require('express');
const router = express.Router();
const { ProductionDatabase } = require('./production-database');
const { requireProductionAuth, requireAdmin, requireManager, hashPassword } = require('./production-auth');

// ============ AUTHENTICATION ROUTES ============

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const { loginProductionUser } = require('./production-auth');
        const result = await loginProductionUser(username, password);
        
        if (result.success) {
            req.session.production_authenticated = true;
            req.session.production_user = result.user;
            res.json({ success: true, user: result.user });
        } else {
            res.status(401).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

router.post('/logout', (req, res) => {
    req.session.production_authenticated = false;
    req.session.production_user = null;
    res.json({ success: true });
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
        
        if (!['admin', 'manager', 'staff'].includes(role)) {
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
        
        if (role && !['admin', 'manager', 'staff'].includes(role)) {
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

router.post('/stock', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, unit, current_quantity, min_quantity, location, cost_per_unit_gbp } = req.body;
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
            cost_per_unit_gbp: parseFloat(cost_per_unit_gbp) || 0
        });
        res.json({ success: true, item });
    } catch (error) {
        console.error('Create stock item error:', error);
        res.status(500).json({ success: false, error: 'Failed to create stock item' });
    }
});

router.put('/stock/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        const { name, description, unit, min_quantity, location, cost_per_unit_gbp } = req.body;
        
        const item = await ProductionDatabase.updateStockItem(itemId, {
            name,
            description,
            unit,
            min_quantity: parseFloat(min_quantity) || 0,
            location,
            cost_per_unit_gbp: parseFloat(cost_per_unit_gbp) || 0
        });
        res.json({ success: true, item });
    } catch (error) {
        console.error('Update stock item error:', error);
        res.status(500).json({ success: false, error: 'Failed to update stock item' });
    }
});

router.delete('/stock/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.post('/panels', requireProductionAuth, requireAdmin, async (req, res) => {
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
        res.status(500).json({ success: false, error: 'Failed to create panel' });
    }
});

router.put('/panels/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.delete('/panels/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        await ProductionDatabase.deletePanel(panelId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete panel error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete panel' });
    }
});

router.get('/panels/:id/bom', requireProductionAuth, async (req, res) => {
    try {
        const panelId = parseInt(req.params.id);
        const bom = await ProductionDatabase.getPanelBOM(panelId);
        res.json({ success: true, bom });
    } catch (error) {
        console.error('Get panel BOM error:', error);
        res.status(500).json({ success: false, error: 'Failed to get panel BOM' });
    }
});

router.post('/panels/:id/bom', requireProductionAuth, requireAdmin, async (req, res) => {
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
        res.status(500).json({ success: false, error: 'Failed to add BOM item' });
    }
});

router.delete('/panels/:id/bom/:bomId', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.post('/components', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.put('/components/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.delete('/components/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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
        res.json({ success: true, bom });
    } catch (error) {
        console.error('Get component BOM error:', error);
        res.status(500).json({ success: false, error: 'Failed to get component BOM' });
    }
});

router.post('/components/:id/bom', requireProductionAuth, requireAdmin, async (req, res) => {
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
        res.status(500).json({ success: false, error: 'Failed to add component BOM item' });
    }
});

router.delete('/components/:id/bom/:bomId', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.post('/products', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, product_type, status } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        
        // Cost is calculated automatically from components (panels + materials)
        const product = await ProductionDatabase.createProduct({
            name,
            description,
            product_type,
            status
        });
        res.json({ success: true, product });
    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({ success: false, error: 'Failed to create product' });
    }
});

router.put('/products/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const { name, description, product_type, status } = req.body;
        
        // Cost is calculated automatically from components
        const product = await ProductionDatabase.updateProduct(productId, {
            name,
            description,
            product_type,
            status
        });
        res.json({ success: true, product });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ success: false, error: 'Failed to update product' });
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

router.post('/products/:id/components', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.delete('/products/:id/components/:compId', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const compId = parseInt(req.params.compId);
        await ProductionDatabase.deleteProductComponent(compId);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete product component error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete product component' });
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
            orderList = [{ product_id: order.product_id, quantity: order.quantity }];
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
        
        const orders = [{ product_id: order.product_id, quantity: order.quantity }];
        const requirements = await ProductionDatabase.calculateMaterialRequirements(orders);
        res.json({ success: true, requirements });
    } catch (error) {
        console.error('Get order requirements error:', error);
        res.status(500).json({ success: false, error: 'Failed to get order requirements' });
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
        const { product_id, quantity, order_date, status } = req.body;
        if (!product_id || !quantity) {
            return res.status(400).json({ success: false, error: 'Product ID and quantity are required' });
        }
        
        // Ensure we don't create quotes through the orders endpoint
        const orderStatus = status && status !== 'quote' ? status : 'pending';
        
        const order = await ProductionDatabase.createProductOrder({
            product_id: parseInt(product_id),
            quantity: parseInt(quantity),
            order_date,
            status: orderStatus,
            created_by: req.session.production_user.id
        });
        res.json({ success: true, order });
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ success: false, error: 'Failed to create order' });
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
        const { product_id, quantity, order_date, status } = req.body;
        
        const updateData = {};
        if (product_id !== undefined) updateData.product_id = parseInt(product_id);
        if (quantity !== undefined) updateData.quantity = parseInt(quantity);
        if (order_date !== undefined) updateData.order_date = order_date;
        if (status !== undefined) updateData.status = status;
        
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
        res.status(500).json({ success: false, error: 'Failed to delete order' });
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
        
        const entry = await ProductionDatabase.clockIn(userId, parseInt(job_id), latitude, longitude);
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
router.get('/timesheet/active', requireProductionAuth, requireManager, async (req, res) => {
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

router.get('/timesheet/notices/all', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const notices = await ProductionDatabase.getAllTimesheetNotices();
        res.json({ success: true, notices });
    } catch (error) {
        console.error('Get all notices error:', error);
        res.status(500).json({ success: false, error: 'Failed to get notices' });
    }
});

router.post('/timesheet/notices', requireProductionAuth, requireManager, async (req, res) => {
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

router.put('/timesheet/notices/:id', requireProductionAuth, requireManager, async (req, res) => {
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

router.delete('/timesheet/notices/:id', requireProductionAuth, requireManager, async (req, res) => {
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
        
        const entry = await ProductionDatabase.clockIn(userId, job_id, latitude, longitude);
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

router.get('/clock/status', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const status = await ProductionDatabase.getCurrentClockStatus(userId);
        res.json({ success: true, status });
    } catch (error) {
        console.error('Get clock status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get clock status' });
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
            const dailyEntries = await ProductionDatabase.getDailyEntriesForWeek(created.id);
            return res.json({ success: true, weeklyTimesheet: created, dailyEntries });
        }
        
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
            const dailyEntries = await ProductionDatabase.getDailyEntriesForWeek(created.id);
            
            // Also get all timesheet entries for this week
            const timesheetEntries = await ProductionDatabase.getTimesheetHistory(userId, weekStartDate, weekEndStr);
            
            return res.json({ success: true, weeklyTimesheet: created, dailyEntries, timesheetEntries });
        }
        
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
        const { daily_notes, overnight_away } = req.body;
        
        const weeklyTimesheet = await ProductionDatabase.getOrCreateWeeklyTimesheet(userId, weekStartDate);
        const dailyEntry = await ProductionDatabase.getOrCreateDailyEntry(weeklyTimesheet.id, entryDate);
        
        const updateData = {};
        if (daily_notes !== undefined) updateData.daily_notes = daily_notes;
        if (overnight_away !== undefined) updateData.overnight_away = overnight_away;
        
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
            
            // Update daily entry with aggregated hours
            await ProductionDatabase.updateDailyEntry(dailyEntry.id, {
                regular_hours: aggregatedHours.regular_hours,
                overtime_hours: aggregatedHours.overtime_hours,
                weekend_hours: aggregatedHours.weekend_hours,
                overnight_hours: aggregatedHours.overnight_hours,
                total_hours: aggregatedHours.total_hours
            });
        }
        
        res.json({ success: true, dailyEntry: updated });
    } catch (error) {
        console.error('Update daily entry error:', error);
        res.status(500).json({ success: false, error: 'Failed to update daily entry' });
    }
});

// Missing times route (for days they forgot to clock in)
router.post('/clock/missing-times', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { job_id, clock_in_time, clock_out_time, reason } = req.body;
        
        if (!job_id || !clock_in_time || !clock_out_time || !reason) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        // Check if within allowed time window (up to 10 days back)
        const today = new Date();
        const tenDaysAgo = new Date(today);
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        tenDaysAgo.setHours(0, 0, 0, 0);
        
        const entryDate = new Date(clock_in_time);
        entryDate.setHours(0, 0, 0, 0);
        
        if (entryDate < tenDaysAgo) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing times can only be added for dates up to 10 days back. Please contact a manager for older entries.' 
            });
        }
        
        // Check if user already has a completed entry for this date
        const dateStr = entryDate.toISOString().split('T')[0];
        const completedEntriesCount = await ProductionDatabase.countEntriesForDate(userId, dateStr);
        
        if (completedEntriesCount >= 1) {
            return res.status(400).json({ 
                success: false, 
                error: 'You already have a clock in/out entry for this date. Only one entry per day is allowed. Please use "Edit Times" to amend it.' 
            });
        }
        
        // Check for duplicate or overlapping times
        const duplicates = await ProductionDatabase.checkDuplicateTimes(userId, clock_in_time, clock_out_time);
        if (duplicates && duplicates.length > 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'A timesheet entry with overlapping or duplicate times already exists for this period. Please use "Edit Times" to amend the existing entry.' 
            });
        }
        
        const result = await ProductionDatabase.createMissingTimesheetEntry(
            userId,
            job_id,
            clock_in_time,
            clock_out_time,
            reason
        );
        
        res.json({ success: true, entry: result.entry, amendment: result.amendment });
    } catch (error) {
        console.error('Create missing times error:', error);
        res.status(500).json({ success: false, error: 'Failed to create missing times entry' });
    }
});

// Time amendment routes
router.post('/clock/amendments', requireProductionAuth, async (req, res) => {
    try {
        const userId = req.session.production_user.id;
        const { entry_id, amended_clock_in_time, amended_clock_out_time, reason } = req.body;
        
        if (!entry_id || !amended_clock_in_time || !reason) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
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
        
        // Calculate the cutoff date (10 days back from today)
        const today = new Date();
        const tenDaysAgo = new Date(today);
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        tenDaysAgo.setHours(0, 0, 0, 0);
        
        const entryDate = new Date(entry.clock_in_time);
        entryDate.setHours(0, 0, 0, 0);
        
        if (entryDate < tenDaysAgo) {
            return res.status(400).json({ 
                success: false, 
                error: 'Amendments are only allowed for entries up to 10 days back. Please contact a manager for older entries.' 
            });
        }
        
        // Check for duplicate or overlapping times (excluding the current entry being amended)
        if (amended_clock_out_time) {
            const duplicates = await ProductionDatabase.checkDuplicateTimes(
                userId, 
                amended_clock_in_time, 
                amended_clock_out_time, 
                entry_id // Exclude the current entry
            );
            if (duplicates && duplicates.length > 0) {
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
router.delete('/clock/entries/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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
router.get('/clock/payroll/:weekStart', requireProductionAuth, requireManager, async (req, res) => {
    try {
        const weekStartDate = req.params.weekStart;
        const summary = await ProductionDatabase.getPayrollSummary(weekStartDate);
        res.json({ success: true, summary });
    } catch (error) {
        console.error('Get payroll summary error:', error);
        res.status(500).json({ success: false, error: 'Failed to get payroll summary' });
    }
});

router.get('/clock/payroll/:weekStart/user/:userId/daily', requireProductionAuth, requireManager, async (req, res) => {
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

router.get('/clock/payroll/:weekStart/export', requireProductionAuth, requireManager, async (req, res) => {
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
        const reminders = await ProductionDatabase.getAllReminders();
        res.json({ success: true, reminders });
    } catch (error) {
        console.error('Get reminders error:', error);
        res.status(500).json({ success: false, error: 'Failed to get reminders' });
    }
});

router.get('/reminders/overdue', requireProductionAuth, async (req, res) => {
    try {
        const reminders = await ProductionDatabase.getOverdueReminders();
        res.json({ success: true, reminders });
    } catch (error) {
        console.error('Get overdue reminders error:', error);
        res.status(500).json({ success: false, error: 'Failed to get overdue reminders' });
    }
});

router.post('/reminders', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { stock_item_id, check_frequency_days, last_checked_date, next_check_date, is_active } = req.body;
        if (!stock_item_id || !check_frequency_days) {
            return res.status(400).json({ success: false, error: 'Stock item ID and frequency are required' });
        }
        
        const reminder = await ProductionDatabase.createReminder({
            stock_item_id: parseInt(stock_item_id),
            check_frequency_days: parseInt(check_frequency_days),
            last_checked_date,
            next_check_date,
            is_active
        });
        res.json({ success: true, reminder });
    } catch (error) {
        console.error('Create reminder error:', error);
        res.status(500).json({ success: false, error: 'Failed to create reminder' });
    }
});

router.put('/reminders/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const reminderId = parseInt(req.params.id);
        const { check_frequency_days, is_active } = req.body;
        
        const reminder = await ProductionDatabase.updateReminder(reminderId, {
            check_frequency_days: parseInt(check_frequency_days),
            is_active
        });
        res.json({ success: true, reminder });
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

router.delete('/reminders/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.delete('/planner/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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

router.post('/tasks', requireProductionAuth, requireManager, async (req, res) => {
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

router.put('/tasks/:id', requireProductionAuth, requireManager, async (req, res) => {
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

router.delete('/tasks/:id', requireProductionAuth, requireAdmin, async (req, res) => {
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

module.exports = router;

