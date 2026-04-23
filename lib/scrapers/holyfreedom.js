/**
 * holyfreedom.js – Scraper per holyfreedom.com/it
 * PrestaShop con paginazione AJAX infinita + anti-bot BotNinja/Imperva.
 * Tutte le richieste HTTP vengono eseguite dentro Puppeteer (stesso fingerprint TLS/browser).
 */

const puppeteer = require('puppeteer-core')
const cheerio   = require('cheerio')
const ExcelJS   = require('exceljs')
const path      = require('path')
const fs        = require('fs')
const os        = require('os')

const BASE_URL   = 'https://www.holyfreedom.com'
const LANG       = '/it'
const OUTPUT_DIR = path.join(__dirname, '../../output/holyfreedom')

const COLUMNS = [
  { key: 'name',              header: 'Nome prodotto',         width: 55 },
  { key: 'reference',         header: 'Codice (SKU)',          width: 18 },
  { key: 'brand',             header: 'Brand',                 width: 14 },
  { key: 'price',             header: 'Prezzo (EUR)',          width: 16 },
  { key: 'availability',      header: 'Disponibilità',         width: 16 },
  { key: 'category',          header: 'Categoria',             width: 30 },
  { key: 'description_short', header: 'Descrizione breve',    width: 55 },
  { key: 'description',       header: 'Descrizione completa', width: 80 },
  { key: 'images',            header: 'Immagini (URL)',        width: 80 },
  { key: 'url',               header: 'URL prodotto',          width: 80 },
]
const ALL_COLUMN_KEYS = COLUMNS.map(c => c.key)

const COLUMN_GROUPS = [
  { id: 'product',  label: 'Prodotto',       icon: '⬡', columns: ['name', 'reference', 'brand', 'url'] },
  { id: 'pricing',  label: 'Prezzo & Stock', icon: '◈', columns: ['price', 'availability'] },
  { id: 'content',  label: 'Contenuto',      icon: '◉', columns: ['description_short', 'description'] },
  { id: 'category', label: 'Categoria',      icon: '▦', columns: ['category'] },
  { id: 'media',    label: 'Media',          icon: '▣', columns: ['images'] },
]

const DEFAULT_CATEGORIES = 'uomo,tutoni,caschi-omologati,cashi-handmade,cappellini,stivali,nuovi-arrivi,t-shirt-donna,pantaloni,explorer'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Puppeteer setup ──────────────────────────────────────────────

function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  const candidates = os.platform() === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable']
  return candidates.find(p => fs.existsSync(p)) || null
}

async function launchBrowser(log) {
  const executablePath = findChromium()
  if (!executablePath) throw new Error(
    'Chromium non trovato. Imposta PUPPETEER_EXECUTABLE_PATH o installa Chrome/Chromium.'
  )
  log(`Browser: ${executablePath}`)
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })
}

async function openPage(browser) {
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  )
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  return page
}

/** Naviga al sito (risolve challenge anti-bot), ritorna la pagina pronta. */
async function initSession(browser, url, log) {
  const page = await openPage(browser)
  log(`Navigazione: ${url}`)

  // Primo tentativo — networkidle0 per aspettare la risoluzione challenge
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })

  // Se siamo su pagina challenge, aspetta redirect automatico
  const title = await page.title()
  if (title.toLowerCase().includes('anti-robot') || title.toLowerCase().includes('validation')) {
    log('Challenge anti-bot rilevata, attendo risoluzione automatica...')
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {})
  } else {
    // Breve attesa per assicurare che tutti i cookie siano impostati
    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {})
  }

  log(`Sessione aperta (titolo: ${(await page.title()).substring(0, 60)})`)
  return page
}

// ─── Crawl categorie via AJAX (dentro browser) ───────────────────

async function fetchCategoryAjax(page, categorySlug, pageNum) {
  const url = `${BASE_URL}${LANG}/${categorySlug}`
  return page.evaluate(async (url, pageNum) => {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
        body: `page=${pageNum}&ajax=1`,
        credentials: 'include',
      })
      if (!resp.ok) return { _error: resp.status }
      const ct = resp.headers.get('content-type') || ''
      if (!ct.includes('json') && !ct.includes('javascript')) {
        const text = await resp.text()
        return { _html: text.substring(0, 200) }
      }
      return resp.json()
    } catch (e) {
      return { _error: e.message }
    }
  }, url, pageNum)
}

async function collectProductUrls(categories, page, log) {
  const seen  = new Set()
  const links = []

  for (const cat of categories) {
    log(`Categoria: /${cat}`)
    let pageNum   = 1
    let totalPages = 1

    while (pageNum <= totalPages) {
      const data = await fetchCategoryAjax(page, cat, pageNum)

      if (data?._error) {
        log(`  ✗ /${cat} p.${pageNum}: ${data._error}`)
        break
      }
      if (data?._html !== undefined) {
        log(`  ⚠ /${cat} p.${pageNum}: risposta HTML (anti-bot?) — ${data._html}`)
        break
      }

      const products = data?.products || []
      if (!products.length) {
        log(`  Categoria /${cat} p.${pageNum}: 0 prodotti — fine`)
        break
      }

      if (pageNum === 1) {
        totalPages = data.pagination?.pages_count || 1
        log(`  Totale: ${data.pagination?.total_items ?? '?'} prodotti, ${totalPages} pagine`)
      }

      let added = 0
      for (const prod of products) {
        const url = prod.url || prod.canonical_url
        if (url && !seen.has(url)) { seen.add(url); links.push(url); added++ }
      }
      log(`  Pagina ${pageNum}/${totalPages}: ${added} nuovi link (totale: ${links.length})`)

      pageNum++
      if (pageNum <= totalPages) await sleep(800)
    }

    await sleep(1000)
  }

  return links
}

// ─── Scraping prodotto (fetch HTML dentro browser, parse in Node) ─

function extractProductJsonLd($) {
  let found = null
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return
    try {
      const obj = JSON.parse($(el).html())
      if (obj['@type'] === 'Product') found = obj
    } catch (_) {}
  })
  return found
}

async function scrapeProduct(page, url) {
  const html = await page.evaluate(async (url) => {
    const resp = await fetch(url, { credentials: 'include' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.text()
  }, url)

  const $ = cheerio.load(html)
  const ld = extractProductJsonLd($)
  if (!ld) throw new Error('Nessun JSON-LD Product trovato')

  const name             = ld.name || $('h1.page-title span').first().text().trim()
  const reference        = ld.sku || ld.mpn || ''
  const brand            = ld.brand?.name || 'Holyfreedom'
  const price            = ld.offers?.price || ''
  const availability     = ld.offers?.availability?.includes('InStock') ? 'Disponibile' : 'Non disponibile'
  const category         = ld.category || ''
  const description_short = (ld.description || $('meta[name="description"]').attr('content') || '').trim()
  const description      = $('.product-description .rte-content').first().text().replace(/\s+/g, ' ').trim()

  const rawImages = Array.isArray(ld.offers?.image) ? ld.offers.image
    : ld.offers?.image ? [ld.offers.image]
    : ld.image         ? [ld.image]
    : []
  const images = [...new Set(rawImages)].join(', ')

  return { name, reference, brand, price, availability, category, description_short, description, images, url }
}

// ─── Excel ────────────────────────────────────────────────────────

function applyHeaderStyling(sheet) {
  const row = sheet.getRow(1)
  row.height = 22
  row.eachCell(cell => {
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a20' } }
    cell.font      = { bold: true, color: { argb: 'FFb56fc9' }, size: 11 }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
}

async function loadOrCreateWorkbook(outputFile, enabledKeys) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Valerio Scraper – HolyFreedom'
  const doneUrls = new Set()
  const activeCols = enabledKeys ? COLUMNS.filter(c => enabledKeys.includes(c.key)) : COLUMNS

  let fileLoaded = false
  try { await wb.xlsx.readFile(outputFile); fileLoaded = true } catch (_) {}

  if (fileLoaded) {
    let sheet = wb.getWorksheet('Products')
    if (!sheet) {
      sheet = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] })
      sheet.addRow(activeCols.map(c => c.header))
      applyHeaderStyling(sheet)
    }
    activeCols.forEach((c, i) => { sheet.getColumn(i + 1).width = c.width })

    let urlColIdx = 0
    sheet.getRow(1).eachCell((cell, colNum) => {
      if (String(cell.value ?? '') === 'URL prodotto') urlColIdx = colNum
    })
    const urlToRowNum = new Map()
    if (urlColIdx > 0) {
      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return
        const cell = row.getCell(urlColIdx).value
        const u = (cell && typeof cell === 'object') ? cell.text : String(cell || '')
        if (u) { doneUrls.add(u); urlToRowNum.set(u, rowNum) }
      })
    }
    return { wb, sheet, doneUrls, urlToRowNum, activeCols }
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  const sheet = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] })
  activeCols.forEach((c, i) => { sheet.getColumn(i + 1).width = c.width })
  sheet.addRow(activeCols.map(c => c.header))
  applyHeaderStyling(sheet)
  await wb.xlsx.writeFile(outputFile)
  return { wb, sheet, doneUrls, urlToRowNum: new Map(), activeCols }
}

// ─── Main ─────────────────────────────────────────────────────────

async function run(settings, onLog) {
  const log = (msg) => { console.log(`[HF] ${msg}`); if (onLog) onLog(msg) }

  const categoriesStr = settings.hf_categories || DEFAULT_CATEGORIES
  const categories    = categoriesStr.split(',').map(s => s.trim()).filter(Boolean)
  const delayMs       = parseInt(settings.hf_delay_ms) || 1500
  const forceUpdate   = settings.hf_force_update === 'true'

  let enabledKeys = null
  try { enabledKeys = JSON.parse(settings.hf_columns) } catch (_) {}

  const outputFile = path.join(OUTPUT_DIR, 'products.xlsx')
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  if (forceUpdate && fs.existsSync(outputFile)) {
    fs.unlinkSync(outputFile)
    log('File precedente eliminato — riscrapo da zero')
  }

  log(`Categorie: ${categories.join(', ')}`)

  const { wb, sheet, doneUrls, urlToRowNum, activeCols } = await loadOrCreateWorkbook(outputFile, enabledKeys)

  const browser = await launchBrowser(log)
  let page

  try {
    // Prima categoria = URL di warm-up per superare anti-bot
    page = await initSession(browser, `${BASE_URL}${LANG}/${categories[0]}`, log)

    log('[1/2] Raccolta URL prodotti...')
    const allUrls  = await collectProductUrls(categories, page, log)
    const toScrape = forceUpdate ? allUrls : allUrls.filter(u => !doneUrls.has(u))
    log(`URL trovati: ${allUrls.length} | Già fatti: ${doneUrls.size} | Da fare: ${toScrape.length}`)

    if (toScrape.length === 0) {
      log('Tutti i prodotti già scrapati — niente da fare.')
      return { productsCount: doneUrls.size, urlsCount: allUrls.length, xlsxPath: outputFile }
    }

    log(`[2/2] Scraping ${toScrape.length} prodotti...`)

    let writeQueue  = Promise.resolve()
    let doneCount   = forceUpdate ? 0 : doneUrls.size
    let errorCount  = 0
    const total     = toScrape.length

    const appendProduct = (product) => {
      writeQueue = writeQueue.then(async () => {
        const rowData = activeCols.map(c => product[c.key] ?? '')
        const existingRowNum = urlToRowNum.get(product.url)
        let row
        if (existingRowNum) {
          row = sheet.getRow(existingRowNum)
          rowData.forEach((val, i) => row.getCell(i + 1).value = val)
        } else {
          row = sheet.addRow(rowData)
          urlToRowNum.set(product.url, row.number)
        }
        const bg = (row.number - 2) % 2 === 0 ? 'FFFAFAFA' : 'FFEFEFEF'
        row.height = 18
        row.eachCell(cell => {
          cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
          cell.alignment = { vertical: 'top', wrapText: false }
        })
        const urlColPos = activeCols.findIndex(c => c.key === 'url') + 1
        if (urlColPos > 0 && product.url) {
          row.getCell(urlColPos).value = { text: product.url, hyperlink: product.url }
          row.getCell(urlColPos).font  = { color: { argb: 'FF0563C1' }, underline: true }
        }
        const dataRows = sheet.rowCount - 1
        let summary = wb.getWorksheet('Summary')
        if (!summary) summary = wb.addWorksheet('Summary')
        summary.getCell('A1').value = 'Last Updated'
        summary.getCell('B1').value = new Date().toISOString()
        summary.getCell('A2').value = 'Categories'
        summary.getCell('B2').value = categoriesStr
        summary.getCell('A3').value = 'Total Products'
        summary.getCell('B3').value = dataRows
        await wb.xlsx.writeFile(outputFile)
      })
      return writeQueue
    }

    for (let i = 0; i < toScrape.length; i++) {
      const url = toScrape[i]
      const num = ++doneCount
      try {
        const product = await scrapeProduct(page, url)
        appendProduct(product)
        log(`  [${num}/${total}] ✓ ${product.name.substring(0, 55)}`)
      } catch (err) {
        errorCount++
        log(`  [${num}/${total}] ✗ ${url.split('/').pop().substring(0, 40)} – ${err.message}`)
      }
      if (i < toScrape.length - 1) await sleep(delayMs)
    }

    await writeQueue

    const finalCount = doneCount - errorCount
    log(`Completato: ${finalCount} prodotti | Errori: ${errorCount}`)
    log(`Excel: ${outputFile}`)
    return { productsCount: finalCount, urlsCount: allUrls.length, xlsxPath: outputFile }

  } finally {
    await browser.close()
  }
}

module.exports = { run, COLUMNS, COLUMN_GROUPS, ALL_COLUMN_KEYS, DEFAULT_CATEGORIES }
