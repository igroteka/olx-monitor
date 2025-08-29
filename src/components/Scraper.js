// src/components/Scraper.js
const cheerio = require('cheerio')
const $logger = require('./Logger')
const $httpClient = require('./HttpClient.js')
const scraperRepository = require('../repositories/scrapperRepository.js')
const Ad = require('./Ad.js')

let page = 1
let maxPrice = 0
let minPrice = 99999999
let sumPrices = 0
let validAds = 0
let adsFound = 0
let nextPage = true

const scraper = async (url) => {
  page = 1
  maxPrice = 0
  minPrice = 99999999
  sumPrices = 0
  adsFound = 0
  validAds = 0
  nextPage = true

  const parsedUrl = new URL(url)
  const isUA = parsedUrl.hostname.endsWith('olx.ua')
  const pageParam = isUA ? 'page' : 'o' // для UA – page, для BR – o
  const searchTerm = parsedUrl.searchParams.get('q') || ''
  const notify = await urlAlreadySearched(url)
  $logger.info(`Will notify: ${notify}`)

  do {
    const currentUrl = setUrlParam(url, pageParam, page)
    try {
      const html = await $httpClient(currentUrl)
      const $ = cheerio.load(html)

      if (isUA) {
        nextPage = await scrapePageUA($, searchTerm, notify)
      } else {
        nextPage = await scrapePageBR($, searchTerm, notify) // исходное поведение
      }
    } catch (error) {
      $logger.error(error)
      return
    }
    page++
  } while (nextPage)

  $logger.info('Valid ads: ' + validAds)

  if (validAds) {
    const averagePrice = sumPrices / validAds

    $logger.info('Maximum price: ' + maxPrice)
    $logger.info('Minimum price: ' + minPrice)
    $logger.info('Average price: ' + averagePrice)

    await scraperRepository.saveLog({
      url,
      adsFound: validAds,
      averagePrice,
      minPrice,
      maxPrice,
    })
  }
}

/**
 * Разбор страницы списка для OLX UA (HTML-карточки)
 */
const scrapePageUA = async ($, searchTerm, notify) => {
  try {
    const cards = $('article[data-cy="l-card"]')
    if (!cards.length) {
      return false
    }

    $logger.info(`Checking new ads for (UA): ${searchTerm}`)
    adsFound += cards.length
    $logger.info('Ads found: ' + adsFound)

    cards.each((_, el) => {
      const $el = $(el)

      // URL объявления
      const a = $el.find('a').first()
      const href = a.attr('href')
      if (!href) return
      const fullUrl = href.startsWith('http') ? href : `https://www.olx.ua${href}`

      // Заголовок
      const title =
        ($el.find('h6').first().text() || $el.find('[data-cy="ad-card-title"]').first().text() || '').trim()

      // Цена
      const priceText = ($el.find('[data-testid="ad-price"]').first().text() || '').trim()
      const price = Number(priceText.replace(/[^\d]/g, '')) || 0

      // ID из URL ...-IDXXXXXX.html
      const m = fullUrl.match(/ID([A-Z0-9]+)\.html/i)
      const id = m ? m[1] : fullUrl

      const result = { id, url: fullUrl, title, searchTerm, price, notify }
      const ad = new Ad(result)
      ad.process()

      if (ad.valid) {
        validAds++
        minPrice = checkMinPrice(ad.price, minPrice)
        maxPrice = checkMaxPrice(ad.price, maxPrice)
        sumPrices += ad.price
      }
    })

    // Пытаемся понять, есть ли следующая страница
    // Ищем ссылку на следующую страницу (page = текущая + 1)
    const nextSelector =
      $(`a[href*="page=${page + 1}"]`).length > 0 ||
      $('a[rel="next"]').length > 0

    return Boolean(nextSelector)
  } catch (error) {
    $logger.error(error)
    throw new Error('UA scraping failed')
  }
}

/**
 * Исходный разбор для BR (через __NEXT_DATA__)
 */
const scrapePageBR = async ($, searchTerm, notify) => {
  try {
    const script = $('script[id="__NEXT_DATA__"]').text()
    if (!script) return false

    const adList = JSON.parse(script).props.pageProps.ads
    if (!Array.isArray(adList) || !adList.length) return false

    adsFound += adList.length
    $logger.info(`Checking new ads for: ${searchTerm}`)
    $logger.info('Ads found: ' + adsFound)

    for (let i = 0; i < adList.length; i++) {
      $logger.debug('Checking ad: ' + (i + 1))
      const advert = adList[i]
      const title = advert.subject
      const id = advert.listId
      const url = advert.url
      const price = parseInt(advert.price?.replace('R$ ', '')?.replace('.', '') || '0')

      const result = { id, url, title, searchTerm, price, notify }
      const ad = new Ad(result)
      ad.process()

      if (ad.valid) {
        validAds++
        minPrice = checkMinPrice(ad.price, minPrice)
        maxPrice = checkMaxPrice(ad.price, maxPrice)
        sumPrices += ad.price
      }
    }
    return true
  } catch (error) {
    $logger.error(error)
    throw new Error('BR scraping failed')
  }
}

const urlAlreadySearched = async (url) => {
  try {
    const ad = await scraperRepository.getLogsByUrl(url, 1)
    if (ad.length) return true
    $logger.info('First run, no notifications')
    return false
  } catch (error) {
    $logger.error(error)
    return false
  }
}

const setUrlParam = (url, param, value) => {
  const u = new URL(url)
  u.searchParams.set(param, value)
  return u.toString()
}

const checkMinPrice = (price, minPrice) => (price < minPrice ? price : minPrice)
const checkMaxPrice = (price, maxPrice) => (price > maxPrice ? price : maxPrice)

module.exports = { scraper }
