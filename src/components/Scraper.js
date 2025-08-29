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

/**
 * Основной запуск парсинга для одного URL (из config.urls)
 */
const scraper = async (url) => {
  page = 1
  maxPrice = 0
  minPrice = 99999999
  sumPrices = 0
  adsFound = 0
  validAds = 0
  nextPage = true

  const parsedUrl = new URL(url)
  // В OLX UA часто нет параметра q, но оставим как «метку» для логов
  const searchTerm = parsedUrl.searchParams.get('q') || ''

  const notify = await urlAlreadySearched(url)
  $logger.info(`Will notify: ${notify}`)

  do {
    const currentUrl = setUrlParam(url, 'o', page)

    try {
      const response = await $httpClient(currentUrl)
      const $ = cheerio.load(response)
      nextPage = await scrapePage($, searchTerm, notify)
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

    const scrapperLog = {
      url,
      adsFound: validAds,
      averagePrice,
      minPrice,
      maxPrice
    }

    await scraperRepository.saveLog(scrapperLog)
  }
}

/**
 * Разбор одной страницы листинга
 */
const scrapePage = async ($, searchTerm, notify) => {
  try {
    const script = $('script[id="__NEXT_DATA__"]').text()
    if (!script) {
      // если нет JSON — дальше листинга нет
      return false
    }

    const data = JSON.parse(script)
    const adList = extractAdsArray(data)

    if (!Array.isArray(adList) || !adList.length) {
      return false
    }

    adsFound += adList.length
    $logger.info(`Checking new ads for: ${searchTerm}`)
    $logger.info('Ads found: ' + adsFound)

    for (let i = 0; i < adList.length; i++) {
      $logger.debug('Checking ad: ' + (i + 1))

      const advert = adList[i]

      // ----- безопасные извлечения полей под OLX UA -----
      const id =
        advert?.id ??
        advert?.listId ??
        advert?.ad_id ??
        advert?.adId

      const title =
        advert?.title ??
        advert?.subject ??
        advert?.params?.title ??
        ''

      // URL бывает как абсолютный, так и относительный
      let url =
        advert?.url ??
        advert?.permalink ??
        advert?.slug ??
        ''

      if (url && typeof url === 'string' && url.startsWith('/')) {
        url = 'https://www.olx.ua' + url
      }

      // Цена: сначала берём число из структурированных полей, потом из строки
      let price =
        numericSafe(advert?.price?.value) ??
        numericSafe(advert?.priceValue) ??
        numericFromString(advert?.price?.label) ??
        numericFromString(advert?.price) ??
        0

      const result = {
        id,
        url,
        title,
        searchTerm,
        price,
        notify
      }

      const ad = new Ad(result)
      ad.process()

      if (ad.valid) {
        validAds++
        minPrice = checkMinPrice(ad.price, minPrice)
        maxPrice = checkMaxPrice(ad.price, maxPrice)
        sumPrices += ad.price
      }
    }

    // Пытаемся вежливо понять, есть ли следующая страница
    const hasNext = hasNextPage(data, page)
    return hasNext
  } catch (error) {
    $logger.error(error)
    throw new Error('Scraping failed')
  }
}

/**
 * На olx.ua путь до массива объявлений может отличаться.
 * Перебираем несколько популярных вариантов.
 */
function extractAdsArray (data) {
  return (
    data?.props?.pageProps?.ads ??
    data?.props?.pageProps?.adList?.ads ??
    data?.props?.pageProps?.searchResult?.ads ??
    data?.props?.pageProps?.items ??
    data?.props?.pageProps?.initialData?.ads ??
    []
  )
}

/**
 * Определяем, есть ли следующая страница. Если информации нет — продолжаем одну итерацию
 * и остановимся, когда не найдём __NEXT_DATA__ на следующем шаге.
 */
function hasNextPage (data, currentPage) {
  // Популярные места, где платформа хранит пагинацию
  const totalPages =
    data?.props?.pageProps?.listingProps?.pagination?.totalPages ??
    data?.props?.pageProps?.pagination?.totalPages ??
    data?.props?.pageProps?.adList?.pagination?.totalPages ??
    null

  if (Number.isInteger(totalPages)) {
    return currentPage < totalPages
  }

  // Фолбэк: если нет информации о пагинации — попробуем ещё одну страницу
  return true
}

/**
 * Узнаём, искался ли этот URL раньше: первый запуск — без уведомлений
 */
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

/**
 * Установка/замена query-параметра в URL
 */
const setUrlParam = (url, param, value) => {
  const newUrl = new URL(url)
  newUrl.searchParams.set(param, value)
  return newUrl.toString()
}

const checkMinPrice = (price, min) => (price < min ? price : min)
const checkMaxPrice = (price, max) => (price > max ? price : max)

/**
 * Безопасно получить число, если пришёл number/строка-число
 */
function numericSafe (v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Вытаскиваем число из строки вида "400 000 грн." -> 400000
 */
function numericFromString (s) {
  if (typeof s !== 'string') return null
  const digits = (s.match(/\d+/g) || []).join('')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

module.exports = {
  scraper
}
