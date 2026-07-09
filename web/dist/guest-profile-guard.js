(function () {
  'use strict';

  const state = { boot: null, orders: [], loading: false, orderLoading: false, source: null, poll: null, observer: null };
  const finalStatuses = ['completed', 'settled', 'paid', 'closed', 'cancelled', 'void'];

  function params() { return new URLSearchParams(window.location.search || ''); }
  function guestContext() {
    const q = params();
    const slug = q.get('s') || q.get('workspace') || q.get('slug') || '';
    const customerId = q.get('c') || q.get('custId') || q.get('customerId') || '';
    const table = q.get('t') || q.get('table') || '';
    const storeId = q.get('storeId') || q.get('store') || q.get('st') || localStorage.getItem('kashikeyo.storeId') || 'main';
    return { slug, customerId, table, storeId, isGuest: Boolean(slug && (customerId || table)) };
  }
  function scopedKey(name) {
    const ctx = guestContext();
    return `kashikeyo.${name}.${ctx.slug}.${ctx.storeId}.${ctx.customerId || ctx.table || 'guest'}`;
  }
  function getSelectedTable() {
    const ctx = guestContext();
    return ctx.table || sessionStorage.getItem(scopedKey('guestTable')) || '';
  }
  function setSelectedTable(value) {
    const clean = String(value || '').trim();
    if (clean) sessionStorage.setItem(scopedKey('guestTable'), clean);
    else sessionStorage.removeItem(scopedKey('guestTable'));
    renderCheckoutEnhancements();
    return clean;
  }
  function getOrderMode() {
    const ctx = guestContext();
    if (ctx.table || getSelectedTable()) return 'dinein';
    return sessionStorage.getItem(scopedKey('guestOrderMode')) || '';
  }
  function setOrderMode(mode) {
    const clean = ['pickup', 'delivery', 'dinein'].includes(mode) ? mode : '';
    if (clean) sessionStorage.setItem(scopedKey('guestOrderMode'), clean);
    else sessionStorage.removeItem(scopedKey('guestOrderMode'));
    if (clean !== 'dinein') setSelectedTable('');
    renderCheckoutEnhancements();
    return clean;
  }
  function money(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  function statusLabel(value) {
    const s = String(value || 'new').toLowerCase();
    if (s === 'settled' || s === 'paid' || s === 'closed' || s === 'completed') return 'Settled';
    if (s === 'preparing') return 'Preparing';
    if (s === 'ready') return 'Ready';
    if (s === 'cancelled' || s === 'void') return 'Cancelled';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function findButtonByText(text) {
    const needle = text.toLowerCase();
    return Array.from(document.querySelectorAll('button, [role="button"], a')).find((el) => (el.textContent || '').trim().toLowerCase().includes(needle));
  }
  function closeSheet() { const sheet = document.getElementById('kashikeyo-guest-profile-sheet'); if (sheet) sheet.remove(); }
  function closeTablePicker() { const picker = document.getElementById('kashikeyo-table-picker'); if (picker) picker.remove(); }

  async function loadBoot(force) {
    const ctx = guestContext();
    if (!ctx.isGuest || (state.boot && !force) || state.loading) return state.boot;
    state.loading = true;
    try {
      const q = new URLSearchParams();
      if (ctx.customerId) q.set('c', ctx.customerId);
      if (ctx.table) q.set('t', ctx.table);
      if (ctx.storeId) q.set('storeId', ctx.storeId);
      const res = await fetch(`/p/${encodeURIComponent(ctx.slug)}/boot?${q.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        state.boot = await res.json();
        const bootOrders = state.boot && state.boot.cust && Array.isArray(state.boot.cust.orders) ? state.boot.cust.orders : [];
        if (bootOrders.length) state.orders = bootOrders;
      }
    } catch (err) { state.boot = null; }
    finally { state.loading = false; }
    renderCheckoutEnhancements();
    return state.boot;
  }

  async function loadOrders() {
    const ctx = guestContext();
    if (!ctx.isGuest || state.orderLoading) return state.orders;
    state.orderLoading = true;
    try {
      const q = new URLSearchParams();
      if (ctx.customerId) q.set('c', ctx.customerId);
      if (ctx.table) q.set('t', ctx.table);
      if (ctx.storeId) q.set('storeId', ctx.storeId);
      const res = await fetch(`/p/${encodeURIComponent(ctx.slug)}/orders?${q.toString()}&ts=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        state.orders = Array.isArray(data.orders) ? data.orders : [];
        if (state.boot && state.boot.cust) state.boot.cust.orders = state.orders;
        renderInlineOrderStatus();
        if (document.getElementById('kashikeyo-guest-profile-sheet')) renderSheet(state.boot);
      }
    } catch (err) {}
    finally { state.orderLoading = false; }
    return state.orders;
  }

  function renderInlineOrderStatus() {
    const existing = document.getElementById('kashikeyo-inline-order-status');
    const latest = state.orders[0];
    if (!guestContext().isGuest || !latest) { if (existing) existing.remove(); return; }
    const anchor = findButtonByText('my orders') || findButtonByText('orders');
    if (!anchor || !anchor.parentElement) return;
    const node = existing || document.createElement('div');
    node.id = 'kashikeyo-inline-order-status';
    const isFinal = finalStatuses.includes(String(latest.status || '').toLowerCase());
    node.innerHTML = `<style>#kashikeyo-inline-order-status{margin:10px 0 12px;padding:12px 14px;border-radius:16px;background:${isFinal ? '#123422' : '#0f2a33'};border:1px solid ${isFinal ? 'rgba(74,222,128,.35)' : 'rgba(103,232,249,.35)'};color:#f8fafc;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;justify-content:space-between;gap:12px;align-items:center}#kashikeyo-inline-order-status b{font-size:14px}#kashikeyo-inline-order-status span{color:#a7b3c7;font-size:13px}#kashikeyo-inline-order-status em{font-style:normal;color:${isFinal ? '#86efac' : '#67e8f9'};font-weight:900}</style><div><b>${esc(latest.no || 'Order')} ${latest.table ? '· ' + esc(latest.table) : ''}</b><br><span>${esc(latest.otype || 'order')} · MVR ${money(latest.total || 0)}</span></div><em>${esc(statusLabel(latest.status))}</em>`;
    if (!existing) anchor.parentElement.insertAdjacentElement('afterend', node);
  }

  function renderCheckoutEnhancements() {
    const ctx = guestContext();
    if (!ctx.isGuest || ctx.table) return;
    const pickup = findButtonByText('pickup');
    const delivery = findButtonByText('delivery');
    if (!pickup || !delivery || !pickup.parentElement || pickup.parentElement !== delivery.parentElement) return;
    const group = pickup.parentElement;
    pickup.addEventListener('click', () => setOrderMode('pickup'), { passive: true });
    delivery.addEventListener('click', () => setOrderMode('delivery'), { passive: true });
    let dine = document.getElementById('kashikeyo-dinein-button');
    if (!dine) {
      dine = document.createElement('button');
      dine.id = 'kashikeyo-dinein-button';
      dine.type = 'button';
      dine.textContent = 'Dine in';
      dine.addEventListener('click', () => setOrderMode('dinein'));
      group.appendChild(dine);
    }
    const mode = getOrderMode();
    dine.setAttribute('style', `border:0;border-radius:14px;padding:12px 14px;font-weight:900;font-size:15px;background:${mode === 'dinein' ? '#06bfd4' : '#1f2d41'};color:${mode === 'dinein' ? '#02111a' : '#f8fafc'};min-width:0`);
    let row = document.getElementById('kashikeyo-dinein-table-row');
    if (mode !== 'dinein') { if (row) row.remove(); return; }
    const tables = state.boot && Array.isArray(state.boot.tables) ? state.boot.tables.filter(Boolean) : [];
    if (!tables.length) return;
    if (!row) {
      row = document.createElement('div');
      row.id = 'kashikeyo-dinein-table-row';
      group.insertAdjacentElement('afterend', row);
    }
    const selected = getSelectedTable();
    row.innerHTML = `<style>#kashikeyo-dinein-table-row{margin:10px 0 0;display:flex;gap:10px;align-items:center}#kashikeyo-dinein-table-row select{flex:1;border:0;border-radius:14px;background:#1f2d41;color:#f8fafc;padding:13px 12px;font-size:15px;font-weight:800}</style><select aria-label="Select table"><option value="">Select table</option>${tables.map((t) => `<option value="${esc(t)}" ${String(t) === selected ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    row.querySelector('select').addEventListener('change', (event) => setSelectedTable(event.target.value));
  }

  async function pickTable() {
    const ctx = guestContext();
    if (!ctx.isGuest) return '';
    if (ctx.table) return ctx.table;
    const boot = await loadBoot(true);
    const tables = boot && Array.isArray(boot.tables) ? boot.tables.filter(Boolean) : [];
    if (!ctx.customerId || !tables.length) return '';
    const existing = getSelectedTable();
    return new Promise((resolve) => {
      closeTablePicker();
      const node = document.createElement('div');
      node.id = 'kashikeyo-table-picker';
      node.innerHTML = `<style>#kashikeyo-table-picker{position:fixed;inset:0;z-index:2147483647;background:rgba(1,7,24,.64);display:flex;align-items:flex-end;justify-content:center;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f8fafc}#kashikeyo-table-picker .ktp-panel{width:min(680px,100%);background:#101827;border:1px solid rgba(148,163,184,.28);border-radius:24px 24px 0 0;box-shadow:0 -24px 80px rgba(0,0,0,.45);padding:20px}#kashikeyo-table-picker h2{margin:0 0 6px;font-size:22px;letter-spacing:0}#kashikeyo-table-picker p{margin:0 0 16px;color:#a7b3c7;font-size:14px}#kashikeyo-table-picker select{width:100%;border:0;border-radius:14px;background:#1f2d41;color:#f8fafc;padding:14px 13px;font-size:17px;font-weight:800;margin-bottom:14px}#kashikeyo-table-picker .ktp-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}#kashikeyo-table-picker button{border:0;border-radius:14px;padding:14px 12px;background:#1f2d41;color:#f8fafc;font-weight:900;font-size:15px}#kashikeyo-table-picker [data-ktp-dine]{background:#06bfd4;color:#02111a}</style><section class="ktp-panel" role="dialog" aria-modal="true" aria-label="Choose table"><h2>Select table</h2><p>Dine-in orders need a table number for staff.</p><select aria-label="Table number"><option value="">Select table</option>${tables.map((t) => `<option value="${esc(t)}" ${String(t) === existing ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><div class="ktp-actions"><button type="button" data-ktp-pickup>Order as pickup</button><button type="button" data-ktp-dine>Dine in</button></div></section>`;
      const done = (value) => { closeTablePicker(); resolve(value || ''); };
      node.addEventListener('click', (event) => {
        if (event.target === node) done('');
        if (event.target.closest('[data-ktp-pickup]')) { setOrderMode('pickup'); done(''); }
        if (event.target.closest('[data-ktp-dine]')) {
          const value = node.querySelector('select').value;
          if (!value) return;
          setOrderMode('dinein');
          done(setSelectedTable(value));
        }
      });
      document.body.appendChild(node);
      if (existing) node.querySelector('select').value = existing;
    });
  }

  function renderSheet(boot) {
    const ctx = guestContext();
    const customer = (boot && boot.cust) || {};
    const orders = state.orders.length ? state.orders : (Array.isArray(customer.orders) ? customer.orders : []);
    const name = customer.name || (ctx.table ? `Table ${ctx.table}` : 'Guest profile');
    const stats = [['Visits', customer.visits || 0], ['Spent', money(customer.spent || 0)], ['Points', customer.points || 0], ['Credit', money(customer.credit || customer.balance || 0)]];
    const orderRows = orders.slice(0, 8).map((order) => `<li><span>${esc(order.no || order.id || 'Order')}${order.table ? ` · ${esc(order.table)}` : ''}</span><b>${esc(statusLabel(order.status))}</b><em>${order.total != null ? money(order.total) : ''}</em></li>`).join('') || '<li><span>No recent orders yet</span><b></b><em></em></li>';
    closeSheet();
    const node = document.createElement('div');
    node.id = 'kashikeyo-guest-profile-sheet';
    node.innerHTML = `<style>#kashikeyo-guest-profile-sheet{position:fixed;inset:0;z-index:2147483647;background:rgba(1,7,24,.62);display:flex;align-items:flex-end;justify-content:center;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f8fafc}#kashikeyo-guest-profile-sheet .kg-panel{width:min(720px,100%);max-height:86vh;overflow:auto;background:#101827;border:1px solid rgba(148,163,184,.28);border-radius:24px 24px 0 0;box-shadow:0 -24px 80px rgba(0,0,0,.45);padding:22px}#kashikeyo-guest-profile-sheet .kg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}#kashikeyo-guest-profile-sheet h2{margin:0;font-size:24px;line-height:1.2;letter-spacing:0}#kashikeyo-guest-profile-sheet p{margin:5px 0 0;color:#a7b3c7;font-size:14px}#kashikeyo-guest-profile-sheet button{border:0;border-radius:14px;padding:13px 16px;background:#1f2d41;color:#f8fafc;font-weight:800;font-size:15px}#kashikeyo-guest-profile-sheet [data-kg-profile-close]{width:44px;height:44px;padding:0;border-radius:999px;font-size:26px;line-height:1;background:#1f2d41}.kg-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0 18px}.kg-stat{background:#162235;border:1px solid rgba(148,163,184,.18);border-radius:14px;padding:12px;min-width:0}.kg-stat span{display:block;color:#93a4bc;font-size:12px;text-transform:uppercase;letter-spacing:.05em}.kg-stat b{display:block;margin-top:5px;font-size:18px;overflow:hidden;text-overflow:ellipsis}.kg-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px}.kg-actions button:first-child{background:#06bfd4;color:#02111a}#kashikeyo-guest-profile-sheet h3{margin:0 0 10px;font-size:15px;color:#cbd5e1;text-transform:uppercase;letter-spacing:.06em}#kashikeyo-guest-profile-sheet ul{margin:0;padding:0;list-style:none;background:#111c2e;border:1px solid rgba(148,163,184,.18);border-radius:16px;overflow:hidden}#kashikeyo-guest-profile-sheet li{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:13px 14px;border-bottom:1px solid rgba(148,163,184,.12)}#kashikeyo-guest-profile-sheet li:last-child{border-bottom:0}#kashikeyo-guest-profile-sheet li b{color:#67e8f9;font-size:13px}#kashikeyo-guest-profile-sheet li em{font-style:normal;color:#a7b3c7;font-family:ui-monospace,Menlo,Consolas,monospace}@media(max-width:560px){.kg-stats{grid-template-columns:repeat(2,1fr)!important}.kg-actions{grid-template-columns:1fr!important}#kashikeyo-guest-profile-sheet li{grid-template-columns:1fr auto}}</style><section class="kg-panel" role="dialog" aria-modal="true" aria-label="Guest profile"><div class="kg-head"><div><h2>${esc(name)}</h2><p>${ctx.customerId ? 'Customer profile' : 'Table ordering'}${ctx.storeId && ctx.storeId !== 'main' ? ` · ${esc(ctx.storeId)}` : ''}</p></div><button type="button" data-kg-profile-close aria-label="Close">x</button></div><div class="kg-stats">${stats.map(([label, value]) => `<div class="kg-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}</div><div class="kg-actions"><button type="button" data-kg-orders>My orders</button><button type="button" data-kg-menu>Back to menu</button></div><h3>Recent orders</h3><ul>${orderRows}</ul></section>`;
    node.addEventListener('click', (event) => {
      if (event.target === node || event.target.closest('[data-kg-profile-close]')) closeSheet();
      if (event.target.closest('[data-kg-orders]')) { closeSheet(); const orders = findButtonByText('my orders') || findButtonByText('orders'); if (orders) orders.click(); }
      if (event.target.closest('[data-kg-menu]')) { closeSheet(); const menu = findButtonByText('menu'); if (menu) menu.click(); }
    });
    document.body.appendChild(node);
  }

  async function showProfile() {
    if (!guestContext().isGuest) return false;
    sessionStorage.setItem('kashikeyo.guestMode', '1');
    renderSheet(state.boot);
    const boot = await loadBoot();
    await loadOrders();
    renderSheet(boot);
    return true;
  }
  function isTopRightAction(event) {
    const target = event.target && event.target.closest && event.target.closest('button,a,[role="button"]');
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const rightEdge = Math.max(document.documentElement.clientWidth, window.innerWidth || 0) - rect.right;
    return rect.top <= 130 && rightEdge <= 130 && rect.width <= 96 && rect.height <= 96;
  }
  function startLiveSync() {
    const ctx = guestContext();
    if (!ctx.isGuest) return;
    loadBoot().then(loadOrders);
    clearInterval(state.poll);
    state.poll = setInterval(loadOrders, 5000);
    if (state.source) state.source.close();
    try {
      const q = new URLSearchParams();
      if (ctx.storeId) q.set('storeId', ctx.storeId);
      state.source = new EventSource(`/p/${encodeURIComponent(ctx.slug)}/events?${q.toString()}`);
      state.source.onmessage = loadOrders;
      state.source.onerror = function () {};
    } catch (err) {}
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(() => renderCheckoutEnhancements());
    state.observer.observe(document.body, { childList: true, subtree: true });
    renderCheckoutEnhancements();
  }
  document.addEventListener('click', (event) => {
    if (!guestContext().isGuest || !isTopRightAction(event)) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); showProfile();
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startLiveSync);
  else startLiveSync();
  window.KashikeyoGuestProfile = { show: showProfile, context: guestContext, getSelectedTable, setSelectedTable, pickTable, refreshOrders: loadOrders, getOrderMode, setOrderMode };
})();
