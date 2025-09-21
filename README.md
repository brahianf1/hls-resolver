# Stream Resolver

Servicio headless para detectar y resolver URLs de streams HLS (.m3u8) desde reproductores web, proporcionando metadatos necesarios para reproducción externa.

## Características

- **Detección HLS**: Identifica automáticamente streams HLS en páginas web
- **Headless Navigation**: Usa Puppeteer con stealth plugin para navegar páginas
- **Metadatos Completos**: Extrae headers, cookies y tokens necesarios para reproducción
- **Pool de Navegadores**: Gestión eficiente de instancias de Chromium
- **API REST**: Endpoint simple POST /api/v1/resolve
- **Observabilidad**: Logging estructurado y métricas Prometheus
- **Seguridad**: API key, allowlist de dominios, rate limiting
- **Dockerizado**: Imagen optimizada con multi-stage build

## Instalación

### Desarrollo Local

```bash
# Clonar repositorio
git clone <repo-url>
cd stream-suite

# Instalar dependencias
npm install

# Configurar variables de entorno (opcional)
cp .env.example .env

# Ejecutar en modo desarrollo
npm run dev
```

### Docker

```bash
# Build de la imagen
docker build -t stream-resolver .

# Ejecutar contenedor
docker run -p 8080:8080 stream-resolver
```

### Docker Compose

```bash
# Ejecutar servicio básico
docker-compose up -d

# Con Nginx proxy
docker-compose --profile with-nginx up -d

# Con monitoreo (Prometheus + Grafana)
docker-compose --profile with-monitoring up -d
```

## Uso

### Endpoint Principal

**POST** `/api/v1/resolve`

```bash
curl -X POST http://localhost:8080/api/v1/resolve \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "url": "https://example.com/player",
    "options": {
      "maxWaitMs": 15000,
      "waitUntil": "networkidle2",
      "emulateMobile": false
    }
  }'
```

**Respuesta:**
```json
{
  "sessionId": "1634567890123-abc123def",
  "pageUrl": "https://example.com/player",
  "detectedAt": "2023-10-18T10:30:00.000Z",
  "streams": [
    {
      "type": "HLS",
      "masterUrl": "https://cdn.example.com/playlist.m3u8",
      "isLive": true,
      "isLowLatency": false,
      "variants": [
        {
          "uri": "https://cdn.example.com/720p.m3u8",
          "bandwidth": 2500000,
          "resolution": { "width": 1280, "height": 720 },
          "codecs": "avc1.64001f,mp4a.40.2",
          "frameRate": 30
        }
      ]
    }
  ],
  "bestGuess": 0,
  "requiredHeaders": {
    "Referer": "https://example.com/player",
    "Origin": "https://example.com",
    "User-Agent": "Mozilla/5.0..."
  },
  "requiredCookies": [
    {
      "name": "session",
      "value": "abc123",
      "domain": "example.com"
    }
  ]
}
```

### Otros Endpoints

- **GET** `/health` - Health check básico
- **GET** `/health/detailed` - Health check con detalles del sistema
- **GET** `/metrics` - Métricas Prometheus
- **GET** `/docs` - Documentación OpenAPI

## Configuración

### Variables de Entorno

```bash
# Servidor
PORT=8080
HOST=0.0.0.0
NODE_ENV=production

# Seguridad
API_KEY=your-secure-api-key
CORS_ORIGINS=https://yourdomain.com
ALLOWLIST_HOSTS=example.com,*.trusted-domain.com

# Navegador
PUPPETEER_HEADLESS=true
NAV_TIMEOUT_MS=30000
MAX_WAIT_MS=15000
USER_AGENT="Custom User Agent"
HTTP_PROXY=http://proxy:8080

# Pool
MAX_CONCURRENT_PAGES=5
BROWSER_POOL_SIZE=2

# Logging
LOG_LEVEL=info
```

### Opciones de Request

```typescript
{
  "url": "string",           // URL del reproductor (requerido)
  "options": {
    "userAgent": "string",   // User-Agent personalizado
    "proxy": "string",       // Proxy HTTP(S)
    "navTimeoutMs": number,  // Timeout de navegación
    "maxWaitMs": number,     // Tiempo máximo de espera
    "waitUntil": "domcontentloaded" | "networkidle2",
    "m3u8Patterns": string[], // Patrones regex adicionales
    "extraHeaders": {},      // Headers adicionales
    "emulateMobile": boolean // Emular dispositivo móvil
  }
}
```

## Desarrollo

### Scripts Disponibles

```bash
npm run dev          # Desarrollo con recarga automática
npm run build        # Compilar TypeScript
npm run start        # Ejecutar versión compilada
npm run test         # Ejecutar tests
npm run test:watch   # Tests en modo watch
npm run lint         # Linter
npm run lint:fix     # Fix automático de linting
npm run type-check   # Verificación de tipos
```

### Estructura del Proyecto

```
src/
├── server/           # Servidor Fastify
│   ├── index.ts     # Bootstrap principal
│   └── routes/      # Definición de rutas
├── core/
│   ├── resolver/    # Lógica de resolución
│   ├── security/    # Middlewares de seguridad
│   └── observability/ # Logging y métricas
├── config/          # Configuración y env vars
├── utils/           # Utilidades compartidas
└── types/           # Tipos y DTOs
```

## Monitoreo

### Métricas Disponibles

- `http_requests_total` - Total de requests HTTP
- `resolve_requests_total` - Total de requests de resolución
- `browser_pages_active` - Páginas activas del navegador
- `hls_streams_detected_total` - Streams HLS detectados
- `navigation_errors_total` - Errores de navegación
- `security_events_total` - Eventos de seguridad

### Health Checks

- `/health` - Liveness probe
- `/health/readiness` - Readiness probe
- `/health/detailed` - Información detallada del sistema

## Seguridad

### API Key

Configurar `API_KEY` en variables de entorno. Se acepta en:
- Header `X-API-Key`
- Header `Authorization: Bearer <token>`
- Query parameter `api_key`

### Allowlist de Dominios

```bash
# Dominios específicos
ALLOWLIST_HOSTS=example.com,trusted.com

# Con wildcards para subdominios
ALLOWLIST_HOSTS=*.example.com,specific.com
```

### Rate Limiting

Configurado via Nginx o variables de entorno:
```bash
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
```

## Despliegue

### Docker Compose Producción

```yaml
version: '3.8'
services:
  resolver:
    image: stream-resolver:latest
    environment:
      - API_KEY=${API_KEY}
      - ALLOWLIST_HOSTS=${ALLOWLIST_HOSTS}
      - LOG_LEVEL=info
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2.0'
    restart: unless-stopped
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stream-resolver
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: resolver
        image: stream-resolver:latest
        ports:
        - containerPort: 8080
        env:
        - name: API_KEY
          valueFrom:
            secretKeyRef:
              name: resolver-secrets
              key: api-key
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /health/liveness
            port: 8080
          initialDelaySeconds: 30
        readinessProbe:
          httpGet:
            path: /health/readiness
            port: 8080
          initialDelaySeconds: 10
```

## Troubleshooting

### Problemas Comunes

**Navegador no inicia:**
```bash
# Verificar dependencias del sistema
docker run --rm stream-resolver chromium --version

# Logs detallados
LOG_LEVEL=debug npm run dev
```

**Streams no detectados:**
- Aumentar `maxWaitMs` en options
- Verificar que la página use HLS
- Revisar logs para errores de navegación
- Probar con `emulateMobile: true`

**Errores de memoria:**
```bash
# Reducir pool de navegadores
BROWSER_POOL_SIZE=1
MAX_CONCURRENT_PAGES=2

# Aumentar memoria del contenedor
docker run -m 4g stream-resolver
```

### Logs

```bash
# Logs del contenedor
docker logs stream-resolver -f

# Logs con nivel debug
docker run -e LOG_LEVEL=debug stream-resolver
```

## Licencia

MIT
