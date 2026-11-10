-- 0010: Structured country/region on user profiles (Ghana-first).
-- Adds ISO 3166-1 alpha-2 country_code and optional region (e.g. Ghana's 16 regions).
-- Best-effort backfill from legacy free-text country; keep `country` for compatibility
-- but application code stops writing to it.

ALTER TABLE users
  ADD COLUMN country_code char(2),
  ADD COLUMN region text;

-- Best-effort backfill: recognize explicit Ghana values; other legacy values left null.
UPDATE users
SET country_code = 'GH'
WHERE country_code IS NULL
  AND country IS NOT NULL
  AND (
    upper(trim(country)) IN ('GH', 'GHA')
    OR lower(trim(country)) = 'ghana'
  );

-- Constrain stored codes to uppercase alpha-2 when present.
ALTER TABLE users
  ADD CONSTRAINT users_country_code_format
  CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

CREATE INDEX users_country_code_idx ON users (country_code) WHERE country_code IS NOT NULL;
