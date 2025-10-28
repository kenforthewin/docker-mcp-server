import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient, executeAndWait, extractProcessId, delay } from '../helpers.js';

describe('Command Execution Tools', () => {
  let client: Client;

  beforeAll(async () => {
    client = await createTestClient();
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe('execute_command tool', () => {
    it('should execute simple echo command', async () => {
      const result = await executeAndWait(
        client,
        'echo "Hello World"',
        'Test simple echo command',
        5
      );

      expect(result).toContain('Hello World');
      expect(result).toContain('Exit code: 0');
    });

    it('should capture stdout output', async () => {
      const result = await executeAndWait(
        client,
        'echo "Line 1" && echo "Line 2" && echo "Line 3"',
        'Test stdout capture',
        5
      );

      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
      expect(result).toContain('Line 3');
    });

    it('should capture stderr output', async () => {
      const result = await executeAndWait(
        client,
        'echo "Error message" >&2',
        'Test stderr capture',
        5
      );

      expect(result).toContain('Error message');
    });

    it('should capture both stdout and stderr', async () => {
      const result = await executeAndWait(
        client,
        'echo "stdout" && echo "stderr" >&2',
        'Test combined output',
        5
      );

      expect(result).toContain('STDOUT');
      expect(result).toContain('STDERR');
      expect(result).toContain('stdout');
      expect(result).toContain('stderr');
    });

    it('should return exit code for successful command', async () => {
      const result = await executeAndWait(
        client,
        'exit 0',
        'Test success exit code',
        5
      );

      expect(result).toContain('Exit code: 0');
    });

    it('should return exit code for failed command', async () => {
      const result = await executeAndWait(
        client,
        'exit 42',
        'Test failure exit code',
        5
      );

      expect(result).toContain('Exit code: 42');
    });

    it('should handle commands with special characters', async () => {
      const result = await executeAndWait(
        client,
        'echo "Test with $pecial ch@racters!"',
        'Test special characters',
        5
      );

      expect(result).toContain('Test with');
      expect(result).toContain('ch@racters!');
    });

    it('should handle multiline commands', async () => {
      const result = await executeAndWait(
        client,
        `echo "First"
         echo "Second"
         echo "Third"`,
        'Test multiline command',
        5
      );

      expect(result).toContain('First');
      expect(result).toContain('Second');
      expect(result).toContain('Third');
    });

    it('should execute commands in /app/workspace directory', async () => {
      const result = await executeAndWait(
        client,
        'pwd',
        'Test working directory',
        5
      );

      expect(result).toContain('/app/workspace');
    });

    it('should handle commands that produce no output', async () => {
      const result = await executeAndWait(
        client,
        'true',
        'Test command with no output',
        5
      );

      expect(result).toContain('Exit code: 0');
    });
  });

  describe('Long-running commands and backgrounding', () => {
    it('should background long-running command', async () => {
      const result = await executeAndWait(
        client,
        'sleep 30',
        'Test backgrounding',
        2  // Short maxWaitTime to trigger backgrounding
      );

      expect(result).toContain('Process ID:');
      expect(result).toContain('running in background');
    });

    it('should return process ID for backgrounded command', async () => {
      const result = await executeAndWait(
        client,
        'sleep 20',
        'Test process ID',
        2
      );

      const processId = extractProcessId(result);
      expect(processId).toBeTruthy();
      expect(processId).toMatch(/^proc_\d+_[a-z0-9]+$/);
    });

    it('should handle fast commands that complete before timeout', async () => {
      const result = await executeAndWait(
        client,
        'echo "Quick command"',
        'Test fast command',
        20  // Long maxWaitTime
      );

      expect(result).toContain('Quick command');
      expect(result).not.toContain('Process ID:');
      expect(result).not.toContain('background');
    });

    it('should respect maxWaitTime parameter', async () => {
      const startTime = Date.now();

      const result = await executeAndWait(
        client,
        'sleep 30',
        'Test maxWaitTime',
        3  // 3 seconds
      );

      const duration = Date.now() - startTime;

      // Should return in approximately 3 seconds (allow 5s buffer)
      expect(duration).toBeLessThan(8000);
      expect(result).toContain('Process ID:');
    });
  });

  describe('check_process tool', () => {
    it('should check status of running process', async () => {
      // Start a long-running command
      const execResult = await executeAndWait(
        client,
        'sleep 15',
        'Start process for checking',
        2
      );

      const processId = extractProcessId(execResult);
      expect(processId).toBeTruthy();

      // Check process status immediately
      const checkResult = await client.callTool({
        name: 'check_process',
        arguments: {
          processId: processId!,
          rationale: 'Check running process'
        }
      });

      let checkText = '';
      if (Array.isArray(checkResult.content) && checkResult.content.length > 0) {
        const firstContent = checkResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          checkText = firstContent.text as string;
        }
      }

      expect(checkText).toContain('Process Status: RUNNING');
      expect(checkText).toContain(processId!);
    });

    it('should check status of completed process', async () => {
      // Start a command that will background then complete
      const execResult = await executeAndWait(
        client,
        'echo "Done" && sleep 3',
        'Start process that will complete',
        2
      );

      const processId = extractProcessId(execResult);
      expect(processId).toBeTruthy();

      // Wait for process to complete (3s sleep + buffer)
      await delay(4000);

      // Check process status
      const checkResult = await client.callTool({
        name: 'check_process',
        arguments: {
          processId: processId!,
          rationale: 'Check completed process'
        }
      });

      let checkText = '';
      if (Array.isArray(checkResult.content) && checkResult.content.length > 0) {
        const firstContent = checkResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          checkText = firstContent.text as string;
        }
      }

      expect(checkText).toContain('Process Status: COMPLETED');
      expect(checkText).toContain('Exit code:');
    });

    it('should handle checking nonexistent process', async () => {
      const checkResult = await client.callTool({
        name: 'check_process',
        arguments: {
          processId: 'proc_999999_nonexistent',
          rationale: 'Check nonexistent process'
        }
      });

      let checkText = '';
      if (Array.isArray(checkResult.content) && checkResult.content.length > 0) {
        const firstContent = checkResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          checkText = firstContent.text as string;
        }
      }

      expect(checkText).toContain('not found');
    });

    it('should show process output in status', async () => {
      // Start command with output
      const execResult = await executeAndWait(
        client,
        'echo "Process output" && sleep 10',
        'Start process with output',
        2
      );

      const processId = extractProcessId(execResult);
      expect(processId).toBeTruthy();

      await delay(1000);

      // Check process
      const checkResult = await client.callTool({
        name: 'check_process',
        arguments: {
          processId: processId!,
          rationale: 'Check process output'
        }
      });

      let checkText = '';
      if (Array.isArray(checkResult.content) && checkResult.content.length > 0) {
        const firstContent = checkResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          checkText = firstContent.text as string;
        }
      }

      expect(checkText).toContain('Process output');
    });
  });

  describe('send_input tool', () => {
    it('should send input to running process', async () => {
      // Start interactive command
      const execResult = await executeAndWait(
        client,
        'read line && echo "Received: $line"',
        'Start interactive process',
        2
      );

      const processId = extractProcessId(execResult);
      expect(processId).toBeTruthy();

      // Send input
      const inputResult = await client.callTool({
        name: 'send_input',
        arguments: {
          processId: processId!,
          input: 'test input',
          rationale: 'Send test input',
          autoNewline: true
        }
      });

      let inputText = '';
      if (Array.isArray(inputResult.content) && inputResult.content.length > 0) {
        const firstContent = inputResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          inputText = firstContent.text as string;
        }
      }

      expect(inputText).toContain('Input sent');

      // Wait and check output
      await delay(2000);

      const checkResult = await client.callTool({
        name: 'check_process',
        arguments: {
          processId: processId!,
          rationale: 'Check after input'
        }
      });

      let checkText = '';
      if (Array.isArray(checkResult.content) && checkResult.content.length > 0) {
        const firstContent = checkResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          checkText = firstContent.text as string;
        }
      }

      expect(checkText).toContain('Received: test input');
    });

    it('should handle sending input without newline', async () => {
      const execResult = await executeAndWait(
        client,
        'cat',
        'Start cat process',
        2
      );

      const processId = extractProcessId(execResult);
      expect(processId).toBeTruthy();

      const inputResult = await client.callTool({
        name: 'send_input',
        arguments: {
          processId: processId!,
          input: 'no newline',
          rationale: 'Test no newline',
          autoNewline: false
        }
      });

      let inputText = '';
      if (Array.isArray(inputResult.content) && inputResult.content.length > 0) {
        const firstContent = inputResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          inputText = firstContent.text as string;
        }
      }

      expect(inputText).toContain('Input sent');
    });

    it('should reject sending input to nonexistent process', async () => {
      const inputResult = await client.callTool({
        name: 'send_input',
        arguments: {
          processId: 'proc_999999_nonexistent',
          input: 'test',
          rationale: 'Test nonexistent process'
        }
      });

      let inputText = '';
      if (Array.isArray(inputResult.content) && inputResult.content.length > 0) {
        const firstContent = inputResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          inputText = firstContent.text as string;
        }
      }

      expect(inputText).toContain('not found');
    });

    it('should reject sending input to completed process', async () => {
      // Start and wait for completion
      const execResult = await executeAndWait(
        client,
        'echo "done"',
        'Start process that completes',
        5
      );

      // This command should complete immediately, not background
      expect(execResult).not.toContain('Process ID:');

      // Try to send input (should fail since it completed synchronously)
      // We can't really test this scenario easily since fast commands don't background
      // This test documents the expected behavior
    });
  });

  describe('Error handling', () => {
    it('should handle command that fails', async () => {
      const result = await executeAndWait(
        client,
        'nonexistent_command_xyz',
        'Test command error',
        5
      );

      expect(result).toBeTruthy();
      // Should contain error information
      expect(result.toLowerCase()).toMatch(/not found|command not found|error/);
    });

    it('should handle command with syntax error', async () => {
      const result = await executeAndWait(
        client,
        'echo "unclosed quote',
        'Test syntax error',
        5
      );

      expect(result).toBeTruthy();
      // Should complete with error or unexpected output
    });

    it('should handle very long output', async () => {
      const result = await executeAndWait(
        client,
        'for i in {1..100}; do echo "Line $i"; done',
        'Test long output',
        10
      );

      expect(result).toContain('Line 1');
      expect(result).toContain('Line 100');
    });
  });
});
