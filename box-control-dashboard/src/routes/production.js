// Production routes for Box Control Dashboard
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Get production form (with optional edit mode)
router.get('/production', requireAuth, async (req, res) => {
    res.locals.currentPage = 'production';
    res.locals.title = 'Production';
    try {
        await db.initializeSchema();
        
        const weekCommencing = req.query.week_commencing || null;
        let existingData = null;

        if (weekCommencing) {
            existingData = await db.getProductionWeekly(weekCommencing);
        }

        // Get all production weeks for reference
        const allWeeks = await db.getProductionWeekly();

        res.render('production', {
            existingData,
            allWeeks: allWeeks.slice(0, 10), // Show last 10 weeks
            weekCommencing
        });
    } catch (error) {
        console.error('Error loading production form:', error);
        res.status(500).render('error', { 
            message: 'Error loading production form',
            error: process.env.NODE_ENV === 'development' ? error : null
        });
    }
});

// Post production data
router.post('/production', requireAuth, async (req, res) => {
    try {
        await db.initializeSchema();

        const {
            week_commencing,
            boxes_produced,
            installs_completed,
            boxes_over_cost,
            rework_hours,
            right_first_time_pct,
            notes
        } = req.body;

        // Validation
        if (!week_commencing) {
            return res.status(400).render('production', {
                error: 'Week commencing date is required',
                existingData: req.body,
                allWeeks: await db.getProductionWeekly()
            });
        }

        // Validate integers
        const boxesProduced = parseInt(boxes_produced, 10);
        const installsCompleted = parseInt(installs_completed, 10);
        const boxesOverCost = parseInt(boxes_over_cost, 10) || 0;

        if (isNaN(boxesProduced) || boxesProduced < 0) {
            return res.status(400).render('production', {
                error: 'Boxes produced must be a non-negative integer',
                existingData: req.body,
                allWeeks: await db.getProductionWeekly()
            });
        }

        if (isNaN(installsCompleted) || installsCompleted < 0) {
            return res.status(400).render('production', {
                error: 'Installs completed must be a non-negative integer',
                existingData: req.body,
                allWeeks: await db.getProductionWeekly()
            });
        }

        if (isNaN(boxesOverCost) || boxesOverCost < 0) {
            return res.status(400).render('production', {
                error: 'Boxes over cost must be a non-negative integer',
                existingData: req.body,
                allWeeks: await db.getProductionWeekly()
            });
        }

        // Parse numeric fields
        const reworkHours = parseFloat(rework_hours) || 0;
        const rightFirstTime = right_first_time_pct ? parseFloat(right_first_time_pct) : null;

        if (reworkHours < 0) {
            return res.status(400).render('production', {
                error: 'Rework hours must be non-negative',
                existingData: req.body,
                allWeeks: await db.getProductionWeekly()
            });
        }

        const data = {
            week_commencing,
            boxes_produced: boxesProduced,
            installs_completed: installsCompleted,
            boxes_over_cost: boxesOverCost,
            rework_hours: reworkHours,
            right_first_time_pct: rightFirstTime,
            notes: notes || null
        };

        await db.upsertProductionWeekly(data);

        res.redirect('/production?week_commencing=' + encodeURIComponent(week_commencing));
    } catch (error) {
        console.error('Error saving production data:', error);
        res.status(500).render('production', {
            error: 'Error saving production data: ' + error.message,
            existingData: req.body,
            allWeeks: await db.getProductionWeekly()
        });
    }
});

module.exports = router;

