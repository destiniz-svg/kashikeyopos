/* The screen filter — the value behind the top bar's box and the "/" key.
 *
 * One predicate, used the same way on every list, because a filter that means
 * something different on each screen is a filter nobody trusts. It is a plain
 * case-insensitive substring over the fields a person would actually type: a
 * name, a code, a supplier, a reason. Not fuzzy — fuzzy matching on a till
 * returns a row that looks nothing like what was typed, and the operator has no
 * way to tell whether the thing they wanted is missing or merely ranked fourth.
 *
 * An empty filter matches everything, so a screen can call this unconditionally
 * and stay exactly as it was when nobody is filtering.
 */
export function hit(q: string | undefined, ...fields: Array<string | number | null | undefined>): boolean {
  const t = (q || '').trim().toLowerCase();
  if (!t) return true;
  for (const f of fields) {
    if (f === null || f === undefined) continue;
    if (String(f).toLowerCase().includes(t)) return true;
  }
  return false;
}
