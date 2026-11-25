import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import './styles.css';
import { detectLocale, getMessages } from './i18n';
import type {
  InstallResultPayload,
  InstallScope,
  InventoryPayload,
  LocalInstallMode,
  Locale,
  PluginItem,
  ResolvedSourceType,
  SourceType,
} from './types';

interface ModalState {
  open: boolean;
  source: string;
  sourceType: SourceType;
  registryPreset: 'official' | 'npmmirror' | 'custom';
  customRegistry: string;
  ref: string;
  subpath: string;
  localMode: LocalInstallMode;
  scope: InstallScope;
  workspacePath: string;
  targetDirName: string;
  overwrite: boolean;
  showGuide: boolean;
  showAdvanced: boolean;
  submitting: boolean;
  error: string | null;
  errorCode: string | null;
  success: InstallResultPayload | null;
}

interface AppState {
  locale: Locale;
  localeManual: boolean;
  loading: boolean;
  refreshing: boolean;
  plugins: PluginItem[];
  counts: InventoryPayload['counts'];
  paths: InventoryPayload['paths'];
  workspacePath: string;
  showWorkspaceBar: boolean;
  filter: 'all' | 'user' | 'workspace' | 'builtin';
  search: string;
  expandedIds: Set<string>;
  confirmUninstallId: string | null;
  busyPluginId: string | null;
  toast: { type: 'success' | 'error'; text: string } | null;
  modal: ModalState;
}

const state: AppState = {
  locale: detectLocale(),
  localeManual: false,
  loading: true,
  refreshing: false,
  plugins: [],
  counts: { total: 0, global: 0, workspace: 0, builtin: 0 },
  paths: { globalDir: '', builtinDir: '', workspaceDir: null },
  workspacePath: '',
  showWorkspaceBar: false,
  filter: 'all',
  search: '',
  expandedIds: new Set(),
  confirmUninstallId: null,
  busyPluginId: null,
  toast: null,
  modal: {
    open: false,
    source: '',
    sourceType: 'auto',
    registryPreset: 'official',
    customRegistry: '',
    ref: '',
    subpath: '',
    localMode: 'copy',
    scope: 'global',
    workspacePath: '',
    targetDirName: '',
    overwrite: false,
    showGuide: true,
    showAdvanced: false,
    submitting: false,
    error: null,
    errorCode: null,
    success: null,
  },
};

const app = new App({ name: 'Plugin Installer', version: '1.1.0' }, {});
let toastTimer: number | null = null;

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(type: 'success' | 'error', text: string) {
  state.toast = { type, text };
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 5000);
}

/**
 * Lightweight client-side source classifier for live UX feedback while typing.
 */
function classifySourceClient(raw: string, selected: SourceType): ResolvedSourceType | null {
  if (selected !== 'auto') return selected;
  const s = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!s) return null;

  if (
    /^https?:\/\/(?:www\.)?github\.com\//i.test(s) ||
    /^github\.com\//i.test(s) ||
    /^git@github\.com:/i.test(s) ||
    s.startsWith('github:')
  ) {
    return 'github';
  }
  if (/^https?:\/\/(?:www\.)?npmjs\.com\/package\//i.test(s) || s.startsWith('npm:')) {
    return 'npm';
  }
  if (
    s.startsWith('file://') ||
    s.startsWith('/') ||
    s.startsWith('~/') ||
    s.startsWith('~\\') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('.\\') ||
    s.startsWith('..\\') ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    s.startsWith('\\\\')
  ) {
    return 'local';
  }
  if (s.startsWith('@')) return 'npm';
  if (s.includes('/') && !s.startsWith('http://') && !s.startsWith('https://')) {
    return 'github';
  }
  if (/^[a-z0-9._-]+(?:@[^@\s]+)?$/i.test(s)) {
    return 'npm';
  }
  return null;
}

function getEffectiveSourceType(): ResolvedSourceType {
  return classifySourceClient(state.modal.source, state.modal.sourceType) || 'github';
}

function applyInventory(payload: Partial<InventoryPayload>) {
  if (Array.isArray(payload.plugins)) {
    state.plugins = payload.plugins;
  }
  if (payload.counts) {
    state.counts = payload.counts;
  }
  if (payload.paths) {
    state.paths = payload.paths;
  }
  if (typeof payload.workspacePath === 'string') {
    state.workspacePath = payload.workspacePath;
    if (payload.workspacePath && !state.modal.workspacePath) {
      state.modal.workspacePath = payload.workspacePath;
    }
  }
  state.loading = false;
  state.refreshing = false;
}

async function refreshInventory() {
  state.refreshing = true;
  render();
  try {
    const res = await app.callServerTool({
      name: 'app_list_plugins',
      arguments: state.workspacePath ? { workspacePath: state.workspacePath } : {},
    });
    const sc = res.structuredContent as Partial<InventoryPayload> | undefined;
    if (sc) applyInventory(sc);
  } catch (err) {
    state.refreshing = false;
    state.loading = false;
    showToast('error', err instanceof Error ? err.message : String(err));
  }
  render();
}

function openModal(initialSource = '') {
  state.modal = {
    ...state.modal,
    open: true,
    source: initialSource || state.modal.source,
    submitting: false,
    error: null,
    errorCode: null,
    success: null,
  };
  render();
  window.setTimeout(() => {
    const input = document.getElementById('modal-source-input') as HTMLInputElement | null;
    input?.focus();
  }, 20);
}

function closeModal() {
  if (state.modal.submitting) return;
  state.modal.open = false;
  state.modal.error = null;
  state.modal.errorCode = null;
  state.modal.success = null;
  render();
}

async function submitInstall(forceOverwrite = false) {
  const m = state.modal;
  const source = m.source.trim();
  if (!source || m.submitting) return;

  if (forceOverwrite) {
    m.overwrite = true;
  }

  m.submitting = true;
  m.error = null;
  m.errorCode = null;
  m.success = null;
  render();

  const effectiveRegistry =
    m.registryPreset === 'custom' ? m.customRegistry.trim() : m.registryPreset;

  const args: Record<string, unknown> = {
    source,
    sourceType: m.sourceType,
    scope: m.scope,
    overwrite: m.overwrite,
  };

  const detected = getEffectiveSourceType();
  if (detected === 'npm') {
    args.registry = effectiveRegistry || 'official';
    if (m.subpath.trim()) args.subpath = m.subpath.trim();
  } else if (detected === 'github') {
    if (m.ref.trim()) args.ref = m.ref.trim();
    if (m.subpath.trim()) args.subpath = m.subpath.trim();
  } else if (detected === 'local') {
    args.mode = m.localMode;
  }

  if (m.scope === 'workspace' && m.workspacePath.trim()) {
    args.workspacePath = m.workspacePath.trim();
  }
  if (m.targetDirName.trim()) {
    args.targetDirName = m.targetDirName.trim();
  }

  try {
    const res = await app.callServerTool({
      name: 'app_install_plugin',
      arguments: args,
    });

    const sc = res.structuredContent as
      | {
          ok: boolean;
          install?: InstallResultPayload;
          inventory?: InventoryPayload;
          error?: string;
          code?: string;
        }
      | undefined;

    m.submitting = false;
    if (sc?.ok && sc.install) {
      m.success = sc.install;
      if (sc.inventory) {
        applyInventory(sc.inventory);
      }
      const msg = getMessages(state.locale);
      const overwroteExisting = sc.install.overwrote ?? Boolean(args.overwrite);
      const toastLabel = sc.install.restoredEnabled
        ? msg.toastUpdatedRestored
        : overwroteExisting && sc.install.wasEnabled === false && sc.install.enabled === false
          ? msg.toastUpdatedKeptDisabled
          : overwroteExisting
            ? msg.toastUpdated
            : msg.toastInstalled;
      showToast('success', `${toastLabel}: ${sc.install.plugin.displayName}`);
    } else {
      const msg = getMessages(state.locale);
      m.error =
        sc?.code === 'SELF_UPDATE_BLOCKED'
          ? msg.errSelfUpdate
          : sc?.error || 'Installation failed.';
      m.errorCode = sc?.code || 'INSTALL_FAILED';
    }
  } catch (err) {
    m.submitting = false;
    m.error = err instanceof Error ? err.message : String(err);
    m.errorCode = 'INSTALL_FAILED';
  }

  render();
}

async function handleUninstall(plugin: PluginItem) {
  if (state.busyPluginId) return;
  state.busyPluginId = plugin.id;
  state.confirmUninstallId = null;
  render();

  try {
    const res = await app.callServerTool({
      name: 'app_uninstall_plugin',
      arguments: {
        dir: plugin.dir,
        scope: plugin.scope === 'workspace' ? 'workspace' : 'global',
        workspacePath: state.workspacePath,
      },
    });
    const sc = res.structuredContent as
      | { ok: boolean; inventory?: InventoryPayload; error?: string; code?: string }
      | undefined;
    const t = getMessages(state.locale);
    if (sc?.ok) {
      if (sc.inventory) applyInventory(sc.inventory);
      showToast('success', `${t.toastUninstalled}: ${plugin.displayName}`);
    } else {
      showToast(
        'error',
        sc?.code === 'SELF_UNINSTALL_BLOCKED'
          ? t.errSelfUninstall
          : sc?.error || 'Failed to uninstall plugin.',
      );
    }
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err));
  } finally {
    state.busyPluginId = null;
    render();
  }
}

async function handleReinstall(plugin: PluginItem) {
  if (state.busyPluginId) return;
  state.busyPluginId = plugin.id;
  render();

  try {
    const res = await app.callServerTool({
      name: 'app_reinstall_plugin',
      arguments: {
        dir: plugin.dir,
        scope: plugin.scope === 'workspace' ? 'workspace' : 'global',
        workspacePath: state.workspacePath,
      },
    });
    const sc = res.structuredContent as
      | {
          ok: boolean;
          install?: InstallResultPayload;
          inventory?: InventoryPayload;
          error?: string;
          code?: string;
        }
      | undefined;
    const t = getMessages(state.locale);
    if (sc?.ok) {
      if (sc.inventory) applyInventory(sc.inventory);
      const toastLabel = sc.install?.restoredEnabled
        ? t.toastUpdatedRestored
        : sc.install?.wasEnabled === false && sc.install?.enabled === false
          ? t.toastUpdatedKeptDisabled
          : t.toastUpdated;
      showToast('success', `${toastLabel}: ${plugin.displayName}`);
    } else {
      showToast(
        'error',
        sc?.code === 'SELF_UPDATE_BLOCKED'
          ? t.errSelfUpdate
          : sc?.error || 'Failed to update plugin.',
      );
    }
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err));
  } finally {
    state.busyPluginId = null;
    render();
  }
}

async function handleToggleEnabled(plugin: PluginItem) {
  if (state.busyPluginId) return;
  state.busyPluginId = plugin.id;
  render();

  const nextEnabled = !plugin.enabled;
  try {
    const res = await app.callServerTool({
      name: 'app_set_plugin_enabled',
      arguments: {
        dir: plugin.dir,
        scope: plugin.scope,
        workspacePath: state.workspacePath,
        enabled: nextEnabled,
      },
    });
    const sc = res.structuredContent as
      | {
          ok: boolean;
          enabled?: boolean;
          inventory?: InventoryPayload;
          error?: string;
          code?: string;
        }
      | undefined;
    const t = getMessages(state.locale);
    if (sc?.ok) {
      if (sc.inventory) {
        applyInventory(sc.inventory);
      } else {
        await refreshInventory();
      }
      const effectiveEnabled = typeof sc.enabled === 'boolean' ? sc.enabled : nextEnabled;
      showToast(
        'success',
        `${effectiveEnabled ? t.toastEnabled : t.toastDisabled}: ${plugin.displayName}`,
      );
    } else {
      showToast(
        'error',
        sc?.code === 'SELF_DISABLE_BLOCKED'
          ? t.errSelfDisable
          : sc?.error || 'Failed to update plugin state.',
      );
    }
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err));
  } finally {
    state.busyPluginId = null;
    render();
  }
}

function getFilteredPlugins(): PluginItem[] {
  const q = state.search.trim().toLowerCase();
  return state.plugins.filter((p) => {
    if (state.filter === 'user' && p.scope !== 'global') return false;
    if (state.filter === 'workspace' && p.scope !== 'workspace') return false;
    if (state.filter === 'builtin' && !p.isBuiltin) return false;
    if (!q) return true;
    const hay = [
      p.name,
      p.displayName,
      p.dir,
      p.description,
      p.author,
      p.installMeta?.displaySource || '',
      ...p.components.skills,
      ...p.components.mcpServers,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

// Inline SVG icons
const icons = {
  plus: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>`,
  refresh: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.67L13.5 5.5"/><path d="M13.5 2.5v3h-3"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.8 10.8 14 14"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  chevronUp: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>`,
  chevronDown: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`,
  info: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.6M8 5h.01"/></svg>`,
  check: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="m5.5 8.2 1.7 1.7 3.4-3.6"/></svg>`,
  package: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.3 1.5h5.4A1.2 1.2 0 0 1 14 5.7v6.1A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8V4.2Z"/></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 4.2h10.4M6 4.2V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.2M4.5 4.2l.6 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.3"/></svg>`,
};

function renderPluginCard(p: PluginItem): string {
  const t = getMessages(state.locale);
  const expanded = state.expandedIds.has(p.id);
  const confirming = state.confirmUninstallId === p.id;
  const busy = state.busyPluginId === p.id;
  const initials = (p.displayName || p.name || '?').slice(0, 2).toUpperCase();

  const sourceBadge = p.isBuiltin
    ? `<span class="badge">${esc(t.builtin)}</span>`
    : p.isSymlink
      ? `<span class="badge badge-info">${esc(t.linked)}</span>`
      : p.installMeta?.sourceType === 'github'
        ? `<span class="badge badge-info">GitHub</span>`
        : p.installMeta?.sourceType === 'npm'
          ? `<span class="badge badge-info">npm</span>`
          : p.scope === 'workspace'
            ? `<span class="badge">${esc(t.workspaceScope)}</span>`
            : `<span class="badge">${esc(t.globalScope)}</span>`;

  const statusBadge = p.enabled
    ? `<span class="badge badge-success"><span class="status-dot"></span>${esc(t.enabled)}</span>`
    : `<span class="badge"><span class="status-dot"></span>${esc(t.disabled)}</span>`;

  const chips: string[] = [];
  if (p.components.skills.length) chips.push(`${p.components.skills.length} ${t.skills}`);
  if (p.components.mcpServers.length) chips.push(`${p.components.mcpServers.length} ${t.mcp}`);
  if (p.components.agents.length) chips.push(`${p.components.agents.length} ${t.agents}`);
  if (p.components.rules.length) chips.push(`${p.components.rules.length} ${t.rules}`);
  if (p.components.hasHooks) chips.push(t.hooks);
  if (p.components.sidecars?.length) chips.push(`${p.components.sidecars.length} ${t.sidecars}`);

  const sourceHint = p.installMeta?.displaySource || (p.isSymlink && p.linkTarget ? p.linkTarget : p.dir);
  const toggleActionLabel = p.enabled ? t.disablePlugin : t.enablePlugin;

  return `
    <article class="plugin-card ${p.enabled ? '' : 'is-disabled'}" data-plugin-id="${esc(p.id)}">
      <div class="card-top">
        <div class="plugin-icon">
          ${p.logoDataUri ? `<img src="${esc(p.logoDataUri)}" alt="" />` : esc(initials)}
        </div>
        <div class="card-meta">
          <div class="card-title-row">
            <span class="card-title" title="${esc(p.displayName)}">${esc(p.displayName)}</span>
            ${p.version ? `<span class="badge">v${esc(p.version)}</span>` : ''}
            ${sourceBadge}
            ${statusBadge}
          </div>
          ${p.description ? `<p class="card-desc">${esc(p.description)}</p>` : ''}
        </div>
        <div class="card-toggle-wrap">
          <button
            type="button"
            class="toggle-switch ${p.enabled ? 'is-enabled' : ''}"
            role="switch"
            aria-checked="${p.enabled ? 'true' : 'false'}"
            aria-label="${esc(toggleActionLabel)}"
            title="${esc(toggleActionLabel)}"
            data-action="toggle-enabled"
            data-id="${esc(p.id)}"
            ${busy ? 'disabled' : ''}
          >
            <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">${esc(p.enabled ? t.enabled : t.disabled)}</span>
          </button>
        </div>
      </div>

      ${
        chips.length > 0 || !p.valid
          ? `<div class="chip-row">
              ${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}
              ${!p.valid ? `<span class="badge badge-danger">Invalid manifest</span>` : ''}
            </div>`
          : ''
      }

      ${
        expanded
          ? `<div class="card-details">
              <div class="detail-row">
                <span class="detail-key">${esc(t.pathLabel)}</span>
                <span class="detail-val">${esc(p.path)}</span>
              </div>
              ${
                p.installMeta?.displaySource
                  ? `<div class="detail-row">
                      <span class="detail-key">${esc(t.sourceLabel)}</span>
                      <span class="detail-val">${esc(p.installMeta.displaySource)}</span>
                    </div>`
                  : ''
              }
              ${
                p.components.skills.length
                  ? `<div class="detail-row">
                      <span class="detail-key">${esc(t.skills)}</span>
                      <span class="detail-val">${esc(p.components.skills.join(', '))}</span>
                    </div>`
                  : ''
              }
              ${
                p.components.mcpServers.length
                  ? `<div class="detail-row">
                      <span class="detail-key">${esc(t.mcp)}</span>
                      <span class="detail-val">${esc(p.components.mcpServers.join(', '))}</span>
                    </div>`
                  : ''
              }
              ${
                p.errors.length || p.warnings.length
                  ? `<div class="detail-row">
                      <span class="detail-key">${esc(t.validationIssues)}</span>
                      <span class="detail-val">${esc([...p.errors, ...p.warnings].join(' | '))}</span>
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }

      <div class="card-footer">
        <span class="card-source-hint" title="${esc(sourceHint)}">${esc(sourceHint)}</span>
        <div class="card-actions">
          <button class="btn btn-ghost" data-action="toggle-details" data-id="${esc(p.id)}">
            ${esc(expanded ? t.hideDetails : t.details)}
          </button>
          ${
            p.canReinstall
              ? `<button class="btn btn-ghost" data-action="reinstall" data-id="${esc(p.id)}" ${busy ? 'disabled' : ''}>
                  ${busy ? `<span class="spinner"></span> ${esc(t.reinstalling)}` : esc(t.reinstall)}
                </button>`
              : ''
          }
          ${
            p.canUninstall
              ? confirming
                ? `<button class="btn btn-danger-soft" data-action="confirm-uninstall" data-id="${esc(p.id)}" ${busy ? 'disabled' : ''}>
                    ${esc(t.confirmUninstall)}
                  </button>
                  <button class="btn btn-ghost" data-action="cancel-uninstall">
                    ${esc(t.cancel)}
                  </button>`
                : `<button class="btn btn-ghost" data-action="ask-uninstall" data-id="${esc(p.id)}" ${busy ? 'disabled' : ''} title="${esc(t.uninstall)}">
                    ${icons.trash} ${esc(t.uninstall)}
                  </button>`
              : ''
          }
        </div>
      </div>
    </article>
  `;
}

function renderModal(): string {
  const m = state.modal;
  if (!m.open) return '';

  const t = getMessages(state.locale);
  const detected = classifySourceClient(m.source, m.sourceType);
  const effectiveType: ResolvedSourceType = detected || 'github';

  const placeholder =
    m.sourceType === 'github'
      ? t.inputPlaceholderGithub
      : m.sourceType === 'npm'
        ? t.inputPlaceholderNpm
        : m.sourceType === 'local'
          ? t.inputPlaceholderLocal
          : t.inputPlaceholderAuto;

  const detectedLabel =
    detected === 'github'
      ? 'GitHub'
      : detected === 'npm'
        ? 'npm'
        : detected === 'local'
          ? t.sourceLocal
          : '';

  const guide =
    effectiveType === 'npm'
      ? {
          title: t.guideNpmTitle,
          desc: t.guideNpmDesc,
          example: t.guideNpmExample,
          sampleValue: '@acme/antigravity-plugin',
        }
      : effectiveType === 'local'
        ? {
            title: t.guideLocalTitle,
            desc: t.guideLocalDesc,
            example: t.guideLocalExample,
            sampleValue: '~/workspace/my-plugin',
          }
        : {
            title: t.guideGithubTitle,
            desc: t.guideGithubDesc,
            example: t.guideGithubExample,
            sampleValue: 'https://github.com/owner/my-antigravity-plugin',
          };

  // Success View inside Modal
  if (m.success) {
    const installed = m.success.plugin;
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-header">
            <div>
              <h2 class="modal-title" id="modal-title">${esc(t.installSuccessTitle)}</h2>
              <p class="modal-subtitle">${esc(installed.displayName)}${installed.version ? ` v${esc(installed.version)}` : ''}</p>
            </div>
            <button class="modal-close" data-action="close-modal" aria-label="Close">${icons.close}</button>
          </div>

          <div class="alert alert-success">
            <span>${icons.check}</span>
            <div>
              <div class="alert-title">${esc(installed.dir)}</div>
              <div class="alert-body">${esc(t.installSuccessHint)}</div>
            </div>
          </div>

          <div class="card-details" style="margin-bottom: 12px;">
            <div class="detail-row">
              <span class="detail-key">${esc(t.sourceLabel)}</span>
              <span class="detail-val">${esc(installed.displaySource)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-key">${esc(t.pathLabel)}</span>
              <span class="detail-val">${esc(installed.path)}</span>
            </div>
          </div>

          <ul class="steps-list">
            ${m.success.steps
              .map(
                (s) => `
                  <li class="step-item">
                    <span class="step-dot ${s.status === 'warn' ? 'warn' : ''}"></span>
                    <span>${esc(s.message)}</span>
                  </li>`,
              )
              .join('')}
          </ul>

          <div class="modal-footer-row">
            <button class="btn" style="flex: 1" data-action="install-another">${esc(t.installAnother)}</button>
            <button class="btn btn-primary" style="flex: 1" data-action="close-modal">${esc(t.done)}</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="modal-backdrop" data-action="backdrop-close">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <div>
            <h2 class="modal-title" id="modal-title">${esc(t.modalTitle)}</h2>
            <p class="modal-subtitle">${esc(t.modalSubtitle)}</p>
          </div>
          <button class="modal-close" data-action="close-modal" aria-label="Close">${icons.close}</button>
        </div>

        <div class="source-tabs" role="tablist">
          ${(['auto', 'github', 'npm', 'local'] as SourceType[])
            .map((st) => {
              const label =
                st === 'auto'
                  ? t.sourceAuto
                  : st === 'github'
                    ? t.sourceGithub
                    : st === 'npm'
                      ? t.sourceNpm
                      : t.sourceLocal;
              return `<button type="button" class="source-tab ${m.sourceType === st ? 'active' : ''}" data-action="set-source-type" data-value="${st}">${esc(label)}</button>`;
            })
            .join('')}
        </div>

        <div class="primary-input-box">
          <input
            id="modal-source-input"
            class="input primary-input"
            type="text"
            value="${esc(m.source)}"
            placeholder="${esc(placeholder)}"
            autocomplete="off"
            spellcheck="false"
            ${m.submitting ? 'disabled' : ''}
          />
          <span id="modal-detected-badge" class="detected-badge">
            ${detectedLabel ? `<span class="badge badge-info">${esc(detectedLabel)}</span>` : ''}
          </span>
        </div>

        <div class="controls-row">
          <button type="button" class="guide-toggle" data-action="toggle-guide">
            ${m.showGuide ? icons.chevronUp : icons.chevronDown}
            <span>${esc(m.showGuide ? t.hideGuide : t.showGuide)}</span>
          </button>

          ${
            effectiveType === 'npm'
              ? `<div class="inline-select-group">
                  <span>${esc(t.registryLabel)}</span>
                  <select id="modal-registry-select" class="select" ${m.submitting ? 'disabled' : ''}>
                    <option value="official" ${m.registryPreset === 'official' ? 'selected' : ''}>${esc(t.registryOfficial)}</option>
                    <option value="npmmirror" ${m.registryPreset === 'npmmirror' ? 'selected' : ''}>${esc(t.registryMirror)}</option>
                    <option value="custom" ${m.registryPreset === 'custom' ? 'selected' : ''}>${esc(t.registryCustom)}</option>
                  </select>
                </div>`
              : effectiveType === 'local'
                ? `<div class="inline-select-group">
                    <span>${esc(t.localModeLabel)}</span>
                    <select id="modal-local-mode" class="select" ${m.submitting ? 'disabled' : ''}>
                      <option value="copy" ${m.localMode === 'copy' ? 'selected' : ''}>${esc(t.localModeCopy)}</option>
                      <option value="link" ${m.localMode === 'link' ? 'selected' : ''}>${esc(t.localModeLink)}</option>
                    </select>
                  </div>`
                : ''
          }
        </div>

        ${
          effectiveType === 'npm' && m.registryPreset === 'custom'
            ? `<div class="field">
                <input
                  id="modal-custom-registry"
                  class="input"
                  type="url"
                  value="${esc(m.customRegistry)}"
                  placeholder="${esc(t.registryCustomPlaceholder)}"
                  ${m.submitting ? 'disabled' : ''}
                />
              </div>`
            : ''
        }

        ${
          m.showGuide
            ? `<div class="guide-card">
                <div class="guide-card-header">
                  <div>
                    <h3 class="guide-card-title">${esc(guide.title)}</h3>
                    <p class="guide-card-desc">${esc(guide.desc)}</p>
                  </div>
                  <button type="button" class="btn btn-sm" data-action="fill-example" data-example="${esc(guide.sampleValue)}" ${m.submitting ? 'disabled' : ''}>
                    ${esc(t.fillExample)}
                  </button>
                </div>
                <div class="guide-card-example">${esc(guide.example)}</div>
              </div>`
            : ''
        }

        ${
          effectiveType === 'github'
            ? `<div class="field-grid">
                <div class="field">
                  <label for="modal-ref-input">${esc(t.branchLabel)}</label>
                  <input
                    id="modal-ref-input"
                    class="input"
                    type="text"
                    value="${esc(m.ref)}"
                    placeholder="${esc(t.branchPlaceholder)}"
                    ${m.submitting ? 'disabled' : ''}
                  />
                </div>
                <div class="field">
                  <label for="modal-subpath-input">${esc(t.subpathLabel)}</label>
                  <input
                    id="modal-subpath-input"
                    class="input"
                    type="text"
                    value="${esc(m.subpath)}"
                    placeholder="${esc(t.subpathPlaceholder)}"
                    ${m.submitting ? 'disabled' : ''}
                  />
                </div>
              </div>`
            : ''
        }

        <div class="controls-row" style="margin-bottom: 8px;">
          <button type="button" class="guide-toggle" data-action="toggle-advanced">
            ${m.showAdvanced ? icons.chevronUp : icons.chevronDown}
            <span>${esc(t.advancedOptions)}</span>
          </button>
        </div>

        ${
          m.showAdvanced
            ? `<div class="advanced-section">
                <div class="field-grid">
                  <div class="field">
                    <label for="modal-scope-select">${esc(t.installScopeLabel)}</label>
                    <select id="modal-scope-select" class="select" style="height: 36px; width: 100%;" ${m.submitting ? 'disabled' : ''}>
                      <option value="global" ${m.scope === 'global' ? 'selected' : ''}>${esc(t.scopeGlobalOption)}</option>
                      <option value="workspace" ${m.scope === 'workspace' ? 'selected' : ''}>${esc(t.scopeWorkspaceOption)}</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="modal-target-dir">${esc(t.targetDirLabel)}</label>
                    <input
                      id="modal-target-dir"
                      class="input"
                      type="text"
                      value="${esc(m.targetDirName)}"
                      placeholder="${esc(t.targetDirPlaceholder)}"
                      ${m.submitting ? 'disabled' : ''}
                    />
                  </div>
                </div>
                ${
                  m.scope === 'workspace'
                    ? `<div class="field" style="margin-top: 10px;">
                        <label for="modal-workspace-path">${esc(t.workspacePathLabel)}</label>
                        <input
                          id="modal-workspace-path"
                          class="input"
                          type="text"
                          value="${esc(m.workspacePath)}"
                          placeholder="${esc(t.workspacePathPlaceholder)}"
                          ${m.submitting ? 'disabled' : ''}
                        />
                      </div>`
                    : ''
                }
                <label class="checkbox-row" style="margin-top: 10px;">
                  <input id="modal-overwrite-check" type="checkbox" ${m.overwrite ? 'checked' : ''} ${m.submitting ? 'disabled' : ''} />
                  <span>${esc(t.overwriteLabel)}</span>
                </label>
              </div>`
            : ''
        }

        <div class="alert alert-warning">
          <span>${icons.info}</span>
          <div>
            <div class="alert-title">${esc(t.securityNoticeTitle)}</div>
            <div class="alert-body">${esc(t.securityNoticeBody)}</div>
          </div>
        </div>

        ${
          m.error
            ? `<div class="alert alert-danger">
                <span>${icons.info}</span>
                <div style="flex: 1;">
                  <div class="alert-body">${esc(m.error)}</div>
                  ${
                    m.errorCode === 'PLUGIN_EXISTS'
                      ? `<div style="margin-top: 8px;">
                          <button type="button" class="btn btn-sm btn-danger-soft" data-action="overwrite-retry">
                            ${esc(t.overwriteAndRetry)}
                          </button>
                        </div>`
                      : ''
                  }
                </div>
              </div>`
            : ''
        }

        <button
          id="modal-submit-btn"
          type="button"
          class="btn btn-primary btn-block"
          data-action="submit-install"
          ${!m.source.trim() || m.submitting ? 'disabled' : ''}
        >
          ${m.submitting ? `<span class="spinner"></span> ${esc(t.installing)}` : esc(t.installSubmit)}
        </button>
      </div>
    </div>
  `;
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const t = getMessages(state.locale);
  const filtered = getFilteredPlugins();

  root.innerHTML = `
    <div class="shell">
      <header class="header">
        <div class="header-title-group">
          <h1 class="header-title">${esc(t.title)}</h1>
          <p class="header-subtitle">${esc(t.subtitle)}</p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-sm" data-action="toggle-locale" title="Switch language">
            ${state.locale === 'zh' ? 'EN' : '中文'}
          </button>
          <button type="button" class="btn" data-action="toggle-workspace-bar" title="${esc(t.workspaceScanToggle)}">
            ${icons.folder}
            <span>${esc(t.workspaceScanToggle)}</span>
          </button>
          <button type="button" class="btn" data-action="refresh" ${state.refreshing ? 'disabled' : ''}>
            <span class="${state.refreshing ? 'spin' : ''}">${icons.refresh}</span>
            <span>${esc(t.refresh)}</span>
          </button>
          <button type="button" class="btn btn-primary" data-action="open-modal">
            ${icons.plus}
            <span>${esc(t.installPlugin)}</span>
          </button>
        </div>
      </header>

      ${
        state.showWorkspaceBar
          ? `<div class="workspace-bar">
              <input
                id="workspace-scan-input"
                class="input"
                type="text"
                value="${esc(state.workspacePath)}"
                placeholder="${esc(t.workspaceScanPlaceholder)}"
              />
              <button type="button" class="btn btn-primary" data-action="apply-workspace">${esc(t.workspaceScanApply)}</button>
            </div>`
          : ''
      }

      ${
        state.toast
          ? `<div class="toast ${state.toast.type === 'error' ? 'error' : ''}">
              <span>${esc(state.toast.text)}</span>
              <button type="button" class="btn btn-ghost btn-sm" data-action="dismiss-toast">${icons.close}</button>
            </div>`
          : ''
      }

      <div class="toolbar">
        <div class="segmented" role="tablist">
          <button type="button" class="segmented-btn ${state.filter === 'all' ? 'active' : ''}" data-action="set-filter" data-value="all">
            ${esc(t.filterAll)} <span class="count-pill">${state.counts.total}</span>
          </button>
          <button type="button" class="segmented-btn ${state.filter === 'user' ? 'active' : ''}" data-action="set-filter" data-value="user">
            ${esc(t.filterUser)} <span class="count-pill">${state.counts.global}</span>
          </button>
          ${
            state.counts.workspace > 0 || state.workspacePath
              ? `<button type="button" class="segmented-btn ${state.filter === 'workspace' ? 'active' : ''}" data-action="set-filter" data-value="workspace">
                  ${esc(t.filterWorkspace)} <span class="count-pill">${state.counts.workspace}</span>
                </button>`
              : ''
          }
          <button type="button" class="segmented-btn ${state.filter === 'builtin' ? 'active' : ''}" data-action="set-filter" data-value="builtin">
            ${esc(t.filterBuiltin)} <span class="count-pill">${state.counts.builtin}</span>
          </button>
        </div>

        <div class="search-group">
          <div class="input-wrap">
            <span class="input-icon">${icons.search}</span>
            <input
              id="plugin-search-input"
              class="input with-icon"
              type="search"
              value="${esc(state.search)}"
              placeholder="${esc(t.searchPlaceholder)}"
            />
          </div>
        </div>
      </div>

      ${
        state.loading
          ? `<div class="empty-state">
              <div class="empty-icon"><span class="spinner"></span></div>
              <p>${esc(t.loading)}</p>
            </div>`
          : filtered.length === 0
            ? `<div class="empty-state">
                <div class="empty-icon">${icons.package}</div>
                <h3>${esc(state.search ? t.emptySearchTitle : t.emptyTitle)}</h3>
                <p>${esc(state.search ? t.emptySearchDesc : t.emptyDesc)}</p>
                ${
                  !state.search
                    ? `<button type="button" class="btn btn-primary" data-action="open-modal">
                        ${icons.plus}
                        <span>${esc(t.installPlugin)}</span>
                      </button>`
                    : ''
                }
              </div>`
            : `<section class="plugin-grid">${filtered.map(renderPluginCard).join('')}</section>`
      }
    </div>
    ${renderModal()}
  `;

  bindEvents();
}

function bindEvents() {
  const root = document.getElementById('app');
  if (!root) return;

  // Search input — update list without losing focus
  const searchInput = document.getElementById('plugin-search-input') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.search = searchInput.value;
      const pos = searchInput.selectionStart;
      render();
      const next = document.getElementById('plugin-search-input') as HTMLInputElement | null;
      if (next) {
        next.focus();
        if (pos !== null) next.setSelectionRange(pos, pos);
      }
    });
  }

  // Modal primary source input — keep focus & IME smooth
  const modalSourceInput = document.getElementById('modal-source-input') as HTMLInputElement | null;
  if (modalSourceInput) {
    let lastDetected = classifySourceClient(state.modal.source, state.modal.sourceType);
    modalSourceInput.addEventListener('input', () => {
      state.modal.source = modalSourceInput.value;
      const nextDetected = classifySourceClient(state.modal.source, state.modal.sourceType);

      const submitBtn = document.getElementById('modal-submit-btn') as HTMLButtonElement | null;
      if (submitBtn) {
        submitBtn.disabled = !state.modal.source.trim() || state.modal.submitting;
      }

      // Only re-render full modal when the detected source category actually changes
      if (nextDetected !== lastDetected) {
        lastDetected = nextDetected;
        const pos = modalSourceInput.selectionStart;
        render();
        const nextInput = document.getElementById('modal-source-input') as HTMLInputElement | null;
        if (nextInput) {
          nextInput.focus();
          if (pos !== null) nextInput.setSelectionRange(pos, pos);
        }
      }
    });
    modalSourceInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && state.modal.source.trim() && !state.modal.submitting) {
        ev.preventDefault();
        void submitInstall(false);
      }
    });
  }

  // Secondary modal inputs
  const bindText = (id: string, setter: (v: string) => void) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.addEventListener('input', () => setter(el.value));
    }
  };
  bindText('modal-ref-input', (v) => {
    state.modal.ref = v;
  });
  bindText('modal-subpath-input', (v) => {
    state.modal.subpath = v;
  });
  bindText('modal-custom-registry', (v) => {
    state.modal.customRegistry = v;
  });
  bindText('modal-target-dir', (v) => {
    state.modal.targetDirName = v;
  });
  bindText('modal-workspace-path', (v) => {
    state.modal.workspacePath = v;
  });
  bindText('workspace-scan-input', (v) => {
    state.workspacePath = v;
  });

  const registrySelect = document.getElementById('modal-registry-select') as HTMLSelectElement | null;
  if (registrySelect) {
    registrySelect.addEventListener('change', () => {
      state.modal.registryPreset = registrySelect.value as 'official' | 'npmmirror' | 'custom';
      render();
    });
  }

  const localModeSelect = document.getElementById('modal-local-mode') as HTMLSelectElement | null;
  if (localModeSelect) {
    localModeSelect.addEventListener('change', () => {
      state.modal.localMode = localModeSelect.value as LocalInstallMode;
      render();
    });
  }

  const scopeSelect = document.getElementById('modal-scope-select') as HTMLSelectElement | null;
  if (scopeSelect) {
    scopeSelect.addEventListener('change', () => {
      state.modal.scope = scopeSelect.value as InstallScope;
      render();
    });
  }

  const overwriteCheck = document.getElementById('modal-overwrite-check') as HTMLInputElement | null;
  if (overwriteCheck) {
    overwriteCheck.addEventListener('change', () => {
      state.modal.overwrite = overwriteCheck.checked;
    });
  }

  // Delegated click handler
  root.onclick = (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    if (target.dataset.action === 'backdrop-close') {
      closeModal();
      return;
    }

    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (!action || action === 'backdrop-close') return;

    switch (action) {
      case 'open-modal':
        openModal();
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'refresh':
        void refreshInventory();
        break;
      case 'toggle-locale':
        state.localeManual = true;
        state.locale = state.locale === 'zh' ? 'en' : 'zh';
        render();
        break;
      case 'toggle-workspace-bar':
        state.showWorkspaceBar = !state.showWorkspaceBar;
        render();
        break;
      case 'apply-workspace':
        void refreshInventory();
        break;
      case 'dismiss-toast':
        state.toast = null;
        render();
        break;
      case 'set-filter':
        state.filter = (actionEl.dataset.value as AppState['filter']) || 'all';
        render();
        break;
      case 'toggle-details': {
        const id = actionEl.dataset.id || '';
        if (state.expandedIds.has(id)) state.expandedIds.delete(id);
        else state.expandedIds.add(id);
        render();
        break;
      }
      case 'ask-uninstall':
        state.confirmUninstallId = actionEl.dataset.id || null;
        render();
        break;
      case 'cancel-uninstall':
        state.confirmUninstallId = null;
        render();
        break;
      case 'confirm-uninstall': {
        const plugin = state.plugins.find((p) => p.id === actionEl.dataset.id);
        if (plugin) void handleUninstall(plugin);
        break;
      }
      case 'reinstall': {
        const plugin = state.plugins.find((p) => p.id === actionEl.dataset.id);
        if (plugin) void handleReinstall(plugin);
        break;
      }
      case 'toggle-enabled': {
        const plugin = state.plugins.find((p) => p.id === actionEl.dataset.id);
        if (plugin) void handleToggleEnabled(plugin);
        break;
      }
      case 'set-source-type':
        state.modal.sourceType = (actionEl.dataset.value as SourceType) || 'auto';
        state.modal.error = null;
        state.modal.errorCode = null;
        render();
        break;
      case 'toggle-guide':
        state.modal.showGuide = !state.modal.showGuide;
        render();
        break;
      case 'toggle-advanced':
        state.modal.showAdvanced = !state.modal.showAdvanced;
        render();
        break;
      case 'fill-example': {
        const sample = actionEl.dataset.example || '';
        state.modal.source = sample;
        state.modal.error = null;
        state.modal.errorCode = null;
        render();
        const input = document.getElementById('modal-source-input') as HTMLInputElement | null;
        input?.focus();
        input?.select();
        break;
      }
      case 'submit-install':
        void submitInstall(false);
        break;
      case 'overwrite-retry':
        void submitInstall(true);
        break;
      case 'install-another':
        state.modal.source = '';
        state.modal.ref = '';
        state.modal.subpath = '';
        state.modal.targetDirName = '';
        state.modal.error = null;
        state.modal.errorCode = null;
        state.modal.success = null;
        render();
        break;
    }
  };
}

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.modal.open && !state.modal.submitting) {
    closeModal();
  }
});

function applyHostContext(ctx: ReturnType<App['getHostContext']>) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.locale && !state.localeManual) {
    state.locale = detectLocale(ctx.locale);
  }
}

// Register MCP App handlers BEFORE connect() so no initial notification is missed
app.ontoolinput = () => {
  state.loading = true;
  render();
};

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Partial<InventoryPayload> | undefined;
  if (sc) {
    applyInventory(sc);
    if (sc.lastInstall?.ok) {
      const t = getMessages(state.locale);
      showToast('success', `${t.toastInstalled}: ${sc.lastInstall.plugin.displayName}`);
    }
    if (sc.openModal || sc.initialSource) {
      openModal(sc.initialSource || '');
      return;
    }
  } else {
    state.loading = false;
  }
  render();
};

app.ontoolcancelled = () => {
  state.loading = false;
  state.modal.submitting = false;
  render();
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
  render();
};

async function bootstrap() {
  render();
  try {
    await app.connect();
    applyHostContext(app.getHostContext());
    render();
    // If opened standalone without an immediate ontoolresult, proactively load inventory
    if (state.loading) {
      await refreshInventory();
    }
  } catch (err) {
    state.loading = false;
    showToast('error', err instanceof Error ? err.message : String(err));
    render();
  }
}

void bootstrap();
