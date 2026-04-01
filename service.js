/**
 * service.js – Servizio unificato: PartsEurope + MotoOne
 *
 * Dashboard: http://localhost:3131
 *
 * Env vars (.env o Coolify):
 *   PORT                 porta dashboard (default: 3131)
 *   RUN_ON_START         true/false override globale
 *   GMAIL_USER           email Gmail condivisa
 *   GMAIL_APP_PASSWORD   app password Gmail
 *   BRAND / COOKIE / CRON_SCHEDULE / RECIPIENT_EMAIL  (PE, backward compat)
 */

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const cron = require('node-cron')
const db = require('./lib/db')
const web = require('./lib/web')
const { getUrls } = require('./lib/crawler')
const { scrapeAll } = require('./lib/scraper')
const { filterColumns } = require('./lib/columns')
const { sendExcel } = require('./lib/mailer')
const motone = require('./lib/scrapers/motone')

const PORT = parseInt(process.env.PORT) || 3131

// ─── Job PartsEurope ───────────────────────────────────────────────

async function runPartsEurope() {
  if (web.isRunning('partseurope')) return
  web.setRunning('partseurope', true)

  const s = db.getAllSettings()
  const brand = s.pe_brand
  const runId = db.createRun('partseurope', brand)

  const log = (msg) => { console.log(`[PE] ${msg}`); db.appendRunLog(runId, msg) }

  let productsCount = 0, urlsCount = 0, emailSent = false

  try {
    log(`Job avviato — brand: ${brand}`)

    log('Fase 1 – Raccolta URL...')
    const urls = await getUrls(brand, parseInt(s.pe_max_pages) || 50, s.pe_cookie || '')
    urlsCount = urls.length
    db.updateRun(runId, { urls_found: urlsCount })

    log('Fase 2 – Scraping prodotti...')
    let enabledColumns = null
    try { enabledColumns = JSON.parse(s.pe_columns) } catch (e) {}
    const result = await scrapeAll(brand, s.pe_cookie || '', enabledColumns, log)
    productsCount = result?.productsCount || 0
    db.updateRun(runId, { products_scraped: productsCount })

    const xlsxPath = path.join(__dirname, 'output', `${brand}.xlsx`)
    const recipient = s.pe_recipient
    const hasEmail = recipient && ((s.smtp_host && s.smtp_user && s.smtp_pass) || (s.gmail_user && s.gmail_app_password))
    if (hasEmail) {
      log('Fase 3 – Invio email...')
      await sendExcel({ xlsxPath, brand, recipientEmail: recipient, gmailUser: s.gmail_user, gmailAppPassword: s.gmail_app_password, smtpHost: s.smtp_host, smtpPort: s.smtp_port, smtpUser: s.smtp_user, smtpPass: s.smtp_pass })
      emailSent = true
      log(`Email inviata a ${recipient}`)
    } else {
      log('Fase 3 – Email saltata (credenziali mancanti)')
    }

    const fileSizeKb = fs.existsSync(xlsxPath)
      ? Math.round(fs.statSync(xlsxPath).size / 1024 * 10) / 10 : null

    db.completeRun(runId, { status: 'completed', productsScraped: productsCount, urlsFound: urlsCount, emailSent, emailRecipient: emailSent ? recipient : null, fileSizeKb })
    log('Completato ✓')
  } catch (err) {
    log(`ERRORE: ${err.message}`)
    db.completeRun(runId, { status: 'error', productsScraped: productsCount, urlsFound: urlsCount, emailSent: false, errorMessage: err.message })
    notifyError('PartsEurope', err)
  } finally {
    web.setRunning('partseurope', false)
  }
}

// ─── Job MotoOne ──────────────────────────────────────────────────

async function runMotone() {
  if (web.isRunning('motone')) return
  web.setRunning('motone', true)

  const s = db.getAllSettings()
  const runId = db.createRun('motone', 'motone.co.uk')

  const log = (msg) => { console.log(`[MO] ${msg}`); db.appendRunLog(runId, msg) }

  let productsCount = 0, urlsCount = 0, emailSent = false

  try {
    log('Job avviato — motone.co.uk')
    const result = await motone.run(s, log)
    productsCount = result.productsCount
    urlsCount = result.urlsCount
    db.updateRun(runId, { products_scraped: productsCount, urls_found: urlsCount })

    const recipient = s.mo_recipient
    const hasEmail = recipient && result.xlsxPath && ((s.smtp_host && s.smtp_user && s.smtp_pass) || (s.gmail_user && s.gmail_app_password))
    if (hasEmail) {
      log('Invio email...')
      await sendExcel({ xlsxPath: result.xlsxPath, brand: 'MotoOne', recipientEmail: recipient, gmailUser: s.gmail_user, gmailAppPassword: s.gmail_app_password, smtpHost: s.smtp_host, smtpPort: s.smtp_port, smtpUser: s.smtp_user, smtpPass: s.smtp_pass })
      emailSent = true
      log(`Email inviata a ${recipient}`)
    } else {
      log('Email saltata (credenziali mancanti)')
    }

    const fileSizeKb = result.xlsxPath && fs.existsSync(result.xlsxPath)
      ? Math.round(fs.statSync(result.xlsxPath).size / 1024 * 10) / 10 : null

    db.completeRun(runId, { status: 'completed', productsScraped: productsCount, urlsFound: urlsCount, emailSent, emailRecipient: emailSent ? recipient : null, fileSizeKb })
    log('Completato ✓')
  } catch (err) {
    log(`ERRORE: ${err.message}`)
    db.completeRun(runId, { status: 'error', productsScraped: productsCount, urlsFound: urlsCount, emailSent: false, errorMessage: err.message })
    notifyError('MotoOne', err)
  } finally {
    web.setRunning('motone', false)
  }
}

// ─── Notifica errore ──────────────────────────────────────────────

async function notifyError(sourceName, err) {
  const s = db.getAllSettings()
  const hasSmtp  = !!(s.smtp_host && s.smtp_user && s.smtp_pass)
  const hasGmail = !!(s.gmail_user && s.gmail_app_password)
  if (!hasSmtp && !hasGmail) return
  try {
    const { buildTransport, senderAddress } = require('./lib/mailer')
    const sm = { gmailUser: s.gmail_user, gmailAppPassword: s.gmail_app_password, smtpHost: s.smtp_host, smtpPort: s.smtp_port, smtpUser: s.smtp_user, smtpPass: s.smtp_pass }
    const t = buildTransport(sm)
    const from = senderAddress(sm)
    await t.sendMail({ from, to: from, subject: `[Valerio Scraper] ERRORE ${sourceName}`, text: `${err.message}\n\n${err.stack}` })
  } catch (_) {}
}

// ─── Avvio ────────────────────────────────────────────────────────

async function main() {
  await web.startWebServer(PORT)

  web.setRunner('partseurope', runPartsEurope)
  web.setRunner('motone', runMotone)

  const s = db.getAllSettings()
  const runOnStart = process.env.RUN_ON_START === 'true'

  // Scheduler PartsEurope
  const peCron = s.pe_cron || '0 8 * * 1'
  if (cron.validate(peCron)) {
    const peTask = cron.schedule(peCron, () => runPartsEurope(), { timezone: 'Europe/Rome' })
    web.setCron('partseurope', peTask)
    console.log(`[PE] Scheduler: ${peCron}`)
  }

  // Scheduler MotoOne
  const moCron = s.mo_cron || '0 9 * * 1'
  if (cron.validate(moCron)) {
    const moTask = cron.schedule(moCron, () => runMotone(), { timezone: 'Europe/Rome' })
    web.setCron('motone', moTask)
    console.log(`[MO] Scheduler: ${moCron}`)
  }

  // Ricrea scheduler quando cambiati dalla UI
  web.app.on('cron-changed', (source, newExpr) => {
    if (!cron.validate(newExpr)) return
    const fn = source === 'partseurope' ? runPartsEurope : runMotone
    const task = cron.schedule(newExpr, () => fn(), { timezone: 'Europe/Rome' })
    web.setCron(source, task)
    console.log(`[${source.toUpperCase()}] Cron aggiornato: ${newExpr}`)
  })

  // Run on start
  if (s.pe_run_on_start === 'true' || runOnStart) {
    console.log('[PE] RUN_ON_START → avvio...')
    runPartsEurope().catch(console.error)
  }
  if (s.mo_run_on_start === 'true') {
    console.log('[MO] RUN_ON_START → avvio...')
    runMotone().catch(console.error)
  }

  console.log(`\nValerio Scraper — dashboard: http://localhost:${PORT}\n`)
}

main().catch(err => { console.error(err); process.exit(1) })
