'use strict';
/* ═══ ASKING A MODEL ════════════════════════════════════════════════════════
   One seam, one driver. The application asks a question and does not know or
   care which model answers it; swapping Gemini for anything else is this file
   and nothing else. Same shape as `src/email.js`, deliberately — the two are
   the only outbound services this build has, and they should fail the same
   way and be diagnosed the same way.

   WHY THIS IS SERVER-SIDE AND NOT A CALL FROM THE PAGE. The key can spend
   money, so it is held exactly like `PLATFORM_KEY` and `RESEND_API_KEY` are:
   never rendered, never in a response, never in a page. The terminal asks
   this outlet; this outlet asks the model.

   And there was no other choice. The AI menu builder called
   `window.claude.complete` — which exists inside a Claude artifact host and
   in NO browser on any real till — so on every customer's terminal it took
   the "model unreachable" branch, every time, for the life of the build. It
   said so honestly, which is the only reason it was not a lying control; it
   was still a feature nobody could use.

   Configure with GEMINI_API_KEY, optionally GEMINI_MODEL.
   ═══════════════════════════════════════════════════════════════════════ */

/* AN UNRESOLVED REFERENCE IS NOT A CONFIGURATION — the same trap `src/email.js`
   names, imported rather than re-spelled, because two definitions of "this is
   a dangling reference" would eventually disagree. */
const { unresolved: unresolvedRef } = require('./email');

const KEY = () => String(process.env.GEMINI_API_KEY || '').trim();
const MODEL = () => String(process.env.GEMINI_MODEL || '').trim() || 'gemini-2.0-flash';

/* THE PROVIDER IS NAMED, NEVER GUESSED. `AI_PROVIDER` exists so an install can
   say it has no model at all without unsetting a key — and so a second driver,
   if one is ever added, is chosen by an operator rather than by which variable
   happens to be present. Unset means "whatever is configured", which today is
   Gemini; `none` is a real answer and turns the whole plane off by name. */
const PROVIDER = () => String(process.env.AI_PROVIDER || '').trim().toLowerCase() || 'gemini';

/* WHERE THE MODEL LIVES, so the call path can be DRIVEN rather than stubbed.
   Everything else here was provable without it — the health ladder, the
   resolution, the clamping — but "what does this build do when Google answers
   503" is a question only a real HTTP round trip can settle, and it is exactly
   the question the first live scan asked. Defaults to Google, so production
   behaviour is what it always was; an operator who sets it is naming a host on
   purpose, which is not the print relay's problem (there a REQUEST BODY named
   the address, and the fence exists because a stranger could write it). */
const BASE = () => String(process.env.GEMINI_BASE_URL || '').trim().replace(/\/+$/, '')
  || 'https://generativelanguage.googleapis.com';

const configured = () => PROVIDER() === 'gemini' && !!KEY() && !unresolvedRef(KEY());

/* WHY AN ANSWER DID NOT COME IS AN INSTALL-WIDE FACT, and the screen needs it.
   Install-wide on purpose, exactly as the mail transport's is: a refusal is a
   property of the key and the quota, never of the invoice that happened to
   trigger it, so reporting it to every caller tells nobody anything about
   anybody's document. */
let last = null;

function health() {
  if (PROVIDER() === 'none') {
    return { ok: false, configured: false, reason: 'no model is configured on this install (AI_PROVIDER=none)' };
  }
  if (!KEY()) {
    return { ok: false, configured: false, reason: 'no model is configured on this install — set GEMINI_API_KEY' };
  }
  if (unresolvedRef(KEY())) {
    return {
      ok: false, configured: false,
      reason: 'the model key on this install is an unresolved ${{reference}}, '
        + 'so it names a service that does not exist here'
    };
  }
  if (PROVIDER() !== 'gemini') {
    return { ok: false, configured: false, reason: 'AI_PROVIDER names a driver this build does not have: ' + PROVIDER() };
  }
  /* WHETHER THIS INSTALL HAS A MODEL AND WHETHER THE LAST CALL WORKED ARE TWO
     QUESTIONS, and collapsing them into one boolean was a LATCH — found by
     driving it, not by reading it. `ok` folded in `last`, and the bootstrap
     published `ok` to decide whether the Scan invoice button is drawn. So one
     transient refusal — a 429, a timeout, a minute of Google being Google —
     took the control off every terminal in the shop, and with the button gone
     there could never be another call to clear it. Off for ever, from one bad
     minute, with a screen that said the install had no model.

     `configured` is the CONFIGURATION and decides whether a control exists.
     `ok` is that AND the last outcome, which is what the boot line and an
     operator want. A door still ATTEMPTS the call whenever `configured` — the
     rule the mail seam already keeps, where a refusal is reported and the next
     send is still made. */
  if (last && !last.ok) {
    return { ok: false, configured: true, model: MODEL(),
      reason: last.reason, detail: last.detail };
  }
  return { ok: true, configured: true, model: MODEL() };
}

/* WHAT COMES BACK IS DATA, NEVER AN INSTRUCTION. A supplier's invoice is a
   document this business did not write, photographed by somebody who did not
   read it, and handed to a model that will repeat what is on it. So nothing
   the model returns is ever executed, resolved to an id by the model itself,
   or trusted to be the shape it was asked for: every caller validates field by
   field and clamps, exactly as `guest_request.pay` does at the guest door.

   `responseMimeType: application/json` is asked for and the answer is STILL
   parsed defensively — a model that decides to wrap its JSON in a fence is not
   an error worth failing a delivery over. */
function jsonFrom(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/* A LOG LINE THAT WRAPS IS A LOG LINE NOBODY READS. Google answers an error as
   PRETTY-PRINTED JSON, so `console.error` wrote eight lines and the platform's
   log viewer showed `[ai] … — {` and scattered the message that mattered
   across the next seven — out of order, since they share a timestamp. The
   operator goes to the log, finds a brace, and reports the symptom instead:
   the defect `[sync] BUILD FAULT` already exists to avoid, one router over. */
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/* A BUSY MODEL IS NOT A REFUSED INSTALL, and only some of these are ours to
   fix. Retried once, because the person is standing at the counter with the
   invoice in their hand and Google's own words are "try again later". */
const RETRYABLE = { 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };

function says(status) {
  if (RETRYABLE[status]) {
    return status === 429
      ? 'the model is rate-limited right now (HTTP 429) — try the scan again in a moment'
      : 'the model is busy right now (HTTP ' + status + ') — try the scan again in a moment';
  }
  if (status === 401 || status === 403) {
    return 'the model refused this install\'s key (HTTP ' + status + ')';
  }
  if (status === 404) {
    return 'this install asks for a model the API does not serve: ' + MODEL();
  }
  return 'the model refused this request (HTTP ' + status + ')';
}

/* THE CALL ITSELF. Bounded by an abort so a model that hangs cannot hold a
   pooled request open — the whole reason the outbox drain was chunked, one
   layer up. */
async function ask(opts) {
  const o = opts || {};
  if (!configured()) {
    const h = health();
    last = { ok: false, at: Date.now(), reason: h.reason };
    return { ok: false, reason: h.reason };
  }
  const parts = [];
  if (o.image && o.image.data) {
    parts.push({ inline_data: { mime_type: o.image.mime, data: o.image.data } });
  }
  parts.push({ text: String(o.prompt || '') });

  const body = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: Math.min(8192, Math.max(256, Number(o.maxTokens) || 4096)),
      responseMimeType: 'application/json'
    }
  };
  if (o.system) body.systemInstruction = { parts: [{ text: String(o.system) }] };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(120000, Number(o.timeoutMs) || 60000));
  try {
    const url = BASE() + '/v1beta/models/'
      + encodeURIComponent(MODEL()) + ':generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY() },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const text = await r.text();
    if (!r.ok) {
      /* THE TRANSPORT'S OWN WORDS GO TO THE OPERATOR, NEVER TO THE CALLER.
         Same two sentences the mail seam keeps: `reason` is the class and the
         status, which is what the person waiting can act on; `detail` is
         verbatim, for whoever reads the log.

         AND THE CLASS IS NOT ALWAYS "THIS INSTALL". Every non-2xx used to read
         `the model refused this install`, which sends whoever is holding the
         invoice to check the key and the variables — and the first real scan
         on the live install answered:

           503 UNAVAILABLE — "This model is currently experiencing high demand.
           Spikes in demand are usually temporary. Please try again later."

         Nothing was wrong with the install at all. That is the wrong half of
         the mail seam's own rule: the sentence has to tell the person whether
         it is THEIRS to fix, and here it said yes when the answer was no. So
         the status decides the sentence, and a busy model is retried once
         inside the same abort budget rather than reported. */
      if (RETRYABLE[r.status] && !o._again) {
        await new Promise((f) => setTimeout(f, 1500));
        return ask(Object.assign({}, o, { _again: true }));
      }
      last = {
        ok: false, at: Date.now(),
        reason: says(r.status),
        detail: flat(text).slice(0, 400)
      };
      console.error('[ai] ' + last.reason + ' — ' + last.detail);
      return { ok: false, reason: last.reason };
    }
    const payload = JSON.parse(text);
    const cand = (payload.candidates || [])[0] || {};
    const out = ((cand.content || {}).parts || []).map((p) => p.text || '').join('');
    const parsed = jsonFrom(out);
    if (!parsed) {
      last = { ok: false, at: Date.now(), reason: 'the model answered in a shape this build cannot read' };
      console.error('[ai] unparseable answer — ' + flat(out).slice(0, 200));
      return { ok: false, reason: last.reason };
    }
    last = { ok: true, at: Date.now() };
    return { ok: true, data: parsed, model: MODEL() };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    last = {
      ok: false, at: Date.now(),
      reason: aborted ? 'the model did not answer in time' : 'the model could not be reached',
      detail: flat((e && e.message) || e).slice(0, 200)
    };
    console.error('[ai] ' + last.reason + ' — ' + last.detail);
    return { ok: false, reason: last.reason };
  } finally {
    clearTimeout(timer);
  }
}

/* WHAT THE BOOT LINE SAYS. A fence that is silently absent is worse than no
   fence, so an install with no model says so by name rather than letting a
   screen imply one is there. */
function why() {
  const h = health();
  return h.ok
    ? '[ai] ' + MODEL() + ' — invoice scanning and the menu builder are live'
    : '[ai] no model: ' + h.reason + (h.detail ? ' — ' + h.detail : '');
}

module.exports = { ask, health, configured, why, _model: MODEL };
