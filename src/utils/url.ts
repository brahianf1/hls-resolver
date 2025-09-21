import { getLogger } from '../core/observability/logger.js';

const URL_MAX_LENGTH_FOR_LOGGING = 256;

/**
 * Normaliza una URL eliminando parámetros innecesarios y fragmentos
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    
    // Remover fragmentos (#)
    urlObj.hash = '';
    
    // Mantener solo parámetros relevantes para HLS
    const relevantParams = [
      'token',
      'auth',
      'key',
      'signature',
      'expires',
      'timestamp',
    ];
    
    const newSearchParams = new URLSearchParams();
    
    for (const [key, value] of urlObj.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      
      if (relevantParams.some(param => lowerKey.includes(param))) {
        newSearchParams.set(key, value);
      }
    }
    
    urlObj.search = newSearchParams.toString();
    
    return urlObj.href;
  } catch (error) {
    getLogger().warn({ error, url }, 'Failed to normalize URL');
    return url;
  }
}

/**
 * Convierte una URL relativa en absoluta
 */
export function resolveUrl(url: string, baseUrl: string): string {
  try {
    // Si ya es absoluta, devolverla tal como está
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    // Si es protocol-relative (//example.com)
    if (url.startsWith('//')) {
      const baseUrlObj = new URL(baseUrl);
      return `${baseUrlObj.protocol}${url}`;
    }
    
    // Resolver URL relativa
    return new URL(url, baseUrl).href;
  } catch (error) {
    getLogger().warn({ error, url, baseUrl }, 'Failed to resolve URL');
    return url;
  }
}

/**
 * Valida si una URL es válida y accesible
 */
export function isValidUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return ['http:', 'https:'].includes(parsedUrl.protocol);
  } catch (error) {
    getLogger().debug({ url, error }, 'Invalid URL format');
    return false;
  }
}

/**
 * Extrae el dominio base de una URL
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (error) {
    getLogger().warn({ error, url }, 'Failed to extract domain from URL');
    return '';
  }
}

/**
 * Extrae el origen (protocol + hostname + port) de una URL
 */
export function extractOrigin(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.origin;
  } catch (error) {
    getLogger().warn({ error, url }, 'Failed to extract origin from URL');
    return '';
  }
}

/**
 * Verifica si una URL pertenece a un dominio permitido
 */
export function isDomainAllowed(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) {
    return true; // Si no hay restricciones, permitir todo
  }
  
  try {
    const domain = extractDomain(url);
    
    return allowedDomains.some(allowedDomain => {
      // Permitir subdominios con wildcard
      if (allowedDomain.startsWith('*.')) {
        const baseDomain = allowedDomain.slice(2);
        return domain === baseDomain || domain.endsWith(`.${baseDomain}`);
      }
      
      // Match exacto
      return domain === allowedDomain;
    });
  } catch {
    return false;
  }
}

/**
 * Sanitiza una URL para logging (oculta tokens sensibles)
 */
export function sanitizeUrlForLogging(url: string): string {
  try {
    const urlObj = new URL(url);
    
    const sensitiveParams = [
      'token',
      'auth',
      'key',
      'password',
      'secret',
      'signature',
      'api_key',
      'apikey',
    ];
    
    for (const [key, value] of urlObj.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      
      if (sensitiveParams.some(param => lowerKey.includes(param)) && value) {
        urlObj.searchParams.set(key, '***MASKED***');
      }
    }
    
    return urlObj.href;
  } catch {
    return url;
  }
}

/**
 * Obtiene los parámetros de consulta de una URL
 */
export function getUrlParams(url: string): Record<string, string> {
  try {
    const urlObj = new URL(url);
    const params: Record<string, string> = {};
    
    for (const [key, value] of urlObj.searchParams.entries()) {
      params[key] = value;
    }
    
    return params;
  } catch (error) {
    getLogger().warn({ error, url }, 'Failed to extract URL parameters');
    return {};
  }
}

/**
 * Construye una URL con nuevos parámetros
 */
export function buildUrlWithParams(
  baseUrl: string, 
  params: Record<string, string>
): string {
  try {
    const urlObj = new URL(baseUrl);
    
    for (const [key, value] of Object.entries(params)) {
      urlObj.searchParams.set(key, value);
    }
    
    return urlObj.href;
  } catch (error) {
    getLogger().warn({ error, baseUrl, params }, 'Failed to build URL with parameters');
    return baseUrl;
  }
}

/**
 * Verifica si una URL es una playlist HLS basándose en la extensión
 */
export function isHLSUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    
    return pathname.endsWith('.m3u8') || pathname.includes('.m3u8');
  } catch {
    return url.toLowerCase().includes('.m3u8');
  }
}

/**
 * Obtiene la URL base para resolver URLs relativas
 */
export function getBaseUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.split('/').slice(0, -1).join('/')}/`;
  } catch (error) {
    getLogger().warn({ error, url }, 'Failed to get base URL');
    return url;
  }
}

/**
 * Valida y normaliza una URL de manifiesto HLS de forma segura.
 * Rechaza URLs con caracteres de control o protocolos no válidos.
 */
export function normalizeM3U8Url(rawUrl: string): URL | null {
  try {
    // Rechazar strings con caracteres de control que puedan invalidar la URL
    if (/[\u0000-\u001F\u007F]/.test(rawUrl)) {
      getLogger().warn({ url: rawUrl }, 'URL de manifiesto rechazada por contener caracteres de control.');
      return null;
    }

    const url = new URL(rawUrl);

    // Asegurar que el protocolo sea http o https
    if (!['http:', 'https:'].includes(url.protocol)) {
      getLogger().warn({ url: rawUrl, protocol: url.protocol }, 'URL de manifiesto rechazada por protocolo no válido.');
      return null;
    }

    return url;
  } catch (error) {
    getLogger().warn({ url: rawUrl, error }, 'No se pudo parsear la URL del manifiesto.');
    return null;
  }
}