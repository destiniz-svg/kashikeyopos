/* ═══ A PERSON HAS A NUMBER ═════════════════════════════════════════════════
   The application form asks for the admin's mobile — the reference form this
   panel inherits marks it required, and it is the one contact that reaches a
   PERSON rather than a shopfront: the account email reaches an inbox somebody
   checks weekly, the company telephone reaches whoever answers the counter,
   and neither is who you ring when the install is on fire at 21:40 on a
   Friday.

   It lands on chain.staff because it is the person's, not the company's —
   the same reasoning that keeps a staff PIN off the account plane. Nullable,
   because every staff row written before this asked nobody, and a kitchen
   hand enrolled at the counter still needs no phone to take a rank-1 login.
   The bootstrap does not publish it: a roster any signed-in till can read
   does not need to carry everybody's personal number. */
ALTER TABLE chain.staff ADD COLUMN IF NOT EXISTS phone text;
