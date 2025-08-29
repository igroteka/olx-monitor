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

/** Утилиты */
function numericFromString (s) {
  if (typeof s !== 'string') return null
  const digits = (s.match(/\d+/g) || []).join('')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

function absoluteUrl (href) {
  try {
    return new URL(href, 'https://www.olx.ua').toString()
  } catch {
    return null
  }
}

function setUrlParam(url, param, value) {
  const u = new URL(url)
  const sp = u.searchParams
  sp.set(param, value)
  u.search = sp.toString()
  return u.toString()
}

/** 1) Парсинг объявлений прямо с DOM списка */
function collectFromDom($) {
  const items = []
  $('[data-cy="l-card"]').each((_, el) => {
    const $el = $(el)

    const id = $el.attr('id') || null

    // основная ссылка карточки
    const hrefRel =
      $el.find('a[href*="/obyavlenie/"]').attr('href') || ''
    const url = absoluteUrl(hrefRel)
    if (!url) return

    // заголовок
    const title =
      $el.find('[data-cy="ad-card-title"] h4').text().trim() ||
      $el.find('a[href*="/obyavlenie/"]').attr('title') ||
      ''

    // цена
    const priceText = $el.find('[data-testid="ad-price"]').text()
    const price = numericFromString(priceText) || 0

    items.push({ id, url, title, price })
  })
  return items
}

/** 2) Попытка вытащить из __NEXT_DATA__ (структуры у OLX разнятся) */
function collectFromNextData($) {
  const script = $('script[id="__NEXT_DATA__"]').first().text()
  if (!script) return []

  let json
  try {
    json = JSON.parse(script)
  } catch {
    return []
  }

  // пробуем несколько известных путей
  const candidates = []

  // olx BR стиль: props.pageProps.ads (массив простых объектов)
  if (json?.props?.pageProps?.ads && Array.isArray(json.props.pageProps.ads)) {
    for (const a of json.props.pageProps.ads) {
      const url = a?.url || a?.shareLink || null
      const id = a?.listId || a?.id || null
      const title = a?.subject || a?.title || ''
      const price = numericFromString(a?.price || a?.price?.value || '')
      if (url) candidates.push({ id, url, title, price: price || 0 })
    }
  }

  // возможные другие коллекции (встречается на EU/UA)
  const tryDeep = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      for (const it of obj) tryDeep(it)
      return
    }
    // эвристика: объект "объявление" содержит ссылку /obyavlenie/
    if (obj.url && String(obj.url).includes('/obyavlenie/')) {
      const url = obj.url
      const id = obj.id || obj.listId || null
      const title = obj.title || obj.subject || ''
      const price = numericFromString(obj.price?.value || obj.price || '')
      candidates.push({ id, url, title, price: price || 0 })
    }
    for (const k of Object.keys(obj)) tryDeep(obj[k])
  }
  if (!candidates.length) tryDeep(json?.props?.pageProps)

  // уникализируем по url
  const seen = new Set()
  const out = []
  for (const it of candidates) {
    if (!it.url || seen.has(it.url)) continue
    seen.add(it.url)
    out.push(it)
  }
  return out
}

/** 3) Если на листинге пусто — собираем ссылки и идём в карточки */
function collectAdLinksFromList($) {
  const links = []
  $('a[href*="/obyavlenie/"]').each((_, a) => {
    const href = $(a).attr('href')
    const url = absoluteUrl(href)
    if (url) links.push(url)
  })
  // уникальные
  return [...new Set(links)]
}

async function fetchAdFromAdPage(url) {
  try {
    const html = await $httpClient(url)
    const $ = cheerio.load(html)

    // Заголовок
    const title =
      $('h1[data-cy="ad_title"]').text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() ||
      ''

    // Цена
    const priceText =
      $('[data-testid="ad-price"]').first().text().trim() ||
      $('meta[property="product:price:amount"]').attr('content') ||
      ''
    const price = numericFromString(priceText) || 0

    // ID (иногда в DOM есть meta с offer id)
    const idAttr = $('[data-cy="ad-contact"]').attr('data-id') ||
                   $('link[rel="canonical"]').attr('href') || ''
    let id = null
    const m = String(idAttr).match(/(\d{6,})/)
    if (m) id = m[1]

    return { id, url, title, price }
  } catch (e) {
    $logger.error(`fetchAdFromAdPage failed: ${url} -> ${e.message}`)
    return null
  }
}

/** Есть ли следующая страница */
function hasNextPage($, currentPage) {
  // 1) rel="next"
  const relNext = $('link[rel="next"]').attr('href')
  if (relNext) return true

  // 2) кнопка "вперёд"
  if ($('a[data-testid="pagination-forward"]').length) return true

  // 3) есть ссылка с ?page=currentPage+1
  const nextNum = String(currentPage + 1)
  let found = false
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || ''
    try {
      const u = new URL(href, 'https://www.olx.ua')
      if (u.searchParams.get('page') === nextNum) found = true
    } catch {}
  })
  return found
}

/** Основной скрапер */
const scraper = async (url) => {
  page = 1
  maxPrice = 0
  minPrice = 99999999
  sumPrices = 0
  adsFound = 0
  validAds = 0
  nextPage = true

  const parsedUrl = new URL(url)
  const searchTerm = parsedUrl.searchParams.get('q') || ''
  const notify = await urlAlreadySearched(url)
  $logger.info(`Will notify: ${notify}`)

  do {
    const currentUrl = setUrlParam(url, 'page', page) // OLX.ua: параметр page
    let response
    try {
      response = await $httpClient(currentUrl)
      const $ = cheerio.load(response)

      let adItems = collectFromDom($)               // 1) DOM листинга
      if (!adItems.length) adItems = collectFromNextData($) // 2) NEXT_DATA

      if (!adItems.length) {
        // 3) Крайний случай — пройтись по карточкам
        const links = collectAdLinksFromList($)
        $logger.info(`Collected ${links.length} ad links from listing`)
        adItems = (await Promise.all(links.map(fetchAdFromAdPage))).filter(Boolean)
      }

      if (!adItems.length) {
        // пустая страница — прекращаем
        nextPage = false
      } else {
        // обработка найденных
        await processAdItems(adItems, searchTerm, notify)
        // решаем идти ли дальше
        nextPage = hasNextPage($, page)
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

    const scrapperLog = {
      url,
      adsFound: validAds,
      averagePrice,
      minPrice,
      maxPrice,
    }
    await scraperRepository.saveLog(scrapperLog)
  }
}

/** Обработка массива объявлений */
async function processAdItems(adItems, searchTerm, notify) {
  adsFound += adItems.length
  $logger.info(`Checking new ads for: ${searchTerm || '(no term)'}`)
  $logger.info('Ads found on page: ' + adItems.length)

  for (let i = 0; i < adItems.length; i++) {
    const it = adItems[i]
    $logger.debug('Checking ad: ' + (i + 1))

    const id = it.id || null
    const url = it.url
    const title = it.title || ''
    const price = Number.isFinite(it.price) ? it.price : 0

    const result = { id, url, title, searchTerm, price, notify }
    const ad = new Ad(result)
    ad.process()

    if (ad.valid) {
      validAds++
      minPrice = Math.min(minPrice, ad.price)
      maxPrice = Math.max(maxPrice, ad.price)
      sumPrices += ad.price
    }
  }
}

/** Флаг: мы уже запускались по этому URL? тогда присылаем уведомления */
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

module.exports = { scraper }
