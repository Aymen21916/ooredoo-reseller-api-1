'use strict';

/**
 * Make SIM cards generic: drop the offer_id link. The offer is now decided
 * at sale time and snapshotted on session_sim_sales (which already happens).
 */

const { Pool } = require('pg');

try {
  require('fs').readFileSync('.env', 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#'))
    .forEach((l) => {
      const [k, ...r] = l.split('=');
      if (k && r.length && !process.env[k.trim()]) {
        process.env[k.trim()] = r.join('=').trim();
      }
    });
} catch {}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const SQL = `
-- 1. Drop dependent view
DROP VIEW IF EXISTS v_cashier_sim_inventory;

-- 2. Drop dependent index then column
DROP INDEX IF EXISTS idx_sim_cards_available;
DROP INDEX IF EXISTS idx_sim_cards_offer;
ALTER TABLE sim_cards DROP COLUMN IF EXISTS offer_id;

-- 3. New available index without offer
CREATE INDEX IF NOT EXISTS idx_sim_cards_available
  ON sim_cards (cashier_id, serial_number)
  WHERE status = 'available';

-- 4. New inventory view grouped per cashier only
CREATE VIEW v_cashier_sim_inventory AS
SELECT
  sc.cashier_id,
  u.full_name                                                 AS cashier_name,
  u.store_id,
  s.name                                                      AS store_name,
  COUNT(*) FILTER (WHERE sc.status = 'available')             AS available_count,
  COUNT(*) FILTER (WHERE sc.status = 'sold')                  AS sold_count,
  COUNT(*) FILTER (WHERE sc.status = 'voided')                AS voided_count,
  MIN(sc.serial_number) FILTER (WHERE sc.status = 'available') AS next_serial,
  MAX(sc.serial_number) FILTER (WHERE sc.status = 'available') AS last_serial,
  COUNT(*) FILTER (WHERE sc.status = 'available') <= 5
    AS is_low_stock
FROM sim_cards sc
JOIN users  u ON u.id = sc.cashier_id
JOIN stores s ON s.id = u.store_id
GROUP BY sc.cashier_id, u.full_name, u.store_id, s.name;

COMMENT ON VIEW v_cashier_sim_inventory IS
  'Cashier SIM inventory aggregated per cashier with low-stock flag (threshold = 5).';
`;

pool
  .query(SQL)
  .then(() => { /*console.log('✓ Generic SIM migration applied.');*/ return pool.end(); })
  .catch((err) => { console.error('✗ Failed:', err.message); pool.end(); process.exit(1); });
