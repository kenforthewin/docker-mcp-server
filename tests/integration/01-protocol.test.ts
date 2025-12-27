import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from '../helpers.js';

describe('MCP Protocol Conformance', () => {
  let client: Client;

  beforeAll(async () => {
    client = await createTestClient();
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe('Initialization', () => {
    it('should successfully initialize connection', async () => {
      // Client is already initialized in beforeAll
      expect(client).toBeDefined();
    });

    it('should return server information', async () => {
      const serverInfo = client.getServerVersion();

      expect(serverInfo).toBeDefined();
      expect(serverInfo?.name).toBe('docker-mcp-server');
      expect(serverInfo?.version).toBe('1.0.0');
    });

    it('should have valid server capabilities', async () => {
      // Verify client is connected and has server info
      const serverInfo = client.getServerVersion();
      expect(serverInfo).toBeDefined();
    });
  });

  describe('Tool Discovery', () => {
    it('should list all available tools', async () => {
      const result = await client.listTools();

      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('should include all expected tools', async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map(t => t.name);

      const expectedTools = [
        'execute_command',
        'check_process',
        'send_input',
        'file_read',
        'file_write',
        'file_edit',
        'file_ls',
        'file_grep'
      ];

      for (const expectedTool of expectedTools) {
        expect(toolNames).toContain(expectedTool);
      }
    });

    it('should provide tool descriptions', async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
      }
    });

    it('should provide tool input schemas', async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.inputSchema).toBe('object');
      }
    });

    it('should have correct schema for execute_command tool', async () => {
      const result = await client.listTools();
      const executeTool = result.tools.find(t => t.name === 'execute_command');

      expect(executeTool).toBeDefined();
      expect(executeTool?.name).toBe('execute_command');
      expect(executeTool?.description).toContain('Execute');
      expect(executeTool?.inputSchema).toBeDefined();
    });

    it('should have correct schema for file_read tool', async () => {
      const result = await client.listTools();
      const readTool = result.tools.find(t => t.name === 'file_read');

      expect(readTool).toBeDefined();
      expect(readTool?.name).toBe('file_read');
      expect(readTool?.description).toContain('Read');
      expect(readTool?.inputSchema).toBeDefined();
    });
  });

  describe('Tool Invocation Protocol', () => {
    it('should return properly formatted response', async () => {
      const result = await client.callTool({
        name: 'execute_command',
        arguments: {
          command: 'echo "test"'
        }
      });

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      if (Array.isArray(result.content)) {
        expect(result.content.length).toBeGreaterThan(0);
      }
    });

    it('should return text content in correct format', async () => {
      const result = await client.callTool({
        name: 'execute_command',
        arguments: {
          command: 'echo "hello"'
        }
      });

      expect(Array.isArray(result.content)).toBe(true);
      if (Array.isArray(result.content) && result.content.length > 0) {
        const content = result.content[0];
        expect(content).toBeDefined();
        expect(content.type).toBe('text');
        expect('text' in content).toBe(true);

        if ('text' in content) {
          expect(typeof content.text).toBe('string');
          expect(content.text).toContain('hello');
        }
      }
    });

    it('should handle tool errors gracefully', async () => {
      await expect(
        client.callTool({
          name: 'nonexistent_tool',
          arguments: {}
        })
      ).rejects.toThrow();
    });

    it('should validate required parameters', async () => {
      await expect(
        client.callTool({
          name: 'execute_command',
          arguments: {
            // Missing required 'command' parameter
          } as any
        })
      ).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid tool name', async () => {
      await expect(
        client.callTool({
          name: 'invalid_tool_name',
          arguments: {}
        })
      ).rejects.toThrow();
    });

    it('should handle missing required arguments', async () => {
      await expect(
        client.callTool({
          name: 'file_read',
          arguments: {
            // Missing required 'filePath'
          } as any
        })
      ).rejects.toThrow();
    });

    it('should handle invalid argument types', async () => {
      await expect(
        client.callTool({
          name: 'execute_command',
          arguments: {
            command: 123 // Should be string
          } as any
        })
      ).rejects.toThrow();
    });
  });
});
