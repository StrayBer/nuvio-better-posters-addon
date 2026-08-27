FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=7000
EXPOSE 7000

USER node
CMD ["node", "src/redirect-server.js"]
