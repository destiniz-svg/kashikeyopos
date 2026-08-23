/* ═══ HOW THE BYTES REACH THE PAPER ══════════════════════════════════════════
   A browser cannot open a TCP socket, and a cloud server cannot see the
   restaurant's LAN — so which path a printer uses depends on where it is
   plugged in, and the till says so per printer instead of pretending one
   route fits all:

     usb     WebUSB. The printer is cabled to THIS till. Chrome asks the
             operator once, remembers the grant, and this module reattaches
             on every reload without asking again.
     serial  Web Serial, for USB-serial and true serial printers. Same
             grant-and-remember shape.
     net     the printer has an Ethernet jack. The till cannot reach it, so
             the SERVER relays the bytes to port 9100 — which is only real
             when the server is on the same network as the printer
             (a LAN-hosted install). A cloud deploy that configures `net`
             will get an honest failure, not a silent success.
     spool   no transport. Jobs hold in the spool as documents — the state
             every install starts in, and says so on the printers screen.

   Connect actions MUST run inside a user gesture (the browser requires it
   for the permission prompt), which is why the printers screen has a button
   and this module never prompts on its own. */
(function (root) {
  "use strict";
  if (!root || root.KPOS_PRINT) return;
  const E = root.KASHIKEYO_ESCPOS;

  /* Live handles, keyed by printer id. Grants survive a reload (the browser
     remembers them); handles do not, so they are reattached lazily on the
     first send after a reload, matched by the vendor/product ids saved when
     the operator connected. */
  const live = {};

  function ids(info) {
    return { vendorId: info.usbVendorId || info.vendorId || 0,
      productId: info.usbProductId || info.productId || 0 };
  }

  async function connectSerial(printerId, baud) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: Number(baud) || 9600 });
    live[printerId] = { kind: "serial", port: port };
    return ids(port.getInfo ? port.getInfo() : {});
  }

  async function openUsb(dev) {
    await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);
    // A printer's data interface is class 7. Take the first OUT endpoint on it.
    for (const iface of dev.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== 7) continue;
        const ep = alt.endpoints.find((e) => e.direction === "out");
        if (!ep) continue;
        await dev.claimInterface(iface.interfaceNumber);
        return { dev: dev, ep: ep.endpointNumber };
      }
    }
    throw new Error("no printer interface on that device");
  }

  async function connectUsb(printerId) {
    const dev = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] });
    live[printerId] = Object.assign({ kind: "usb" }, await openUsb(dev));
    return { vendorId: dev.vendorId, productId: dev.productId };
  }

  /* After a reload: the grant is still there, the handle is not. */
  async function reattach(printerId, cfg) {
    if (cfg.conn === "usb" && navigator.usb) {
      const devs = await navigator.usb.getDevices();
      const dev = devs.find((d) => d.vendorId === cfg.vendorId
        && d.productId === cfg.productId) || devs[0];
      if (!dev) throw new Error("printer not attached — reconnect it on the printers screen");
      live[printerId] = Object.assign({ kind: "usb" }, await openUsb(dev));
      return;
    }
    if (cfg.conn === "serial" && navigator.serial) {
      const ports = await navigator.serial.getPorts();
      const port = ports.find((p) => {
        const i = p.getInfo ? p.getInfo() : {};
        return i.usbVendorId === cfg.vendorId && i.usbProductId === cfg.productId;
      }) || ports[0];
      if (!port) throw new Error("printer not attached — reconnect it on the printers screen");
      if (!port.readable) await port.open({ baudRate: Number(cfg.baud) || 9600 });
      live[printerId] = { kind: "serial", port: port };
      return;
    }
    throw new Error("this browser has no " + cfg.conn + " support");
  }

  async function send(printerId, bytes, cfg) {
    const c = cfg || {};
    if (c.conn === "net") {
      if (!c.host) throw new Error("no printer address configured");
      if (!root.KPOS_API || !root.KPOS_API.print) throw new Error("no connection to the outlet");
      return root.KPOS_API.print(c.host, E.toBase64(bytes));
    }
    if (c.conn !== "usb" && c.conn !== "serial") {
      throw new Error("no transport configured — the document is in the spool");
    }
    if (!live[printerId]) await reattach(printerId, c);
    const h = live[printerId];
    const data = new Uint8Array(bytes);
    if (h.kind === "usb") {
      const r = await h.dev.transferOut(h.ep, data);
      if (r.status !== "ok") throw new Error("printer refused the transfer: " + r.status);
      return { sent: true, via: "usb" };
    }
    const w = h.port.writable.getWriter();
    try { await w.write(data); } finally { w.releaseLock(); }
    return { sent: true, via: "serial" };
  }

  root.KPOS_PRINT = {
    connectSerial: connectSerial,
    connectUsb: connectUsb,
    send: send,
    // The drawer plugs into the receipt printer; opening it is a print.
    kick: function (printerId, cfg) { return send(printerId, E.drawerPulse(), cfg); },
    supports: function () {
      return { usb: !!navigator.usb, serial: !!navigator.serial };
    }
  };
}(typeof window !== "undefined" ? window : null));
