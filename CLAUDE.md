# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Docker Operations
- `npm run docker:build` - Build the Docker image with server code
- `npm run docker:up` - Start the containerized MCP server
- `npm run docker:down` - Stop and remove the container
- `npm run docker:logs` - View server logs (follow mode)
- `npm run docker:restart` - Rebuild and restart the container
- `npm run docker:shell` - Open bash shell in running container
- `./reset-docker.sh` - Complete reset (stop, clean workspace, rebuild, start)

### Local Development
- `npm run build` - Compile TypeScript to JavaScript in `/dist`
- `npm install` - Install dependencies

## High-Level Architecture

This is an **MCP (Model Context Protocol) Server** that runs entirely inside a Docker container and provides command execution capabilities. The server is exposed via HTTP with bearer token authentication.

### Core Components

1. **MCP Server** (`src/index.ts`) - TypeScript server using `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`
2. **HTTP Transport** - Network-based communication on port 3000
3. **Bearer Token Auth** - Secure authentication for all requests
4. **Docker Container** - Debian-based container with Node.js, Playwright, and the MCP server
5. **Workspace Mount** - Host `./tmp` directory mounted to container `/app/workspace` for persistent file storage
6. **Process Management** - Tracks background processes with unique IDs and timeouts

### Container Environment
- **Base Image**: `node:current-bookworm` (Debian with current Node.js)
- **Additional Tools**: git, xdg-utils, jq, python3, Playwright with dependencies
- **Server Location**: `/app` (contains built MCP server code)
- **Working Directory**: `/app/workspace` (mounted from host `./tmp`)
- **Exposed Port**: 3000 (mapped to host port 3000)
- **Container Name**: `mcp-container`

### Architecture Changes from Previous Version

**OLD (Host-Based):**
- MCP server ran on host machine
- Used stdio transport (stdin/stdout)
- Commands executed via `docker exec` into separate container
- Container only provided execution environment

**NEW (Container-Based):**
- MCP server runs inside container
- Uses HTTP transport with bearer token auth
- Commands execute directly (no docker exec overhead)
- Container is self-contained and network-accessible
- Accessible at `http://localhost:3000`

## MCP Tools Available

### Command Execution
- **`execute_command`** - Execute shell commands directly in container with process tracking
- **`check_process`** - Monitor background processes by ID
- **`send_input`** - Send input to running processes

### File Operations
- **`file_read`** - Read files from `/app/workspace` with line offset/limit support
- **`file_write`** - Create/overwrite files (requires prior read)
- **`file_edit`** - Exact string replacement edits (requires prior read)
- **`file_ls`** - List directory contents with ignore patterns
- **`file_grep`** - Search file contents with regex support

All file operations work within `/app/workspace` which is mounted from host `./tmp`.

## MCP Server Aggregation

This server acts as an **aggregator** that can run multiple child MCP servers inside the container and expose all their tools as a unified interface. This allows you to combine specialized MCP servers (like Playwright, filesystem, git, etc.) with the native tools.

### Configuration

Create a file named `mcp-servers.json` in the repository root (same directory as `Dockerfile.debian`) to define child servers. This file is copied into the container at build time:

```json
{
  "servers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@automatalabs/mcp-server-playwright"],
      "env": {
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/app/workspace"]
    }
  }
}
```

**Config Options:**
- `command`: Executable to run (e.g., "npx", "node", "python")
- `args`: Command-line arguments (optional)
- `env`: Environment variables (optional)

### Tool Namespacing

Tools from child servers are namespaced to avoid conflicts:
- **Native tools**: `execute_command`, `file_read`, etc. (unchanged)
- **Child server tools**: `serverName:toolName`
  - Example: `playwright:screenshot`, `playwright:navigate`
  - Example: `filesystem:read_file`, `filesystem:write_file`

### How It Works

1. **Startup**: Server loads config and spawns child MCP servers as subprocesses
2. **Discovery**: Connects to each child via stdio transport and discovers their tools
3. **Registration**: All tools are registered with the main server with namespaced names
4. **Routing**: When a tool is called, the aggregator routes it to the appropriate child server
5. **Results**: Results are returned through the main server to the client

### Error Handling

- **Missing config**: Server starts normally with native tools only
- **Failed child servers**: Server continues without them, logs errors
- **Child server crashes**: Automatic restart with exponential backoff (max 3 attempts)
- **Tool call errors**: Returns helpful error messages, doesn't crash the aggregator

### Example Child Servers

**Playwright** (browser automation):
```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@automatalabs/mcp-server-playwright"]
}
```

**Filesystem** (file operations):
```json
"filesystem": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/app/workspace"]
}
```

**Git** (version control):
```json
"git": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "/app/workspace"]
}
```

**Fetch** (HTTP requests):
```json
"fetch": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-fetch"]
}
```

See `./mcp-servers.json.example` for a complete example configuration.

**Note**: Changes to the config file require rebuilding the container with `npm run docker:restart` since the config is baked into the image at build time.

## Process Management System

Commands run with intelligent timeout handling:
- **Default timeout**: 20 seconds of inactivity before backgrounding
- **Maximum timeout**: 10 minutes absolute limit
- **Process tracking**: Background processes get unique IDs for monitoring
- **Smart waiting**: Based on output activity rather than fixed intervals

## Authentication

The server requires bearer token authentication on all requests:
- Token is auto-generated on startup (logged to console)
- Can be specified with `--token` flag when starting server
- Required in `Authorization` header: `Bearer <token>`
- Displayed in startup logs with connection configuration

## Workspace Scoping (Execution-Id)

The server supports workspace isolation through an optional `Execution-Id` header. This allows multiple clients or sessions to maintain separate workspaces within the same container.

### How It Works

**Without Execution-Id:**
- All operations execute in `/app/workspace` (default)
- Files and commands use the shared workspace

**With Execution-Id:**
- Set the `Execution-Id` header on HTTP requests
- All operations are automatically scoped to `/app/workspace/<execution-id>`
- The scoped directory is created automatically on first use
- Each execution ID gets its own isolated workspace

### Example Usage

```bash
# Request with Execution-Id header
curl -X POST http://localhost:3000 \
  -H "Authorization: Bearer <token>" \
  -H "Execution-Id: my-session-123" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "tools/call", ...}'
```

### Affected Operations

All workspace operations respect the Execution-Id scoping:
- **Command execution**: `execute_command` runs in scoped directory
- **File operations**: `file_read`, `file_write`, `file_edit` operate on scoped paths
- **Directory operations**: `file_ls` lists scoped directory contents
- **Search operations**: `file_grep` searches within scoped workspace

### Use Cases

- **Multi-tenant environments**: Isolate different users or projects
- **Parallel testing**: Run tests in isolated environments simultaneously
- **Session management**: Maintain separate state for different client sessions
- **CI/CD pipelines**: Separate workspace for each build/deployment

## Key Implementation Details

### TypeScript Configuration
- Target: ES2022 with ESNext modules
- Output: `./dist` directory
- Source maps and declarations enabled
- Strict type checking

### Docker Build Process
1. Container builds from `Dockerfile.debian`
2. Copies source code (`package.json`, `tsconfig.json`, `src/`) into container
3. Copies `mcp-servers.json` config file (if present) into container
4. Runs `npm install` and `npm run build` inside container
5. Creates `/app/workspace` directory
6. Exposes port 3000
7. Starts server with `node dist/index.js --port 3000`

### Container Startup
1. Server starts and binds to `0.0.0.0:3000`
2. Generates authentication token (or uses provided token)
3. Logs connection details including:
   - Port number
   - Authentication token
   - Example client configuration
4. Waits for HTTP requests with bearer token auth

### File Tool Safety
- All file operations require rationale parameter for traceability
- Write/edit operations require reading file first to understand context
- Base64 encoding used for safe text replacement in edit operations
- Automatic backup creation during edit operations
- All paths are relative to `/app/workspace`

## Client Configuration

To connect to the MCP server, clients need:

```json
{
  "url": "http://localhost:3000",
  "headers": {
    "Authorization": "Bearer <token-from-logs>"
  }
}
```

**Optional: Add workspace scoping**
```json
{
  "url": "http://localhost:3000",
  "headers": {
    "Authorization": "Bearer <token-from-logs>",
    "Execution-Id": "unique-session-id"
  }
}
```

The exact token is displayed in the container logs on startup. View with:
```bash
npm run docker:logs
```

## Examples Directory Structure

The `/examples` directory contains various AI model implementations of games (primarily Minesweeper), useful for understanding different AI coding approaches and testing the MCP server capabilities.

## Working with this Codebase

1. **Start Development**: Run `./reset-docker.sh` to ensure clean environment
2. **Make Code Changes**: Edit TypeScript files in `src/`
3. **Rebuild**: Run `npm run docker:restart` to rebuild and restart with changes
4. **View Logs**: Use `npm run docker:logs` to see server output and auth token
5. **Test Tools**: Connect MCP client using URL and token from logs
6. **File Operations**: Always read files before editing to understand current state
7. **Debug**: Use `npm run docker:shell` to access container bash

## Container Lifecycle

The Docker container is self-contained and includes the MCP server:
- Builds with server code included
- Starts automatically with `docker-compose up`
- Runs server process (`node dist/index.js`)
- Exposes port 3000 for network access
- Workspace at `/app/workspace` persists via volume mount
- Container restart requires rebuild to include code changes
- Use `reset-docker.sh` for complete clean restart

## Troubleshooting

**Server won't start:**
- Check logs: `npm run docker:logs`
- Verify port 3000 is not in use on host
- Rebuild: `npm run docker:restart`

**Can't connect to server:**
- Verify container is running: `docker ps | grep mcp-container`
- Check token in logs: `npm run docker:logs`
- Ensure using correct URL: `http://localhost:3000`
- Verify bearer token in Authorization header

**Code changes not reflected:**
- Remember: must rebuild container with `npm run docker:restart`
- Check build output for TypeScript errors
- Verify changes were saved before rebuild
