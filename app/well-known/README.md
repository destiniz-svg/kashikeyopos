# /.well-known/

Files here answer at `https://<this install>/.well-known/<name>`.

The directory is deliberately **not** called `.well-known`: `express.static`
ignores dotfiles, and switching that off to serve one file would also start
serving every other dotfile that ever lands in `app/`. `server.js` maps the URL
onto this directory instead.

What goes here:

- `apple-developer-domain-association.txt` — Apple will not enable Sign in with
  Apple until it can fetch this from the domain you registered on the Services
  ID. Download it from the Services ID's "Configure" screen and drop it in.
- `assetlinks.json` / `apple-app-site-association` — only if a native app is
  ever built. Nothing needs them today, which is why the 404s in the access log
  are Google and Apple probing, not something broken.
