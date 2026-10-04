'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendSuccess } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const { DEFAULTS, pickKnown, validateSettings } = require('../utils/barcodePrintSettings');

const KEY = 'barcode_print';

const loadCurrent = async () => {
  const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [KEY]);
  return { ...DEFAULTS, ...pickKnown(rows[0]?.value || {}) };
};

// GET /api/settings/barcode-print — any logged-in user (cashiers may print labels too)
const getBarcodePrintSettings = asyncHandler(async (req, res) => {
  sendSuccess(res, await loadCurrent());
});

// PUT /api/settings/barcode-print — admin only
const updateBarcodePrintSettings = asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw AppError.badRequest('Request body must be an object of settings.', 'VALIDATION_ERROR');
  }
  const current = await loadCurrent();
  const { settings, errors } = validateSettings(req.body, current);
  if (errors.length) throw AppError.badRequest(errors.join(' '), 'VALIDATION_ERROR');

  await db.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify(settings), req.user.id]
  );

  audit({
    userId: req.user.id, action: 'UPDATE', table: 'app_settings', recordId: 0,
    newValues: settings, description: 'barcode_print settings', ip: req.clientIp,
  });

  sendSuccess(res, settings, 200, 'Barcode print settings saved.');
});

module.exports = { getBarcodePrintSettings, updateBarcodePrintSettings };