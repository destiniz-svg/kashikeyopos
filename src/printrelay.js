'use strict';
/* THE LAN PRINT RELAY, with no gate of its own. Mounted behind the staff
   session in the cloud (routes/outlet.js) and behind the cloud's say-so on a
   store hub (src/hub.js), so the SSRF fence below exists exactly once. */
module.exports = async function relay(req, res) {
  const b = req.body || {};
  const host = String(b.host || '').trim();
  const data = String(b.data || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host)) {
    return res.status(400).json({ error: 'that is not a printer address' });
  }
  if (!data || data.length > 90000) {
    return res.status(400).json({ error: 'a print job is at most 64KB of bytes' });
  }
  let buf;
  try { buf = Buffer.from(data, 'base64'); } catch (e) { buf = null; }
  if (!buf || !buf.length) return res.status(400).json({ error: 'no bytes to print' });

  try {
    const dns = require('dns');
    const { address } = await dns.promises.lookup(host);
    /* AN ALLOW-LIST, NOT A DENY-LIST. This blocked the addresses somebody had
       thought of — 127.x, ::1, 169.254.x — and let everything else through,
       which meant two things. It let 0.0.0.0 through, and on Linux a connect
       to the unspecified address goes to loopback: proved by dialling it, the
       bytes arrived at a listener on 127.0.0.1:9100 and this endpoint answered
       {"sent":true}. And it let PUBLIC addresses through, so a signed-in
       cashier could ask the server to open a socket to any host on the
       internet, one port at a time.

       A printer is never on a public address. So the question is turned round:
       the resolved address must be inside a PRIVATE range, and everything
       outside one is refused without anybody having to have thought of it
       first. That is the whole of the SSRF surface closed rather than fenced.

       An IPv4-mapped IPv6 address is the same address wearing a different
       spelling, so it is unwrapped BEFORE it is judged rather than
       pattern-matched twice — and the address dialled below is the unwrapped
       one, so what was judged is what is reached. */
    const flat = String(address).replace(/^::ffff:/i, '');
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(flat);
    const o = v4 ? v4.slice(1, 5).map(Number) : null;
    const privateV4 = !!o && o.every((n) => n >= 0 && n <= 255) && (
      o[0] === 10                                   // 10/8
      || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)  // 172.16/12
      || (o[0] === 192 && o[1] === 168)              // 192.168/16
      || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) // 100.64/10, carrier NAT
    );
    // fc00::/7 is the v6 side of "private", and the only v6 range a printer
    // is plausibly on. Link-local (fe80::/10, and 169.254 on the v4 side) is
    // deliberately NOT private here: 169.254.169.254 is every cloud's
    // metadata service.
    const privateV6 = /^f[cd][0-9a-f]{2}:/i.test(flat);
    const allowLoop = process.env.NODE_ENV !== 'production'
      && process.env.PRINT_ALLOW_LOOPBACK === '1'
      && (/^127\./.test(flat) || flat === '::1');

    if (!privateV4 && !privateV6 && !allowLoop) {
      return res.status(400).json({
        error: 'that is not a printer on this network — a receipt printer sits'
             + ' on the shop\'s own LAN, and only those addresses are dialled'
      });
    }
    const net = require('net');
    await new Promise(function (resolve, reject) {
      // Dial exactly what was judged, not the string DNS handed back.
      const sock = net.connect({ host: flat, port: 9100 });
      const die = (msg) => { sock.destroy(); reject(new Error(msg)); };
      sock.setTimeout(4000, () => die('the printer did not answer in 4 seconds'));
      sock.on('error', (e) => die(e.code === 'ECONNREFUSED'
        ? 'nothing is listening at ' + host + ':9100' : e.message));
      sock.on('connect', function () {
        sock.end(buf, () => resolve());
      });
    });
    res.json({ sent: true, via: 'net', bytes: buf.length });
  } catch (e) {
    // An unreachable printer is an operational fact, not a server fault.
    res.status(502).json({ error: e.message });
  }
};
