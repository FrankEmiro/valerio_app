/**
 * scraper.js – Fase 2: scrapa i dettagli di ogni prodotto
 * e produce output/{brand}.csv e output/{brand}.xlsx
 */

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const cheerio = require('cheerio')
const crypto = require('crypto')
const ExcelJS = require('exceljs')
const createCsvWriter = require('csv-writer').createObjectCsvWriter
const unescapeJs = require('unescape-js')

const ARCHIVE_DIR = path.join(__dirname, '..', 'archive')
const OUTPUT_DIR = path.join(__dirname, '..', 'output')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const { ALL_COLUMNS, filterColumns } = require('./columns')

const escapeSpecialChars = (s) => s.replace(/[\x00-\x1F\x7F-\x9F]/g, '')

function emptyOutput() {
  const o = {}
  for (const col of COLUMNS) o[col] = ''
  o['Categorie correlate1'] = 'Home'
  return o
}

function createParentCode(row) {
  const keys = Object.values(row)
  const hasSize = keys.some(k => String(k).includes('Taglie') || String(k).includes('Taglia'))
  if (!hasSize) return ''

  const filteredValues = [row['Nome del prodotto'], row.Descrizione]
  let skipNext = false

  for (const key in row) {
    if (skipNext) { skipNext = false; continue }
    if (key.startsWith('Attributo')) {
      const num = key.match(/\d+/)?.[0]
      if (!num) continue
      const val = row[key]
      if (
        val === 'Codice articolo produttore' ||
        String(val).includes('Taglie') ||
        String(val).includes('Taglia') ||
        String(val).includes('Colore')
      ) {
        skipNext = true
        continue
      }
      filteredValues.push(row[`Valore ${num}`])
    }
  }

  const hash = crypto.createHash('sha256').update(filteredValues.join('')).digest('hex')
  return parseInt(hash, 16)
}

function renameParentCodes(products) {
  const uniqueValues = {}
  let nextId = 1

  // Azzera i parent code che appaiono solo una volta
  const counts = {}
  for (const p of products) {
    const pc = p['Parent code']
    if (pc) counts[pc] = (counts[pc] || 0) + 1
  }

  return products.map(p => {
    let pc = p['Parent code']
    if (!pc || counts[pc] < 2) {
      p['Parent code'] = ''
      return p
    }
    if (uniqueValues[pc] === undefined) {
      uniqueValues[pc] = nextId++
    }
    p['Parent code'] = uniqueValues[pc]
    return p
  })
}

const makeHeaders = (cookie, referer, isAjax = false) => ({
  accept: isAjax
    ? 'application/json, text/javascript, */*; q=0.01'
    : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,it;q=0.8',
  'sec-ch-ua': '"Chromium";v="118", "Google Chrome";v="118", "Not=A?Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': isAjax ? 'empty' : 'document',
  'sec-fetch-mode': isAjax ? 'cors' : 'navigate',
  'sec-fetch-site': 'same-origin',
  ...(isAjax ? { 'x-requested-with': 'XMLHttpRequest' } : { 'upgrade-insecure-requests': '1' }),
  cookie,
  ...(referer ? { Referer: referer, 'Referrer-Policy': 'strict-origin-when-cross-origin' } : {})
})

// Carica il file done_{brand}.json per sapere quali URL sono già stati scrapati
function loadDone(brand) {
  const file = path.join(ARCHIVE_DIR, `done_${brand}.json`)
  if (fs.existsSync(file)) return new Set(JSON.parse(fs.readFileSync(file, 'utf8')))
  return new Set()
}

function saveDone(brand, done) {
  const file = path.join(ARCHIVE_DIR, `done_${brand}.json`)
  fs.writeFileSync(file, JSON.stringify([...done], null, 2))
}

async function scrapeProduct(url1, cookie) {
  try {
    const response = await axios.get(url1, {
      headers: makeHeaders(cookie, 'https://www.partseurope.eu/it/brands/'),
      timeout: 30000
    })

    // Cattura cookie di sessione dalla risposta per usarli nelle chiamate AJAX
    const setCookieHeaders = response.headers['set-cookie'] || []
    const sessionCookie = setCookieHeaders.length > 0
      ? setCookieHeaders.map(c => c.split(';')[0]).join('; ')
      : cookie

    const output = emptyOutput()
    const html = response.data
    const $ = cheerio.load(html)

    // JSON-LD strutturato
    const scriptEl = $('script[type="application/ld+json"]:contains("description")')
    if (!scriptEl.length) {
      console.log(`  [SKIP] Nessun JSON-LD in ${url1}`)
      return null
    }

    let jsonData
    try {
      jsonData = JSON.parse(escapeSpecialChars(scriptEl.html()).replace(/&#039;/g, "'"))
    } catch (e) {
      console.log(`  [SKIP] JSON-LD non parsabile in ${url1}`)
      return null
    }

    // Senza immagini saltiamo
    if (!jsonData.image || jsonData.image.length === 0) {
      console.log(`  [SKIP] Nessuna immagine in ${url1}`)
      return null
    }

    // Dati di base
    const codice_produttore = $('div.name:contains("Codice articolo produttore")').next('div.value')?.text()?.trim() || ''
    const titolo_prodotto = $('h1.notranslate')?.text()?.trim() || jsonData.name || ''

    // Stock
    const inStockEl = $('.item-information div.in-stock').first()
    let stock_eu = ''
    let stock_us = ''
    if (inStockEl.find('div.country.eu').length > 0) {
      stock_eu = inStockEl.find('div.quantity span.number').first().text().trim().replace(/\+/, '')
    }
    if (inStockEl.find('div.country.us').length > 0) {
      stock_us = inStockEl.find('div.quantity span.number').first().text().trim().replace(/\+/, '')
    }

    // Codici OEM
    const oemCodes = []
    $('table.table.oem-make-number label').each((_, el) => {
      oemCodes.push($(el).text().trim())
    })

    // Categorie breadcrumb
    const categories_texts = []
    $('[itemtype="https://schema.org/BreadcrumbList"] li a span[itemprop]').each((_, el) => {
      const t = $(el).text().trim()
      if (t && t !== 'Pagina iniziale') categories_texts.push(t)
    })
    const unique_cats = [...new Set(categories_texts)]
    for (let i = 0; i < unique_cats.length && i < 5; i++) {
      output[`Categorie correlate${i + 2}`] = unique_cats[i]
    }

    // Dati prodotto
    const brandName = jsonData.brand?.name || ''
    output['Nome del prodotto'] = `${titolo_prodotto} ${brandName}`.trim()
    output.Brand = brandName
    output['Codice di riferimento'] = jsonData.sku || jsonData.mpn || ''
    output['Codice produttore'] = codice_produttore
    output['Magazzino EU'] = stock_eu
    output['Magazzino US'] = stock_us
    output['Meta titolo'] = output['Nome del prodotto']
    output['Meta descrizione'] = output['Nome del prodotto']

    const infoText = $('[data-tab="information"] .col-xs-12')?.text()?.trim() || ''
    const h2 = `<h2>${output['Nome del prodotto']}</h2>`
    output.Descrizione = oemCodes.length > 0
      ? `${h2}\n${infoText} Codici Oem - ${oemCodes.join(', ')}`
      : `${h2}\n${infoText}`
    output.Descrizione = output.Descrizione.replace(/&quot;/g, '"')

    output.Url = jsonData.offers?.url || url1
    output['Images url'] = Array.isArray(jsonData.image) ? jsonData.image.join(',') : jsonData.image
    output['Prezzo di acquisto tasse escluse'] = jsonData.offers?.price || ''
    output['Prezzo di vendita tasse incl'] = jsonData.offers?.price || ''

    // Applicazioni (fitments AJAX – usa POST come da JS del sito)
    let applicazioni = []
    if ($('a[data-target="fitments"]').length > 0) {
      const tableEl = $('table#fitments-table')
      const dataId = tableEl.attr('data-id')
      const dataToken = tableEl.attr('data-token')

      const matchTot = /\((\d+)\)/.exec($('a[data-target="fitments"]').text())
      const tot = matchTot ? parseInt(matchTot[1]) : 0
      console.log(`  Applicazioni da scaricare: ${tot}`)

      const length = 100
      let start = 0
      while (start < tot) {
        try {
          const params = new URLSearchParams()
          params.append('start', String(start))
          params.append('length', String(length))
          params.append('partNumber', dataId)
          params.append('_csrf_token', dataToken)

          const res2 = await axios.post(
            'https://www.partseurope.eu/it/product/ajax/get-fitments',
            params,
            {
              headers: {
                accept: 'application/json, text/javascript, */*; q=0.01',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'sec-ch-ua': '"Chromium";v="118", "Google Chrome";v="118", "Not=A?Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"macOS"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'x-requested-with': 'XMLHttpRequest',
                cookie: sessionCookie,
                Referer: url1,
                'Referrer-Policy': 'strict-origin-when-cross-origin'
              },
              timeout: 20000
            }
          )

          const items = res2.data?.data?.data || []
          applicazioni = [...applicazioni, ...items]
          start += items.length
          if (items.length === 0) break
          await sleep(300)
        } catch (e) {
          console.log(`  Errore fitments a start=${start}: ${e.message}`)
          break
        }
      }

      // Deduplica per id
      const seenIds = new Set()
      applicazioni = applicazioni.filter(a => {
        if (seenIds.has(a.id)) return false
        seenIds.add(a.id)
        return true
      })

      console.log(`  Applicazioni scaricate: ${applicazioni.length}`)
      output.Applicazioni = applicazioni.map(a =>
        `${a.bikeProducer} ${a.bikeModel} ${a.year} ${a.salesName} ${a.country}`
      ).join(';')
    }

    // Attributi (tab information)
    const namesArray = $("[data-tab='information'] .name")
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
    const valuesArray = $("[data-tab='information'] .value")
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()

    if (oemCodes.length > 0) {
      namesArray.push('Codici OEM')
      valuesArray.push(oemCodes.join(', '))
    }

    if (namesArray.length === valuesArray.length) {
      for (let i = 0; i < namesArray.length && i < 20; i++) {
        output[`Attributo ${i + 1}`] = namesArray[i]
        output[`Valore ${i + 1}`] = valuesArray[i]
      }
    }

    // Varianti URL (da javascript variantFilters)
    const variantUrls = []
    $('script').each((_, el) => {
      const content = $(el).html() || ''
      if (content.includes('const variantFilters')) {
        try {
          let cleaned = content.replace(/const currentPartNumber = '[^']+'\n/g, '')
          const start = cleaned.indexOf("'")
          const end = cleaned.lastIndexOf("'") + 1
          let extracted = cleaned.substring(start, end).replace(/'/g, '')
          const jsonObj = JSON.parse(unescapeJs(extracted))
          for (const key in jsonObj) {
            const inner = jsonObj[key]
            for (const v of Object.values(inner.values)) {
              const links = v.parts.split(',').map(n => {
                const parts = url1.split('/')
                parts[parts.length - 1] = n
                return parts.join('/')
              }).filter(u => u !== url1)
              variantUrls.push(...links)
            }
          }
        } catch (e) { /* non bloccante */ }
      }
    })

    // Varianti da part-list-preview
    if ($('table.table#part-list-preview').length > 0) {
      try {
        const dataVariantToken = $('.part-variants').attr('data-token')
        const variantApiUrl = `${url1}/parts`
        const varHeaders = {
          ...makeHeaders(cookie, url1, true),
          accept: '*/*',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
        }
        const res3 = await axios.post(
          variantApiUrl,
          `page=1&limit=1000&availableFilterOptionIds=false&template=row&_csrf_token=${dataVariantToken}`,
          { headers: varHeaders, timeout: 20000 }
        )
        const items = res3.data?.data?.items || []
        const baseUrl = 'https://www.partseurope.eu'
        for (const html of items) {
          const match = html.match(/<a href="([^"]+)"/)
          if (match?.[1]) variantUrls.push(baseUrl + match[1])
        }
      } catch (e) { /* non bloccante */ }
    }

    output['Parent code'] = createParentCode(output)

    return { output, variantUrls: [...new Set(variantUrls)].filter(u => u !== url1) }
  } catch (e) {
    console.error(`  [ERRORE] ${url1}: ${e.message}`)
    return null
  }
}

async function appendToCsv(brand, record, columns) {
  const csvPath = path.join(OUTPUT_DIR, `${brand}.csv`)
  const fileExists = fs.existsSync(csvPath)
  // Filtra il record alle sole colonne abilitate
  const filteredRecord = {}
  for (const col of columns) filteredRecord[col] = record[col] ?? ''
  const writer = createCsvWriter({
    path: csvPath,
    header: columns.map(k => ({ id: k, title: k })),
    append: fileExists
  })
  await writer.writeRecords([filteredRecord])
}

async function scrapeAll(brand, cookie, enabledColumns = null, onLog = null) {
  const archivePath = path.join(ARCHIVE_DIR, `${brand}.json`)
  if (!fs.existsSync(archivePath)) {
    console.error(`Archivio non trovato: ${archivePath}`)
    console.error('Esegui prima la Fase 1 (get_urls) o esegui senza --only-scrape')
    return
  }

  const columns = filterColumns(enabledColumns)
  const log = (msg) => { console.log(msg); if (onLog) onLog(msg) }

  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'))
  const done = loadDone(brand)
  const allRecords = []

  log(`Prodotti nell'archivio: ${archive.length}`)
  log(`Già scrapati: ${done.size}`)
  log(`Colonne abilitate: ${columns.length}/${ALL_COLUMNS.length}`)

  for (let i = 0; i < archive.length; i++) {
    const { link } = archive[i]
    const url = 'https://www.partseurope.eu' + link

    if (done.has(url)) continue

    log(`[${i + 1}/${archive.length}] Scraping: ${link}`)
    const result = await scrapeProduct(url, cookie)

    if (result) {
      const { output, variantUrls } = result
      await appendToCsv(brand, output, columns)
      allRecords.push(output)
      done.add(url)

      for (const vUrl of variantUrls) {
        if (done.has(vUrl)) continue
        log(`  → Variante: ${vUrl}`)
        const vResult = await scrapeProduct(vUrl, cookie)
        if (vResult) {
          await appendToCsv(brand, vResult.output, columns)
          allRecords.push(vResult.output)
        }
        done.add(vUrl)
        await sleep(600)
      }
    }

    done.add(url)
    saveDone(brand, done)
    await sleep(1000)
  }

  // Excel finale
  log('\nGenerazione Excel finale...')
  let finalRecords = allRecords
  const csvPath = path.join(OUTPUT_DIR, `${brand}.csv`)
  if (fs.existsSync(csvPath)) {
    try {
      const csvParser = require('csv-parser')
      const rows = []
      await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
          .pipe(csvParser())
          .on('data', row => rows.push(row))
          .on('end', resolve)
          .on('error', reject)
      })
      finalRecords = rows
    } catch (e) { /* usa allRecords */ }
  }

  const renamed = renameParentCodes(finalRecords)

  const workbook = new ExcelJS.Workbook()
  const ws = workbook.addWorksheet('Prodotti')
  ws.columns = columns.map(k => ({ header: k, key: k, width: 20 }))
  ws.addRows(renamed)

  const xlsxPath = path.join(OUTPUT_DIR, `${brand}.xlsx`)
  await workbook.xlsx.writeFile(xlsxPath)
  log(`Excel salvato: ${xlsxPath}`)
  log(`CSV salvato: ${csvPath}`)

  return { productsCount: renamed.length, urlsCount: archive.length, xlsxPath }
}

module.exports = { scrapeAll }
