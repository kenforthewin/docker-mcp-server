import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTestClient } from '../helpers.js';

describe('MCP Server Aggregation', () => {
  let client: Client;

  beforeAll(async () => {
    client = await createTestClient();
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe('Child Server Integration', () => {
    it('should load child servers from config', async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map(t => t.name);

      // Should have tools from memory server (namespaced)
      const memoryTools = toolNames.filter(name => name.startsWith('memory:'));
      expect(memoryTools.length).toBeGreaterThan(0);
    });

    it('should namespace child server tools correctly', async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map(t => t.name);

      // All memory server tools should start with "memory:"
      const memoryTools = toolNames.filter(name => name.startsWith('memory:'));

      for (const toolName of memoryTools) {
        expect(toolName).toMatch(/^memory:[a-z_]+$/);
      }
    });

    it('should preserve native tools alongside child server tools', async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map(t => t.name);

      // Native tools should still be available
      expect(toolNames).toContain('execute_command');
      expect(toolNames).toContain('file_read');
      expect(toolNames).toContain('file_write');
      expect(toolNames).toContain('check_process');

      // Child server tools should also be available
      const memoryTools = toolNames.filter(name => name.startsWith('memory:'));
      expect(memoryTools.length).toBeGreaterThan(0);
    });

    it('should include child server name in tool descriptions', async () => {
      const result = await client.listTools();
      const memoryTools = result.tools.filter(t => t.name.startsWith('memory:'));

      for (const tool of memoryTools) {
        expect(tool.description).toContain('[memory]');
      }
    });
  });

  describe('Tool Routing', () => {
    it('should successfully call child server tools', async () => {
      // Create entities in the knowledge graph
      const createResult = await client.callTool({
        name: 'memory:create_entities',
        arguments: {
          entities: [
            {
              name: 'test-entity',
              entityType: 'concept',
              observations: ['Test observation']
            }
          ]
        }
      });

      expect(createResult).toBeDefined();
      expect(Array.isArray(createResult.content)).toBe(true);

      if (Array.isArray(createResult.content)) {
        expect(createResult.content.length).toBeGreaterThan(0);

        // Verify the content indicates success
        const firstContent = createResult.content[0];
        expect(firstContent).toBeDefined();
        expect(firstContent.type).toBe('text');

        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          expect(firstContent.text).toBeTruthy();
        }
      }
    });

    it('should handle tool calls with multiple operations', async () => {
      // First create some entities
      await client.callTool({
        name: 'memory:create_entities',
        arguments: {
          entities: [
            { name: 'entity1', entityType: 'concept', observations: ['First entity'] },
            { name: 'entity2', entityType: 'concept', observations: ['Second entity'] }
          ]
        }
      });

      // Then create a relation between them
      const relationResult = await client.callTool({
        name: 'memory:create_relations',
        arguments: {
          relations: [
            {
              from: 'entity1',
              to: 'entity2',
              relationType: 'related_to'
            }
          ]
        }
      });

      expect(relationResult).toBeDefined();
      expect(Array.isArray(relationResult.content)).toBe(true);
    });

    it('should work with search operations', async () => {
      // Search for entities
      const searchResult = await client.callTool({
        name: 'memory:search_nodes',
        arguments: {
          query: 'test'
        }
      });

      expect(searchResult).toBeDefined();
      expect(Array.isArray(searchResult.content)).toBe(true);
    });

    it('should handle errors from child servers gracefully', async () => {
      // Try to create a relation with non-existent entities
      const result = await client.callTool({
        name: 'memory:create_relations',
        arguments: {
          relations: [
            {
              from: 'non-existent-entity-1',
              to: 'non-existent-entity-2',
              relationType: 'invalid'
            }
          ]
        }
      });

      // Should return a result (not throw), even if it indicates an error
      expect(result).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
    });
  });

  describe('Native Tools with Aggregation', () => {
    it('should still execute native command execution tools', async () => {
      const result = await client.callTool({
        name: 'execute_command',
        arguments: {
          command: 'echo "Aggregation test"',
          rationale: 'Test native tool with aggregation enabled'
        }
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);

      if (Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          expect(firstContent.text).toContain('Aggregation test');
        }
      }
    });

    it('should still execute native file operations', async () => {
      // Write a file using native tool
      await client.callTool({
        name: 'file_write',
        arguments: {
          filePath: 'test-aggregation.txt',
          content: 'Testing aggregation',
          rationale: 'Test native file tool'
        }
      });

      // Read it back
      const readResult = await client.callTool({
        name: 'file_read',
        arguments: {
          filePath: 'test-aggregation.txt',
          rationale: 'Verify file write'
        }
      });

      expect(Array.isArray(readResult.content)).toBe(true);
      if (Array.isArray(readResult.content) && readResult.content.length > 0) {
        const firstContent = readResult.content[0];
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          expect(firstContent.text).toContain('Testing aggregation');
        }
      }
    });

    it('should handle concurrent calls to native and child tools', async () => {
      // Make multiple calls in parallel
      const results = await Promise.all([
        client.callTool({
          name: 'execute_command',
          arguments: {
            command: 'echo "native"',
            rationale: 'Concurrent test 1'
          }
        }),
        client.callTool({
          name: 'memory:search_nodes',
          arguments: {
            query: 'test'
          }
        }),
        client.callTool({
          name: 'file_read',
          arguments: {
            filePath: 'test-aggregation.txt',
            rationale: 'Concurrent test 2'
          }
        })
      ]);

      // All should succeed
      expect(results.length).toBe(3);
      for (const result of results) {
        expect(result).toBeDefined();
        expect(Array.isArray(result.content)).toBe(true);
      }
    });
  });

  describe('Tool Discovery', () => {
    it('should list all tools including native and aggregated', async () => {
      const result = await client.listTools();

      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);

      // Should have native tools (8) + memory tools (9+)
      expect(result.tools.length).toBeGreaterThanOrEqual(17);
    });

    it('should provide schemas for child server tools', async () => {
      const result = await client.listTools();
      const memoryTools = result.tools.filter(t => t.name.startsWith('memory:'));

      for (const tool of memoryTools) {
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.inputSchema).toBe('object');
      }
    });

    it('should have unique tool names across all servers', async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map(t => t.name);

      // Check for duplicates
      const uniqueNames = new Set(toolNames);
      expect(uniqueNames.size).toBe(toolNames.length);
    });
  });
});
