import axios from 'axios';
import { getLogger } from '../../observability/logger.js';

/**
 * Patrones conocidos de scripts anti-devtool
 */
const ANTI_DEVTOOL_PATTERNS = [
  'disable-devtool',
  'console-ban',
  'devtools-detector',
  'anti-devtools',
  'devtool-detect',
  'devtools-detect',
];

/**
 * Resultado de la detección
 */
export interface AntiDevtoolDetectionResult {
  hasAntiDevtool: boolean;
  confidence: 'high' | 'medium' | 'low';
  detectedPatterns: string[];
  method: 'html-analysis' | 'known-domain' | 'none';
}

/**
 * Detector inteligente de sitios con protección anti-devtool.
 * 
 * Estrategias:
 * 1. Lista de dominios conocidos (rápido, alta confianza)
 * 2. Análisis del HTML inicial (medio, media confianza)
 * 3. Heurística de comportamiento (lento, baja confianza)
 */
export class AntiDevtoolDetector {
  /**
   * Detecta si una URL requiere protección anti-devtool.
   * Usa múltiples estrategias para máxima precisión.
   * 
   * @param url - URL a analizar
   * @param knownDomains - Lista de dominios conocidos
   * @param enableAutoDetect - Habilitar detección automática por análisis HTML
   */
  static async detect(
    url: string,
    knownDomains: string[] = [],
    enableAutoDetect: boolean = true,
  ): Promise<AntiDevtoolDetectionResult> {
    // Estrategia 1: Verificar contra lista de dominios conocidos (más rápido)
    const domainResult = this.checkKnownDomain(url, knownDomains);
    if (domainResult.hasAntiDevtool) {
      return domainResult;
    }

    // Estrategia 2: Análisis del HTML inicial (solo si está habilitado)
    if (enableAutoDetect) {
      const htmlResult = await this.analyzeHTML(url);
      if (htmlResult.hasAntiDevtool) {
        return htmlResult;
      }
    }

    // No se detectó anti-devtool
    return {
      hasAntiDevtool: false,
      confidence: 'high',
      detectedPatterns: [],
      method: 'none',
    };
  }

  /**
   * Verifica si el dominio está en la lista de dominios conocidos
   */
  private static checkKnownDomain(
    url: string,
    knownDomains: string[],
  ): AntiDevtoolDetectionResult {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      const matchedDomain = knownDomains.find((domain) =>
        hostname.includes(domain.toLowerCase()),
      );

      if (matchedDomain) {
        return {
          hasAntiDevtool: true,
          confidence: 'high',
          detectedPatterns: [matchedDomain],
          method: 'known-domain',
        };
      }
    } catch (error) {
      // URL inválida
    }

    return {
      hasAntiDevtool: false,
      confidence: 'high',
      detectedPatterns: [],
      method: 'none',
    };
  }

  /**
   * Analiza el HTML inicial para detectar scripts anti-devtool.
   * Hace un request GET ligero y busca patrones en el HTML.
   */
  private static async analyzeHTML(
    url: string,
  ): Promise<AntiDevtoolDetectionResult> {
    try {
      // Request rápido con timeout corto
      const response = await axios.get(url, {
        timeout: 5000,
        maxRedirects: 5,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
        validateStatus: (status) => status >= 200 && status < 500,
      });

      const html = response.data.toLowerCase();
      const detectedPatterns: string[] = [];

      // Buscar patrones de anti-devtool en el HTML
      for (const pattern of ANTI_DEVTOOL_PATTERNS) {
        if (html.includes(pattern)) {
          detectedPatterns.push(pattern);
        }
      }

      if (detectedPatterns.length > 0) {
        getLogger().info(
          {
            url,
            detectedPatterns,
          },
          '🔍 Anti-devtool protection detected via HTML analysis',
        );

        return {
          hasAntiDevtool: true,
          confidence: detectedPatterns.length > 1 ? 'high' : 'medium',
          detectedPatterns,
          method: 'html-analysis',
        };
      }
    } catch (error) {
      // Si falla el análisis, asumir que no tiene (fail-safe)
      getLogger().debug(
        {
          url,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to analyze HTML for anti-devtool detection',
      );
    }

    return {
      hasAntiDevtool: false,
      confidence: 'medium',
      detectedPatterns: [],
      method: 'none',
    };
  }

  /**
   * Verifica si la detección tiene suficiente confianza
   */
  static isConfidentDetection(result: AntiDevtoolDetectionResult): boolean {
    return result.hasAntiDevtool && 
           (result.confidence === 'high' || result.confidence === 'medium');
  }
}

