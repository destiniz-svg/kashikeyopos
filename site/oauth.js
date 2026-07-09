/* Shared "Sign in with Google / Apple" wiring for /login and /signup.
   Both buttons hand back a verified identity, not a password, so the same
   server session shape ({ token, slug, register }) comes back from either
   provider and gets stored in localStorage exactly like the email/password
   flow does - see /api/auth/google and /auth/apple/callback in index.js. */
(function () {
  function storeSessionAndGo(data) {
    localStorage.setItem("kashikeyo-cloud", JSON.stringify({ url: "", token: data.token, slug: data.slug, register: data.register }));
    location.href = "/app";
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== window.location.origin || !e.data || !e.data.kashikeyoAppleAuth) return;
    if (e.data.error) { window.KashikeyoOAuthError && window.KashikeyoOAuthError(e.data.error); return; }
    storeSessionAndGo(e.data);
  });

  async function initGoogle(container, cfg, onError) {
    await loadScript("https://accounts.google.com/gsi/client");
    window.google.accounts.id.initialize({
      client_id: cfg.clientId,
      callback: async function (resp) {
        try {
          var r = await fetch("/api/auth/google", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential: resp.credential }),
          });
          var data = await r.json().catch(function () { return {}; });
          if (!r.ok) throw new Error(data.error || "Google sign-in failed");
          storeSessionAndGo(data);
        } catch (e) { onError(e.message); }
      },
    });
    window.google.accounts.id.renderButton(container, { theme: "outline", size: "large", width: 320, shape: "pill", text: "continue_with" });
  }

  async function initApple(button, cfg) {
    await loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js");
    window.AppleID.auth.init({ clientId: cfg.clientId, scope: "name email", redirectURI: cfg.redirectUri, usePopup: true });
    button.style.display = "flex";
    button.addEventListener("click", function () {
      window.AppleID.auth.signIn().catch(function () { /* user cancelled / popup blocked */ });
    });
  }

  window.KashikeyoOAuth = {
    init: async function (opts) {
      var box = document.getElementById(opts.boxId);
      var googleContainer = document.getElementById(opts.googleId);
      var appleButton = document.getElementById(opts.appleId);
      var divider = document.getElementById(opts.dividerId);
      var onError = opts.onError || function () {};
      window.KashikeyoOAuthError = onError;
      var cfg;
      try { cfg = await fetch("/api/auth/config").then(function (r) { return r.json(); }); }
      catch (e) { return; } // config unreachable - quietly skip OAuth options
      // Each provider inits independently - a CDN hiccup or misconfiguration
      // on one (e.g. Apple) must not take down the other's working button.
      var any = false;
      if (cfg.google && cfg.google.enabled) {
        try { await initGoogle(googleContainer, cfg.google, onError); any = true; }
        catch (e) { /* Google script/init failed - leave its slot empty */ }
      }
      if (cfg.apple && cfg.apple.enabled) {
        try { await initApple(appleButton, cfg.apple); any = true; }
        catch (e) { /* Apple script/init failed - leave its slot empty */ }
      }
      if (any) { box.style.display = "grid"; if (divider) divider.style.display = "flex"; }
    },
  };
})();
