-- Migration: add tax_breakdown column to Bills
-- Run this on your PostgreSQL database connected to the app's schema.

ALTER TABLE "Bills"
  ADD COLUMN IF NOT EXISTS tax_breakdown jsonb;

-- Optionally set default to null explicitly (not required):
-- ALTER TABLE "Bills" ALTER COLUMN tax_breakdown SET DEFAULT NULL;

-- Verify:
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'Bills';
