// Main routes for Box Control Dashboard
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, isAuthenticated } = require('../middleware/auth');

// Helper function to calculate RAG status
function getRAGStatus(value, thresholds) {
    if (value < thresholds.red) return 'red';
    if (value >= thresholds.red && value < thresholds.green) return 'amber';
    return 'green';
}

// Helper function to get contribution RAG
function getContributionRAG(contribution, survival, target) {
    if (contribution < survival) return 'red';
    if (contribution >= survival && contribution < target) return 'amber';
    return 'green';
}

// Dashboard route
router.get('/dashboard', requireAuth, async (req, res) => {
    res.locals.currentPage = 'dashboard';
    res.locals.title = 'Dashboard';
    try {
        // Initialize schema if needed
        await db.initializeSchema();

        // Get settings
        const settings = await db.getSettings();

        // Get MTD data
        const salesMTD = await db.getSalesMTD();
        const productionMTD = await db.getProductionMTD();

        // Get last 4 weeks data
        const salesLast4Weeks = await db.getSalesLast4Weeks();
        const productionLast4Weeks = await db.getProductionLast4Weeks();

        // Calculate metrics
        const contributionMTD = salesMTD.boxes_sold * parseFloat(settings.contribution_per_box);

        // Install % (last 4 weeks weighted)
        const totalBoxes4Weeks = salesLast4Weeks.reduce((sum, w) => sum + (w.boxes_sold || 0), 0);
        const totalInstalls4Weeks = salesLast4Weeks.reduce((sum, w) => sum + (w.installs_sold || 0), 0);
        const installPct = totalBoxes4Weeks > 0 ? totalInstalls4Weeks / totalBoxes4Weeks : 0;

        // Extras % (last 4 weeks weighted)
        const totalBoxRevenue4Weeks = salesLast4Weeks.reduce((sum, w) => sum + parseFloat(w.box_revenue || 0), 0);
        const totalExtrasRevenue4Weeks = salesLast4Weeks.reduce((sum, w) => sum + parseFloat(w.extras_revenue || 0), 0);
        const extrasPct = totalBoxRevenue4Weeks > 0 ? totalExtrasRevenue4Weeks / totalBoxRevenue4Weeks : 0;

        // Contribution per box (MTD)
        const contributionPerBox = salesMTD.boxes_sold > 0 
            ? contributionMTD / salesMTD.boxes_sold 
            : 0;

        // Cost compliance (last 4 weeks)
        const totalBoxesProduced4Weeks = productionLast4Weeks.reduce((sum, w) => sum + (w.boxes_produced || 0), 0);
        const totalBoxesOverCost4Weeks = productionLast4Weeks.reduce((sum, w) => sum + (w.boxes_over_cost || 0), 0);
        const costCompliancePct = totalBoxesProduced4Weeks > 0
            ? (totalBoxesProduced4Weeks - totalBoxesOverCost4Weeks) / totalBoxesProduced4Weeks
            : 0;

        // Rework per box (last 4 weeks)
        const totalReworkHours4Weeks = productionLast4Weeks.reduce((sum, w) => sum + parseFloat(w.rework_hours || 0), 0);
        const reworkPerBox = totalBoxesProduced4Weeks > 0
            ? totalReworkHours4Weeks / totalBoxesProduced4Weeks
            : 0;

        // Average boxes per week (production last 4 weeks)
        const avgBoxesPerWeek = productionLast4Weeks.length > 0
            ? totalBoxesProduced4Weeks / productionLast4Weeks.length
            : 0;

        // Forward look
        const forwardLook = await db.getForwardLook();

        // Calculate RAG statuses
        const contributionRAG = getContributionRAG(
            contributionMTD,
            parseFloat(settings.survival_contribution),
            parseFloat(settings.monthly_contribution_target)
        );

        const installRAG = installPct < parseFloat(settings.target_install_pct) ? 'red' : 'green';
        const extrasRAG = extrasPct < parseFloat(settings.target_extras_pct) ? 'red' : 'green';
        const contributionPerBoxRAG = getRAGStatus(contributionPerBox, { red: 600, green: 640 });
        const costComplianceRAG = costCompliancePct < parseFloat(settings.cost_compliance_target) ? 'red' : 'green';
        const reworkRAG = getRAGStatus(reworkPerBox, { red: 0.5, green: 0.25 });

        const { isAuthenticated: checkAuth } = require('../middleware/auth');
        res.render('dashboard', {
            settings,
            salesMTD,
            productionMTD,
            contributionMTD,
            contributionRAG,
            installPct: installPct * 100,
            installRAG,
            extrasPct: extrasPct * 100,
            extrasRAG,
            contributionPerBox,
            contributionPerBoxRAG,
            costCompliancePct: costCompliancePct * 100,
            costComplianceRAG,
            reworkPerBox,
            reworkRAG,
            avgBoxesPerWeek,
            forwardLook,
            isAuthenticated: checkAuth(req)
        });
    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.status(500).render('error', { 
            message: 'Error loading dashboard',
            error: process.env.NODE_ENV === 'development' ? error : null
        });
    }
});

// Settings update API
router.post('/api/settings', requireAuth, async (req, res) => {
    try {
        const updates = req.body;
        
        // Validate numeric fields
        const numericFields = [
            'monthly_contribution_target',
            'survival_contribution',
            'target_boxes_per_month',
            'target_boxes_per_week',
            'target_install_pct',
            'target_extras_pct',
            'contribution_per_box',
            'cost_compliance_target',
            'right_first_time_target'
        ];

        for (const field of numericFields) {
            if (updates[field] !== undefined) {
                const value = parseFloat(updates[field]);
                if (isNaN(value) || value < 0) {
                    return res.status(400).json({ 
                        error: `Invalid value for ${field}` 
                    });
                }
                updates[field] = value;
            }
        }

        const updated = await db.updateSettings(updates);
        res.json({ success: true, settings: updated });
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({ error: 'Error updating settings' });
    }
});

// Root redirect to dashboard
router.get('/', (req, res) => {
    res.redirect('/dashboard');
});

module.exports = router;


