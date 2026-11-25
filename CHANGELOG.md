# Changelog

All notable changes to **Plugin Installer for Antigravity** are documented in this file.

## v1.1.0 (2026-11-26)

### Added
- 插件管理页面新增禁用 / 启用插件切换按钮（`role="switch"`），支持 `global`、`workspace` 与 `builtin` 作用域插件状态实时切换与中英双语显示。
- 新增仅 UI 可见的 MCP 工具 `app_set_plugin_enabled`，按插件目录名（`dir`）以串行原子写入方式同步 `~/.gemini/config/config.json`，完整保留 `userSettings`、`sidecars` 及其他插件配置项。
- 对齐 Antigravity v2.35.1 插件规范：支持 `.gemini-plugin/plugin.json`、`category` / `extensions` 清单字段、`sidecars` 组件识别、`ANTIGRAVITY_APP_DATA_DIR` 环境变量及 `agy` CLI 路径自动发现。
- 新增 4 层级端到端（E2E）自动化测试套件（`tests/e2e/`）与安全自保护测试。

### Fixed
- 修复插件在启用状态下点击更新报错“资源被锁定”的问题：更新前先拉取并校验候选版本，再自动禁用已启用插件并带 `EBUSY`/`EPERM` 退避重试完成原子备份替换；更新成功后，原本启用的插件自动恢复启用，原本禁用的插件保持禁用。
- 修复 `parseJsonc()` 未剥离 UTF-8 BOM（`\uFEFF`）导致无法解析带 BOM 的 `config.json` / `plugin.json` 的问题。
- 新增针对自身运行目录（`PLUGIN_ROOT`）的 `SELF_DISABLE_BLOCKED`、`SELF_UPDATE_BLOCKED`、`SELF_UNINSTALL_BLOCKED` 保护（兼容符号链接/Junction 与 Windows 盘符大小写）。
- 修复 `360px`–`440px` 窄侧边栏（`aux_pane`）与弹窗长名称/长链接下的横向溢出问题。
- 停止 Git 跟踪根目录开发规则文件 `AGENTS.md`（纳入 `.gitignore`），确保仓库发布版与本地安装副本通过 `agy plugin validate --strict` 严格校验。

## v1.0.0

antigrvity v1.0.0 正式发布
