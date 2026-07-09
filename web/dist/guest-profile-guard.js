(function () {
  'use strict';

  const state = { boot: null, orders: [], loading: false, polling: null, events: null, observer: null };
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
  function buttons() { return Array.from(document.querySelectorAll('button,[role="button"],a')); }
  function byText(s) { const n = s.toLowerCase(); return buttons().find((b) => text(b).includes(n)); }
  function statusName(s) {
    const v = String(s || 'new').toLowerCase();
    if (v === 'new') return 'New';
    if (v === 'accepted' || v === 'accept') return 'Accepted';
    if (v === 'preparing' || v === 'kitchen') return 'Preparing';
    if (v === 'ready') return 'Ready';
    if (v === 'served') return 'Served';
    if (finalStatuses.includes(v)) return 'Settled';
    if (v === 'cancelled' || v === 'canceled' || v === 'void') return 'Cancelled';
    return v.charAt(0).toUpperCase() + v.slice(1);
  }
  function selectedTable() {
    const c = ctx();
    return c.table || sessionStorage.getItem(key('guestTable')) || '';
  }
  function setSelectedTable(v) {
    const clean = String(v || '').trim();
    if (clean) sessionStorage.setItem(key('guestTable'), clean);
    else sessionStorage.removeItem(key('guestTable'));
    renderCheckoutMode();
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
    renderCheckoutMode();
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
        patchVisibleOrders();
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

  function patchVisibleOrders() {
    for (const order of state.orders) {
      if (!order.no && !order.id) continue;
      const needle = String(order.no || order.id).toLowerCase();
      const host = Array.from(document.querySelectorAll('div,li,section,article')).find((el) => text(el).includes(needle));
      if (!host) continue;
      let badge = host.querySelector('[data-kashikeyo-live-status]');
      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute('data-kashikeyo-live-status', '1');
        badge.style.cssText = 'display:inline-flex;margin-left:8px;padding:4px 8px;border-radius:999px;background:#0f2a33;color:#67e8f9;font-weight:900;font-size:12px;vertical-align:middle';
        host.appendChild(badge);
      }
      badge.textContent = statusName(order.status);
    }
  }

  function tableOptions() {
    const tables = state.boot && Array.isArray(state.boot.tables) ? state.boot.tables : [];
    return tables.filter(Boolean);
  }
  function findModeGroup() {
    const pickup = byText('pickup');
    const delivery = byText('delivery');
    if (!pickup || !delivery) return null;
    let p = pickup.parentElement;
    while (p && p !== document.body) {
      if (p.contains(delivery)) return { group: p, pickup, delivery };
      p = p.parentElement;
    }
    return pickup.parentElement ? { group: pickup.parentElement, pickup, delivery } : null;
  }
  function renderCheckoutMode() {
    const c = ctx();
    if (!c.isGuest || c.table) return;
    const found = findModeGroup();
    if (!found) return;
    const { group, pickup, delivery } = found;
    if (!pickup.dataset.kashikeyoMode) {
      pickup.dataset.kashikeyoMode = 'pickup';
      pickup.addEventListener('click', () => setOrderMode('pickup'), true);
    }
    if (!delivery.dataset.kashikeyoMode) {
      delivery.dataset.kashikeyoMode = 'delivery';
      delivery.addEventListener('click', () => setOrderMode('delivery'), true);
    }
    let dine = document.getElementById('kashikeyo-dinein-mode');
    if (!dine) {
      dine = pickup.cloneNode(true);
      dine.id = 'kashikeyo-dinein-mode';
      dine.textContent = 'Dine in';
      dine.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setOrderMode('dinein'); }, true);
      group.appendChild(dine);
    }
    const mode = orderMode();
    dine.style.opacity = mode === 'dinein' ? '1' : '.82';
    dine.style.outline = mode === 'dinein' ? '2px solid #06bfd4' : '0';
    dine.style.outlineOffset = '-2px';
    renderTableSelect(group, mode);
  }
  function renderTableSelect(group, mode) {
    let row = document.getElementById('kashikeyo-dinein-table');
    if (mode !== 'dinein') { if (row) row.remove(); return; }
    const tables = tableOptions();
    if (!tables.length) return;
    if (!row) {
      row = document.createElement('div');
      row.id = 'kashikeyo-dinein-table';
      group.insertAdjacentElement('afterend', row);
    }
    const current = selectedTable();
    row.innerHTML = `<style>#kashikeyo-dinein-table{margin:10px 0 0}#kashikeyo-dinein-table select{width:100%;border:0;border-radius:14px;background:#1f2d41;color:#f8fafc;padding:13px 12px;font-size:15px;font-weight:800}</style><select aria-label="Select table"><option value="">Select table</option>${tables.map((t) => `<option value="${esc(t)}" ${String(t) === current ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    row.querySelector('select').addEventListener('change', (e) => setSelectedTable(e.target.value));
  }
  async function pickTable() {
    await boot(true);
    if (orderMode() !== 'dinein') return '';
    const table = selectedTable();
    if (table) return table;
    renderCheckoutMode();
    const sel = document.querySelector('#kashikeyo-dinein-table select');
    if (sel) sel.focus();
    return '';
  }

  function showProfile() {
    const latest = state.orders[0];
    if (!latest) return false;
    renderLiveStatus();
    const tab = byText('my orders') || byText('orders');
    if (tab) tab.click();
    return true;
  }
  function isTopRight(event) {
    const target = event.target && event.target.closest && event.target.closest('button,a,[role="button"]');
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const right = Math.max(document.documentElement.clientWidth, innerWidth || 0) - rect.right;
    return rect.top <= 130 && right <= 130 && rect.width <= 100 && rect.height <= 100;
  }
  function start() {
    if (!ctx().isGuest) return;
    boot(true).then(refreshOrders).then(renderCheckoutMode);
    clearInterval(state.polling);
    state.polling = setInterval(refreshOrders, 4000);
    if (state.events) state.events.close();
    try {
      const c = ctx();
      state.events = new EventSource(`/p/${encodeURIComponent(c.slug)}/events?storeId=${encodeURIComponent(c.storeId)}`);
      state.events.onmessage = refreshOrders;
    } catch {}
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(() => { renderCheckoutMode(); patchVisibleOrders(); });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('click', (event) => {
    if (!ctx().isGuest || !isTopRight(event)) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); showProfile();
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.KashikeyoGuestProfile = { context: ctx, show: showProfile, refreshOrders, getSelectedTable: selectedTable, setSelectedTable, getOrderMode: orderMode, setOrderMode, pickTable };
})();
