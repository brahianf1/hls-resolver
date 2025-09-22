# Multi-stage build para optimizar tamaño de imagen final
FROM node:20-bookworm AS builder

# Configurar directorio de trabajo
WORKDIR /app

# Copiar archivos de configuración
COPY package*.json ./
COPY tsconfig.json ./

# Instalar dependencias (incluyendo devDependencies para build)
RUN npm ci --include=dev

# Copiar código fuente
COPY src/ ./src/

# Compilar TypeScript
RUN npm run build

# Limpiar devDependencies
RUN npm prune --production && npm cache clean --force

# Imagen de runtime
FROM node:20-bookworm-slim AS runtime

# Instalar dependencias del sistema para Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libdrm2 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Crear usuario no-root
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && mkdir -p /home/appuser/Downloads \
    && chown -R appuser:appuser /home/appuser

# Configurar directorio de trabajo
WORKDIR /app

# Cambiar propietario del directorio de la aplicación
RUN chown -R appuser:appuser /app

# Cambiar a usuario no-root
USER appuser

# Copiar archivos compilados desde builder
COPY --from=builder --chown=appuser:appuser /app/dist ./dist
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/package*.json ./

# Variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Variables de entorno por defecto
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PUPPETEER_HEADLESS=true \
    LOG_LEVEL=info

# Exponer puerto
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (res) => { \
        process.exit(res.statusCode === 200 ? 0 : 1) \
    }).on('error', () => process.exit(1))"

# Comando por defecto
CMD ["node", "dist/server/index.js"]
