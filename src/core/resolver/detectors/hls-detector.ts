import type { Page, HTTPResponse, HTTPRequest, Frame } from 'puppeteer';
import { HLSCandidate, DetectionContext, Cookie } from '../../../types/dto.js';
import { getLogger } from '../../observability/logger.js';
import { BrowserPage } from '../browser.pool.js';

export class HLSDetector {
  private candidates: Map<string, HLSCandidate> = new Map();
  private context: DetectionContext;
  private collectedHeaders: Record<string, string> = {};
  private collectedCookies: Cookie[] = [];

  constructor(context: DetectionContext) {
    this.context = context;
  }

  /**
   * Configura los listeners de detección en una página
   */
  async setupDetection(browserPage: BrowserPage): Promise<void> {
    const page = browserPage.getPage();
    
    // Listener para responses
    page.on('response', (response: HTTPResponse) => {
      this.handleResponse(response);
    });

    // Listener para requests
    page.on('request', (request: HTTPRequest) => {
      this.handleRequest(request);
    });

    // Listener para request finished (para obtener headers finales)
    page.on('requestfinished', (request: HTTPRequest) => {
      this.handleRequestFinished(request);
    });

    // Listener para frames (iframes)
    page.on('frameattached', (frame: Frame) => {
      this.setupFrameDetection(frame);
    });

    getLogger().debug({ sessionId: this.context.sessionId }, 'HLS detection listeners configured');
  }

  /**
   * Maneja responses HTTP para detectar streams HLS
   */
  private handleResponse(response: HTTPResponse): void {
    try {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      const status = response.status();

      // Verificar si es un candidato HLS válido
      if (this.isHLSCandidate(url, contentType) && status >= 200 && status < 400) {
        this.addCandidate({
          url,
          contentType,
          headers: this.extractRelevantHeaders(response.request().headers()),
          cookies: [], // Se llenarán después
          detectedAt: Date.now(),
          source: 'response',
        });

        getLogger().debug({
          sessionId: this.context.sessionId,
          url,
          contentType,
          status,
        }, 'HLS candidate detected from response');
      }

      // Recopilar headers importantes para reproducción
      this.collectHeaders(response.request().headers());
      
    } catch (error) {
      getLogger().error({ 
        error, 
        sessionId: this.context.sessionId,
        url: response.url() 
      }, 'Error handling response in HLS detector');
    }
  }

  /**
   * Maneja requests HTTP para detectar patrones HLS
   */
  private handleRequest(request: HTTPRequest): void {
    try {
      const url = request.url();
      const headers = request.headers();

      // Detectar requests a archivos .m3u8
      if (this.isHLSCandidate(url)) {
        this.addCandidate({
          url,
          contentType: headers['content-type'],
          headers: this.extractRelevantHeaders(headers),
          cookies: [], // Se llenarán después
          detectedAt: Date.now(),
          source: 'request',
        });

        getLogger().debug({
          sessionId: this.context.sessionId,
          url,
          method: request.method(),
        }, 'HLS candidate detected from request');
      }

      // Recopilar headers importantes
      this.collectHeaders(headers);
      
    } catch (error) {
      getLogger().error({ 
        error, 
        sessionId: this.context.sessionId 
      }, 'Error handling request in HLS detector');
    }
  }

  /**
   * Maneja requests finalizados para obtener información completa
   */
  private handleRequestFinished(request: HTTPRequest): void {
    try {
      const response = request.response();
      if (!response) return;

      const url = request.url();
      
      // Si ya tenemos este candidato, actualizamos con información del response
      if (this.candidates.has(url)) {
        const candidate = this.candidates.get(url)!;
        const responseHeaders = response.headers();
        
        // Actualizar content-type si no lo teníamos
        if (!candidate.contentType && responseHeaders['content-type']) {
          candidate.contentType = responseHeaders['content-type'];
        }

        // Merge headers
        candidate.headers = {
          ...candidate.headers,
          ...this.extractRelevantHeaders(responseHeaders),
        };

        this.candidates.set(url, candidate);
      }
      
    } catch (error) {
      getLogger().error({ 
        error, 
        sessionId: this.context.sessionId 
      }, 'Error handling finished request in HLS detector');
    }
  }

  /**
   * Configura detección en frames (iframes)
   */
  private setupFrameDetection(frame: Frame): void {
    try {
      // Configurar listeners para el frame
      frame.on('response', (response) => {
        this.handleResponse(response as HTTPResponse);
      });

      frame.on('request', (request) => {
        this.handleRequest(request as HTTPRequest);
      });

      getLogger().debug({
        sessionId: this.context.sessionId,
        frameUrl: frame.url(),
      }, 'Frame detection configured');
      
    } catch (error) {
      getLogger().error({ 
        error, 
        sessionId: this.context.sessionId 
      }, 'Error setting up frame detection');
    }
  }

  /**
   * Recopila cookies de la página actual
   */
  async collectCookies(page: Page): Promise<void> {
    try {
      const cookies = await page.cookies();
      
      this.collectedCookies = cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires ? Math.floor(cookie.expires) : undefined,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
      }));

      // Actualizar candidatos con cookies
      for (const candidate of this.candidates.values()) {
        candidate.cookies = this.collectedCookies;
      }

      getLogger().debug({
        sessionId: this.context.sessionId,
        cookiesCount: this.collectedCookies.length,
      }, 'Cookies collected');
      
    } catch (error) {
      getLogger().error({ 
        error, 
        sessionId: this.context.sessionId 
      }, 'Error collecting cookies');
    }
  }

  /**
   * Verifica si una URL o content-type es candidato HLS
   */
  private isHLSCandidate(url: string, contentType?: string): boolean {
    // Verificar extensión .m3u8
    if (url.includes('.m3u8')) {
      return true;
    }

    // Verificar content-type HLS
    if (contentType) {
      const hlsContentTypes = [
        'application/vnd.apple.mpegurl',
        'application/x-mpegurl',
        'audio/mpegurl',
        'audio/x-mpegurl',
      ];
      
      if (hlsContentTypes.some(type => contentType.includes(type))) {
        return true;
      }
    }

    // Verificar patrones adicionales del contexto
    if (this.context.options?.m3u8Patterns) {
      return this.context.options.m3u8Patterns.some(pattern => {
        try {
          return new RegExp(pattern).test(url);
        } catch {
          return false;
        }
      });
    }

    return false;
  }

  /**
   * Añade un candidato HLS al mapa
   */
  private addCandidate(candidate: Omit<HLSCandidate, 'cookies'> & { cookies: Cookie[] }): void {
    const existing = this.candidates.get(candidate.url);
    
    if (existing) {
      // Merge con candidato existente
      existing.headers = { ...existing.headers, ...candidate.headers };
      existing.contentType = existing.contentType ?? candidate.contentType;
      if (candidate.cookies.length > 0) {
        existing.cookies = candidate.cookies;
      }
    } else {
      this.candidates.set(candidate.url, candidate as HLSCandidate);
    }
  }

  /**
   * Extrae headers relevantes para reproducción
   */
  private extractRelevantHeaders(headers: Record<string, string>): Record<string, string> {
    const relevantHeaders: Record<string, string> = {};
    
    const importantHeaders = [
      'referer',
      'origin',
      'user-agent',
      'authorization',
      'x-forwarded-for',
      'x-real-ip',
      'range',
      'accept',
      'accept-language',
      'accept-encoding',
    ];

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      
      if (importantHeaders.includes(lowerKey)) {
        relevantHeaders[key] = value;
      }
      
      // Incluir headers custom (que empiecen con x-)
      if (lowerKey.startsWith('x-') && !lowerKey.startsWith('x-forwarded')) {
        relevantHeaders[key] = value;
      }
    }

    return relevantHeaders;
  }

  /**
   * Recopila headers importantes para el contexto global
   */
  private collectHeaders(headers: Record<string, string>): void {
    const extracted = this.extractRelevantHeaders(headers);
    this.collectedHeaders = { ...this.collectedHeaders, ...extracted };
  }

  /**
   * Obtiene todos los candidatos detectados
   */
  getCandidates(): HLSCandidate[] {
    return Array.from(this.candidates.values());
  }

  /**
   * Obtiene headers requeridos para reproducción
   */
  getRequiredHeaders(): Record<string, string> {
    return { ...this.collectedHeaders };
  }

  /**
   * Obtiene cookies requeridas para reproducción
   */
  getRequiredCookies(): Cookie[] {
    return [...this.collectedCookies];
  }

  /**
   * Limpia el detector
   */
  cleanup(): void {
    this.candidates.clear();
    this.collectedHeaders = {};
    this.collectedCookies = [];
  }

  /**
   * Obtiene estadísticas de detección
   */
  getStats(): {
    candidatesCount: number;
    headersCount: number;
    cookiesCount: number;
    detectionDuration: number;
  } {
    return {
      candidatesCount: this.candidates.size,
      headersCount: Object.keys(this.collectedHeaders).length,
      cookiesCount: this.collectedCookies.length,
      detectionDuration: Date.now() - this.context.startTime,
    };
  }
}
