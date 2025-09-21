import { StreamVariant, StreamEncryption, ParsedM3U8 } from '../../../types/dto.js';
import { getLogger } from '../../observability/logger.js';

export class M3U8Parser {
  /**
   * Parsea un manifiesto M3U8 y extrae información relevante
   */
  static async parseManifest(content: string, baseUrl: string): Promise<ParsedM3U8> {
    const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
    
    const result: ParsedM3U8 = {
      isLive: true, // Por defecto asumimos live hasta encontrar EXT-X-ENDLIST
      isLowLatency: false,
      variants: [],
      mediaPlaylists: [],
      encryption: undefined,
    };

    let currentVariant: Partial<StreamVariant> = {};
    let isProcessingVariant = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      
      if (!line.startsWith('#')) {
        // Es una URL
        if (isProcessingVariant && currentVariant.uri === undefined) {
          currentVariant.uri = this.resolveUrl(line, baseUrl);
          result.variants.push(currentVariant as StreamVariant);
          currentVariant = {};
          isProcessingVariant = false;
        } else if (line.includes('.m3u8')) {
          // Es una playlist de media
          result.mediaPlaylists.push(this.resolveUrl(line, baseUrl));
        }
        continue;
      }

      // Procesar tags
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        currentVariant = this.parseStreamInf(line);
        isProcessingVariant = true;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        result.isLive = false;
      } else if (line.startsWith('#EXT-X-PART') || line.startsWith('#EXT-X-PRELOAD-HINT')) {
        result.isLowLatency = true;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        result.encryption = this.parseEncryption(line, baseUrl);
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const mediaUrl = this.parseMedia(line);
        if (mediaUrl) {
          result.mediaPlaylists.push(this.resolveUrl(mediaUrl, baseUrl));
        }
      }
    }

    getLogger().debug({
      manifest: {
        isLive: result.isLive,
        isLowLatency: result.isLowLatency,
        variantsCount: result.variants.length,
        mediaPlaylistsCount: result.mediaPlaylists.length,
        hasEncryption: !!result.encryption,
      }
    }, 'Parsed M3U8 manifest');

    return result;
  }

  /**
   * Parsea la línea EXT-X-STREAM-INF
   */
  private static parseStreamInf(line: string): Partial<StreamVariant> {
    const variant: Partial<StreamVariant> = {};
    
    // Extraer atributos
    const attributes = this.parseAttributes(line);
    
    if (attributes['BANDWIDTH']) {
      variant.bandwidth = parseInt(attributes['BANDWIDTH'], 10);
    }
    
    if (attributes['CODECS']) {
      variant.codecs = attributes['CODECS'].replace(/"/g, '');
    }
    
    if (attributes['RESOLUTION']) {
      const resolutionStr = attributes['RESOLUTION'];
      if (resolutionStr) {
        const [width, height] = resolutionStr.split('x').map(Number);
        if (width !== undefined && height !== undefined && !isNaN(width) && !isNaN(height)) {
          variant.resolution = { width, height };
        }
      }
    }
    
    if (attributes['FRAME-RATE']) {
      const frameRateStr = attributes['FRAME-RATE'];
      if(frameRateStr) {
        const frameRate = parseFloat(frameRateStr);
        if (!isNaN(frameRate)) {
          variant.frameRate = frameRate;
        }
      }
    }
    
    return variant;
  }

  /**
   * Parsea la línea EXT-X-KEY para información de encriptación
   */
  private static parseEncryption(line: string, baseUrl: string): StreamEncryption | undefined {
    const attributes = this.parseAttributes(line);
    
    const methodValue = attributes['METHOD'];
    if (!methodValue) {
      return undefined;
    }
    
    const method = methodValue.replace(/"/g, '') as StreamEncryption['method'];
    if (!['AES-128', 'SAMPLE-AES', 'NONE'].includes(method)) {
      return undefined;
    }
    
    const encryption: StreamEncryption = { method };
    
    const uriValue = attributes['URI'];
    if (uriValue && method !== 'NONE') {
      encryption.keyUri = this.resolveUrl(uriValue.replace(/"/g, ''), baseUrl);
    }
    
    return encryption;
  }

  /**
   * Parsea la línea EXT-X-MEDIA para extraer URL de media
   */
  private static parseMedia(line: string): string | undefined {
    const attributes = this.parseAttributes(line);
    
    const uriValue = attributes['URI'];
    if (uriValue) {
      return uriValue.replace(/"/g, '');
    }
    
    return undefined;
  }

  /**
   * Parsea atributos de una línea de tag M3U8
   */
  private static parseAttributes(line: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    
    // Extraer la parte después del ':'
    const attributePart = line.split(':').slice(1).join(':');
    
    // Regex para parsear atributos key=value
    const regex = /([A-Z0-9-]+)=([^,]+)/g;
    let match;
    
    while ((match = regex.exec(attributePart)) !== null) {
      if (match[1] && match[2]) {
        const key = match[1];
        let value = match[2];
        
        // Limpiar comillas si existen
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        
        attributes[key] = value;
      }
    }
    
    return attributes;
  }

  /**
   * Resuelve una URL relativa a absoluta
   */
  private static resolveUrl(url: string, baseUrl: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    try {
      return new URL(url, baseUrl).href;
    } catch (error) {
      getLogger().warn({ url, baseUrl, error }, 'Failed to resolve URL');
      return url;
    }
  }

  /**
   * Valida si el contenido es un manifiesto M3U8 válido
   */
  static isValidM3U8(content: string): boolean {
    const lines = content.split('\n');
    
    // Debe empezar con #EXTM3U
    if (!lines[0]?.trim().startsWith('#EXTM3U')) {
      return false;
    }
    
    // Debe tener al menos un tag EXT-X
    return lines.some(line => line.trim().startsWith('#EXT-X-'));
  }

  /**
   * Determina si es un master playlist o una media playlist
   */
  static isMasterPlaylist(content: string): boolean {
    return content.includes('#EXT-X-STREAM-INF');
  }

  /**
   * Extrae todas las URLs de playlists de un master playlist
   */
  static extractPlaylistUrls(content: string, baseUrl: string): string[] {
    const lines = content.split('\n').map(line => line.trim());
    const urls: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        // La siguiente línea debería ser la URL
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          urls.push(this.resolveUrl(nextLine, baseUrl));
        }
      }
    }
    
    return urls;
  }

  /**
   * Obtiene información básica de un manifiesto sin parsing completo
   */
  static getBasicInfo(content: string): {
    isValid: boolean;
    isMaster: boolean;
    isLive: boolean;
    hasVariants: boolean;
  } {
    const isValid = this.isValidM3U8(content);
    const isMaster = this.isMasterPlaylist(content);
    const isLive = !content.includes('#EXT-X-ENDLIST');
    const hasVariants = content.includes('#EXT-X-STREAM-INF');
    
    return {
      isValid,
      isMaster,
      isLive,
      hasVariants,
    };
  }
}
