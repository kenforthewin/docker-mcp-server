import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Configuration for a child MCP server
 */
export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Runtime information about a child MCP server
 */
interface ChildServerInfo {
  name: string;
  config: ServerConfig;
  client: Client;
  transport: StdioClientTransport;
  status: "starting" | "connected" | "failed" | "disconnected";
  restartCount: number;
  lastRestartTime: number;
}

/**
 * Aggregated tool with metadata about its source
 * Uses Zod schema shape instead of JSON Schema for inputSchema
 */
export interface AggregatedTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  _meta: {
    originalName: string;
    serverName: string;
  };
}

/**
 * Convert JSON Schema to Zod schema shape
 * Returns the shape object (Record<string, ZodTypeAny>) for object schemas
 * This matches what MCP SDK's registerTool() expects
 */
function jsonSchemaToZodShape(schema: any): Record<string, z.ZodTypeAny> {
  // Handle null/undefined schemas - return empty object
  if (!schema || schema.type !== "object") {
    return {};
  }

  const shape: Record<string, z.ZodTypeAny> = {};

  // Convert each property
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      let fieldSchema = jsonSchemaPropertyToZod(propSchema);

      // Make optional if not in required array
      if (!schema.required || !schema.required.includes(key)) {
        fieldSchema = fieldSchema.optional();
      }

      shape[key] = fieldSchema;
    }
  }

  return shape;
}

/**
 * Convert a JSON Schema property to a Zod type
 */
function jsonSchemaPropertyToZod(schema: any): z.ZodTypeAny {
  if (!schema) {
    return z.any();
  }

  const type = schema.type;

  switch (type) {
    case "string":
      return z.string();

    case "number":
      return z.number();

    case "integer":
      return z.number().int();

    case "boolean":
      return z.boolean();

    case "array":
      if (schema.items) {
        const itemSchema = jsonSchemaPropertyToZod(schema.items);
        return z.array(itemSchema);
      }
      return z.array(z.any());

    case "object":
      if (schema.properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          let fieldSchema = jsonSchemaPropertyToZod(propSchema);
          if (!schema.required || !schema.required.includes(key)) {
            fieldSchema = fieldSchema.optional();
          }
          shape[key] = fieldSchema;
        }
        return z.object(shape);
      }
      return z.record(z.any());

    case "null":
      return z.null();

    default:
      // Handle union types (anyOf, oneOf)
      if (schema.anyOf) {
        const schemas = schema.anyOf.map((s: any) => jsonSchemaPropertyToZod(s));
        return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      }

      if (schema.oneOf) {
        const schemas = schema.oneOf.map((s: any) => jsonSchemaPropertyToZod(s));
        return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      }

      // Fallback to any
      return z.any();
  }
}

/**
 * Manages multiple child MCP servers and aggregates their capabilities
 */
export class ChildServerManager {
  private servers = new Map<string, ChildServerInfo>();
  private maxRestartAttempts = 3;
  private restartBackoffMs = 5000;

  /**
   * Start a child MCP server
   */
  async startServer(name: string, config: ServerConfig): Promise<void> {
    console.error(`[ChildServerManager] Starting child server: ${name}`);

    try {
      // Create stdio transport
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env,
        stderr: "pipe", // Capture stderr for logging
      });

      // Create client
      const client = new Client(
        {
          name: `aggregator-client-${name}`,
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      // Set up error handler
      client.onerror = (error) => {
        console.error(`[ChildServerManager] Error from ${name}:`, error);
      };

      // Store server info
      const serverInfo: ChildServerInfo = {
        name,
        config,
        client,
        transport,
        status: "starting",
        restartCount: 0,
        lastRestartTime: 0,
      };

      this.servers.set(name, serverInfo);

      // Set up transport handlers
      this.setupTransportHandlers(name, serverInfo);

      // Connect to the child server
      await client.connect(transport);

      // Verify connection by listing tools
      await client.listTools();

      serverInfo.status = "connected";
      console.error(`[ChildServerManager] Successfully connected to ${name}`);
    } catch (error) {
      console.error(`[ChildServerManager] Failed to start ${name}:`, error);
      const serverInfo = this.servers.get(name);
      if (serverInfo) {
        serverInfo.status = "failed";
      }
      throw error;
    }
  }

  /**
   * Set up handlers for transport events
   */
  private setupTransportHandlers(name: string, serverInfo: ChildServerInfo): void {
    // Monitor stderr for errors
    if (serverInfo.transport.stderr) {
      serverInfo.transport.stderr.on("data", (data) => {
        console.error(`[ChildServerManager] [${name}] stderr:`, data.toString().trim());
      });
    }

    // Handle transport close
    serverInfo.transport.onclose = () => {
      console.error(`[ChildServerManager] Child server ${name} disconnected`);
      serverInfo.status = "disconnected";

      // Attempt restart if not exceeded max attempts
      this.attemptRestart(name, serverInfo);
    };
  }

  /**
   * Attempt to restart a failed or disconnected server
   */
  private attemptRestart(name: string, serverInfo: ChildServerInfo): void {
    const now = Date.now();
    const timeSinceLastRestart = now - serverInfo.lastRestartTime;

    // Reset restart count if it's been a while since last restart
    if (timeSinceLastRestart > 60000) {
      // 1 minute
      serverInfo.restartCount = 0;
    }

    if (serverInfo.restartCount < this.maxRestartAttempts) {
      serverInfo.restartCount++;
      serverInfo.lastRestartTime = now;

      const backoffDelay = this.restartBackoffMs * serverInfo.restartCount;

      console.error(
        `[ChildServerManager] Scheduling restart for ${name} ` +
          `(attempt ${serverInfo.restartCount}/${this.maxRestartAttempts}) ` +
          `in ${backoffDelay}ms`
      );

      setTimeout(() => {
        console.error(`[ChildServerManager] Restarting ${name}...`);
        this.startServer(name, serverInfo.config).catch((error) => {
          console.error(`[ChildServerManager] Restart failed for ${name}:`, error);
        });
      }, backoffDelay);
    } else {
      console.error(
        `[ChildServerManager] Max restart attempts reached for ${name}, giving up`
      );
    }
  }

  /**
   * Stop a child server
   */
  async stopServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      console.warn(`[ChildServerManager] Server ${name} not found`);
      return;
    }

    try {
      console.error(`[ChildServerManager] Stopping ${name}...`);
      await serverInfo.client.close();
      this.servers.delete(name);
      console.error(`[ChildServerManager] Stopped ${name}`);
    } catch (error) {
      console.error(`[ChildServerManager] Error stopping ${name}:`, error);
    }
  }

  /**
   * Stop all child servers
   */
  async stopAll(): Promise<void> {
    console.error(`[ChildServerManager] Stopping all child servers...`);
    const stopPromises = Array.from(this.servers.keys()).map((name) =>
      this.stopServer(name)
    );
    await Promise.all(stopPromises);
    console.error(`[ChildServerManager] All child servers stopped`);
  }

  /**
   * Get a specific child server
   */
  getServer(name: string): ChildServerInfo | undefined {
    return this.servers.get(name);
  }

  /**
   * Get all connected servers
   */
  getConnectedServers(): ChildServerInfo[] {
    return Array.from(this.servers.values()).filter(
      (server) => server.status === "connected"
    );
  }

  /**
   * Aggregate tools from all connected child servers
   */
  async aggregateTools(): Promise<AggregatedTool[]> {
    const allTools: AggregatedTool[] = [];

    for (const serverInfo of this.getConnectedServers()) {
      try {
        const toolsResult = await serverInfo.client.listTools();

        for (const tool of toolsResult.tools) {
          // Convert JSON Schema to Zod schema shape
          const zodShape = jsonSchemaToZodShape(tool.inputSchema);

          // Namespace the tool with server name
          const namespacedTool: AggregatedTool = {
            name: `${serverInfo.name}:${tool.name}`,
            description: `[${serverInfo.name}] ${tool.description}`,
            inputSchema: zodShape,
            _meta: {
              originalName: tool.name,
              serverName: serverInfo.name,
            },
          };

          allTools.push(namespacedTool);
        }

        console.error(
          `[ChildServerManager] Collected ${toolsResult.tools.length} tools from ${serverInfo.name}`
        );
      } catch (error) {
        console.error(
          `[ChildServerManager] Error listing tools from ${serverInfo.name}:`,
          error
        );
      }
    }

    return allTools;
  }

  /**
   * Route a tool call to the appropriate child server
   */
  async routeToolCall(toolName: string, args: any): Promise<any> {
    // Parse namespaced tool name: "server-name:tool-name"
    const colonIndex = toolName.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(
        `Invalid tool name format: ${toolName}. Expected format: serverName:toolName`
      );
    }

    const serverName = toolName.substring(0, colonIndex);
    const originalToolName = toolName.substring(colonIndex + 1);

    const serverInfo = this.servers.get(serverName);
    if (!serverInfo || serverInfo.status !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: `Error: Server "${serverName}" is not available. Status: ${
              serverInfo?.status || "not found"
            }`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Call the tool on the child server
      const result = await serverInfo.client.callTool({
        name: originalToolName,
        arguments: args,
      });

      return result;
    } catch (error: any) {
      console.error(
        `[ChildServerManager] Error calling ${serverName}:${originalToolName}:`,
        error
      );

      return {
        content: [
          {
            type: "text",
            text: `Error calling ${serverName}:${originalToolName}: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
}
