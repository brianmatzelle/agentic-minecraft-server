FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js client.lua ./
EXPOSE 8175 8176
CMD ["node", "server.js"]
