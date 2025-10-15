import type { HTTPRequest } from 'puppeteer';
import { getLogger } from '../../observability/logger.js';

/**
 * Tipo de acción para el interceptor
 */
export enum InterceptAction {
  CONTINUE = 'continue',
  ABORT = 'abort',
  MODIFY = 'modify',
}

/**
 * Resultado de una regla de intercepción
 */
export interface InterceptResult {
  action: InterceptAction;
  reason?: string;
  modifiedUrl?: string;
}

/**
 * Regla de intercepción de requests
 */
export interface InterceptRule {
  name: string;
  priority: number; // Mayor prioridad se evalúa primero
  test: (request: HTTPRequest) => boolean;
  handle: (request: HTTPRequest) => InterceptResult;
}

/**
 * Configuración del interceptor
 */
export interface RequestInterceptorConfig {
  rules: InterceptRule[];
  logBlocked?: boolean;
  logAllowed?: boolean;
  sessionId?: string;
}

/**
 * Request Interceptor Unificado
 * Maneja todas las interceptaciones de requests en un solo handler para evitar conflictos.
 */
export class RequestInterceptor {
  private rules: InterceptRule[] = [];
  private config: RequestInterceptorConfig;
  private isActive = false;

  constructor(config: RequestInterceptorConfig) {
    this.config = config;
    this.rules = config.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Agrega una regla al interceptor
   */
  addRule(rule: InterceptRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remueve una regla por nombre
   */
  removeRule(name: string): void {
    this.rules = this.rules.filter(r => r.name !== name);
  }

  /**
   * Handler principal de requests
   */
  handleRequest = (request: HTTPRequest): void => {
    try {
      const url = request.url();
      const resourceType = request.resourceType();

      // Evaluar reglas en orden de prioridad
      for (const rule of this.rules) {
        if (rule.test(request)) {
          const result = rule.handle(request);

          switch (result.action) {
            case InterceptAction.ABORT:
              if (this.config.logBlocked) {
                getLogger().debug(
                  {
                    sessionId: this.config.sessionId,
                    url,
                    resourceType,
                    rule: rule.name,
                    reason: result.reason,
                  },
                  'Request blocked by interceptor',
                );
              }
              request.abort().catch(() => {});
              return;

            case InterceptAction.MODIFY:
              // En el futuro se puede implementar modificación de requests
              request.continue().catch(() => {});
              return;

            case InterceptAction.CONTINUE:
              // Continuar a la siguiente regla o permitir el request
              continue;
          }
        }
      }

      // Si ninguna regla bloqueó, continuar
      if (this.config.logAllowed) {
        getLogger().debug(
          {
            sessionId: this.config.sessionId,
            url,
            resourceType,
          },
          'Request allowed',
        );
      }
      request.continue().catch(() => {});
    } catch (error) {
      getLogger().error(
        {
          sessionId: this.config.sessionId,
          error,
          url: request.url(),
        },
        'Error in request interceptor',
      );
      // En caso de error, intentar continuar el request
      try {
        request.continue().catch(() => {});
      } catch {}
    }
  };

  /**
   * Activa el interceptor
   */
  activate(): void {
    this.isActive = true;
  }

  /**
   * Desactiva el interceptor
   */
  deactivate(): void {
    this.isActive = false;
  }

  /**
   * Verifica si está activo
   */
  isInterceptorActive(): boolean {
    return this.isActive;
  }

  /**
   * Obtiene el handler para usar con page.on('request')
   */
  getHandler(): (request: HTTPRequest) => void {
    return this.handleRequest;
  }
}

/**
 * Factory para crear interceptor con reglas predefinidas
 */
export class RequestInterceptorFactory {
  /**
   * Crea un interceptor estándar (sin anti-devtool)
   */
  static createStandard(sessionId?: string): RequestInterceptor {
    return new RequestInterceptor({
      rules: [
        RequestInterceptorFactory.createAdBlockRule(),
        RequestInterceptorFactory.createTrackingBlockRule(),
        RequestInterceptorFactory.createOptimizationRule(),
      ],
      logBlocked: false,
      logAllowed: false,
      sessionId,
    });
  }

  /**
   * Crea un interceptor con protección anti-devtool
   */
  static createAntiDevtool(sessionId?: string): RequestInterceptor {
    return new RequestInterceptor({
      rules: [
        RequestInterceptorFactory.createAntiDevtoolBlockRule(), // Prioridad más alta
        RequestInterceptorFactory.createAdBlockRule(),
        RequestInterceptorFactory.createTrackingBlockRule(),
        RequestInterceptorFactory.createOptimizationRule(),
      ],
      logBlocked: true,
      logAllowed: false,
      sessionId,
    });
  }

  /**
   * Regla para bloquear scripts anti-devtool (PRIORIDAD MÁXIMA)
   */
  private static createAntiDevtoolBlockRule(): InterceptRule {
    const antiDevtoolPatterns = [
      'disable-devtool',
      'cdn.jsdelivr.net/npm/disable-devtool',
      'unpkg.com/disable-devtool',
      'console-ban',
      'devtools-detector',
      'anti-devtools',
    ];

    return {
      name: 'anti-devtool-blocker',
      priority: 1000, // Máxima prioridad
      test: (request: HTTPRequest) => {
        const url = request.url().toLowerCase();
        const resourceType = request.resourceType();
        return (
          resourceType === 'script' &&
          antiDevtoolPatterns.some(pattern => url.includes(pattern))
        );
      },
      handle: (request: HTTPRequest) => ({
        action: InterceptAction.ABORT,
        reason: 'Anti-devtool script blocked',
      }),
    };
  }

  /**
   * Regla para bloquear anuncios
   */
  private static createAdBlockRule(): InterceptRule {
    const adDomains = [
      'ads-twitter.com',
      'imasdk.googleapis.com',
      'googleads.com',
      'googlesyndication.com',
      'doubleclick.net',
      'ptichoolsougn.net',
      'campfirecroutondecorator.com',
      'jilliandescribecompany.com/log',
      'static.ads-twitter.com',
      'facebook.com/tr',
    ];

    return {
      name: 'ad-blocker',
      priority: 900,
      test: (request: HTTPRequest) => {
        const url = request.url().toLowerCase();
        return adDomains.some(domain => url.includes(domain));
      },
      handle: () => ({
        action: InterceptAction.ABORT,
        reason: 'Ad domain blocked',
      }),
    };
  }

  /**
   * Regla para bloquear tracking y analytics
   */
  private static createTrackingBlockRule(): InterceptRule {
    const trackingPatterns = [
      '/log_js_error',
      '/analytics',
      '/tracking',
      '/metrics',
      '/ping',
      'ima3.js',
      'vignette.min.js',
      'uwt.js',
      'analytics.google.com',
      'googletagmanager.com',
      'google-analytics.com',
    ];

    return {
      name: 'tracking-blocker',
      priority: 800,
      test: (request: HTTPRequest) => {
        const url = request.url().toLowerCase();
        return trackingPatterns.some(pattern => url.includes(pattern));
      },
      handle: () => ({
        action: InterceptAction.ABORT,
        reason: 'Tracking blocked',
      }),
    };
  }

  /**
   * Regla para optimización de recursos (bloquear imágenes innecesarias)
   */
  private static createOptimizationRule(): InterceptRule {
    return {
      name: 'optimization',
      priority: 100,
      test: (request: HTTPRequest) => {
        const url = request.url().toLowerCase();
        const resourceType = request.resourceType();

        // Siempre permitir recursos importantes para HLS
        if (
          url.includes('.m3u8') ||
          url.includes('.ts') ||
          url.includes('manifest') ||
          url.includes('playlist') ||
          url.includes('hls') ||
          url.includes('orbitcache.com') ||
          url.includes('urlset') ||
          resourceType === 'media' ||
          resourceType === 'xhr' ||
          resourceType === 'fetch' ||
          resourceType === 'document' ||
          resourceType === 'script'
        ) {
          return false; // No aplicar esta regla, dejar pasar
        }

        // Bloquear recursos innecesarios
        if (['image', 'stylesheet', 'font'].includes(resourceType)) {
          // Permitir solo thumbnails importantes
          if (
            url.includes('thumb') ||
            url.includes('preview') ||
            url.includes('poster')
          ) {
            return false;
          }
          return true; // Bloquear otras imágenes/estilos/fuentes
        }

        return false;
      },
      handle: () => ({
        action: InterceptAction.ABORT,
        reason: 'Resource optimization',
      }),
    };
  }
}

