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

## Supabase 数据表

项目数据存储在 `projects` 表中，推荐结构如下：

```sql
create table projects (
  id text primary key,
  title text not null,
  date date,
  summary text,
  "coverImage" text,
  content text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
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
CORS_ORIGIN=https://your-frontend-domain.vercel.app
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
ADMIN_SESSION_SECRET=change-this-random-secret
PORT=3000
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
CORS_ORIGIN=https://your-frontend-domain.vercel.app
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
ADMIN_SESSION_SECRET=change-this-random-secret
NODE_ENV=production
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

## 后续可优化方向

- 为后台增加登录鉴权
- 给项目增加标签、分类和搜索
- 增加自定义域名
- 增加图片上传而不是只使用外链
