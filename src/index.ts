#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn, ChildProcess } from "child_process";
import { Command } from "commander";
import http from "http";
import { randomUUID } from "crypto";
import { readFile, mkdir } from "fs/promises";
import { ChildServerManager, type ServerConfig } from "./childServerManager.js";
import { AsyncLocalStorage } from "async_hooks";

// Request context storage for execution ID scoping
interface RequestContext {
  executionId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the workspace path for the current request.
 * If an Execution-Id header was provided, returns /app/workspace/<execution-id>
 * Otherwise returns the default /app/workspace
 */
function getWorkspacePath(): string {
  const context = requestContext.getStore();
  const executionId = context?.executionId;

  if (executionId) {
    return `/app/workspace/${executionId}`;
  }

  return "/app/workspace";
}

/**
 * Ensure the workspace directory exists for the current request
 */
async function ensureWorkspaceExists(): Promise<void> {
  const workspacePath = getWorkspacePath();
  try {
    await mkdir(workspacePath, { recursive: true });
  } catch (error) {
    console.error(`Warning: Failed to create workspace directory ${workspacePath}:`, error);
  }
}

// Parse CLI arguments
const program = new Command();
program
  .name('docker-mcp-server')
  .description('MCP server for Docker container execution')
  .version('1.0.0')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('-t, --token <token>', 'Bearer token for authentication (auto-generated if not provided)')
  .parse();

const options = program.opts();
const PORT = parseInt(options.port, 10);
const AUTH_TOKEN = options.token || randomUUID();

interface ProcessInfo {
  startTime: number;
  command: string;
  rationale?: string;
  bashProcess?: ChildProcess;
  status: 'running' | 'completed';
  endTime?: number;
  exitCode?: number;
  result?: string;
  currentStdout?: string;
  currentStderr?: string;
  lastOutputTime?: number;
  maxWaitTime: number;
}

const processes = new Map<string, ProcessInfo>();

function generateProcessId(): string {
  return `proc_${Date.now()}_${Math.random().toString(36).substring(2)}`;
}

const server = new McpServer({
  name: "docker-mcp-server",
  version: "1.0.0"
});

// Child server manager for aggregating multiple MCP servers
const childServerManager = new ChildServerManager();

server.registerTool(
  "execute_command",
  {
    title: "Execute Docker Command",
    description: "Execute a shell command inside a Docker container.\n\nNOTE: This tool is scoped to the execution workspace directory at /app/workspace/<execution-id>. All paths should be relative to this workspace root. Commands and file operations should stay within this directory as it represents the project boundary.",
    inputSchema: {
      command: z.string().describe("The shell command to execute in the container"),
      rationale: z.string().describe("Explanation of why this command is being executed"),
      maxWaitTime: z.number().optional().describe("Maximum seconds to wait before returning to agent (default: 20)")
    }
  },
  async ({ command, rationale, maxWaitTime = 20 }) => {
    // Ensure workspace directory exists before executing command
    await ensureWorkspaceExists();

    const workspacePath = getWorkspacePath();
    console.error(`Executing command in ${workspacePath}: ${command}`);
    console.error(`Rationale: ${rationale}`);

    return new Promise((resolve) => {
      const processId = generateProcessId();
      const bashProcess = spawn("bash", [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workspacePath
      });

      if (!bashProcess.stdin || !bashProcess.stdout || !bashProcess.stderr) {
        resolve({
          content: [{
            type: "text" as const,
            text: "Error: Failed to create process streams\nExit code: 1"
          }]
        });
        return;
      }

      // Track this process
      processes.set(processId, {
        startTime: Date.now(),
        command,
        rationale,
        bashProcess,
        status: 'running',
        lastOutputTime: Date.now(),
        maxWaitTime
      });

      let stdout = "";
      let stderr = "";
      let completed = false;
      const uniqueMarker = `__MCP_END_${Date.now()}_${Math.random().toString(36).substring(2)}__`;

      const formatResult = (exitCode: number) => {
        let result = "";
        const cleanStdout = stdout.replace(new RegExp(`${uniqueMarker}.*`, 's'), '').trim();
        const cleanStderr = stderr.trim();
        
        if (cleanStdout && cleanStderr) {
          result = `STDOUT:\n${cleanStdout}\n\nSTDERR:\n${cleanStderr}`;
        } else if (cleanStdout) {
          result = cleanStdout;
        } else if (cleanStderr) {
          result = cleanStderr;
        } else {
          if (exitCode === 0) {
            result = "Command executed successfully (no output)";
          } else {
            result = "Command executed with error (no output)";
          }
        }
        
        result += `\nExit code: ${exitCode}`;
        return result;
      };

      const cleanup = () => {
        if (!completed) {
          completed = true;
          bashProcess.stdout?.removeAllListeners("data");
          bashProcess.stderr?.removeAllListeners("data");
          bashProcess.removeAllListeners("error");
          bashProcess.removeAllListeners("exit");
        }
      };

      // Smart timeout system: wait for output inactivity
      let lastOutputTime = Date.now();
      let inactivityTimeoutId: NodeJS.Timeout;
      let maxTimeoutId: NodeJS.Timeout;

      const handleInactivity = () => {
        if (!completed) {
          completed = true;
          const inactivityDuration = Date.now() - lastOutputTime;
          console.error(`Command inactive for ${Math.floor(inactivityDuration/1000)}s (maxWaitTime: ${maxWaitTime}s), running in background with ID: ${processId}`);
          
          let result = "";
          if (stdout.trim() || stderr.trim()) {
            const cleanStdout = stdout.trim();
            const cleanStderr = stderr.trim();
            
            if (cleanStdout && cleanStderr) {
              result = `STDOUT:\n${cleanStdout}\n\nSTDERR:\n${cleanStderr}\n\n`;
            } else if (cleanStdout) {
              result = `${cleanStdout}\n\n`;
            } else if (cleanStderr) {
              result = `${cleanStderr}\n\n`;
            }
          }
          
          result += `Command still running in background (no output for ${Math.floor(inactivityDuration/1000)}s, maxWaitTime: ${maxWaitTime}s).\nProcess ID: ${processId}\nUse check_process tool to monitor status.`;

          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      };

      const resetInactivityTimer = () => {
        clearTimeout(inactivityTimeoutId);
        lastOutputTime = Date.now();
        inactivityTimeoutId = setTimeout(handleInactivity, maxWaitTime * 1000); // maxWaitTime seconds of inactivity
      };

      // Start inactivity timer
      resetInactivityTimer();

      // Maximum safety timeout (10 minutes)
      maxTimeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          console.error(`Command maximum timeout (10min) reached, running in background with ID: ${processId}`);
          
          let result = "";
          if (stdout.trim() || stderr.trim()) {
            const cleanStdout = stdout.trim();
            const cleanStderr = stderr.trim();
            
            if (cleanStdout && cleanStderr) {
              result = `STDOUT:\n${cleanStdout}\n\nSTDERR:\n${cleanStderr}\n\n`;
            } else if (cleanStdout) {
              result = `${cleanStdout}\n\n`;
            } else if (cleanStderr) {
              result = `${cleanStderr}\n\n`;
            }
          }
          
          result += `Command still running in background (maximum timeout reached).\nProcess ID: ${processId}\nUse check_process tool to monitor status.`;

          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      }, 600000); // 10 minutes

      // Track marker detection for proper exit code handling
      let markerDetected = false;
      let detectedExitCode = 0;

      bashProcess.on("error", (error) => {
        clearTimeout(inactivityTimeoutId);
        clearTimeout(maxTimeoutId);
        cleanup();

        const errorResult = `Error spawning process: ${error.message}\nExit code: 1`;

        // Store error result
        const processInfo = processes.get(processId);
        if (processInfo) {
          processInfo.status = 'completed';
          processInfo.endTime = Date.now();
          processInfo.exitCode = 1;
          processInfo.result = errorResult;
          processInfo.bashProcess = undefined; // Clear process reference
        }

        resolve({
          content: [{
            type: "text" as const,
            text: errorResult
          }]
        });
      });

      // Background process exit detection (event-driven, no polling)
      bashProcess.on("exit", (code) => {
        // Use detectedExitCode if marker was found, otherwise use bash exit code
        const exitCode = markerDetected ? detectedExitCode : (code ?? 1);
        const result = formatResult(exitCode);

        const processInfo = processes.get(processId);
        if (processInfo) {
          const duration = Date.now() - processInfo.startTime;

          console.error(`Background process ${processId} finished after ${duration}ms with exit code: ${exitCode}`);

          // Debug log final result
          const truncatedResult = result.length > 500 ? result.substring(0, 500) + '... (truncated)' : result;
          console.error(`[DEBUG] Process ${processId} Final Result: ${JSON.stringify(truncatedResult)}`);

          // Store completion result
          processInfo.status = 'completed';
          processInfo.endTime = Date.now();
          processInfo.exitCode = exitCode;
          processInfo.result = result;
          processInfo.bashProcess = undefined; // Clear process reference
        }

        if (!completed) {
          clearTimeout(inactivityTimeoutId);
          clearTimeout(maxTimeoutId);
          cleanup();

          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      });

      bashProcess.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;

        // Debug log for stdout
        const truncatedText = text.length > 500 ? text.substring(0, 500) + '... (truncated)' : text;
        console.error(`[DEBUG] Process ${processId} STDOUT: ${JSON.stringify(truncatedText)}`);

        // Reset inactivity timer on any output
        resetInactivityTimer();

        // Update current output in process info
        const processInfo = processes.get(processId);
        if (processInfo) {
          processInfo.currentStdout = stdout;
          processInfo.lastOutputTime = Date.now();
        }

        if (text.includes(uniqueMarker) && !markerDetected) {
          // Command completed, close stdin so bash can exit
          markerDetected = true;
          bashProcess.stdin.end();

          clearTimeout(inactivityTimeoutId);
          clearTimeout(maxTimeoutId);

          const parts = stdout.split(uniqueMarker);
          const exitCodeMatch = parts[1]?.match(/EXIT_CODE:(\d+)/);
          detectedExitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 0;

          // For synchronous commands, let the exit handler format the final result
          // to ensure stderr is fully received. For backgrounded commands, store now.
          if (completed) {
            // Process was already backgrounded, format and store result now
            const result = formatResult(detectedExitCode);
            const processInfo = processes.get(processId);
            if (processInfo) {
              processInfo.status = 'completed';
              processInfo.endTime = Date.now();
              processInfo.exitCode = detectedExitCode;
              processInfo.result = result;
              processInfo.currentStdout = parts[0].trim();
              processInfo.bashProcess = undefined;
            }
            cleanup();
          }
          // If not completed (synchronous), let exit handler finish
        }
      });

      bashProcess.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;

        // Debug log for stderr
        const truncatedText = text.length > 500 ? text.substring(0, 500) + '... (truncated)' : text;
        console.error(`[DEBUG] Process ${processId} STDERR: ${JSON.stringify(truncatedText)}`);

        // Reset inactivity timer on any output
        resetInactivityTimer();
        
        // Update current output in process info
        const processInfo = processes.get(processId);
        if (processInfo) {
          processInfo.currentStderr = stderr;
          processInfo.lastOutputTime = Date.now();
        }
      });

      // Handle background commands properly
      const isBackgroundCommand = command.trim().endsWith('&');
      let commandWithMarker;

      if (isBackgroundCommand) {
        // For background commands, we need to capture the PID and wait for completion differently
        commandWithMarker = `${command} echo "${uniqueMarker}EXIT_CODE:$?"\n`;
      } else {
        // For regular commands, append the marker with semicolon
        commandWithMarker = `${command}; echo "${uniqueMarker}EXIT_CODE:$?"\n`;
      }

      console.error(`[DEBUG] Process ${processId} sending command to bash: ${JSON.stringify(command)}`);
      bashProcess.stdin.write(commandWithMarker);
      // Keep stdin open for potential future input (don't call bashProcess.stdin.end())
    });
  }
);

server.registerTool(
  "check_process",
  {
    title: "Check Background Process",
    description: "Check the status of a background process by its ID",
    inputSchema: {
      processId: z.string().describe("The process ID returned by a long-running command"),
      rationale: z.string().describe("Explanation of why you need to check this process")
    }
  },
  async ({ processId, rationale }) => {
    console.error(`Checking process status: ${processId}`);
    console.error(`Rationale: ${rationale}`);
    const processInfo = processes.get(processId);
    
    if (!processInfo) {
      return {
        content: [{
          type: "text" as const,
          text: "Process not found"
        }]
      };
    }

    // If process is already completed, return results immediately
    if (processInfo.status === 'completed') {
      const duration = (processInfo.endTime! - processInfo.startTime);
      const durationSeconds = Math.floor(duration / 1000);
      
      let result = `Process Status: COMPLETED\n`;
      result += `Process ID: ${processId}\n`;
      result += `Command: ${processInfo.command}\n`;
      if (processInfo.rationale) {
        result += `Rationale: ${processInfo.rationale}\n`;
      }
      result += `Completed after: ${durationSeconds} seconds\n`;
      result += `Exit code: ${processInfo.exitCode}\n\n`;
      result += `Final Result:\n${processInfo.result}`;

      return {
        content: [{
          type: "text" as const,
          text: result
        }]
      };
    }

    // Process is running - use smart waiting based on output activity
    return new Promise((resolve) => {
      const startWaitTime = Date.now();
      const initialLastOutputTime = processInfo.lastOutputTime || processInfo.startTime;
      console.error(`Checking process ${processId}, waiting for completion or inactivity...`);

      const checkCompletion = () => {
        const currentProcessInfo = processes.get(processId);
        
        if (!currentProcessInfo) {
          resolve({
            content: [{
              type: "text" as const,
              text: "Process not found (may have been cleaned up)"
            }]
          });
          return;
        }

        if (currentProcessInfo.status === 'completed') {
          const duration = (currentProcessInfo.endTime! - currentProcessInfo.startTime);
          const durationSeconds = Math.floor(duration / 1000);
          const waitDuration = Date.now() - startWaitTime;
          
          console.error(`Process ${processId} completed during wait (waited ${waitDuration}ms)`);
          
          let result = `Process Status: COMPLETED\n`;
          result += `Process ID: ${processId}\n`;
          result += `Command: ${currentProcessInfo.command}\n`;
          if (currentProcessInfo.rationale) {
            result += `Rationale: ${currentProcessInfo.rationale}\n`;
          }
          result += `Completed after: ${durationSeconds} seconds\n`;
          result += `Exit code: ${currentProcessInfo.exitCode}\n\n`;
          result += `Final Result:\n${currentProcessInfo.result}`;

          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
          return;
        }

        const now = Date.now();
        const lastOutput = currentProcessInfo.lastOutputTime || currentProcessInfo.startTime;
        const timeSinceLastOutput = now - lastOutput;
        const totalWaitTime = now - startWaitTime;
        
        // Return if no output for maxWaitTime seconds OR we've waited 10 minutes total
        const maxWaitMs = (currentProcessInfo.maxWaitTime || 20) * 1000;
        if (timeSinceLastOutput >= maxWaitMs || totalWaitTime >= 600000) {
          const totalDuration = now - currentProcessInfo.startTime;
          const totalDurationSeconds = Math.floor(totalDuration / 1000);
          const inactivitySeconds = Math.floor(timeSinceLastOutput / 1000);
          const waitSeconds = Math.floor(totalWaitTime / 1000);
          
          const reason = totalWaitTime >= 600000 ? 
            `maximum wait time (${waitSeconds}s)` : 
            `no output for ${inactivitySeconds}s (maxWaitTime: ${currentProcessInfo.maxWaitTime}s)`;
            
          console.error(`Process ${processId} still running after ${reason}`);
          
          let result = `Process Status: RUNNING\n`;
          result += `Process ID: ${processId}\n`;
          result += `Command: ${currentProcessInfo.command}\n`;
          if (currentProcessInfo.rationale) {
            result += `Rationale: ${currentProcessInfo.rationale}\n`;
          }
          result += `Running for: ${totalDurationSeconds} seconds\n`;
          result += `(Waited ${waitSeconds}s, ${reason})\n\n`;
          
          // Show current output
          if (currentProcessInfo.currentStdout || currentProcessInfo.currentStderr) {
            result += `Current Output:\n`;
            if (currentProcessInfo.currentStdout && currentProcessInfo.currentStderr) {
              result += `STDOUT:\n${currentProcessInfo.currentStdout.trim()}\n\nSTDERR:\n${currentProcessInfo.currentStderr.trim()}`;
            } else if (currentProcessInfo.currentStdout) {
              result += currentProcessInfo.currentStdout.trim();
            } else if (currentProcessInfo.currentStderr) {
              result += currentProcessInfo.currentStderr.trim();
            }
          } else {
            result += `No output captured yet`;
          }

          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
          return;
        }

        // Check again in 500ms
        setTimeout(checkCompletion, 500);
      };

      // Start checking
      checkCompletion();
    });
  }
);

server.registerTool(
  "send_input",
  {
    title: "Send Input to Process",
    description: "Send input to a running background process",
    inputSchema: {
      processId: z.string().describe("The process ID of the running process"),
      input: z.string().describe("The input to send to the process"),
      rationale: z.string().describe("Explanation of why you need to send input to this process"),
      autoNewline: z.boolean().optional().default(true).describe("Whether to automatically add a newline (default: true)")
    }
  },
  async ({ processId, input, rationale, autoNewline = true }) => {
    const processInfo = processes.get(processId);
    
    if (!processInfo) {
      return {
        content: [{
          type: "text" as const,
          text: "Process not found"
        }]
      };
    }

    if (processInfo.status === 'completed') {
      return {
        content: [{
          type: "text" as const,
          text: "Cannot send input to completed process"
        }]
      };
    }

    if (!processInfo.bashProcess || !processInfo.bashProcess.stdin) {
      return {
        content: [{
          type: "text" as const,
          text: "Process stdin not available"
        }]
      };
    }

    try {
      const inputToSend = input + (autoNewline ? '\n' : '');
      processInfo.bashProcess.stdin.write(inputToSend);
      
      console.error(`Sent input to process ${processId}: ${JSON.stringify(inputToSend)}`);
      console.error(`Rationale: ${rationale}`);
      
      return {
        content: [{
          type: "text" as const,
          text: `Input sent to process ${processId}`
        }]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text" as const,
          text: `Error sending input: ${errorMessage}`
        }]
      };
    }
  }
);

server.registerTool(
  "file_ls",
  {
    title: "List Directory Contents in Docker Container",
    description: "Lists files and directories in a given path. The path parameter must be an absolute path, not a relative path. You can optionally provide an array of glob patterns to ignore with the ignore parameter.\n\nNOTE: This tool is scoped to the execution workspace directory at /app/workspace/<execution-id>. All paths should be relative to this workspace root. Commands and file operations should stay within this directory as it represents the project boundary.",
    inputSchema: {
      path: z.string().optional().default(".").describe("The directory path to list (default: current directory)"),
      rationale: z.string().describe("Explanation of why you need to list this directory"),
      ignore: z.array(z.string()).optional().describe("List of glob patterns to ignore")
    }
  },
  async ({ path = ".", rationale, ignore = [] }) => {
    await ensureWorkspaceExists();
    const workspacePath = getWorkspacePath();

    console.error(`Listing directory: ${path}${ignore.length ? ` (ignoring: ${ignore.join(', ')})` : ''}`);
    console.error(`Rationale: ${rationale}`);

    return new Promise((resolve) => {
      const bashProcess = spawn("bash", [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workspacePath
      });

      if (!bashProcess.stdin || !bashProcess.stdout || !bashProcess.stderr) {
        resolve({
          content: [{
            type: "text" as const,
            text: "Error: Failed to create process streams\nExit code: 1"
          }]
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let completed = false;
      const uniqueMarker = `__LS_END_${Date.now()}_${Math.random().toString(36).substring(2)}__`;

      const cleanup = () => {
        if (!completed) {
          completed = true;
          bashProcess.stdout?.removeAllListeners("data");
          bashProcess.stderr?.removeAllListeners("data");
          bashProcess.removeAllListeners("error");
          bashProcess.removeAllListeners("exit");
        }
      };

      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          bashProcess.kill();
          resolve({
            content: [{
              type: "text" as const,
              text: "Error: List operation timed out\nExit code: 1"
            }]
          });
        }
      }, 30000); // 30 second timeout

      bashProcess.on("error", (error) => {
        clearTimeout(timeoutId);
        cleanup();
        resolve({
          content: [{
            type: "text" as const,
            text: `Error spawning process: ${error.message}\nExit code: 1`
          }]
        });
      });

      bashProcess.on("exit", (code) => {
        if (!completed) {
          clearTimeout(timeoutId);
          cleanup();
          completed = true;
          
          const exitCode = code ?? 1;
          let result = "";
          
          if (stdout.trim() || stderr.trim()) {
            const cleanStdout = stdout.replace(new RegExp(`${uniqueMarker}.*`, 's'), '').trim();
            const cleanStderr = stderr.trim();
            
            if (exitCode === 0) {
              result = cleanStdout || "Directory is empty";
            } else if (cleanStderr) {
              result = cleanStderr;
            } else if (cleanStdout) {
              result = cleanStdout;
            }
          }
          
          if (exitCode !== 0) {
            result = result || "List operation failed";
            result += `\nExit code: ${exitCode}`;
          }
          
          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      });

      bashProcess.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        
        if (text.includes(uniqueMarker) && !completed) {
          bashProcess.stdin.end();
          
          clearTimeout(timeoutId);
          const parts = stdout.split(uniqueMarker);
          const exitCodeMatch = parts[1]?.match(/EXIT_CODE:(\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 0;
          
          cleanup();
          completed = true;
          
          let result = parts[0].trim();
          const cleanStderr = stderr.trim();
          
          if (exitCode === 0) {
            result = result || "Directory is empty";
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          } else {
            result = cleanStderr || result || "List operation failed";
            result += `\nExit code: ${exitCode}`;
            
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          }
        }
      });

      bashProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Default ignore patterns similar to OpenCode
      const defaultIgnorePatterns = [
        "node_modules",
        ".git",
        "dist",
        "build",
        "target",
        ".next",
        ".nuxt",
        ".vscode",
        ".idea",
        "*.log",
        ".DS_Store",
        "Thumbs.db",
        "*.tmp",
        "*.temp"
      ];
      
      const allIgnorePatterns = [...defaultIgnorePatterns, ...ignore];
      
      // Build find command with ignore patterns
      let findCommand = `find "${path}" -type f -o -type d`;
      
      // Add exclude patterns
      for (const pattern of allIgnorePatterns) {
        findCommand += ` | grep -v "${pattern}"`;
      }
      
      // Create a bash script to list directory contents
      const lsScript = `
# Check if directory exists
if [ ! -d "${path}" ]; then
  echo "Error: Directory ${path} not found"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
fi

# Change to the directory
cd "${path}" || {
  echo "Error: Cannot access directory ${path}"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
}

# List files and directories with details, limit to 100 entries
ls -la | head -n 101 | while IFS= read -r line; do
  # Skip total line
  if [[ "$line" == total* ]]; then
    continue
  fi
  echo "$line"
done

# Check if there are more than 100 entries
TOTAL_COUNT=$(ls -1 | wc -l)
if [ "$TOTAL_COUNT" -gt 100 ]; then
  echo ""
  echo "Note: Showing first 100 of $TOTAL_COUNT total entries"
fi

echo "${uniqueMarker}EXIT_CODE:0"
`;

      bashProcess.stdin.write(lsScript);
    });
  }
);

server.registerTool(
  "file_grep",
  {
    title: "Search Files in Docker Container",
    description: "Search for patterns in files inside the Docker container using grep.\n\nNOTE: This tool is scoped to the execution workspace directory at /app/workspace/<execution-id>. All paths should be relative to this workspace root. Commands and file operations should stay within this directory as it represents the project boundary.",
    inputSchema: {
      pattern: z.string().describe("The search pattern (supports regex)"),
      rationale: z.string().describe("Explanation of why you need to search for this pattern"),
      path: z.string().optional().default(".").describe("The directory to search in (default: current directory)"),
      include: z.string().optional().describe("File pattern to include (e.g., '*.js', '*.{ts,tsx}')"),
      caseInsensitive: z.boolean().optional().default(false).describe("Case insensitive search (default: false)"),
      maxResults: z.number().optional().default(100).describe("Maximum number of results to return (default: 100)")
    }
  },
  async ({ pattern, rationale, path = ".", include, caseInsensitive = false, maxResults = 100 }) => {
    await ensureWorkspaceExists();
    const workspacePath = getWorkspacePath();

    console.error(`Searching for pattern: ${pattern} in ${path}${include ? ` (include: ${include})` : ''}`);
    console.error(`Rationale: ${rationale}`);

    return new Promise((resolve) => {
      const bashProcess = spawn("bash", [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workspacePath
      });

      if (!bashProcess.stdin || !bashProcess.stdout || !bashProcess.stderr) {
        resolve({
          content: [{
            type: "text" as const,
            text: "Error: Failed to create process streams\nExit code: 1"
          }]
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let completed = false;
      const uniqueMarker = `__GREP_END_${Date.now()}_${Math.random().toString(36).substring(2)}__`;

      const cleanup = () => {
        if (!completed) {
          completed = true;
          bashProcess.stdout?.removeAllListeners("data");
          bashProcess.stderr?.removeAllListeners("data");
          bashProcess.removeAllListeners("error");
          bashProcess.removeAllListeners("exit");
        }
      };

      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          bashProcess.kill();
          resolve({
            content: [{
              type: "text" as const,
              text: "Error: Grep operation timed out\nExit code: 1"
            }]
          });
        }
      }, 30000); // 30 second timeout

      bashProcess.on("error", (error) => {
        clearTimeout(timeoutId);
        cleanup();
        resolve({
          content: [{
            type: "text" as const,
            text: `Error spawning process: ${error.message}\nExit code: 1`
          }]
        });
      });

      bashProcess.on("exit", (code) => {
        if (!completed) {
          clearTimeout(timeoutId);
          cleanup();
          completed = true;
          
          const exitCode = code ?? 1;
          let result = "";
          
          if (stdout.trim() || stderr.trim()) {
            const cleanStdout = stdout.replace(new RegExp(`${uniqueMarker}.*`, 's'), '').trim();
            const cleanStderr = stderr.trim();
            
            if (exitCode === 0 || exitCode === 1) { // grep returns 1 when no matches found
              result = cleanStdout || "No matches found";
            } else if (cleanStderr) {
              result = cleanStderr;
            } else if (cleanStdout) {
              result = cleanStdout;
            }
          }
          
          if (exitCode > 1) { // grep error codes > 1 indicate actual errors
            result = result || "Grep operation failed";
            result += `\nExit code: ${exitCode}`;
          }
          
          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      });

      bashProcess.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        
        if (text.includes(uniqueMarker) && !completed) {
          bashProcess.stdin.end();
          
          clearTimeout(timeoutId);
          const parts = stdout.split(uniqueMarker);
          const exitCodeMatch = parts[1]?.match(/EXIT_CODE:(\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 0;
          
          cleanup();
          completed = true;
          
          let result = parts[0].trim();
          const cleanStderr = stderr.trim();
          
          if (exitCode === 0 || exitCode === 1) { // 0 = matches found, 1 = no matches
            result = result || "No matches found";
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          } else {
            result = cleanStderr || result || "Grep operation failed";
            result += `\nExit code: ${exitCode}`;
            
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          }
        }
      });

      bashProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Escape pattern for safe shell usage
      const escapedPattern = pattern.replace(/'/g, "'\"'\"'");

      // Build grep command with options
      let grepCommand = "grep -E -rn"; // extended regex, recursive, show line numbers

      if (caseInsensitive) {
        grepCommand += "i"; // case insensitive
      }
      
      // Add file include pattern if specified
      const includeOption = include ? `--include="${include}"` : "";
      
      // Create a bash script to perform the grep search
      const grepScript = `
# Change to the specified directory
cd "${path}" || {
  echo "Error: Directory ${path} not found"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
}

# Perform grep search with specified options
${grepCommand} ${includeOption} '${escapedPattern}' . 2>/dev/null | head -n ${maxResults}
EXIT_CODE=$?

# Count total matches (without limit) for reporting
TOTAL_MATCHES=$(${grepCommand} ${includeOption} '${escapedPattern}' . 2>/dev/null | wc -l)

# Add summary information
if [ $TOTAL_MATCHES -gt ${maxResults} ]; then
  echo ""
  echo "Note: Showing first ${maxResults} of $TOTAL_MATCHES total matches"
fi

echo "${uniqueMarker}EXIT_CODE:$EXIT_CODE"
`;

      bashProcess.stdin.write(grepScript);
    });
  }
);

server.registerTool(
  "file_write",
  {
    title: "Write File to Docker Container",
    description: "Create or overwrite a file inside the Docker container with the provided content.\n\nIMPORTANT: You MUST use the file_read tool to read the file first before writing to it, even if you intend to completely overwrite it. This ensures you understand the current state and context of the file.\n\nNOTE: This tool is scoped to the execution workspace directory at /app/workspace/<execution-id>. All paths should be relative to this workspace root. Commands and file operations should stay within this directory as it represents the project boundary.",
    inputSchema: {
      filePath: z.string().describe("The path to the file to write (relative to /app in container)"),
      content: z.string().describe("The content to write to the file"),
      rationale: z.string().describe("Explanation of why you need to write this file")
    }
  },
  async ({ filePath, content, rationale }) => {
    await ensureWorkspaceExists();
    const workspacePath = getWorkspacePath();

    console.error(`Writing file: ${filePath} (${content.length} characters)`);
    console.error(`Rationale: ${rationale}`);

    return new Promise((resolve) => {
      const bashProcess = spawn("bash", [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workspacePath
      });

      if (!bashProcess.stdin || !bashProcess.stdout || !bashProcess.stderr) {
        resolve({
          content: [{
            type: "text" as const,
            text: "Error: Failed to create process streams\nExit code: 1"
          }]
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let completed = false;
      const uniqueMarker = `__WRITE_END_${Date.now()}_${Math.random().toString(36).substring(2)}__`;

      const cleanup = () => {
        if (!completed) {
          completed = true;
          bashProcess.stdout?.removeAllListeners("data");
          bashProcess.stderr?.removeAllListeners("data");
          bashProcess.removeAllListeners("error");
          bashProcess.removeAllListeners("exit");
        }
      };

      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          bashProcess.kill();
          resolve({
            content: [{
              type: "text" as const,
              text: "Error: Write operation timed out\nExit code: 1"
            }]
          });
        }
      }, 30000); // 30 second timeout

      bashProcess.on("error", (error) => {
        clearTimeout(timeoutId);
        cleanup();
        resolve({
          content: [{
            type: "text" as const,
            text: `Error spawning process: ${error.message}\nExit code: 1`
          }]
        });
      });

      bashProcess.on("exit", (code) => {
        if (!completed) {
          clearTimeout(timeoutId);
          cleanup();
          completed = true;
          
          const exitCode = code ?? 1;
          let result = "";
          
          if (stdout.trim() || stderr.trim()) {
            const cleanStdout = stdout.replace(new RegExp(`${uniqueMarker}.*`, 's'), '').trim();
            const cleanStderr = stderr.trim();
            
            if (exitCode === 0) {
              result = cleanStdout || "File written successfully";
            } else if (cleanStderr) {
              result = cleanStderr;
            } else if (cleanStdout) {
              result = cleanStdout;
            }
          }
          
          if (exitCode !== 0) {
            result = result || "Write operation failed";
            result += `\nExit code: ${exitCode}`;
          }
          
          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      });

      bashProcess.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        
        if (text.includes(uniqueMarker) && !completed) {
          bashProcess.stdin.end();
          
          clearTimeout(timeoutId);
          const parts = stdout.split(uniqueMarker);
          const exitCodeMatch = parts[1]?.match(/EXIT_CODE:(\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 0;
          
          cleanup();
          completed = true;
          
          let result = parts[0].trim();
          const cleanStderr = stderr.trim();
          
          if (exitCode === 0) {
            result = result || "File written successfully";
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          } else {
            result = cleanStderr || result || "Write operation failed";
            result += `\nExit code: ${exitCode}`;
            
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          }
        }
      });

      bashProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Escape content for safe transmission
      const escapedContent = content.replace(/'/g, "'\"'\"'");
      
      // Create a bash script to write the file
      const writeScript = `
# Create directory if it doesn't exist
mkdir -p "$(dirname "${filePath}")" || {
  echo "Error: Could not create directory for ${filePath}"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
}

# Write content to file using cat with here-doc to handle all content types safely
cat > "${filePath}" << 'EOF_CONTENT_MARKER'
${content}
EOF_CONTENT_MARKER

# Check if write was successful
if [ $? -eq 0 ]; then
  echo "File written successfully: ${filePath}"
  echo "Content length: ${content.length} characters"
  echo "${uniqueMarker}EXIT_CODE:0"
else
  echo "Error: Failed to write file ${filePath}"
  echo "${uniqueMarker}EXIT_CODE:1"
fi
`;

      bashProcess.stdin.write(writeScript);
    });
  }
);

server.registerTool(
  "file_read",
  {
    title: "Read File from Docker Container",
    description: "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The filePath parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n- Any lines longer than 2000 characters will be truncated\n- Results are returned using cat -n format, with line numbers starting at 1\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.\n\nNOTE: This tool is scoped to the execution workspace directory at /app/workspace/<execution-id>. All paths should be relative to this workspace root. Commands and file operations should stay within this directory as it represents the project boundary.",
    inputSchema: {
      filePath: z.string().describe("The path to the file to read (relative to /app in container)"),
      rationale: z.string().describe("Explanation of why you need to read this file"),
      offset: z.number().optional().default(0).describe("Starting line number (0-based, default: 0)"),
      limit: z.number().optional().default(2000).describe("Maximum number of lines to read (default: 2000)")
    }
  },
  async ({ filePath, rationale, offset = 0, limit = 2000 }) => {
    await ensureWorkspaceExists();
    const workspacePath = getWorkspacePath();

    console.error(`Reading file: ${filePath} (offset: ${offset}, limit: ${limit})`);
    console.error(`Rationale: ${rationale}`);

    return new Promise((resolve) => {
      const bashProcess = spawn("bash", [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workspacePath
      });

      if (!bashProcess.stdin || !bashProcess.stdout || !bashProcess.stderr) {
        resolve({
          content: [{
            type: "text" as const,
            text: "Error: Failed to create process streams\nExit code: 1"
          }]
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let completed = false;
      const uniqueMarker = `__READ_END_${Date.now()}_${Math.random().toString(36).substring(2)}__`;

      const cleanup = () => {
        if (!completed) {
          completed = true;
          bashProcess.stdout?.removeAllListeners("data");
          bashProcess.stderr?.removeAllListeners("data");
          bashProcess.removeAllListeners("error");
          bashProcess.removeAllListeners("exit");
        }
      };

      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          bashProcess.kill();
          resolve({
            content: [{
              type: "text" as const,
              text: "Error: Read operation timed out\nExit code: 1"
            }]
          });
        }
      }, 30000); // 30 second timeout

      bashProcess.on("error", (error) => {
        clearTimeout(timeoutId);
        cleanup();
        resolve({
          content: [{
            type: "text" as const,
            text: `Error spawning process: ${error.message}\nExit code: 1`
          }]
        });
      });

      bashProcess.on("exit", (code) => {
        if (!completed) {
          clearTimeout(timeoutId);
          cleanup();
          completed = true;
          
          const exitCode = code ?? 1;
          let result = "";
          
          if (stdout.trim() || stderr.trim()) {
            const cleanStdout = stdout.replace(new RegExp(`${uniqueMarker}.*`, 's'), '').trim();
            const cleanStderr = stderr.trim();
            
            if (exitCode === 0 && cleanStdout) {
              result = cleanStdout;
            } else if (cleanStderr) {
              result = cleanStderr;
            } else if (cleanStdout) {
              result = cleanStdout;
            }
          }
          
          if (exitCode !== 0) {
            result = result || "Read operation failed";
            result += `\nExit code: ${exitCode}`;
          }
          
          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      });

      bashProcess.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        
        if (text.includes(uniqueMarker) && !completed) {
          bashProcess.stdin.end();
          
          clearTimeout(timeoutId);
          const parts = stdout.split(uniqueMarker);
          const exitCodeMatch = parts[1]?.match(/EXIT_CODE:(\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 0;
          
          cleanup();
          completed = true;
          
          let result = parts[0].trim();
          const cleanStderr = stderr.trim();
          
          if (exitCode === 0) {
            // Success - return file contents
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          } else {
            // Error - return error message
            result = cleanStderr || result || "Read operation failed";
            result += `\nExit code: ${exitCode}`;
            
            resolve({
              content: [{
                type: "text" as const,
                text: result
              }]
            });
          }
        }
      });

      bashProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Create a bash script to read the file with offset and limit
      const readScript = `
# Check if file exists
if [ ! -f "${filePath}" ]; then
  echo "Error: File ${filePath} not found"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
fi

# Check if file is readable
if [ ! -r "${filePath}" ]; then
  echo "Error: File ${filePath} is not readable"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
fi

# Check if it's a binary file
if file "${filePath}" | grep -q "binary"; then
  echo "Error: Cannot read binary file ${filePath}"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
fi

# Read file with offset and limit, adding line numbers
tail -n +$((${offset} + 1)) "${filePath}" | head -n ${limit} | cat -n
echo "${uniqueMarker}EXIT_CODE:0"
`;

      bashProcess.stdin.write(readScript);
    });
  }
);

server.registerTool(
  "file_edit",
  {
    title: "Edit File in Docker Container",
    description: "Performs exact string replacements in files.\n\nIMPORTANT: You MUST use the file_read tool to read the file first before editing it. This ensures you have the exact text to match and understand the file's current state.\n\nUsage:\n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n\nNOTE: This tool is scoped to the execution workspace directory at /app/workspace/<execution-id>. All paths should be relative to this workspace root. Commands and file operations should stay within this directory as it represents the project boundary.",
    inputSchema: {
      filePath: z.string().describe("The path to the file to edit (relative to /app in container)"),
      oldString: z.string().describe("The exact text to replace"),
      newString: z.string().describe("The replacement text"),
      rationale: z.string().describe("Explanation of why you need to edit this file"),
      replaceAll: z.boolean().optional().default(false).describe("Whether to replace all occurrences (default: false)")
    }
  },
  async ({ filePath, oldString, newString, rationale, replaceAll = false }) => {
    if (oldString === newString) {
      return {
        content: [{
          type: "text" as const,
          text: "Error: oldString and newString must be different"
        }]
      };
    }

    await ensureWorkspaceExists();
    const workspacePath = getWorkspacePath();

    console.error(`Editing file: ${filePath}`);
    console.error(`Rationale: ${rationale}`);
    console.error(`Replacing "${oldString.substring(0, 100)}${oldString.length > 100 ? '...' : ''}" with "${newString.substring(0, 100)}${newString.length > 100 ? '...' : ''}"`);

    return new Promise((resolve) => {
      const bashProcess = spawn("bash", [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workspacePath
      });

      if (!bashProcess.stdin || !bashProcess.stdout || !bashProcess.stderr) {
        resolve({
          content: [{
            type: "text" as const,
            text: "Error: Failed to create process streams\nExit code: 1"
          }]
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let completed = false;
      const uniqueMarker = `__EDIT_END_${Date.now()}_${Math.random().toString(36).substring(2)}__`;

      const cleanup = () => {
        if (!completed) {
          completed = true;
          bashProcess.stdout?.removeAllListeners("data");
          bashProcess.stderr?.removeAllListeners("data");
          bashProcess.removeAllListeners("error");
          bashProcess.removeAllListeners("exit");
        }
      };

      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          bashProcess.kill();
          resolve({
            content: [{
              type: "text" as const,
              text: "Error: Edit operation timed out\nExit code: 1"
            }]
          });
        }
      }, 30000); // 30 second timeout

      bashProcess.on("error", (error) => {
        clearTimeout(timeoutId);
        cleanup();
        resolve({
          content: [{
            type: "text" as const,
            text: `Error spawning process: ${error.message}\nExit code: 1`
          }]
        });
      });

      bashProcess.on("exit", (code) => {
        if (!completed) {
          clearTimeout(timeoutId);
          cleanup();
          completed = true;
          
          const exitCode = code ?? 1;
          let result = "";
          
          if (stdout.trim() || stderr.trim()) {
            const cleanStdout = stdout.replace(new RegExp(`${uniqueMarker}.*`, 's'), '').trim();
            const cleanStderr = stderr.trim();
            
            if (cleanStdout && cleanStderr) {
              result = `STDOUT:\n${cleanStdout}\n\nSTDERR:\n${cleanStderr}`;
            } else if (cleanStdout) {
              result = cleanStdout;
            } else if (cleanStderr) {
              result = cleanStderr;
            }
          }
          
          if (exitCode === 0) {
            result = result || "File edited successfully";
          } else {
            result = result || "Edit operation failed";
          }
          
          result += `\nExit code: ${exitCode}`;
          
          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      });

      bashProcess.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        
        if (text.includes(uniqueMarker) && !completed) {
          bashProcess.stdin.end();
          
          clearTimeout(timeoutId);
          const parts = stdout.split(uniqueMarker);
          const exitCodeMatch = parts[1]?.match(/EXIT_CODE:(\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : 0;
          
          cleanup();
          completed = true;
          
          let result = "";
          const cleanStdout = parts[0].trim();
          const cleanStderr = stderr.trim();
          
          if (cleanStdout && cleanStderr) {
            result = `STDOUT:\n${cleanStdout}\n\nSTDERR:\n${cleanStderr}`;
          } else if (cleanStdout) {
            result = cleanStdout;
          } else if (cleanStderr) {
            result = cleanStderr;
          }
          
          if (exitCode === 0) {
            result = result || "File edited successfully";
          } else {
            result = result || "Edit operation failed";
          }
          
          result += `\nExit code: ${exitCode}`;
          
          resolve({
            content: [{
              type: "text" as const,
              text: result
            }]
          });
        }
      });

      bashProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Create a Python script for safe text replacement using base64 encoding
      const oldStringB64 = Buffer.from(oldString).toString('base64');
      const newStringB64 = Buffer.from(newString).toString('base64');

      // Create a Python-based script for robust text replacement
      const replaceScript = `
# Check if file exists
if [ ! -f "${filePath}" ]; then
  echo "Error: File ${filePath} not found"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
fi

# Check if file is readable
if [ ! -r "${filePath}" ]; then
  echo "Error: File ${filePath} is not readable"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
fi

# Create backup
cp "${filePath}" "${filePath}.backup" || {
  echo "Error: Could not create backup of ${filePath}"
  echo "${uniqueMarker}EXIT_CODE:1"
  exit 1
}

# Use Python for safe text replacement with base64 encoding
python3 -c "
import sys
import base64

try:
    # Read file content
    with open('${filePath}', 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Decode base64 strings
    old_string = base64.b64decode('${oldStringB64}').decode('utf-8')
    new_string = base64.b64decode('${newStringB64}').decode('utf-8')
    
    # Check if old string exists
    if old_string not in content:
        print('Error: String not found in file')
        sys.exit(1)
    
    # Perform replacement
    if ${replaceAll ? 'True' : 'False'}:
        new_content = content.replace(old_string, new_string)
    else:
        new_content = content.replace(old_string, new_string, 1)
    
    # Write back to file
    with open('${filePath}', 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    print('File edited successfully')
    sys.exit(0)
    
except Exception as e:
    print(f'Error: {e}')
    sys.exit(1)
" && {
  rm "${filePath}.backup"
  echo "${uniqueMarker}EXIT_CODE:0"
} || {
  echo "Error: Python replacement failed, restoring backup"
  mv "${filePath}.backup" "${filePath}"
  echo "${uniqueMarker}EXIT_CODE:1"
}
`;

      bashProcess.stdin.write(replaceScript);
    });
  }
);

/**
 * Configuration format for MCP server aggregation
 */
interface AggregatorConfig {
  servers: Record<string, ServerConfig>;
}

/**
 * Load MCP server configuration (baked into container at build time)
 */
async function loadAggregatorConfig(): Promise<AggregatorConfig> {
  const configPath = "/app/mcp-servers.json";

  try {
    const configData = await readFile(configPath, "utf-8");
    const config = JSON.parse(configData) as AggregatorConfig;

    console.error(`[Aggregator] Loaded config from ${configPath}`);
    console.error(
      `[Aggregator] Found ${Object.keys(config.servers).length} child server(s) configured`
    );

    return config;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      console.error(
        `[Aggregator] No config file found at ${configPath}, starting without child servers`
      );
    } else {
      console.error(`[Aggregator] Error loading config:`, error);
    }

    return { servers: {} };
  }
}

/**
 * Initialize all configured child MCP servers
 */
async function initializeChildServers(): Promise<void> {
  const config = await loadAggregatorConfig();

  const serverNames = Object.keys(config.servers);
  if (serverNames.length === 0) {
    console.error("[Aggregator] No child servers to initialize");
    return;
  }

  console.error(`[Aggregator] Initializing ${serverNames.length} child server(s)...`);

  // Start all servers in parallel
  const startPromises = serverNames.map(async (name) => {
    try {
      await childServerManager.startServer(name, config.servers[name]);
    } catch (error) {
      console.error(`[Aggregator] Failed to start ${name}, will continue without it`);
    }
  });

  await Promise.all(startPromises);

  const connectedCount = childServerManager.getConnectedServers().length;
  console.error(
    `[Aggregator] Successfully connected to ${connectedCount}/${serverNames.length} child server(s)`
  );
}

/**
 * Register aggregated tools from all child servers
 */
async function registerAggregatedTools(): Promise<void> {
  // Give child servers a moment to fully initialize
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.error("[Aggregator] Discovering tools from child servers...");

  const aggregatedTools = await childServerManager.aggregateTools();

  if (aggregatedTools.length === 0) {
    console.error("[Aggregator] No tools found from child servers");
    return;
  }

  console.error(
    `[Aggregator] Registering ${aggregatedTools.length} tool(s) from child servers`
  );

  // Register each aggregated tool with the main server
  for (const tool of aggregatedTools) {
    server.registerTool(
      tool.name, // Already namespaced as "serverName__toolName"
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema, // Now a proper Zod schema
      },
      async (args: any) => {
        // Route the tool call to the appropriate child server
        return await childServerManager.routeToolCall(tool.name, args);
      }
    );
  }

  console.error(`[Aggregator] Tool registration complete`);
}

async function main() {
  console.error('='.repeat(60));
  console.error('Docker MCP Server Starting');
  console.error('='.repeat(60));
  console.error(`Port: ${PORT}`);
  console.error(`Auth Token: ${AUTH_TOKEN}`);
  console.error('='.repeat(60));

  // Initialize child MCP servers
  await initializeChildServers();

  // Register tools from child servers
  await registerAggregatedTools();

  console.error('='.repeat(60));
  console.error('Server initialization complete');
  console.error('='.repeat(60));

  // Map to store transports by session ID
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Helper function to parse request body
  const parseBody = (req: http.IncomingMessage): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          if (body) {
            resolve(JSON.parse(body));
          } else {
            resolve(undefined);
          }
        } catch (error) {
          reject(new Error('Invalid JSON in request body'));
        }
      });
      req.on('error', reject);
    });
  };

  // Create HTTP server with authentication middleware
  const httpServer = http.createServer(async (req, res) => {
    console.error(`[DEBUG] HTTP request received: ${req.method} ${req.url}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Check bearer token authentication
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (token !== AUTH_TOKEN) {
      console.error(`Authentication failed: Invalid token from ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing bearer token' }));
      return;
    }

    // Handle MCP requests
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const executionId = req.headers['execution-id'] as string | undefined;

      // Log execution ID if provided
      if (executionId) {
        console.error(`[Execution-Id] Request scoped to workspace: /app/workspace/${executionId}`);
      }

      // For POST requests, parse the body
      let parsedBody: unknown = undefined;
      if (req.method === 'POST') {
        parsedBody = await parseBody(req);
      }

      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport for this session
        console.error(`Request for existing session: ${sessionId}`);
        transport = transports[sessionId];
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(parsedBody)) {
        // New initialization request - create new transport
        console.error('New initialization request - creating transport');
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            console.error(`Session initialized with ID: ${newSessionId}`);
            transports[newSessionId] = transport;
          }
        });

        // Set up onclose handler to clean up transport when closed
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            console.error(`Transport closed for session ${sid}, removing from transports map`);
            delete transports[sid];
          }
        };

        // Connect the transport to the MCP server BEFORE handling the request
        console.error('[DEBUG] Connecting transport to server...');
        await server.connect(transport);
        console.error('[DEBUG] Transport connected, handling request...');

        // Handle the request with the parsed body in the execution context
        await requestContext.run({ executionId }, async () => {
          await transport.handleRequest(req, res, parsedBody);
        });
        console.error('[DEBUG] handleRequest completed');
        return;
      } else {
        // Invalid request - no session ID or not initialization request
        console.error(`Invalid request: method=${req.method}, sessionId=${sessionId}, isInit=${parsedBody ? isInitializeRequest(parsedBody) : false}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided or not an initialization request',
          },
          id: null,
        }));
        return;
      }

      // Handle the request with existing transport in the execution context
      await requestContext.run({ executionId }, async () => {
        await transport.handleRequest(req, res, parsedBody);
      });
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        }));
      }
    }
  });

  // Start HTTP server
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.error('='.repeat(60));
    console.error(`Docker MCP Server started successfully`);
    console.error(`Listening on: http://0.0.0.0:${PORT}`);
    console.error(`Working directory: /app/workspace (scoped by Execution-Id header)`);
    console.error('='.repeat(60));
    console.error('');
    console.error('To connect, use the following configuration:');
    console.error(JSON.stringify({
      url: `http://localhost:${PORT}`,
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`
      }
    }, null, 2));
    console.error('='.repeat(60));
  });

  // Handle server shutdown
  process.on('SIGINT', async () => {
    console.error('Shutting down server...');

    // Shutdown all child servers
    await childServerManager.stopAll();

    // Close all active transports
    for (const sessionId in transports) {
      try {
        console.error(`Closing transport for session ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    console.error('Server shutdown complete');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});