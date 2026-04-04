# ClaudeAboutWeb

Gemini 设计，Codex 实现，整体功能已完成。

这是一个基于 `Express` 的个人项目展示网站，包含项目列表、项目详情和后台管理页，后端通过 JSON 文件提供数据读写能力。

## 项目结构

```text
ClaudeAboutWeb/
├── index.html                # 已加 Projects 导航链接
├── server.js                 # Express 后端（端口 3000）
├── package.json              # express + cors
├── data/
│   └── projects.json         # 3 个机器人主题示例项目
└── public/
    ├── index.html            # 备用首页
    ├── projects.html         # CSDN 风格项目列表页（只显示标题）
    ├── project-detail.html   # 项目详情页（点击后查看全文）
    └── admin.html            # 管理页（添加 / 编辑项目）
```

## API 端点

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| `GET` | `/api/projects` | 获取所有项目（仅标题 / 摘要） |
| `GET` | `/api/projects/:id` | 获取单个项目完整内容 |
| `POST` | `/api/projects` | 新建项目 |
| `PUT` | `/api/projects/:id` | 更新项目 |
| `DELETE` | `/api/projects/:id` | 删除项目 |

## 页面路由

- `/`：个人博客首页
- `/projects`：项目列表页，采用 CSDN 风格，只显示标题
- `/project/:id`：项目详情页，点击后跳转查看全文
- `/admin`：后台管理页

## 启动方式

在终端中执行：

```bash
cd C:/Users/86151/Desktop/ClaudeCode/ClaudeAboutWeb
node server.js
```

然后在浏览器中打开：

```text
http://localhost:3000
```

## 说明

- 前端页面位于 `public/` 目录中。
- 项目数据保存在 `data/projects.json`。
- 后台管理页支持添加、编辑和删除项目。

# 线上部署