# Builder Stage
FROM node:16 AS builder
WORKDIR /usr/app
COPY ./src ./          # в src лежит package.json и код
RUN npm install --omit=dev

# Final Stage (ВАЖНО: такой же базовый, как в builder!)
FROM node:16
ENV NODE_ENV=production
WORKDIR /usr/app
COPY --from=builder /usr/app/ ./

CMD ["node", "index.js"]   # или ["npm","start"] если у тебя так
