---
name: install-plugin
description: >-
  Open the interactive Plugin Installer UI or install an Antigravity plugin
  directly from a GitHub repository URL, an npm package name, or a local folder.
  Use when the user asks to install a custom plugin, open the plugin installer
  panel, or manage installed plugins.
---

# Install Plugin

Use this skill when the user wants to open the **Plugin Installer** UI or
install a third-party/local plugin from a GitHub URL, npm package, or local
directory path.

## Workflow

1. **Open the interactive UI**:
   - Call `plugin-installer_installer`'s `open_plugin_installer` tool when the
     user wants to browse installed plugins or open the `Install Plugin` modal.
   - If the user already provided a source (GitHub URL, npm package name, or
     local path) and wants to review options first, pass `initialSource` and
     `openModal: true` to `open_plugin_installer`.

2. **Direct installation from chat**:
   - If the user explicitly asks to install a specific GitHub URL, npm package,
     or local directory right away, call `install_plugin` with `source` (and
     optional `registry`, `ref`, `subpath`, `mode`, `overwrite`, or
     `workspacePath`).
   - Remind the user that newly installed plugins in `~/.gemini/config/plugins/`
     are discovered automatically by Antigravity without a restart, and can be
     enabled or disabled directly from the **Plugin Installer** UI or the native
     **Customizations** page using `[<name>](customization://<dir>)`.

3. **Safety guardrails**:
   - Never suggest or run commands that manually hand-edit `~/.gemini/config/config.json`.
   - Always verify the source with the user if it comes from an untrusted or
     ambiguous origin.
