import type { Session } from './api';

/* Architecture — 02-POS-SPEC §2 (`architecture`): "The system's own map."
 *
 * A READ-ONLY SCREEN THAT CALLS NOTHING. Every fact on it is a fact about the
 * shape of the code, and a fact about shape that is fetched from a server is a
 * fact that can be wrong in two places. What is written here is written once,
 * here, and the things it claims are each enforced somewhere a test can reach:
 * the tenancy belts by `backend/scripts/leak-test.js`, the single bill
 * calculation by `test/guest-quote.test.js`, the one journal writer and the one
 * chart of accounts by `test/deployable.test.js`.
 *
 * WHY IT EXISTS AT ALL. A restaurant platform is bought by somebody who will
 * never read its source and is audited by somebody who needs to know where the
 * money is decided. This is the page that answers "where does a figure come
 * from" without either of them opening a file — and it is honest about the
 * limits, because an architecture page that only lists strengths is marketing.
 */

const MONO = "'JetBrains Mono',monospace";
const card: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 13, padding: 16,
};
const h: React.CSSProperties = {
  font: '600 11px/1 system-ui', letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', margin: '0 0 12px',
};
const body: React.CSSProperties = {
  font: '400 13px/1.7 system-ui', color: 'var(--text-muted)', maxWidth: 760,
};
const code: React.CSSProperties = { fontFamily: MONO, color: 'var(--code-text)' };

function Step({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{
        width: 26, height: 26, flex: '0 0 26px', borderRadius: 8, background: 'var(--bg-3)',
        display: 'grid', placeItems: 'center',
        font: `600 12px/1 ${MONO}`, color: 'var(--amber-bright)',
      }}>{n}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ font: '600 14px/1.4 system-ui', color: 'var(--text)' }}>{title}</div>
        <div style={{ font: '400 12px/1.6 system-ui', color: 'var(--text-muted)', maxWidth: 640 }}>
          {text}
        </div>
      </div>
    </div>
  );
}

export function Architecture({ session }: { session: Session }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── the chain of consequence ───────────────────────────────────── */}
      <div style={card}>
        <div style={h}>What happens when somebody orders a burger</div>
        <div style={{ display: 'grid', gap: 12 }}>
          <Step n="1" title="A ticket opens on the floor"
            text="Locally, in the browser's own storage first. The register works with
              no network at all — offline is the normal case, not the failure case." />
          <Step n="2" title="The kitchen is fired"
            text="The line goes to the pass with a target time. Nothing about this waits
              for the cloud." />
          <Step n="3" title="The till settles it, and the SERVER decides the money"
            text="The device sends what it rang up; the server prices the bill again from
              the menu, the service charge and the tax version in force on that
              business date, and stores its own figures. What the device thought is
              kept beside them so a terminal that disagrees can be found." />
          <Step n="4" title="Tax is extracted, not added"
            text="Menu prices are GST-inclusive. The tax is the rate fraction OF the
              inclusive amount, and the rate recorded on the sale is the one that was
              in force — so a rate change next month cannot restate this receipt." />
          <Step n="5" title="Stock moves at the moment of sale"
            text="The recipe is exploded and each ingredient is moved with the cost it
              had at that moment. Costing is real time; there is no nightly batch to
              be wrong about." />
          <Step n="6" title="The ledger is posted by one writer"
            text="Revenue, tax, service charge and cost of sales all reach the books
              through a single function that refuses to post anything that does not
              balance — a deferred constraint checks it again at COMMIT." />
          <Step n="7" title="Everything above is attributable"
            text="Person, rank, timestamp and device, on the row itself. That is what
              makes the chain auditable rather than merely recorded." />
        </div>
      </div>

      {/* ── tenancy ────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>How one branch is kept out of another&rsquo;s books</div>
        <div style={body}>
          <p style={{ margin: '0 0 10px' }}>
            <strong style={{ color: 'var(--text)' }}>Two belts, not one.</strong> Each
            outlet owns a Postgres schema of its own (<span style={code}>outlet_3</span>)
            and its own login role (<span style={code}>outlet_3_app</span>), granted
            usage on that schema alone. Another branch&rsquo;s tables are not filtered
            out of a query — they are unreachable on the connection.
          </p>
          <p style={{ margin: '0 0 10px' }}>
            The shared control tables carry row-level security on top of that, with
            <span style={code}> FORCE ROW LEVEL SECURITY</span> so the rules apply to the
            table&rsquo;s owner as well. Identity comes from the database role, not from a
            variable the application sets, because a variable can be set to anything.
          </p>
          <p style={{ margin: '0 0 10px' }}>
            <strong style={{ color: 'var(--text)' }}>One cross-outlet read exists</strong> —
            the estate aggregates on the owner&rsquo;s dashboard. It runs on a read-only
            role that holds no grant on any table at all, through functions that can
            only return sums, and it is written to the audit trail as a group-scope
            query. Those functions return no id of anything, so there is nothing to
            drill through to.
          </p>
          <p style={{ margin: 0 }}>
            None of that is asserted here and taken on trust: a script tries
            twenty-eight ways across the boundary on every build — reading another
            branch&rsquo;s sales, forging group scope, claiming to be another outlet,
            rewriting the audit trail — and the build stops if any of them succeeds.
            It also checks the lock still OPENS for the caller it exists for, because
            refusing everybody looks exactly like refusing the right people.
          </p>
        </div>
      </div>

      {/* ── one of each ───────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>Things there is deliberately only one of</div>
        <div style={{ display: 'grid', gap: 10 }}>
          {[
            ['The bill calculation',
              'One function prices every bill — the till, the guest\'s phone and the '
              + 'server all call it. Written twice, the counter and the phone quote '
              + 'different totals and a test suite stays green.'],
            ['The journal writer',
              'Every posting goes through one function. Five modules once had their '
              + 'own insert, and one of them took a different unit — an outage-queued '
              + 'entry would have posted a hundredth of its value and balanced.'],
            ['The chart of accounts',
              'Seeded once. Five migrations once restated the whole list, only the '
              + 'last ran, and a code added to any of the others simply did not exist.'],
            ['What an account MEANS',
              'Cost of sales and labour are one list, shared by the P&L, the CFO '
              + 'screen and the estate. Three copies is how prime cost reads 31% on '
              + 'one screen and 34% on another for the same week.'],
            ['The name of a table',
              'One table had four spellings, which made an exclusion constraint '
              + 'decorative and left tickets unopenable from the floor.'],
          ].map(([title, text]) => (
            <div key={title}>
              <div style={{ font: '600 13px/1.4 system-ui', color: 'var(--text)' }}>{title}</div>
              <div style={{ font: '400 12px/1.6 system-ui', color: 'var(--text-muted)', maxWidth: 720 }}>
                {text}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── offline ───────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={h}>What happens when the network goes</div>
        <div style={body}>
          <p style={{ margin: '0 0 10px' }}>
            Nothing stops. The register holds its own copy of the menu, the open
            tickets and today&rsquo;s sales, and every write goes into an outbox on the
            device before it goes anywhere else. When the connection returns, the
            outbox replays in order and the server applies each operation once —
            replaying the same one twice returns the first answer rather than doing it
            again.
          </p>
          <p style={{ margin: 0 }}>
            The consequence worth knowing: while a till is offline this server cannot
            see what it is holding. Sync &amp; Devices says <em>unknown</em> rather than
            a confident zero, and reports which paired machines have gone quiet while
            the others are talking — which is the only honest signal there is.
          </p>
        </div>
      </div>

      {/* ── the limits ────────────────────────────────────────────────── */}
      <div style={{ ...card, background: 'var(--bg-0)' }}>
        <div style={h}>What this design does not do</div>
        <div style={{ ...body, color: 'var(--text-faint)' }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong>Pairing a device is not authentication.</strong> A device id lives in
            that machine&rsquo;s own storage and can be cleared. Revoking a till stops an
            honest one and flags a dishonest one; the PIN and the audit trail are the
            controls.
          </p>
          <p style={{ margin: '0 0 8px' }}>
            <strong>An offline till is trusted about its own order of events.</strong> It
            timestamps its work and the server records both what the device said and
            when the work actually arrived, so a clock that is wrong can be found —
            but it cannot be prevented.
          </p>
          <p style={{ margin: '0 0 8px' }}>
            <strong>A sale that has taken money is never rejected.</strong> The server
            re-checks every bill&rsquo;s arithmetic and stamps a mismatch rather than
            refusing it — a cashier has already handed over the change, and refusing
            the record would lose the sale rather than fix it. Corrections are credit
            notes, numbered and approved.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Backups and monitoring live outside this application.</strong> The
            database is a managed service; what this build guarantees is that a single
            outlet can be restored on its own, because one outlet is one schema.
          </p>
        </div>
      </div>

      <div style={{ ...card, background: 'var(--bg-0)' }}>
        <div style={h}>Where the money is decided</div>
        <div style={{ ...body, fontFamily: MONO, fontSize: 12, lineHeight: 1.9 }}>
          <div>packages/money/money.js — every bill, everywhere</div>
          <div>backend/src/sale.js — what the server does with one</div>
          <div>backend/src/journal.js — the only thing that writes to the ledger</div>
          <div>backend/src/accounts.js — what each account code means</div>
          <div>backend/migrations/ — every table, and why it is shaped that way</div>
        </div>
        <div style={{ marginTop: 10, font: '400 11px/1.6 system-ui', color: 'var(--text-faint)' }}>
          Signed in as {session.name}, rank {session.rank}. This screen is the same for
          everybody who can reach it — it holds no figures, only the shape.
        </div>
      </div>
    </div>
  );
}
