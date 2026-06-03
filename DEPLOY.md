# 上线部署清单（DEPLOY.md）

本项目分三部分：**前端**（静态页，部署到 Vercel）、**后端**（Express，部署到 Render）、**数据库 / 存储**（Supabase）。
照着本清单从上到下做一遍即可上线。打勾的地方就是你要操作的步骤。

> 当前线上后端地址：`https://myblogbackend-njns.onrender.com`（前端页面里 `API_BASE` 已写死指向它，换地址见 [§6](#6-换后端域名可选)）。

---

## 0. 总览：一次上线要做的事

- [ ] **Supabase**：建表 + 跑 5 个迁移（[§1](#1-supabase-数据库)）
- [ ] **Render**：配后端环境变量（[§2](#2-render-后端环境变量)）
- [ ] **收款码**：把 6 张图放进 `public/assets/`（[§3](#3-收款码图片)）
- [ ] **Vercel**：部署前端（[§4](#4-vercel-前端)）
- [ ] 合并代码到部署分支 → 自动部署（[§5](#5-部署--合并分支)）
- [ ] **冒烟测试**：注册 / 付款 / 一键开通走一遍（[§7](#7-上线后冒烟测试)）

---

## 1. Supabase（数据库）

### 1.1 建项目 + 拿密钥
1. 在 [supabase.com](https://supabase.com) 建项目。
2. Project Settings → API：复制 **Project URL** 和 **service_role key**（注意是 service_role，不是 anon）。

### 1.2 建主表 + 跑迁移
打开 Supabase 的 **SQL Editor**，依次执行：

1. **项目主表 `projects`**（若还没建过）——参考 `data/projects.json` 字段，最少需要：
   `id, title, summary, content, date, coverImage, videoUrl, repoUrl, tags, status, pinned, created_at`。
2. 跑 `data/` 下的 5 个迁移（直接把每个 `.sql` 内容粘进 SQL Editor 运行）：

   | 文件 | 作用 |
   | --- | --- |
   | `data/migration-add-video-url.sql` | 演示视频字段 |
   | `data/migration-add-tags.sql` | 标签 |
   | `data/migration-add-status-pinned.sql` | 草稿状态 + 置顶 |
   | `data/migration-add-repo-url.sql` | GitHub 仓库链接 |
   | `data/migration-add-visitors.sql` | **访客/会员表（含 `member_until`，会员功能必需）** |

> ⚠️ `migration-add-visitors.sql` 是会员、付款、一键开通、AI 助手门禁的基础。**不跑这个，会员相关功能全部不可用。**

### 1.3 存储桶（Storage）
代码会自动创建，无需手动建：封面图桶 `project-covers`、视频桶 `project-videos`（名字可用环境变量覆盖）。

---

## 2. Render（后端环境变量）

Render → 你的 Web Service → **Environment** 里加下列变量。

### 2.1 必填

| 变量 | 值 / 说明 |
| --- | --- |
| `SUPABASE_URL` | 上一步的 Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 上一步的 service_role key |
| `ADMIN_USERNAME` | 管理员登录名（自定义） |
| `ADMIN_PASSWORD` | 管理员密码（**改成强密码**） |
| `ADMIN_SESSION_SECRET` | 随机长字符串（签发令牌用；**换它可一键作废所有旧管理员令牌**） |
| `CORS_ORIGIN` | 你的前端域名，如 `https://你的站.vercel.app,https://*.vercel.app`（不要结尾斜杠） |

### 2.2 邮件（注册验证码 + 付款通知 + 一键开通链接靠它发）

推荐 **Brevo**（无需域名、可给任意人发信）：

| 变量 | 值 / 说明 |
| --- | --- |
| `BREVO_API_KEY` | Brevo 后台拿的 API Key |
| `BREVO_SENDER` | 已在 Brevo 验证过的发件邮箱（你的 QQ 邮箱 `2284610019@qq.com`） |
| `BREVO_SENDER_NAME` | 发件人显示名，如 `Heisd.Stark` |
| `CONTACT_TO` | 收信邮箱（留言 + 付款通知发到这），默认 `2284610019@qq.com` |
| `BACKEND_PUBLIC_URL` | 选填。一键开通链接的域名；留空自动用请求 Host（Render 上即 onrender 地址）。用自有域名时填 |

> Brevo 怎么配：注册 → Senders & IP → 验证 `2284610019@qq.com` → SMTP & API → 生成 API Key。
> 备选 `RESEND_*` / `SMTP_*` 见 `.env.example`（Render 免费版封了 SMTP 端口，别用 SMTP）。

### 2.3 会员功能

| 变量 | 值 / 说明 |
| --- | --- |
| `GITHUB_TOKEN` | 站内浏览私有仓库源码用。GitHub → Settings → Developer settings → Personal access tokens；fine-grained 选对应私有库给 **Contents: Read-only**，或 classic 勾 `repo` |
| `LLM_API_KEY` | AI 助手用。OpenAI / DeepSeek / Kimi / 智谱 等任一的 Key |
| `LLM_BASE_URL` | 如 `https://api.deepseek.com/v1`（**不要带结尾 `/chat/completions`**） |
| `LLM_MODEL` | 如 `deepseek-chat` / `gpt-4o-mini` |

### 2.4 选填

| 变量 | 说明 |
| --- | --- |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | 配了用 Cloudflare Turnstile 人机验证；不配走内置（蜜罐 + 表单令牌） |
| `SUPABASE_IMAGE_BUCKET` / `SUPABASE_VIDEO_BUCKET` | 自定义存储桶名 |
| `PORT` | Render 自动注入，一般不用填 |

---

## 3. 收款码图片

把你的 6 张收款码按下表**精确命名**后放进 `public/assets/`，然后提交（Vercel 部署后即生效）：

| 你的图 | 存成的文件名 |
| --- | --- |
| 微信 ¥50 | `public/assets/pay-wechat-50.png` |
| 微信 ¥150 | `public/assets/pay-wechat-150.png` |
| 微信 ¥600 | `public/assets/pay-wechat-600.png` |
| 支付宝 ¥50 | `public/assets/pay-alipay-50.png` |
| 支付宝 ¥150 | `public/assets/pay-alipay-150.png` |
| 支付宝 ¥600 | `public/assets/pay-alipay-600.png` |

- 用户在 `/welcome` 选套餐时会自动显示对应金额的码（选 1 个月→¥50，12 个月→¥600）。
- 缺某张会自动回退到通用码 `pay-wechat.png` / `pay-alipay.png`（对方手动输金额）；都没有则提示"尚未配置"。
- 改价/改套餐：编辑 `public/welcome.html` 顶部的 `PLANS`（同时把文件名里的数字一起改）。

> 命名规则详见 `public/assets/README.md`。

---

## 4. Vercel（前端）

1. Vercel 新建项目，连本仓库。
2. **Root Directory 设为 `public`**（站点根，`/assets/...`、`/assistant.js` 才能正确解析）。
3. Framework Preset：**Other**（纯静态，无构建命令）。
4. 路由已由 `vercel.json` 配好（`/welcome`、`/projects`、`/admin`、`/project/:id` 等重写）。
5. 部署后把 Vercel 域名加进 Render 的 `CORS_ORIGIN`。

---

## 5. 部署 / 合并分支

- 后端在 Render，绑定的是用于部署的分支（按你的设置，通常是合并到 `lqy` 或 `main` 后自动部署）。
- 本次会员相关改动在分支 `claude/gracious-rubin-8P6Wv`，**合并到部署分支**后 Render / Vercel 会自动构建。

```bash
# 例：把功能分支合并到部署分支并推送
git checkout <部署分支>
git merge claude/gracious-rubin-8P6Wv
git push origin <部署分支>
```

---

## 6. 换后端域名（可选）

前端页面里 `API_BASE` 写死为 `https://myblogbackend-njns.onrender.com`。换后端地址时全局替换：

```
public/welcome.html, public/projects.html, public/project-detail.html,
public/admin.html, public/contact.html, public/assistant.js
```

---

## 7. 上线后冒烟测试

按顺序点一遍，全过就算上线成功：

- [ ] 打开前端 → `/welcome` 能注册（收到验证码邮件）、能登录。
- [ ] 管理员：`/admin` 用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录，能看到项目列表 + 「会员管理」面板。
- [ ] **手动添加会员**：会员管理输入一个邮箱 → 「添加为会员」→ 列表出现「待认领」徽章；用该邮箱去注册能收到验证码、设密码后即为会员。
- [ ] **付款 → 一键开通**：用普通账号在 `/welcome` 选套餐 → 「我已付款」→ 你 `CONTACT_TO` 邮箱收到带「一键开通」链接的邮件 → 点链接 → 选时长 → 该用户变会员。
- [ ] **会员特权**：会员能在项目详情页「浏览源码（站内只读）」、能用右下角 🤖 AI 助手；非会员看到「🔒 去开通会员」。
- [ ] **删除会员**：会员管理点「删除」能移除账号。

---

## 8. 会员/支付模式说明（重要）

- 当前为**人工收款 + 一键开通**：个人微信/支付宝收款码**不会**回调服务器，所以无法"收款即自动开通"。流程是用户付款 → 点「我已付款」→ 你核对手机到账 → 点邮件里「一键开通」链接开通。
- 一键开通链接：HMAC 签名 + 7 天有效 + 一次性 + 只发到你私人邮箱；月数由你在确认页选（防止有人少付却选长套餐）。
- 一次性状态存内存，Render 免费实例休眠重启会重置——理论上 7 天内同一链接可能被再点一次，因链接只在你邮箱，风险可忽略。
- 想要**真·全自动**（付款成功自动开通）需接官方商户支付（微信支付/支付宝商户，需营业执照或个体户；或 Stripe）。需要时再加。

---

## 9. 常见问题

| 现象 | 排查 |
| --- | --- |
| 收不到验证码 / 付款通知邮件 | 检查 `BREVO_API_KEY`、`BREVO_SENDER` 是否已在 Brevo 验证；看 Render 日志 |
| 会员管理报"请先执行 visitors.member_until 迁移" | 没跑 `migration-add-visitors.sql` |
| 浏览源码报 503 | 没配 `GITHUB_TOKEN` 或权限不足（需 Contents 读） |
| AI 助手"尚未配置" | 没配 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` |
| 前端报 CORS | `CORS_ORIGIN` 没包含你的前端域名（不要带结尾斜杠） |
| 首次访问很慢（30~60s） | Render 免费版休眠冷启动，正常；前端已带唤醒重试 |
| 收款码不显示 | 文件名/路径不对，必须是 `public/assets/pay-{wechat,alipay}-{50,150,600}.png` |
