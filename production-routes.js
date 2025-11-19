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
        
        if (!['admin', 'manager'].includes(role)) {
            return res.status(400).json({ success: false, error: 'Invalid role' });
        }
        
        const passwordHash = await hashPassword(password);
        const user = await ProductionDatabase.createUser(username, passwordHash, role);
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) {
        console.error('Create user error:', error);
        if (error.message && error.message.includes('UNIQUE')) {
            res.status(400).json({ success: false, error: 'Username already exists' });
        } else {
            res.status(500).json({ success: false, error: 'Failed to create user' });
        }
    }
});

router.put('/users/:id', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const { username, role, password } = req.body;
        const userId = parseInt(req.params.id);
        
        if (role && !['admin', 'manager'].includes(role)) {
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
        const { name, description, panel_type, status, cost_gbp } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        
        const panel = await ProductionDatabase.createPanel({
            name,
            description,
            panel_type,
            status,
            cost_gbp: parseFloat(cost_gbp) || 0
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
        const { name, description, panel_type, status, cost_gbp } = req.body;
        
        const panel = await ProductionDatabase.updatePanel(panelId, {
            name,
            description,
            panel_type,
            status,
            cost_gbp: parseFloat(cost_gbp) || 0
        });
        res.json({ success: true, panel });
    } catch (error) {
        console.error('Update panel error:', error);
        res.status(500).json({ success: false, error: 'Failed to update panel' });
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
        const { stock_item_id, quantity_required, unit } = req.body;
        
        if (!stock_item_id || !quantity_required || !unit) {
            return res.status(400).json({ success: false, error: 'Stock item, quantity, and unit are required' });
        }
        
        const bomItem = await ProductionDatabase.addBOMItem(
            panelId,
            parseInt(stock_item_id),
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
        const { name, description, product_type, status, cost_gbp } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }
        
        const product = await ProductionDatabase.createProduct({
            name,
            description,
            product_type,
            status,
            cost_gbp: parseFloat(cost_gbp) || 0
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
        const { name, description, product_type, status, cost_gbp } = req.body;
        
        const product = await ProductionDatabase.updateProduct(productId, {
            name,
            description,
            product_type,
            status,
            cost_gbp: parseFloat(cost_gbp) || 0
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

router.post('/products/:id/components', requireProductionAuth, requireAdmin, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const { component_type, component_id, quantity_required, unit } = req.body;
        
        if (!component_type || !component_id || !quantity_required || !unit) {
            return res.status(400).json({ success: false, error: 'All component fields are required' });
        }
        
        if (!['panel', 'raw_material'].includes(component_type)) {
            return res.status(400).json({ success: false, error: 'Invalid component type' });
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

// ============ PRODUCT ORDERS ROUTES ============

router.get('/orders', requireProductionAuth, async (req, res) => {
    try {
        const orders = await ProductionDatabase.getAllProductOrders();
        res.json({ success: true, orders });
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
        
        const order = await ProductionDatabase.createProductOrder({
            product_id: parseInt(product_id),
            quantity: parseInt(quantity),
            order_date,
            status,
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
        const { status } = req.body;
        
        const order = await ProductionDatabase.updateProductOrder(orderId, { status });
        res.json({ success: true, order });
    } catch (error) {
        console.error('Update order error:', error);
        res.status(500).json({ success: false, error: 'Failed to update order' });
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

