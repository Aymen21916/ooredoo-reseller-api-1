'use strict';

// Defaults, limits and validation for the barcode label printing settings.
// KEEP IN SYNC with the client's src/utils/barcodeLayout.js (same limits).

const PAGE_SIZES_MM = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } };

const DEFAULTS = {
  // Label & paper
  mode: 'roll',                // 'roll' = one label per page (label/thermal printer) | 'sheet' = grid on a sticker sheet
  label_width_mm: 50,
  label_height_mm: 30,
  padding_mm: 1.5,
  // Sheet mode only
  page_size: 'A4',             // 'A4' | 'Letter'
  columns: 3,
  rows: 8,
  margin_top_mm: 10,
  margin_left_mm: 7,
  gap_x_mm: 2,
  gap_y_mm: 0,
  // Barcode
  format: 'CODE128',           // CODE128 | EAN13 | EAN8 | UPC | CODE39
  barcode_width_pct: 90,       // % of the label's inner width
  barcode_height_mm: 10,
  show_value: true,            // human-readable number under the bars
  value_font_size_pt: 7,
  // Text on the label
  show_store_name: false,
  store_name: '',
  store_font_size_pt: 7,
  show_name: true,
  name_font_size_pt: 8,
  name_max_lines: 2,
  show_price: true,
  price_font_size_pt: 10,
  currency_label: 'DA',
  text_align: 'center',        // left | center | right
  // Printing
  copies_mode: 'fixed',        // 'fixed' = default_copies per product | 'stock' = one label per unit in stock
  default_copies: 1,
};

const SPEC = {
  mode:               { enum: ['roll', 'sheet'] },
  label_width_mm:     { num: [15, 200] },
  label_height_mm:    { num: [10, 200] },
  padding_mm:         { num: [0, 10] },
  page_size:          { enum: ['A4', 'Letter'] },
  columns:            { int: [1, 12] },
  rows:               { int: [1, 30] },
  margin_top_mm:      { num: [0, 50] },
  margin_left_mm:     { num: [0, 50] },
  gap_x_mm:           { num: [0, 30] },
  gap_y_mm:           { num: [0, 30] },
  format:             { enum: ['CODE128', 'EAN13', 'EAN8', 'UPC', 'CODE39'] },
  barcode_width_pct:  { int: [30, 100] },
  barcode_height_mm:  { num: [5, 60] },
  show_value:         { bool: true },
  value_font_size_pt: { num: [5, 20] },
  show_store_name:    { bool: true },
  store_name:         { str: 40 },
  store_font_size_pt: { num: [5, 20] },
  show_name:          { bool: true },
  name_font_size_pt:  { num: [5, 20] },
  name_max_lines:     { int: [1, 3] },
  show_price:         { bool: true },
  price_font_size_pt: { num: [5, 30] },
  currency_label:     { str: 10 },
  text_align:         { enum: ['left', 'center', 'right'] },
  copies_mode:        { enum: ['fixed', 'stock'] },
  default_copies:     { int: [1, 500] },
};

const isValid = (rule, v) => {
  if (rule.enum) return rule.enum.includes(v);
  if (rule.bool) return typeof v === 'boolean';
  if (rule.int)  return Number.isInteger(v) && v >= rule.int[0] && v <= rule.int[1];
  if (rule.num)  return typeof v === 'number' && Number.isFinite(v) && v >= rule.num[0] && v <= rule.num[1];
  if (rule.str)  return typeof v === 'string' && v.trim().length <= rule.str;
  return false;
};

/** Keeps only known keys (drops anything stale/unknown from storage or requests). */
const pickKnown = (obj = {}) => {
  const out = {};
  for (const key of Object.keys(SPEC)) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
};

/**
 * Validates `input` (partial) on top of `base` (full settings).
 * Returns { settings, errors[] }. Unknown keys are ignored.
 */
const validateSettings = (input, base = DEFAULTS) => {
  const errors = [];
  const settings = { ...DEFAULTS, ...pickKnown(base) };

  for (const [key, rule] of Object.entries(SPEC)) {
    if (input[key] === undefined) continue;
    if (!isValid(rule, input[key])) {
      const range = rule.enum ? `one of ${rule.enum.join(', ')}`
        : rule.int ? `a whole number ${rule.int[0]}–${rule.int[1]}`
        : rule.num ? `a number ${rule.num[0]}–${rule.num[1]}`
        : rule.str ? `text up to ${rule.str} characters`
        : 'true or false';
      errors.push(`${key} must be ${range}.`);
    } else {
      settings[key] = typeof input[key] === 'string' ? input[key].trim() : input[key];
    }
  }
  if (errors.length) return { settings, errors };

  if (settings.padding_mm * 2 >= settings.label_width_mm || settings.padding_mm * 2 >= settings.label_height_mm) {
    errors.push('padding_mm is too large for this label size.');
  }

  if (settings.mode === 'sheet') {
    const page = PAGE_SIZES_MM[settings.page_size];
    const usedW = settings.margin_left_mm + settings.columns * settings.label_width_mm + (settings.columns - 1) * settings.gap_x_mm;
    const usedH = settings.margin_top_mm + settings.rows * settings.label_height_mm + (settings.rows - 1) * settings.gap_y_mm;
    if (usedW > page.w + 0.01) {
      errors.push(`${settings.columns} column(s) need ${usedW.toFixed(1)} mm but a ${settings.page_size} page is ${page.w} mm wide.`);
    }
    if (usedH > page.h + 0.01) {
      errors.push(`${settings.rows} row(s) need ${usedH.toFixed(1)} mm but a ${settings.page_size} page is ${page.h} mm tall.`);
    }
  }
  return { settings, errors };
};

module.exports = { DEFAULTS, SPEC, PAGE_SIZES_MM, pickKnown, validateSettings };