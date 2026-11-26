# Changelog

All notable changes to **Plugin Installer for Antigravity** are documented in this file.

## v1.1.1 (2026-11-26)

### Changed
- 对齐只读配置规范：停止直接修改 `~/.gemini/config/config.json`（移除 `app_set_plugin_enabled` 与更新时自动禁用写入逻辑），改为只读读取插件启用状态，并提供 Antigravity 原生 Customizations（`customization://<dir>`）操作引导与直达链接。
- 更新单元测试与 4 层级端到端（E2E）测试套件（17 项单元测试 + 66 项 E2E 测试），覆盖只读配置引导、Windows 原地同步回滚及已禁用插件锁错误场景。

### Fixed
- 修复 Windows 环境下更新已禁用插件仍报资源锁定的问题：当 `language_server.exe` 目录监听器阻止 `fs.rename` 时，自动降级为安全的原地同步策略（`synchronizeDirInPlace`），在 `os.tmpdir()` 中保存备份并在失败时回滚，同时为辅助重命名操作增加 `renameWithRetry` 退避重试。
- 改进前后端文件锁错误处理：透传 `alreadyDisabled` 标记，对已禁用插件触发的锁冲突单独展示 `errFilesLockedDisabled` 及诊断详情，避免错误提示用户禁用本已禁用的插件。

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
