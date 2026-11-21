import readline from 'node:readline';

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export class McpStdioServer {
  constructor({ name, version }) {
    this.serverInfo = { name, version };
    this.tools = new Map();
    this.resources = new Map();
  }

  registerTool(definition, handler) {
    this.tools.set(definition.name, { definition, handler });
  }

  registerResource(definition, handler) {
    this.resources.set(definition.uri, { definition, handler });
  }

  writeMessage(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  writeError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    this.writeMessage({ jsonrpc: '2.0', id, error });
  }

  writeResult(id, result) {
    this.writeMessage({ jsonrpc: '2.0', id, result });
  }

  async handleRequest(msg) {
    const { id, method, params } = msg;

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return;
    }

    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];

      this.writeResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: this.serverInfo,
      });
      return;
    }

    if (method === 'ping') {
      this.writeResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      const tools = Array.from(this.tools.values()).map(({ definition }) => definition);
      this.writeResult(id, { tools });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const entry = this.tools.get(toolName);
      if (!entry) {
        this.writeError(id, -32602, `Unknown tool: ${String(toolName)}`);
        return;
      }

      try {
        const result = await entry.handler(params?.arguments ?? {});
        this.writeResult(id, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.writeResult(id, {
          isError: true,
          content: [{ type: 'text', text: message }],
          structuredContent: { ok: false, error: message },
        });
      }
      return;
    }

    if (method === 'resources/list') {
      const resources = Array.from(this.resources.values()).map(({ definition }) => definition);
      this.writeResult(id, { resources });
      return;
    }

    if (method === 'resources/templates/list') {
      this.writeResult(id, { resourceTemplates: [] });
      return;
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      const entry = this.resources.get(uri);
      if (!entry) {
        this.writeError(id, -32002, `Resource not found: ${String(uri)}`);
        return;
      }
      try {
        const contents = await entry.handler(uri);
        this.writeResult(id, { contents });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.writeError(id, -32603, `Failed to read resource ${uri}: ${message}`);
      }
      return;
    }

    if (id !== undefined) {
      this.writeError(id, -32601, `Method not found: ${String(method)}`);
    }
  }

  start() {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (err) {
        this.writeError(null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      if (!msg || typeof msg !== 'object') {
        this.writeError(null, -32600, 'Invalid JSON-RPC request');
        return;
      }

      try {
        await this.handleRequest(msg);
      } catch (err) {
        if (msg.id !== undefined) {
          this.writeError(
            msg.id,
            -32603,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    });

    rl.on('close', () => {
      process.exit(0);
    });
  }
}
