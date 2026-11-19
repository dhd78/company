# dsh-task-dispatch

DSH Host 插件。白名单总管或调度以 fire-and-forget 方式向在册的顶层部长会话派送任务指针，并提供回执、进度报告、状态查询与可审计的本地台账。

- 版本：0.1.1
- 许可：MIT
- 运行环境：DSH 桌面 0.2.2-rc.1（宿主核心 44.7.0）、Node.js >= 24.21.0 < 25
- 形态：Host 插件 + 4 个 Agent 工具；无 Client 半、无 UI、无第三方运行时依赖

## 功能

- `dispatch_task`：按工号向在册顶层会话派工，写入台账后立即返回 `dispatchId`，不等待目标完成。
- `ack_task`：目标会话确认或拒绝派工，可附预计完成时间。
- `report_task`：目标会话报告进度（进行中、阻塞、待验收、完成、取消）与证据路径。
- `dispatch_status`：按 `taskId`、`dispatchId` 或部门查询状态、超期与证据。
- 台账以 `%DSH_HOME%/task-dispatch/dispatches.jsonl` 为权威，`index.json` 为派生索引，支持重启重建与坏行隔离。

## 安装

建议在测试 profile 中安装。

1. 将本包放入测试 profile 的 `node_modules/dsh-task-dispatch/`，或在源码目录执行 `npm pack` 后安装 tarball。
2. 在测试 profile 的 `cordis.patch.yml` 中加入：

   ```yaml
   - insert:
       - id: task-dispatch
         name: 'dsh-task-dispatch'
         config:
           rosterPath: roster.json
   ```

3. 在 `%DSH_HOME%/task-dispatch/` 下创建 `config.json` 与 `roster.json`（样例见下）。目录不存在时，插件启动时会创建。
4. 重启测试实例，确认 `dispatch_task`、`ack_task`、`report_task`、`dispatch_status` 四个工具已注册。

### 测试

```bash
node --version   # v24.21.0
node --test tests/unit.test.mjs tests/integration.test.mjs tests/regressions.test.mjs
```

默认 26 项中 23 项通过、3 项跳过；设置 `DSH_DISPATCH_INTEGRATION=1` 后 26 项全部通过。测试仅写入系统临时目录，不联网，不修改生产台账。

## 配置

### config.json

```json
{
  "version": 1,
  "timeZone": "Asia/Shanghai",
  "maxPayloadBytes": 102400,
  "whitelist": [
    { "sessionId": "<总管会话>", "employeeId": "A-001", "name": "派工者", "kind": "issuer" },
    { "sessionId": "<调度助理会话>", "employeeId": "A-002", "name": "调度助理", "kind": "assistant" },
    { "sessionId": "<质量会话>", "employeeId": "A-003", "name": "质控", "kind": "quality" }
  ],
  "rosterPath": "roster.json",
  "taskRoots": ["<任务包根绝对路径>"],
  "evidenceRoots": ["<证据根绝对路径>"],
  "mirror": { "enabled": false, "path": "<工作区>/03-任务/公司任务台账.md" },
  "wake": { "timeoutMs": 2000 }
}
```

默认值：`timeZone=Asia/Shanghai`（v0 仅支持该值）、`maxPayloadBytes=102400`、`whitelist=[]`、`rosterPath=roster.json`、`taskRoots`/`evidenceRoots` 为 `%DSH_HOME%/task-dispatch/`、`mirror.enabled=false`、`wake.timeoutMs=2000`。

白名单是唯一授权来源；`roster.json` 负责员工、会话与部门的对应关系。配置文件使用 UTF-8 编码，可带 BOM。

### roster.json

```json
{
  "version": 1,
  "employees": [
    {
      "employeeId": "B-101",
      "name": "部长",
      "department": "业务部",
      "sessionId": "<部长会话>",
      "roles": ["部长"],
      "enabled": true
    }
  ]
}
```

## 工具

### dispatch_task

```json
{
  "to": "B-101",
  "taskId": "TSK-20260101-01",
  "title": "实现样例任务",
  "priority": "P1",
  "deadline": "2026-11-20T18:00:00+08:00",
  "briefPath": "<任务包根>/brief.md",
  "acceptance": "单测全绿",
  "ackBy": "2026-11-19T18:00:00+08:00"
}
```

- 必填：`to`、`taskId`、`title`、`priority`（P0/P1/P2）、`deadline`、`briefPath`、`acceptance`；可选：`ackBy`、`dedupeKey`。
- `to` 为工号（如 `B-101`），`taskId` 形如 `TSK-20260101-01`。
- `deadline`/`ackBy` 接受 ISO-8601（含 `+08:00`、`Z`）或 `YYYY-MM-DD HH:mm`（按 +08:00 解释）；必须晚于当前时间，`ackBy` 缺省等于 `deadline` 且不得晚于 `deadline`。
- 服务端计算 `dedupeKey = taskId|targetSessionId`；入参 `dedupeKey` 必须与之一致，否则返回 `dedupe-key-mismatch`。
- 同 taskId 同目标重复派工返回原 `dispatchId` 与 `duplicate: true`，不重复唤醒；原记录为 `pending_wake`/`wake_failed` 时重新唤醒并返回 `retried: true`；同 taskId 换目标返回 `task-id-target-conflict`。
- 返回：

```json
{
  "ok": true,
  "dispatchId": "dsp_<ULID>",
  "taskId": "TSK-20260101-01",
  "dedupeKey": "TSK-20260101-01|<目标 sessionId>",
  "target": { "employeeId": "B-101", "name": "部长", "department": "业务部", "sessionId": "<目标 sessionId>" },
  "status": "delivered",
  "deliveredAt": "2026-11-19T12:00:00+08:00",
  "duplicate": false,
  "wake": { "attempted": true, "mode": "live", "settled": true }
}
```

### ack_task

```json
{ "taskId": "TSK-20260101-01", "ack": true, "note": "已收到", "eta": "2026-11-20T10:00:00+08:00" }
```

只有该派工的 `targetSessionId` 可以调用；非目标返回 `not-target`。`ack:false` 表示拒绝，不得携带 `eta`。重复确认或重复拒绝幂等返回 `duplicate:true`；拒绝后状态为 `rejected`（终态）。

```json
{ "ok": true, "taskId": "TSK-20260101-01", "dispatchId": "dsp_…", "status": "acked", "ackedAt": "2026-11-19T13:00:00+08:00", "eta": "2026-11-20T10:00:00+08:00", "duplicate": false }
```

### report_task

```json
{ "taskId": "TSK-20260101-01", "status": "进行中", "evidencePath": "<证据根>/proof.txt", "note": "开工" }
```

- `status`：`进行中`、`阻塞`、`待验收`、`完成`、`取消`。
- `evidencePath` 必须位于 `evidenceRoots` 内且不含 `..`，否则返回 `evidence-path-outside-root`；省略时沿用上一条证据路径。
- 状态机：`pending_wake → delivered → acked → in_progress ↔ blocked → pending_acceptance → done`；`delivered → rejected`；任意非终态可 `cancelled`；终态为 `done`/`cancelled`/`rejected`。非法迁移返回 `invalid-transition`，重复同一状态幂等返回 `duplicate:true`。

```json
{ "ok": true, "taskId": "TSK-20260101-01", "dispatchId": "dsp_…", "status": "in_progress", "updatedAt": "2026-11-19T14:00:00+08:00", "evidencePath": null, "duplicate": false }
```

### dispatch_status

```json
{ "taskId": "TSK-20260101-01" }
```

- 按 `taskId`、`dispatchId` 或 `department` 查询，至少提供一个条件；`limit` 为 1–200，默认 50。
- 返回 `{ ok, query, count, truncated, dispatches[] }`；`count` 为可见记录总数，`truncated` 表示是否被 `limit` 截断。
- 每条记录包含 `dispatchId`、`taskId`、`title`、`priority`、`status`、`derivedStatus`、`issuer`、`target`、`deliveredAt`、`ackedAt`、`updatedAt`、`deadline`、`ackBy`、`ackOverdue`、`deadlineOverdue`、`overdueSeconds`、`evidencePath`、`lastNote`。
- 截止时间已过且非终态时，`derivedStatus` 为 `expired`；超期字段每次查询计算，不回写台账、不触发升级。

## 数据与恢复

- 权威台账：`%DSH_HOME%/task-dispatch/dispatches.jsonl`；只追加完整记录快照，同一 `dispatchId` 以最后一行为准。
- 派生索引：`%DSH_HOME%/task-dispatch/index.json`；通过临时文件与 rename 更新，可由 JSONL 重建，不应手工修改。
- 坏行隔离：启动时把无法解析的行复制到 `dispatches.corrupt.jsonl`，不阻塞启动。
- 配置：`config.json`；花名册：`roster.json`；Markdown 镜像由 `mirror.enabled` 控制，默认关闭。
- 备份与恢复：停止测试实例，复制整个 `%DSH_HOME%/task-dispatch/`；恢复时放回目录并启动，索引会自动重建。
- 完整性校验：`清单.md` 列出逐文件字节数与 SHA256，可在包目录使用 `Get-FileHash` 或 `sha256sum` 校验。

## 权限

1. 调用者身份取自 `exec.agent.id`（或 `exec.agent.session.id`），为空返回 `unauthorized-caller`；不接受 `issuer` 参数。
2. `config.whitelist` 中 `kind=issuer|assistant` 可派工；`kind=quality` 只读；名单外返回 `unauthorized-issuer`。
3. 目标从 `roster.json` 按工号解析；未登记返回 `unknown-employee`，停用返回 `employee-disabled`。
4. 目标校验顺序：花名册启用 → 会话存在 → 非归档 → 顶层（非 subagent、无 parentSession、delegationDepth=0）→ 非调用者 → taskId 唯一。任一失败不写台账、不唤醒。
5. `briefPath` 归一化后必须位于 `taskRoots` 内且为存在的文件；`evidencePath` 必须位于 `evidenceRoots` 内且不含 `..`。
6. 唤醒消息使用 `kind=agent-message`、`form=relay`，`busMessageId` 与 `threadId` 为 `dispatchId`，`hop=0`；只包含任务指针、简报路径、验收摘要与回执入口。
7. 查询权限：调用者须在白名单内；`assistant`/`quality` 可见全部记录，`issuer` 仅见自己派发或作为目标的记录。
8. 错误仅返回稳定错误码与安全文案，不返回堆栈、密钥或花名册全量；日志仅记录工号、sessionId 与错误码。

## 限制

- v0 为单进程模型：同一 `DSH_HOME` 只运行一个实例；无跨进程锁、跨机同步、加密与 RBAC 管理界面。
- `config.json` 与 `roster.json` 在插件加载时读取；修改后需重启实例，v0 不支持热加载。
- 不支持 `dispatch_inbox`、自动升级、定时器、启动补扫、反向通知、UI/看板、批量派工、任务模板、依赖图、成本记录或 flow 联动。
- 派工目标必须是已存在、启用、顶层且未归档的会话；插件不会自动创建或恢复会话。
- 唤醒失败只记录 `wake_failed`，无消息重试队列；重新派工同一 taskId 可触发一次重试。
- 超期只计算，不通知、不回写 `status`；重启后按同一规则重算。
- 入参上限 100KB（可配 1KB–100KB）；单条台账记录上限 8KB；`notes` 总量上限 4096 字节（保留最新备注，必要时截断）；查询单页最多 200 条。
- Markdown 镜像为 best-effort，镜像失败只追加 `mirror-failed` 备注，不影响 JSONL。
- v0 不支持改派：同一 taskId 更换目标会被拒绝。
- `briefPath` 仅校验归一化后是否越出 `taskRoots`，不单独拒绝 `..`；`evidencePath` 拒绝任意 `..`。
- `wake.timeoutMs` 默认 2000ms，可配 100–30000ms，是唤醒调用的超时上限；`dispatch_task` 在写入台账与投递消息后立即返回。
- Windows x64 为实测平台；POSIX 平台未实测。

## 卸载与回滚

1. 停止测试实例。
2. 从测试 profile 删除插件目录及 `cordis.patch.yml` 中的 `task-dispatch` 条目。
3. 保留 `%DSH_HOME%/task-dispatch/`：台账、配置与花名册不随插件卸载删除。
4. 卸载后 `dispatches.jsonl` 可独立解析；清理前应先备份整个目录。

回滚时还原上一版本插件目录与 `config.json`/`cordis.patch.yml` 备份，保留台账，版本号只增不减。

## 故障排查

| 错误码 | 原因与处置 |
|---|---|
| `unauthorized-caller` | 宿主未提供 `exec.agent.id`。 |
| `unauthorized-issuer` | 调用者不在白名单，或 `quality` 角色尝试派工。 |
| `invalid-argument` | 参数格式、长度、时间或组合不合法。 |
| `unknown-employee` / `employee-disabled` | 检查 `roster.json` 中的工号、sessionId 与 enabled。 |
| `target-not-top-level` | 目标是子会话或 subagent；只能派给顶层会话。 |
| `target-archived` | 目标会话已归档。 |
| `target-session-missing` | 花名册中的会话不存在，或会话服务不可用。 |
| `target-is-caller` | 不能向调用者自身派工。 |
| `brief-path-outside-root` / `brief-file-missing` | 简报路径越出 `taskRoots`，或文件不存在。 |
| `payload-too-large` | 入参超过 100KB，或单条台账记录超过 8KB。 |
| `task-id-target-conflict` | 同一 taskId 已派给其他目标。 |
| `dedupe-key-mismatch` | 手工传入的 dedupeKey 与服务端计算值不一致。 |
| `wake-failed` | 目标无法解析，或 followup 失败/超时；检查 `wake.timeoutMs` 与目标会话状态。 |
| `unknown-task` / `unknown-dispatch` | taskId 或 dispatchId 不存在。 |
| `not-target` | 回执或报告者不是该派工目标。 |
| `invalid-transition` / `invalid-status` | 状态迁移或状态值不合法。 |
| `invalid-eta` | eta 不是合法时间。 |
| `evidence-path-outside-root` | evidencePath 越出 `evidenceRoots` 或包含 `..`。 |
| `unauthorized-viewer` / `invalid-query` / `invalid-limit` | 查询者无权限、未提供过滤条件，或 limit 不在 1–200。 |
| `internal-error` | 未预期异常；检查宿主日志与配置/花名册 JSON。 |

其他常见现象：

- 工具未出现：检查 `cordis.patch.yml` 条目、包是否位于测试 profile 的 `node_modules/dsh-task-dispatch/`，并重启实例。
- 启动后台账查不到：确认 `%DSH_HOME%` 与实例一致；`index.json` 会从 `dispatches.jsonl` 重建。
- JSONL 存在坏行：启动时会复制到 `dispatches.corrupt.jsonl`；修复前先备份台账目录。
- 派工成功但目标无响应：确认目标会话可唤醒，检查返回的 `wake.mode` 与回执截止时间。

## 兼容性与许可

- 仓库：https://github.com/dhd78/company/tree/dsh-task-dispatch
- 问题反馈：https://github.com/dhd78/company/issues
- DSH：桌面 0.2.2-rc.1（宿主核心 44.7.0）；`engines.dsh = 0.2.2-rc.1`。
- Node.js：`>=24.21.0 <25`；构建基线 pnpm 11.28.5。
- 依赖：无第三方运行时依赖，仅使用 Node.js 内置模块。
- 发布包：`npm pack` 生成的 tarball 包含 19 个文件（`package.json`、`index.js`、`lib/` 11 个模块、`cordis.patch.yml`、README、CHANGELOG、LICENSE、release-notes、`.gitignore`）；不包含 `tests/` 与 `清单.md`，测试请使用源码目录。
- 许可：MIT，详见 `LICENSE`。
