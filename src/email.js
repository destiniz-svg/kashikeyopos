'use strict';
/* ═══ SENDING AN EMAIL ══════════════════════════════════════════════════════
   One seam, one driver. The application asks for an email to be sent and does
   not know or care how; swapping Resend for anything else is this file and
   nothing else.

   THE FALLBACK IS NOT A FAILURE. With no transport configured — a fresh
   install, a local run, a staging box with no key — the message is written to
   the audit trail and the call still succeeds, because a sign-in code that
   exists nowhere is worse than one an administrator can read out. What is
   never done is pretending: `sent` says which of the two happened, and the
   caller passes that fact to the person waiting.

   Configure with RESEND_API_KEY and EMAIL_FROM.
   ═══════════════════════════════════════════════════════════════════════ */

/* AN UNRESOLVED REFERENCE IS NOT A CONFIGURATION. Both services take these
   from the platform's environment, and on Railway a variable may be written as
   a reference to another service — `${{kashikeyopos.RESEND_API_KEY}}`. When
   that reference is right it is substituted before the process ever sees it;
   when the service name is wrong the LITERAL survives, non-empty and truthy.

   Left alone, that reads as configured, so every send is attempted with a
   nonsense key and comes back as a 401 from Resend — which tells whoever is
   reading it that the key is wrong, when what is actually wrong is the name
   inside the braces. One is a five-second fix and the other is an afternoon.
   So it is named, and it falls back to the honest "not configured" path rather
   than to a doomed request. */
const unresolved = (v) => /\$\{\{[^}]*\}\}/.test(String(v || ''));

const configured = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
  && !unresolved(process.env.RESEND_API_KEY) && !unresolved(process.env.EMAIL_FROM);

/* Resend's REST API. No SDK: one POST, and a dependency we would have to keep
   patched forever is not worth the four lines it saves. */
async function viaResend(msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html || undefined
    }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error('email transport refused: ' + res.status + ' ' + body.slice(0, 200));
    err.status = 502;
    throw err;
  }
  let id = null;
  try { id = (JSON.parse(body) || {}).id || null; } catch (e) { /* not JSON */ }
  return { sent: true, via: 'resend', id: id };
}

/* Send, or say honestly that you could not. Never throws for want of a
   transport — only for a transport that answered and refused. */
async function send(msg) {
  if (!msg || !msg.to || !msg.subject) {
    throw Object.assign(new Error('an email needs a recipient and a subject'), { status: 400 });
  }
  if (!configured()) {
    const dangling = unresolved(process.env.RESEND_API_KEY)
      || unresolved(process.env.EMAIL_FROM);
    return { sent: false, via: 'none',
      reason: dangling
        ? 'RESEND_API_KEY or EMAIL_FROM is an unresolved platform reference —'
          + ' check the service name inside the braces'
        : 'no transport configured' };
  }
  return viaResend(msg);
}

/* ── the one message this build sends ──────────────────────────────────── */
function signInCode(opts) {
  const code = opts.code;
  const mins = opts.mins || 10;
  const brand = opts.brand || 'KashikeyoPOS';
  const what = opts.purpose === 'verify'
    ? 'confirm this address'
    : 'sign in';
  return {
    to: opts.to,
    subject: brand + ' sign-in code: ' + code,
    text: [
      'Your ' + brand + ' code is ' + code + '.',
      '',
      'Enter it to ' + what + '. It lasts ' + mins + ' minutes and can be used once.',
      '',
      'If you did not ask for this, nothing has happened to your account and you',
      'can ignore this message — the code is useless without your email inbox.'
    ].join('\n'),
    html: '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;'
      + 'max-width:460px;line-height:1.6;color:#1a1a1a">'
      + '<p style="margin:0 0 18px">Your <b>' + esc(brand) + '</b> code is:</p>'
      + '<p style="margin:0 0 18px;font-size:32px;font-weight:800;letter-spacing:.18em;'
      + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace">' + esc(code) + '</p>'
      + '<p style="margin:0 0 18px;color:#5a5a60">Enter it to ' + what + '. It lasts '
      + mins + ' minutes and can be used once.</p>'
      + '<p style="margin:0;color:#8a8a8f;font-size:13px">If you did not ask for this, '
      + 'nothing has happened to your account and you can ignore this message.</p>'
      + '</div>'
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { send, signInCode, configured };
