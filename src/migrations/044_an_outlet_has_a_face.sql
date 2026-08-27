/* ═══ AN OUTLET HAS A FACE, AND IT IS NOT THE COMPANY'S ═════════════════════
   `chain.company` has carried a `brand` jsonb since the schema was written —
   the logo, the trading style, the things a receipt and a portal put on a page
   that are not columns anybody queries on. `chain.outlet` never got one, so
   every fact about a STORE that is not one of its eighteen columns had nowhere
   to be: its own logo, its own email, its own website, its own postal code,
   its own mobile.

   That was invisible while onboarding asked for none of them. It stops being
   invisible the moment the panel does — a field collected, toasted as saved
   and written nowhere is the defect this build refuses by name, and the honest
   alternatives were to add the column or stop asking.

   jsonb rather than five columns, for the same reason the company has one:
   these are presentation, not predicates. Nothing joins on a website. A
   business that wants its receipt to carry a postal code should not need a
   migration, and a column nobody queries is a column somebody will one day
   query wrongly.

   NOT NULL DEFAULT '{}' so every reader can address it without a coalesce, and
   an outlet that has said nothing reads as an outlet that has said nothing —
   never as one whose brand is unknown. */
ALTER TABLE chain.outlet ADD COLUMN IF NOT EXISTS brand jsonb NOT NULL DEFAULT '{}'::jsonb;
