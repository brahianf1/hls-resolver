import crypto from 'crypto';
import { 
  ResolveRequest, 
  ResolveResponse, 
  Stream, 
  DetectionContext,
  RawFinding,
  HLSCandidate
} from '../../types/dto.js';
import { BrowserPool, BrowserPage } from './browser.pool.js';
import { HLSDetector } from './detectors/hls-detector.js';
import { M3U8Parser } from './parsers/m3u8.parser.js';
import { getLogger, logPerformance } from '../observability/logger.js';
import { 
  incrementResolveRequest, 
  incrementHlsStreams,
  incrementNavigationError 
} from '../observability/metrics.js';
import { getConfig, getAllowlistHosts } from '../../config/env.js';
import { 
  isValidUrl, 
  isDomainAllowed, 
  sanitizeUrlForLogging,
  normalizeUrl,
  normalizeM3U8Url 
} from '../../utils/url.js';
import { 
  HeadersManager 
} from '../../utils/headers.js';
import axios from 'axios';
import { IStrategyCache, Strategy } from '../cache/strategy-cache.interface.js';

export class ResolverService {
  private browserPool: BrowserPool;
  private strategyCache: IStrategyCache;
  private config = getConfig();

  constructor(browserPool: BrowserPool, strategyCache: IStrategyCache) {
    this.browserPool = browserPool;
    this.strategyCache = strategyCache;
  }

  /**
   * Resuelve una URL para detectar streams HLS
   */
  async resolve(request: ResolveRequest): Promise<ResolveResponse> {
    const sessionId = this.generateSessionId();
    const startTime = Date.now();
    const sanitizedUrl = sanitizeUrlForLogging(request.url);
    
    getLogger().info({
      sessionId,
      url: sanitizedUrl,
      options: request.options,
    }, 'Starting resolve request');

    try {
      // Validaciones iniciales
      this.validateRequest(request);

      // Crear contexto de detección
      const context: DetectionContext = {
        url: request.url,
        options: request.options || {},
        sessionId,
        startTime,
      };

      // Obtener página del pool
      const browserPage = await this.browserPool.getPage();
      
      try {
        // Configurar detección HLS
        const detector = new HLSDetector(context);
        await detector.setupDetection(browserPage);

        // Navegar y detectar streams
        const successfulStrategy = await this.navigateAndDetect(browserPage, context, detector);

        // Recopilar cookies
        await detector.collectCookies(browserPage.getPage());

        // Procesar candidatos detectados
        const result = await this.processDetectionResults(context, detector);

        const duration = Date.now() - startTime;
        const hasStreams = result.streams.length > 0;

        // Guardar la estrategia en caché si la detección fue exitosa
        if (hasStreams) {
          const domain = new URL(request.url).hostname;
          const strategyToCache = successfulStrategy || { selector: 'none', timeout: 0 };
          await this.strategyCache.set(domain, strategyToCache);
        }

        // Métricas y logs
        incrementResolveRequest('success', hasStreams, duration);
        logPerformance('resolve_request', duration, true, {
          sessionId,
          streamsFound: result.streams.length,
          candidatesFound: detector.getCandidates().length,
        });

        getLogger().info({
          sessionId,
          url: sanitizedUrl,
          streamsFound: result.streams.length,
          duration,
        }, 'Resolve request completed successfully');

        return result;

      } finally {
        await browserPage.release();
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      
      incrementResolveRequest('error', false, duration);
      logPerformance('resolve_request', duration, false, {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      getLogger().error({
        sessionId,
        url: sanitizedUrl,
        error,
        duration,
      }, 'Resolve request failed');

      throw error;
    }
  }

  /**
   * Valida la request de resolución
   */
  private validateRequest(request: ResolveRequest): void {
    if (!isValidUrl(request.url)) {
      throw new Error(`Invalid URL: ${request.url}`);
    }

    const allowedHosts = getAllowlistHosts();
    if (!isDomainAllowed(request.url, allowedHosts)) {
      throw new Error(`Domain not allowed: ${request.url}`);
    }
  }

  /**
   * Navega a la URL y ejecuta la detección
   */
  private async navigateAndDetect(
    browserPage: BrowserPage,
    context: DetectionContext,
    detector: HLSDetector
  ): Promise<Strategy | null> {
    const page = browserPage.getPage();
    const options = context.options;

    try {
      // Configurar headers adicionales si se proporcionaron
      if (options?.extraHeaders) {
        await page.setExtraHTTPHeaders(options.extraHeaders as Record<string, string>);
      }

      // Emular móvil si se solicita
      if (options?.emulateMobile) {
        await page.emulate({
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
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
      const navTimeout = options?.navTimeoutMs || this.config.NAV_TIMEOUT_MS;
      const maxWait = options?.maxWaitMs || this.config.MAX_WAIT_MS;

      // Navegar a la URL
      await browserPage.navigateTo(context.url, {
        waitUntil: options?.waitUntil || 'networkidle0',
        timeout: navTimeout,
      });

      getLogger().debug({
        sessionId: context.sessionId,
        url: sanitizeUrlForLogging(context.url),
      }, 'Navigation completed, waiting for stream detection');

      // Esperar para detectar streams
      const successfulStrategy = await this.waitForStreamDetection(page, maxWait, context.sessionId, context.url);

      // Intentar detectar en iframes si no se encontraron streams
      const candidates = detector.getCandidates();
      if (candidates.length === 0) {
        await this.detectInIframes(page, context.sessionId);
      }

      return successfulStrategy; // Devolver la estrategia exitosa

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
    }
  }

  /**
   * Espera para la detección de streams con diferentes estrategias
   */
  private async waitForStreamDetection(
    page: any,
    maxWaitMs: number,
    sessionId: string,
    url: string
  ): Promise<Strategy | null> {

    const domain = new URL(url).hostname;

    const defaultStrategies: Strategy[] = [
      { selector: 'video', timeout: 3000 },
      { selector: '[data-hls]', timeout: 2000 },
      { selector: '.video-player', timeout: 2000 },
    ];

    const cachedStrategy = await this.strategyCache.get(domain);

    // Si la estrategia cacheada es 'none', no esperar
    if (cachedStrategy && cachedStrategy.selector === 'none') {
      getLogger().debug({ domain }, 'Skipping wait strategies based on cache.');
      return null;
    }

    const strategies = cachedStrategy
      ? [cachedStrategy, ...defaultStrategies.filter(s => s.selector !== cachedStrategy.selector)]
      : defaultStrategies;

    const startTime = Date.now();
    let successfulStrategy: Strategy | null = null;

    for (const strategy of strategies) {
      if (Date.now() - startTime >= maxWaitMs) {
        break;
      }

      try {
        if (strategy.selector) {
          await page.waitForSelector(strategy.selector, { 
            timeout: strategy.timeout 
          });
          getLogger().debug({
            sessionId,
            selector: strategy.selector,
          }, 'Found target selector');
          
          // Esperar un poco más después de encontrar el selector
          await page.waitForTimeout(1000);

          successfulStrategy = strategy;
          break;
        } 
      } catch (error) {
        // Continuar con la siguiente estrategia
        getLogger().debug({
          sessionId,
          strategy,
          error: error instanceof Error ? error.message : 'Unknown error',
        }, 'Wait strategy failed, trying next');
      }
    }

    // Espera mínima para asegurar que se capturen requests
    const remainingTime = Math.max(1000, maxWaitMs - (Date.now() - startTime));
    if (remainingTime > 0) {
      await page.waitForTimeout(Math.min(remainingTime, 3000));
    }

    return successfulStrategy;
  }

  /**
   * Detecta streams en iframes
   */
  private async detectInIframes(
    page: any,
    sessionId: string
  ): Promise<void> {
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

  /**
   * Procesa los resultados de la detección
   */
  private async processDetectionResults(
    context: DetectionContext,
    detector: HLSDetector
  ): Promise<ResolveResponse> {
    const candidates = detector.getCandidates();
    const requiredHeaders = detector.getRequiredHeaders();
    const requiredCookies = detector.getRequiredCookies();

    getLogger().debug({
      sessionId: context.sessionId,
      candidatesCount: candidates.length,
      headersCount: Object.keys(requiredHeaders).length,
      cookiesCount: requiredCookies.length,
    }, 'Processing detection results');

    // Convertir candidatos a streams
    const streams = await this.processHLSCandidates(candidates, context);
    
    // Determinar el mejor candidato
    const bestGuess = this.determineBestGuess(streams);

    // Crear findings raw
    const rawFindings: RawFinding[] = candidates.map(candidate => ({
      url: candidate.url,
      contentType: candidate.contentType,
    }));

    // Generar notas
    const notes = this.generateNotes(candidates, streams);

    const contextualHeaders = new HeadersManager(requiredHeaders)
      .getAll() as Record<string, string>;

    return {
      sessionId: context.sessionId,
      pageUrl: context.url,
      detectedAt: new Date().toISOString(),
      streams,
      bestGuess,
      requiredHeaders: contextualHeaders,
      requiredCookies: requiredCookies.length > 0 ? requiredCookies : undefined,
      rawFindings: rawFindings.length > 0 ? rawFindings : undefined,
      notes: notes.length > 0 ? notes : undefined,
    };
  }

  /**
   * Procesa candidatos HLS y los convierte en streams
   */
  private async processHLSCandidates(
    candidates: HLSCandidate[],
    context: DetectionContext
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

  /**
   * Procesa un candidato HLS individual
   */
  private async processHLSCandidate(
    candidate: HLSCandidate,
    context: DetectionContext
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

  /**
   * Obtiene el contenido de un manifiesto HLS de forma segura.
   * Utiliza una estrategia de dos intentos: primero con cabeceras completas y luego con un perfil mínimo si falla.
   */
  private async fetchManifestContent(candidate: HLSCandidate, context: DetectionContext): Promise<string | null> {
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

  /**
   * Determina el mejor candidato basándose en heurísticas
   */
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

  /**
   * Genera notas explicativas sobre la detección
   */
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

  /**
   * Genera un ID de sesión único
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString();
    const random = crypto.randomBytes(8).toString('hex');
    return `${timestamp}-${random}`;
  }
}
