import { readFileSync } from 'fs';
import { join } from 'path';

// Load test configuration from file created by globalSetup
const configPath = join(__dirname, 'test-config.json');
let config: { authToken: string; serverUrl: string; port: number };

try {
  const configContent = readFileSync(configPath, 'utf-8');
  config = JSON.parse(configContent);
} catch (error) {
  throw new Error(
    'Failed to load test configuration. Make sure globalSetup has run. ' +
    `Error: ${error}`
  );
}

// Export test configuration for use in tests
export const TEST_AUTH_TOKEN = config.authToken;
export const TEST_SERVER_URL = config.serverUrl;
export const TEST_PORT = config.port;
