-- ============================================================
-- Clear All HydroOne Data from Home Assistant Statistics
-- ============================================================
-- Run this BEFORE importing new data to ensure clean cumulative sums.
--
-- WARNING: This will delete ALL hydroone:* statistics data!
-- Make sure you have your Green Button XML files ready for reimport.
-- ============================================================

-- Step 1: Delete from statistics table (main historical data)
DELETE FROM statistics
WHERE metadata_id IN (
    SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%'
);

-- Step 2: Delete from statistics_short_term table (recent data)
DELETE FROM statistics_short_term
WHERE metadata_id IN (
    SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%'
);

-- ============================================================
-- Verification Queries (run after DELETE to confirm)
-- ============================================================

-- Check remaining hydroone records (should be 0)
-- SELECT COUNT(*) as remaining_records FROM statistics
-- WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%');

-- View metadata entries (these are kept for reimport)
-- SELECT * FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%';
