export default {
  // 1. 接收邮件逻辑：深度清洗 MIME 报文与 Quoted-printable 乱码  - By 1224HuangJin
  async email(message, env, ctx) {
    const subject = message.headers.get("subject") || "(无主题)";
    const from = message.from;
    const to = message.to;
    const rawBody = await new Response(message.raw).text();

    let cleanContent = rawBody;
    // 健壮的正文提取逻辑：优先寻找 HTML，其次寻找纯文本  - By 1224HuangJin
    if (rawBody.includes("Content-Type: text/html")) {
      const parts = rawBody.split("Content-Type: text/html");
      cleanContent = parts.length > 1 ? parts[parts.length - 1].split("--") : rawBody;
    } else if (rawBody.includes("Content-Type: text/plain")) {
      const parts = rawBody.split("Content-Type: text/plain");
      cleanContent = parts.length > 1 ? parts[parts.length - 1].split("--") : rawBody;
    }

    // 核心乱码清洗：解码 Quoted-printable (如 =3D -> =, =20 -> 空格)  - By 1224HuangJin
    cleanContent = cleanContent
      .replace(/=\r?\n/g, "")
      .replace(/=3D/g, "=")
      .replace(/=20/g, " ")
      .replace(/<head>[\s\S]*?<\/head>/gi, ""); // 移除多余样式头  - By 1224HuangJin

    await env.DB.prepare(
      "INSERT INTO emails (user_account, folder, sender, recipient, subject, content, is_read, is_starred) VALUES (?, ?, ?, ?, ?, ?, 0, 0)"
    ).bind("admin", "inbox", from, to, subject, cleanContent).run();
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cookieHeader = request.headers.get("Cookie") || "";
    const isLoggedIn = cookieHeader.includes(`auth_session=${env.SESSION_SECRET}`);

    // --- 登录逻辑 - By 1224HuangJin ---
    if (url.pathname === "/login" && request.method === "POST") {
      const formData = await request.formData();
      const isValid = (env.USER_LIST || "").split(",").some(u => u.trim() === `${formData.get("username")}:${formData.get("password")}`);
      if (isValid) {
        return new Response("OK", {
          status: 302,
          headers: { "Set-Cookie": `auth_session=${env.SESSION_SECRET}; Path=/; HttpOnly; Max-Age=2592000`, "Location": "/" }
        });
      }
      return new Response("验证失败", { status: 401 });
    }

    if (!isLoggedIn) return new Response(this.getLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    // --- API: 邮件列表  - By 1224HuangJin---
    if (url.pathname === "/api/list") {
      const folder = url.searchParams.get("type") || "inbox";
      const q = url.searchParams.get("q") || "";
      let query = "SELECT id, sender, subject, created_at, is_read, is_starred FROM emails WHERE user_account='admin' ";
      let params = [];
      if (folder === 'starred') {
        query += "AND is_starred = 1 AND folder != 'trash' ";
      } else {
        query += "AND folder = ? ";
        params.push(folder);
      }
      if (q) {
        query += "AND (subject LIKE ? OR sender LIKE ? OR content LIKE ?) ";
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      query += "ORDER BY created_at DESC LIMIT 50";
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
    }

    // --- API: 邮件详情 - By 1224HuangJin ---
    if (url.pathname === "/api/detail") {
      const id = url.searchParams.get("id");
      await env.DB.prepare("UPDATE emails SET is_read = 1 WHERE id = ?").bind(id).run();
      const email = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first();
      return new Response(JSON.stringify(email), { headers: { "Content-Type": "application/json" } });
    }

    // --- API: 邮件操作 (星标、删除)  - By 1224HuangJin --- 
    if (url.pathname === "/api/action" && request.method === "POST") {
      const { id, action } = await request.json();
      if (action === "star") await env.DB.prepare("UPDATE emails SET is_starred = 1 WHERE id = ?").bind(id).run();
      if (action === "unstar") await env.DB.prepare("UPDATE emails SET is_starred = 0 WHERE id = ?").bind(id).run();
      if (action === "trash") await env.DB.prepare("UPDATE emails SET folder = 'trash' WHERE id = ?").bind(id).run();
      if (action === "delete") await env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    // --- API: 发送邮件 (集成附件支持与发件人自定义)  - By 1224HuangJin ---
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const data = await request.json();
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: `${data.senderName || "Admin"} <admin@exemple.com>`,
            to: data.to.split(','),
            subject: data.subject,
            html: data.content,
            // 重新加入附件逻辑：将前端传来的 Base64 数组映射给 Resend  - By 1224HuangJin
            attachments: data.attachments?.map(a => ({
              filename: a.name,
              content: a.content.split(',') // 移除 Data URL 前缀  - By 1224HuangJin
            }))
          }),
        });

        if (res.ok) {
          if (data.draftId) await env.DB.prepare("DELETE FROM emails WHERE id=?").bind(data.draftId).run();
          await env.DB.prepare("INSERT INTO emails (user_account, folder, sender, recipient, subject, content, is_read, is_starred) VALUES (?, 'sent', ?, ?, ?, ?, 1, 0)")
            .bind("admin", `Me (${data.senderName || 'Admin'})`, data.to, data.subject, data.content).run();
          return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "发送失败" }), { status: 400 });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    return new Response(this.getMainHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  },

  getLoginHTML() {
    return `<!DOCTYPE html><html><head><title>Login</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-100 flex items-center justify-center h-screen"><div class="bg-white p-8 rounded-2xl shadow-xl w-96 text-center"><h1 class="text-2xl font-bold mb-6 text-slate-800">Cloud Mail Pro</h1><form action="/login" method="POST" class="space-y-4"><input type="text" name="username" placeholder="用户名" class="w-full p-3 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"><input type="password" name="password" placeholder="密码" class="w-full p-3 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"><button class="w-full bg-blue-600 text-white p-3 rounded-lg font-semibold hover:bg-blue-700 transition">登录</button></form></div></body></html>`;
  },

  getMainHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>Cloud Mail - By 1224HuangJin</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
    <script src="https://cdn.quilljs.com/1.3.6/quill.js"></script>
    <style>
        :root { --gmail-bg: #f6f8fc; --gmail-active: #d3e3fd; }
        body { background-color: var(--gmail-bg); font-family: system-ui, -apple-system, sans-serif; }
        .sidebar-item { border-radius: 0 24px 24px 0; transition: all 0.2s; cursor: pointer; padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
        .sidebar-item.active { background-color: var(--gmail-active); font-weight: 600; color: #001d35; }
        .mail-card { background: white; border-radius: 16px; margin: 0 16px 16px 0; border: 1px solid #e0e0e0; flex: 1; overflow: hidden; display: flex; flex-direction: column; }
        .email-row { border-bottom: 1px solid #f1f3f4; display: flex; align-items: center; padding: 10px 16px; cursor: pointer; }
        .unread { font-weight: bold; background: #fff; }
        .read { font-weight: normal; background: #f8f9fa; opacity: 0.8; }
        #composeModal { display: none; position: fixed; bottom: 0; right: 50px; width: 550px; background: white; border-radius: 10px 10px 0 0; box-shadow: 0 8px 30px rgba(0,0,0,0.2); z-index: 100; }
        .attachment-badge { background: #f1f3f4; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-right: 4px; border: 1px solid #ddd; }
    </style>
</head>
<body class="h-screen flex flex-col overflow-hidden">
    <header class="h-16 flex items-center px-6 bg-white border-b shrink-0 justify-between">
        <span class="text-xl font-bold text-blue-600">Cloud Mail Pro</span>
        <div class="flex-1 max-w-xl mx-auto">
            <input type="text" id="searchInput" onkeyup="if(event.key==='Enter') loadEmails()" placeholder="搜索邮件" class="w-full bg-blue-50 px-6 py-2 rounded-full outline-none focus:bg-white border">
        </div>
    </header>

    <div class="flex flex-1 overflow-hidden">
        <aside class="w-64 pt-4 shrink-0">
            <button onclick="openCompose()" class="flex items-center gap-3 ml-4 mb-6 px-10 py-4 bg-blue-100 hover:bg-blue-200 text-blue-900 rounded-2xl font-bold shadow-sm transition">
                撰写
            </button>
            <nav>
                <div onclick="switchFolder('inbox', this)" class="sidebar-item active">📥 收件箱</div>
                <div onclick="switchFolder('starred', this)" class="sidebar-item">⭐ 星标</div>
                <div onclick="switchFolder('sent', this)" class="sidebar-item">📤 已发送</div>
                <div onclick="switchFolder('trash', this)" class="sidebar-item">🗑️ 垃圾箱</div>
            </nav>
        </aside>

        <main class="mail-card shadow-sm">
            <div id="listView" class="flex-1 overflow-y-auto"></div>
            <div id="detailView" class="hidden flex-1 overflow-y-auto p-10 bg-white">
                <button onclick="closeDetail()" class="mb-6 text-blue-600 hover:underline">← 返回列表</button>
                <h2 id="mailSubject" class="text-2xl font-medium mb-6"></h2>
                <div id="mailInfo" class="text-sm text-gray-500 mb-8 pb-4 border-b"></div>
                <div id="mailContent" class="prose max-w-none text-gray-800 leading-relaxed min-h-[250px]"></div>
                <div class="mt-12 pt-6 border-t flex gap-4">
                    <button id="replyBtn" class="bg-blue-600 text-white px-10 py-2 rounded-full font-bold shadow-md">回复</button>
                    <button id="delBtn" class="border border-red-200 text-red-500 px-8 py-2 rounded-full hover:bg-red-50">删除</button>
                </div>
            </div>
        </main>
    </div>

    <!-- 撰写模态框：增加了附件功能 -->
    <div id="composeModal">
        <div class="bg-gray-800 text-white px-4 py-2 flex justify-between items-center rounded-t-lg">
            <span class="text-sm font-bold">新邮件</span>
            <button onclick="closeCompose()">✕</button>
        </div>
        <div class="p-4 space-y-3">
            <input id="cName" type="text" placeholder="您的姓名" class="w-full border-b py-1 text-sm outline-none focus:border-blue-500" value="Admin">
            <input id="cTo" type="text" placeholder="收件人" class="w-full border-b py-1 outline-none text-sm focus:border-blue-500">
            <input id="cSub" type="text" placeholder="主题" class="w-full border-b py-1 outline-none text-sm focus:border-blue-500">
            <div id="editor" style="height: 250px;"></div>
            <!-- 附件上传区域 -->
            <div class="pt-2">
                <label class="text-xs text-gray-500 block mb-1">附件上传 (支持多文件):</label>
                <input id="cFiles" type="file" multiple class="text-xs w-full text-gray-500">
            </div>
        </div>
        <div class="p-4 border-t bg-gray-50 flex justify-end">
            <button onclick="sendMail()" id="sendBtn" class="bg-blue-600 text-white px-12 py-2 rounded-full font-bold shadow-lg hover:bg-blue-700">发送</button>
        </div>
    </div>

    <script>
        let quill = new Quill('#editor', { theme: 'snow', placeholder: '在此输入邮件正文...' });
        let currentFolder = 'inbox';
        let currentMail = null;

        async function loadEmails() {
            const q = document.getElementById('searchInput').value;
            const res = await fetch(\`/api/list?type=\${currentFolder}&q=\${q}\`);
            const data = await res.json();
            document.getElementById('listView').innerHTML = data.map(m => \`
                <div onclick="openMail(\${m.id})" class="email-row \${m.is_read ? 'read' : 'unread'}">
                    <div class="w-10 shrink-0" onclick="event.stopPropagation(); doAction('star', \${m.id})">
                        \${m.is_starred ? '⭐' : '☆'}
                    </div>
                    <div class="w-48 truncate text-sm">\${m.sender}</div>
                    <div class="flex-1 truncate text-sm px-4">\${m.subject}</div>
                    <div class="text-xs text-gray-400">\${new Date(m.created_at).toLocaleDateString()}</div>
                </div>
            \`).join('') || '<div class="p-20 text-center text-gray-400">暂无相关邮件</div>';
        }

        async function openMail(id) {
            const res = await fetch(\`/api/detail?id=\${id}\`);
            currentMail = await res.json();
            document.getElementById('listView').classList.add('hidden');
            document.getElementById('detailView').classList.remove('hidden');
            
            document.getElementById('mailSubject').innerText = currentMail.subject;
            document.getElementById('mailInfo').innerText = \`发件人: \${currentMail.sender} | 时间: \${new Date(currentMail.created_at).toLocaleString()}\`;
            document.getElementById('mailContent').innerHTML = currentMail.content;
            
            document.getElementById('replyBtn').onclick = () => {
                openCompose();
                document.getElementById('cTo').value = currentMail.sender;
                document.getElementById('cSub').value = "Re: " + currentMail.subject;
                quill.root.innerHTML = \`<br><br>--- 在 \${new Date(currentMail.created_at).toLocaleString()}，\${currentMail.sender} 写道：<br><blockquote>\${currentMail.content}</blockquote>\`;
            };
            document.getElementById('delBtn').onclick = () => doAction('trash', id);
            loadEmails();
        }

        async function doAction(action, id) {
            await fetch('/api/action', { method: 'POST', body: JSON.stringify({ id, action }) });
            if (action === 'trash') closeDetail();
            loadEmails();
        }

        function closeDetail() {
            document.getElementById('listView').classList.remove('hidden');
            document.getElementById('detailView').classList.add('hidden');
        }

        function switchFolder(f, el) {
            currentFolder = f;
            document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
            el.classList.add('active');
            closeDetail();
            loadEmails();
        }

        // 附件转 Base64 辅助函数  - By 1224HuangJin
        const toBase64 = file => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result);
            reader.onerror = error => reject(error);
        });

        async function sendMail() {
            const btn = document.getElementById('sendBtn');
            const fileInput = document.getElementById('cFiles');
            btn.disabled = true; btn.innerText = '发送中...';

            try {
                // 读取并转换所有附件  - By 1224HuangJin
                const attachments = [];
                for (let file of fileInput.files) {
                    const base64 = await toBase64(file);
                    attachments.push({ name: file.name, content: base64 });
                }

                const data = { 
                    senderName: document.getElementById('cName').value,
                    to: document.getElementById('cTo').value, 
                    subject: document.getElementById('cSub').value, 
                    content: quill.root.innerHTML,
                    attachments: attachments, // 包含附件数组  - Code By 1224HuangJin
                    draftId: currentMail && currentFolder === 'draft' ? currentMail.id : null
                };
                
                const res = await fetch('/api/send', { method: 'POST', body: JSON.stringify(data) });
                if (res.ok) { 
                    alert('邮件已成功发送');
                    closeCompose(); 
                    loadEmails(); 
                    fileInput.value = ""; // 清空附件  - By 1224HuangJin
                } else {
                    alert('发送失败，请检查 Resend 配置');
                }
            } catch (err) {
                alert('附件处理错误: ' + err.message);
            } finally {
                btn.disabled = false; btn.innerText = '发送';
            }
        }

        function openCompose() { document.getElementById('composeModal').style.display = 'block'; }
        function closeCompose() { document.getElementById('composeModal').style.display = 'none'; }

        loadEmails();
        setInterval(loadEmails, 20000); 
    </script>
</body>
</html>`;
  }
};
