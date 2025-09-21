import { M3U8Parser } from '../../src/core/resolver/parsers/m3u8.parser';

describe('M3U8Parser', () => {
  describe('isValidM3U8', () => {
    it('should validate valid M3U8 content', () => {
      const validContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment1.ts
#EXT-X-ENDLIST`;
      
      expect(M3U8Parser.isValidM3U8(validContent)).toBe(true);
    });

    it('should reject invalid M3U8 content', () => {
      const invalidContent = `This is not a valid M3U8 file`;
      
      expect(M3U8Parser.isValidM3U8(invalidContent)).toBe(false);
    });

    it('should reject content without EXTM3U header', () => {
      const invalidContent = `#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10`;
      
      expect(M3U8Parser.isValidM3U8(invalidContent)).toBe(false);
    });
  });

  describe('isMasterPlaylist', () => {
    it('should identify master playlists', () => {
      const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720
medium.m3u8`;
      
      expect(M3U8Parser.isMasterPlaylist(masterContent)).toBe(true);
    });

    it('should identify media playlists', () => {
      const mediaContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment1.ts
#EXTINF:10.0,
segment2.ts`;
      
      expect(M3U8Parser.isMasterPlaylist(mediaContent)).toBe(false);
    });
  });

  describe('parseManifest', () => {
    it('should parse master playlist correctly', async () => {
      const masterContent = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480,CODECS="avc1.42e01e,mp4a.40.2",FRAME-RATE=30.000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=30.000
medium.m3u8
#EXT-X-ENDLIST`;
      
      const result = await M3U8Parser.parseManifest(masterContent, 'https://example.com/');
      
      expect(result.isLive).toBe(false); // Has EXT-X-ENDLIST
      expect(result.variants).toHaveLength(2);
      expect(result.variants[0]).toEqual({
        uri: 'https://example.com/low.m3u8',
        bandwidth: 1280000,
        resolution: { width: 854, height: 480 },
        codecs: 'avc1.42e01e,mp4a.40.2',
        frameRate: 30,
      });
      expect(result.variants[1]).toEqual({
        uri: 'https://example.com/medium.m3u8',
        bandwidth: 2560000,
        resolution: { width: 1280, height: 720 },
        codecs: 'avc1.64001f,mp4a.40.2',
        frameRate: 30,
      });
    });

    it('should parse live stream correctly', async () => {
      const liveContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:10.0,
segment100.ts
#EXTINF:10.0,
segment101.ts`;
      
      const result = await M3U8Parser.parseManifest(liveContent, 'https://example.com/');
      
      expect(result.isLive).toBe(true); // No EXT-X-ENDLIST
      expect(result.variants).toHaveLength(0);
    });

    it('should parse low latency stream correctly', async () => {
      const llContent = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:6
#EXT-X-PART-INF:PART-TARGET=1.0
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:6.0,
#EXT-X-PART:DURATION=1.0,URI="segment100_part0.m4s"
#EXT-X-PART:DURATION=1.0,URI="segment100_part1.m4s"
segment100.ts`;
      
      const result = await M3U8Parser.parseManifest(llContent, 'https://example.com/');
      
      expect(result.isLive).toBe(true);
      expect(result.isLowLatency).toBe(true); // Has EXT-X-PART
    });

    it('should parse encryption information', async () => {
      const encryptedContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin",IV=0x12345678901234567890123456789012
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment1.ts
#EXT-X-ENDLIST`;
      
      const result = await M3U8Parser.parseManifest(encryptedContent, 'https://example.com/');
      
      expect(result.encryption).toEqual({
        method: 'AES-128',
        keyUri: 'https://example.com/key.bin',
      });
    });
  });

  describe('extractPlaylistUrls', () => {
    it('should extract all playlist URLs from master playlist', () => {
      const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000
medium.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5120000
high.m3u8`;
      
      const urls = M3U8Parser.extractPlaylistUrls(masterContent, 'https://example.com/');
      
      expect(urls).toHaveLength(3);
      expect(urls).toContain('https://example.com/low.m3u8');
      expect(urls).toContain('https://example.com/medium.m3u8');
      expect(urls).toContain('https://example.com/high.m3u8');
    });

    it('should handle absolute URLs', () => {
      const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000
https://cdn.example.com/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000
https://cdn.example.com/medium.m3u8`;
      
      const urls = M3U8Parser.extractPlaylistUrls(masterContent, 'https://example.com/');
      
      expect(urls).toHaveLength(2);
      expect(urls).toContain('https://cdn.example.com/low.m3u8');
      expect(urls).toContain('https://cdn.example.com/medium.m3u8');
    });
  });

  describe('getBasicInfo', () => {
    it('should return correct basic info for master playlist', () => {
      const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000
low.m3u8
#EXT-X-ENDLIST`;
      
      const info = M3U8Parser.getBasicInfo(masterContent);
      
      expect(info).toEqual({
        isValid: true,
        isMaster: true,
        isLive: false,
        hasVariants: true,
      });
    });

    it('should return correct basic info for media playlist', () => {
      const mediaContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment1.ts`;
      
      const info = M3U8Parser.getBasicInfo(mediaContent);
      
      expect(info).toEqual({
        isValid: true,
        isMaster: false,
        isLive: true,
        hasVariants: false,
      });
    });

    it('should return correct basic info for invalid content', () => {
      const invalidContent = `This is not M3U8`;
      
      const info = M3U8Parser.getBasicInfo(invalidContent);
      
      expect(info).toEqual({
        isValid: false,
        isMaster: false,
        isLive: false,
        hasVariants: false,
      });
    });
  });
});
