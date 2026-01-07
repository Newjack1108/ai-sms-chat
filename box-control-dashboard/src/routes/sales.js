// Sales routes for Box Control Dashboard
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Get sales form (with optional edit mode)
router.get('/sales', requireAuth, async (req, res) => {
    res.locals.currentPage = 'sales';
    res.locals.title = 'Sales';
    try {
        await db.initializeSchema();
        
        const weekCommencing = req.query.week_commencing || null;
        const warning = req.query.warning || null;
        let existingData = null;

        if (weekCommencing) {
            existingData = await db.getSalesWeekly(weekCommencing);
        }

        // Get all sales weeks for reference
        const allWeeks = await db.getSalesWeekly();

        res.render('sales', {
            existingData,
            allWeeks: allWeeks.slice(0, 10), // Show last 10 weeks
            weekCommencing,
            warning
        });
    } catch (error) {
        console.error('Error loading sales form:', error);
        res.status(500).render('error', { 
            message: 'Error loading sales form',
            error: process.env.NODE_ENV === 'development' ? error : null
        });
    }
});

// Post sales data
router.post('/sales', requireAuth, async (req, res) => {
    try {
        await db.initializeSchema();

        const {
            week_commencing,
            boxes_sold,
            installs_sold,
            box_revenue,
            extras_revenue,
            install_revenue,
            notes
        } = req.body;

        // Validation
        if (!week_commencing) {
            return res.status(400).render('sales', {
                error: 'Week commencing date is required',
                existingData: req.body,
                allWeeks: await db.getSalesWeekly()
            });
        }

        // Validate integers
        const boxesSold = parseInt(boxes_sold, 10);
        const installsSold = parseInt(installs_sold, 10);

        if (isNaN(boxesSold) || boxesSold < 0) {
            return res.status(400).render('sales', {
                error: 'Boxes sold must be a non-negative integer',
                existingData: req.body,
                allWeeks: await db.getSalesWeekly()
            });
        }

        if (isNaN(installsSold) || installsSold < 0) {
            return res.status(400).render('sales', {
                error: 'Installs sold must be a non-negative integer',
                existingData: req.body,
                allWeeks: await db.getSalesWeekly()
            });
        }

        // Warn if installs > boxes but allow
        let warning = null;
        if (installsSold > boxesSold) {
            warning = 'Warning: Installs sold exceeds boxes sold. This is allowed but may indicate a data entry error.';
        }

        // Parse revenue fields (allow decimals)
        const boxRev = parseFloat(box_revenue) || 0;
        const extrasRev = parseFloat(extras_revenue) || 0;
        const installRev = parseFloat(install_revenue) || 0;

        const data = {
            week_commencing,
            boxes_sold: boxesSold,
            installs_sold: installsSold,
            box_revenue: boxRev,
            extras_revenue: extrasRev,
            install_revenue: installRev,
            notes: notes || null
        };

        await db.upsertSalesWeekly(data);

        res.redirect('/sales?week_commencing=' + encodeURIComponent(week_commencing) + (warning ? '&warning=' + encodeURIComponent(warning) : ''));
    } catch (error) {
        console.error('Error saving sales data:', error);
        res.status(500).render('sales', {
            error: 'Error saving sales data: ' + error.message,
            existingData: req.body,
            allWeeks: await db.getSalesWeekly()
        });
    }
});

module.exports = router;

