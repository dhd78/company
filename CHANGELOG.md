# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.1.2] - 2026-11-19

### Fixed

- 真实宿主工具调用中 `ctx.now()` 在非请求作用域抛错，导致 `dispatch_status`（仅按 `department` 查询时）返回“内部错误”。`nowMs` 现在捕获异常并回退到进程时钟。

### Added

- `tests/regressions.test.mjs` 新增 `T-FIX-03`：`ctx.now` getter/函数抛错时回退进程时钟。

### Notes

- 兼容性：无接口、配置或数据格式变更；建议从 0.1.1 升级。

## [0.1.1] - 2026-11-19

### Fixed

- `config.json` / `roster.json` 带 UTF-8 BOM 时无法加载的问题；读取后先去除 BOM 再解析。
- `notes` 累积导致单条台账记录超过 8KB 后任务无法更新的问题；现保留最新备注，总量上限 4096 字节，必要时截断。

### Changed

- 许可证确定为 MIT；`private: false`、`publishConfig.access = public`。
- 明确 `dispatch_task` 的返回时延口径：写入台账并投递消息后立即返回；`wake.timeoutMs` 默认 2000ms，可配置。

### Added

- `tests/regressions.test.mjs`：BOM 兼容与备注上限回归测试。

## [0.1.0] - 2026-11-19

### Added

- 4 个 Agent 工具：`dispatch_task`、`ack_task`、`report_task`、`dispatch_status`。
- 白名单派工、花名册解析、顶层会话校验、fire-and-forget 唤醒。
- JSONL 权威台账、原子派生索引、启动重建、坏行隔离与可选 Markdown 镜像。
- 幂等派工、状态机、超期派生、查询可见性控制。
- 配置与花名册加载、路径边界校验、Asia/Shanghai 时间处理。
- README、CHANGELOG、LICENSE、release-notes、清单与 `.gitignore`。

### Security

- 调用者身份取自 `exec.agent.id`，不接受自报身份。
- 白名单与查询范围控制；路径根目录校验；错误不包含堆栈、密钥或花名册全量。

### Tests

- 单元与回归测试 23 项默认通过，集成测试 3 项默认跳过；设置 `DSH_DISPATCH_INTEGRATION=1` 后 26 项全部通过。

## Notes

- 运行环境：DSH 桌面 0.2.2-rc.1（宿主核心 44.7.0）、Node.js >= 24.21.0 < 25。
- Windows x64 已实测；POSIX 平台未实测。
