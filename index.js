/* eslint-disable camelcase */
/**
 * Partseurope.eu Brand Scraper
 *
 * COME USARLO:
 *   node index.js saddlemen-1          → scrapa saddlemen, pagine auto-detect
 *   node index.js saddlemen-1 5        → scrapa saddlemen, max 5 pagine
 *   node index.js saddlemen-1 --only-urls   → solo fase 1 (scarica URL lista prodotti)
 *   node index.js saddlemen-1 --only-scrape → solo fase 2 (scrapa prodotti dall'archivio)
 *
 * BRAND SLUG: il nome del brand come appare nell'URL partseurope.eu
 *   Es: https://www.partseurope.eu/it/brands/saddlemen-1  → slug = "saddlemen-1"
 *
 * COOKIE: aggiorna COOKIE qui sotto se il sito inizia a bloccare le richieste
 */

const { getUrls } = require('./lib/crawler')
const { scrapeAll } = require('./lib/scraper')

// ─────────────────────────────────────────────────────────────
// CONFIGURAZIONE – modifica qui se vuoi un brand fisso di default
// ─────────────────────────────────────────────────────────────
const DEFAULT_BRAND = 'saddlemen-1'
const DEFAULT_MAX_PAGES = 50 // numero massimo pagine da esplorare (si ferma prima se finisce)

// Cookie di sessione – aggiornalo se il sito blocca le richieste
const COOKIE = 'maxPerPage=24; pe-cookie=[%22functional-cookies%22%2C%22preference-cookies%22%2C%22analytics-cookies%22%2C%22external-cookies%22]; userCountry=IT; user_locale=it; PHPSESSID=78v1r7rpif0e11sra05hqect5k; _ga=GA1.2.758143841.1706784723'

// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const brand = args.find(a => !a.startsWith('--') && isNaN(a)) || DEFAULT_BRAND
const maxPages = parseInt(args.find(a => !isNaN(a) && !a.startsWith('--'))) || DEFAULT_MAX_PAGES
const onlyUrls = args.includes('--only-urls')
const onlyScrape = args.includes('--only-scrape')

async function main() {
  console.log(`\n========================================`)
  console.log(`  Brand: ${brand}`)
  console.log(`  Max pagine: ${maxPages}`)
  console.log(`========================================\n`)

  if (!onlyScrape) {
    console.log('FASE 1 – Raccolta URL prodotti...')
    await getUrls(brand, maxPages, COOKIE)
  }

  if (!onlyUrls) {
    console.log('\nFASE 2 – Scraping prodotti...')
    await scrapeAll(brand, COOKIE)
  }

  console.log('\nDone!')
}

main().catch(console.error)
