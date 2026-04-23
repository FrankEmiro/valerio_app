/**
 * db.js – SQLite multi-sorgente
 */

const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { ALL_COLUMNS } = require('./columns')
const motone = require('./scrapers/motone')
const holyfreedom = require('./scrapers/holyfreedom')

const DB_DIR = path.join(__dirname, '..', 'data')
const DB_PATH = path.join(DB_DIR, 'scraper.db')
fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL DEFAULT 'partseurope',
    brand            TEXT,
    started_at       TEXT NOT NULL,
    completed_at     TEXT,
    status           TEXT NOT NULL DEFAULT 'running',
    urls_found       INTEGER DEFAULT 0,
    products_scraped INTEGER DEFAULT 0,
    email_sent       INTEGER DEFAULT 0,
    email_recipient  TEXT,
    error_message    TEXT,
    duration_seconds INTEGER,
    file_size_kb     REAL,
    log              TEXT DEFAULT ''
  );
`)

// Migrazione: aggiungi colonna source se non esiste
try { db.exec('ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT "partseurope"') } catch (_) {}

// ─── Defaults per sorgente ────────────────────────────────────────

const DEFAULTS = {
  // PartsEurope
  pe_brand:           'saddlemen-1',
  pe_max_pages:       '50',
  pe_cookie:          '',
  pe_cron:            '0 8 * * 1',
  pe_run_on_start:    'false',
  pe_force_update:    'false',
  pe_columns:         JSON.stringify(ALL_COLUMNS),
  pe_recipient:       '',
  // MotoOne
  mo_category_url:    'https://www.motone.co.uk/motorcycle-parts-c26',
  mo_max_products:    '1000',
  mo_concurrency:     '5',
  mo_delay_ms:        '1500',
  mo_child_categories: motone.DEFAULT_CHILD_CATEGORIES,
  mo_session_cookie:  '',
  mo_cron:            '0 9 * * 1',
  mo_run_on_start:    'false',
  mo_force_update:    'false',
  mo_columns:         JSON.stringify(motone.ALL_COLUMN_KEYS),
  mo_recipient:       '',
  // HolyFreedom
  hf_categories:      holyfreedom.DEFAULT_CATEGORIES,
  hf_cookie:          '',
  hf_delay_ms:        '1500',
  hf_cron:            '0 10 * * 1',
  hf_run_on_start:    'false',
  hf_force_update:    'false',
  hf_columns:         JSON.stringify(holyfreedom.ALL_COLUMN_KEYS),
  hf_recipient:       '',
  // Shared email – Gmail
  gmail_user:         '',
  gmail_app_password: '',
  // Shared email – SMTP alternativo (es. Brevo)
  smtp_host:          '',
  smtp_port:          '587',
  smtp_user:          '',
  smtp_pass:          '',
}

// ─── Settings ────────────────────────────────────────────────────

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : (DEFAULTS[key] ?? null)
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value ?? ''))
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const result = { ...DEFAULTS }
  for (const row of rows) result[row.key] = row.value
  // Env var fallback per email condivisa
  if (process.env.GMAIL_USER && !rows.find(r => r.key === 'gmail_user')) result.gmail_user = process.env.GMAIL_USER
  if (process.env.GMAIL_APP_PASSWORD && !rows.find(r => r.key === 'gmail_app_password')) result.gmail_app_password = process.env.GMAIL_APP_PASSWORD
  // Env var fallback PE
  if (process.env.BRAND && !rows.find(r => r.key === 'pe_brand')) result.pe_brand = process.env.BRAND
  if (process.env.COOKIE && !rows.find(r => r.key === 'pe_cookie')) result.pe_cookie = process.env.COOKIE
  if (process.env.CRON_SCHEDULE && !rows.find(r => r.key === 'pe_cron')) result.pe_cron = process.env.CRON_SCHEDULE
  if (process.env.RECIPIENT_EMAIL && !rows.find(r => r.key === 'pe_recipient')) result.pe_recipient = process.env.RECIPIENT_EMAIL
  return result
}

function saveSettings(data) {
  const allowed = Object.keys(DEFAULTS)
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `)
  const saveMany = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(k, String(v ?? ''))
  })
  saveMany(Object.entries(data).filter(([k]) => allowed.includes(k)))
}

// ─── Runs ────────────────────────────────────────────────────────

function createRun(source, brand = null) {
  return db.prepare(`
    INSERT INTO runs (source, brand, started_at, status)
    VALUES (?, ?, datetime('now'), 'running')
  `).run(source, brand).lastInsertRowid
}

function updateRun(id, data) {
  const keys = Object.keys(data)
  if (!keys.length) return
  db.prepare(`UPDATE runs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), id)
}

function appendRunLog(id, text) {
  db.prepare('UPDATE runs SET log = log || ? WHERE id = ?').run(text + '\n', id)
}

function completeRun(id, { status, productsScraped, urlsFound, emailSent, emailRecipient, errorMessage, fileSizeKb }) {
  db.prepare(`
    UPDATE runs SET
      status = ?, completed_at = datetime('now'),
      products_scraped = ?, urls_found = ?,
      email_sent = ?, email_recipient = ?,
      error_message = ?, file_size_kb = ?,
      duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER)
    WHERE id = ?
  `).run(status, productsScraped || 0, urlsFound || 0, emailSent ? 1 : 0,
    emailRecipient || null, errorMessage || null, fileSizeKb || null, id)
}

function getRuns(source = null, limit = 100) {
  if (source) {
    return db.prepare(`
      SELECT id, source, brand, started_at, completed_at, status,
             urls_found, products_scraped, email_sent, email_recipient,
             error_message, duration_seconds, file_size_kb
      FROM runs WHERE source = ? ORDER BY started_at DESC LIMIT ?
    `).all(source, limit)
  }
  return db.prepare(`
    SELECT id, source, brand, started_at, completed_at, status,
           urls_found, products_scraped, email_sent, email_recipient,
           error_message, duration_seconds, file_size_kb
    FROM runs ORDER BY started_at DESC LIMIT ?
  `).all(limit)
}

function getRunLog(id) {
  return db.prepare('SELECT log FROM runs WHERE id = ?').get(id)?.log || ''
}

function getStats(source = null) {
  const where = source ? `WHERE source = '${source}'` : ''
  return db.prepare(`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_runs,
      COALESCE(SUM(products_scraped), 0) as total_products,
      MAX(started_at) as last_run_at,
      ROUND(AVG(CASE WHEN status = 'completed' THEN duration_seconds END)) as avg_duration
    FROM runs ${where}
  `).get()
}

function getActiveRun(source = null) {
  const where = source ? `AND source = '${source}'` : ''
  return db.prepare(`
    SELECT id, source, brand, started_at, log
    FROM runs WHERE status = 'running' ${where}
    ORDER BY started_at DESC LIMIT 1
  `).get()
}

function deleteRun(id) {
  db.prepare('DELETE FROM runs WHERE id = ?').run(id)
}

module.exports = {
  getSetting, setSetting, getAllSettings, saveSettings,
  createRun, updateRun, appendRunLog, completeRun,
  getRuns, getRunLog, getStats, getActiveRun, deleteRun, DEFAULTS
}
