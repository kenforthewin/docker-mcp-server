import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

const TEST_PORT = 3000;
const MAX_STARTUP_WAIT = 60000; // 60 seconds
const TEST_SERVER_URL = `http://localhost:${TEST_PORT}`;

/**
 * Wait for the MCP server to be ready by polling the health endpoint
 */
async function waitForServer(authToken: string, timeout: number = MAX_STARTUP_WAIT): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 1000; // Check every second

  while (Date.now() - startTime < timeout) {
    try {
      // Try to connect to the server with a simple request
      const response = await fetch(TEST_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'ping',
          id: 1
        })
      });

      // If we get any response (even an error), the server is running
      if (response.status === 200 || response.status === 404 || response.status === 400) {
        console.log('✓ MCP server is ready');
        return;
      }
    } catch (error) {
      // Server not ready yet, continue polling
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`MCP server failed to start within ${timeout}ms`);
}

/**
 * Global setup - runs once before all tests
 */
export default async function globalSetup() {
  console.log('='.repeat(70));
  console.log('MCP Integration Test Suite - Global Setup');
  console.log('='.repeat(70));
  console.log(`Test Server URL: ${TEST_SERVER_URL}`);
  console.log('='.repeat(70));

  console.log('\n1. Checking if Docker is running...');
  try {
    execSync('docker info', { stdio: 'ignore' });
    console.log('✓ Docker is running');
  } catch (error) {
    throw new Error('Docker is not running. Please start Docker and try again.');
  }

  console.log('\n2. Stopping any existing containers...');
  try {
    execSync('docker-compose down', { stdio: 'ignore' });
    console.log('✓ Existing containers stopped');
  } catch (error) {
    // Ignore if no containers exist
    console.log('✓ No existing containers to stop');
  }

  console.log('\n3. Copying test MCP server config for build...');
  try {
    execSync('cp tests/test-mcp-servers.json mcp-servers.json', { stdio: 'inherit' });
    console.log('✓ Test config copied to repository root');
  } catch (error) {
    console.error('Warning: Failed to copy test config, tests may not have child servers');
  }

  console.log('\n4. Building Docker container with test configuration...');
  try {
    execSync('docker-compose build', { stdio: 'inherit' });
    console.log('✓ Container built successfully');
  } catch (error) {
    throw new Error('Failed to build Docker container');
  }

  console.log('\n5. Starting MCP server container...');
  try {
    execSync('docker-compose up -d', {
      stdio: 'inherit'
    });
    console.log('✓ Container started');
  } catch (error) {
    throw new Error('Failed to start Docker container');
  }

  console.log('\n6. Extracting auth token from container logs...');
  let authToken = '';
  try {
    // Wait a moment for server to start and log the token
    await new Promise(resolve => setTimeout(resolve, 3000));

    const logs = execSync('docker-compose logs mcp-container', { encoding: 'utf-8' });
    const tokenMatch = logs.match(/Auth Token: ([a-z0-9-]+)/);

    if (tokenMatch) {
      authToken = tokenMatch[1];
      console.log(`✓ Found auth token: ${authToken}`);
    } else {
      throw new Error('Could not extract auth token from logs');
    }
  } catch (error) {
    console.error('Failed to extract auth token');
    console.error('Container logs:');
    try {
      execSync('docker-compose logs', { stdio: 'inherit' });
    } catch {
      // Ignore if logs fail
    }
    throw error;
  }

  console.log('\n7. Waiting for MCP server to be ready...');
  try {
    await waitForServer(authToken);
    console.log('✓ MCP server is ready for tests');
  } catch (error) {
    console.error('Failed to connect to MCP server');
    console.error('Attempting to show container logs:');
    try {
      execSync('docker-compose logs', { stdio: 'inherit' });
    } catch {
      // Ignore if logs fail
    }
    throw error;
  }

  // Write auth token and server URL to a file that tests can read
  const testConfig = {
    authToken,
    serverUrl: TEST_SERVER_URL,
    port: TEST_PORT
  };

  const configPath = join(__dirname, 'test-config.json');
  writeFileSync(configPath, JSON.stringify(testConfig, null, 2));
  console.log(`✓ Test configuration written to ${configPath}`);

  console.log('\n' + '='.repeat(70));
  console.log('Global Setup Complete - Starting Tests');
  console.log('='.repeat(70) + '\n');
}
