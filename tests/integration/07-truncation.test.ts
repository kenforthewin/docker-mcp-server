import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient, randomFilename, writeFile, readFile, cleanupTestFiles } from '../helpers.js';

describe('Line Truncation', () => {
  let client: Client;

  beforeAll(async () => {
    client = await createTestClient();
  });

  afterAll(async () => {
    if (client) {
      await cleanupTestFiles(client);
      await client.close();
    }
  });

  beforeEach(async () => {
    await cleanupTestFiles(client);
  });

  describe('file_read truncation', () => {
    it('should truncate lines longer than 2000 characters', async () => {
      const filename = randomFilename();
      // Create a line with 3000 'a' characters
      const longLine = 'a'.repeat(3000);
      const content = `short line\n${longLine}\nanother short line`;

      await writeFile(client, filename, content);
      const result = await readFile(client, filename);

      // The long line should be truncated to 2000 chars
      // Since cat -n adds line numbers, we check that we don't see 3000 a's
      const lines = result.split('\n');
      const longLineResult = lines.find(l => l.includes('aaa'));

      expect(longLineResult).toBeDefined();
      // Count the 'a' characters - should be at most 2000
      const aCount = (longLineResult!.match(/a/g) || []).length;
      expect(aCount).toBeLessThanOrEqual(2000);
      expect(aCount).toBeGreaterThan(1000); // Should still have substantial content
    });

    it('should not truncate lines under 2000 characters', async () => {
      const filename = randomFilename();
      const normalLine = 'x'.repeat(500);
      const content = normalLine;

      await writeFile(client, filename, content);
      const result = await readFile(client, filename);

      // All 500 x's should be present
      const xCount = (result.match(/x/g) || []).length;
      expect(xCount).toBe(500);
    });
  });

  describe('file_grep truncation', () => {
    it('should truncate matched lines longer than 2000 characters', async () => {
      const filename = randomFilename();
      // Create a line with 3000 characters that contains a searchable pattern
      const longLine = 'FINDME' + 'b'.repeat(2994);
      const content = `short line\n${longLine}\nanother line`;

      await writeFile(client, filename, content);

      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'FINDME',
          path: '.'
        }
      });

      const text = (result.content as Array<{text: string}>)[0].text;

      // The matched line should be truncated
      // Count b's - should be less than 2994
      const bCount = (text.match(/b/g) || []).length;
      expect(bCount).toBeLessThan(2994);
      expect(text).toContain('FINDME');
    });

    it('should not truncate grep results under 200 characters', async () => {
      const filename = randomFilename();
      // grep truncates at 200 chars, so use a line that fits within that limit
      // SEARCHTERM (10 chars) + 100 z's = 110 chars total, well under 200
      // Using 'z' to avoid matching random chars in filename
      const normalLine = 'SEARCHTERM' + 'z'.repeat(100);
      const content = normalLine;

      await writeFile(client, filename, content);

      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'SEARCHTERM',
          path: '.'
        }
      });

      const text = (result.content as Array<{text: string}>)[0].text;

      // All 100 z's should be present (line is under 200 char limit)
      const zCount = (text.match(/z/g) || []).length;
      expect(zCount).toBe(100);
    });
  });
});
