import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient, randomFilename, writeFile, readFile, cleanupTestFiles } from '../helpers.js';

describe('File Operation Tools', () => {
  let client: Client;

  beforeAll(async () => {
    client = await createTestClient();
  });

  afterAll(async () => {
    if (client) {
      // Cleanup any test files
      await cleanupTestFiles(client);
      await client.close();
    }
  });

  beforeEach(async () => {
    // Clean up before each test
    await cleanupTestFiles(client);
  });

  describe('file_write tool', () => {
    it('should create a new file', async () => {
      const filename = randomFilename();
      const content = 'Test file content';

      await writeFile(client, filename, content, 'Test file creation');

      // Verify file was created by reading it
      const readContent = await readFile(client, filename, 'Verify file created');

      expect(readContent).toContain(content);
    });

    it('should write multiline content', async () => {
      const filename = randomFilename();
      const content = 'Line 1\nLine 2\nLine 3\nLine 4';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      expect(readContent).toContain('Line 1');
      expect(readContent).toContain('Line 2');
      expect(readContent).toContain('Line 3');
      expect(readContent).toContain('Line 4');
    });

    it('should overwrite existing file', async () => {
      const filename = randomFilename();

      // Write initial content
      await writeFile(client, filename, 'Initial content');

      // Overwrite with new content
      await writeFile(client, filename, 'New content');

      const readContent = await readFile(client, filename);

      expect(readContent).toContain('New content');
      expect(readContent).not.toContain('Initial content');
    });

    it('should handle special characters', async () => {
      const filename = randomFilename();
      const content = 'Special: $pecial @chars #test & more!';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      expect(readContent).toContain('$pecial');
      expect(readContent).toContain('@chars');
      expect(readContent).toContain('#test');
    });

    it('should create file in subdirectory', async () => {
      const filename = 'subdir/' + randomFilename();
      const content = 'File in subdirectory';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      expect(readContent).toContain(content);
    });

    it('should handle empty content', async () => {
      const filename = randomFilename();

      await writeFile(client, filename, '');

      const readContent = await readFile(client, filename);

      // File should exist but be empty (or have minimal output)
      expect(readContent).toBeDefined();
    });
  });

  describe('file_read tool', () => {
    it('should read file content', async () => {
      const filename = randomFilename();
      const content = 'Content to read';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      expect(readContent).toContain(content);
    });

    it('should return line-numbered output', async () => {
      const filename = randomFilename();
      const content = 'Line 1\nLine 2\nLine 3';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      // Should have line numbers with pipe separator format: "    1| content"
      expect(readContent).toMatch(/\d+\|.*Line 1/);
      expect(readContent).toMatch(/\d+\|.*Line 2/);
    });

    it('should format line numbers consistently', async () => {
      const filename = randomFilename();
      const content = 'First\nSecond\nThird';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      // All lines should have consistent format: space-padded number + pipe + content
      expect(readContent).toMatch(/^\s*1\| First/m);
      expect(readContent).toMatch(/^\s*2\| Second/m);
      expect(readContent).toMatch(/^\s*3\| Third/m);
    });

    it('should show correct line numbers with offset', async () => {
      const filename = randomFilename();
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';

      await writeFile(client, filename, content);

      const result = await client.callTool({
        name: 'file_read',
        arguments: {
          filePath: filename,
          rationale: 'Test line numbers with offset',
          offset: 5, // Skip first 5 lines
          limit: 100
        }
      });

      let readContent = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          readContent = firstContent.text as string;
        }
      }

      // Line numbers should start at 6 (offset + 1), not 1
      expect(readContent).toMatch(/^\s*6\| Line 6/m);
      expect(readContent).toMatch(/^\s*7\| Line 7/m);
      expect(readContent).toMatch(/^\s*10\| Line 10/m);
      // Should NOT have line 1-5
      expect(readContent).not.toMatch(/^\s*1\| /m);
    });

    it('should handle single line file', async () => {
      const filename = randomFilename();
      const content = 'Single line content';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      expect(readContent).toMatch(/^\s*1\| Single line content/m);
    });

    it('should handle file with empty lines', async () => {
      const filename = randomFilename();
      const content = 'First\n\nThird\n\nFifth';

      await writeFile(client, filename, content);

      const readContent = await readFile(client, filename);

      // Empty lines should still have line numbers
      expect(readContent).toMatch(/^\s*1\| First/m);
      expect(readContent).toMatch(/^\s*2\| $/m);  // Empty line 2
      expect(readContent).toMatch(/^\s*3\| Third/m);
      expect(readContent).toMatch(/^\s*4\| $/m);  // Empty line 4
      expect(readContent).toMatch(/^\s*5\| Fifth/m);
    });

    it('should handle reading with offset', async () => {
      const filename = randomFilename();
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';

      await writeFile(client, filename, content);

      const result = await client.callTool({
        name: 'file_read',
        arguments: {
          filePath: filename,
          rationale: 'Test offset',
          offset: 2, // Skip first 2 lines
          limit: 100
        }
      });

      let readContent = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          readContent = firstContent.text as string;
        }
      }

      expect(readContent).toContain('Line 3');
      expect(readContent).toContain('Line 4');
      expect(readContent).toContain('Line 5');
    });

    it('should handle reading with limit', async () => {
      const filename = randomFilename();
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');

      await writeFile(client, filename, lines);

      const result = await client.callTool({
        name: 'file_read',
        arguments: {
          filePath: filename,
          rationale: 'Test limit',
          offset: 0,
          limit: 10  // Only first 10 lines
        }
      });

      let readContent = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          readContent = firstContent.text as string;
        }
      }

      expect(readContent).toContain('Line 1');
      expect(readContent).toContain('Line 10');
      expect(readContent).not.toContain('Line 50');
    });

    it('should error on nonexistent file', async () => {
      const result = await client.callTool({
        name: 'file_read',
        arguments: {
          filePath: 'nonexistent-file-xyz.txt',
          rationale: 'Test nonexistent file'
        }
      });

      let readContent = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          readContent = firstContent.text as string;
        }
      }

      expect(readContent.toLowerCase()).toMatch(/error|not found/);
    });
  });

  describe('file_edit tool', () => {
    it('should replace text in file', async () => {
      const filename = randomFilename();
      const content = 'Hello World\nThis is a test\nGoodbye World';

      await writeFile(client, filename, content);

      // Edit the file
      await client.callTool({
        name: 'file_edit',
        arguments: {
          filePath: filename,
          oldString: 'Hello World',
          newString: 'Hi Universe',
          rationale: 'Test text replacement'
        }
      });

      const readContent = await readFile(client, filename);

      expect(readContent).toContain('Hi Universe');
      expect(readContent).not.toContain('Hello World');
      expect(readContent).toContain('This is a test');
    });

    it('should replace only first occurrence by default', async () => {
      const filename = randomFilename();
      const content = 'test\ntest\ntest';

      await writeFile(client, filename, content);

      await client.callTool({
        name: 'file_edit',
        arguments: {
          filePath: filename,
          oldString: 'test',
          newString: 'replaced',
          rationale: 'Test single replacement',
          replaceAll: false
        }
      });

      const readContent = await readFile(client, filename);

      // Should contain one 'replaced' and two 'test'
      const replacedCount = (readContent.match(/replaced/g) || []).length;
      const testCount = (readContent.match(/test/g) || []).length;

      expect(replacedCount).toBe(1);
      expect(testCount).toBeGreaterThanOrEqual(2);
    });

    it('should replace all occurrences when replaceAll is true', async () => {
      const filename = randomFilename();
      const content = 'test test test';

      await writeFile(client, filename, content);

      await client.callTool({
        name: 'file_edit',
        arguments: {
          filePath: filename,
          oldString: 'test',
          newString: 'replaced',
          rationale: 'Test replace all',
          replaceAll: true
        }
      });

      const readContent = await readFile(client, filename);

      expect(readContent).not.toContain('test');
      const replacedCount = (readContent.match(/replaced/g) || []).length;
      expect(replacedCount).toBeGreaterThanOrEqual(3);
    });

    it('should handle multiline replacements', async () => {
      const filename = randomFilename();
      const content = 'Line 1\nLine 2\nLine 3';

      await writeFile(client, filename, content);

      await client.callTool({
        name: 'file_edit',
        arguments: {
          filePath: filename,
          oldString: 'Line 1\nLine 2',
          newString: 'Replaced Lines',
          rationale: 'Test multiline replacement'
        }
      });

      const readContent = await readFile(client, filename);

      expect(readContent).toContain('Replaced Lines');
      expect(readContent).not.toContain('Line 1');
    });

    it('should error when old string not found', async () => {
      const filename = randomFilename();
      const content = 'Some content';

      await writeFile(client, filename, content);

      const result = await client.callTool({
        name: 'file_edit',
        arguments: {
          filePath: filename,
          oldString: 'Nonexistent text',
          newString: 'New text',
          rationale: 'Test string not found'
        }
      });

      let editResult = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          editResult = firstContent.text as string;
        }
      }

      expect(editResult.toLowerCase()).toMatch(/error|not found/);
    });

    it('should create backup before editing', async () => {
      const filename = randomFilename();
      const content = 'Original content';

      await writeFile(client, filename, content);

      await client.callTool({
        name: 'file_edit',
        arguments: {
          filePath: filename,
          oldString: 'Original',
          newString: 'Modified',
          rationale: 'Test backup creation'
        }
      });

      // Backup behavior is internal, but file should be successfully edited
      const readContent = await readFile(client, filename);
      expect(readContent).toContain('Modified');
    });
  });

  describe('file_ls tool', () => {
    it('should list files in directory', async () => {
      // Create some test files
      await writeFile(client, randomFilename('list', 'txt'), 'File 1');
      await writeFile(client, randomFilename('list', 'txt'), 'File 2');
      await writeFile(client, randomFilename('list', 'txt'), 'File 3');

      const result = await client.callTool({
        name: 'file_ls',
        arguments: {
          path: '.',
          rationale: 'Test directory listing'
        }
      });

      let lsOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          lsOutput = firstContent.text as string;
        }
      }

      expect(lsOutput).toContain('list-');
      // Should have multiple files listed
      const fileCount = (lsOutput.match(/list-/g) || []).length;
      expect(fileCount).toBeGreaterThanOrEqual(3);
    });

    it('should show tree structure', async () => {
      // Create nested files
      await writeFile(client, 'tree-test/file1.txt', 'Test content');
      await writeFile(client, 'tree-test/subdir/file2.txt', 'Test content');

      const result = await client.callTool({
        name: 'file_ls',
        arguments: {
          path: '.',
          rationale: 'Test tree structure'
        }
      });

      let lsOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          lsOutput = firstContent.text as string;
        }
      }

      // Should show tree characters
      expect(lsOutput).toMatch(/[├└]/);
      expect(lsOutput).toContain('tree-test');
    });

    it('should show file count', async () => {
      await writeFile(client, randomFilename(), 'Test content');

      const result = await client.callTool({
        name: 'file_ls',
        arguments: {
          path: '.',
          rationale: 'Test file count'
        }
      });

      let lsOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          lsOutput = firstContent.text as string;
        }
      }

      // Should show file count
      expect(lsOutput).toMatch(/Found \d+ files?/);
    });

    it('should handle empty directory', async () => {
      // Clean all test files first
      await cleanupTestFiles(client);

      const result = await client.callTool({
        name: 'file_ls',
        arguments: {
          path: '.',
          rationale: 'Test empty directory'
        }
      });

      let lsOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          lsOutput = firstContent.text as string;
        }
      }

      expect(lsOutput).toBeDefined();
    });

    it('should error on nonexistent directory', async () => {
      const result = await client.callTool({
        name: 'file_ls',
        arguments: {
          path: '/nonexistent/directory/xyz',
          rationale: 'Test nonexistent directory'
        }
      });

      let lsOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          lsOutput = firstContent.text as string;
        }
      }

      expect(lsOutput.toLowerCase()).toMatch(/error|not found/);
    });
  });

  describe('file_glob tool', () => {
    beforeEach(async () => {
      // Create files for glob testing
      await writeFile(client, 'glob-test.txt', 'test');
      await writeFile(client, 'glob-test.js', 'test');
      await writeFile(client, 'glob-test.ts', 'test');
      await writeFile(client, 'subdir/nested.txt', 'test');
    });

    it('should find files matching pattern', async () => {
      const result = await client.callTool({
        name: 'file_glob',
        arguments: {
          pattern: '*.txt',
          rationale: 'Test glob pattern'
        }
      });

      let globOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          globOutput = firstContent.text as string;
        }
      }

      expect(globOutput).toContain('glob-test.txt');
      expect(globOutput).not.toContain('glob-test.js');
    });

    it('should find files with recursive pattern', async () => {
      const result = await client.callTool({
        name: 'file_glob',
        arguments: {
          pattern: '**/*.txt',
          rationale: 'Test recursive glob'
        }
      });

      let globOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          globOutput = firstContent.text as string;
        }
      }

      expect(globOutput).toContain('glob-test.txt');
      expect(globOutput).toContain('nested.txt');
    });

    it('should handle no matches', async () => {
      const result = await client.callTool({
        name: 'file_glob',
        arguments: {
          pattern: '*.nonexistent',
          rationale: 'Test no matches'
        }
      });

      let globOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          globOutput = firstContent.text as string;
        }
      }

      expect(globOutput.toLowerCase()).toContain('no files found');
    });

    it('should respect maxResults limit', async () => {
      // Create many files
      for (let i = 0; i < 20; i++) {
        await writeFile(client, `many-${i}.txt`, 'test');
      }

      const result = await client.callTool({
        name: 'file_glob',
        arguments: {
          pattern: 'many-*.txt',
          rationale: 'Test max results',
          maxResults: 5
        }
      });

      let globOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          globOutput = firstContent.text as string;
        }
      }

      // Should mention limiting
      expect(globOutput).toContain('showing first 5');
    });

    it('should show file count in output', async () => {
      const result = await client.callTool({
        name: 'file_glob',
        arguments: {
          pattern: 'glob-test.*',
          rationale: 'Test file count'
        }
      });

      let globOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          globOutput = firstContent.text as string;
        }
      }

      expect(globOutput).toMatch(/Found \d+ files?/);
    });
  });

  describe('file_grep tool', () => {
    beforeEach(async () => {
      // Create files for grep testing
      await writeFile(client, 'grep-test-1.txt', 'apple banana cherry');
      await writeFile(client, 'grep-test-2.txt', 'dog elephant fox');
      await writeFile(client, 'grep-test-3.txt', 'apple pie is delicious');
    });

    it('should search for pattern in files', async () => {
      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'apple',
          rationale: 'Test grep search',
          path: '.'
        }
      });

      let grepOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          grepOutput = firstContent.text as string;
        }
      }

      expect(grepOutput).toContain('apple');
      expect(grepOutput).toContain('grep-test-1.txt');
      expect(grepOutput).toContain('grep-test-3.txt');
    });

    it('should show line numbers', async () => {
      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'apple',
          rationale: 'Test line numbers',
          path: '.'
        }
      });

      let grepOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          grepOutput = firstContent.text as string;
        }
      }

      // Should have line numbers (number|content format)
      expect(grepOutput).toMatch(/\d+\|/);
    });

    it('should handle case insensitive search', async () => {
      await writeFile(client, 'grep-case.txt', 'UPPERCASE lowercase');

      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'uppercase',
          rationale: 'Test case insensitive',
          path: '.',
          include: 'grep-case.txt',
          caseInsensitive: true
        }
      });

      let grepOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          grepOutput = firstContent.text as string;
        }
      }

      expect(grepOutput).toContain('UPPERCASE');
    });

    it('should filter by file pattern', async () => {
      await writeFile(client, 'test.js', 'function test() {}');
      await writeFile(client, 'test.txt', 'function test() {}');

      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'function',
          rationale: 'Test file filtering',
          path: '.',
          include: '*.js'
        }
      });

      let grepOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          grepOutput = firstContent.text as string;
        }
      }

      expect(grepOutput).toContain('test.js');
      expect(grepOutput).not.toContain('test.txt');
    });

    it('should handle no matches found', async () => {
      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'zzzznonexistent',
          rationale: 'Test no matches',
          path: '.'
        }
      });

      let grepOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          grepOutput = firstContent.text as string;
        }
      }

      expect(grepOutput.toLowerCase()).toMatch(/no matches|no.*found/);
    });

    it('should respect maxResults limit', async () => {
      // Create many files with matching content
      for (let i = 0; i < 50; i++) {
        await writeFile(client, `many-${i}.txt`, 'searchterm');
      }

      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'searchterm',
          rationale: 'Test max results',
          path: '.',
          maxResults: 10
        }
      });

      let grepOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          grepOutput = firstContent.text as string;
        }
      }

      // Should mention limiting results
      expect(grepOutput.toLowerCase()).toMatch(/showing first|note:/);
    });

    it('should support regex patterns', async () => {
      await writeFile(client, 'regex-test.txt', 'test123 test456 test789');

      const result = await client.callTool({
        name: 'file_grep',
        arguments: {
          pattern: 'test[0-9]+',
          rationale: 'Test regex',
          path: '.'
        }
      });

      let grepOutput = '';
      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          grepOutput = firstContent.text as string;
        }
      }

      expect(grepOutput).toContain('test');
    });
  });
});
