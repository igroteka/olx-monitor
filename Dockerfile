# Builder
FROM node:20 AS builder
WORKDIR /usr/app
COPY ./src/ ./
RUN npm install --omit=dev

# Final
FROM node:20
ENV NODE_ENV=production
WORKDIR /usr/app
COPY --from=builder /usr/app/ ./

CMD ["node", "index.js"]
