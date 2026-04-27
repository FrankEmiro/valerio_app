const puppeteer = require('puppeteer-core')
const fs = require('fs')

function findChromium() {
  const c = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  return c.find(p => fs.existsSync(p)) || null
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: findChromium(), headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })

  const baseUrl = 'https://www.holyfreedom.com/it/uomo/giacche-certificate/prison-jacket'
  console.log('Navigating...')
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2000))

  // Get all radio inputs
  const radios = await page.evaluate(() =>
    [...document.querySelectorAll('input.input-radio[name^="group"]')].map((el, i) => ({
      index: i, title: el.title, value: el.value
    }))
  )
  console.log('Radios found:', radios.length)

  function readDataProduct(page) {
    return page.evaluate(() => {
      const el = document.querySelector('#product-details, .js-product-details')
      if (!el) return null
      try { return JSON.parse(el.dataset.product || 'null') } catch(_) { return null }
    })
  }

  const variants = []

  for (const radio of radios) {
    console.log(`\nClicking radio: ${radio.title} (value=${radio.value})...`)
    
    // Read current id_product_attribute before click
    const before = await readDataProduct(page)
    const prevId = before?.id_product_attribute

    // Click the radio
    await page.evaluate((value) => {
      const el = document.querySelector(`input.input-radio[value="${value}"]`)
      if (el) el.click()
    }, radio.value)

    // Wait up to 5s for data-product to update
    let dp = null
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 200))
      dp = await readDataProduct(page)
      if (dp && dp.id_product_attribute !== prevId) break
    }

    if (!dp) {
      console.log('  No data-product found')
      variants.push({ title: radio.title, error: 'no data' })
      continue
    }

    const attr = dp.attributes ? Object.values(dp.attributes)[0] : {}
    console.log(`  id_product_attribute: ${dp.id_product_attribute}`)
    console.log(`  attrName: ${attr?.name}`)
    console.log(`  ean13: ${attr?.ean13}`)
    console.log(`  upc: ${attr?.upc}`)
    console.log(`  quantity: ${dp.quantity}`)
    variants.push({
      title: radio.title,
      comboId: dp.id_product_attribute,
      ean13: attr?.ean13,
      upc: attr?.upc,
      quantity: dp.quantity,
    })
  }

  console.log('\n=== SUMMARY ===')
  variants.forEach(v => console.log(JSON.stringify(v)))

  await browser.close()
})()
