import type { Page, HTTPResponse, HTTPRequest } from 'puppeteer';
import { getLogger } from '../../observability/logger.js';

/**
 * Candidato HLS capturado de forma agresiva
 */
export interface AggressiveHLSCandidate {
  url: string;
  type: 'request' | 'response';
  method?: string;
  resourceType?: string;
  status?: number;
  timestampRequest?: number;
  timestampResponse?: number;
  contentType?: string;
}

/**
 * Resultado de la detección agresiva
 */
export interface AggressiveDetectionResult {
  allM3u8Urls: string[];
  masterPlaylist: string | null;
  indexPlaylists: string[];
  otherM3u8: string[];
  segmentsSample: string[];
  totalSegments: number;
  total: number;
  success: boolean;
  message: string;
}

/**
 * Detector HLS Agresivo basado en el código exitoso de n8n.
 * 
 * Diferencias con HLSDetector estándar:
 * 1. Captura TODOS los requests y responses sin filtros prematuros
 * 2. Clasifica después de la captura, no durante
 * 3. No depende de CDP (más simple y directo)
 * 4. Retorna formato estructurado similar a n8n para comparación
 */
export class AggressiveHLSDetector {
  private captured: AggressiveHLSCandidate[] = [];
  private sessionId: string;
  private page?: Page;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Configura los listeners de captura en la página.
   * Debe llamarse ANTES de navegar.
   */
  async setup(page: Page): Promise<void> {
    this.page = page;
    this.captured = [];

    // Listener de requests - captura TODO
    page.on('request', (request: HTTPRequest) => {
      try {
        const url = request.url();
        
        this.captured.push({
          url: url,
          type: 'request',
          method: request.method(),
          resourceType: request.resourceType(),
          timestampRequest: Date.now(),
        });

        // Log inmediato de requests HLS
        if (this.isHLSRelated(url)) {
          getLogger().info(
            {
              sessionId: this.sessionId,
              url,
              method: request.method(),
              resourceType: request.resourceType(),
            },
            '⭐ HLS-related request captured',
          );
        } else {
          // DEBUG: Log de todos los requests para análisis
          getLogger().debug(
            {
              sessionId: this.sessionId,
              url,
              method: request.method(),
              resourceType: request.resourceType(),
            },
            '🔍 Request captured (not HLS)',
          );
        }
      } catch (error) {
        getLogger().debug(
          { sessionId: this.sessionId, error },
          'Error capturing request',
        );
      }
    });

    // Listener de responses - captura TODO con status y contentType
    page.on('response', async (response: HTTPResponse) => {
      try {
        const url = response.url();
        const status = response.status();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';

        // Capturar response si es HLS o potencialmente interesante
        if (this.isHLSRelated(url)) {
          this.captured.push({
            url: url,
            type: 'response',
            status: status,
            contentType: contentType,
            timestampResponse: Date.now(),
          });

          getLogger().info(
            {
              sessionId: this.sessionId,
              url,
              status,
              contentType,
            },
            '⭐ HLS-related response captured',
          );
        } else {
          // DEBUG: Log de responses importantes (XHR, Fetch, Media)
          const resourceType = response.request().resourceType();
          if (['xhr', 'fetch', 'media', 'document'].includes(resourceType)) {
            getLogger().debug(
              {
                sessionId: this.sessionId,
                url,
                status,
                contentType,
                resourceType,
              },
              '🔍 Response captured (not HLS but important type)',
            );
          }
        }
      } catch (error) {
        getLogger().debug(
          { sessionId: this.sessionId, error },
          'Error capturing response',
        );
      }
    });

    getLogger().debug(
      { sessionId: this.sessionId },
      'Aggressive HLS detector setup completed',
    );
  }

  /**
   * Verifica si una URL está relacionada con HLS
   */
  private isHLSRelated(url: string): boolean {
    const u = url.toLowerCase();
    
    // Patrones de M3U8
    if (u.includes('.m3u8')) {
      return true;
    }
    
    // Patrones de segmentos HLS
    if (u.includes('.ts')) {
      // Solo si está en contexto de streaming
      if (
        u.includes('hls') ||
        u.includes('stream') ||
        u.includes('segment') ||
        u.includes('chunk') ||
        u.includes('video') ||
        u.includes('seg-') ||
        u.includes('/hls2/')
      ) {
        return true;
      }
    }
    
    // Otros patrones HLS
    if (
      u.includes('/hls/') ||
      u.includes('/hls-') ||
      u.includes('manifest') ||
      u.includes('playlist')
    ) {
      return true;
    }
    
    return false;
  }

  /**
   * Procesa las capturas y genera resultado estructurado.
   * Similar al formato de salida de n8n para facilitar comparación.
   */
  getResults(): AggressiveDetectionResult {
    // DEBUG: Log todas las URLs capturadas para análisis
    getLogger().debug(
      {
        sessionId: this.sessionId,
        totalCaptured: this.captured.length,
        sampleUrls: this.captured.slice(0, 10).map(c => ({
          url: c.url.substring(0, 100),
          type: c.type,
          resourceType: c.resourceType,
        })),
      },
      '📊 All captured URLs (first 10)',
    );

    // Extraer URLs únicas
    const allUrls = this.captured
      .map((c) => c.url)
      .filter((u) => u);

    // DEBUG: Buscar patrones específicos
    const hasM3u8 = allUrls.filter((u) => u.toLowerCase().includes('.m3u8'));
    const hasTs = allUrls.filter((u) => u.toLowerCase().includes('.ts'));
    const hasHls = allUrls.filter((u) => u.toLowerCase().includes('hls'));
    const hasStream = allUrls.filter((u) => u.toLowerCase().includes('stream'));
    
    getLogger().debug(
      {
        sessionId: this.sessionId,
        hasM3u8: hasM3u8.length,
        hasTs: hasTs.length,
        hasHls: hasHls.length,
        hasStream: hasStream.length,
        sampleM3u8: hasM3u8.slice(0, 3),
        sampleTs: hasTs.slice(0, 3),
      },
      '🔍 Pattern analysis in captured URLs',
    );

    // Clasificar M3U8s
    const m3u8Urls = [...new Set(allUrls.filter((u) => u.includes('.m3u8')))];

    // Clasificar segmentos .ts
    const tsUrls = [
      ...new Set(
        allUrls.filter(
          (u) =>
            u.includes('.ts') &&
            (u.includes('hls') ||
              u.includes('stream') ||
              u.includes('segment') ||
              u.includes('chunk') ||
              u.includes('video') ||
              u.includes('seg-')),
        ),
      ),
    ];

    // Identificar master playlist
    const masterPlaylist =
      m3u8Urls.find((u) => u.includes('master.m3u8')) || null;

    // Identificar index playlists
    const indexPlaylists = m3u8Urls.filter(
      (u) => u.includes('index') && u.includes('.m3u8'),
    );

    // Otros M3U8 (no master ni index)
    const otherM3u8 = m3u8Urls.filter(
      (u) => !u.includes('master.m3u8') && !u.includes('index'),
    );

    const total = m3u8Urls.length + tsUrls.length;
    const success = m3u8Urls.length > 0;

    const result: AggressiveDetectionResult = {
      success,
      total,
      masterPlaylist,
      indexPlaylists,
      otherM3u8,
      segmentsSample: tsUrls.slice(0, 3),
      totalSegments: tsUrls.length,
      allM3u8Urls: m3u8Urls,
      message: success
        ? `Encontrados ${m3u8Urls.length} archivos .m3u8 y ${tsUrls.length} segmentos`
        : 'No se encontraron archivos HLS',
    };

    getLogger().info(
      {
        sessionId: this.sessionId,
        result: {
          success: result.success,
          m3u8Count: m3u8Urls.length,
          segmentsCount: tsUrls.length,
          masterPlaylist: result.masterPlaylist,
        },
      },
      'Aggressive HLS detection results',
    );

    return result;
  }

  /**
   * Obtiene el número de candidatos capturados
   */
  getCandidatesCount(): number {
    return this.captured.length;
  }

  /**
   * Obtiene todas las capturas (para debugging)
   */
  getAllCaptures(): AggressiveHLSCandidate[] {
    return [...this.captured];
  }

  /**
   * Limpia las capturas
   */
  clear(): void {
    this.captured = [];
  }

  /**
   * Libera recursos
   */
  async dispose(): Promise<void> {
    try {
      if (this.page) {
        this.page.removeAllListeners('request');
        this.page.removeAllListeners('response');
      }
      this.captured = [];
    } catch (error) {
      getLogger().error(
        { sessionId: this.sessionId, error },
        'Error disposing aggressive HLS detector',
      );
    }
  }
}

