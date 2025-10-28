# Docker MCP Server

A Model Context Protocol (MCP) server that runs entirely inside a Docker container, providing secure command execution and file operations through HTTP with bearer token authentication.

## 🚀 Features

- **Containerized MCP Server**: Runs entirely inside Docker with no host dependencies
- **HTTP Transport**: Network-based communication with bearer token authentication
- **Secure Command Execution**: Run shell commands in isolated container environment
- **File Operations**: Read, write, edit, and search files within container workspace
- **Process Management**: Track long-running processes with unique IDs
- **Interactive Input**: Send input to running processes
- **Smart Timeouts**: Intelligent process timeout handling based on output activity

## 🏗️ Architecture

The MCP server runs inside a Docker container and communicates with clients over HTTP:

```
MCP Client (via HTTP) ↔ Docker Container (Port 3000)
                              ↓
                        MCP Server (Node.js)
                              ↓
                    Workspace (/app/workspace)
                              ↓
                    Host ./tmp directory (mounted)
```

### Core Components

- **Containerized MCP Server** - TypeScript server using `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`
- **HTTP API** - Network-based communication on port 3000
- **Bearer Token Auth** - Secure authentication for all requests
- **Docker Container** - Debian-based with Node.js, Playwright, and development tools
- **Workspace Mount** - Host `./tmp` directory mounted to `/app/workspace`
- **Process Tracking** - Background process management with unique IDs

### Key Differences from Traditional MCP Servers

- **No Host Installation**: Server runs entirely in container
- **Network Access**: HTTP-based instead of stdio transport
- **Authentication Required**: Bearer token for all requests
- **Self-Contained**: All dependencies bundled in container image
- **Direct Execution**: No docker exec overhead

## 📋 Prerequisites

- [Docker](https://www.docker.com/get-started) installed and running
- [Docker Compose](https://docs.docker.com/compose/install/) for container management
- [Node.js](https://nodejs.org/) (v18 or higher) for local development only

## 🚀 Quick Start

### 1. Clone and Setup

```bash
git clone <your-repository-url>
cd docker-mcp
```

### 2. Start the Server

```bash
# Quick start: reset environment and start server
./reset-docker.sh

# Or manually:
npm run docker:build    # Build container with server code
npm run docker:up       # Start container
npm run docker:logs     # View logs and get auth token
```

### 3. Get Connection Info

The server logs display the authentication token and connection details:

```bash
npm run docker:logs
```

Look for output like:
```
============================================================
Docker MCP Server Starting
============================================================
Port: 3000
Auth Token: abc123-def456-ghi789
============================================================
```

### 4. Test Connection

```bash
# Test with curl
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
     http://localhost:3000

# View server logs
npm run docker:logs
```

## 🔧 Development Commands

### Docker Operations

```bash
# Build the container image with server code
npm run docker:build

# Start the containerized MCP server
npm run docker:up

# Stop the container
npm run docker:down

# View server logs (includes auth token)
npm run docker:logs

# Rebuild and restart (after code changes)
npm run docker:restart

# Open bash shell in container
npm run docker:shell

# Complete reset (clean workspace and rebuild)
./reset-docker.sh
```

### Local Development

```bash
# Build TypeScript (for development/testing only)
npm run build

# Install/update dependencies
npm install
```

## ⚙️ MCP Client Configuration

### Configuration Format

MCP clients need to connect via HTTP with bearer token authentication:

```json
{
  "url": "http://localhost:3000",
  "headers": {
    "Authorization": "Bearer YOUR_TOKEN_FROM_LOGS"
  }
}
```

**Important:**
- Get the auth token from container logs: `npm run docker:logs`
- Token is auto-generated on each container start
- Token must be included in the `Authorization` header with `Bearer ` prefix

### Claude Desktop Configuration

Add to your Claude Desktop configuration file:

**Location:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "docker-mcp": {
      "url": "http://localhost:3000",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_FROM_LOGS"
      }
    }
  }
}
```

**Note:** Replace `YOUR_TOKEN_FROM_LOGS` with the actual token from `npm run docker:logs`

### Getting Your Authentication Token

1. Start the server: `npm run docker:up`
2. View logs: `npm run docker:logs`
3. Copy the token from the output
4. Update your client configuration with the token
5. Restart your MCP client

### Verification

After configuration:
1. Restart your MCP client (e.g., Claude Desktop)
2. Check that the Docker MCP server shows as connected
3. Verify access to all available tools

## 🛠️ Available MCP Tools

### 🚀 Command Execution

#### `execute_command`
**Execute shell commands inside the container**

Execute any shell command within the container environment with intelligent process tracking.

**Parameters:**
- `command` (string) - The shell command to execute
- `rationale` (string) - Explanation of why this command is being executed
- `maxWaitTime` (number, optional) - Maximum seconds to wait before returning (default: 20)

**Features:**
- Automatic backgrounding for long-running processes
- Smart timeout based on output activity
- Process ID returned for monitoring
- Real-time output capture

#### `check_process`
**Monitor background processes by ID**

Check the status and output of background processes started by `execute_command`.

**Parameters:**
- `processId` (string) - The process ID returned by a long-running command
- `rationale` (string) - Explanation of why you need to check this process

**Returns:**
- Process status (running/completed)
- Current output (stdout/stderr)
- Exit code (if completed)
- Runtime duration

#### `send_input`
**Send input to running background processes**

Send input data to interactive processes waiting for user input.

**Parameters:**
- `processId` (string) - The process ID of the running process
- `input` (string) - The input to send to the process
- `rationale` (string) - Explanation of why you need to send input
- `autoNewline` (boolean, optional) - Auto-add newline (default: true)

### 📁 File Operations

All file operations work within `/app/workspace` which is mounted from host `./tmp`.

#### `file_read`
**Read files from container filesystem**

Read file contents with support for large files through pagination.

**Parameters:**
- `filePath` (string) - Path relative to `/app/workspace`
- `rationale` (string) - Explanation of why you need to read this file
- `offset` (number, optional) - Starting line number (default: 0)
- `limit` (number, optional) - Maximum lines to read (default: 2000)

#### `file_write`
**Create or overwrite files**

Write content to files with automatic directory creation.

**Parameters:**
- `filePath` (string) - Path relative to `/app/workspace`
- `content` (string) - The content to write
- `rationale` (string) - Explanation of why you need to write this file

**Important:** Use `file_read` first to understand current state.

#### `file_edit`
**Perform exact string replacements**

Edit files using precise string matching with backup protection.

**Parameters:**
- `filePath` (string) - Path relative to `/app/workspace`
- `oldString` (string) - The exact text to replace
- `newString` (string) - The replacement text
- `rationale` (string) - Explanation of why you need to edit this file
- `replaceAll` (boolean, optional) - Replace all occurrences (default: false)

**Important:** Use `file_read` first to get the exact text to match.

#### `file_ls`
**List directory contents**

List files and directories with intelligent filtering.

**Parameters:**
- `path` (string, optional) - Directory path (default: current directory)
- `rationale` (string) - Explanation of why you need to list this directory
- `ignore` (array, optional) - Glob patterns to ignore

#### `file_grep`
**Search file contents**

Search for patterns in files using grep with regex support.

**Parameters:**
- `pattern` (string) - Search pattern (supports regex)
- `rationale` (string) - Explanation of why you need to search
- `path` (string, optional) - Directory to search (default: current)
- `include` (string, optional) - File pattern filter (e.g., '*.js')
- `caseInsensitive` (boolean, optional) - Case insensitive (default: false)
- `maxResults` (number, optional) - Result limit (default: 100)

## 📊 Process Management

Commands run with intelligent timeout handling:

- **Default timeout**: 20 seconds of inactivity before backgrounding
- **Maximum timeout**: 10 minutes absolute limit
- **Process tracking**: Background processes get unique IDs for monitoring
- **Smart waiting**: Based on output activity, not fixed intervals

### Example Process Flow

```javascript
// Long-running command gets backgrounded automatically
const result1 = execute_command({
  command: "npm install",
  rationale: "Installing dependencies"
});
// Returns process ID if backgrounded

// Check status later
const result2 = check_process({
  processId: result1.processId,
  rationale: "Checking installation progress"
});

// Send input to interactive processes
send_input({
  processId: result1.processId,
  input: "y",
  rationale: "Confirming prompt"
});
```

## 🔒 Security Considerations

### Authentication

- **Bearer Token Required**: All requests must include valid bearer token
- **Auto-Generated Token**: New token generated on each container start
- **Token Rotation**: Restart container to generate new token
- **CORS Enabled**: Allows cross-origin requests (consider restricting in production)

### Container Isolation

- **Network Isolation**: Container exposed only on port 3000
- **Workspace Mount**: Only `./tmp` directory accessible from host
- **User Permissions**: Commands run with container-level permissions
- **No Host Access**: Server cannot access host filesystem outside mount

### Recommended Security Practices

1. **Token Management**: Keep authentication tokens secure and private
2. **Network Restrictions**: Use firewall rules to limit access to port 3000
3. **Workspace Isolation**: Regularly audit `./tmp` directory contents
4. **Resource Limits**: Add CPU and memory constraints in docker-compose.yml
5. **Access Logs**: Monitor container logs for suspicious activity

## 🚨 Troubleshooting

### Server Won't Start

```bash
# Check Docker is running
docker info

# View container logs for errors
npm run docker:logs

# Verify port 3000 is available
lsof -i :3000  # macOS/Linux
netstat -ano | findstr :3000  # Windows

# Complete reset
npm run docker:down
./reset-docker.sh
```

### Can't Connect to Server

```bash
# Verify container is running
docker ps | grep mcp-container

# Check server logs for auth token
npm run docker:logs

# Ensure correct URL
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000

# Restart container
npm run docker:restart
```

### Code Changes Not Reflected

```bash
# Remember: server code is built into container image
# After changing TypeScript code, you MUST rebuild:
npm run docker:restart

# Or manually:
npm run docker:down
npm run docker:build
npm run docker:up
```

### Authentication Failed

```bash
# Get current auth token from logs
npm run docker:logs

# Verify token format in client config
# Must be: "Bearer YOUR_TOKEN" (with "Bearer " prefix)

# Token changes on restart - update client config
```

### Permission Errors in Workspace

```bash
# Ensure tmp directory exists and is writable
mkdir -p tmp
chmod 755 tmp

# Reset workspace
rm -rf tmp && mkdir tmp
```

### Process Timeout Issues

- Increase `maxWaitTime` parameter in `execute_command`
- Use `check_process` to monitor long-running operations
- Break complex operations into smaller steps
- Check container resources: `docker stats mcp-container`

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes in `src/`
4. Test with `npm run docker:restart`
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Add comprehensive error handling
- Include rationale parameters for all tool operations
- Test with both quick and long-running commands
- Document any new MCP tools or capabilities
- Test authentication and security features

## 📦 Deployment

### Local Deployment

```bash
# Production deployment
docker-compose up -d

# View production logs
docker-compose logs -f mcp-container

# Auto-restart on failure
# (already configured with restart: unless-stopped)
```

### Custom Configuration

```yaml
# docker-compose.yml
services:
  mcp-container:
    environment:
      - NODE_ENV=production
      - AUTH_TOKEN=your-custom-token  # Optional: set custom token
    ports:
      - "3000:3000"  # Change port mapping if needed
    volumes:
      - ./custom-workspace:/app/workspace
```

### Environment Variables

- `NODE_ENV`: Set to `production` for production deployment
- Port: Configure via CLI flag `--port 3000`
- Token: Set via CLI flag `--token your-token` (auto-generated if not set)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙋‍♂️ Support

- 🐛 **Bug Reports**: Open an issue with detailed reproduction steps
- 💡 **Feature Requests**: Open an issue with your use case
- 📖 **Documentation**: Check `CLAUDE.md` for AI assistant specific guidance
- 💬 **Questions**: Open a discussion for general questions

## 📚 Additional Resources

- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Docker Documentation](https://docs.docker.com/)

---

**Built for the Model Context Protocol ecosystem** 🤖

**Features:**
- ✅ HTTP Transport with Bearer Token Auth
- ✅ Containerized Architecture
- ✅ Process Management
- ✅ File Operations
- ✅ Network Accessible
- ✅ Production Ready
