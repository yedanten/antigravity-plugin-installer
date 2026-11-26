import type { Locale } from './types';

export interface Messages {
  title: string;
  subtitle: string;
  installPlugin: string;
  refresh: string;
  searchPlaceholder: string;
  filterAll: string;
  filterUser: string;
  filterWorkspace: string;
  filterBuiltin: string;
  workspaceScanToggle: string;
  workspaceScanPlaceholder: string;
  workspaceScanApply: string;
  emptyTitle: string;
  emptyDesc: string;
  emptySearchTitle: string;
  emptySearchDesc: string;
  enabled: string;
  disabled: string;
  manageNative: string;
  hideManageNative: string;
  nativeManageTitle: string;
  nativeManageDesc: string;
  nativeManageLinkLabel: string;
  nativeManageSendChat: string;
  nativeManageSentChat: string;
  nativeManageCopyLink: string;
  nativeManageCopied: string;
  builtin: string;
  linked: string;
  globalScope: string;
  workspaceScope: string;
  details: string;
  hideDetails: string;
  reinstall: string;
  reinstalling: string;
  uninstall: string;
  confirmUninstall: string;
  cancel: string;
  sourceLabel: string;
  pathLabel: string;
  componentsLabel: string;
  validationIssues: string;
  skills: string;
  mcp: string;
  agents: string;
  rules: string;
  hooks: string;
  sidecars: string;
  modalTitle: string;
  modalSubtitle: string;
  sourceAuto: string;
  sourceGithub: string;
  sourceNpm: string;
  sourceLocal: string;
  inputPlaceholderAuto: string;
  inputPlaceholderGithub: string;
  inputPlaceholderNpm: string;
  inputPlaceholderLocal: string;
  detectedPrefix: string;
  showGuide: string;
  hideGuide: string;
  registryLabel: string;
  registryOfficial: string;
  registryMirror: string;
  registryCustom: string;
  registryCustomPlaceholder: string;
  localModeLabel: string;
  localModeCopy: string;
  localModeLink: string;
  fillExample: string;
  guideGithubTitle: string;
  guideGithubDesc: string;
  guideGithubExample: string;
  guideNpmTitle: string;
  guideNpmDesc: string;
  guideNpmExample: string;
  guideLocalTitle: string;
  guideLocalDesc: string;
  guideLocalExample: string;
  branchLabel: string;
  branchPlaceholder: string;
  subpathLabel: string;
  subpathPlaceholder: string;
  advancedOptions: string;
  installScopeLabel: string;
  scopeGlobalOption: string;
  scopeWorkspaceOption: string;
  workspacePathLabel: string;
  workspacePathPlaceholder: string;
  targetDirLabel: string;
  targetDirPlaceholder: string;
  overwriteLabel: string;
  securityNoticeTitle: string;
  securityNoticeBody: string;
  installSubmit: string;
  installing: string;
  overwriteAndRetry: string;
  installSuccessTitle: string;
  installSuccessHint: string;
  done: string;
  installAnother: string;
  toastUninstalled: string;
  toastUpdated: string;
  toastInstalled: string;
  errSelfUpdate: string;
  errSelfUninstall: string;
  errFilesLocked: string;
  errFilesLockedDisabled: string;
  loading: string;
}

const zh: Messages = {
  title: '插件管理',
  subtitle: '通过 GitHub 仓库、npm 包或本地目录安装与管理自定义插件',
  installPlugin: 'Install Plugin',
  refresh: '刷新',
  searchPlaceholder: '搜索已安装插件名称、描述或来源...',
  filterAll: '全部',
  filterUser: '已安装',
  filterWorkspace: '工作区',
  filterBuiltin: '内置',
  workspaceScanToggle: '工作区目录',
  workspaceScanPlaceholder: '输入工作区路径以同时查看 .agents/plugins/',
  workspaceScanApply: '加载',
  emptyTitle: '还没有安装自定义插件',
  emptyDesc: '点击右上角 Install Plugin，直接通过 GitHub 地址、npm 包名或本地路径安装 Antigravity 插件。',
  emptySearchTitle: '没有匹配的插件',
  emptySearchDesc: '尝试更换关键词或切换上方筛选分类。',
  enabled: '已启用',
  disabled: '已禁用',
  manageNative: '原生启停',
  hideManageNative: '收起指引',
  nativeManageTitle: '请在 Antigravity 原生 Customizations 页面切换启停',
  nativeManageDesc:
    'Antigravity 由 Language Server 统一托管插件热重载（MCP、Sidecar、Hooks、Rules）。请前往左侧栏 Customizations → Installed 页面找到该插件进行启用或禁用（立即生效、无需重启）。',
  nativeManageLinkLabel: '原生插件链接',
  nativeManageSendChat: '在对话中发送跳转链接',
  nativeManageSentChat: '已将原生管理跳转链接发送到当前对话',
  nativeManageCopyLink: '复制链接',
  nativeManageCopied: '已复制原生插件链接',
  builtin: '内置',
  linked: '软链接',
  globalScope: '全局',
  workspaceScope: '工作区',
  details: '详情',
  hideDetails: '收起',
  reinstall: '更新',
  reinstalling: '更新中...',
  uninstall: '卸载',
  confirmUninstall: '确认卸载',
  cancel: '取消',
  sourceLabel: '安装来源',
  pathLabel: '安装路径',
  componentsLabel: '包含组件',
  validationIssues: '清单校验提示',
  skills: 'Skills',
  mcp: 'MCP',
  agents: 'Agents',
  rules: 'Rules',
  hooks: 'Hooks',
  sidecars: 'Sidecars',
  modalTitle: 'Install Plugin',
  modalSubtitle: '输入插件的 GitHub 仓库地址、npm 包名或本地目录路径。',
  sourceAuto: '自动识别',
  sourceGithub: 'GitHub',
  sourceNpm: 'npm',
  sourceLocal: '本地路径',
  inputPlaceholderAuto: '例如 https://github.com/owner/repo、@scope/plugin 或 D:\\path\\to\\plugin',
  inputPlaceholderGithub: '例如 https://github.com/owner/repo 或 owner/repo',
  inputPlaceholderNpm: '例如 @scope/my-plugin 或 my-agy-plugin@1.0.0',
  inputPlaceholderLocal: '例如 D:\\projects\\my-plugin 或 ~/plugins/my-plugin',
  detectedPrefix: '已识别为',
  showGuide: '展开引导',
  hideGuide: '收起引导',
  registryLabel: '安装源',
  registryOfficial: 'npm 官方源',
  registryMirror: 'npmmirror 国内源',
  registryCustom: '自定义源',
  registryCustomPlaceholder: 'https://registry.example.com',
  localModeLabel: '安装方式',
  localModeCopy: '复制安装',
  localModeLink: '开发软链接 (Link)',
  fillExample: '填入示例',
  guideGithubTitle: '填入 GitHub 仓库地址',
  guideGithubDesc:
    '支持完整仓库链接、带 /tree/<branch>/<subdir> 的子目录链接、SSH 地址或 owner/repo 简写。仓库根目录或指定子目录需包含 plugin.json。',
  guideGithubExample: '示例：https://github.com/owner/my-antigravity-plugin',
  guideNpmTitle: '填入插件 npm 包名',
  guideNpmDesc:
    '支持标准包名、作用域包（@org/plugin）、指定版本号（pkg@1.2.0）或 npmjs.com 页面地址。可通过右上角切换官方源或国内镜像源。',
  guideNpmExample: '示例：@acme/antigravity-plugin',
  guideLocalTitle: '填入本地插件目录路径',
  guideLocalDesc:
    '指向包含 plugin.json 的本地目录（支持 ~/ 路径与带引号的路径）。推荐“复制安装”（Windows 下 Antigravity 默认不扫描 Junction/软链接，复制安装后修改源码可随时点击“更新”同步）。',
  guideLocalExample: '示例：~/workspace/my-plugin',
  branchLabel: '分支 / Tag（可选）',
  branchPlaceholder: '例如 main、v1.0.0',
  subpathLabel: '子目录（可选）',
  subpathPlaceholder: '例如 plugins/my-plugin',
  advancedOptions: '高级安装选项',
  installScopeLabel: '安装范围',
  scopeGlobalOption: '全局（~/.gemini/config/plugins）',
  scopeWorkspaceOption: '工作区（<workspace>/.agents/plugins）',
  workspacePathLabel: '工作区根目录',
  workspacePathPlaceholder: '输入项目根目录绝对路径',
  targetDirLabel: '自定义安装目录名（可选）',
  targetDirPlaceholder: '默认使用 plugin.json 中的 name',
  overwriteLabel: '如存在同名插件，覆盖重新安装',
  securityNoticeTitle: '请确认插件来源可信',
  securityNoticeBody:
    '插件中的 MCP Server 与 Hooks 会以当前用户权限运行。安装完成后 Antigravity 会自动热发现新插件；如需启用或禁用，请前往 Antigravity 原生 Customizations → Installed 页面操作（实时生效）。',
  installSubmit: '安装插件',
  installing: '正在安装...',
  overwriteAndRetry: '勾选覆盖并重新安装',
  installSuccessTitle: '插件安装成功',
  installSuccessHint: 'Antigravity 会自动发现新安装的插件（无需重启）。如需启用、禁用或配置凭据，请前往原生 Customizations → Installed 页面管理。',
  done: '完成',
  installAnother: '继续安装其他插件',
  toastUninstalled: '已卸载插件',
  toastUpdated: '已重新安装插件',
  toastInstalled: '已成功安装插件',
  errSelfUpdate: '无法在当前面板中更新 Plugin Installer 自身，请使用 npm run install:local 或 Antigravity CLI 更新。',
  errSelfUninstall: '无法在当前面板中卸载 Plugin Installer 自身，否则会删除其正在运行的 MCP 服务与管理界面。',
  errFilesLocked: '插件文件正在被运行中的进程占用，无法直接覆盖。请先在 Antigravity 原生 Customizations → Installed 页面禁用该插件（停止其 MCP Server / Sidecar），然后重试更新。',
  errFilesLockedDisabled:
    '该插件已处于禁用状态，但部分文件或目录仍被 Antigravity 或其他进程占用，无法完成替换。请重启 Antigravity 或关闭占用该插件目录的进程后重试。',
  loading: '正在加载已安装插件...',
};

const en: Messages = {
  title: 'Plugins',
  subtitle: 'Install and manage custom plugins from GitHub repositories, npm packages, or local folders',
  installPlugin: 'Install Plugin',
  refresh: 'Refresh',
  searchPlaceholder: 'Search installed plugins by name, description, or source...',
  filterAll: 'All',
  filterUser: 'Installed',
  filterWorkspace: 'Workspace',
  filterBuiltin: 'Built-in',
  workspaceScanToggle: 'Workspace',
  workspaceScanPlaceholder: 'Enter a workspace path to also inspect .agents/plugins/',
  workspaceScanApply: 'Load',
  emptyTitle: 'No custom plugins installed yet',
  emptyDesc: 'Click Install Plugin above to add an Antigravity plugin from a GitHub URL, npm package, or local directory.',
  emptySearchTitle: 'No matching plugins',
  emptySearchDesc: 'Try a different search query or filter category.',
  enabled: 'Enabled',
  disabled: 'Disabled',
  manageNative: 'Enable / Disable',
  hideManageNative: 'Close guide',
  nativeManageTitle: 'Toggle live in Antigravity Customizations',
  nativeManageDesc:
    'Antigravity manages live plugin reloads (MCP servers, sidecars, hooks, and rules) inside its Language Server. Open Customizations → Installed in the left sidebar to enable or disable this plugin live without restarting.',
  nativeManageLinkLabel: 'Native link',
  nativeManageSendChat: 'Send jump link to chat',
  nativeManageSentChat: 'Sent native link request to chat',
  nativeManageCopyLink: 'Copy link',
  nativeManageCopied: 'Copied native plugin link',
  builtin: 'Built-in',
  linked: 'Linked',
  globalScope: 'Global',
  workspaceScope: 'Workspace',
  details: 'Details',
  hideDetails: 'Hide',
  reinstall: 'Update',
  reinstalling: 'Updating...',
  uninstall: 'Uninstall',
  confirmUninstall: 'Confirm',
  cancel: 'Cancel',
  sourceLabel: 'Source',
  pathLabel: 'Location',
  componentsLabel: 'Components',
  validationIssues: 'Manifest Notices',
  skills: 'Skills',
  mcp: 'MCP',
  agents: 'Agents',
  rules: 'Rules',
  hooks: 'Hooks',
  sidecars: 'Sidecars',
  modalTitle: 'Install Plugin',
  modalSubtitle: 'Enter a GitHub repository URL, npm package name, or local directory path.',
  sourceAuto: 'Auto',
  sourceGithub: 'GitHub',
  sourceNpm: 'npm',
  sourceLocal: 'Local Path',
  inputPlaceholderAuto: 'e.g. https://github.com/owner/repo, @scope/plugin, or ~/my-plugin',
  inputPlaceholderGithub: 'e.g. https://github.com/owner/repo or owner/repo',
  inputPlaceholderNpm: 'e.g. @scope/my-plugin or my-agy-plugin@1.0.0',
  inputPlaceholderLocal: 'e.g. /path/to/my-plugin or D:\\projects\\my-plugin',
  detectedPrefix: 'Detected',
  showGuide: 'Show guide',
  hideGuide: 'Hide guide',
  registryLabel: 'Registry',
  registryOfficial: 'npm Official',
  registryMirror: 'npmmirror',
  registryCustom: 'Custom URL',
  registryCustomPlaceholder: 'https://registry.example.com',
  localModeLabel: 'Mode',
  localModeCopy: 'Copy files',
  localModeLink: 'Symlink / Junction (Dev)',
  fillExample: 'Use example',
  guideGithubTitle: 'Enter a GitHub Repository',
  guideGithubDesc:
    'Supports full HTTPS URLs, /tree/<branch>/<subdir> subdirectory URLs, SSH URLs, or owner/repo shorthand. The root or selected subdirectory must contain plugin.json.',
  guideGithubExample: 'Example: https://github.com/owner/my-antigravity-plugin',
  guideNpmTitle: 'Enter an npm Package Name',
  guideNpmDesc:
    'Supports package names, scoped packages (@org/plugin), version specifiers (pkg@1.2.0), or npmjs.com URLs. Switch registries using the selector above.',
  guideNpmExample: 'Example: @acme/antigravity-plugin',
  guideLocalTitle: 'Enter a Local Plugin Folder',
  guideLocalDesc:
    'Point to a local directory containing plugin.json (supports ~/ and quoted paths). Copy mode is recommended (Antigravity on Windows skips directory junctions; use Update on the card to re-sync local edits).',
  guideLocalExample: 'Example: ~/workspace/my-plugin',
  branchLabel: 'Branch / Tag (optional)',
  branchPlaceholder: 'e.g. main, v1.0.0',
  subpathLabel: 'Subdirectory (optional)',
  subpathPlaceholder: 'e.g. plugins/my-plugin',
  advancedOptions: 'Advanced options',
  installScopeLabel: 'Install scope',
  scopeGlobalOption: 'Global (~/.gemini/config/plugins)',
  scopeWorkspaceOption: 'Workspace (<workspace>/.agents/plugins)',
  workspacePathLabel: 'Workspace root path',
  workspacePathPlaceholder: 'Absolute path to your project root',
  targetDirLabel: 'Custom folder name (optional)',
  targetDirPlaceholder: 'Defaults to plugin.json name',
  overwriteLabel: 'Overwrite if a plugin with the same directory already exists',
  securityNoticeTitle: 'Verify plugin trust before installing',
  securityNoticeBody:
    'Bundled MCP servers and hooks run with your user permissions. Newly installed plugins are discovered automatically without restarting; manage live enable/disable state in Antigravity Customizations → Installed.',
  installSubmit: 'Install Plugin',
  installing: 'Installing...',
  overwriteAndRetry: 'Overwrite & Retry',
  installSuccessTitle: 'Plugin installed',
  installSuccessHint: 'Antigravity discovers new plugins automatically. Use Antigravity’s native Customizations → Installed page to toggle enable/disable live or configure credentials.',
  done: 'Done',
  installAnother: 'Install another',
  toastUninstalled: 'Uninstalled',
  toastUpdated: 'Updated',
  toastInstalled: 'Installed',
  errSelfUpdate: 'Cannot update Plugin Installer from inside its own running MCP server. Use "npm run install:local" or Antigravity CLI.',
  errSelfUninstall: 'Cannot uninstall Plugin Installer from its own panel, as doing so would delete its running MCP server and UI.',
  errFilesLocked: 'Plugin files are currently locked by a running process. Disable this plugin in Antigravity Customizations → Installed first so its MCP server or sidecar stops, then retry updating.',
  errFilesLockedDisabled:
    'This plugin is already disabled, but some files or folders are still locked by Antigravity or another process. Restart Antigravity or close the process holding the plugin files, then retry.',
  loading: 'Loading installed plugins...',
};

export function detectLocale(hostLocale?: string): Locale {
  const candidate = (hostLocale || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en').toLowerCase();
  return candidate.startsWith('zh') ? 'zh' : 'en';
}

export function getMessages(locale: Locale): Messages {
  return locale === 'zh' ? zh : en;
}
