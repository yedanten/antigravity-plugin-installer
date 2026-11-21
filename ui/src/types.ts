export type Locale = 'zh' | 'en';
export type SourceType = 'auto' | 'github' | 'npm' | 'local';
export type ResolvedSourceType = 'github' | 'npm' | 'local';
export type InstallScope = 'global' | 'workspace';
export type LocalInstallMode = 'copy' | 'link';

export interface PluginComponents {
  skills: string[];
  mcpServers: string[];
  agents: string[];
  rules: string[];
  hasHooks: boolean;
}

export interface InstallMeta {
  dir: string;
  name: string;
  displayName: string;
  version: string;
  sourceType: ResolvedSourceType;
  rawSource: string;
  displaySource: string;
  registry?: string;
  ref?: string;
  subpath?: string;
  mode?: LocalInstallMode;
  scope: InstallScope;
  workspacePath?: string;
  installedAt?: string;
  updatedAt?: string;
}

export interface PluginItem {
  id: string;
  dir: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  homepage: string;
  repository: string;
  scope: 'global' | 'workspace' | 'builtin';
  path: string;
  enabled: boolean;
  isBuiltin: boolean;
  isSymlink: boolean;
  linkTarget: string | null;
  logoDataUri: string | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
  components: PluginComponents;
  installMeta: InstallMeta | null;
  canUninstall: boolean;
  canReinstall: boolean;
}

export interface InventoryPayload {
  plugins: PluginItem[];
  paths: {
    globalDir: string;
    builtinDir: string;
    workspaceDir: string | null;
  };
  counts: {
    total: number;
    global: number;
    workspace: number;
    builtin: number;
  };
  workspacePath?: string;
  registries?: Record<string, string>;
  platform?: string;
  initialSource?: string;
  openModal?: boolean;
  lastInstall?: InstallResultPayload;
}

export interface InstallStep {
  phase: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

export interface InstallResultPayload {
  ok: boolean;
  plugin: {
    dir: string;
    name: string;
    displayName: string;
    version: string;
    description: string;
    path: string;
    scope: InstallScope;
    mode: LocalInstallMode;
    sourceType: ResolvedSourceType;
    displaySource: string;
    components: PluginComponents;
    warnings: string[];
  };
  steps: InstallStep[];
}
