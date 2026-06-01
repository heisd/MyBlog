# MyBlogAboutWeb

一个已经完成线上部署的个人博客项目，展示机器人、视觉与嵌入式 AI 相关内容。

当前线上架构：

- 前端部署在 `Vercel`
- 后端部署在 `Render`
- 数据库存储在 `Supabase`

## 架构图

```mermaid
flowchart TD
    U[用户 / 浏览器 / 手机]
    GH[GitHub Repository]
    VE[Vercel Frontend]
    RE[Render Backend]
    DB[(Supabase projects 表)]

    U --> VE
    VE -->|HTTPS /api/projects| RE
    RE -->|CRUD| DB

    GH -->|自动部署| VE
    GH -->|自动部署| RE
```

## 请求链路

```mermaid
sequenceDiagram
    participant User as 用户
    participant Frontend as Vercel 前端
    participant Backend as Render 后端
    participant Supabase as Supabase 数据库

    User->>Frontend: 打开 /projects 或 /admin
    Frontend->>Backend: 请求 /api/projects
    Backend->>Supabase: 查询 / 新增 / 更新 / 删除
    Supabase-->>Backend: 返回数据
    Backend-->>Frontend: 返回 JSON
    Frontend-->>User: 渲染页面
```

## 项目说明

这个项目最初使用本地 `projects.json` 作为数据源，现已切换为 `Supabase` 数据库，支持线上读取、创建、编辑和删除项目内容。

页面包含：

- 首页
- 项目列表页
- 项目详情页
- 在线留言页（联系页）
- 后台登录页
- 后台管理页

## 项目结构

```text
ClaudeAboutWeb/
├── index.html
├── server.js
├── package.json
├── .env.example
├── vercel.json
├── data/
│   ├── projects.json
│   └── projects-import.csv
└── public/
    ├── index.html
    ├── projects.html
    ├── project-detail.html
    ├── contact.html
    └── admin.html
```

## 技术栈

- `Express`
- `Supabase`
- `Vercel`
- `Render`
- `HTML / CSS / JavaScript`

## 页面路由

- `/`：博客首页
- `/projects`：项目列表页
- `/project/:id`：项目详情页
- `/contact`：在线留言页（访客可直接给站长发消息）
- `/admin`：后台管理页
- `/admin-login`：后台登录页

`Vercel` 通过 [`vercel.json`](C:/Users/86151/Desktop/ClaudeCode/ClaudeAboutWeb/vercel.json) 将这些路由重写到静态页面：

- `/projects` -> `/projects.html`
- `/admin` -> `/admin.html`
- `/project/:id` -> `/project-detail.html?id=:id`

## API 端点

后端由 `Render` 托管，接口包括：

| 方法       | 路径                  | 功能             |
| ---------- | --------------------- | ---------------- |
| `GET`    | `/api/projects`     | 获取项目列表     |
| `GET`    | `/api/projects/:id` | 获取单个项目详情 |
| `POST`   | `/api/projects`     | 新建项目         |
| `PUT`    | `/api/projects/:id` | 更新项目         |
| `DELETE` | `/api/projects/:id` | 删除项目         |
| `POST`   | `/api/uploads/image` | 上传封面/正文图片（需登录），返回公开链接 |
| `POST`   | `/api/uploads/video` | 上传演示视频（需登录），返回公开链接 |
| `POST`   | `/api/uploads/document` | 导入 MD/Word/PDF（需登录），解析为正文 HTML 并返回目录/摘要/标题 |
| `POST`   | `/api/contact`      | 提交留言并邮件通知站长 |

## 在线留言（联系页）

访客在 `/contact` 页面填写称呼、邮箱（选填）和留言内容后，前端会调用 `POST /api/contact`，后端把留言邮件发送到 `CONTACT_TO`（默认 `2284610019@qq.com`）。

发信方式支持两种，**优先使用 Resend**：

| 方式 | 触发条件 | 说明 |
| --- | --- | --- |
| **Resend HTTP API（推荐）** | 配置了 `RESEND_API_KEY` | 走 HTTPS，**绕过 Render 免费版对 SMTP 端口的封锁**，零成本 |
| SMTP（备选） | 未配 Resend，但配了 `SMTP_USER`/`SMTP_PASS` | Render **免费实例已封禁出站 SMTP 端口**，需付费实例才可用 |

> ⚠️ **重要**：Render 自 2025-09-26 起，免费 Web 服务封禁了出站 SMTP 端口（25/465/587），所以免费实例上 SMTP 一定连接超时。免费方案请用 Resend。

### 用 Resend（免费）

1. 到 [resend.com](https://resend.com) 注册（建议直接用你的收件 QQ 邮箱注册）
2. 创建一个 **API Key**
3. 在 Render 后端服务的环境变量里加：
   ```env
   RESEND_API_KEY=re_xxxxxxxx
   RESEND_FROM=MyBlog <onboarding@resend.dev>
   ```
4. 重新部署即可。没有自有域名时用默认的 `onboarding@resend.dev` 发信，**只能发到你 Resend 账号的邮箱**——而本场景的收件人正是站长本人，所以够用。若以后要发给任意地址，在 Resend 验证一个自有域名再把 `RESEND_FROM` 换成该域名地址即可。

### 其它行为

- 收件箱：由 `CONTACT_TO` 控制，默认 `2284610019@qq.com`
- 频率限制：同一 IP 每小时最多发送 5 条（仅统计**成功**发送）
- 访客填了邮箱时，邮件带 `Reply-To`，方便直接回复
- 两种方式都没配时接口返回 503，前端自动降级为 `mailto:` 链接，访客仍可一键用邮件联系；发送失败返回 502，同样有 `mailto:` 兜底

## CORS 跨域配置

前端（Vercel）与后端（Render）不同源，后端通过环境变量 `CORS_ORIGIN` 控制允许访问的前端域名。若页面出现 `Not allowed by CORS`，说明当前访问的域名不在白名单里。

- 多个域名用英文逗号隔开，**不要带结尾斜杠**（如 `https://xxx.vercel.app/` 会匹配失败）
- 匹配**忽略大小写并自动去掉结尾斜杠**，避免常见的格式踩坑
- 支持 `*` 通配符：配一条 `https://*.vercel.app` 即可同时覆盖正式域名和所有 Vercel **预览部署**域名（预览 URL 每个分支都不同）
- `CORS_ORIGIN` 留空表示放行所有来源（仅建议本地开发使用）

示例：

```env
CORS_ORIGIN=https://your-frontend-domain.vercel.app,https://*.vercel.app
```

## Supabase 数据表

项目数据存储在 `projects` 表中，推荐结构如下：

```sql
create table projects (
  id text primary key,
  title text not null,
  date date,
  summary text,
  "coverImage" text,
  "videoUrl" text,
  content text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
```

如果你的 `projects` 表是在加入视频功能之前创建的，请对线上数据库执行下面的迁移补上 `videoUrl` 列，否则项目列表、新增、编辑接口会返回 500：

```sql
alter table projects add column if not exists "videoUrl" text;
```

## 本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

参考 [`.env.example`](C:/Users/86151/Desktop/ClaudeCode/ClaudeAboutWeb/.env.example)：

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-secret-key
CORS_ORIGIN=https://your-frontend-domain.vercel.app,https://*.vercel.app
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
ADMIN_SESSION_SECRET=change-this-random-secret
PORT=3000

# 在线留言邮件发送（联系页）
CONTACT_TO=2284610019@qq.com
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-account@qq.com
SMTP_PASS=your-smtp-authorization-code
CONTACT_FROM=your-account@qq.com
```

### 3. 启动服务

```bash
node server.js
```

浏览器访问：

```text
http://localhost:3000
```

## 部署说明

### 前端部署到 Vercel

1. 将项目推送到 GitHub
2. 在 `Vercel` 中导入仓库
3. `Application Preset` 选择 `Other`
4. 部署完成后得到前端域名

### 后端部署到 Render

1. 在 `Render` 中创建 `Web Service`
2. 连接同一个 GitHub 仓库
3. 构建命令使用：

```bash
npm install
```

4. 启动命令使用：

```bash
node server.js
```

5. 在 `Environment Variables` 中添加：

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-secret-key
CORS_ORIGIN=https://your-frontend-domain.vercel.app,https://*.vercel.app
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
ADMIN_SESSION_SECRET=change-this-random-secret
NODE_ENV=production
CONTACT_TO=2284610019@qq.com
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-account@qq.com
SMTP_PASS=your-smtp-authorization-code
CONTACT_FROM=your-account@qq.com
```

### 数据库部署到 Supabase

1. 创建 `Supabase` 项目
2. 新建 `projects` 表
3. 导入项目数据
4. 在 `Render` 中配置 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`

## 当前说明

- 前端已经适配线上 `Render` API 地址
- 后端已经切换到 `Supabase`
- `projects.json` 现在主要作为初始数据参考，不再是线上正式数据源
- 已实际验证后台新增、编辑、删除可以写入 `Supabase`
- 后台新增了用户名密码登录保护，未登录不能执行创建、修改、删除操作
- 后台现在支持上传本地视频文件，视频会进入 `Supabase Storage`
- 后台封面图片支持两种方式：粘贴外链，或直接上传本地图片（≤ 8MB，存入 `Supabase Storage` 的 `project-covers` 桶并自动回填链接，带预览）
- 正文编辑支持「上传图片插入正文」：可一次多选，上传后在光标处依次插入 `<img>` 标签（复用同一图片上传接口）
- 正文编辑支持「导入文档」：上传 `.md/.markdown/.txt/.docx/.pdf`，后端用 `marked`（Markdown）、`mammoth`（Word）、`pdf-parse`（PDF）解析为正文 HTML，自动提取**目录**（h1–h3 生成带锚点的 TOC）、**摘要**（首段）与**标题**（首个标题），标题/摘要仅在为空时自动填入，文档本身不入库

## 性能与可用性：冷启动与前端重试

### 问题：Render 免费实例会休眠

后端部署在 `Render` 免费套餐上，**闲置约 15 分钟后实例会被自动休眠（spin down）**。下次有人访问时，需要先把整个服务重新拉起来，这个**冷启动过程约 30~60 秒**。在这期间：

- 项目归档页请求 `GET /api/projects` 会超时或被网关返回 5xx → 显示「加载项目失败」
- 留言页 `POST /api/contact` 迟迟没有响应 → 卡在「发送中…」

这不是代码 bug，而是免费套餐的固有行为。下面用两条互补的手段缓解。

### 方案一：保活（外部定时 ping）

用一个免费监控服务（如 [UptimeRobot](https://uptimerobot.com)、[cron-job.org](https://cron-job.org)）**每 5~10 分钟** GET 一次健康检查端点，让实例保持唤醒、基本不再休眠：

```text
GET https://<你的后端域名>.onrender.com/healthz
```

`/healthz` 是专门为此新增的**轻量端点**：只返回 `{ status, uptime, timestamp }`，**不访问数据库**，所以保活 ping 既廉价又不会打扰正常业务。

### 方案一·补充：数据库（Supabase）保活

Supabase **免费项目闲置约 7 天会自动暂停（Paused）**，暂停后所有数据库请求都失败（项目列表加载不出来）。同样可以用定时访问来保活——为此提供了一个会**轻量查询数据库**的端点：

```text
GET https://<你的后端域名>.onrender.com/healthz/db
```

它执行一次 `select id from projects limit 1`，产生数据库活动让 Supabase 不进入休眠；成功返回 `{ status:"ok", db:"ok" }`，失败返回 503。

**推荐做法**：把 UptimeRobot 的监控地址直接设成 `/healthz/db`（每 5~10 分钟一次）。这一个地址就能**同时保活后端实例（被唤醒）和数据库（产生查询）**，省去单独再配一个监控。

> ⚠️ 注意：
> - 若项目**当前已是 Paused 状态**，保活无法自动唤醒它，需先到 [supabase.com](https://supabase.com) 手动点 **Restore** 恢复，之后保活才能防止它再次休眠。
> - 这是规避免费版限制的实践做法；Supabase 的休眠策略未来可能调整。要彻底免休眠可升级 Supabase Pro。
> - 也可用 GitHub Actions 定时任务直接查询 Supabase REST API 来保活，效果相同。

### 方案二：前端重试 + 唤醒提示（已实现）

即便偶尔遇到冷启动，前端也不会直接报错，而是自动重试到服务唤醒。项目归档页与留言页都接入了统一的 `fetchWithWake()`：

- **重试触发条件**：仅当 `fetch` 抛出网络错误/超时，或响应是 `502/503/504` **且响应体不是我们的 JSON**（即 Render 网关的冷启动错误页）时，才判定为冷启动并重试；
- **退避序列**：`1.5s → 2.5s → 4s → 6s → 8s → 10s`，最多 6 次，约覆盖 30~40 秒的冷启动窗口；
- **唤醒提示**：重试期间通过 `onWaking` 回调显示「服务器正在唤醒，请稍候…（第 N 次重试）」，而不是直接显示失败；
- **关键设计**：留言接口 `/api/contact` 会**主动**返回带 JSON 的 `503`（未配置 SMTP）和 `502`（发送失败），这些是有效响应，必须按原样处理。因此重试判定要求「响应体不是 JSON」，避免把这些有效响应误判为冷启动而反复重试、延误 `mailto:` 兜底。

> 实现位置：`/healthz` 在 `server.js`；`fetchWithWake()` 分别内联在 `public/projects.html` 与 `public/contact.html` 的脚本中。

## 后续可优化方向

- 为后台增加登录鉴权
- 给项目增加标签、分类和搜索
- 增加自定义域名
- 增加图片上传而不是只使用外链
