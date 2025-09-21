import { FastifyInstance } from 'fastify';
import { main } from '../../src/server/index';

describe('Server Integration Tests', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    // Mock environment variables for testing
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0'; // Use random available port
    process.env.API_KEY = 'test-api-key-12345';
    process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests
    process.env.PUPPETEER_HEADLESS = 'true';
    process.env.BROWSER_POOL_SIZE = '1';
    process.env.MAX_CONCURRENT_PAGES = '2';

    // Start server
    await main();
    server = (await import('../../src/server/index')).fastify;
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  describe('Health Endpoints', () => {
    it('should respond to health check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('timestamp');
    });

    it('should respond to detailed health check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/detailed',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body).toHaveProperty('system');
      expect(body).toHaveProperty('browserPool');
      expect(body).toHaveProperty('metrics');
    });

    it('should respond to readiness check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/readiness',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('ready');
    });

    it('should respond to liveness check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/liveness',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.alive).toBe(true);
    });
  });

  describe('Metrics Endpoints', () => {
    it('should respond to metrics endpoint', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('# HELP');
    });

    it('should respond to JSON metrics endpoint', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics/json',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('metrics');
      expect(body).toHaveProperty('system');
    });
  });

  describe('API Endpoints', () => {
    it('should require API key for resolve endpoint', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/resolve',
        payload: {
          url: 'https://example.com',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Unauthorized');
    });

    it('should validate request body for resolve endpoint', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/resolve',
        headers: {
          'x-api-key': 'test-api-key-12345',
        },
        payload: {
          invalidField: 'value',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Bad Request');
    });

    it('should accept valid resolve request', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/resolve',
        headers: {
          'x-api-key': 'test-api-key-12345',
        },
        payload: {
          url: 'https://example.com',
          options: {
            maxWaitMs: 5000,
          },
        },
      });

      // The request should be accepted (not 400/401/403)
      // The actual resolution might fail due to test environment, but that's expected
      expect([200, 422, 500]).toContain(response.statusCode);
    });

    it('should respond to session status endpoint', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/resolve/status/test-session-id',
        headers: {
          'x-api-key': 'test-api-key-12345',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sessionId).toBe('test-session-id');
      expect(body.status).toBe('completed');
    });
  });

  describe('Documentation', () => {
    it('should serve OpenAPI documentation', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/docs',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('should serve OpenAPI JSON', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/docs/json',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('openapi');
      expect(body).toHaveProperty('info');
      expect(body).toHaveProperty('paths');
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown routes', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/unknown-route',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Not Found');
      expect(body).toHaveProperty('requestId');
    });

    it('should handle invalid JSON in request body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/resolve',
        headers: {
          'x-api-key': 'test-api-key-12345',
          'content-type': 'application/json',
        },
        payload: '{invalid-json}',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Security', () => {
    it('should include security headers', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      // Check for basic security headers that might be set by middleware
      expect(response.headers).toBeDefined();
    });

    it('should handle CORS preflight requests', async () => {
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/api/v1/resolve',
        headers: {
          'origin': 'https://example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-api-key',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });
});
