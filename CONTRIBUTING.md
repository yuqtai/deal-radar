# 贡献说明

欢迎提交问题反馈、功能建议和 Pull Request！

## 提交 Issue

**反馈问题（Bug）请包含：**

- 运行方式：`bun run start` / `bun run dev` / Docker
- 环境：操作系统、Bun 版本（`bun --version`）
- 复现步骤与预期结果 / 实际结果
- 相关的服务端日志（启动终端里的输出，或 `docker compose logs`）
- 如涉及某个来源抓取失败，注明来源名称与页面上显示的错误信息

**功能建议请说明：**

- 想解决什么问题、使用场景是什么
- 期望的效果（可附截图或草图）

**新增数据源**：请附上 RSS / 接口地址，并说明该来源是否允许抓取。

> ⚠️ 请勿在 Issue、日志或截图中贴出你的 `XIZHI_KEY`、`OPENROUTER_API_KEY` 等密钥。

## 提交 Pull Request

1. Fork 本仓库并新建分支
2. 本地运行：`bun install && cp .env.example .env && bun run dev`
3. 提交前确保通过类型检查：`bun run typecheck`
4. 修改数据库结构时，在 `drizzle/` 下新增按序号命名的迁移文件（如 `0007_xxx.sql`），不要修改已有迁移
5. PR 描述里说明改了什么、为什么，涉及界面的请附截图
