# 每日优惠情报

多来源羊毛 / 优惠聚合：自动从 V2EX、NodeSeek、LINUX DO、小众软件等 6 个来源抓取最新优惠，**AI 打价值分、自动分类、生成排行榜**，值得看的新优惠通过微信推送给你。

- 🗂 聚合 6 个来源，去重，只保留近 7 天，按发布时间排序
- 🤖 AI 价值评分（0~100）+ AI 分类（12 类），「AI 排行榜」一眼看出最值的羊毛
- 🔎 搜索、按来源 / 类别筛选，讨论帖和交易帖默认隐藏
- ✅ 标记已领、收藏，刷新不会覆盖
- 📮 微信推送：只推高价值的，不重复，夜间静默
- 🪶 单进程 + SQLite，一条命令跑起来；AI 和推送都可选、都用免费服务

---

## 快速开始（3 分钟）

**前置**：安装 [Bun](https://bun.sh/) ≥ 1.3

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
# Windows（PowerShell）
powershell -c "irm bun.sh/install.ps1 | iex"
```

**运行**：

```bash
git clone <你的仓库地址> mei-ri-you-hui-qing-bao
cd mei-ri-you-hui-qing-bao
bun install
cp .env.example .env      # 可选：填入推送 / AI 的 Key，不填也能跑
bun run start
```

打开 <http://localhost:3000> ，首次打开会自动抓取一轮（十几秒）。之后每 2 小时自动刷新，也可以点「立即刷新」。

> 不配置任何 Key 时：抓取、浏览、筛选、收藏都能用；AI 评分、排行榜和微信推送会自动关闭，分类退回关键词规则。

### 用 Docker 部署（服务器长期运行）

```bash
cp .env.example .env      # 按需填写
docker compose up -d --build
```

数据保存在 `./data/`，升级时 `git pull && docker compose up -d --build` 即可，数据不丢。

---

## 配置

所有配置都写在根目录 `.env`（参考 [`.env.example`](.env.example)），**全部可选**：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `XIZHI_KEY` | 息知微信推送 Key（开启推送） | 空 |
| `OPENROUTER_API_KEY` | OpenRouter Key（开启 AI 评分 / 分类 / 排行榜） | 空 |
| `OPENROUTER_MODEL` | AI 决策模型 | `parallel/decisions-fast:free` |
| `PORT` | 端口 | `3000` |
| `DATA_DIR` | 数据目录（SQLite） | `./data` |
| `REFRESH_INTERVAL_MINUTES` | 自动刷新间隔，`0` 关闭 | `120` |
| `PUSH_QUIET_HOURS` | 推送静默时段（北京时间），`off` 关闭 | `23-8` |

修改 `.env` 后重启服务生效。启动时 Key 会写入数据库 `app_settings` 表，服务端只从那里读取，**永远不会发到前端**。

### 获取微信推送 Key（息知，免费）

1. 微信关注公众号「息知」，点底部「消息推送」，自动回复里就有你的专属 Key；也可以在 <https://xz.qqoq.net/> 扫码登录后，在「我的」页面查看。
2. 填到 `.env` 的 `XIZHI_KEY=`。只填 `XZ` 开头的 Key 本身，不要填整个 `https://xizhi.qqoq.net/xxx.send` 地址。
3. 重启后点页面右上角「测试推送」，微信收到就说明接通了。

### 获取 AI Key（OpenRouter，免费模型）

1. 在 <https://openrouter.ai/keys> 注册并创建 Key（`sk-or-v1-` 开头）。
2. 填到 `.env` 的 `OPENROUTER_API_KEY=`，重启即可。默认模型免费，不需要充值。

---

## 功能说明

### 数据源

| 来源 | 方式 |
| --- | --- |
| V2EX 推广 | RSS `https://www.v2ex.com/feed/promotions.xml` |
| NodeSeek | RSS `https://rss.nodeseek.com/` |
| 小众软件 | RSS `https://www.appinn.com/feed/` |
| 果核剥壳 | RSS `https://www.ghxi.com/feed` |
| 异次元软件世界 | RSS `https://www.iplaysoft.com/feed` |
| LINUX DO 福利羊毛 | 直连会被 Cloudflare 拦截（403），改走 [Jina Reader](https://jina.ai/reader) 代理 `https://r.jina.ai/https://linux.do/c/welfare/36.rss`，并带请求头 `X-Return-Format: html` 让它原样返回 RSS，这样能拿到正文摘要 |

单个来源失败不影响其他来源，页面上会如实显示每个来源的状态。来源定义在 `server/src/actions.ts` 的 `SOURCES` 数组，加一个 RSS 源只需加一行。

### AI 评分与分类（`server/src/ai.ts`）

- 用 OpenRouter 的**决策模型**。它**不走** `chat/completions`，而是调 `POST https://openrouter.ai/api/alpha/decisions`：
  - `score` 题型：两条标准分别描述「低价值」和「高价值」，返回 0~1 的分数。
  - `choice` 题型：在 12 个类别里单选，返回类别和置信度。
  - 每条帖子在同一请求里同时打分和分类，每批 8 条，3 路并发。
- **分档**：≥40 高价值、≥30 值得看、≥15 一般，其余价值低。这个模型整体给分偏低，阈值是按实测分布校准的。
- **类别**：免费白嫖、限免、低价优惠、会员订阅、游戏、AI 相关、VPS/云服务、代理/机场、软件工具、交易/求购、讨论/资讯、其他。
  - 分类置信度不够时，退回关键词规则。
  - 标题特征明确的交易帖（出 / 收 / 求开头）和讨论帖（问句结尾），以规则为准。

### 微信推送（`server/src/actions.ts`）

- **推哪些**：每轮刷新后，从近 24 小时内还没推过、未领、未过期的条目里挑。
  - 有 AI 分时，要求 AI 分 ≥30。
  - 没有 AI 分时，用关键词打分。
  - 硬排除：交易帖、讨论帖、自荐、中转、代充类帖子。
- **推多少**：每次最多 8 条，按价值排序；同一条永不重复推，同标题的重复帖只推一条。
- **失败与静默**：推送失败的下一轮自动补推；静默时段（默认 23:00–08:00）内不推，积压到早上一起推。
- **通知标题**：`🔥 <最值得看的那条> 等 N 条优惠`，在通知栏不点开也能判断。

---

## 项目结构

```
client/                 前端（React 19 + TanStack Query + Tailwind CSS v4）
  src/App.tsx           主界面：列表、AI 排行榜、筛选、卡片
server/src/
  actions.ts            服务端动作：抓取、解析、分类、推送、仪表盘
  ai.ts                 AI 评分与分类（OpenRouter decisions）
  schema.ts             数据表定义（Drizzle ORM）
drizzle/                数据库迁移 SQL（启动时自动按顺序执行）
standalone/
  server.ts             独立运行服务：HTTP + SQLite + 迁移 + 定时刷新
  space-sdk/            @hatch/space-sdk 的本地实现（见下文「关于 Muse」）
Dockerfile / docker-compose.yml
```

### 常用命令

```bash
bun run start       # 生产模式启动
bun run dev         # 开发模式（改代码自动重载）
bun run typecheck   # 类型检查
```

### 关于 Muse / `@hatch/space-sdk`

本项目最初是在 Muse 的 Web Artifact（TypeScript Space）运行时上写的，业务代码通过 `@hatch/space-sdk` 调用服务端动作和数据库。为了能脱离那个平台独立运行，仓库在 `standalone/space-sdk/` 里提供了这个 SDK 的本地实现，`package.json` 默认就指向它，**普通用户不需要关心这一点**。

如果你确实要部署回 Muse，把 `package.json` 里的 `@hatch/space-sdk` 改回平台提供的路径即可。`space.json` 里已经声明了每 2 小时刷新的托管定时任务。

---

## 常见问题

**Q：LINUX DO 显示「异常」？**
这个来源依赖 Jina Reader 免费服务，偶尔会被限流，下一轮会自动重试。

**Q：「测试推送」失败？**
检查 `.env` 里的 `XIZHI_KEY` 是不是只填了 Key 本身，改完要重启服务。

**Q：AI 排行榜是空的？**
确认填了 `OPENROUTER_API_KEY` 并重启了服务。已有条目可以点筛选栏上方的「N 条待 AI 评分」手动补评。

**Q：端口被占用？**
在 `.env` 里改 `PORT=3001`。

**Q：怎么清空数据重来？**
停掉服务后删除 `data/` 目录，再重新启动。

---

## 社区

问题反馈与功能建议请使用 [GitHub Issues](../../issues)，填写要求见 [贡献说明](CONTRIBUTING.md)。

感谢 [LINUX DO](https://linux.do/) 社区提供开放、友善的技术交流平台。

---

## 许可证与免责声明

代码以 [MIT License](LICENSE) 开源。

本项目仅供个人学习与自用。各数据源内容的版权归原站所有，请遵守各站点的使用条款，合理设置抓取频率。
