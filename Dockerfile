FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# Instalar Chromium y sus dependencias del sistema
RUN apt-get update && apt-get install -y \
    chromium \
    libxss1 \
    fonts-liberation \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Usar el Chromium del sistema en vez de que Puppeteer descargue el suyo
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
