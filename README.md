# Company DSH Plugins

公司运行所需的 DSH 插件集合。仓库按**插件分支**管理：每个插件位于独立分支，`main` 仅保留本目录与使用说明。

## 插件分支

| 插件 | 分支 | 版本 | 说明 |
|---|---|---|---|
| `dsh-task-dispatch` | [`dsh-task-dispatch`](https://github.com/dhd78/company/tree/dsh-task-dispatch) | 0.1.1 | 白名单任务派送：4 个 Agent 工具、顶层会话唤醒、JSONL 审计台账 |

## 使用

```bash
git clone -b dsh-task-dispatch https://github.com/dhd78/company.git dsh-task-dispatch
```

进入插件目录后，按该分支的 `README.md` 安装到 DSH 测试 profile。生产 profile 的插件变更应在测试实例验证后单独执行。

## 分支与发布约定

- 每个插件一个分支，分支名使用插件包名；后续插件按同一规则新增分支。
- 每个插件独立版本、独立 `README.md`、`CHANGELOG.md`、`LICENSE`、release-notes 与 `清单.md`。
- tag 格式：`<plugin>-v<version>`；当前 `dsh-task-dispatch-v0.1.1`。
- 插件包清单包含逐文件字节数与 SHA256；`npm pack` 生成的 tarball 不包含 `tests/` 与 `清单.md`。

## 许可

各插件以其分支下的 `LICENSE` 为准。`dsh-task-dispatch` 使用 MIT 许可。
