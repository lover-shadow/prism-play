import { adminCouponScript } from './admin-coupon-script';

/** Native JS served verbatim at /admin/assets/app.js; no runtime dependencies. */
export const adminScript = String.raw`(() => {
'use strict';
const $ = id => document.getElementById(id);
let csrf = '', epoch = 0, expiryTimer, sessionExpiry = 0;
const message = text => { $('message').textContent = text; };
const errors = {400:'请求格式无效，请核对输入。',401:'会话已失效，请重新登录。',403:'请求被拒绝，请刷新会话后重试。',404:'记录不存在。',409:'状态冲突，请刷新核对；操作未确认成功。',429:'操作过于频繁，请稍后手动重试。',503:'服务暂不可用，请稍后重试。'};
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function date(seconds) { return seconds == null ? '暂无数据' : new Date(seconds * 1000).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}); }
function clearPrivate() {
  epoch++; csrf = ''; sessionExpiry = 0; clearTimeout(expiryTimer);
  $('workspace').hidden = true; $('logout').hidden = true; $('login-panel').hidden = false;
  for (const id of ['metrics','series','coupon-rows','devices','signals','version','detail','metric-meta','pagination','session-expiry']) $(id).replaceChildren();
  $('full-codes').value = ''; $('copy-status').textContent = '';
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('generate').reset(); $('mutation').reset(); clearCouponState();
}
async function api(path, body) {
  const current = epoch;
  let response;
  try { response = await fetch('/api/admin/' + path, {method:body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store', headers: body === undefined ? {} : {'Content-Type':'application/json', 'X-CSRF-Token':csrf}, body:body === undefined ? undefined : JSON.stringify(body)}); }
  catch { throw new Error('网络异常。写操作结果可能未知，请保留同一请求 ID 重试，勿重复生成。'); }
  if (current !== epoch) throw new Error('会话已变更，已丢弃旧响应。');
  if (response.status === 401) clearPrivate();
  if (!response.ok) throw new Error(errors[response.status] || '请求失败，请稍后重试。');
  const data = await response.json();
  if (current !== epoch) throw new Error('会话已变更，已丢弃旧响应。');
  return data;
}
async function run(control, task) {
  if (control.disabled) return;
  control.disabled = true;
  try { await task(); } catch (error) { message(error.message || '操作失败。'); }
  finally {
    control.disabled = control.id === 'previous' ? page <= 1 : control.id === 'next' ? page * Number($('filters').elements.limit.value) >= total : false;
  }
}
function session(data) {
  if (typeof data.csrf !== 'string' || !Number.isFinite(data.expiresAt)) throw new Error('会话响应无效。');
  csrf = data.csrf; sessionExpiry = data.expiresAt;
  $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  if (!$('generate').elements.requestId.value) $('generate').elements.requestId.value = requestId();
  $('session-expiry').textContent = '会话到期：' + date(data.expiresAt);
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => { clearPrivate(); message('会话到期，请重新登录。'); }, Math.max(0, data.expiresAt * 1000 - Date.now()));
}
let metricSequence = 0, operationsSequence = 0;
async function dashboard() {
  const sequence = ++metricSequence;
  $('metric-meta').textContent = '正在读取统计…';
  $('metrics').replaceChildren(); $('series').replaceChildren();
  try {
    const data = await api('dashboard?days=' + $('days').value);
    if (sequence !== metricSequence) return;
    const series = data.series || [];
    const totals = series.reduce((sum, item) => ({requests:sum.requests + Number(item.requests), downloads:sum.downloads + Number(item.downloads)}), {requests:0, downloads:0});
    const values = [['页面访问请求',totals.requests],['下载触发',totals.downloads],['期间可识别浏览器',data.uv],['同标识转化率',data.conversionRate == null ? '暂无数据' : (data.conversionRate * 100).toFixed(1) + '%']];
    for (const [label,value] of values) { const card = node('div', undefined, 'metric'); card.append(node('span',label),node('strong',value)); $('metrics').append(card); }
    $('metric-meta').textContent = data.fromDay + ' — ' + data.toDay + ' · 开始记录：' + (data.startedAt || '暂无数据') + ' · 最近写入：' + date(data.updatedAt);
    for (const item of series) { const row = node('tr'); for (const value of [item.day,item.requests,item.downloads]) row.append(node('td',value)); $('series').append(row); }
    if (!series.length) { const row = node('tr'); const cell = node('td','暂无统计记录'); cell.colSpan = 3; row.append(cell); $('series').append(row); }
  } catch (error) { if (sequence === metricSequence) $('metric-meta').textContent = '统计读取失败，可刷新重试。'; throw error; }
}
function records(id, rows) {
  $(id).replaceChildren();
  if (!rows.length) { $(id).append(node('p','暂无记录')); return; }
  for (const row of rows) $(id).append(node('pre', JSON.stringify(row, null, 2)));
}
async function operations() {
  const sequence = ++operationsSequence;
  for (const id of ['devices','signals','version']) $(id).textContent = '正在读取…';
  try {
    const data = await api('operations');
    if (sequence !== operationsSequence) return;
    records('devices',data.authorizedDevices || []); records('signals',data.lineSignals || []);
    $('signal-notice').textContent = data.lineSignalNotice;
    $('version').textContent = data.version == null ? '暂无发布信息' : JSON.stringify(data.version, null, 2);
  } catch (error) { for (const id of ['devices','signals','version']) $(id).textContent = '读取失败，请刷新重试。'; throw error; }
}
async function refresh() {
  session(await api('session'));
  await Promise.all([dashboard(),coupons(),operations()].map(task => task.catch(error => message(error.message))));
}
${adminCouponScript}
$('login').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  run(form.querySelector('button'), async () => {
    const password = form.elements.password.value;
    form.elements.password.value = '';
    session(await api('login', {password})); message('登录成功。'); await refresh();
  });
});
$('refresh').addEventListener('click', event => run(event.currentTarget, refresh));
$('days').addEventListener('change', event => run(event.currentTarget, dashboard));
$('operations-refresh').addEventListener('click', event => run(event.currentTarget, operations));
$('logout').addEventListener('click', event => run(event.currentTarget, async () => {
  await api('logout', {}); clearPrivate(); message('已退出登录。');
}));
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => {
    if (dialog.id === 'code-dialog') { $('full-codes').value = ''; $('copy-status').textContent = ''; }
    if (dialog.id === 'detail-dialog') $('detail').textContent = '';
  });
}
window.addEventListener('pagehide', clearPrivate);
window.addEventListener('pageshow', event => { if (event.persisted) run($('refresh'), refresh); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && sessionExpiry && Date.now() >= sessionExpiry * 1000) clearPrivate(); });
run($('refresh'), refresh);
})();`;
