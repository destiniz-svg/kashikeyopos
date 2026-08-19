'use strict';
/* AI Menu Builder — 02-POS-SPEC §2 (`aimenu`): "Cost-engineered menu
 * suggestions from the live item master."
 *
 * THE ENGINEERING IS ARITHMETIC AND NEEDS NO MODEL. Everything that decides
 * anything on this screen — what a dish costs today, what margin it makes, how
 * often it sells, where it sits against the rest of the menu, what it would
 * have to be priced at to hit a target — is computed from this outlet's own
 * item master and its own sales. A language model cannot know any of it and
 * must never be asked to guess at it. So the whole board works with no API key
 * configured, and always will.
 *
 * WHAT THE MODEL IS FOR is prose: a dish description, a better name, the
 * wording of a menu section. That is the one part of this module that calls
 * out, it is clearly separated below, and with no key set it answers
 * `configured: false` and says what would be needed — rather than failing, or
 * worse, inventing a suggestion locally and presenting it as advice.
 *
 * MENU ENGINEERING, THE ACTUAL METHOD. Every dish sits in one of four boxes,
 * on two axes: how well it sells against the menu average, and what margin it
 * makes against the menu average.
 *
 *     sells well + good margin  → STAR         leave it alone; protect it
 *     sells well + poor margin  → PLOUGH-HORSE reprice or re-engineer the plate
 *     sells badly + good margin → PUZZLE       promote it, move it up the menu
 *     sells badly + poor margin → DOG          cut it
 *
 * The comparison is against THIS menu, not an industry figure: a menu of
 * beverages and a menu of steaks have nothing to say to each other, and a
 * hardcoded "60% GP" benchmark would be exactly the invented configuration
 * this build refuses to ship.
 *
 * POPULARITY IS COUNTED, MARGIN IS LIVE, and the difference matters. What sold
 * is history and comes from `sale_line`, where the cost booked at the moment of
 * sale is the cost that was actually made — recomputing it would make last
 * month's profit change when a supplier does. What a dish COSTS is today's
 * recipe at today's ingredient prices, because that is what the next plate will
 * cost and the only figure a pricing decision can be made on. Where the two
 * disagree, that gap is reported as DRIFT: the dish is being sold at a price
 * set against a cost that has since moved.
 *
 * A DISH NOBODY HAS COSTED IS NOT A 100% MARGIN DISH. It is a dish with no
 * recipe, and putting it top of the board as the best performer on the menu is
 * how the recipe never gets written. Uncosted dishes are counted separately and
 * ranked nowhere.
 */

const costing = require('./costing');

const laari = (mvr) => Math.round(Number(mvr) * 100);
const pct1 = (x) => Math.round(Number(x) * 10) / 10;

/* ── the board ───────────────────────────────────────────────────────────── */

/**
 * Every active dish, costed at today's prices and ranked against the rest of
 * this menu.
 *
 * `taxRatePct` is the outlet's own GST rate as at today. Menu prices are
 * GST-INCLUSIVE, so margin is measured against the price NET of tax — measuring
 * it against the gross flatters every dish on the menu by the tax rate, which
 * is a mistake that survives review because every number moves together.
 */
async function board(c, q, taxRatePct) {
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
  const target = q.targetGpPct === undefined || q.targetGpPct === null || q.targetGpPct === ''
    ? null : Math.min(95, Math.max(0, Number(q.targetGpPct)));

  const items = await c.query(
    'SELECT id, name, category, price, yield_qty FROM item WHERE active'
    + ' ORDER BY category NULLS LAST, name');

  /* What actually sold, and what it actually cost when it did. */
  const sold = await c.query(
    'SELECT l.item_id, sum(l.qty) AS qty, sum(l.line_total) AS revenue,'
    + ' sum(l.line_cost) AS cost'
    + ' FROM sale_line l'
    + ' JOIN sale s ON s.id = l.sale_id AND s.voided_at IS NULL'
    + " WHERE s.business_date > current_date - ($1 || ' days')::interval"
    + ' GROUP BY l.item_id', [String(days)]);
  const mix = new Map();
  for (const r of sold.rows) {
    mix.set(r.item_id, {
      qty: Number(r.qty), revenue: laari(r.revenue) / 100, cost: laari(r.cost) / 100,
    });
  }

  const rows = [];
  for (const it of items.rows) {
    const cost = await costing.itemCost(c, it.id);
    const plateCost = Math.round(cost.cost);
    const price = laari(it.price);
    const gp = costing.grossProfit(price, plateCost, taxRatePct);
    const m = mix.get(it.id) || { qty: 0, revenue: 0, cost: 0 };

    /* Booked cost per unit over the window against what the plate costs now.
       A dish sold two hundred times at a cost that has since risen 12% is a
       price nobody has revisited, and nothing else in this build looks for
       it. */
    const bookedUnit = m.qty > 0 ? Math.round((m.cost * 100) / m.qty) : null;
    const drift = bookedUnit === null || bookedUnit === 0 || plateCost === 0
      ? null : pct1(((plateCost - bookedUnit) / bookedUnit) * 100);

    rows.push({
      itemId: it.id, name: it.name, category: it.category || null,
      price, plateCost, ...gp,
      /* Costed, said plainly. A dish with no recipe has a plate cost of zero,
         which is not a margin of 100%. */
      costed: cost.lines.length > 0 && plateCost > 0,
      incomplete: cost.incomplete,
      sold: m.qty,
      revenue: Math.round(m.revenue * 100),
      /* Contribution: total margin in money, which is what pays the rent. A
         90% dish selling twice a week contributes nothing. */
      contribution: Math.round((m.revenue - m.cost) * 100),
      bookedUnitCost: bookedUnit,
      costDriftPct: drift,
      suggestedPrice: target === null ? null : priceForTarget(plateCost, target, taxRatePct),
    });
  }

  /* ── the two axes, drawn against THIS menu ─────────────────────────────
     Only costed dishes that have sold take part: an uncosted dish has no
     margin to compare and a dish nobody has ordered has no popularity. Ranking
     them anyway would move the averages that every other dish is judged
     against. */
  const ranked = rows.filter((r) => r.costed && r.sold > 0);
  const meanSold = ranked.length
    ? ranked.reduce((a, r) => a + r.sold, 0) / ranked.length : 0;
  const meanGp = ranked.length
    ? ranked.reduce((a, r) => a + r.gpPct, 0) / ranked.length : 0;

  for (const r of rows) {
    if (!r.costed) { r.quadrant = null; r.why = 'nobody has written this recipe'; continue; }
    if (!r.sold) { r.quadrant = null; r.why = 'it has not sold in this window'; continue; }
    const popular = r.sold >= meanSold;
    const rich = r.gpPct >= meanGp;
    r.quadrant = popular ? (rich ? 'star' : 'ploughhorse') : (rich ? 'puzzle' : 'dog');
    r.why = popular
      ? (rich ? 'sells well and makes money — protect it'
        : 'sells well and makes little — reprice it or re-engineer the plate')
      : (rich ? 'makes money and nobody orders it — move it up the menu'
        : 'sells badly and makes little — the candidate to cut');
  }

  rows.sort((a, b) => b.contribution - a.contribution);

  return {
    days, taxRatePct: Number(taxRatePct) || 0, targetGpPct: target,
    items: rows,
    /* The averages are published, because a dish is called a dog by comparison
       with them and a manager is entitled to see what it was compared to. */
    benchmark: {
      dishesRanked: ranked.length,
      meanSold: Math.round(meanSold * 10) / 10,
      meanGpPct: pct1(meanGp),
      uncosted: rows.filter((r) => !r.costed).length,
      unsold: rows.filter((r) => r.costed && !r.sold).length,
    },
  };
}

/**
 * The GST-inclusive price that would hit a target GP at today's plate cost.
 *
 * Rounded ONCE, from the figure itself. Working the tax back off a rounded
 * exclusive base is not a round trip and drifts by laari — which on a menu of
 * ninety dishes is a real amount of money in the wrong direction.
 */
function priceForTarget(plateCostLaari, targetGpPct, taxRatePct) {
  const t = Number(targetGpPct) / 100;
  if (!(plateCostLaari > 0) || !(t < 1)) return null;
  const net = plateCostLaari / (1 - t);
  return Math.round(net * (1 + Number(taxRatePct) / 100));
}

/* ── the part that needs a key ───────────────────────────────────────────── */

/**
 * Is a model configured, and which one.
 *
 * Deliberately says the ENV VAR NAME. "AI features unavailable" is a message
 * that sends somebody to the source; naming the variable is the difference
 * between a five-minute fix and a support ticket.
 */
function aiConfig() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  return {
    configured: Boolean(key),
    model: process.env.AIMENU_MODEL || 'claude-sonnet-4-5',
    needs: key ? null : 'ANTHROPIC_API_KEY is not set on the API service',
  };
}

/**
 * Menu copy for one dish: a description, and optionally a sharper name.
 *
 * WHAT IT IS AND IS NOT ALLOWED TO DO. It writes prose. It is handed the dish's
 * real name, category and recipe ingredients, and it is told in the prompt that
 * it may not state a price, a portion size, a health claim or an allergen —
 * those are facts this system already holds, and a model restating them from
 * a guess is how a menu ends up promising something the kitchen does not serve.
 * Allergens in particular are a safety claim and belong to the ingredient
 * record, which the guest portal already reads.
 *
 * NOTHING IS SAVED HERE. It returns a draft; a manager edits it and saves it
 * through Menu Master like any other menu text. A model writing directly into
 * the item master would be a change nobody approved with nobody's name on it.
 */
async function describe(c, itemId, body) {
  const cfg = aiConfig();

  const it = await c.query('SELECT id, name, category, price FROM item WHERE id = $1', [itemId]);
  if (!it.rows.length) throw Object.assign(new Error('no such dish'), { status: 404 });

  const ing = await c.query(
    'SELECT i.name FROM recipe_line r JOIN ingredient i ON i.id = r.ingredient_id'
    + ' WHERE r.item_id = $1 ORDER BY r.qty DESC LIMIT 12', [itemId]);
  const parts = ing.rows.map((r) => r.name);

  if (!cfg.configured) {
    /* A first-class answer, not an error. The screen shows the dish and its
       ingredients and says exactly what is missing — so the feature is
       understandable before anybody pays for a key. */
    return {
      configured: false, needs: cfg.needs,
      itemId, name: it.rows[0].name, ingredients: parts,
      why: 'Everything else on this screen is computed from your own menu and '
        + 'sales and needs no key. Writing menu copy is the one part that calls out.',
    };
  }

  /* One word or two, on one line. `tone` is the only caller-supplied text that
     reaches the prompt, and a newline in it is how somebody appends their own
     instructions to the rules below. Admin rank is not a reason to skip this:
     the point is that the rules cannot be argued with, by anybody. */
  const tone = String(body.tone || 'plain').replace(/\s+/g, ' ').trim().slice(0, 40) || 'plain';
  const prompt = 'Write one menu description for a restaurant dish.\n\n'
    + 'Dish: ' + it.rows[0].name + '\n'
    + 'Section: ' + (it.rows[0].category || 'not set') + '\n'
    + (parts.length ? 'Made with: ' + parts.join(', ') + '\n' : '')
    + '\nRules:\n'
    + '- One or two sentences, under 30 words. This goes under the dish name on a menu.\n'
    + '- Tone: ' + tone + '.\n'
    + '- Use only the ingredients listed. Do not invent any.\n'
    + '- Do NOT state a price, a portion size, a calorie figure, a health claim,'
    + ' or whether it is suitable for any allergy or diet. Those are facts the'
    + ' system already holds and yours would be a guess.\n'
    + '- Return the description only, with no preamble and no quotation marks.';

  const text = await callModel(cfg.model, prompt, body.maxTokens);
  return {
    configured: true, model: cfg.model,
    itemId, name: it.rows[0].name, ingredients: parts,
    draft: text,
    /* Said on every response, because a draft that arrives looking finished is
       a draft that gets pasted onto a menu unread. */
    note: 'A draft. Nothing has been saved — edit it and save it in Menu Master.',
  };
}

/**
 * One call, over native fetch. No SDK dependency: this is a single POST with a
 * JSON body, and a dependency for that is a dependency to keep current, audit
 * and rebuild the image for.
 *
 * NOTE FOR WHOEVER SETS THE KEY: this path has never been exercised against
 * the live API in this build, because no key has ever been configured here.
 * The not-configured path above is the one that is tested. Run one describe
 * against a real dish the day the key is set.
 */
async function callModel(model, prompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(1024, Math.max(64, Number(maxTokens) || 300)),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    /* 502, not 500: the failure is upstream, and a manager reading the screen
       needs to know it is not their data. */
    throw Object.assign(new Error('the model service answered ' + res.status
      + (detail ? ': ' + detail.slice(0, 200) : '')), { status: 502 });
  }
  const j = await res.json();
  const text = (j.content || [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw Object.assign(new Error('the model returned nothing'), { status: 502 });
  return text;
}

module.exports = { board, describe, aiConfig, priceForTarget };
