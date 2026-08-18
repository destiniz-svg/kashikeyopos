import type { Session } from './api';
import { navFor } from './nav';

/* How this works — 02-POS-SPEC §2 (`start`): "Orientation for a new operator."
 *
 * RANK 1, WHICH MEANS A KITCHEN HAND OPENS IT. So it is written for somebody on
 * their first shift, not for somebody evaluating the software: short sentences,
 * no architecture, and the three or four things that will actually confuse them
 * in the first hour.
 *
 * IT IS BUILT FROM THE READER'S OWN RANK. A cashier is told about taking money
 * and never about the ledger; a kitchen hand is told about the pass and nothing
 * else. Showing everybody the whole system and letting them work out which half
 * applies is how an orientation page stops being read.
 *
 * THE THREE THINGS THAT SURPRISE PEOPLE, and they are here because they are
 * surprising rather than because they are impressive:
 *   · it keeps working with no network, and does not say so loudly
 *   · nobody can do anything above their own rank, including their manager's
 *     favours — the refusal comes from the database, not from politeness
 *   · everything anybody does has their name on it, permanently
 */

const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 16,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 12px',
};

const RANK_NAME = ['', 'Kitchen', 'Till', 'Manager', 'Admin', 'Owner'];

/* What each rank is told first. Keyed by the LOWEST rank it applies to, so a
   manager reads the cashier's paragraph as well — they will be covering the
   till on a short-staffed Tuesday. */
const FOR_RANK: Array<{ from: number; title: string; text: string }> = [
  { from: 1, title: 'The pass is yours',
    text: 'Kitchen Display shows what has been fired, oldest first, with how long it '
      + 'has been waiting. Tap a line when it is away. Nothing here can be undone by '
      + 'somebody else without it showing.' },
  { from: 2, title: 'Taking money',
    text: 'Open a table on the floor, add what they ordered, send it to the kitchen, '
      + 'and settle when they are ready. The bill the screen shows is worked out the '
      + 'same way the guest\'s own phone works it out — if the two ever differ, that '
      + 'is a fault worth reporting, not a rounding quirk.' },
  { from: 2, title: 'If something is wrong with a bill',
    text: 'You can raise a credit note from the receipt, and you should. It does not '
      + 'move any money by itself — a manager has to approve it — so raising one for '
      + 'a mistake you are not sure about costs nothing and hides nothing.' },
  { from: 3, title: 'Your morning list',
    text: 'Today shows what is waiting on a decision — counts to approve, deliveries '
      + 'unpriced, accounts over their limit. It is a list of doors, not a dashboard: '
      + 'every row opens the screen where the thing is dealt with.' },
  { from: 3, title: 'Approving',
    text: 'You can approve what somebody below you did and not what you did yourself. '
      + 'That is the point of an approval, and the refusal comes from the database '
      + 'rather than from this screen being polite about it.' },
  { from: 4, title: 'Setting the rules',
    text: 'The service charge, the tax rate and the roster are yours. A tax rate is '
      + 'added with a date and never backdated — every receipt records the rate it '
      + 'was rung up at, and changing an old one would rewrite receipts guests are '
      + 'already holding.' },
  { from: 5, title: 'The estate',
    text: 'The owner dashboard shows every branch, computed inside each branch\'s own '
      + 'books and added up. It shows sums and never rows: you cannot open somebody '
      + 'else\'s receipts from it, and that is deliberate.' },
];

const ALWAYS: Array<{ title: string; text: string }> = [
  { title: 'It works with no internet',
    text: 'This is the normal case, not an emergency. Orders, tickets and sales are '
      + 'kept on the machine in front of you and sent up when the connection comes '
      + 'back. Keep serving. The only thing you will notice is a quiet marker in the '
      + 'top bar.' },
  { title: 'You can only do what your rank allows',
    text: 'Anything above it is simply not on your screen — not greyed out, absent. '
      + 'If you need something you cannot see, the person to ask is whoever is one '
      + 'rung up, and they cannot do you a favour above their own rank either.' },
  { title: 'Your name is on your work',
    text: 'Every sale, every void, every discount and every count records who did it, '
      + 'at what rank, at what time, on which machine. Nothing here can be deleted, '
      + 'including by the owner — corrections are made by adding a correction. That '
      + 'protects you as much as it records you.' },
  { title: 'Signing in is a PIN and nothing else',
    text: 'Do not share it. Wrong PINs lock the terminal for everybody after a few '
      + 'tries, because nobody types a username here — so a shared PIN is somebody '
      + 'else\'s mistake ending up against your name.' },
];

export function Start({ session, onGo }: { session: Session; onGo: (m: string) => void }) {
  const rank = session.rank;
  const mine = FOR_RANK.filter((x) => rank >= x.from);
  const rail = navFor(rank).flatMap((g) => g.items);
  const first = rail.find((i) => i.id !== 'start');

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={h}>You are signed in</div>
        <div style={{ font: '600 20px/1.3 system-ui', color: 'var(--text)' }}>
          {session.name} — {RANK_NAME[rank] || 'rank ' + rank}
        </div>
        <div style={{ font: '400 13px/1.6 system-ui', color: 'var(--text-muted)',
          marginTop: 6, maxWidth: 680 }}>
          Everything on the left is everything you can do. There is nothing hidden
          behind a menu and nothing greyed out waiting for a password — if it is not
          in that list, this account cannot do it.
          {first && (
            <>
              {' '}Most shifts start on{' '}
              <button type="button" onClick={() => onGo(first.id)}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  font: '600 13px/1.6 system-ui', color: 'var(--amber-bright)',
                  textDecoration: 'underline' }}>
                {first.label}
              </button>.
            </>
          )}
        </div>
      </div>

      <div style={card}>
        <div style={h}>What your shift looks like</div>
        <div style={{ display: 'grid', gap: 14 }}>
          {mine.map((x) => (
            <div key={x.title}>
              <div style={{ font: '600 14px/1.4 system-ui', color: 'var(--text)' }}>{x.title}</div>
              <div style={{ font: '400 13px/1.65 system-ui', color: 'var(--text-muted)', maxWidth: 700 }}>
                {x.text}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={h}>Four things that surprise people</div>
        <div style={{ display: 'grid', gap: 14 }}>
          {ALWAYS.map((x) => (
            <div key={x.title}>
              <div style={{ font: '600 14px/1.4 system-ui', color: 'var(--text)' }}>{x.title}</div>
              <div style={{ font: '400 13px/1.65 system-ui', color: 'var(--text-muted)', maxWidth: 700 }}>
                {x.text}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ ...card, background: 'var(--bg-0)' }}>
        <div style={h}>If something looks wrong</div>
        <div style={{ font: '400 13px/1.7 system-ui', color: 'var(--text-faint)', maxWidth: 700 }}>
          Say so, and do not try to make the numbers agree by hand. A figure that is
          wrong on this screen is wrong in the books, and it is far easier to find
          while somebody still remembers the bill it came from. Nothing you can press
          here deletes anything — the worst case is a correction that somebody has to
          approve, which is exactly what corrections are for.
        </div>
      </div>
    </div>
  );
}
