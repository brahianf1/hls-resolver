import {
  normalizeUrl,
  resolveUrl,
  isValidUrl,
  extractDomain,
  extractOrigin,
  isDomainAllowed,
  sanitizeUrlForLogging,
  getUrlParams,
  buildUrlWithParams,
  isHLSUrl,
  getBaseUrl,
  normalizeM3U8Url,
} from '../../src/utils/url';

describe('URL Utils', () => {
  describe('normalizeUrl', () => {
    it('should remove fragments', () => {
      const url = 'https://example.com/path#fragment';
      const normalized = normalizeUrl(url);
      expect(normalized).toBe('https://example.com/path');
    });

    it('should keep relevant parameters', () => {
      const url = 'https://example.com/path?token=abc&other=xyz&key=123';
      const normalized = normalizeUrl(url);
      expect(normalized).toContain('token=abc');
      expect(normalized).toContain('key=123');
      expect(normalized).not.toContain('other=xyz');
    });

    it('should handle malformed URLs gracefully', () => {
      const malformed = 'not-a-url';
      const result = normalizeUrl(malformed);
      expect(result).toBe(malformed);
    });
  });

  describe('resolveUrl', () => {
    it('should resolve relative URLs', () => {
      const base = 'https://example.com/path/';
      const relative = 'file.m3u8';
      const resolved = resolveUrl(relative, base);
      expect(resolved).toBe('https://example.com/path/file.m3u8');
    });

    it('should return absolute URLs unchanged', () => {
      const absolute = 'https://cdn.example.com/file.m3u8';
      const base = 'https://example.com/';
      const resolved = resolveUrl(absolute, base);
      expect(resolved).toBe(absolute);
    });

    it('should handle protocol-relative URLs', () => {
      const relative = '//example.com/path';
      const base = 'https://another.com';
      const result = resolveUrl(relative, base);
      expect(result).toBe('https://example.com/path');
    });

    /*
    it('should handle malformed URLs gracefully', () => {
      const malformed = 'not-a-url';
      const base = 'https://example.com/';
      const result = resolveUrl(malformed, base);
      expect(result).toBe(malformed);
    });
    */
  });

  describe('isValidUrl', () => {
    it('should validate HTTP URLs', () => {
      expect(isValidUrl('http://example.com')).toBe(true);
      expect(isValidUrl('https://example.com')).toBe(true);
    });

    it('should reject non-HTTP URLs', () => {
      expect(isValidUrl('ftp://example.com')).toBe(false);
      expect(isValidUrl('file:///path/to/file')).toBe(false);
    });

    it('should reject malformed URLs', () => {
      expect(isValidUrl('not-a-url')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });
  });

  describe('extractDomain', () => {
    it('should extract domain from URL', () => {
      expect(extractDomain('https://example.com/path')).toBe('example.com');
      expect(extractDomain('https://sub.example.com:8080/path')).toBe('sub.example.com');
    });

    it('should handle malformed URLs gracefully', () => {
      expect(extractDomain('not-a-url')).toBe('');
    });
  });

  describe('extractOrigin', () => {
    it('should extract origin from URL', () => {
      expect(extractOrigin('https://example.com/path')).toBe('https://example.com');
      expect(extractOrigin('https://example.com:8080/path')).toBe('https://example.com:8080');
    });

    it('should handle malformed URLs gracefully', () => {
      expect(extractOrigin('not-a-url')).toBe('');
    });
  });

  describe('isDomainAllowed', () => {
    it('should allow all domains when allowlist is empty', () => {
      expect(isDomainAllowed('https://example.com', [])).toBe(true);
    });

    it('should allow exact domain matches', () => {
      const allowed = ['example.com', 'test.com'];
      expect(isDomainAllowed('https://example.com/path', allowed)).toBe(true);
      expect(isDomainAllowed('https://test.com/path', allowed)).toBe(true);
      expect(isDomainAllowed('https://other.com/path', allowed)).toBe(false);
    });

    it('should handle wildcard domains', () => {
      const allowed = ['*.example.com'];
      expect(isDomainAllowed('https://sub.example.com/path', allowed)).toBe(true);
      expect(isDomainAllowed('https://example.com/path', allowed)).toBe(true);
      expect(isDomainAllowed('https://other.com/path', allowed)).toBe(false);
    });

    it('should handle malformed URLs gracefully', () => {
      expect(isDomainAllowed('not-a-url', ['example.com'])).toBe(false);
    });
  });

  describe('sanitizeUrlForLogging', () => {
    it('should mask sensitive parameters', () => {
      const url = 'https://example.com/path?token=secret123&other=public';
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain('token=***MASKED***');
      expect(sanitized).toContain('other=public');
    });

    it('should handle URLs without sensitive parameters', () => {
      const url = 'https://example.com/path?param=value';
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toBe(url);
    });

    it('should handle malformed URLs gracefully', () => {
      const malformed = 'not-a-url';
      const result = sanitizeUrlForLogging(malformed);
      expect(result).toBe(malformed);
    });
  });

  describe('getUrlParams', () => {
    it('should extract URL parameters', () => {
      const url = 'https://example.com/path?param1=value1&param2=value2';
      const params = getUrlParams(url);
      expect(params).toEqual({
        param1: 'value1',
        param2: 'value2',
      });
    });

    it('should handle URLs without parameters', () => {
      const url = 'https://example.com/path';
      const params = getUrlParams(url);
      expect(params).toEqual({});
    });

    it('should handle malformed URLs gracefully', () => {
      const malformed = 'not-a-url';
      const result = getUrlParams(malformed);
      expect(result).toEqual({});
    });
  });

  describe('buildUrlWithParams', () => {
    it('should add parameters to URL', () => {
      const baseUrl = 'https://example.com/path';
      const params = { param1: 'value1', param2: 'value2' };
      const result = buildUrlWithParams(baseUrl, params);
      expect(result).toContain('param1=value1');
      expect(result).toContain('param2=value2');
    });

    it('should replace existing parameters', () => {
      const baseUrl = 'https://example.com/path?existing=old';
      const params = { existing: 'new', added: 'value' };
      const result = buildUrlWithParams(baseUrl, params);
      expect(result).toContain('existing=new');
      expect(result).toContain('added=value');
    });

    it('should handle malformed URLs gracefully', () => {
      const malformed = 'not-a-url';
      const params = { param: 'value' };
      const result = buildUrlWithParams(malformed, params);
      expect(result).toBe(malformed);
    });
  });

  describe('isHLSUrl', () => {
    it('should identify HLS URLs', () => {
      expect(isHLSUrl('https://example.com/playlist.m3u8')).toBe(true);
      expect(isHLSUrl('https://example.com/path/file.m3u8?token=abc')).toBe(true);
    });

    it('should reject non-HLS URLs', () => {
      expect(isHLSUrl('https://example.com/video.mp4')).toBe(false);
      expect(isHLSUrl('https://example.com/path')).toBe(false);
    });

    it('should handle malformed URLs', () => {
      expect(isHLSUrl('not-a-url.m3u8')).toBe(true); // Still contains .m3u8
      expect(isHLSUrl('not-a-url')).toBe(false);
    });
  });

  describe('getBaseUrl', () => {
    it('should extract base URL', () => {
      const url = 'https://example.com/path/to/file.m3u8';
      const base = getBaseUrl(url);
      expect(base).toBe('https://example.com/path/to/');
    });

    it('should handle root URLs', () => {
      const url = 'https://example.com/file.m3u8';
      const base = getBaseUrl(url);
      expect(base).toBe('https://example.com/');
    });

    it('should handle malformed URLs gracefully', () => {
      const malformed = 'not-a-url';
      const result = getBaseUrl(malformed);
      expect(result).toBe(malformed);
    });
  });
});

describe('normalizeM3U8Url', () => {
  // Caso de prueba 1: URL HTTPS válida
  test('debería devolver un objeto URL para una URL HTTPS válida', () => {
    const url = 'https://example.com/master.m3u8';
    const result = normalizeM3U8Url(url);
    expect(result).toBeInstanceOf(URL);
    expect(result?.href).toBe(url);
  });

  // Caso de prueba 2: URL HTTP válida
  test('debería devolver un objeto URL para una URL HTTP válida', () => {
    const url = 'http://example.com/live/stream.m3u8';
    const result = normalizeM3U8Url(url);
    expect(result).toBeInstanceOf(URL);
    expect(result?.href).toBe(url);
  });

  // Caso de prueba 3: URL con protocolo no válido (ftp)
  test('debería devolver null para un protocolo no válido como FTP', () => {
    const url = 'ftp://example.com/data.m3u8';
    expect(normalizeM3U8Url(url)).toBeNull();
  });

  // Caso de prueba 4: URL inválida (mal formada)
  test('debería devolver null para una URL mal formada', () => {
    const url = 'esto no es una url';
    expect(normalizeM3U8Url(url)).toBeNull();
  });

  // Caso de prueba 5: URL con caracteres de control (salto de línea)
  test('debería devolver null si la URL contiene caracteres de control', () => {
    const url = 'https://example.com/\nmaster.m3u8';
    expect(normalizeM3U8Url(url)).toBeNull();
  });

  // Casos de prueba basados en los logs del usuario
  describe('Casos de prueba de regresión del usuario', () => {
    test('debería validar la URL master de kravaxxa', () => {
      const url = 'https://kravaxxa.com/stream/r8nJ8DtPclNU9bO8prOJJg/kjhhiuahiuhgihdf/1758484629/56837250/master.m3u8';
      const result = normalizeM3U8Url(url);
      expect(result).toBeInstanceOf(URL);
      expect(result?.href).toBe(url);
    });

    test('debería validar la URL index-f1 de kravaxxa', () => {
      const url = 'https://kravaxxa.com/stream/r8nJ8DtPclNU9bO8prOJJg/kjhhiuahiuhgihdf/1758484629/56837250/index-f1-v1-a1.m3u8';
      const result = normalizeM3U8Url(url);
      expect(result).toBeInstanceOf(URL);
      expect(result?.href).toBe(url);
    });

    test('debería validar la URL index-f3 de kravaxxa', () => {
      const url = 'https://kravaxxa.com/stream/r8nJ8DtPclNU9bO8prOJJg/kjhhiuahiuhgihdf/1758484629/56837250/index-f3-v1-a1.m3u8';
      const result = normalizeM3U8Url(url);
      expect(result).toBeInstanceOf(URL);
      expect(result?.href).toBe(url);
    });
  });
});
