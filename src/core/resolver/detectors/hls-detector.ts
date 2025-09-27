import type {
  Page,
  HTTPResponse,
  HTTPRequest,
  Target,
  CDPSession,
  Browser,
} from 'puppeteer';

import type { Protocol } from 'devtools-protocol';

import {
  HLSCandidate,
  DetectionContext,
  Cookie,
} from '../../../types/dto.js';

import { getLogger } from '../../observability/logger.js';
import { BrowserPage } from '../browser.pool.js';

// Forma unificada mínima para responses provenientes de CDP
type CdpResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
};

export class HLSDetector {
  private candidates: Map<string, HLSCandidate> = new Map();
  private context: DetectionContext;

  private collectedHeaders: Record<string, string> = {};
  private collectedCookies: Cookie[] = [];

  // referencias para cleanup
  private browser?: Browser;
  private page?: Page;
  private targetCreatedHandler?: (t: Target) => void;
  private cdpSessions: Set<CDPSession> = new Set();

  constructor(context: DetectionContext) {
    this.context = context;
  }

  /**
   * Configura los listeners de detección en una página.
   * - Page.on('response'|'request'|'requestfinished')
   * - CDP Network por target (principal + nuevos), cubre OOPIF/iframes.
   */
  async setupDetection(browserPage: BrowserPage): Promise<void> {
    this.page = browserPage.getPage();
    this.browser = this.page.browser();

    // Page-level listeners (rápidos y simples)
    const onPageResponse = (response: HTTPResponse) => this.handleResponse(response);
    const onPageRequest = (request: HTTPRequest) => this.handleRequest(request);
    const onPageRequestFinished = (request: HTTPRequest) => this.handleRequestFinished(request);

    this.page.on('response', onPageResponse);
    this.page.on('request', onPageRequest);
    this.page.on('requestfinished', onPageRequestFinished);

    // CDP por target para cubrir OOPIF/iframes
    const setupCDPForTarget = async (target: Target) => {
      try {
        const session: CDPSession = await target.createCDPSession();
        this.cdpSessions.add(session);

        await session.send('Network.enable');

        session.on(
          'Network.responseReceived',
          (evt: Protocol.Network.ResponseReceivedEvent) => {
            const hdrs = this.normalizeHeaders(evt.response.headers || {});
            const url  = evt.response.url || '';
            const type = String(evt.type || '');
            // Traza del recurso (XHR/Fetch/Media suelen ser señales más “limpias” de HLS)
            if (this.isHlsManifest(url, hdrs['content-type'] || '')) {
              try { getLogger().debug({ sessionId: this.context.sessionId, type, url }, 'HLS CDP candidate'); } catch {}
            }
            const cdpRes: CdpResponse = { url, status: evt.response.status, headers: hdrs };
            this.handleResponse(cdpRes);
          },
        );

        getLogger().debug(
          {
            sessionId: this.context.sessionId,
            targetType: target.type(),
            targetUrl: target.url(),
          },
          'CDP Network listener attached',
        );
      } catch (error) {
        getLogger().error(
          { error, sessionId: this.context.sessionId },
          'Failed to attach CDP listener',
        );
      }
    };

    // Target principal
    await setupCDPForTarget(this.page.target());

    // Futuros targets
    this.targetCreatedHandler = async (t: Target) => {
      try {
        // Opcional: filtrar por browserContext si se desea estricta asociación
        await setupCDPForTarget(t);
      } catch (error) {
        try {
          getLogger().error(
            { error, sessionId: this.context.sessionId },
            'Error in targetCreatedHandler'
          );
        } catch {}
      }
    };
    this.browser.on('targetcreated', this.targetCreatedHandler);

    getLogger().debug(
      { sessionId: this.context.sessionId },
      'HLS detection listeners configured (Page + CDP)',
    );
  }

  /**
   * Maneja responses HTTP/CDP y detecta manifiestos HLS.
   */
  private handleResponse(response: HTTPResponse | CdpResponse): void {
    try {
      const isPptr = typeof (response as HTTPResponse).url === 'function';

      const url: string = isPptr
        ? (response as HTTPResponse).url()
        : (response as CdpResponse).url;

      const status: number = isPptr
        ? (response as HTTPResponse).status()
        : (response as CdpResponse).status;

      const headersObj: Record<string, any> = isPptr
        ? (response as HTTPResponse).headers()
        : (response as CdpResponse).headers;

      const headers = this.normalizeHeaders(headersObj || {});
      const contentType = headers['content-type'] || '';
      const isHLS = this.isHlsManifest(url, contentType);

      // Solo log responses HLS o potencialmente importantes
      if (isHLS || url.toLowerCase().includes('m3u8') || url.toLowerCase().includes('hls')) {
        getLogger().info({
          sessionId: this.context.sessionId,
          url,
          status,
          contentType,
          isHLS
        }, 'Potential HLS Response detected');
      }

      if (isHLS && status >= 200 && status < 400) {
        this.addCandidate(url, contentType);
      }
    } catch (error) {
      const safeUrl =
        typeof (response as HTTPResponse).url === 'function'
          ? (response as HTTPResponse).url()
          : (response as CdpResponse).url;
      getLogger().error(
        { error, sessionId: this.context.sessionId, url: safeUrl },
        'Error handling response in HLS detector',
      );
    }
  }

  /**
   * Maneja requests HTTP para detectar candidatos HLS y capturar headers relevantes.
   */
  private handleRequest(request: HTTPRequest): void {
    try {
      const url = request.url();
      const headers = this.normalizeHeaders(request.headers() || {});

      if (this.isHLSCandidate(url)) {
        this.addCandidate(url, headers['content-type'] || '');
        getLogger().debug(
          { sessionId: this.context.sessionId, url, method: request.method() },
          'HLS candidate from request',
        );
      }

      this.collectHeaders(headers);
    } catch (error) {
      getLogger().error(
        { error, sessionId: this.context.sessionId },
        'Error handling request in HLS detector',
      );
    }
  }

  /**
   * En requestfinished, completa metadata del candidato con headers de respuesta.
   */
  private handleRequestFinished(request: HTTPRequest): void {
    try {
      const response = request.response();
      if (!response) return;

      const url = request.url();
      if (!this.candidates.has(url)) return;

      const candidate = this.candidates.get(url)!;
      const responseHeaders = this.normalizeHeaders(response.headers() || {});

      if (!candidate.contentType && responseHeaders['content-type']) {
        candidate.contentType = responseHeaders['content-type'];
      }
      candidate.headers = {
        ...candidate.headers,
        ...this.extractRelevantHeaders(responseHeaders),
      };

      this.candidates.set(url, candidate);
    } catch (error) {
      getLogger().error(
        { error, sessionId: this.context.sessionId },
        'Error handling finished request in HLS detector',
      );
    }
  }

  /**
   * Recopila cookies actuales y las asocia a todos los candidatos.
   */
  async collectCookies(page: Page): Promise<void> {
    try {
      const cookies = await page.cookies();
      this.collectedCookies = cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires ? Math.floor(cookie.expires) : undefined,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
      }));

      for (const candidate of this.candidates.values()) {
        candidate.cookies = this.collectedCookies;
      }

      getLogger().debug(
        { sessionId: this.context.sessionId, cookiesCount: this.collectedCookies.length },
        'Cookies collected',
      );
    } catch (error) {
      getLogger().error(
        { error, sessionId: this.context.sessionId },
        'Error collecting cookies',
      );
    }
  }

  /**
   * Heurística de detección por URL y content-type HLS.
   */
  private isHlsManifest(url: string, contentType: string): boolean {
    const u = (url || '').toLowerCase();
    const ct = (contentType || '').toLowerCase();
    
    // Patrones de URL M3U8 más amplios
    const hlsUrlPatterns = [
      '.m3u8',
      '/hls/',
      '/hls-',
      'manifest.m3u8',
      'playlist.m3u8',
      'index.m3u8',
      'master.m3u8',
      '/engine/hls',
      'orbitcache.com',
      'urlset/index',
      'hls2-c',
    ];
    
    // Verificar patrones de URL
    if (hlsUrlPatterns.some(pattern => u.includes(pattern))) {
      return true;
    }
    
    // Content-Type HLS
    const hlsContentTypes = [
      'application/vnd.apple.mpegurl',
      'application/x-mpegurl',
      'audio/mpegurl',
      'audio/x-mpegurl',
    ];
    
    return hlsContentTypes.some(type => ct.includes(type));
  }

  /**
   * Candidato por URL/CT y patrones opcionales del contexto.
   */
  private isHLSCandidate(url: string, contentType?: string): boolean {
    const u = (url || '').toLowerCase();
    
    // Patrones de URL M3U8 más amplios
    const hlsUrlPatterns = [
      '.m3u8',
      '/hls/',
      '/hls-',
      'manifest.m3u8',
      'playlist.m3u8', 
      'index.m3u8',
      'master.m3u8',
      '/engine/hls',
      'orbitcache.com',
      'urlset/index',
      'hls2-c',
    ];
    
    if (hlsUrlPatterns.some(pattern => u.includes(pattern))) {
      return true;
    }

    if (contentType) {
      const ct = contentType.toLowerCase();
      const hlsContentTypes = [
        'application/vnd.apple.mpegurl',
        'application/x-mpegurl',
        'audio/mpegurl',
        'audio/x-mpegurl',
      ];
      if (hlsContentTypes.some((t) => ct.includes(t))) return true;
    }

    if (this.context.options?.m3u8Patterns) {
      return this.context.options.m3u8Patterns.some((pattern) => {
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
   * Añade un candidato HLS si no existe ya.
   */
  private addCandidate(url: string, contentType: string): void {
    if (this.candidates.has(url)) return;

    const newCandidate: HLSCandidate = {
      url,
      contentType,
      headers: {},
      cookies: [],
      detectedAt: Date.now(),
      source: 'response',
    };

    this.candidates.set(url, newCandidate);

    getLogger().debug(
      { sessionId: this.context.sessionId, url, contentType },
      'HLS candidate detected',
    );
  }

  /**
   * Normaliza headers a un shape plano string:string.
   */
  private normalizeHeaders(h: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h || {})) {
      const key = k.toLowerCase();
      out[key] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return out;
  }

  /**
   * Extrae headers relevantes para reproducción y replicación.
   */
  private extractRelevantHeaders(headers: Record<string, string>): Record<string, string> {
    const relevant: Record<string, string> = {};
    const important = [
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
      const lower = key.toLowerCase();
      if (important.includes(lower)) relevant[key] = value;
      if (lower.startsWith('x-') && !lower.startsWith('x-forwarded')) {
        relevant[key] = value;
      }
    }
    return relevant;
  }

  /**
   * Mezcla headers relevantes a nivel de detector (para requests posteriores).
   */
  private collectHeaders(headers: Record<string, string>): void {
    const extracted = this.extractRelevantHeaders(headers);
    this.collectedHeaders = { ...this.collectedHeaders, ...extracted };
  }

  getCandidates(): HLSCandidate[] {
    return Array.from(this.candidates.values());
  }

  getRequiredHeaders(): Record<string, string> {
    return { ...this.collectedHeaders };
  }

  getRequiredCookies(): Cookie[] {
    return [...this.collectedCookies];
  }

  /**
   * Libera listeners de Page/Browser y sesiones CDP.
   */
  async dispose(): Promise<void> {
    try {
      if (this.page) {
        try {
          this.page.removeAllListeners('response');
          this.page.removeAllListeners('request');
          this.page.removeAllListeners('requestfinished');
        } catch (error) {
          try {
            getLogger().error({ error, sessionId: this.context.sessionId }, 'Error removing page listeners');
          } catch {}
        }
      }
      if (this.browser && this.targetCreatedHandler) {
        try {
          this.browser.off('targetcreated', this.targetCreatedHandler);
        } catch (error) {
          try {
            getLogger().error({ error, sessionId: this.context.sessionId }, 'Error removing browser listener');
          } catch {}
        }
      }
      
      // Mejorar el manejo de errores en el cierre de sesiones CDP
      const detachPromises = Array.from(this.cdpSessions).map(async (s) => {
        try {
          await s.detach();
        } catch (error) {
          try {
            getLogger().debug({ error, sessionId: this.context.sessionId }, 'Error detaching CDP session');
          } catch {}
        }
      });
      
      try {
        await Promise.allSettled(detachPromises);
      } catch (error) {
        try {
          getLogger().error({ error, sessionId: this.context.sessionId }, 'Error in CDP sessions cleanup');
        } catch {}
      }
      
      this.cdpSessions.clear();
    } catch (error) {
      try {
        getLogger().error({ error, sessionId: this.context.sessionId }, 'Error in HLSDetector dispose');
      } catch {}
    } finally {
      this.candidates.clear();
      this.collectedHeaders = {};
      this.collectedCookies = [];
    }
  }
}

export default HLSDetector;