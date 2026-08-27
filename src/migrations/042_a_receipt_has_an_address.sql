/* ═══ 042 · A RECEIPT HAS AN ADDRESS ════════════════════════════════════════
   Sharing a bill by email, WhatsApp and Viber is three channels and ONE
   mechanism: a hosted page at a permanent link. That is what every till in
   this category does — Square, Toast, Loyverse all mail a link rather than an
   attachment — and it is the only shape that makes the three channels the
   same feature rather than three features. A message app carries a URL; an
   inbox carries a URL; a printed QR carries a URL.

   The token IS the credential, so it is minted from the platform CSPRNG and
   is long. It names ONE sale and grants nothing else: no session, no member,
   no other bill. It does not expire, because a receipt is a document somebody
   keeps — an expiring receipt link is a receipt you cannot produce at the
   moment you need it, which is the only moment it matters.

   Stored rather than hashed, unlike an invitation's token. An invitation is
   used once and proves possession; a receipt link is handed out again every
   time the guest asks for it, so the server has to be able to spell it. The
   fence is the token's own entropy plus a doorman on the endpoint, not
   secrecy at rest.

   NULL until somebody shares: a bill nobody asked to share has no address,
   and minting one for every sale would put a live link on every transaction
   in the shop whether it was wanted or not. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format(
      'ALTER TABLE %I.sale ADD COLUMN IF NOT EXISTS share_token text', s);
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS sale_share_token ON %I.sale(share_token)'
      || ' WHERE share_token IS NOT NULL', s);
  END LOOP;
END $$;
