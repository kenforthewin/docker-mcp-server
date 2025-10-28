import { execSync } from 'child_process';
import { unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Global teardown - runs once after all tests
 */
export default async function globalTeardown() {
  console.log('\n' + '='.repeat(70));
  console.log('Test Suite Complete - Global Cleanup');
  console.log('='.repeat(70));

  console.log('\n1. Stopping MCP server container...');
  try {
    execSync('docker-compose down', { stdio: 'inherit' });
    console.log('✓ Container stopped and removed');
  } catch (error) {
    console.error('Warning: Failed to stop container:', error);
  }

  console.log('\n2. Cleaning up test workspace...');
  try {
    execSync('rm -rf tmp/*', { stdio: 'ignore' });
    console.log('✓ Test workspace cleaned');
  } catch (error) {
    // Ignore cleanup errors
  }

  console.log('\n3. Removing test configuration files...');
  try {
    const configPath = join(__dirname, 'test-config.json');
    unlinkSync(configPath);
    console.log('✓ Test configuration removed');
  } catch (error) {
    // Ignore if file doesn't exist
  }

  console.log('\n4. Removing MCP servers config from repository root...');
  try {
    execSync('rm -f mcp-servers.json', { stdio: 'ignore' });
    console.log('✓ MCP servers config removed');
  } catch (error) {
    // Ignore cleanup errors
  }

  console.log('\n' + '='.repeat(70));
  console.log('Global Cleanup Complete');
  console.log('='.repeat(70) + '\n');
}
