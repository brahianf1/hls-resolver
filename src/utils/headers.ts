import { getLogger } from '../core/observability/logger.js';
import { validateHeaderValue } from 'node:http';

// Expresión regular para nombres de cabecera válidos (según RFC 7230)
const SAFE_HEADER_NAME_REGEX = /^[!#$%&'*+\-.\^_`|~0-9a-zA-Z]+$/;

// Caracteres de control que deben ser eliminados de los valores de las cabeceras
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;

// Lista blanca explícita de cabeceras permitidas para las peticiones de manifiestos
const HEADER_ALLOWLIST: readonly string[] = [
  'user-agent',
  'accept',
  'accept-language',
  'referer',
  'origin',
  'cookie',
];

/**
 * Valida un par nombre/valor de cabecera.
 * - El nombre debe cumplir con el formato de token de RFC 7230.
 * - El valor no debe contener caracteres inválidos.
 *
 * @param name - Nombre de la cabecera.
 * @param value - Valor de la cabecera (ya saneado de caracteres de control).
 * @returns `true` si la cabecera es válida, `false` en caso contrario.
 */
function isValidHeader(name: string, value: string): boolean {
  if (!SAFE_HEADER_NAME_REGEX.test(name)) {
    getLogger().warn({ headerName: name }, 'Nombre de cabecera inválido descartado.');
    return false;
  }
  try {
    // `validateHeaderValue` de Node.js arroja un error si el valor es inválido
    validateHeaderValue(name, value);
    return true;
  } catch (error) {
    getLogger().warn({ headerName: name, error }, 'Valor de cabecera inválido descartado.');
    return false;
  }
}

export class HeadersManager {
  private headers: Record<string, string>;

  constructor(initialHeaders: Record<string, string> = {}) {
    this.headers = {};
    for (const [key, value] of Object.entries(initialHeaders)) {
      this.set(key, value);
    }
  }

  /**
   * Establece una cabecera, asegurándose de que el nombre sea canónico (minúsculas).
   */
  public set(key: string, value: string): this {
    this.headers[key.toLowerCase()] = value;
    return this;
  }

  /**
   * Obtiene el valor de una cabecera por su nombre (insensible a mayúsculas/minúsculas).
   */
  public get(key: string): string | undefined {
    return this.headers[key.toLowerCase()];
  }
  
  /**
  * Devuelve todas las cabeceras como un objeto plano.
  */
  public getAll(): Record<string, string> {
    return { ...this.headers };
  }


  /**
   * Construye un conjunto de cabeceras "contextuales" seguras para una petición de manifiesto.
   *
   * @param pageUrl - La URL de la página donde se detectó el manifiesto.
   * @param candidateUrl - La URL del manifiesto que se va a solicitar.
   * @param baseHeaders - Cabeceras base capturadas (p.ej., User-Agent, Cookie).
   * @param minimalProfile - Si es `true`, solo se usan las cabeceras más esenciales (fallback).
   * @returns Una instancia de `HeadersManager` con las cabeceras saneadas y listas para usar.
   */
  public static buildContextualHeaders(
    pageUrl: string,
    candidateUrl: string,
    baseHeaders: { userAgent: string; cookie?: string },
    minimalProfile = false,
  ): HeadersManager {
    const manager = new HeadersManager();
    const logger = getLogger();

    try {
      const pageOrigin = new URL(pageUrl).origin;
      const targetOrigin = new URL(candidateUrl).origin;

      // 1. User-Agent (esencial)
      manager.set('User-Agent', baseHeaders.userAgent);

      // 2. Accept (perfil recomendado para HLS)
      manager.set('Accept', 'application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.1');
      
      // 3. Referer
      manager.set('Referer', pageUrl);

      // Si no es el perfil mínimo, añadir cabeceras adicionales
      if (!minimalProfile) {
        // 4. Origin
        if (pageOrigin !== 'null') {
            manager.set('Origin', pageOrigin);
        }

        // 5. Accept-Language
        manager.set('Accept-Language', 'en-US,en;q=0.8');
        
        // 6. Cookie (solo si se proporciona y es necesario)
        if (baseHeaders.cookie) {
            manager.set('Cookie', baseHeaders.cookie);
        }
      }

      // Saneamiento y validación final
      const finalHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(manager.getAll())) {
        // Omitir cabeceras que no están en la lista blanca
        if (!HEADER_ALLOWLIST.includes(key.toLowerCase())) {
          continue;
        }

        // Eliminar caracteres de control del valor
        const cleanedValue = String(value).replace(CONTROL_CHARS_REGEX, '');

        if (isValidHeader(key, cleanedValue)) {
          finalHeaders[key] = cleanedValue;
        } else {
          logger.warn({ header: { key, value } }, 'Cabecera descartada durante el saneamiento final.');
        }
      }
      
      return new HeadersManager(finalHeaders);

    } catch (error) {
      logger.error({ error, pageUrl, candidateUrl }, 'Error al construir cabeceras contextuales.');
      // Devolver un conjunto mínimo y seguro en caso de error
      return new HeadersManager({ 'User-Agent': baseHeaders.userAgent, 'Accept': '*/*' });
    }
  }
}

