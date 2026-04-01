/**
 * web.js – Express dashboard + REST API multi-sorgente
 */

const express = require('express')
const path = require('path')
const fs = require('fs')
const cron = require('node-cron')
const ExcelJS = require('exceljs')
const db = require('./db')
const { COLUMN_GROUPS: PE_GROUPS, ALL_COLUMNS: PE_ALL } = require('./columns')
const motone = require('./scrapers/motone')

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, '..', 'public')))

// Runner iniettato da service.js
const _runners = {}       // { partseurope: fn, motone: fn }
const _running = {}       // { partseurope: bool, motone: bool }
const _cronTasks = {}     // { partseurope: task, motone: task }

function setRunner(source, fn) { _runners[source] = fn }
function setRunning(source, v) { _running[source] = v }
function setCron(source, task) { _cronTasks[source] = task }
function isRunning(source) { return !!_running[source] }
function anyRunning() { return Object.values(_running).some(Boolean) }

const CRON_LABELS = {
  '0 8 * * 1': 'ogni lunedì alle 8:00',
  '0 9 * * 1': 'ogni lunedì alle 9:00',
  '0 6 * * *': 'ogni giorno alle 6:00',
  '0 0 * * 0': 'ogni domenica a mezzanotte',
  '0 0 1 * *': 'il primo del mese',
  '0 */12 * * *': 'ogni 12 ore',
  '0 * * * *': 'ogni ora',
}

// ─── API generali ──────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const s = db.getAllSettings()
  res.json({
    sources: {
      partseurope: {
        isRunning: isRunning('partseurope'),
        brand: s.pe_brand,
        cronSchedule: s.pe_cron,
        nextRunLabel: CRON_LABELS[s.pe_cron] || s.pe_cron,
        stats: db.getStats('partseurope'),
        lastRun: db.getRuns('partseurope', 1)[0] || null,
        activeRun: isRunning('partseurope') ? db.getActiveRun('partseurope') : null,
      },
      motone: {
        isRunning: isRunning('motone'),
        categoryUrl: s.mo_category_url,
        cronSchedule: s.mo_cron,
        nextRunLabel: CRON_LABELS[s.mo_cron] || s.mo_cron,
        stats: db.getStats('motone'),
        lastRun: db.getRuns('motone', 1)[0] || null,
        activeRun: isRunning('motone') ? db.getActiveRun('motone') : null,
      }
    },
    globalStats: db.getStats(),
    allRuns: db.getRuns(null, 5),
  })
})

app.get('/api/runs', (req, res) => {
  const { source } = req.query
  res.json(db.getRuns(source || null, 100))
})

app.get('/api/runs/:id/log', (req, res) => {
  res.json({ log: db.getRunLog(parseInt(req.params.id)) })
})

// ─── Settings ──────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const s = db.getAllSettings()
  if (s.gmail_app_password) s.gmail_app_password = '••••••••••••••••'
  res.json(s)
})

app.post('/api/settings', (req, res) => {
  const data = { ...req.body }
  if (data.gmail_app_password) data.gmail_app_password = data.gmail_app_password.replace(/\s+/g, '')
  if (!data.gmail_app_password || data.gmail_app_password === '••••••••••••••••') delete data.gmail_app_password
  db.saveSettings(data)
  if (data.pe_cron && _cronTasks.partseurope) {
    _cronTasks.partseurope.stop()
    app.emit('cron-changed', 'partseurope', data.pe_cron)
  }
  if (data.mo_cron && _cronTasks.motone) {
    _cronTasks.motone.stop()
    app.emit('cron-changed', 'motone', data.mo_cron)
  }
  res.json({ ok: true })
})

// ─── Colonne ───────────────────────────────────────────────────────

app.get('/api/columns/:source', (req, res) => {
  const { source } = req.params
  const s = db.getAllSettings()

  if (source === 'partseurope') {
    let enabled
    try { enabled = JSON.parse(s.pe_columns) } catch (e) { enabled = PE_ALL }
    const enabledSet = new Set(enabled)
    return res.json({
      groups: PE_GROUPS.map(g => ({
        ...g,
        columns: g.columns.map(col => ({ name: col, enabled: enabledSet.has(col) }))
      })),
      totalEnabled: enabled.length,
      totalAll: PE_ALL.length,
      keyField: 'name'
    })
  }

  if (source === 'motone') {
    let enabled
    try { enabled = JSON.parse(s.mo_columns) } catch (e) { enabled = motone.ALL_COLUMN_KEYS }
    const enabledSet = new Set(enabled)
    return res.json({
      groups: motone.COLUMN_GROUPS.map(g => ({
        ...g,
        columns: g.columns.map(key => ({
          key,
          name: motone.COLUMNS.find(c => c.key === key)?.header || key,
          enabled: enabledSet.has(key)
        }))
      })),
      totalEnabled: enabled.length,
      totalAll: motone.ALL_COLUMN_KEYS.length,
      keyField: 'key'
    })
  }

  res.status(404).json({ error: 'Sorgente non trovata' })
})

// ─── Run / Stop ────────────────────────────────────────────────────

app.post('/api/run/:source', async (req, res) => {
  const { source } = req.params
  if (!['partseurope', 'motone'].includes(source))
    return res.status(404).json({ error: 'Sorgente non valida' })
  if (isRunning(source))
    return res.status(409).json({ error: 'Job già in esecuzione per questa sorgente' })
  if (!_runners[source])
    return res.status(503).json({ error: 'Runner non disponibile' })
  res.json({ ok: true, message: `Job ${source} avviato` })
  _runners[source]().catch(console.error)
})

// ─── Download (filtra colonne on-the-fly) ─────────────────────────

async function buildFilteredExcel(xlsxPath, enabledHeaders) {
  const srcWb = new ExcelJS.Workbook()
  await srcWb.xlsx.readFile(xlsxPath)
  const srcSheet = srcWb.getWorksheet('Products')
  if (!srcSheet) throw new Error('Foglio Products non trovato nel file')

  // mappa header → indice colonna sorgente (1-based)
  const headerMap = {}
  srcSheet.getRow(1).eachCell((cell, colNum) => {
    headerMap[String(cell.value ?? '')] = colNum
  })

  // colonne da includere nell'ordine selezionato dall'utente
  const colsToInclude = enabledHeaders
    .map(h => ({ header: h, srcIdx: headerMap[h] }))
    .filter(c => c.srcIdx != null)

  if (!colsToInclude.length) throw new Error('Nessuna colonna valida trovata nel file')

  const outWb = new ExcelJS.Workbook()
  outWb.creator = 'Valerio Scraper'
  const outSheet = outWb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] })

  // intestazioni
  outSheet.addRow(colsToInclude.map(c => c.header))
  const hdr = outSheet.getRow(1)
  hdr.height = 22
  hdr.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a20' } }
    cell.font  = { bold: true, color: { argb: 'FFf97316' }, size: 11 }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  // righe dati
  srcSheet.eachRow((srcRow, rowNum) => {
    if (rowNum === 1) return
    const values = colsToInclude.map(c => {
      const srcCell = srcRow.getCell(c.srcIdx)
      // preserva hyperlink se presente
      if (srcCell.hyperlink) return { text: String(srcCell.value ?? ''), hyperlink: srcCell.hyperlink }
      return srcCell.value
    })
    const newRow = outSheet.addRow(values)
    const bg = (rowNum - 2) % 2 === 0 ? 'FFFAFAFA' : 'FFEFEFEF'
    newRow.height = 18
    newRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
      cell.alignment = { vertical: 'top', wrapText: false }
    })
  })

  // larghezze colonne: leggi dalla sorgente
  colsToInclude.forEach((c, i) => {
    const srcCol = srcSheet.getColumn(c.srcIdx)
    outSheet.getColumn(i + 1).width = srcCol.width || 20
  })

  return outWb.xlsx.writeBuffer()
}

app.get('/api/download/:source', async (req, res) => {
  const { source } = req.params
  const s = db.getAllSettings()
  let xlsxPath, enabledHeaders, filename

  if (source === 'partseurope') {
    xlsxPath = path.join(__dirname, '..', 'output', `${s.pe_brand}.xlsx`)
    filename  = `${s.pe_brand}.xlsx`
    let keys = PE_ALL
    try { keys = JSON.parse(s.pe_columns) } catch (_) {}
    enabledHeaders = keys  // per PE i keys == headers
  } else if (source === 'motone') {
    xlsxPath = path.join(__dirname, '..', 'output', 'motone', 'products.xlsx')
    filename  = 'motone_products.xlsx'
    let keys = motone.ALL_COLUMN_KEYS
    try { keys = JSON.parse(s.mo_columns) } catch (_) {}
    const keyToHeader = Object.fromEntries(motone.COLUMNS.map(c => [c.key, c.header]))
    enabledHeaders = keys.map(k => keyToHeader[k]).filter(Boolean)
  } else {
    return res.status(404).json({ error: 'Sorgente non valida' })
  }

  if (!fs.existsSync(xlsxPath)) return res.status(404).json({ error: 'File non trovato' })

  try {
    const buffer = await buildFilteredExcel(xlsxPath, enabledHeaders)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(Buffer.from(buffer))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Helper: ottieni headers abilitati per sorgente ───────────────

function getEnabledHeaders(source, s) {
  if (source === 'partseurope') {
    let keys = PE_ALL
    try { keys = JSON.parse(s.pe_columns) } catch (_) {}
    return { headers: keys, brand: s.pe_brand, filename: `${s.pe_brand}.xlsx`, xlsxPath: path.join(__dirname, '..', 'output', `${s.pe_brand}.xlsx`) }
  }
  if (source === 'motone') {
    let keys = motone.ALL_COLUMN_KEYS
    try { keys = JSON.parse(s.mo_columns) } catch (_) {}
    const keyToHeader = Object.fromEntries(motone.COLUMNS.map(c => [c.key, c.header]))
    return { headers: keys.map(k => keyToHeader[k]).filter(Boolean), brand: 'MotoOne', filename: 'motone_products.xlsx', xlsxPath: path.join(__dirname, '..', 'output', 'motone', 'products.xlsx') }
  }
  return null
}

// ─── Preview dati Excel ────────────────────────────────────────────

app.get('/api/preview/:source', async (req, res) => {
  const { source } = req.params
  const s = db.getAllSettings()
  const info = getEnabledHeaders(source, s)
  if (!info) return res.status(404).json({ error: 'Sorgente non valida' })
  if (!fs.existsSync(info.xlsxPath)) return res.json({ headers: [], rows: [], total: 0 })

  try {
    const limit = parseInt(req.query.limit) || 100
    const srcWb = new ExcelJS.Workbook()
    await srcWb.xlsx.readFile(info.xlsxPath)
    const srcSheet = srcWb.getWorksheet('Products')
    if (!srcSheet) return res.json({ headers: [], rows: [], total: 0 })

    const headerMap = {}
    srcSheet.getRow(1).eachCell((cell, colNum) => { headerMap[String(cell.value ?? '')] = colNum })

    const colsToShow = info.headers
      .map(h => ({ header: h, srcIdx: headerMap[h] }))
      .filter(c => c.srcIdx != null)

    const rows = []
    let total = 0
    srcSheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return
      total++
      if (rows.length < limit) {
        rows.push(colsToShow.map(c => {
          const cell = row.getCell(c.srcIdx)
          if (cell.hyperlink) return cell.hyperlink
          const v = cell.value
          if (v && typeof v === 'object' && v.text) return v.text
          return String(v ?? '')
        }))
      }
    })
    res.json({ headers: colsToShow.map(c => c.header), rows, total, showing: rows.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Invio email manuale ───────────────────────────────────────────

app.post('/api/send-email/:source', async (req, res) => {
  const { source } = req.params
  const s = db.getAllSettings()
  if (!s.gmail_user || !s.gmail_app_password)
    return res.status(400).json({ error: 'Credenziali Gmail non configurate' })

  const info = getEnabledHeaders(source, s)
  if (!info) return res.status(404).json({ error: 'Sorgente non valida' })

  const recipient = req.body.recipient || (source === 'partseurope' ? s.pe_recipient : s.mo_recipient)
  if (!recipient) return res.status(400).json({ error: 'Nessun destinatario configurato' })
  if (!fs.existsSync(info.xlsxPath)) return res.status(404).json({ error: 'Nessun file Excel disponibile' })

  try {
    const os = require('os')
    const tmpPath = path.join(os.tmpdir(), `valerio_${source}_${Date.now()}.xlsx`)
    const buffer = await buildFilteredExcel(info.xlsxPath, info.headers)
    fs.writeFileSync(tmpPath, Buffer.from(buffer))
    const { sendExcel } = require('./mailer')
    try {
      await sendExcel({ xlsxPath: tmpPath, brand: info.brand, recipientEmail: recipient, gmailUser: s.gmail_user, gmailAppPassword: s.gmail_app_password })
    } finally {
      try { fs.unlinkSync(tmpPath) } catch (_) {}
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Test email ────────────────────────────────────────────────────

app.post('/api/test-email', async (req, res) => {
  const s = db.getAllSettings()
  if (!s.gmail_user || !s.gmail_app_password || s.gmail_app_password === '••••••••••••••••')
    return res.status(400).json({ error: 'Credenziali Gmail non configurate' })
  const recipient = req.body.recipient || s.pe_recipient || s.mo_recipient
  if (!recipient) return res.status(400).json({ error: 'Nessun destinatario configurato' })
  try {
    const nodemailer = require('nodemailer')
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: s.gmail_user, pass: s.gmail_app_password } })
    await t.sendMail({
      from: s.gmail_user, to: recipient,
      subject: '[Valerio Scraper] Test email configurazione',
      text: 'Configurazione email funzionante ✓\n\nI prossimi Excel verranno consegnati a questo indirizzo.'
    })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

function startWebServer(port = 3131) {
  return new Promise(resolve => {
    const server = app.listen(port, () => {
      console.log(`Dashboard: http://localhost:${port}`)
      resolve(server)
    })
  })
}

module.exports = { startWebServer, setRunner, setRunning, setCron, isRunning, anyRunning, app }
