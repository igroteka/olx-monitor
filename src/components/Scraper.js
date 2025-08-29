// src/components/Scraper.js
const cheerio = require('cheerio')
const $logger = require('./Logger')
const $httpClient = require('./HttpClient.js')
const scraperRepository = require('../repositories/scrapperRepository.js')
const Ad = require('./Ad.js');

let page = 1
let validAds = 0
let sumPrices = 0
let minPrice = Infinity
let maxPrice = 0

// На olx.ua параметр пагинации = page
const setUrlParam = (url, param, value) => {
  const u = new URL(url)
  u.searchParams.set(param, value)
  return u.toString()
}

const urlAlreadySearched = async (url) => {
  try {
    const last = await scraperRepository.getLogsByUrl(url, 1)
    if (last.length) return true
    $logger.info('First run, no notifications')
    return false
  } catch (e) {
    $logger.error(e)
    return false
  }
}

const parsePrice = (txt) => {
  if (!txt) return 0
  // примеры: "7 500 грн.", "400 000 грн.", "Договорная"
  const m = txt.replace(/\s+/g,'').match(/(\d+)/g)
  if (!m) return 0
  // склеиваем все числа: "400000"
  return parseInt(m.join(''), 10) || 0
}

const scrapeListingPage = async ($, searchTerm, notify) => {
  const cards = $('[data-cy="l-card"][data-testid="l-card"]')
  if (!cards.length) return false

  $logger.info(`Found ${cards.length} cards on page ${page}`)

  cards.each((i, el) => {
    try {
      const $card = $(el)
      const idStr = $card.attr('id') || '' // бывает числовой id
      const linkEl = $card.find('a.css-1tqlkj0').first()
      const href = linkEl.attr('href') || ''
      const url = href.startsWith('http') ? href : `https://www.olx.ua${href}`
      const title = linkEl.find('h4').text().trim() || linkEl.attr('title') || ''
      const priceText = $card.find('[data-testid="ad-price"]').first().text().trim()
      const price = parsePrice(priceText)

      // Если нет id в div, возьмём из URL кусок после "ID..."
      let id = idStr
      if (!id) {
        const m = url.match(/ID[0-9A-Za-z]+/i)
        if (m) id = m[0]
      }

      if (!id || !url || !title) return

      const payload = { id, url, title, searchTerm, price, notify }
      const ad = new Ad(payload)
      ad.process()

      if (ad.valid) {
        validAds++
        sumPrices += price
        if (price > maxPrice) maxPrice = price
        if (price < minPrice) minPrice = price
      }
    } catch (e) {
      $logger.error(e)
    }
  })

  // На olx.ua "следующая" страница детектим по кнопке пагинации (если есть).
  // Чтобы не усложнять, просто скажем «есть следующая страница, если есть хоть одна карточка».
  return true
}

const scraper = async (baseUrl) => {
  page = 1
  validAds = 0
  sumPrices = 0
  minPrice = Infinity
  maxPrice = 0

  const parsedUrl = new URL(baseUrl)
  const searchTerm = parsedUrl.searchParams.get('q') || ''

  const notify = await urlAlreadySearched(baseUrl)
  $logger.info(`Will notify: ${notify}`)

  let hasNext = true
  // Для начала можно ограничиться 1–2 страницами, чтобы не перегружать запросами
  const MAX_PAGES = 2

  while (hasNext && page <= MAX_PAGES) {
    const currentUrl = setUrlParam(baseUrl, 'page', page)
    let html

    try {
      html = await $httpClient(currentUrl)
    } catch (e) {
      $logger.error(e)
      break
    }

    // быстрая проверка, что это HTML
    if (typeof html !== 'string' || html.length < 1000) {
      $logger.warn(`Page ${page}: response looks too small (${(html && html.length) || 0} bytes)`)
      break
    }

    const $ = cheerio.load(html)
    hasNext = await scrapeListingPage($, searchTerm, notify)
    page++
  }

  $logger.info('Valid ads: ' + validAds)

  if (validAds > 0) {
    const averagePrice = Math.round(sumPrices / validAds)
    $logger.info('Maximum price: ' + maxPrice)
    $logger.info('Minimum price: ' + (isFinite(minPrice) ? minPrice : 0))
    $logger.info('Average price: ' + averagePrice)

    await scraperRepository.saveLog({
      url: baseUrl,
      adsFound: validAds,
      averagePrice,
      minPrice: isFinite(minPrice) ? minPrice : 0,
      maxPrice,
    })
  }
}

module.exports = { scraper }
