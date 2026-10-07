import { lucideIcon } from './theme';
export { adminStyles } from './admin-styles';
export { adminScript } from './admin-script';

const tiers = '<option value="Q">季度畅享卡 Q</option><option value="B">高级全源卡 B</option><option value="Y">年度尊享卡 Y</option><option value="S">极客纪念卡 S</option>';

/** Public shell only: never accepts session, coupon or operations data. */
export function renderAdminPage(): string {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer">
<title>光影Play · 运营控制台</title><link rel="stylesheet" href="/admin/assets/app.css">
<script src="/admin/assets/app.js" defer></script></head><body>
<header class="top"><a class="brand" href="/admin">${lucideIcon('shield', 20)} 光影Play <span>运营控制台</span></a>
<button id="logout" hidden type="button">退出登录</button></header>
<main class="admin-shell"><p id="message" role="status" aria-live="polite"></p>
<section id="login-panel" class="panel login stack"><p class="eyebrow">受保护的运营空间</p><h1>登录控制台</h1>
<p class="subtle">管理员会话仅用于运营，不改变 App 授权。</p>
<form id="login" action="/api/admin/login" method="post" class="stack">
<label>管理员口令<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
<button class="primary" type="submit">${lucideIcon('shield', 16)} 登录</button></form>
<noscript><p>此控制台需要启用 JavaScript，以 JSON 安全提交口令。</p></noscript></section>
<div id="workspace" hidden class="stack">
<nav aria-label="控制台导航"><a href="#dashboard">访问概览</a><a href="#coupons">卡密库存</a><a href="#operations">运行信息</a></nav>
<div class="section-head"><h1>运营概览</h1><div class="actions"><span id="session-expiry" class="subtle"></span><button id="refresh" type="button">刷新会话与数据</button></div></div>
<section id="dashboard" class="panel stack" aria-labelledby="dashboard-title"><div class="section-head"><h2 id="dashboard-title">访问与下载</h2>
<label>统计期间<select id="days"><option value="7">近 7 天</option><option value="30">近 30 天</option></select></label></div>
<p id="metric-meta" class="subtle"></p><div id="metrics" class="metrics"></div>
<p class="subtle">日期按 Asia/Shanghai。UV 是可识别浏览器数，不是人数；下载触发不代表完成下载或安装。统计可能延迟或不完整。</p>
<div class="table-wrap"><table><caption>每日访问趋势</caption><thead><tr><th>日期</th><th>页面访问请求</th><th>下载触发</th></tr></thead><tbody id="series"></tbody></table></div></section>
<section id="coupons" class="panel stack" aria-labelledby="coupon-title"><h2 id="coupon-title">卡密库存</h2>
<p class="subtle">ACTIVE 不代表已使用。核销、绑定、分发独立记录；复制不会标记分发。</p>
<details><summary>生成新卡密</summary><form id="generate" class="form-grid">
<label>卡种<select name="tier">${tiers}</select></label><label>数量<input name="count" type="number" min="1" max="100" value="1" required></label>
<label>批次备注<input name="note" maxlength="200"></label><label>请求 ID<input name="requestId" pattern="[A-Za-z0-9_\\-]{8,100}" minlength="8" maxlength="100" required></label>
<button type="submit" class="primary">生成卡密</button><button id="new-request" type="button">新建请求 ID</button></form></details>
<form id="filters" class="form-grid"><label>卡种<select name="tier"><option value="">全部</option>${tiers}<option value="A">历史卡 A</option></select></label>
<label>核销状态<select name="status"><option value="">全部</option><option>UNUSED</option><option>ACTIVE</option><option>REVOKED</option></select></label>
<label>分发状态<select name="dispatch"><option value="">全部</option><option>UNKNOWN</option><option>IDLE</option><option>DISPATCHED</option></select></label>
<label>每页<select name="limit"><option>20</option><option>50</option></select></label><button type="submit">筛选</button></form>
<div class="table-wrap"><table><caption>掩码卡密列表</caption><thead><tr><th>卡密 / 卡种</th><th>核销 / 绑定</th><th>分发</th><th>备注</th><th>操作</th></tr></thead><tbody id="coupon-rows"></tbody></table></div>
<div class="actions"><button id="previous" type="button">上一页</button><span id="pagination"></span><button id="next" type="button">下一页</button></div></section>
<section id="operations" class="panel stack"><div class="section-head"><h2>运行信息 · 只读</h2><button id="operations-refresh" type="button">刷新</button></div>
<h3>有效授权设备</h3><div id="devices"></div><h3>近 24 小时失败上报样本</h3>
<p id="signal-notice" class="subtle">未经认证的失败上报样本，不代表失败率或健康状态</p><div id="signals"></div><h3>当前发布信息</h3><pre id="version"></pre></section>
</div></main>
<dialog id="code-dialog" aria-labelledby="code-title"><div class="stack"><h2 id="code-title">卡密全码</h2>
<p class="subtle">全码仅在本页临时展示。复制不等于分发，请另行明确确认分发。</p>
<label>手动复制<textarea id="full-codes" readonly rows="6" spellcheck="false" autocomplete="off"></textarea></label>
<p id="copy-status" role="status"></p><div class="actions"><button id="copy" type="button">复制全码</button><button data-close="code-dialog" type="button">关闭并清除</button></div></div></dialog>
<dialog id="detail-dialog" aria-labelledby="detail-title"><div class="stack"><h2 id="detail-title">绑定详情</h2><pre id="detail"></pre><button data-close="detail-dialog" type="button">关闭</button></div></dialog>
<dialog id="action-dialog" aria-labelledby="action-title"><form id="mutation" class="stack"><h2 id="action-title"></h2><p id="action-description"></p>
<label id="action-note-label">分发备注<input name="note" maxlength="200"></label><label id="action-reason-label">停止核销原因<input name="reason" maxlength="200"></label>
<p id="action-request" class="subtle"></p><label><input name="confirmed" type="checkbox" required> 我已核对并确认此操作</label>
<div class="actions"><button class="primary" type="submit">确认执行</button><button data-close="action-dialog" type="button">取消</button></div></form></dialog>
</body></html>`;
}
