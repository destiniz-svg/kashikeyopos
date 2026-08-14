'use strict';
/* Writing a journal entry — the one copy.
 *
 * Three modules had grown a byte-identical private version of this, and a
 * fourth was about to. Nothing had gone wrong yet, which is exactly when this
 * is worth fixing: the copies were the same today and would have drifted the
 * first time one of them needed a document series that was not JV, or a memo
 * length, or an entry date that came from somewhere else. This build has
 * already paid that bill once, when three hand-written copies of the bill
 * calculation charged GST-exclusive at the counter for months with a green
 * suite (see packages/money).
 *
 * WHAT THIS DOES NOT DO is check that the entry balances. It cannot be tricked
 * into writing one that does not: `assert_balanced()` is a DEFERRED constraint
 * trigger in every outlet schema, so an unbalanced journal is refused at COMMIT
 * whatever route it took to get there. That is why the two legs may be inserted
 * in either order, and why this function is allowed to be this small.
 */

const toMVR = (laari) => (laari / 100).toFixed(2);

/**
 * post(c, { date, memo, source, sourceId, lines: [{account, dr, cr}] }, ctx)
 *
 * `dr`/`cr` are integer laari, like every other figure in the request. The
 * document number comes from chain.next_doc_no, which is per outlet and
 * gapless, because a tax authority asks about gaps.
 */
async function post(c, j, ctx) {
  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['JV']);
  const h = await c.query(
    'INSERT INTO journal (jv_no, entry_date, memo, source, source_id, posted_by)'
    + ' VALUES ($1,$2::date,$3,$4,$5,$6) RETURNING id',
    [no.rows[0].no, j.date, j.memo, j.source, j.sourceId, ctx.actor]);
  for (const l of j.lines) {
    await c.query(
      'INSERT INTO journal_line (journal_id, account_code, dr, cr) VALUES ($1,$2,$3,$4)',
      [h.rows[0].id, l.account, toMVR(l.dr), toMVR(l.cr)]);
  }
  return h.rows[0].id;
}

module.exports = { post };
