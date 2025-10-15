# 🛡️ Anti-Devtool Protection - Guía de Testing

## 📋 Resumen

Se ha implementado un sistema especializado para capturar HLS de sitios web que utilizan bloqueadores anti-devtools (como `disable-devtool.js`). Este sistema replica las técnicas exitosas del flujo de n8n/Browserless.

## 🎯 Características Implementadas

### 1. **Request Interceptor Unificado**
- Bloquea scripts anti-devtool antes de que se carguen
- Maneja todos los requests en un solo handler (evita conflictos)
- Prioriza reglas por importancia

### 2. **Bypass Anti-Devtool Mejorado**
- Mock completo del objeto `DisableDevtool`
- Sobrescritura de `navigator.webdriver`
- Neutralización de debugger statements
- Bloqueo de detección por dimensiones de ventana

### 3. **Browser con Flags Anti-Detección**
- `--disable-blink-features=AutomationControlled` ⭐ (crítico)
- Configuración optimizada basada en Browserless
- Navegador temporal por request

### 4. **Detector HLS Agresivo**
- Captura TODOS los requests/responses sin filtros prematuros
- Clasifica después de capturar
- Formato de salida similar a n8n para comparación

### 5. **Detección Automática**
- Lista de dominios conocidos con bloqueadores
- Activación automática según el dominio
- Configurable vía variables de entorno

## 🚀 Cómo Probar

### Opción 1: Endpoint Específico de Testing

El endpoint `/api/v1/resolve/protected` está diseñado para testing y siempre usa la protección anti-devtool.

```bash
# Iniciar el servicio en modo desarrollo
npm run dev

# En otra terminal, probar con la URL de lamovie.link
curl -X POST http://localhost:8080/api/v1/resolve/protected \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-api-key" \
  -d '{
    "url": "https://lamovie.link/embed-9g7p0nlgflbs.html"
  }'
```

### Opción 2: Endpoint Regular (Detección Automática)

El endpoint `/api/v1/resolve` detecta automáticamente si la URL necesita protección.

```bash
curl -X POST http://localhost:8080/api/v1/resolve \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-api-key" \
  -d '{
    "url": "https://lamovie.link/embed-9g7p0nlgflbs.html",
    "options": {}
  }'
```

### Respuesta Esperada

Si la implementación funciona correctamente, deberías ver:

```json
{
  "sessionId": "anti-devtool-1729012345678-abc123",
  "url": "https://lamovie.link/embed-9g7p0nlgflbs.html",
  "success": true,
  "manifests": [
    {
      "url": "https://s2.vimeos.net/hls2/.../master.m3u8?t=...",
      "status": 200,
      "contentType": "application/vnd.apple.mpegurl"
    },
    {
      "url": "https://s2.vimeos.net/hls2/.../index-a1.m3u8?t=...",
      "status": 200,
      "contentType": "application/vnd.apple.mpegurl"
    }
  ],
  "timings": {
    "total": 15234,
    "navigation": 3456,
    "activation": 1234,
    "detection": 567
  },
  "clicksPerformed": 1,
  "antiDevtoolEnabled": true
}
```

## ⚙️ Configuración

### Variables de Entorno

En `.env.development`:

```bash
# Habilitar/deshabilitar protección anti-devtool
ANTI_DEVTOOL_ENABLED=true

# Dominios personalizados (opcional)
# Si está vacío, usa lista predeterminada
ANTI_DEVTOOL_DOMAINS=lamovie.link,voe.sx,custom-domain.com

# Tiempo de espera después del click (ms)
ANTI_DEVTOOL_WAIT_AFTER_CLICK=8000
```

### Dominios Predeterminados

Si `ANTI_DEVTOOL_DOMAINS` está vacío, se usan estos dominios:
- `lamovie.link`
- `voe.sx`
- `streamtape.com`
- `doodstream.com`

## 📊 Logs de Debugging

Con `LOG_LEVEL=debug`, verás logs detallados:

```
[INFO] 🛡️ Anti-devtool protection required for this URL
[INFO] Anti-devtool bypass script injected successfully
[DEBUG] Request interceptor configured with anti-devtool rules
[DEBUG] Request blocked by interceptor: disable-devtool
[INFO] ⭐ HLS-related request captured
[INFO] ⭐ HLS-related response captured
[INFO] ✓ Click en reproductor (selector específico)
[INFO] 🎉 Anti-Devtool resolve successful
```

## 🔍 Troubleshooting

### Problema: No se detectan manifiestos

**Solución:**
1. Verificar logs para ver si el anti-devtool se activó:
   ```
   grep "Anti-devtool protection required" logs.txt
   ```

2. Aumentar tiempo de espera:
   ```bash
   ANTI_DEVTOOL_WAIT_AFTER_CLICK=12000
   ```

3. Ver qué se capturó:
   ```
   grep "HLS-related" logs.txt
   ```

### Problema: Script anti-devtool no se bloqueó

**Verificar:**
1. Que la intercepción esté activa (ver logs)
2. Que el patrón del script esté en la lista de bloqueo
3. Agregar patrón personalizado si es necesario

### Problema: Browser crash o timeout

**Posibles causas:**
- Memoria insuficiente
- Flags incompatibles

**Solución:**
Revisar flags en `anti-devtool-browser-page.ts` y ajustar según el sistema.

## 🎯 Testing Manual

### 1. Verificar Bloqueo de Scripts

Buscar en logs:
```bash
grep "Anti-devtool script blocked" logs.txt
```

### 2. Verificar Mock de DisableDevtool

Buscar en logs del navegador:
```bash
grep "Anti-Devtool Bypass" logs.txt
```

Deberías ver:
```
[Anti-Devtool Bypass] Successfully injected - DisableDevtool neutralized
```

### 3. Verificar Captura de HLS

```bash
grep "⭐ HLS" logs.txt | wc -l
```

Deberías ver múltiples capturas de URLs .m3u8 y .ts

### 4. Comparar con n8n

Si tienes el flujo de n8n funcionando, compara:
- Número de manifiestos capturados
- URLs específicas
- Tiempo de ejecución

## 📈 Próximos Pasos

1. **Testing en producción:**
   - Probar con múltiples URLs
   - Medir tasa de éxito
   - Ajustar timeouts si es necesario

2. **Optimización:**
   - Reducir timeouts si es posible
   - Agregar más dominios a la lista

3. **Monitoring:**
   - Agregar métricas específicas anti-devtool
   - Dashboard de tasa de éxito

## 🆘 Soporte

Si encuentras problemas:

1. **Recopilar información:**
   - Logs completos con `LOG_LEVEL=debug`
   - URL de prueba
   - Respuesta obtenida

2. **Verificar requisitos:**
   - Node.js >= 20
   - Chromium instalado
   - Memoria disponible >= 2GB

3. **Comparar con n8n:**
   - ¿Funciona la misma URL en n8n?
   - ¿Qué diferencias hay en la respuesta?

## 📚 Referencias

- Código original de n8n: `Capturador.json`
- Técnicas anti-detección: https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth
- Disable-devtool bypass: Implementado en `anti-devtool-bypass.ts`

