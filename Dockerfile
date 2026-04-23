FROM node:20-alpine

WORKDIR /app

# Chromium per Puppeteer (risolve challenge anti-bot su holyfreedom.com)
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Installa dipendenze
COPY package*.json ./
RUN npm ci --only=production

# Copia sorgenti
COPY . .

# Crea cartelle persistenti (da montare come volume in Coolify)
RUN mkdir -p /app/archive /app/output /app/data

# Volumi persistenti (montarli in Coolify per non perdere dati al restart)
VOLUME ["/app/archive", "/app/output", "/app/data"]

EXPOSE 3131

# Avvia il servizio scheduler + dashboard
CMD ["node", "service.js"]
