import crypto from 'crypto';
import { AntiDevtoolBrowserPage } from './anti-devtool-browser-page.js';
import { AggressiveHLSDetector } from './detectors/aggressive-hls-detector.js';
import { getLogger } from '../observability/logger.js';
import { getConfig } from '../../config/env.js';
import { ResolveHLSResponse, Manifest } from '../../types/dto.js';
import { sanitizeUrlForLogging } from '../../utils/url.js';

/**
 * Opciones para resolver con anti-devtool
 */
export interface AntiDevtoolResolveOptions {
  url: string;
  timeoutMs?: number;
  waitAfterClick?: number;
  clickRetries?: number;
  userAgent?: string;
}

/**
 * Servicio especializado para resolver sitios con bloqueadores anti-devtool.
 * 
 * Basado en el código exitoso de n8n/Browserless:
 * 1. Usa navegador con flags anti-detección
 * 2. Inyecta bypass antes de navegación
 * 3. Bloquea scripts anti-devtool
 * 4. Captura HLS de forma agresiva
 * 5. Interactúa con el reproductor para activar el stream
 */
export class AntiDevtoolResolverService {
  private config = getConfig();

  /**
   * Resuelve una URL de un sitio con bloqueador anti-devtool
   */
  async resolve(options: AntiDevtoolResolveOptions): Promise<ResolveHLSResponse> {
    const sessionId = this.generateSessionId();
    const startTime = Date.now();
    const timings = { total: 0, navigation: 0, activation: 0, detection: 0 };
    let clicksPerformed = 0;
    let manifests: Manifest[] = [];

    const sanitizedUrl = sanitizeUrlForLogging(options.url);
    getLogger().info(
      { sessionId, url: sanitizedUrl },
      '🛡️ Starting Anti-Devtool HLS resolve',
    );

    let browserPage: AntiDevtoolBrowserPage | undefined;
    let detector: AggressiveHLSDetector | undefined;

    try {
      // 1. Crear página especializada con protección anti-devtool
      browserPage = new AntiDevtoolBrowserPage(sessionId);
      await browserPage.initialize({
        url: options.url,
        sessionId,
        userAgent: options.userAgent,
      });

      // 2. Configurar detector agresivo
      detector = new AggressiveHLSDetector(sessionId);
      const page = browserPage.getPage();
      await detector.setup(page);

      // 3. Navegar a la URL
      const navStartTime = Date.now();
      await browserPage.navigateTo(options.url, {
        waitUntil: 'networkidle0',
        timeout: options.timeoutMs || 30000,
      });
      timings.navigation = Date.now() - navStartTime;

      getLogger().debug(
        { sessionId },
        '✅ Navigation completed, starting player interaction',
      );

      // 4. Espera inicial para que la página cargue
      await page.waitForTimeout(3000);

      // 5. Intentar encontrar y clickear el reproductor
      const activationStartTime = Date.now();
      
      // DEBUG: Ver qué elementos hay en la página antes de hacer click
      const pageInfo = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        const players = document.querySelectorAll('[id*="player"], [class*="player"]');
        const iframes = document.querySelectorAll('iframe');
        
        return {
          videoCount: videos.length,
          videoSrcs: Array.from(videos).map(v => (v as HTMLVideoElement).src || '(empty)'),
          playerCount: players.length,
          playerIds: Array.from(players).map(p => p.id || p.className),
          iframeCount: iframes.length,
          iframeSrcs: Array.from(iframes).map(i => (i as HTMLIFrameElement).src),
        };
      });
      
      getLogger().debug(
        {
          sessionId,
          pageInfo,
        },
        '📋 Page elements before click',
      );
      
      // Selectores comprehensivos para reproductores
      const playerSelector =
        '#player, video, .player, [id*="player"], [class*="player"]';

      try {
        // Intentar esperar por el selector del reproductor
        await page.waitForSelector(playerSelector, { timeout: 10000 });
        
        // DEBUG: Ver qué elemento se encontró
        const foundElement = await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          return el ? {
            tagName: el.tagName,
            id: el.id,
            className: el.className,
            visible: window.getComputedStyle(el).display !== 'none',
          } : null;
        }, playerSelector);
        
        getLogger().debug(
          {
            sessionId,
            foundElement,
          },
          '🎯 Player element found',
        );
        
        await page.click(playerSelector);
        clicksPerformed++;
        
        getLogger().info(
          { sessionId },
          '✓ Click en reproductor (selector específico)',
        );
      } catch (e) {
        // Fallback: Click en el centro de la ventana
        const dimensions = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));

        getLogger().debug(
          {
            sessionId,
            dimensions,
            error: (e as Error).message,
          },
          '⚠️ Player selector failed, using center click fallback',
        );

        await page.mouse.click(dimensions.width / 2, dimensions.height / 2);
        clicksPerformed++;
        
        getLogger().info(
          { sessionId },
          '✓ Click en centro de la ventana (fallback)',
        );
      }

      timings.activation = Date.now() - activationStartTime;

      // 6. Esperar a que se carguen los manifiestos y segmentos
      const waitTime = options.waitAfterClick || 8000;
      getLogger().debug(
        { sessionId, waitTime },
        `Waiting ${waitTime}ms for HLS streams to load...`,
      );
      
      await page.waitForTimeout(waitTime);

      // 7. CRÍTICO: Extraer HLS del DOM directamente (como en n8n)
      // Esto es necesario porque el src del video puede no generar requests HTTP
      const domExtractionStartTime = Date.now();
      const hlsFromDOM = await page.evaluate(() => {
        const results = {
          videoSrcs: [] as string[],
          sourceSrcs: [] as string[],
        };
        
        // Extraer de elementos <video>
        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
          const src = (video as HTMLVideoElement).src;
          if (src && (src.includes('.m3u8') || src.includes('hls'))) {
            results.videoSrcs.push(src);
          }
        });
        
        // Extraer de elementos <source>
        const sources = document.querySelectorAll('source');
        sources.forEach(source => {
          const src = (source as HTMLSourceElement).src;
          if (src && (src.includes('.m3u8') || src.includes('hls'))) {
            results.sourceSrcs.push(src);
          }
        });
        
        return results;
      });
      
      getLogger().info(
        {
          sessionId,
          videoSrcs: hlsFromDOM.videoSrcs,
          sourceSrcs: hlsFromDOM.sourceSrcs,
        },
        '🎬 HLS URLs extracted from DOM',
      );

      // 8. Obtener resultados del detector agresivo
      const detectionStartTime = Date.now();
      const detectionResult = detector.getResults();
      timings.detection = Date.now() - detectionStartTime;

      // 9. Combinar resultados: HTTP requests + DOM extraction
      const allM3u8Urls = new Set<string>();
      
      // Agregar URLs del DOM (prioridad alta)
      hlsFromDOM.videoSrcs.forEach(url => allM3u8Urls.add(url));
      hlsFromDOM.sourceSrcs.forEach(url => allM3u8Urls.add(url));
      
      // Agregar URLs de requests HTTP
      detectionResult.allM3u8Urls.forEach(url => allM3u8Urls.add(url));
      
      if (allM3u8Urls.size > 0) {
        manifests = Array.from(allM3u8Urls).map((url) => ({
          url: url,
          status: 200,
          contentType: 'application/vnd.apple.mpegurl',
          fromTargetId: sessionId,
          timestamp: Date.now(),
        }));

        getLogger().info(
          {
            sessionId,
            manifestsFound: manifests.length,
            fromDOM: hlsFromDOM.videoSrcs.length + hlsFromDOM.sourceSrcs.length,
            fromHTTP: detectionResult.allM3u8Urls.length,
            urls: Array.from(allM3u8Urls),
          },
          '🎉 Anti-Devtool resolve successful - HLS found!',
        );
      } else {
        getLogger().warn(
          {
            sessionId,
            capturedCount: detector.getCandidatesCount(),
            domVideosCount: hlsFromDOM.videoSrcs.length,
            domSourcesCount: hlsFromDOM.sourceSrcs.length,
          },
          '⚠️ No HLS manifests found (neither DOM nor HTTP)',
        );
      }
    } catch (error) {
      getLogger().error(
        { sessionId, error, url: sanitizedUrl },
        '❌ Anti-Devtool resolve failed',
      );
      throw error;
    } finally {
      // Cleanup
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

      timings.total = Date.now() - startTime;
    }

    getLogger().info(
      {
        sessionId,
        manifestsFound: manifests.length,
        timings,
        clicksPerformed,
      },
      'Anti-Devtool HLS resolve completed',
    );

    return {
      manifests,
      timings,
      clicksPerformed,
      targetsObserved: 1,
    };
  }

  /**
   * Genera un ID de sesión único
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString();
    const random = crypto.randomBytes(8).toString('hex');
    return `anti-devtool-${timestamp}-${random}`;
  }
}

