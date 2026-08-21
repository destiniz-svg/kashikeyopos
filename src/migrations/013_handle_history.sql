-- ═══ A STORE MAY MOVE, AND ITS OLD ADDRESS MUST NOT ══════════════════════
-- A handle is printed. It is on the table cards, in the WhatsApp message the
-- host sent last week, in the bookmark a regular made. So a business can rename
-- its store address — people outgrow a name — but the old address cannot simply
-- stop working, and it must never be handed to somebody else.
--
-- Two failures this table exists to prevent:
--
--   · the old address 404s, and every card already stuck to a table is dead;
--   · the old address is claimed by another business, and a guest scanning the
--     card in front of them lands on a competitor's menu. That is worse than
--     dead — it is dead and pointing somewhere.
--
-- So a retired handle is KEPT, owned by the outlet that gave it up. It redirects
-- to wherever that outlet is now, and chain.handle_why() refuses it to everyone
-- else. An outlet may take back its own former address; nobody else ever can.
--
-- Nothing here expires. A QR card outlives the decision that renamed it, and a
-- retired handle costs a row.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chain.outlet_handle_history (
  handle      text PRIMARY KEY,
  outlet_id   int  NOT NULL REFERENCES chain.outlet(id) ON DELETE CASCADE,
  retired_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outlet_handle_history_outlet
  ON chain.outlet_handle_history (outlet_id);

-- WHY a handle cannot be used, as a sentence, or NULL when it can. Extended
-- here to see retired addresses: to their own outlet they are free (it is
-- taking its own name back), to anybody else they are taken.
CREATE OR REPLACE FUNCTION chain.handle_why(h text, p_outlet int DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT chain.handle_shape_ok(h)
      THEN 'that is not a usable store address'
    WHEN EXISTS (SELECT 1 FROM chain.reserved_handle r WHERE r.name = h)
      THEN format('"%s" is reserved for %s', h,
                  (SELECT why FROM chain.reserved_handle r WHERE r.name = h))
    WHEN EXISTS (SELECT 1 FROM chain.outlet o
                  WHERE o.slug = h AND (p_outlet IS NULL OR o.id <> p_outlet))
      THEN format('"%s" is already another store''s address', h)
    WHEN EXISTS (SELECT 1 FROM chain.outlet_handle_history x
                  WHERE x.handle = h AND (p_outlet IS NULL OR x.outlet_id <> p_outlet))
      THEN format('"%s" was another store''s address and still points at it', h)
    ELSE NULL
  END
$$;

/* Rename a store, keeping the address it is giving up.

   One transaction, because a rename that recorded the old handle and failed to
   set the new one would leave a store answering to an address the directory
   thinks is retired — and a rename that set the new one without recording the
   old would kill every card already printed. */
CREATE OR REPLACE FUNCTION chain.rename_outlet(p_outlet int, p_handle text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE was text; why text;
BEGIN
  SELECT slug INTO was FROM chain.outlet WHERE id = p_outlet;
  IF was IS NULL THEN
    RAISE EXCEPTION 'no outlet %', p_outlet USING ERRCODE = '23503';
  END IF;
  IF was = p_handle THEN RETURN was; END IF;   -- already there; nothing retires

  why := chain.handle_why(p_handle, p_outlet);
  IF why IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = why;
  END IF;

  -- Taking back an address it retired earlier: that row stops being history.
  DELETE FROM chain.outlet_handle_history
   WHERE handle = p_handle AND outlet_id = p_outlet;

  INSERT INTO chain.outlet_handle_history (handle, outlet_id)
  VALUES (was, p_outlet)
  ON CONFLICT (handle) DO UPDATE SET outlet_id = excluded.outlet_id,
                                     retired_at = now();

  UPDATE chain.outlet SET slug = p_handle WHERE id = p_outlet;
  RETURN was;
END $$;

/* Where an address points, current or retired. One query answers both, so the
   redirect and the portal can never disagree about which store a guest reached. */
CREATE OR REPLACE FUNCTION chain.handle_points_at(h text)
RETURNS TABLE (outlet_id int, current_handle text, retired boolean)
LANGUAGE sql STABLE AS $$
  SELECT o.id, o.slug, false FROM chain.outlet o WHERE o.slug = h AND o.active
  UNION ALL
  SELECT o.id, o.slug, true FROM chain.outlet_handle_history x
    JOIN chain.outlet o ON o.id = x.outlet_id
   WHERE x.handle = h AND o.active AND NOT EXISTS (
     SELECT 1 FROM chain.outlet c WHERE c.slug = h AND c.active)
  LIMIT 1
$$;

-- Every outlet role may ask where an address points; the history is not
-- anybody's to edit. Renaming runs on the owner connection, behind rank 5.
GRANT SELECT ON chain.outlet_handle_history TO PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON chain.outlet_handle_history FROM PUBLIC;
