#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NPM_REGISTRIES,
  installPlugin,
  previewPluginSource,
} from './installer.mjs';
import { McpStdioServer } from './mcp-stdio.mjs';
import {
  InstallRegistry,
  listInstalledPlugins,
  registryKey,
  uninstallPlugin,
} from './plugins.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DEFAULT_APP_HTML = path.join(PLUGIN_ROOT, 'assets', 'app.html');
const APP_URI = 'ui://plugin-installer/app.html';

function parseCliArgs(argv) {
  let dataDir = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    }
  }
  return { dataDir };
}

const { dataDir } = parseCliArgs(process.argv.slice(2));
const installRegistry = new InstallRegistry(dataDir || process.env.PLUGIN_DATA || '');

const server = new McpStdioServer({
  name: 'plugin-installer',
  version: '1.0.0',
});

// UI Resource
server.registerResource(
  {
    uri: APP_URI,
    name: 'Plugin Installer App',
    description: 'Interactive UI for installing and managing Antigravity plugins.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async (uri) => {
    const htmlPath = process.env.PLUGIN_INSTALLER_APP_HTML || DEFAULT_APP_HTML;
    const html = await fs.readFile(htmlPath, 'utf8');
    return [
      {
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: html,
      },
    ];
  },
);

// Primary entrypoint tool (Global sidebar page + Side aux pane + Model-callable)
server.registerTool(
  {
    name: 'open_plugin_installer',
    title: 'Plugin Installer',
    description:
      'Open the Plugin Installer UI to browse installed plugins and install new plugins from GitHub URLs, npm packages, or local directories.',
    inputSchema: {
      type: 'object',
      properties: {
        initialSource: {
          type: 'string',
          description: 'Optional GitHub URL, npm package name, or local path to pre-fill in the Install Plugin modal.',
        },
        openModal: {
          type: 'boolean',
          description: 'Whether to open the Install Plugin dialog immediately.',
        },
        workspacePath: {
          type: 'string',
          description: 'Optional workspace root path to also inspect workspace-scoped plugins.',
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: APP_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'global', title: 'Plugin Installer' },
          { type: 'aux_pane', title: 'Plugin Installer' },
        ],
      },
    },
  },
  async (args = {}) => {
    const workspacePath = typeof args.workspacePath === 'string' ? args.workspacePath : '';
    const inventory = await listInstalledPlugins({ registry: installRegistry, workspacePath });

    return {
      content: [
        {
          type: 'text',
          text: `Opened Plugin Installer (${inventory.counts.global} global, ${inventory.counts.builtin} built-in${
            inventory.counts.workspace ? `, ${inventory.counts.workspace} workspace` : ''
          } plugins).`,
        },
      ],
      structuredContent: {
        view: 'manager',
        initialSource: typeof args.initialSource === 'string' ? args.initialSource : '',
        openModal: Boolean(args.openModal || args.initialSource),
        workspacePath,
        registries: NPM_REGISTRIES,
        platform: process.platform,
        ...inventory,
      },
    };
  },
);

// Model-callable direct install tool (also renders the MCP App inline with the result)
server.registerTool(
  {
    name: 'install_plugin',
    title: 'Install Plugin',
    description:
      'Install an Antigravity plugin from a GitHub repository URL, an npm package name, or a local directory path.',
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source: {
          type: 'string',
          description: 'GitHub URL (https://github.com/owner/repo), npm package name (@scope/pkg), or local directory path.',
        },
        sourceType: {
          type: 'string',
          enum: ['auto', 'github', 'npm', 'local'],
          description: 'Optional explicit source type; defaults to auto detection.',
        },
        registry: {
          type: 'string',
          description: 'npm registry preset ("official", "npmmirror") or custom https:// registry URL.',
        },
        ref: {
          type: 'string',
          description: 'Optional Git branch, tag, or commit ref for GitHub repositories.',
        },
        subpath: {
          type: 'string',
          description: 'Optional subdirectory inside a repository or package containing plugin.json.',
        },
        mode: {
          type: 'string',
          enum: ['copy', 'link'],
          description: 'For local directory sources: "copy" files (default) or create a symlink/junction ("link").',
        },
        scope: {
          type: 'string',
          enum: ['global', 'workspace'],
          description: 'Install globally (~/.gemini/config/plugins) or to a workspace (.agents/plugins).',
        },
        workspacePath: {
          type: 'string',
          description: 'Workspace root path (required when scope is "workspace").',
        },
        targetDirName: {
          type: 'string',
          description: 'Optional custom directory name under the plugins root.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite an existing plugin with the same directory name.',
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: APP_URI },
    },
  },
  async (args = {}) => {
    const installResult = await installPlugin({
      ...args,
      installRegistry,
    });
    const workspacePath = args.scope === 'workspace' && args.workspacePath ? args.workspacePath : '';
    const inventory = await listInstalledPlugins({ registry: installRegistry, workspacePath });

    return {
      content: [
        {
          type: 'text',
          text: `Installed plugin "${installResult.plugin.displayName}" (${installResult.plugin.dir}) to ${installResult.plugin.path}. Manage it in Customizations: [${installResult.plugin.displayName}](customization://${installResult.plugin.dir})`,
        },
      ],
      structuredContent: {
        view: 'manager',
        lastInstall: installResult,
        workspacePath,
        registries: NPM_REGISTRIES,
        platform: process.platform,
        ...inventory,
      },
    };
  },
);

// App-only tools (invisible to the model, callable directly from the UI via app.callServerTool)
const APP_ONLY_META = { ui: { visibility: ['app'] } };

server.registerTool(
  {
    name: 'app_list_plugins',
    title: 'List Installed Plugins',
    description: 'Refresh the list of installed Antigravity plugins.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    const workspacePath = typeof args.workspacePath === 'string' ? args.workspacePath : '';
    const inventory = await listInstalledPlugins({ registry: installRegistry, workspacePath });
    return {
      content: [{ type: 'text', text: `Found ${inventory.counts.total} plugins.` }],
      structuredContent: {
        ok: true,
        workspacePath,
        registries: NPM_REGISTRIES,
        platform: process.platform,
        ...inventory,
      },
    };
  },
);

server.registerTool(
  {
    name: 'app_preview_source',
    title: 'Preview Plugin Source',
    description: 'Parse and preview a plugin source string before installing.',
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source: { type: 'string' },
        sourceType: { type: 'string', enum: ['auto', 'github', 'npm', 'local'] },
        ref: { type: 'string' },
        subpath: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    const preview = await previewPluginSource(args);
    return {
      content: [{ type: 'text', text: `Detected ${preview.parsed.type}: ${preview.parsed.displaySource}` }],
      structuredContent: preview,
    };
  },
);

server.registerTool(
  {
    name: 'app_install_plugin',
    title: 'Install Plugin (App)',
    description: 'Execute plugin installation from the MCP App UI.',
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source: { type: 'string' },
        sourceType: { type: 'string', enum: ['auto', 'github', 'npm', 'local'] },
        registry: { type: 'string' },
        ref: { type: 'string' },
        subpath: { type: 'string' },
        mode: { type: 'string', enum: ['copy', 'link'] },
        scope: { type: 'string', enum: ['global', 'workspace'] },
        workspacePath: { type: 'string' },
        targetDirName: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    try {
      const result = await installPlugin({
        ...args,
        installRegistry,
      });
      const workspacePath = args.scope === 'workspace' && args.workspacePath ? args.workspacePath : '';
      const inventory = await listInstalledPlugins({ registry: installRegistry, workspacePath });

      return {
        content: [{ type: 'text', text: `Installed ${result.plugin.displayName}` }],
        structuredContent: {
          ok: true,
          install: result,
          inventory,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: false,
        content: [{ type: 'text', text: message }],
        structuredContent: {
          ok: false,
          error: message,
          code: err?.code || 'INSTALL_FAILED',
          existingDir: err?.existingDir || null,
        },
      };
    }
  },
);

server.registerTool(
  {
    name: 'app_uninstall_plugin',
    title: 'Uninstall Plugin (App)',
    description: 'Uninstall a user-installed plugin directory.',
    inputSchema: {
      type: 'object',
      required: ['dir'],
      properties: {
        dir: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'workspace'] },
        workspacePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    try {
      const removed = await uninstallPlugin({
        dir: args.dir,
        scope: args.scope || 'global',
        workspacePath: args.workspacePath || '',
        registry: installRegistry,
      });
      const inventory = await listInstalledPlugins({
        registry: installRegistry,
        workspacePath: args.workspacePath || '',
      });
      return {
        content: [{ type: 'text', text: `Uninstalled ${removed.dir}` }],
        structuredContent: {
          ok: true,
          removed,
          inventory,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: false,
        content: [{ type: 'text', text: message }],
        structuredContent: {
          ok: false,
          error: message,
        },
      };
    }
  },
);

server.registerTool(
  {
    name: 'app_reinstall_plugin',
    title: 'Reinstall Plugin (App)',
    description: 'Reinstall or update a previously installed plugin from its recorded source.',
    inputSchema: {
      type: 'object',
      required: ['dir'],
      properties: {
        dir: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'workspace'] },
        workspacePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    try {
      const scope = args.scope || 'global';
      const workspacePath = args.workspacePath || '';
      const entries = await installRegistry.readAll();
      const record = entries[registryKey(scope, args.dir, workspacePath)];
      if (!record || !record.rawSource) {
        throw new Error(`No saved source metadata found for "${args.dir}".`);
      }

      const result = await installPlugin({
        source: record.rawSource,
        sourceType: record.sourceType || 'auto',
        registry: record.registry || 'official',
        ref: record.ref || '',
        subpath: record.subpath || '',
        mode: record.mode || 'copy',
        scope,
        workspacePath,
        targetDirName: args.dir,
        overwrite: true,
        installRegistry,
      });

      const inventory = await listInstalledPlugins({ registry: installRegistry, workspacePath });
      return {
        content: [{ type: 'text', text: `Updated ${result.plugin.displayName}` }],
        structuredContent: {
          ok: true,
          install: result,
          inventory,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: false,
        content: [{ type: 'text', text: message }],
        structuredContent: {
          ok: false,
          error: message,
        },
      };
    }
  },
);

server.start();
