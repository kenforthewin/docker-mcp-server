#!/usr/bin/env bash

echo "=== Resetting Docker MCP Server ==="
echo ""

echo "1. Stopping existing container..."
docker-compose down

echo ""
echo "2. Cleaning workspace directory..."
rm -rf tmp && mkdir tmp

echo ""
echo "3. Rebuilding container with latest code..."
docker-compose build

echo ""
echo "4. Starting container..."
docker-compose up -d

echo ""
echo "5. Waiting for server to start..."
sleep 3

echo ""
echo "=== Docker MCP Server Reset Complete ==="
echo ""
echo "Container is running. View logs with:"
echo "  docker-compose logs -f"
echo ""
echo "Or connect to shell with:"
echo "  docker exec -it mcp-container bash"
echo ""
echo "Check server status:"
docker-compose ps
