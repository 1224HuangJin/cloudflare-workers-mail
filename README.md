# 🚀 项目名称：Cloudflare Workers Mail

> [!WARNING]
> 比起这个项目，我更推荐你使用这个： [https://temp-mail-docs.awsl.uk/zh/](https://temp-mail-docs.awsl.uk/zh/)


```
⚠️ 请您注意，本代码全由AI制作、并某些功能并未实现（我懒得搞了，我懒到连这个介绍都是ai生成的、只是我纠正+优化了）

但最少的发送邮件和接受邮件目前还可以使用。
```
**Cloudflare Workers Mail** 是一款专为个人和开发者设计的轻量级、无服务器（Serverless）邮件处理系统。它运行在 Cloudflare 的边缘网络上，通过 **Cloudflare Email Routing** 接收邮件，并利用 **Resend API** 发送邮件，让您能够通过自己的域名建立一个功能完备的私密邮局。

### 🌟 核心功能
*   **全能附件发送**：支持在发送邮件时上传多个附件，系统会自动将其转换为 **Base64** 编码，通过 Resend 服务可靠送达。
*   **身份自定义**：支持在发信时自定义“发件人显示名称”，方便在不同场合切换身份（如：客服、管理员或个人姓名）。
*   **全方位邮件管理**：提供收件箱、已星标、已发送、垃圾箱分类管理，支持全文模糊搜索及未读标记提醒。
*   **自动化体验**：具备自动删除已发送草稿的逻辑，并保持前端 20 秒一次的自动轮询，确保新邮件准时触达。

---

## 🛠️ 部署步骤与设置

### 1. 准备 Cloudflare 环境
*   **域名托管**：确保您的域名已托管在 Cloudflare 且 DNS 解析由其负责。
*   **启用路由**：在 Cloudflare 控制台的 **Email -> Email Routing** 中点击启用，Cloudflare 会自动为您添加 **MX** 和 **SPF** 记录。
*   **配置 D1 数据库**：创建一个名为 `DB` 的 D1 数据库实例。并在其控制台执行以下 SQL 语句初始化表结构（注意，推荐您一行一行复制粘贴）：
    ```sql
    CREATE TABLE emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_account TEXT, folder TEXT, sender TEXT, recipient TEXT,
      subject TEXT, content TEXT, is_read INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    ```

### 2. 配置 Workers 绑定 (Bindings)
在 Workers 的 **Bindings(绑定)** 中必须设置以下变量，代码方可运行：
*   **D1 Database**: 变量名设为 `DB`。
*   **Environment Variables**:
    *   `SESSION_SECRET`: 您自定义的登录密钥。（自己随便写个就好了）
    *   `USER_LIST`: 格式为 `用户名:密码`（如 `admin:123456`并且可以弄多个）。
    *   `RESEND_API_KEY`: 您的 **Resend.com** API 密钥。

### 3. 关联域名与发送服务
*   **Resend 验证**：在 Resend 后台添加并验证您的域名，获取 3 条 DNS 记录并填回 Cloudflare 中，以确保邮件不会被判定为垃圾邮件。
*   **路由到 Worker**：在 Cloudflare 邮箱路由规则中，将“Catch-all”或特定地址的动作设置为“路由到 Worker (Route to Workers)”，并选择您创建的这个 Worker。
*  **填入你的域名**: 请务必在 `from: `${data.senderName || "Admin"} <admin@yourdomain.com>`,` 中的 "@yourdomain.com" 改为您真正的已经在Resend绑定的域名，比如说、像这样 `... <admin@1224hj.top>`
---

## 🔗 用到的链接：
[https://dash.cloudflare.com/login](https://dash.cloudflare.com/login)
[https://resend.com/](https://resend.com/)
---

## ⚠️ 注意事项
*   **DMARC 合规性**：为了满足 Gmail/Yahoo 2025 年的新要求，请务必根据 Resend 的指引配置好 **SPF、DKIM 和 DMARC** 记录，否则您的邮件可能被拦截。
*   **附件体积**：由于附件转为 Base64 传输，体积会增大约 33%，建议单次附件总大小控制在 10MB 以内。
*   **域名一致性**：发送邮件时填写的域名必须与您在 Worker 代码 和 Resend 中验证过的域名完全一致。

---

## 📄 许可证 (License)
[MIT License](https://github.com/1224HuangJin/cloudflare-workers-mail/blame/main/LICENSE)
