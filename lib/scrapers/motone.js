/**
 * motone.js – Scraper per motone.co.uk
 * Adattato da scraper/scraper.js per funzionare come modulo con settings + onLog
 */

const axios = require('axios')
const cheerio = require('cheerio')
const ExcelJS = require('exceljs')
const path = require('path')
const fs = require('fs')

const BASE_URL = 'https://www.motone.co.uk'
const OUTPUT_DIR = path.join(__dirname, '../../output/motone')

const COLUMNS = [
  { key: 'title',            header: 'Product Name',        width: 55 },
  { key: 'brand',            header: 'Brand',               width: 14 },
  { key: 'reference',        header: 'Part ID / Reference', width: 18 },
  { key: 'price',            header: 'Price (GBP inc VAT)', width: 18 },
  { key: 'price_eur',        header: 'Prezzo EU (cambio)',  width: 22 },
  { key: 'price_vale',       header: 'Prezzo Vale (+8%)',   width: 20 },
  { key: 'shipping',         header: 'Shipping',            width: 14 },
  { key: 'stockStatus',      header: 'Stock Status',        width: 14 },
  { key: 'stockMessage',     header: 'Stock Message',       width: 32 },
  { key: 'description',      header: 'Description',         width: 65 },
  { key: 'imageUrl',         header: 'Main Image URL',      width: 80 },
  { key: 'additionalImages', header: 'Additional Images',   width: 60 },
  { key: 'breadcrumb',       header: 'Category Path',       width: 55 },
  { key: 'category',         header: 'Category',            width: 30 },
  { key: 'url',              header: 'Product URL',         width: 80 },
  { key: 'parentProductId',  header: 'Parent Product ID',   width: 16 },
  { key: 'subProductId',     header: 'Sub Product ID',      width: 14 },
]

const COL = Object.fromEntries(COLUMNS.map((c, i) => [c.key, i + 1]))

const DEFAULT_CHILD_CATEGORIES =
  '26|25|123|120|98|99|100|101|102|103|104|105|106|107|108|109|110|111|112|113|114|115|116|117|118|69|70|74|75|76|97|119|121|122'

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.5',
  'Connection': 'keep-alive',
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Tasso di cambio GBP→EUR ───────────────────────────────────────

async function fetchGbpToEur() {
  try {
    const resp = await axios.get('https://api.frankfurter.app/latest?from=GBP&to=EUR', { timeout: 6000 })
    return resp.data?.rates?.EUR || null
  } catch (_) {
    try {
      // fallback
      const resp2 = await axios.get('https://open.er-api.com/v6/latest/GBP', { timeout: 6000 })
      return resp2.data?.rates?.EUR || null
    } catch (_) { return null }
  }
}

function parseGbpAmount(priceStr) {
  if (!priceStr) return null
  const match = String(priceStr).replace(',', '').match(/[\d.]+/)
  return match ? parseFloat(match[0]) : null
}

function buildPriceEur(priceStr, rate) {
  if (!rate) return ''
  const gbp = parseGbpAmount(priceStr)
  if (gbp == null) return ''
  return parseFloat((gbp * rate).toFixed(2))
}

function buildPriceVale(priceStr, rate) {
  if (!rate) return ''
  const gbp = parseGbpAmount(priceStr)
  if (gbp == null) return ''
  return parseFloat((gbp * rate * 1.08).toFixed(2))
}
function toAbsoluteUrl(href) {
  if (!href) return ''
  return href.startsWith('http') ? href : `${BASE_URL}${href}`
}

function toZoomUrl(src) {
  if (!src) return ''
  return src
    .replace(/_thumbmini\.(jpg|jpeg|png|webp)/i, '_zoom.$1')
    .replace(/_thumb\.(jpg|jpeg|png|webp)/i, '_zoom.$1')
    .replace(/_medium\.(jpg|jpeg|png|webp)/i, '_zoom.$1')
    .replace(/_small\.(jpg|jpeg|png|webp)/i, '_zoom.$1')
}

// ─── Excel ────────────────────────────────────────────────────────

function applyHeaderStyling(sheet) {
  const row = sheet.getRow(1)
  row.height = 22
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a20' } }
    cell.font = { bold: true, color: { argb: 'FFf97316' }, size: 11 }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
}

function applyDataRowStyling(row, product, activeCols) {
  const bg = (row.number - 2) % 2 === 0 ? 'FFFAFAFA' : 'FFEFEFEF'
  row.height = 18
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
    cell.alignment = { vertical: 'top', wrapText: false }
  })
  // helper: posizione colonna nel foglio filtrato (1-based)
  const pos = (key) => activeCols.findIndex(c => c.key === key) + 1

  const descPos = pos('description')
  if (descPos > 0) row.getCell(descPos).alignment = { vertical: 'top', wrapText: true }

  const ssPos = pos('stockStatus')
  if (ssPos > 0) row.getCell(ssPos).font =
    product.stockStatus === 'In Stock'
      ? { color: { argb: 'FF217A3C' }, bold: true }
      : { color: { argb: 'FFCC0000' }, bold: true }

  const urlPos = pos('url')
  if (urlPos > 0 && product.url) {
    row.getCell(urlPos).value = { text: product.url, hyperlink: product.url }
    row.getCell(urlPos).font = { color: { argb: 'FF0563C1' }, underline: true }
  }

  const eurPos = pos('price_eur')
  if (eurPos > 0 && product.price_eur)
    row.getCell(eurPos).font = { color: { argb: 'FF1a5c91' } }

  const valePos = pos('price_vale')
  if (valePos > 0 && product.price_vale)
    row.getCell(valePos).font = { color: { argb: 'FF2a7a4f' }, bold: true }
}

async function loadOrCreateWorkbook(outputFile, enabledKeys) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Valerio Scraper – MotoOne'
  const doneUrls = new Set()

  const activeCols = enabledKeys
    ? COLUMNS.filter(c => enabledKeys.includes(c.key))
    : COLUMNS

  // Tenta lettura file esistente
  let fileLoaded = false
  try {
    await wb.xlsx.readFile(outputFile)
    fileLoaded = true
  } catch (_) {}

  if (fileLoaded) {
    let sheet = wb.getWorksheet('Products')
    if (!sheet) {
      // file esiste ma senza foglio Products – lo crea
      sheet = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] })
      sheet.addRow(activeCols.map(c => c.header))
      applyHeaderStyling(sheet)
    }
    activeCols.forEach((c, i) => { sheet.getColumn(i + 1).width = c.width })

    // Trova la colonna URL per header (robusto a cambiamenti di struttura)
    let fileUrlColIdx = 0
    sheet.getRow(1).eachCell((cell, colNum) => {
      if (String(cell.value ?? '') === 'Product URL') fileUrlColIdx = colNum
    })
    if (fileUrlColIdx > 0) {
      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return
        const cell = row.getCell(fileUrlColIdx).value
        const url = (cell && typeof cell === 'object') ? cell.text : String(cell || '')
        if (url) doneUrls.add(url)
      })
    }
    return { wb, sheet, doneUrls, activeCols }
  }

  // Crea da zero
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  const sheet = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] })
  activeCols.forEach((c, i) => { sheet.getColumn(i + 1).width = c.width })
  sheet.addRow(activeCols.map(c => c.header))
  applyHeaderStyling(sheet)

  const sum = wb.addWorksheet('Summary')
  sum.getColumn(1).width = 20; sum.getColumn(2).width = 60

  await wb.xlsx.writeFile(outputFile)
  return { wb, sheet, doneUrls, activeCols }
}

// ─── Scraping ──────────────────────────────────────────────────────

async function collectProductLinks(categoryUrl, maxNeeded, childCategories, sessionCookie) {
  const links = new Set()
  const slug = categoryUrl.split('/').pop()
  const catIdMatch = slug.match(/-c(\d+)$/)
  const catId = catIdMatch ? catIdMatch[1] : ''
  if (!catId) throw new Error(`Impossibile estrarre category ID da: ${categoryUrl}`)

  const ajaxHeaders = {
    ...HTTP_HEADERS,
    'accept': '*/*',
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'Referer': categoryUrl,
    ...(sessionCookie ? { cookie: sessionCookie } : {})
  }

  let page = 1
  while (links.size < maxNeeded) {
    const ajaxUrl = `${BASE_URL}/ajax/getProductListings?base_url=${slug}&page_type=productlistings&page_variant=show&parent_category_id[]=${catId}&all_upcoming_flag[]=78&keywords=&show=&sort=&page=${page}&child_categories[]=${childCategories}&transport=html`
    let html
    try {
      const resp = await axios.get(ajaxUrl, { headers: ajaxHeaders, timeout: 15000 })
      html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
    } catch (err) {
      break
    }
    if (!html || html.trim() === '') break
    const $ = cheerio.load(html)
    if ($('#search_results_cms').length || /unable to find any products/i.test(html)) break
    const prevSize = links.size
    const container = $('#product_listings_repeat').length ? $('#product_listings_repeat') : $('body')
    container.find('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (href && /\-p\d+$/.test(href)) links.add(toAbsoluteUrl(href))
    })
    if (links.size === prevSize) break
    page++
    await sleep(500)
  }
  return [...links]
}

async function fetchAjaxData(parentProductId, subProductId) {
  try {
    const url = `${BASE_URL}/ajax/get_product_options/${parentProductId}/${subProductId}?cmd=addtobasket&parent_product_id=${parentProductId}&product_id=${subProductId}&image_product_id=0&image_id=0&image_index=0&quantity=1`
    const resp = await axios.get(url, {
      headers: { ...HTTP_HEADERS, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, */*' },
      timeout: 8000
    })
    const data = resp.data
    const entries = Array.isArray(data?.selection) ? data.selection : Object.values(data?.selection || {})
    if (entries.length > 0) {
      const sel = entries[0]
      const descHtml = sel.product_description || ''
      return {
        brand: sel.title_manufacturer || '',
        ajaxReference: sel.reference || '',
        description: descHtml.trim() ? cheerio.load(descHtml).text().replace(/\s+/g, ' ').trim() : ''
      }
    }
  } catch (_) {}
  return { brand: '', ajaxReference: '', description: '' }
}

async function scrapeProduct(url) {
  const resp = await axios.get(url, { headers: HTTP_HEADERS, timeout: 15000 })
  const $ = cheerio.load(resp.data)
  const parentProductId = $('input[name="parent_product_id"]').val() || ''
  const subProductId = $('input[name="product_id"]').val() || ''
  const title = $('#product_title').text().replace(/\s+/g, ' ').trim()
  let brand = $('#product_brand_title').text().trim() || $('#product_page_brand a').attr('title') || ''
  const reference = $('#product_reference_holder #product_reference').text().trim() || $('#product_reference').text().trim()
  const priceRaw = $('.GBP[itemprop="price"]').text().trim()
  const priceContent = $('[itemprop="price"][content]').attr('content')
  const price = priceRaw ? parseGbpAmount(priceRaw) : (priceContent ? parseFloat(priceContent) : '')
  const shippingRaw = $('#product_shipping_price .inc .GBP').first().text().trim()
  const shipping = shippingRaw ? (parseGbpAmount(shippingRaw) ?? shippingRaw) : ''
  const inStockStyle = $('.product_in_stock').attr('style') || ''
  const outStockStyle = $('.product_out_stock').attr('style') || ''
  const stockStatus = (inStockStyle.includes('inline') || (!inStockStyle.includes('none') && inStockStyle !== '') || outStockStyle.includes('none')) ? 'In Stock' : 'Out of Stock'
  const stockMessage = $('#product_stock_mesage').text().trim()
  const imageUrl = toZoomUrl(toAbsoluteUrl($('#product_medium_image').attr('src') || ''))
  const thumbUrls = []
  $('#product_thumb_images img').each((_, el) => {
    const src = $(el).attr('src')
    if (src) thumbUrls.push(toZoomUrl(toAbsoluteUrl(src)))
  })
  // additionalImages: main image sempre prima, poi i thumb (deduplicati)
  const seen = new Set()
  const allImages = [imageUrl, ...thumbUrls].filter(u => u && !seen.has(u) && seen.add(u))
  const breadcrumb = $('#breadcrumb_container p').text().replace(/\s+/g, ' ').replace(/›/g, '>').trim()
  const breadcrumbParts = breadcrumb.split('>').map(s => s.trim()).filter(Boolean)
  const category = breadcrumbParts.length >= 2 ? breadcrumbParts[breadcrumbParts.length - 2] : (breadcrumbParts[0] || '')
  let description = $('#product_summary').text().replace(/\s+/g, ' ').trim() || $('#care_tab_content').text().replace(/\s+/g, ' ').trim()
  let finalReference = reference
  if (parentProductId && subProductId) {
    const ajax = await fetchAjaxData(parentProductId, subProductId)
    if (ajax.brand) brand = ajax.brand
    if (ajax.ajaxReference) finalReference = ajax.ajaxReference
    if (!description && ajax.description) description = ajax.description
  }
  if (!description) description = $('meta[name="description"]').attr('content') || ''
  return { title, brand, reference: finalReference, price, shipping, stockStatus, stockMessage, description, imageUrl, additionalImages: allImages.join(', '), breadcrumb, category, url, parentProductId, subProductId }
}

// ─── Main run function ─────────────────────────────────────────────

async function run(settings, onLog) {
  const log = (msg) => { console.log(msg); if (onLog) onLog(msg) }

  const categoryUrl = settings.mo_category_url || `${BASE_URL}/motorcycle-parts-c26`
  const maxProducts = parseInt(settings.mo_max_products) || 1000
  const concurrency = parseInt(settings.mo_concurrency) || 5
  const delayMs = parseInt(settings.mo_delay_ms) || 1500
  const childCategories = settings.mo_child_categories || DEFAULT_CHILD_CATEGORIES
  const sessionCookie = settings.mo_session_cookie || ''

  let enabledKeys = null
  try {
    enabledKeys = JSON.parse(settings.mo_columns)
  } catch (e) {}

  const outputFile = path.join(OUTPUT_DIR, 'products.xlsx')
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  log(`MotoOne – Category: ${categoryUrl}`)
  log(`Max prodotti: ${maxProducts} | Concorrenza: ${concurrency}`)

  log('Recupero tasso GBP→EUR...')
  const gbpEurRate = await fetchGbpToEur()
  if (gbpEurRate) log(`Tasso live: 1 GBP = ${gbpEurRate.toFixed(4)} EUR`)
  else log('Tasso non disponibile – colonne prezzo EUR lasciate vuote')

  const { wb, sheet, doneUrls, activeCols } = await loadOrCreateWorkbook(outputFile, enabledKeys)

  log(`[1/2] Raccolta link prodotti...`)
  const allLinks = await collectProductLinks(categoryUrl, maxProducts, childCategories, sessionCookie)
  const toScrape = allLinks.slice(0, maxProducts).filter(u => !doneUrls.has(u))
  log(`Trovati: ${allLinks.length} | Già fatti: ${doneUrls.size} | Da fare: ${toScrape.length}`)

  if (toScrape.length === 0) {
    log('Tutti i prodotti già scrapati — niente da fare.')
    return { productsCount: doneUrls.size, urlsCount: allLinks.length, xlsxPath: outputFile }
  }

  log(`[2/2] Scraping ${toScrape.length} prodotti...`)

  let writeQueue = Promise.resolve()
  const appendProduct = (product) => {
    writeQueue = writeQueue.then(async () => {
      product.price_eur = buildPriceEur(product.price, gbpEurRate)
      product.price_vale = buildPriceVale(product.price, gbpEurRate)
      const rowData = activeCols.map(c => product[c.key] ?? '')
      const row = sheet.addRow(rowData)
      applyDataRowStyling(row, product, activeCols)
      const dataRows = sheet.rowCount - 1
      let summary = wb.getWorksheet('Summary')
      if (!summary) summary = wb.addWorksheet('Summary')
      summary.getCell('A1').value = 'Last Updated'
      summary.getCell('B1').value = new Date().toISOString()
      summary.getCell('A2').value = 'Category URL'
      summary.getCell('B2').value = categoryUrl
      summary.getCell('A3').value = 'Total Products'
      summary.getCell('B3').value = dataRows
      await wb.xlsx.writeFile(outputFile)
    })
    return writeQueue
  }

  let doneCount = doneUrls.size
  let errorCount = 0
  const total = allLinks.slice(0, maxProducts).length

  async function worker(tasks, startIdx) {
    let i = startIdx
    while (i < tasks.length) {
      const url = tasks[i]
      i += concurrency
      const num = ++doneCount
      try {
        const product = await scrapeProduct(url)
        appendProduct(product)
        log(`  [${num}/${total}] ✓ ${product.title.substring(0, 50)}`)
      } catch (err) {
        errorCount++
        log(`  [${num}/${total}] ✗ ${url.split('/').pop().substring(0, 40)} – ${err.message}`)
      }
      await sleep(delayMs)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, toScrape.length) }, (_, i) =>
    worker(toScrape, i)
  )
  await Promise.all(workers)
  await writeQueue

  const finalCount = doneCount - errorCount
  log(`Completato: ${finalCount} prodotti | Errori: ${errorCount}`)
  log(`Excel: ${outputFile}`)

  return { productsCount: finalCount, urlsCount: allLinks.length, xlsxPath: outputFile }
}

// ─── Colonne per UI ────────────────────────────────────────────────

const COLUMN_GROUPS = [
  { id: 'product', label: 'Prodotto', icon: '⬡', columns: ['title', 'brand', 'reference', 'url'] },
  { id: 'pricing', label: 'Prezzi & Stock', icon: '◈', columns: ['price', 'price_eur', 'price_vale', 'shipping', 'stockStatus', 'stockMessage'] },
  { id: 'content', label: 'Contenuto', icon: '◉', columns: ['description'] },
  { id: 'category', label: 'Categorie', icon: '▦', columns: ['breadcrumb', 'category'] },
  { id: 'media', label: 'Media', icon: '▣', columns: ['imageUrl', 'additionalImages'] },
  { id: 'technical', label: 'Tecnico', icon: '≡', columns: ['parentProductId', 'subProductId'] },
]

const ALL_COLUMN_KEYS = COLUMNS.map(c => c.key)

module.exports = { run, COLUMNS, COLUMN_GROUPS, ALL_COLUMN_KEYS, DEFAULT_CHILD_CATEGORIES }
