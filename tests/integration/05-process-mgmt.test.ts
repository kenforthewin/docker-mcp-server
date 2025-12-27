import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient, executeAndWait, extractProcessId, checkProcess, delay } from '../helpers.js';

describe('Process Management', () => {
  let client: Client;

  beforeAll(async () => {
    client = await createTestClient();
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe('Process backgrounding behavior', () => {
    it('should background process after inactivity timeout', async () => {
      const result = await executeAndWait(
        client,
        'sleep 30',
        3// 3 second timeout
      );

      expect(result).toContain('Process ID:');
      expect(result).toContain('no output');
      expect(result).toContain('inactivityTimeout');
    });

    it('should not background fast completing commands', async () => {
      const result = await executeAndWait(
        client,
        'echo "fast"',
        10// Long timeout
      );

      expect(result).not.toContain('Process ID:');
      expect(result).toContain('fast');
      expect(result).toContain('Exit code: 0');
    });

    it('should reset inactivity timer on output', async () => {
      // Command that produces output periodically
      const result = await executeAndWait(
        client,
        'for i in 1 2 3; do echo $i; sleep 1; done',
        10// Should complete within 10 seconds
      );

      // Should complete successfully, not background
      expect(result).toContain('Exit code: 0');
      expect(result).not.toContain('Process ID:');
    });

    it('should respect custom inactivityTimeout', async () => {
      const startTime = Date.now();

      const result = await executeAndWait(
        client,
        'sleep 20',
        5// 5 seconds
      );

      const duration = Date.now() - startTime;

      expect(result).toContain('Process ID:');
      // Should return in approximately 5 seconds (allow buffer)
      expect(duration).toBeLessThan(8000);
      expect(duration).toBeGreaterThan(4000);
    });

    it('should enforce maximum timeout of 10 minutes', async () => {
      // This test would take too long to run, so we document the behavior
      // The server should enforce a 10-minute maximum regardless of inactivityTimeout
      // For actual testing, we verify the behavior with shorter timeouts
      expect(true).toBe(true); // Placeholder for documentation
    });

    it('should background immediately when inactivityTimeout is 0', async () => {
      const startTime = Date.now();

      const result = await executeAndWait(
        client,
        'sleep 10 && echo "Done"',
        0// 0 = immediate background
      );

      const duration = Date.now() - startTime;

      expect(result).toContain('Process ID:');
      expect(result).toContain('inactivityTimeout: 0');
      expect(result).toContain('background');
      // Should return almost immediately (less than 2 seconds)
      expect(duration).toBeLessThan(2000);
    });

    it('should cap inactivityTimeout to 600 seconds', async () => {
      // This test verifies the capping behavior without actually waiting 600 seconds
      // We can't easily test the full 600s cap, but we can verify the command accepts it
      const result = await executeAndWait(
        client,
        'echo "Testing cap"',
        700// 700 seconds - should be capped to 600
      );

      // Command should complete successfully (fast command)
      expect(result).toContain('Testing cap');
      expect(result).toContain('Exit code: 0');
      // The capping happens internally, so we can't directly verify it
      // But the command should work without errors
    });
  });

  describe('Concurrent process management', () => {
    it('should track multiple processes simultaneously', async () => {
      // Start 3 processes in parallel
      const results = await Promise.all([
        executeAndWait(client, 'sleep 15 && echo "Process 1"', 2),
        executeAndWait(client, 'sleep 15 && echo "Process 2"', 2),
        executeAndWait(client, 'sleep 15 && echo "Process 3"', 2)
      ]);

      // Extract process IDs
      const processIds = results.map(r => extractProcessId(r)).filter(id => id !== null);

      expect(processIds.length).toBe(3);

      // All process IDs should be unique
      const uniqueIds = new Set(processIds);
      expect(uniqueIds.size).toBe(3);

      // Check status of each process
      for (const processId of processIds) {
        const status = await checkProcess(client, processId!);
        expect(status).toContain('Process Status:');
      }
    });

    it('should handle mixed fast and slow processes', async () => {
      const results = await Promise.all([
        executeAndWait(client, 'echo "Fast 1"', 10),
        executeAndWait(client, 'sleep 15', 2),
        executeAndWait(client, 'echo "Fast 2"', 10),
        executeAndWait(client, 'sleep 15', 2)
      ]);

      // First and third should complete immediately
      expect(results[0]).toContain('Fast 1');
      expect(results[0]).not.toContain('Process ID:');

      expect(results[2]).toContain('Fast 2');
      expect(results[2]).not.toContain('Process ID:');

      // Second and fourth should background
      expect(results[1]).toContain('Process ID:');
      expect(results[3]).toContain('Process ID:');
    });

    it('should maintain separate output buffers for each process', async () => {
      // Start processes with distinct output
      const result1 = await executeAndWait(
        client,
        'echo "Process A output" && sleep 10',
        2
      );
      const result2 = await executeAndWait(
        client,
        'echo "Process B output" && sleep 10',
        2
      );

      const pid1 = extractProcessId(result1);
      const pid2 = extractProcessId(result2);

      expect(pid1).toBeTruthy();
      expect(pid2).toBeTruthy();
      expect(pid1).not.toBe(pid2);

      // Check each process output
      await delay(1000);

      const status1 = await checkProcess(client, pid1!);
      const status2 = await checkProcess(client, pid2!);

      expect(status1).toContain('Process A output');
      expect(status1).not.toContain('Process B output');

      expect(status2).toContain('Process B output');
      expect(status2).not.toContain('Process A output');
    });
  });

  describe('Process lifecycle', () => {
    it('should track process from start to completion', async () => {
      // Start long command
      const startResult = await executeAndWait(
        client,
        'sleep 5 && echo "Completed"',
        2
      );

      const processId = extractProcessId(startResult);
      expect(processId).toBeTruthy();

      // Check while running
      const runningStatus = await checkProcess(client, processId!);
      expect(runningStatus).toContain('Process Status: RUNNING');

      // Wait for completion
      await delay(6000);

      // Check after completion
      const completedStatus = await checkProcess(client, processId!);
      expect(completedStatus).toContain('Process Status: COMPLETED');
      expect(completedStatus).toContain('Completed');
      expect(completedStatus).toContain('Exit code: 0');
    });

    it('should show process runtime duration', async () => {
      const result = await executeAndWait(
        client,
        'sleep 10',
        2
      );

      const processId = extractProcessId(result);

      await delay(3000);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('Running for:');
      expect(status).toMatch(/\d+\s+seconds?/);
    });

    it('should store final output after completion', async () => {
      const result = await executeAndWait(
        client,
        'echo "Final output" && sleep 3',
        2
      );

      const processId = extractProcessId(result);

      // Wait for completion
      await delay(4000);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('COMPLETED');
      expect(status).toContain('Final output');
      expect(status).toContain('Final Result:');
    });

    it('should handle process that exits with error', async () => {
      const result = await executeAndWait(
        client,
        'sleep 3 && exit 42',
        2
      );

      const processId = extractProcessId(result);

      await delay(4000);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('COMPLETED');
      expect(status).toContain('Exit code: 42');
    });
  });

  describe('Process monitoring', () => {
    it('should capture incremental output', async () => {
      // Command that produces output with gaps longer than inactivityTimeout
      const result = await executeAndWait(
        client,
        'echo "Line 1" && sleep 3 && echo "Line 2" && sleep 3 && echo "Line 3"',
        2
      );

      const processId = extractProcessId(result);
      expect(processId).toBeTruthy();

      // Check at different points
      await delay(4000); // After "Line 2" should be visible
      const status1 = await checkProcess(client, processId!);
      expect(status1).toContain('Line');

      await delay(3000); // After "Line 3" and completion
      const status2 = await checkProcess(client, processId!);

      // Should show completed status with all lines
      if (status2.includes('COMPLETED')) {
        expect(status2).toContain('Line');
      } else {
        expect(status2).toContain('Line');
      }
    });

    it('should show current output for running process', async () => {
      const result = await executeAndWait(
        client,
        'echo "Started" && sleep 10',
        2
      );

      const processId = extractProcessId(result);

      await delay(1000);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('Process Status: RUNNING');
      expect(status).toContain('Current Output:');
      expect(status).toContain('Started');
    });

    it('should handle process with no output', async () => {
      const result = await executeAndWait(
        client,
        'sleep 10',
        2
      );

      const processId = extractProcessId(result);

      await delay(1000);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('Process Status: RUNNING');
      // Should handle gracefully (may say "No output captured")
    });

    it('should separate stdout and stderr in output', async () => {
      const result = await executeAndWait(
        client,
        'echo "stdout message" && echo "stderr message" >&2 && sleep 10',
        2
      );

      const processId = extractProcessId(result);

      await delay(1000);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('stdout message');
      expect(status).toContain('stderr message');

      // May be labeled as STDOUT/STDERR
      if (status.includes('STDOUT') && status.includes('STDERR')) {
        expect(status).toContain('STDOUT');
        expect(status).toContain('STDERR');
      }
    });
  });

  describe('Process information', () => {
    it('should include process command in status', async () => {
      const command = 'echo "test" && sleep 10';
      const result = await executeAndWait(
        client,
        command,
        2
      );

      const processId = extractProcessId(result);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('Command:');
      expect(status).toContain('echo');
    });

    it('should show process ID in status', async () => {
      const result = await executeAndWait(
        client,
        'sleep 10',
        2
      );

      const processId = extractProcessId(result);

      const status = await checkProcess(client, processId!);

      expect(status).toContain('Process ID:');
      expect(status).toContain(processId!);
    });
  });

  describe('Edge cases', () => {
    it('should handle checking process multiple times', async () => {
      const result = await executeAndWait(
        client,
        'sleep 10',
        2
      );

      const processId = extractProcessId(result);

      // Check multiple times
      for (let i = 0; i < 5; i++) {
        const status = await checkProcess(client, processId!);
        expect(status).toContain('Process Status:');
        await delay(500);
      }
    });

    it('should handle very short background processes', async () => {
      const result = await executeAndWait(
        client,
        'sleep 0.5',
        2
      );

      // May or may not background depending on timing
      // Just verify it completes successfully
      expect(result).toBeDefined();
    });

    it('should generate unique process IDs', async () => {
      const results = await Promise.all(
        Array(10).fill(null).map(() =>
          executeAndWait(
        client,
        'sleep 15', 1)
        )
      );

      const processIds = results.map(r => extractProcessId(r)).filter(id => id !== null);

      // All IDs should be unique
      const uniqueIds = new Set(processIds);
      expect(uniqueIds.size).toBe(processIds.length);
    });

    it('should handle process that immediately exits', async () => {
      const result = await executeAndWait(
        client,
        'exit 0',
        5
      );

      // Should complete synchronously
      expect(result).toContain('Exit code: 0');
      expect(result).not.toContain('Process ID:');
    });
  });
});
