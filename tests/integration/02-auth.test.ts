import { describe, it, expect } from '@jest/globals';
import { TEST_SERVER_URL, TEST_AUTH_TOKEN } from '../setup.js';

describe('Authentication', () => {
  const validRequest = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    },
    id: 1
  };

  describe('Bearer Token Authentication', () => {
    it('should reject requests without Authorization header', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
          // No Authorization header
        },
        body: JSON.stringify(validRequest)
      });

      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error).toContain('Unauthorized');
    });

    it('should reject requests with invalid token', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-token-12345'
        },
        body: JSON.stringify(validRequest)
      });

      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error).toContain('Unauthorized');
    });

    it('should reject requests with malformed Authorization header', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'InvalidFormat token-value'
        },
        body: JSON.stringify(validRequest)
      });

      expect(response.status).toBe(401);
    });

    it('should reject requests with token but no Bearer prefix', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': TEST_AUTH_TOKEN // Missing "Bearer " prefix
        },
        body: JSON.stringify(validRequest)
      });

      expect(response.status).toBe(401);
    });

    it('should accept requests with valid bearer token', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(validRequest)
      });

      // Should not be unauthorized
      expect(response.status).not.toBe(401);

      // Should be a successful response (200) or method-specific error (4xx that's not 401)
      expect(response.status).toBeGreaterThanOrEqual(200);
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers in response', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(validRequest)
      });

      expect(response.headers.get('access-control-allow-origin')).toBeDefined();
      expect(response.headers.get('access-control-allow-methods')).toBeDefined();
      expect(response.headers.get('access-control-allow-headers')).toBeDefined();
    });

    it('should handle OPTIONS preflight requests', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:30000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type,Authorization'
        }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeDefined();
      expect(response.headers.get('access-control-allow-methods')).toBeDefined();
    });
  });

  describe('Security Headers', () => {
    it('should not expose sensitive information in error responses', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-token'
        },
        body: JSON.stringify(validRequest)
      });

      const data = await response.json();

      // Should not reveal the correct token
      expect(JSON.stringify(data)).not.toContain(TEST_AUTH_TOKEN);

      // Should not expose internal paths or stack traces
      expect(JSON.stringify(data).toLowerCase()).not.toContain('/users/');
      expect(JSON.stringify(data).toLowerCase()).not.toContain('stack trace');
    });

    it('should return JSON error responses', async () => {
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
          // Missing auth
        },
        body: JSON.stringify(validRequest)
      });

      expect(response.headers.get('content-type')).toContain('application/json');

      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe('Token Validation', () => {
    it('should validate token format', async () => {
      const invalidTokens = [
        '',                    // Empty string
        'Bearer',             // Just "Bearer" with no token
        'Bearer ',            // "Bearer " with no token
        'invalid',            // No Bearer prefix
        'Basic token',        // Wrong auth scheme
      ];

      for (const invalidToken of invalidTokens) {
        const response = await fetch(TEST_SERVER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': invalidToken
          },
          body: JSON.stringify(validRequest)
        });

        expect(response.status).toBe(401);
      }
    });

    it('should consistently validate token across multiple requests', async () => {
      // Make multiple requests with valid token
      const requests = Array(5).fill(null).map(() =>
        fetch(TEST_SERVER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
          },
          body: JSON.stringify(validRequest)
        })
      );

      const responses = await Promise.all(requests);

      // All should succeed authentication
      for (const response of responses) {
        expect(response.status).not.toBe(401);
      }
    });
  });
});
