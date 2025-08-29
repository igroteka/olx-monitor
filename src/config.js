// src/config.js
require('dotenv').config()

let config = {}

config.urls = [
  'https://www.olx.ua/uk/elektronika/igry-i-igrovye-pristavki/pristavki/?currency=UAH&search%5Bprivate_business%5D=private&search%5Border%5D=created_at:desc'
]

config.interval = '*/1 * * * *' // опрос каждую минуту
config.telegramChatID = process.env.TELEGRAM_CHAT_ID
config.telegramToken  = process.env.TELEGRAM_TOKEN

config.dbFile = '../data/ads.db'
config.logger = {
  logFilePath: '../data/scrapper.log',
  timestampFormat: 'YYYY-MM-DD HH:mm:ss'
}

module.exports = config

