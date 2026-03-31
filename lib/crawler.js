/**
 * crawler.js – Fase 1: raccoglie tutti gli URL prodotti di un brand
 * e li salva in archive/{brand}.json
 */

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const cheerio = require('cheerio')

const ARCHIVE_DIR = path.join(__dirname, '..', 'archive')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const makeHeaders = (cookie, referer) => ({
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-US,en;q=0.9,it;q=0.8',
  'cache-control': 'max-age=0',
  'sec-ch-ua': '"Chromium";v="118", "Google Chrome";v="118", "Not=A?Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'upgrade-insecure-requests': '1',
  cookie,
  ...(referer ? { Referer: referer } : {})
})

function loadArchive(brand) {
  const file = path.join(ARCHIVE_DIR, `${brand}.json`)
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  return []
}

function saveArchive(brand, data) {
  const file = path.join(ARCHIVE_DIR, `${brand}.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

async function scrapePage(brand, page, cookie) {
  const url = `https://www.partseurope.eu/it/brands/${brand}?available=all&specialSale=false&pageLimit=48&page=${page}`
  try {
    const response = await axios.get(url, {
      headers: makeHeaders(cookie, 'https://www.partseurope.eu/it/brands/'),
      timeout: 30000
    })
    const $ = cheerio.load(response.data)
    const products = []
    const seen = new Set()

    // Selettori compatibili con layout nuovo (a.product-detail) e vecchio (.product-1)
    $('a[href*="/it/product/"], .product-1 a.title').each((_, el) => {
      const link = $(el).attr('href')
      if (!link || seen.has(link)) return
      // Esclude link che non sono pagine prodotto
      if (!link.match(/\/it\/product\/[^/]+\/[^/]+$/)) return
      seen.add(link)
      products.push({ link, variants: '0' })
    })

    console.log(`  Pagina ${page}: trovati ${products.length} prodotti`)
    return products
  } catch (err) {
    console.error(`  Errore pagina ${page}: ${err.message}`)
    return []
  }
}

async function getUrls(brand, maxPages = 50, cookie) {
  console.log(`Raccolta URL per brand: ${brand}`)

  const existing = loadArchive(brand)
  const existingLinks = new Set(existing.map(p => p.link))
  let all = [...existing]
  let index = existing.length + 1

  for (let page = 1; page <= maxPages; page++) {
    const products = await scrapePage(brand, page, cookie)

    if (products.length === 0) {
      console.log(`  Nessun prodotto a pagina ${page}, fine.`)
      break
    }

    let added = 0
    for (const p of products) {
      if (!existingLinks.has(p.link)) {
        p.index = index++
        all.push(p)
        existingLinks.add(p.link)
        added++
      }
    }

    saveArchive(brand, all)
    console.log(`  Salvati ${added} nuovi URL (totale: ${all.length})`)

    await sleep(800)
  }

  console.log(`\nTotale URL archiviati: ${all.length}`)
  return all
}

module.exports = { getUrls }
