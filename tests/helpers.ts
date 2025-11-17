import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TEST_SERVER_URL, TEST_AUTH_TOKEN } from './setup.js';

/**
 * Create an authenticated MCP client for testing
 */
export async function createTestClient(): Promise<Client> {
  const client = new Client({
    name: 'test-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(TEST_SERVER_URL),
    {
      requestInit: {
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      }
    }
  );

  await client.connect(transport);
  return client;
}

/**
 * Generate a random filename for testing
 */
export function randomFilename(prefix: string = 'test', extension: string = 'txt'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `${prefix}-${timestamp}-${random}.${extension}`;
}

/**
 * Execute a command and wait for it to complete
 * Returns the result content
 */
export async function executeAndWait(
  client: Client,
  command: string,
  rationale: string,
  inactivityTimeout: number = 10
): Promise<string> {
  const result = await client.callTool({
    name: 'execute_command',
    arguments: {
      command,
      rationale,
      inactivityTimeout
    }
  });

  if (Array.isArray(result.content) && result.content.length > 0) {
    const firstContent = result.content[0];
    if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
      return firstContent.text as string;
    }
  }

  throw new Error('Unexpected result format from execute_command');
}

/**
 * Read a file and return its contents
 */
export async function readFile(
  client: Client,
  filePath: string,
  rationale: string = 'Test file read'
): Promise<string> {
  const result = await client.callTool({
    name: 'file_read',
    arguments: {
      filePath,
      rationale
    }
  });

  if (Array.isArray(result.content) && result.content.length > 0) {
    const firstContent = result.content[0];
    if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
      return firstContent.text as string;
    }
  }

  throw new Error('Unexpected result format from file_read');
}

/**
 * Write a file with the given content
 */
export async function writeFile(
  client: Client,
  filePath: string,
  content: string,
  rationale: string = 'Test file write'
): Promise<void> {
  await client.callTool({
    name: 'file_write',
    arguments: {
      filePath,
      content,
      rationale
    }
  });
}

/**
 * Check if a process is still running
 */
export async function checkProcess(
  client: Client,
  processId: string,
  rationale: string = 'Check process status'
): Promise<string> {
  const result = await client.callTool({
    name: 'check_process',
    arguments: {
      processId,
      rationale
    }
  });

  if (Array.isArray(result.content) && result.content.length > 0) {
    const firstContent = result.content[0];
    if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
      return firstContent.text as string;
    }
  }

  throw new Error('Unexpected result format from check_process');
}

/**
 * Extract process ID from command output
 */
export function extractProcessId(output: string): string | null {
  const match = output.match(/Process ID: (proc_\d+_[a-z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Wait for a specific condition with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number = 10000,
  interval: number = 500
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Clean up test files in the workspace
 */
export async function cleanupTestFiles(client: Client, pattern: string = 'test-*'): Promise<void> {
  try {
    await executeAndWait(
      client,
      `rm -f ${pattern}`,
      'Cleanup test files',
      5
    );
  } catch (error) {
    // Ignore cleanup errors
    console.warn('Warning: Failed to cleanup test files:', error);
  }
}

/**
 * Assert that a string contains a substring
 */
export function assertContains(haystack: string, needle: string, message?: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      message || `Expected string to contain "${needle}"\nGot: ${haystack}`
    );
  }
}

/**
 * Assert that a string does not contain a substring
 */
export function assertNotContains(haystack: string, needle: string, message?: string): void {
  if (haystack.includes(needle)) {
    throw new Error(
      message || `Expected string not to contain "${needle}"\nGot: ${haystack}`
    );
  }
}

/**
 * Delay for a specified number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
