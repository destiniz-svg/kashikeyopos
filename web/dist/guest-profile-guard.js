(function () {
  'use strict';

  const state = { boot: null, orders: [], loading: false, polling: null, events: null, uiTimer: null };
  const finalStatuses = ['completed', 'complete', 'settled', 'paid', 'closed'];

  function qp() { return new URLSearchParams(location.search || ''); }
  function ctx() {
    const q = qp();
    const slug = q.get('s') || q.get('workspace') || q.get('slug') || '';
    const customerId = q.get('c') || q.get('custId') || q.get('customerId') || '';
    const table = q.get('t') || q.get('table') || '';
    const storeId = q.get('storeId') || q.get('store') || q.get('st') || localStorage.getItem('kashikeyo.storeId') || 'main';
    return { slug, customerId, table, storeId, isGuest: Boolean(slug && (customerId || table)) };
  }
  function key(name) {
    const c = ctx();
    return `kashikeyo.${name}.${c.slug}.${c.storeId}.${c.customerId || c.table || 'guest'}`;
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
  function money(v) { const n = Number(v || 0); return Number.isFinite(n) ? n.toFixed(2) : '0.00'; }
  function text(el) { return (el && el.textContent || '').trim().toLowerCase(); }
  function buttons() { return Array.from(document.querySelectorAll('button,[role="button"]')); }
  function byText(s) { const n = s.toLowerCase(); return buttons().find((b) => text(b).includes(n)); }
  function statusName(s) {
    const v = String(s || 'new').toLowerCase();
    if (v === 'accepted' || v === 'accept') return 'Accepted';
    if (v === 'preparing' || v === 'kitchen') return 'Preparing';
    if (v === 'ready') return 'Ready';
    if (v === 'served') return 'Served';
    if (finalStatuses.includes(v)) return 'Settled';
    if (v === 'cancelled' || v === 'canceled' || v === 'void') return 'Cancelled';
    return v.charAt(0).toUpperCase() + v.slice(1 || 1) || 'New';
  }
  function selectedTable() {
    const c = ctx();
    return c.table || sessionStorage.getItem(key('guestTable')) || '';
  }
  function setSelectedTable(v) {
    const clean = String(v || '').trim();
    if (clean) sessionStorage.setItem(key('guestTable'), clean);
    else sessionStorage.removeItem(key('guestTable'));
    paintDineButton();
    renderTableSelect();
    return clean;
  }
  function orderMode() {
    const c = ctx();
    if (c.table || selectedTable()) return 'dinein';
    return sessionStorage.getItem(key('guestMode')) || '';
  }
  function setOrderMode(v) {
    const mode = ['pickup', 'delivery', 'dinein'].includes(v) ? v : '';
    if (mode) sessionStorage.setItem(key('guestMode'), mode);
    else sessionStorage.removeItem(key('guestMode'));
    if (mode !== 'dinein') setSelectedTable('');
    paintDineButton();
    renderTableSelect();
    return mode;
  }

  async function boot(force) {
    const c = ctx();
    if (!c.isGuest || (state.boot && !force) || state.loading) return state.boot;
    state.loading = true;
    try {
      const q = new URLSearchParams();
      if (c.customerId) q.set('c', c.customerId);
      if (c.table) q.set('t', c.table);
      q.set('storeId', c.storeId);
      const r = await fetch(`/p/${encodeURIComponent(c.slug)}/boot?${q}`, { cache: 'no-store' });
      if (r.ok) state.boot = await r.json();
    } catch {}
    state.loading = false;
    return state.boot;
  }
  async function refreshOrders() {
    const c = ctx();
    if (!c.isGuest) return state.orders;
    try {
      const q = new URLSearchParams();
      if (c.customerId) q.set('c', c.customerId);
      if (c.table) q.set('t', c.table);
      q.set('storeId', c.storeId);
      q.set('ts', Date.now());
      const r = await fetch(`/p/${encodeURIComponent(c.slug)}/orders?${q}`, { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        state.orders = Array.isArray(data.orders) ? data.orders : [];
        renderLiveStatus();
      }
    } catch {}
    return state.orders;
  }

  function renderLiveStatus() {
    const c = ctx();
    const latest = state.orders[0];
    let node = document.getElementById('kashikeyo-live-order-status');
    if (!c.isGuest || !latest) { if (node) node.remove(); return; }
    const tab = byText('my orders') || byText('orders');
    if (!tab || !tab.parentElement) return;
    if (!node) {
      node = document.createElement('div');
      node.id = 'kashikeyo-live-order-status';
    }
    const isFinal = finalStatuses.includes(String(latest.status || '').toLowerCase());
    node.innerHTML = `<style>#kashikeyo-live-order-status{margin:10px 0 12px;padding:12px 14px;border-radius:16px;background:${isFinal ? '#123422' : '#0f2a33'};border:1px solid ${isFinal ? 'rgba(74,222,128,.35)' : 'rgba(103,232,249,.35)'};color:#f8fafc;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#kashikeyo-live-order-status b{font-size:14px}#kashikeyo-live-order-status span{font-size:13px;color:#a7b3c7}#kashikeyo-live-order-status em{font-style:normal;font-weight:900;color:${isFinal ? '#86efac' : '#67e8f9'}}</style><div><b>${esc(latest.no || 'Order')}${latest.table ? ' · ' + esc(latest.table) : ''}</b><br><span>MVR ${money(latest.total)} · ${(latest.items || []).length || 0} items</span></div><em>${esc(statusName(latest.status))}</em>`;
    if (!node.parentElement) tab.parentElement.insertAdjacentElement('afterend', node);
  }

  function tableOptions() {
    const tables = state.boot && Array.isArray(state.boot.tables) ? state.boot.tables : [];
    return tables.filter(Boolean);
  }
  function modeGroup() {
    const pickup = byText('pickup');
    const delivery = byText('delivery');
    if (!pickup || !delivery) return null;
    let p = pickup.parentElement;
    while (p && p !== document.body) {
      if (p.contains(delivery)) return { group: p, pickup, delivery };
      p = p.parentElement;
    }
    return { group: pickup.parentElement, pickup, delivery };
  }
  function copyButtonLook(from, to) {
    to.className = from.className || '';
    const cs = getComputedStyle(from);
    ['borderRadius', 'padding', 'font', 'fontSize', 'fontWeight', 'minHeight', 'height'].forEach((k) => { try { to.style[k] = cs[k]; } catch {} });
    to.style.border = cs.border;
    to.style.background = orderMode() === 'dinein' ? cs.backgroundColor : cs.background;
    to.style.color = cs.color;
  }
  function ensureDineButton() {
    const c = ctx();
    if (!c.isGuest || c.table) return null;
    const found = modeGroup();
    if (!found || !found.group) return null;
    const { group, pickup, delivery } = found;
    if (!pickup.dataset.kashikeyoNative) {
      pickup.dataset.kashikeyoNative = '1';
      pickup.addEventListener('click', () => setOrderMode('pickup'));
    }
    if (!delivery.dataset.kashikeyoNative) {
      delivery.dataset.kashikeyoNative = '1';
      delivery.addEventListener('click', () => setOrderMode('delivery'));
    }
    let dine = document.getElementById('kashikeyo-dinein-mode');
    if (!dine) {
      dine = document.createElement('button');
      dine.id = 'kashikeyo-dinein-mode';
      dine.type = 'button';
      dine.textContent = 'Dine in';
      dine.addEventListener('click', () => setOrderMode('dinein'));
      group.appendChild(dine);
    }
    copyButtonLook(pickup, dine);
    paintDineButton();
    return dine;
  }
  function paintDineButton() {
    const dine = document.getElementById('kashikeyo-dinein-mode');
    if (!dine) return;
    const active = orderMode() === 'dinein';
    dine.style.opacity = active ? '1' : '.86';
    dine.style.boxShadow = active ? 'inset 0 0 0 2px #06bfd4' : '';
  }
  function renderTableSelect() {
    const found = modeGroup();
    let row = document.getElementById('kashikeyo-dinein-table');
    if (!found || orderMode() !== 'dinein') { if (row) row.remove(); return; }
    const tables = tableOptions();
    if (!tables.length) return;
    if (!row) {
      row = document.createElement('div');
      row.id = 'kashikeyo-dinein-table';
      found.group.insertAdjacentElement('afterend', row);
    }
    const current = selectedTable();
    row.innerHTML = `<style>#kashikeyo-dinein-table{margin:10px 0 0}#kashikeyo-dinein-table select{width:100%;border:0;border-radius:14px;background:#1f2d41;color:#f8fafc;padding:13px 12px;font-size:15px;font-weight:800;font-family:inherit}</style><select aria-label="Select table"><option value="">Select table</option>${tables.map((t) => `<option value="${esc(t)}" ${String(t) === current ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    row.querySelector('select').addEventListener('change', (e) => setSelectedTable(e.target.value));
  }
  function refreshUi() {
    ensureDineButton();
    renderTableSelect();
  }
  async function pickTable() {
    await boot(true);
    if (orderMode() !== 'dinein') return '';
    const t = selectedTable();
    if (t) return t;
    refreshUi();
    const select = document.querySelector('#kashikeyo-dinein-table select');
    if (select) select.focus();
    return '';
  }

  function start() {
    if (!ctx().isGuest) return;
    boot(true).then(() => { refreshOrders(); refreshUi(); });
    clearInterval(state.polling);
    state.polling = setInterval(refreshOrders, 5000);
    clearInterval(state.uiTimer);
    state.uiTimer = setInterval(refreshUi, 1200);
    if (state.events) state.events.close();
    try {
      const c = ctx();
      state.events = new EventSource(`/p/${encodeURIComponent(c.slug)}/events?storeId=${encodeURIComponent(c.storeId)}`);
      state.events.onmessage = refreshOrders;
    } catch {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.KashikeyoGuestProfile = { context: ctx, refreshOrders, getSelectedTable: selectedTable, setSelectedTable, getOrderMode: orderMode, setOrderMode, pickTable };
})();
