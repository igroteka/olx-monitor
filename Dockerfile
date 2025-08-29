# Builder Stage
FROM node:16 AS builder
WORKDIR /usr/app

# все файлы из src (включая package.json) внутрь образа
COPY ./src/ ./

# ставим прод-зависимости
RUN npm install --omit=dev

# Final Stage
FROM node:16
ENV NODE_ENV=production
WORKDIR /usr/app

# переносим собранное из builder
COPY --from=builder /usr/app/ ./

# стартуем процесс
CMD ["node", "index.js"]
