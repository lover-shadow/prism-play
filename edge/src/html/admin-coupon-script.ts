/** Composed inside adminScript's closure; all API values are rendered as text. */
export const adminCouponScript = String.raw`
let page = 1, total = 0, couponSequence = 0, action = null;
const requestId = () => crypto.randomUUID();
function clearCouponState() { page = 1; total = 0; action = null; couponSequence++; }
function showCodes(codes) {
  $('full-codes').value = codes.join('\n'); $('copy-status').textContent = '';
  $('code-dialog').showModal();
}
function button(label, task, disabled = false) {
  const element = node('button',label); element.type = 'button'; element.disabled = disabled;
  element.addEventListener('click', () => run(element, task)); return element;
}
function openAction(item, type) {
  const titles = {dispatch:'确认手动分发', 'confirm-stock':'确认旧码库存', revoke:'停止后续核销'};
  action = {id:item.id, type, requestId:requestId()};
  $('mutation').reset();
  $('action-title').textContent = titles[type] + ' · ' + item.maskedCode;
  $('action-description').textContent = type === 'revoke' ? '仅禁止后续核销，已有设备权限、授权期限与历史绑定不会撤回。' : type === 'confirm-stock' ? 'UNKNOWN 不等于可用库存。请人工核实此码尚未分发、未核销，再确认转为 IDLE。' : '请核对收件人与分发渠道。此操作会明确记录 DISPATCHED，复制不会自动执行它。';
  $('action-note-label').hidden = type !== 'dispatch';
  $('action-reason-label').hidden = type !== 'revoke';
  $('mutation').elements.reason.required = type === 'revoke';
  $('action-request').textContent = '请求 ID：' + action.requestId + '（失败重试保留）';
  $('action-dialog').showModal();
}
async function coupons() {
  const sequence = ++couponSequence;
  $('coupon-rows').replaceChildren(); $('pagination').textContent = '正在读取库存…';
  const parameters = new URLSearchParams(new FormData($('filters')));
  parameters.set('page',String(page));
  try {
    const data = await api('coupons?' + parameters.toString());
    if (sequence !== couponSequence) return;
    total = data.total; page = data.page;
    for (const item of data.items) {
      const row = node('tr');
      row.append(node('td',item.maskedCode + '\n' + item.tier_name + ' (' + item.tier + ')'),node('td',item.status + ' · ' + item.device_count + '/' + item.max_devices + ' 设备'),node('td',item.dispatch_status),node('td',(item.note || '无批次备注') + '\n分发备注：' + (item.dispatch_note || '无')));
      const cell = node('td'), actions = node('div',undefined,'actions');
      actions.append(button('绑定详情', async () => { const detail = await api('coupons/' + item.id); $('detail').textContent = JSON.stringify(detail,null,2); $('detail-dialog').showModal(); }));
      const revealRequest = requestId();
      actions.append(button('查看全码', async () => { const data = await api('coupons/' + item.id + '/reveal', {requestId:revealRequest}); showCodes([data.code]); }));
      const stock = item.status !== 'REVOKED' && item.device_count === 0;
      actions.append(button('确认库存', () => openAction(item,'confirm-stock'), !stock || item.dispatch_status !== 'UNKNOWN'));
      actions.append(button('确认分发', () => openAction(item,'dispatch'), !stock || item.dispatch_status !== 'IDLE'));
      actions.append(button('停止核销', () => openAction(item,'revoke'), item.status === 'REVOKED'));
      cell.append(actions); row.append(cell); $('coupon-rows').append(row);
    }
    if (!data.items.length) { const row = node('tr'), cell = node('td','没有符合筛选的卡密'); cell.colSpan = 5; row.append(cell); $('coupon-rows').append(row); }
    $('pagination').textContent = '第 ' + page + ' / ' + Math.max(1,Math.ceil(total / data.limit)) + ' 页 · 共 ' + total + ' 条';
    $('previous').disabled = page <= 1; $('next').disabled = page * data.limit >= total;
  } catch (error) { if (sequence === couponSequence) $('pagination').textContent = '库存读取失败，可重新筛选或刷新。'; throw error; }
}
$('filters').addEventListener('submit', event => { event.preventDefault(); page = 1; run(event.currentTarget.querySelector('button'), coupons); });
$('previous').addEventListener('click', event => run(event.currentTarget, async () => { if (page > 1) page--; await coupons(); }));
$('next').addEventListener('click', event => run(event.currentTarget, async () => { if (page * Number($('filters').elements.limit.value) < total) page++; await coupons(); }));
$('new-request').addEventListener('click', () => { $('generate').elements.requestId.value = requestId(); });
$('generate').elements.requestId.value = requestId();
$('generate').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  run(form.querySelector('[type=submit]'), async () => {
    const body = Object.fromEntries(new FormData(form)); body.count = Number(body.count);
    const data = await api('coupons/generate',body);
    showCodes(data.codes); message(data.created ? '已生成。请核对库存后显式分发。' : '已恢复同一请求的生成结果，未重复生成。');
    // Keep requestId after success: changing it is an explicit new batch action.
    await coupons();
  });
});
$('mutation').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  if (!action || !form.elements.confirmed.checked) return;
  run(form.querySelector('[type=submit]'), async () => {
    const current = action;
    const note = form.elements.note.value, reason = form.elements.reason.value;
    if (current.type === 'revoke' && !reason.trim()) throw new Error('请填写停止核销原因。');
    const result = await api('coupons/' + current.id + '/' + current.type, {requestId:current.requestId, note, reason});
    $('action-dialog').close(); action = null;
    message('已完成：' + result.status + '。已有设备权限未改变。'); await coupons();
  });
});
$('copy').addEventListener('click', event => run(event.currentTarget, async () => {
  const codes = $('full-codes').value;
  if (!codes) return;
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(codes);
    if ($('code-dialog').open && $('full-codes').value === codes) $('copy-status').textContent = '已复制；尚未标记分发。';
  } catch {
    if (!$('code-dialog').open) return;
    $('copy-status').textContent = '剪贴板不可用或被拒绝，未确认复制成功。请选中下方全码手动复制。';
    $('full-codes').focus(); $('full-codes').select();
  }
}));
`;
