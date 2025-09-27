import crypto from 'crypto';
import {
  ResolveRequest,
  ResolveResponse,
  Stream,
  DetectionContext,
  RawFinding,
  HLSCandidate,
  ResolveHLSRequest,
  ResolveHLSResponse,
  Manifest,
  ResolveHLSOptions,
} from '../../types/dto.js';
import { BrowserPool, BrowserPage } from './browser.pool.js';
import { HLSDetector } from './detectors/hls-detector.js';
import { M3U8Parser } from './parsers/m3u8.parser.js';
import { getLogger, logPerformance } from '../observability/logger.js';
import {
  incrementResolveRequest,
  incrementHlsStreams,
  incrementNavigationError,
} from '../observability/metrics.js';
import { getConfig, getAllowlistHosts } from '../../config/env.js';
import {
  isValidUrl,
  isDomainAllowed,
  sanitizeUrlForLogging,
  normalizeUrl,
  normalizeM3U8Url,
} from '../../utils/url.js';
import { HeadersManager } from '../../utils/headers.js';
import axios from 'axios';
import {
  IActivationStrategyCache,
  ActivationStrategy,
} from '../cache/strategy-cache.interface.js';

export enum ActivationStrategyName {
  None = 'none',
  FastCenterOnce = 'fast-center-once',
  FastCenterDouble = 'fast-center-double',
  OverlayClose = 'overlay-close',
  PlayElements = 'play-elements',
}

export interface NavigationResult {
  strategy: ActivationStrategy | null;
  clicksPerformed: number;
}

export class ResolverService {
  private browserPool: BrowserPool;
  private strategyCache: IActivationStrategyCache;
  private config = getConfig();

  constructor(
    browserPool: BrowserPool,
    strategyCache: IActivationStrategyCache,
  ) {
    this.browserPool = browserPool;
    this.strategyCache = strategyCache;
  }

  /**
   * @deprecated Utilizar resolveHLS en su lugar. Esta función se eliminará en futuras versiones.
   */
  async resolve(request: ResolveRequest): Promise<ResolveResponse> {
    const hlsRequest: ResolveHLSRequest = {
      url: request.url,
      options: {
        timeoutMs: request.options?.maxWaitMs || 10000,
        clickRetries: 1,
        abortAfterFirst: true,
        captureBodies: false,
      },
    };

    const hlsResponse = await this.resolveHLS(hlsRequest);

    // Mapeo de la respuesta nueva al formato antiguo
    const oldStreams = await this.processHLSCandidates(
      hlsResponse.manifests.map(m => ({
        url: m.url,
        contentType: m.contentType,
        detectedAt: m.timestamp,
        source: 'response',
        headers: {},
        cookies: [],
      })),
      {
        url: request.url,
        options: { ...request.options, timeoutMs: 10000, clickRetries: 1, abortAfterFirst: true, captureBodies: false },
        sessionId: 'legacy',
        startTime: 0,
      },
    );

    return {
      sessionId: 'legacy',
      pageUrl: request.url,
      detectedAt: new Date().toISOString(),
      streams: oldStreams,
      bestGuess: this.determineBestGuess(oldStreams),
      requiredHeaders: {},
      requiredCookies: [],
      rawFindings: hlsResponse.manifests.map(m => ({ url: m.url, contentType: m.contentType })),
      notes: [],
    };
  }

  async resolveHLS(request: ResolveHLSRequest): Promise<ResolveHLSResponse> {
    const sessionId = this.generateSessionId();
    const overallStartTime = Date.now();
    const timings = { total: 0, navigation: 0, activation: 0, detection: 0 };
    let clicksPerformed = 0;
    let targetsObserved = 0;
    let manifests: Manifest[] = [];

    const sanitizedUrl = sanitizeUrlForLogging(request.url);
    getLogger().info(
      { sessionId, url: sanitizedUrl, options: request.options },
      'Starting HLS resolve request',
    );

    let browserPage: BrowserPage | undefined;
    let detector: HLSDetector | undefined;
    try {
      this.validateRequest({ url: request.url });

      const finalOptions: ResolveHLSOptions = {
        timeoutMs: 10000,
        clickRetries: 1,
        abortAfterFirst: true,
        captureBodies: false,
        ...request.options,
      };

      const context: DetectionContext = {
        url: request.url,
        options: finalOptions,
        sessionId,
        startTime: overallStartTime,
      };

      browserPage = await this.browserPool.getPage();
      targetsObserved = browserPage.getPage().browser().targets().length;

      detector = new HLSDetector(context);
      await detector.setupDetection(browserPage);

      const navStartTime = Date.now();
      const result = await this.navigateAndDetect(
        browserPage,
        context,
        detector,
      );
      timings.navigation = Date.now() - navStartTime;
      
      // Extraer información del resultado
      const successfulStrategy = result?.strategy || null;
      clicksPerformed = result?.clicksPerformed || 0;

      const activationStartTime = Date.now();
      if (successfulStrategy) {
        const domain = new URL(request.url).hostname;
        await this.strategyCache.set(domain, successfulStrategy);
      }
      timings.activation = Date.now() - activationStartTime;

      const detectionStartTime = Date.now();
      const candidates = detector.getCandidates();
      manifests = candidates.map(c => ({
        url: c.url,
        status: 200, // Placeholder
        contentType: c.contentType || 'application/vnd.apple.mpegurl',
        fromTargetId: 'unknown', // Placeholder
        timestamp: c.detectedAt,
      }));
      timings.detection = Date.now() - detectionStartTime;

      incrementResolveRequest('success', manifests.length > 0, timings.total);
    } catch (error) {
      incrementResolveRequest('error', false, Date.now() - overallStartTime);
      getLogger().error({ sessionId, error }, 'HLS resolve request failed');
      // Re-throw or handle as per API error policy
      throw error;
    } finally {
      if (detector) {
        try {
          await detector.dispose();
        } catch (error) {
          getLogger().error({ sessionId, error }, 'Error disposing detector');
        }
      }
      if (browserPage) {
        try {
          await browserPage.release();
        } catch (error) {
          getLogger().error({ sessionId, error }, 'Error releasing browser page');
        }
      }
      timings.total = Date.now() - overallStartTime;
    }

    getLogger().info(
      { sessionId, manifestsFound: manifests.length, timings, clicksPerformed, targetsObserved },
      'HLS resolve request finished',
    );

    return {
      manifests,
      timings,
      clicksPerformed,
      targetsObserved,
    };
  }

  private validateRequest(request: { url: string }): void {
    if (!isValidUrl(request.url)) {
      throw new Error(`Invalid URL: ${request.url}`);
    }
    const allowedHosts = getAllowlistHosts();
    if (!isDomainAllowed(request.url, allowedHosts)) {
      throw new Error(`Domain not allowed: ${request.url}`);
    }
  }

  private async navigateAndDetect(
    browserPage: BrowserPage,
    context: DetectionContext,
    detector: HLSDetector,
  ): Promise<NavigationResult> {
    const page = browserPage.getPage();
    const options = context.options;
    const browser = page.browser();
    let clicksPerformed = 0;

    // (1) Endurecer contra Service Workers y popups ANTES de navegar/activar
    await page.setBypassServiceWorker(true);
    
    // Bloquear más tipos de popups y redirects
    await page.evaluateOnNewDocument(() => {
      try {
        // Bloquear window.open completamente
        (window as any).open = () => null;
        
        // Bloquear otros métodos de popup
        (window as any).showModalDialog = () => null;
        
        // Prevenir redirects automáticos
        const originalReplace = (window as any).location.replace;
        const originalAssign = (window as any).location.assign;
        (window as any).location.replace = () => {};
        (window as any).location.assign = () => {};
        
        // Bloquear alerts y prompts que pueden interrumpir
        (window as any).alert = () => {};
        (window as any).confirm = () => true;
        (window as any).prompt = () => null;
      } catch {}
    });
    const originHost = new URL(context.url).host;
    const onTargetCreated = async (t: any) => {
      try {
        const targetType = typeof t.type === 'function' ? t.type() : 'unknown';
        const targetUrl = typeof t.url === 'function' ? t.url() : 'unknown';
        
        getLogger().debug(
          { sessionId: context.sessionId, targetType, targetUrl },
          'New target created'
        );
        
        if (targetType === 'page') {
          const child = await t.page().catch(() => null);
          if (!child) return;
          
          const href = child.url();
          let host = '';
          try {
            host = new URL(href).host;
          } catch {}
          
          // Cerrar cualquier página que no sea del dominio original
          if (host && host !== originHost) {
            getLogger().debug(
              { sessionId: context.sessionId, blockedUrl: href },
              'Blocking popup/redirect'
            );
            try {
              await child.close();
            } catch {}
          }
        }
      } catch (error) {
        try {
          getLogger().warn(
            { sessionId: context.sessionId, error: (error as Error)?.message },
            'Error in onTargetCreated handler'
          );
        } catch {}
      }
    };
    browser.on('targetcreated', onTargetCreated);

    try {
      // Configurar headers adicionales si se proporcionaron
      if (options?.extraHeaders) {
        await page.setExtraHTTPHeaders(
          options.extraHeaders as Record<string, string>,
        );
      }

      // Emular móvil si se solicita
      if (options?.emulateMobile) {
        await page.emulate({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
          viewport: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            isLandscape: false,
          },
        });
      }

      // Configurar timeouts
      const navTimeout = options?.timeoutMs || this.config.NAV_TIMEOUT_MS;
      const maxWait = options?.timeoutMs || this.config.NAV_TIMEOUT_MS;


      // Navegar a la URL
      await browserPage.navigateTo(context.url, {
        waitUntil: options?.waitUntil || 'domcontentloaded',
        timeout: navTimeout,
      });

      getLogger().debug(
        {
          sessionId: context.sessionId,
          url: sanitizeUrlForLogging(context.url),
        },
        'Navigation completed, starting activation strategy',
      );
      
      // OPTIMIZACIÓN: Basado en análisis de logs (67% de los casos), muchos sitios
      // muestran HLS inmediatamente. Se reduce la espera inicial.
      // OPTIMIZACIÓN: Tiempo reducido para detección automática (67% de sitios según análisis)
      await page.waitForTimeout(1000);

      // OPTIMIZACIÓN: Early return para sitios automáticos
      if (detector.getCandidates().length > 0) {
        getLogger().debug(
          { sessionId: context.sessionId },
          'HLS already detected after navigation, no clicks needed'
        );
        return {
          strategy: { name: ActivationStrategyName.None },
          clicksPerformed: 0
        };
      }

      // Breve espera adicional para sitios automáticos lentos
      await page.waitForTimeout(1000);
      if (detector.getCandidates().length > 0) {
        getLogger().debug(
          { sessionId: context.sessionId },
          'HLS detected after brief wait, avoiding unnecessary activation'
        );
        return {
          strategy: { name: ActivationStrategyName.None },
          clicksPerformed: 0
        };
      }
      
      // (Opcional) Telemetría en modo debug
      if (options?.debug) {
        page.on('console', m =>
          console.log('[page.console]', m.type?.(), m.text?.()),
        );
        page.on('pageerror', e =>
          console.error('[page.error]', e?.message || String(e)),
        );
        try {
          await page.screenshot({ path: `./debug-before-click.png` });
        } catch {}
      }

      // (2) Activación por clic inmediato en el centro del viewport (sin move/delay)
      const vp = page.viewport() || { width: 800, height: 600 };
      const cx = Math.max(1, Math.floor(vp.width / 2));
      const cy = Math.max(1, Math.floor(vp.height / 2));
      
      getLogger().debug(
        { sessionId: context.sessionId, cx, cy, viewport: vp },
        'Attempting center click'
      );
      
      let clicksPerformed = 0;
      try {
        // Agregar timeout para evitar que se cuelgue el clic
        await Promise.race([
          page.mouse.click(cx, cy),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Click timeout')), 5000)
          )
        ]);
        clicksPerformed++;
        getLogger().debug(
          { sessionId: context.sessionId },
          'First click executed successfully'
        );
      } catch (e) {
        getLogger().warn(
          { sessionId: context.sessionId, err: (e as Error)?.message },
          'Center click failed',
        );
      }

      // Si la estrategia/opts indica doble clic rápido, emitir un segundo clic con una espera mínima
      if (options?.clickRetries && options.clickRetries > 0) {
        try {
          await page.waitForTimeout(140);
          await Promise.race([
            page.mouse.click(cx, cy),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Second click timeout')), 5000)
            )
          ]);
          clicksPerformed++;
          getLogger().debug(
            { sessionId: context.sessionId },
            'Second click executed successfully'
          );
        } catch (e) {
          getLogger().warn(
            { sessionId: context.sessionId, err: (e as Error)?.message },
            'Second click failed',
          );
        }
      }
      
      getLogger().debug(
        { sessionId: context.sessionId, clicksPerformed },
        'Click phase completed'
      );

      // (2.b) Fallback: clicar el centro del mayor iframe visible si no hay HLS pronto
      // OPTIMIZACIÓN: Timeout reducido - análisis mostró que 1.8s era tiempo muerto
      const shortWait = 1000; // Reducido de 1800ms
      let successfulStrategy = await this.waitForStreamDetection(
        detector,
        shortWait,
        context.sessionId,
      );
      
      if (!successfulStrategy) {
        getLogger().debug(
          { sessionId: context.sessionId },
          'No HLS detected after initial clicks, trying optimized strategies sequence'
        );
        
        // ESTRATEGIA 1: Cerrar overlays PRIMERO (más efectivo según análisis de logs voe.sx)
        try {
          getLogger().debug(
            { sessionId: context.sessionId },
            'Attempting to close overlays/modals that might be blocking the player'
          );
          
          // Buscar y cerrar overlays/modals
          const overlaysClosed = await page.evaluate(() => {
            const overlaySelectors = [
              '.modal', '.popup', '.overlay', '.dialog',
              '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]',
              '[class*="dialog"]', '[id*="modal"]', '[id*="popup"]',
              '.close', '.close-button', '[class*="close"]',
              '[aria-label*="close"]', '[title*="close"]',
              // Selectores adicionales para ads comunes
              '[class*="ad-"]', '[id*="ad-"]', '.advertisement',
              '.popup-close', '.modal-close', '.overlay-close'
            ];
            
            let closed = 0;
            for (const selector of overlaySelectors) {
              try {
                const elements = document.querySelectorAll(selector);
                for (const el of Array.from(elements)) {
                  // Solo elementos visibles
                  const style = window.getComputedStyle(el);
                  if (style.display !== 'none' && style.visibility !== 'hidden') {
                    (el as HTMLElement).click();
                    closed++;
                  }
                }
              } catch {}
            }
            
            return closed;
          });
          
          if (overlaysClosed > 0) {
            getLogger().info(
              { sessionId: context.sessionId, overlaysClosed },
              'Closed overlays, waiting for player to become available'
            );
            
            // Tiempo optimizado (reducido de 1500ms)
            await page.waitForTimeout(1000);
            
            // Intentar clic en el centro nuevamente después de cerrar overlays
            try {
              const vp = page.viewport() || { width: 800, height: 600 };
              const cx = Math.max(1, Math.floor(vp.width / 2));
              const cy = Math.max(1, Math.floor(vp.height / 2));
              
              await Promise.race([
                page.mouse.click(cx, cy),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Post-overlay click timeout')), 2000) // Reducido de 3000ms
                )
              ]);
              clicksPerformed++;
              
              const detected = await this.waitForStreamDetection(
                detector,
                1500, // Reducido de 2000ms
                context.sessionId,
              );
              
              if (detected) {
                getLogger().info(
                  { sessionId: context.sessionId },
                  'HLS detected after closing overlays!'
                );
                successfulStrategy = detected;
              }
            } catch {}
          }
        } catch (e) {
          getLogger().warn(
            { sessionId: context.sessionId, err: (e as Error)?.message },
            'Overlay closing failed'
          );
        }

        // ESTRATEGIA 2: Elementos play (solo si overlays no funcionó)
        if (!successfulStrategy) {
          try {
            // Buscar elementos clickeables específicos (botones de play, video elements, etc)
            const playElements = await page.evaluate(() => {
              const selectors = [
                // Selectores específicos para reproductores
                'button[class*="play"]', 'button[id*="play"]', 'button[class*="Play"]',
                '.play-button', '.video-play', '.player-play', '.play-btn',
                'video', '.video-container', '.player-container', '.video-wrapper',
                '[class*="player"]', '[id*="player"]', '[class*="Player"]',
                'button[aria-label*="play"]', 'button[title*="play"]', 'button[title*="Play"]',
                // Selectores más específicos para sitios de streaming
                '.vjs-big-play-button', '.plyr__control--overlaid',
                '.video-js .vjs-poster', '.plyr--video',
                '[class*="overlay"]', '[class*="Overlay"]',
                '[data-testid*="play"]', '[data-test*="play"]',
                // Centros de iframes y divs grandes que podrían ser reproductores
                'iframe[src*="player"]', 'iframe[src*="embed"]',
                'div[class*="video"]:not([class*="ad"])', 'div[id*="video"]:not([id*="ad"])'
              ];
              
              const elements: Array<{x: number, y: number, tag: string, classes: string, id: string, area: number}> = [];
              
              for (const selector of selectors) {
                try {
                  const els = document.querySelectorAll(selector);
                  for (const el of Array.from(els)) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 20 && rect.height > 20 && rect.top >= 0 && rect.left >= 0) {
                      // Evitar elementos de anuncios
                      const classList = el.className?.toLowerCase() || '';
                      const elementId = el.id?.toLowerCase() || '';
                      if (classList.includes('ad') || classList.includes('ads') || 
                          elementId.includes('ad') || elementId.includes('ads')) {
                        continue;
                      }
                      
                      const area = rect.width * rect.height;
                      elements.push({
                        x: Math.floor(rect.left + rect.width / 2),
                        y: Math.floor(rect.top + rect.height / 2),
                        tag: el.tagName.toLowerCase(),
                        classes: el.className || '',
                        id: el.id || '',
                        area: area
                      });
                    }
                  }
                } catch {}
              }
              
              // Ordenar por área (elementos más grandes primero) y limitar a 5
              return elements.sort((a, b) => b.area - a.area).slice(0, 5);
            });
            
            getLogger().info(
              { sessionId: context.sessionId, elementsFound: playElements.length },
              `Found ${playElements.length} potential play elements`
            );
            
            // Intentar hacer clic en elementos específicos de play/video
            for (const element of playElements) {
              try {
                getLogger().info(
                  { sessionId: context.sessionId, element },
                  'Clicking on potential play element'
                );
                
                await Promise.race([
                  page.mouse.click(element.x, element.y),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Play element click timeout')), 2500) // Reducido de 3000ms
                  )
                ]);
                clicksPerformed++;
                
                // Esperar más tiempo para que se active el reproductor
                await page.waitForTimeout(800); // Reducido de 1000ms
                
                const detected = await this.waitForStreamDetection(
                  detector,
                  1800, // Reducido de 2000ms
                  context.sessionId,
                );
                
                if (detected) {
                  getLogger().info(
                    { sessionId: context.sessionId, element },
                    'HLS detected after clicking play element!'
                  );
                  successfulStrategy = detected;
                  break;
                }
              } catch (e) {
                getLogger().debug(
                  { sessionId: context.sessionId, err: (e as Error)?.message },
                  'Play element click failed'
                );
              }
            }
          } catch (e) {
            getLogger().warn(
              { sessionId: context.sessionId, err: (e as Error)?.message },
              'Play elements detection failed'
            );
          }
        }
        
        if (!successfulStrategy) {
          try {
            const frames: Array<{
              x: number;
              y: number;
              w: number;
              h: number;
              src: string;
            }> = await page.evaluate(() => {
              const list = Array.from(document.querySelectorAll('iframe'))
                .map(el => {
                  const r = el.getBoundingClientRect();
                  return {
                    x: Math.floor(r.left + r.width / 2),
                    y: Math.floor(r.top + r.height / 2),
                    w: Math.floor(r.width),
                    h: Math.floor(r.height),
                    src: (el as HTMLIFrameElement).src || '',
                  };
                })
                .filter(f => f.w > 40 && f.h > 40); // descartar iframes diminutos típicos de ads
              list.sort((a, b) => b.w * b.h - a.w * a.h);
              return list.slice(0, 2); // mayor y segundo mayor por área
            });
            
            for (const f of frames) {
              try {
                getLogger().debug(
                  { sessionId: context.sessionId, frameUrl: f.src, size: `${f.w}x${f.h}` },
                  'Trying click on iframe'
                );
                
                // Agregar timeout para iframe clicks
                await Promise.race([
                  page.mouse.click(f.x, f.y),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Iframe click timeout')), 3000)
                  )
                ]);
                clicksPerformed++;
                
                const ok = await this.waitForStreamDetection(
                  detector,
                  1200,
                  context.sessionId,
                );
                if (ok) {
                  successfulStrategy = ok;
                  break;
                }
              } catch (e) {
                getLogger().debug(
                  { sessionId: context.sessionId, frameUrl: f.src, err: (e as Error)?.message },
                  'Iframe click failed',
                );
              }
            }
          } catch (e) {
            getLogger().warn(
              { sessionId: context.sessionId, err: (e as Error)?.message },
              'Iframe fallback failed',
            );
          }
        }
      }

      if (options?.debug) {
        try {
          await page.screenshot({ path: `./debug-after-click.png` });
        } catch {}
      }

      // Esperar para detectar streams (listeners ya activos) con más tiempo
      if (!successfulStrategy) {
        getLogger().info(
          { sessionId: context.sessionId },
          'No HLS found with specific strategies, waiting for stream detection with extended timeout'
        );
        
        successfulStrategy = await this.waitForStreamDetection(
          detector,
          Math.max(5000, maxWait - shortWait), // Mínimo 5 segundos adicionales
          context.sessionId,
        );
      }
      
      // Log final de diagnóstico
      const finalCandidates = detector.getCandidates();
      getLogger().info(
        { 
          sessionId: context.sessionId, 
          candidatesFound: finalCandidates.length,
          candidates: finalCandidates.map(c => ({ url: c.url, contentType: c.contentType })),
          clicksPerformed,
          strategy: successfulStrategy?.name || 'none'
        },
        'Navigation and detection phase completed'
      );
      
      return {
        strategy: successfulStrategy,
        clicksPerformed
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          incrementNavigationError('navigation_timeout');
        } else if (error.message.includes('net::ERR')) {
          incrementNavigationError('network_error');
        } else {
          incrementNavigationError('navigation_error');
        }
      }

      throw error;
    } finally {
      // (3) Limpieza del listener de popups para evitar fugas de listeners entre resoluciones
      try {
        browser.off('targetcreated', onTargetCreated);
      } catch {}
    }
  }

  private async performActivationStrategy(
    browserPage: BrowserPage,
    context: DetectionContext,
    detector: HLSDetector,
  ): Promise<ActivationStrategy | null> {
    const domain = new URL(context.url).hostname;
    const cachedStrategy = await this.strategyCache.get(domain);

    const strategies: ActivationStrategyName[] = cachedStrategy
      ? [cachedStrategy.name, ...Object.values(ActivationStrategyName).filter(s => s !== cachedStrategy.name)]
      : [ActivationStrategyName.FastCenterOnce, ActivationStrategyName.FastCenterDouble];

    // Si HLS aparece sin clic, la estrategia es 'none'
    if (detector.getCandidates().length > 0) {
      return { name: ActivationStrategyName.None };
    }

    for (const strategyName of strategies) {
      if (strategyName === ActivationStrategyName.None) continue;

      getLogger().debug({ sessionId: context.sessionId, strategy: strategyName }, 'Applying activation strategy');

      const clickRetries = strategyName === ActivationStrategyName.FastCenterDouble ? 2 : 1;

      for (let i = 0; i < clickRetries; i++) {
        await this.clickViewportCenterFast(browserPage);
        await browserPage.wait(3000); // Espera bounded para detección post-clic

        if (detector.getCandidates().length > 0) {
          getLogger().info({ sessionId: context.sessionId, strategy: strategyName, clicks: i + 1 }, 'HLS detected after activation');
          return { name: strategyName };
        }
      }
    }

    getLogger().warn({ sessionId: context.sessionId }, 'No HLS streams detected after all activation strategies.');
    return null;
  }

  private async detectInIframes(page: any, sessionId: string): Promise<void> {
    try {
      const frames = page.frames();

      getLogger().debug({
        sessionId,
        framesCount: frames.length,
      }, 'Checking frames for stream detection');

      for (const frame of frames) {
        try {
          if (frame.url() && frame.url() !== 'about:blank') {
            // Esperar un poco para que el frame cargue
            await page.waitForTimeout(1000);

            getLogger().debug({
              sessionId,
              frameUrl: sanitizeUrlForLogging(frame.url()),
            }, 'Checking frame for streams');
          }
        } catch (error) {
          getLogger().debug({
            sessionId,
            frameUrl: frame.url(),
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 'Error checking frame');
        }
      }
    } catch (error) {
      getLogger().warn({
        sessionId,
        error,
      }, 'Error during iframe detection');
    }
  }

  private async processDetectionResults(
    context: DetectionContext,
    detector: HLSDetector,
  ): Promise<ResolveResponse> {
    // This method is now legacy, its logic is partially moved to resolveHLS
    return {} as ResolveResponse;
  }

  private async processHLSCandidates(
    candidates: HLSCandidate[],
    context: DetectionContext,
  ): Promise<Stream[]> {
    const streams: Stream[] = [];

    for (const candidate of candidates) {
      try {
        const stream = await this.processHLSCandidate(candidate, context);
        if (stream) {
          streams.push(stream);

          // Métricas
          incrementHlsStreams(
            stream.isLive || false,
            stream.isLowLatency || false,
            (stream.variants?.length || 0) > 0
          );
        }
      } catch (error) {
        getLogger().warn({
          sessionId: context.sessionId,
          candidateUrl: sanitizeUrlForLogging(candidate.url),
          error,
        }, 'Failed to process HLS candidate');
      }
    }

    return streams;
  }

  private async processHLSCandidate(
    candidate: HLSCandidate,
    context: DetectionContext,
  ): Promise<Stream | null> {
    try {
      // Intentar obtener el contenido del manifiesto
      const manifestContent = await this.fetchManifestContent(candidate, context);

      if (!manifestContent || !M3U8Parser.isValidM3U8(manifestContent)) {
        return null;
      }

      // Parsear el manifiesto
      const parsed = await M3U8Parser.parseManifest(manifestContent, candidate.url);

      const stream: Stream = {
        type: 'HLS',
        masterUrl: normalizeUrl(candidate.url),
        isLive: parsed.isLive,
        isLowLatency: parsed.isLowLatency,
        variants: parsed.variants.length > 0 ? parsed.variants : undefined,
        mediaPlaylists: parsed.mediaPlaylists.length > 0 ? parsed.mediaPlaylists : undefined,
        encryption: parsed.encryption,
      };

      getLogger().debug({
        sessionId: context.sessionId,
        streamUrl: sanitizeUrlForLogging(stream.masterUrl),
        isLive: stream.isLive,
        variantsCount: stream.variants?.length || 0,
      }, 'Successfully processed HLS stream');

      return stream;

    } catch (error) {
      getLogger().debug({
        sessionId: context.sessionId,
        candidateUrl: sanitizeUrlForLogging(candidate.url),
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Failed to process HLS candidate');

      return null;
    }
  }

  private async fetchManifestContent(
    candidate: HLSCandidate,
    context: DetectionContext,
  ): Promise<string | null> {
    const logger = getLogger();
    const sanitizedCandidateUrl = sanitizeUrlForLogging(candidate.url);

    // 1. Normalizar y validar la URL del candidato
    const manifestUrl = normalizeM3U8Url(candidate.url);
    if (!manifestUrl) {
      logger.warn({ sessionId: context.sessionId, candidateUrl: sanitizedCandidateUrl }, 'Candidato HLS descartado por URL inválida.');
      return null;
    }

    const manifestDomain = manifestUrl.hostname;

    const relevantCookies = candidate.cookies.filter(cookie => {
      const cookieDomain = cookie.domain || manifestDomain;
      // Comprobar si el dominio del manifiesto coincide con el dominio de la cookie
      // Esto incluye subdominios, por ej. .example.com coincide con api.example.com
      return manifestDomain.endsWith(cookieDomain.startsWith('.') ? cookieDomain.substring(1) : cookieDomain);
    });

    const baseHeaders = {
      userAgent: this.config.USER_AGENT,
      cookie: relevantCookies.map(c => `${c.name}=${c.value}`).join('; ') || undefined,
    };

    // --- Intento 1: Perfil de cabeceras completo ---
    let headers = HeadersManager.buildContextualHeaders(context.url, candidate.url, baseHeaders, false).getAll();

    try {
      const response = await axios.get(manifestUrl.href, {
        headers,
        timeout: this.config.M3U8_DOWNLOAD_TIMEOUT_MS,
        responseType: 'text',
      });
      return response.data;
    } catch (error: any) {
      // Si el error no es por caracteres inválidos, fallar directamente
      if (error.code !== 'ERR_INVALID_CHAR') {
        logger.error({
            sessionId: context.sessionId,
            candidateUrl: sanitizedCandidateUrl,
            error: { code: error.code, message: error.message }
        }, 'Error no relacionado con cabeceras al descargar manifiesto.');
        return null;
      }

      logger.warn({
          sessionId: context.sessionId,
          candidateUrl: sanitizedCandidateUrl
      }, 'Fallo en el primer intento por cabeceras inválidas. Reintentando con perfil mínimo.');
    }

    // --- Intento 2: Perfil de cabeceras mínimo (fallback) ---
    headers = HeadersManager.buildContextualHeaders(context.url, candidate.url, baseHeaders, true).getAll();

    try {
      const response = await axios.get(manifestUrl.href, {
        headers,
        timeout: this.config.M3U8_DOWNLOAD_TIMEOUT_MS,
        responseType: 'text',
      });
      return response.data;
    } catch (error: any) {
      logger.error({
          sessionId: context.sessionId,
          candidateUrl: sanitizedCandidateUrl,
          error: { code: error.code, message: error.message }
      }, 'Fallo al descargar el manifiesto después del reintento con perfil mínimo.');
      return null;
    }
  }

  private determineBestGuess(streams: Stream[]): number | undefined {
    if (streams.length === 0) return undefined;
    if (streams.length === 1) return 0;

    let bestIndex = 0;
    let bestScore = 0;

    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      if (!stream) continue;
      let score = 0;

      // Preferir streams con más variantes
      score += (stream.variants?.length || 0) * 10;

      // Preferir streams master
      if (stream.variants && stream.variants.length > 1) {
        score += 50;
      }

      // Preferir streams live
      if (stream.isLive) {
        score += 20;
      }

      // Preferir streams con baja latencia
      if (stream.isLowLatency) {
        score += 30;
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  private generateNotes(candidates: HLSCandidate[], streams: Stream[]): string[] {
    const notes: string[] = [];

    if (candidates.length === 0) {
      notes.push('No se detectaron candidatos HLS en la página');
    } else if (streams.length === 0) {
      notes.push(`Se detectaron ${candidates.length} candidatos HLS pero ninguno pudo ser procesado`);
    } else if (streams.length < candidates.length) {
      notes.push(`Se procesaron ${streams.length} de ${candidates.length} candidatos detectados`);
    }

    if (streams.length > 1) {
      notes.push(`Se encontraron múltiples streams. El campo 'bestGuess' indica el recomendado`);
    }

    const liveStreams = streams.filter(s => s.isLive).length;
    const lowLatencyStreams = streams.filter(s => s.isLowLatency).length;

    if (liveStreams > 0) {
      notes.push(`${liveStreams} stream(s) detectado(s) como live`);
    }

    if (lowLatencyStreams > 0) {
      notes.push(`${lowLatencyStreams} stream(s) con baja latencia detectado(s)`);
    }

    return notes;
  }

  private generateSessionId(): string {
    const timestamp = Date.now().toString();
    const random = crypto.randomBytes(8).toString('hex');
    return `${timestamp}-${random}`;
  }

  private async clickViewportCenterFast(page: BrowserPage): Promise<void> {
    try {
      const pageInstance = page.getPage();
      const dimensions = await Promise.race([
        pageInstance.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })),
        new Promise<{width: number, height: number}>((_, reject) => 
          setTimeout(() => reject(new Error('Evaluate timeout')), 3000)
        )
      ]);
      const centerX = Math.max(1, Math.floor((dimensions.width || 1920) / 2));
      const centerY = Math.max(1, Math.floor((dimensions.height || 1080) / 2));
      
      await Promise.race([
        pageInstance.mouse.click(centerX, centerY, { delay: 0 }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Click timeout')), 3000)
        )
      ]);
    } catch (error) {
      throw new Error(`Fast click failed: ${(error as Error)?.message}`);
    }
  }

  private async waitForStreamDetection(
    detector: HLSDetector,
    timeout: number,
    sessionId: string,
  ): Promise<ActivationStrategy | null> {
    const checkInterval = 100; // Verificar más frecuentemente (cada 100ms)
    const endTime = Date.now() + timeout;
    let lastCheck = 0;

    while (Date.now() < endTime) {
      const candidates = detector.getCandidates();
      if (candidates.length > 0) {
        getLogger().info(
          { sessionId, candidatesFound: candidates.length, timeRemaining: endTime - Date.now() },
          'HLS streams detected during wait period'
        );
        return { name: ActivationStrategyName.None };
      }
      
      // Log cada segundo para mostrar progreso
      const now = Date.now();
      if (now - lastCheck > 1000) {
        const remaining = Math.ceil((endTime - now) / 1000);
        getLogger().debug(
          { sessionId, timeRemaining: remaining },
          `Waiting for HLS detection... ${remaining}s remaining`
        );
        lastCheck = now;
      }
      
      await new Promise(r => setTimeout(r, checkInterval));
    }
    
    getLogger().debug(
      { sessionId, timeout },
      'Stream detection timeout reached'
    );
    return null;
  }
}
