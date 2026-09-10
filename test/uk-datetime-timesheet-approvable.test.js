/**
 * Timesheet approval unlocks from Saturday (London) of the week.
 * Run: node --test test/uk-datetime-timesheet-approvable.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    isTimesheetWeekApprovable,
    latestApprovableTimesheetWeekStart
} = require('../uk-datetime');

// Week starting Monday 2026-09-07 (Mon–Sun). Saturday = 2026-09-12.
const WEEK_START = '2026-09-07';

describe('isTimesheetWeekApprovable', () => {
    it('blocks Friday of the same week', () => {
        assert.equal(
            isTimesheetWeekApprovable(WEEK_START, new Date('2026-09-11T12:00:00+01:00')),
            false
        );
    });

    it('allows Saturday of the same week', () => {
        assert.equal(
            isTimesheetWeekApprovable(WEEK_START, new Date('2026-09-12T00:30:00+01:00')),
            true
        );
    });

    it('allows Sunday of the same week', () => {
        assert.equal(
            isTimesheetWeekApprovable(WEEK_START, new Date('2026-09-13T15:00:00+01:00')),
            true
        );
    });

    it('allows the following Monday', () => {
        assert.equal(
            isTimesheetWeekApprovable(WEEK_START, new Date('2026-09-14T09:00:00+01:00')),
            true
        );
    });

    it('blocks an empty week start', () => {
        assert.equal(isTimesheetWeekApprovable('', new Date()), false);
    });
});

describe('latestApprovableTimesheetWeekStart', () => {
    it('on Friday returns previous Monday', () => {
        assert.equal(
            latestApprovableTimesheetWeekStart(new Date('2026-09-11T12:00:00+01:00')),
            '2026-08-31'
        );
    });

    it('on Saturday returns this week Monday', () => {
        assert.equal(
            latestApprovableTimesheetWeekStart(new Date('2026-09-12T10:00:00+01:00')),
            '2026-09-07'
        );
    });

    it('on Sunday returns this week Monday', () => {
        assert.equal(
            latestApprovableTimesheetWeekStart(new Date('2026-09-13T10:00:00+01:00')),
            '2026-09-07'
        );
    });
});
