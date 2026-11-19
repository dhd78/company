# dsh-task-dispatch 0.1.1 发布说明

- 版本：0.1.1
- 许可：MIT
- 形态：DSH Host 插件 + 4 个 Agent 工具；无 Client 半、无 UI
- 运行环境：DSH 桌面 0.2.2-rc.1（宿主核心 44.7.0）、Node.js >= 24.21.0 < 25

## 一、变更

- 修复 `config.json` / `roster.json` 带 UTF-8 BOM 时无法加载的问题。
- 修复 `notes` 累积导致单条台账记录超过 8KB 后任务无法更新的问题；备注总量上限 4096 字节。
- 许可证确定为 MIT；包元数据设置为公开发布（`private: false`、`publishConfig.access = public`）。
- 明确 `dispatch_task` 返回时延口径：写入台账并投递消息后立即返回；`wake.timeoutMs` 默认 2000ms，可配置。
- 新增 `tests/regressions.test.mjs`，覆盖 BOM 兼容与备注上限。

## 二、兼容性

| 项 | 要求 |
|---|---|
| DSH 桌面 | 0.2.2-rc.1（宿主核心 44.7.0）；`engines.dsh = 0.2.2-rc.1` |
| Node.js | >= 24.21.0 < 25；构建基线 24.21.0 |
| pnpm | 11.28.5（构建基线；无第三方运行时依赖） |
| 平台 | Windows x64 已实测；POSIX 未实测 |
| Host 服务 | `tools`、`sessionQuery`、`agents`、`sessionController` |
| Client 半 | 无 |
| 数据格式 | `schemaVersion=1`；JSONL 每行一条完整记录，索引可重建 |

## 三、安装

1. 在源码目录执行 `npm pack`，或把包目录复制到测试 profile 的 `node_modules/dsh-task-dispatch/`。
2. 在测试 profile 的 `cordis.patch.yml` 中加入 `task-dispatch` 条目。
3. 在 `%DSH_HOME%/task-dispatch/` 创建 `config.json` 与 `roster.json`；配置样例见 README。
4. 重启测试实例，确认 4 个工具已注册。

安装前备份原有的 `config.json` 与 `cordis.patch.yml`，并保留上一版本目录作为回滚点。

## 四、卸载

1. 停止测试实例。
2. 删除测试 profile 中的插件目录及 `cordis.patch.yml` 中的 `task-dispatch` 条目。
3. 保留 `%DSH_HOME%/task-dispatch/`：台账、配置与花名册不随插件卸载删除。
4. 卸载后 `dispatches.jsonl` 可独立解析；清理前先备份整个目录。

## 五、已知限制

- v0 为单进程模型：同一 `%DSH_HOME%` 只运行一个实例；无跨进程锁、跨机同步、加密与 RBAC 管理界面。
- 配置与花名册在插件加载时读取，修改后需重启。
- 不支持 inbox、自动升级、定时器、启动补扫、反向通知、UI、批量派工、任务模板、依赖图、成本记录或 flow 联动。
- 派工目标必须是已存在、启用、顶层且未归档的会话；不自动创建或恢复会话。
- 唤醒失败只记录 `wake_failed`，无消息重试队列；重新派工同一 taskId 可触发一次重试。
- 超期只计算，不通知、不回写状态。
- 入参上限 100KB；单条台账记录上限 8KB；备注总量上限 4096 字节；查询单页最多 200 条。
- `briefPath` 仅校验归一化后是否越出任务根目录；`evidencePath` 拒绝任意 `..`。
- 无改派：同一 taskId 更换目标会被拒绝。

## 六、回滚

还原上一版本插件目录与 `config.json` / `cordis.patch.yml` 备份，保留台账目录；版本号只增不减。

## 七、验证

- 测试：默认 23 项通过、3 项跳过；开启集成后 26 项全部通过。
- 清单：23 个对象文件逐文件字节数与 SHA256 校验通过。
- 真实实例：非活跃顶层会话唤醒、卸载/重启后台账保留均通过。

## 八、许可

MIT，详见 `LICENSE`。
