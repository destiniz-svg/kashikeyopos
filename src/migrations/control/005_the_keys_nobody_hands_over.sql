-- ═══ A VAPID KEY IS GENERATED, NEVER TYPED ══════════════════════════════════
-- Web Push (RFC 8292) needs one P-256 key pair for the whole estate, signed
-- into a JWT on every send so a push service can tell this server sent the
-- message. Somebody could paste one into an env var — and can, `VAPID_*`
-- still overrides — but the default is that nobody ever holds the private
-- half in a clipboard, a chat message or a support ticket. The server makes
-- its own key the first time it needs one and keeps it here.
--
-- IN THE REGISTRY, NOT A BUSINESS DATABASE. One key signs push messages for
-- every outlet in the estate — a subscription doesn't know or care which
-- business owns the server that's sending to it, so there is one key, not
-- one per business. `control/003` already revoked CONNECT at the door for
-- every role but the owner; nothing further is needed to keep an outlet role
-- out of this table, because no outlet role has ever been able to open a
-- session on this database at all.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chain.vapid_key (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),  -- exactly one row
  public_key  text NOT NULL,   -- base64url, uncompressed P-256 point (65 bytes)
  private_key text NOT NULL,   -- base64url, the 32-byte scalar (d)
  created_at  timestamptz NOT NULL DEFAULT now()
);
