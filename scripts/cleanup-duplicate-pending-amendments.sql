-- One-time cleanup: duplicate pending timesheet amendments (same timesheet_entry_id).
-- Backup the database before running. After cleanup, verify:
--   SELECT timesheet_entry_id, COUNT(*) FROM timesheet_amendments
--   WHERE status = 'pending' GROUP BY timesheet_entry_id HAVING COUNT(*) > 1;
-- should return no rows.

-- ========== PostgreSQL ==========
-- DELETE FROM timesheet_amendments ta
-- USING (
--   SELECT timesheet_entry_id, MIN(id) AS keep_id
--   FROM timesheet_amendments
--   WHERE status = 'pending'
--   GROUP BY timesheet_entry_id
--   HAVING COUNT(*) > 1
-- ) d
-- WHERE ta.timesheet_entry_id = d.timesheet_entry_id
--   AND ta.status = 'pending'
--   AND ta.id <> d.keep_id;

-- CREATE UNIQUE INDEX IF NOT EXISTS idx_amendments_one_pending_per_entry
-- ON timesheet_amendments (timesheet_entry_id) WHERE (status = 'pending');

-- ========== SQLite ==========
-- DELETE FROM timesheet_amendments
-- WHERE id IN (
--   SELECT id FROM (
--     SELECT ta.id FROM timesheet_amendments ta
--     INNER JOIN (
--       SELECT timesheet_entry_id, MIN(id) AS keep_id
--       FROM timesheet_amendments
--       WHERE status = 'pending'
--       GROUP BY timesheet_entry_id
--       HAVING COUNT(*) > 1
--     ) g ON g.timesheet_entry_id = ta.timesheet_entry_id
--     WHERE ta.status = 'pending' AND ta.id != g.keep_id
--   )
-- );

-- CREATE UNIQUE INDEX IF NOT EXISTS idx_amendments_one_pending_per_entry
-- ON timesheet_amendments(timesheet_entry_id) WHERE status = 'pending';
