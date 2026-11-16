// 管理页面的 HTML。没有构建步骤，样式和脚本都内联。
//
// 页面本身不做业务，只是一个壳：拉 /api/state 渲染账号列表，
// 新建账号后轮询 /api/session/<sid> 拿二维码和状态。

export function pageHtml({ token = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信机器人 · 账号管理</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fafafa; --muted:#666; --line:#e2e2e2; --accent:#2b6cb0; --warn:#b7791f; --err:#c53030; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --bg:#1a1a1a; --muted:#999; --line:#333; --accent:#63b3ed; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; font:15px/1.6 -apple-system,"Segoe UI",sans-serif; color:var(--fg); background:var(--bg); }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:20px; }
  .card { border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:14px; }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .grow { flex:1; min-width:140px; }
  .name { font-weight:600; }
  .meta { color:var(--muted); font-size:12px; }
  .tag { font-size:12px; padding:1px 7px; border-radius:20px; border:1px solid var(--line); color:var(--muted); }
  .tag.ok { color:#2f855a; border-color:#2f855a; }
  .tag.warn { color:var(--warn); border-color:var(--warn); }
  .tag.err { color:var(--err); border-color:var(--err); }
  button { font:inherit; padding:6px 14px; border-radius:7px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.primary:hover { color:#fff; opacity:.9; }
  button.danger:hover { border-color:var(--err); color:var(--err); }
  input { font:inherit; padding:7px 10px; border-radius:7px; border:1px solid var(--line); background:transparent; color:var(--fg); }
  .qr { margin-top:14px; text-align:center; }
  .qr svg { width:240px; height:240px; background:#fff; padding:8px; border-radius:8px; }
  .qr p { color:var(--muted); font-size:13px; margin:10px 0 0; }
  .empty { color:var(--muted); text-align:center; padding:24px; }
  .err { color:var(--err); font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>微信机器人 · 账号管理</h1>
  <div class="sub">每个账号是一个独立的微信 ClawBot，各自扫码登录，记忆和任务互相隔离。</div>

  <div class="card">
    <div class="row">
      <input id="name" class="grow" placeholder="给这个账号起个名字，比如「工作号」" maxlength="40">
      <button class="primary" id="add">添加账号</button>
    </div>
    <div class="err" id="addErr"></div>
  </div>

  <div id="list"></div>
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
const headers = TOKEN ? { 'X-Access-Token': TOKEN } : {};

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...headers, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

let polling = null;

function render(tenants) {
  const list = document.getElementById('list');
  if (!tenants.length) {
    list.innerHTML = '<div class="empty">还没有账号。在上面输入名字，点「添加账号」后扫码。</div>';
    return;
  }

  list.innerHTML = tenants.map(t => {
    const tag = !t.loggedIn
      ? '<span class="tag warn">未登录</span>'
      : t.running ? '<span class="tag ok">运行中</span>' : '<span class="tag">已登录未启动</span>';
    return '<div class="card" data-id="' + esc(t.id) + '">' +
      '<div class="row">' +
        '<div class="grow"><div class="name">' + esc(t.name) + ' ' + tag + '</div>' +
        '<div class="meta">' + esc(t.id) + (t.selfId ? ' · ' + esc(t.selfId) : '') + '</div></div>' +
        '<button data-act="login">' + (t.loggedIn ? '重新扫码' : '扫码登录') + '</button>' +
        '<button class="danger" data-act="del">删除</button>' +
      '</div>' +
      '<div class="qr" data-qr></div>' +
    '</div>';
  }).join('');
}

async function refresh() {
  try {
    const data = await api('/api/state');
    render(data.tenants);
  } catch (e) {
    document.getElementById('list').innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
  }
}

async function pollSession(sid, box) {
  clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const s = await api('/api/session/' + encodeURIComponent(sid));
      if (!s) { clearInterval(polling); return; }

      if (s.status === 'confirmed') {
        clearInterval(polling);
        box.innerHTML = '<p>登录成功，已开始收消息。</p>';
        setTimeout(refresh, 1200);
        return;
      }
      if (s.status === 'failed') {
        clearInterval(polling);
        box.innerHTML = '<p class="err">登录失败：' + esc(s.error) + '</p>';
        return;
      }
      if (s.status === 'expired') {
        box.innerHTML = '<p>二维码过期，正在换新的一张…</p>';
        return;
      }
      if (s.qrSvg) {
        box.innerHTML = s.qrSvg + '<p>' + (s.status === 'scanned' ? '已扫码，请在手机上确认' : '用微信扫这个码登录') + '</p>';
      }
    } catch {
      clearInterval(polling);
    }
  }, 1200);
}

document.getElementById('add').addEventListener('click', async () => {
  const input = document.getElementById('name');
  const err = document.getElementById('addErr');
  err.textContent = '';
  const name = input.value.trim();
  if (!name) { err.textContent = '先起个名字'; return; }

  try {
    const { sessionId } = await api('/api/tenants', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await refresh();
    const card = document.querySelector('[data-id]');
    if (card) pollSession(sessionId, card.querySelector('[data-qr]'));
  } catch (e) {
    err.textContent = e.message;
  }
});

document.getElementById('list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('[data-id]');
  const id = card.dataset.id;

  if (btn.dataset.act === 'login') {
    try {
      const { sessionId } = await api('/api/tenants/' + encodeURIComponent(id) + '/login', { method: 'POST' });
      pollSession(sessionId, card.querySelector('[data-qr]'));
    } catch (e) {
      card.querySelector('[data-qr]').innerHTML = '<p class="err">' + esc(e.message) + '</p>';
    }
    return;
  }

  if (btn.dataset.act === 'del') {
    if (!confirm('删掉这个账号？登录凭证会一起删，再想用要重新扫码。')) return;
    try {
      await api('/api/tenants/' + encodeURIComponent(id), { method: 'DELETE' });
      refresh();
    } catch (e) {
      alert(e.message);
    }
  }
});

refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`
}
