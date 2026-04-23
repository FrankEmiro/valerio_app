/**
 * browser.js – Puppeteer helper per risolvere challenge anti-bot (Imperva/Incapsula)
 * Lancia Chromium una volta, aspetta che la pagina carichi, estrae i cookie di sessione.
 */

const puppeteer = require('puppeteer-core')
const os = require('os')
const fs = require('fs')

function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  const candidates = os.platform() === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/chromium-browser',
      ]
    : [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ]
  return candidates.find(p => fs.existsSync(p)) || null
}

/**
 * Naviga a `url` con un browser reale, aspetta che la pagina si stabilizzi,
 * e restituisce i cookie come stringa (format: "nome=valore; nome2=valore2").
 */
async function fetchCookiesViaBrowser(url, onLog) {
  const executablePath = findChromium()
  if (!executablePath) {
    throw new Error(
      'Chromium non trovato. Imposta la variabile d\'ambiente PUPPETEER_EXECUTABLE_PATH, ' +
      'oppure installa Chrome/Chromium.'
    )
  }

  onLog?.(`[browser] Avvio Chromium: ${executablePath}`)
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    )
    // Nascondi webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    onLog?.(`[browser] Navigo: ${url}`)
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 40000 })

    // Attesa extra se la pagina contiene ancora una challenge
    const title = await page.title()
    if (title.toLowerCase().includes('anti-robot') || title.toLowerCase().includes('validation')) {
      onLog?.('[browser] Challenge rilevata, attendo risoluzione...')
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {})
    }

    const cookies = await page.cookies()
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    onLog?.(`[browser] Cookie estratti (${cookies.length} totali)`)
    return cookieStr
  } finally {
    await browser.close()
  }
}

module.exports = { fetchCookiesViaBrowser }
