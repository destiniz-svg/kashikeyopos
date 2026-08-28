'use strict';
/* ═══ PROVISIONING AN INSTALL, WITHOUT A HUMAN TYPING NINE SECRETS ══════════
   Standing a store up used to be six manual acts before the panel was even
   opened: create a service, create a database, generate three secrets and two
   keys, set nine variables, point a domain — and then type two of those values
   back into Mission Control by hand, where nothing checked they matched what
   was actually set. A secret typed twice is a secret that diverges, and the
   only symptom is a customer refused at step one holding a code the panel
   swears is right.

   So the panel does it. This module is the whole of the machinery, and it is
   built around four rules.

   ONE · THE TOKEN NEVER REACHES A BROWSER. Every call here runs server-side
   from the panel process. RAILWAY_API_TOKEN can create and destroy
   infrastructure, so it is treated exactly like PLATFORM_KEY already is: held
   by the panel, never rendered, never returned.

   TWO · THE PASSWORD IS MINTED AND NEVER READ BACK. The app's DATABASE_URL is
   set to a variable REFERENCE — ${{Postgres.DATABASE_URL}} — which Railway
   resolves at deploy time, so the app's own configuration never contains a
   credential and this process never reads one.

   It does MINT the Postgres password, and that is a correction. This module
   first assumed Railway's Postgres image publishes DATABASE_URL by itself, so
   the panel would never touch it at all. It does not: a bare service created
   from that image gets only Railway's own RAILWAY_* variables — DATABASE_URL,
   POSTGRES_USER, POSTGRES_PASSWORD and PGDATA all come from the TEMPLATE, not
   the image. Proved on a throwaway project, which is exactly why that
   rehearsal was worth doing: every provisioning run would otherwise have
   polled for three minutes at step four and failed.

   So pgVariables() below is the template's own wiring, and the password is
   generated here with the other secrets. Everything downstream is still a
   reference chain Railway resolves.

   THREE · PROGRESS IS RECORDED BEFORE IT IS MADE. Every step reports through
   `onStep` before and after it runs, and the caller writes that down. A crash
   halfway through must never leave infrastructure that nothing knows about —
   the most expensive failure mode here is not an error, it is an orphan.

   FOUR · A PARTIAL RUN IS NAMED, NEVER ROUNDED UP. If step five fails, the
   result says which five succeeded and what they created, by id. Rollback is
   offered only for a project THIS RUN created: deleting a project that already
   existed because our own later step failed is how automation earns its
   reputation.
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

/* Railway's own endpoint. Overridable so the whole path can be driven against
   a stub — the alternative is a feature whose only rehearsal is a customer's
   first store. It is an environment variable, so it is set by whoever already
   holds the token; a value here is not a new trust boundary. */
const API = process.env.RAILWAY_API_URL || 'https://backboard.railway.com/graphql/v2';

/* Railway's own Postgres, read off a running one rather than guessed: the
   image their template deploys and the path it requires a volume at. Both are
   overridable, because an image tag is a moving target and a guide that has to
   be edited to change one is a guide that goes stale. */
const PG_IMAGE = process.env.INSTALL_PG_IMAGE || 'ghcr.io/railwayapp-templates/postgres-ssl:18';
const PG_MOUNT = '/var/lib/postgresql/data';
const PG_NAME = 'Postgres';

const REPO = () => String(process.env.INSTALL_REPO || '').trim();
const BRANCH = () => String(process.env.INSTALL_BRANCH || 'main').trim();
const REGION = () => String(process.env.INSTALL_REGION || '').trim();
const TOKEN = () => String(process.env.RAILWAY_API_TOKEN || '').trim();
const WORKSPACE = () => String(process.env.RAILWAY_WORKSPACE_ID || '').trim();

/* THE EMAIL TRANSPORT AN INSTALL INHERITS. Every install sends from the
   seller's own Resend account and sending domain — one seller, one sending
   identity — so these default to the panel's own. An explicit INSTALL_* pair
   overrides that where a seller wants stores to send from somewhere else.

   Getting this wrong is not a degraded feature, it is a dead one: with no
   transport the account plane writes the verification code to the audit trail
   and says so, and a customer who cannot verify their address cannot claim
   their install. Found exactly that way — a provisioned install had neither
   variable, so the first person to sign up never got a code. */
const MAIL_KEY = () => String(process.env.INSTALL_RESEND_API_KEY
  || process.env.RESEND_API_KEY || '').trim();
const MAIL_FROM = () => String(process.env.INSTALL_EMAIL_FROM
  || process.env.EMAIL_FROM || '').trim();

/* Where a store's guests are sent. On a Railway-generated hostname there is no
   wildcard, so `<handle>.<that host>` resolves nowhere — and src/handle.js
   would otherwise inherit that apex from PUBLIC_URL and hand out QR addresses
   that answer nothing. An EMPTY value is the meaningful one: it turns store
   subdomains off and uses the path forms, which DO resolve. Set
   INSTALL_PORTAL_BASE_DOMAIN once a real wildcard domain exists. */
const PORTAL_DOMAIN = () => String(process.env.INSTALL_PORTAL_BASE_DOMAIN || '').trim();

/* WHAT THIS PANEL HOLDS IS NOT ALWAYS WHAT IT CAN PASS ON. Both mail variables
   were read with a bare truthiness check, and a Railway variable may be written
   as a reference to another service — `${{kashikeyopos.RESEND_API_KEY}}`. When
   the service name is right the reference is substituted before this process
   ever sees it, and a real key is copied forward. When it is WRONG the literal
   survives: non-empty, truthy, no warning from ready(), and copied verbatim
   into a brand-new project whose only services are a database and the app. It
   can never resolve there. The install comes up believing it has email,
   answers every send with the honest "not configured" fallback, and the
   customer sits on Check your email — which is exactly what happened.

   So the same rule that governs a send governs a HANDOVER, and it is imported
   rather than re-spelled: two definitions of "this is a dangling reference"
   would eventually disagree, and this one is already load-bearing. */
const EMAIL = require('../src/email');

function mailReady() {
  const k = MAIL_KEY(), f = MAIL_FROM();
  if (!k || !f) {
    return { ok: false, why: 'no email transport to pass on — set RESEND_API_KEY'
      + ' and EMAIL_FROM on this panel, or the install cannot send a'
      + ' verification code' };
  }
  if (EMAIL.unresolved(k) || EMAIL.unresolved(f)) {
    return { ok: false, why: "this panel's RESEND_API_KEY or EMAIL_FROM is an"
      + ' unresolved ${{reference}} — check the service name inside the braces.'
      + ' It is not passed on: a reference belongs to the project it was'
      + ' written in and means nothing in a new one' };
  }
  /* A key that LOOKS fine and is refused is worth saying too, and this panel
     finds out every time it emails a customer their address. */
  const h = EMAIL.health();
  if (!h.ok) {
    return { ok: false, why: 'the last message this panel tried to send was not'
      + ' delivered: ' + (h.detail || h.reason) };
  }
  return { ok: true };
}

/* A service name becomes the hostname, so it is the store's, not the
   product's. Every install was called `kashikeyopos` and every address came
   out `kashikeyopos-production.up.railway.app` — indistinguishable across
   customers, and Railway starts suffixing once they collide. */
function slug(name) {
  const s = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    .replace(/-+$/, '');
  return s || 'kashikeyopos';
}

/* Is the automated path available at all? Two answers, not one: "off" is a
   deployment that never configured it, and the panel must offer the manual
   sheet rather than a button that 500s. `why` is rendered next to the disabled
   control, because a control that is greyed out for an unstated reason teaches
   an operator that the app is broken. */
function ready() {
  if (!TOKEN()) return { ok: false, why: 'RAILWAY_API_TOKEN is not set on this panel' };
  if (!REPO()) return { ok: false, why: 'INSTALL_REPO is not set — name the repository a new install deploys from, as owner/name' };
  /* Not a refusal: an install with no email still works, its customer just has
     to be read their code. But it is worth saying BEFORE the run rather than
     discovering it when the first person cannot sign up. */
  const mail = mailReady();
  if (!mail.ok) return { ok: true, warn: mail.why };
  return { ok: true };
}

/* ── the transport ───────────────────────────────────────────────────────── */

/* GraphQL answers 200 with an `errors` array, so a bare `res.ok` check reports
   success on a refusal. Both shapes are collapsed into one thrown Error whose
   message is the thing a human needs to read. */
async function gql(query, variables, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeoutMs || 30000);
  let res;
  try {
    res = await fetch(process.env.RAILWAY_API_URL || API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + TOKEN()
      },
      body: JSON.stringify({ query: query, variables: variables || {} }),
      signal: ctl.signal
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'Railway did not answer within ' + Math.round((o.timeoutMs || 30000) / 1000) + 's'
      : 'could not reach Railway: ' + e.message);
  } finally { clearTimeout(t); }

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* fall through to the raw text */ }

  if (res.status === 401 || res.status === 403) {
    throw new Error('Railway refused the API token (' + res.status + ') — check RAILWAY_API_TOKEN');
  }
  if (res.status === 429) {
    throw new Error('Railway rate-limited this token; retry after '
      + (res.headers.get('retry-after') || 'a minute'));
  }
  if (!body) throw new Error('Railway answered ' + res.status + ' with something that is not JSON');
  if (body.errors && body.errors.length) {
    throw new Error(body.errors.map((e) => e && e.message).filter(Boolean).join('; ')
      || 'Railway refused the request and gave no reason');
  }
  if (!res.ok) throw new Error('Railway answered ' + res.status);
  return body.data;
}

/* ── the pieces ──────────────────────────────────────────────────────────── */

async function createProject(name) {
  const input = { name: name };
  if (WORKSPACE()) input.workspaceId = WORKSPACE();
  const d = await gql(
    'mutation projectCreate($input: ProjectCreateInput!) {'
    + ' projectCreate(input: $input) { id environments { edges { node { id name } } } } }',
    { input: input });
  const p = d.projectCreate;
  const envs = ((p.environments || {}).edges || []).map((e) => e.node);
  // A fresh project has exactly one environment and it is called production.
  // Taking the first unconditionally would silently pick whatever came back
  // first if that ever changes.
  const env = envs.find((e) => e && e.name === 'production') || envs[0];
  if (!env) throw new Error('the project was created but reported no environment');
  return { projectId: p.id, environmentId: env.id };
}

async function createService(projectId, name, source, variables) {
  const input = { projectId: projectId, name: name, source: source };
  if (source && source.repo && BRANCH()) input.branch = BRANCH();
  if (variables) input.variables = variables;
  const d = await gql(
    'mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }',
    { input: input });
  return d.serviceCreate.id;
}

async function createVolume(projectId, environmentId, serviceId, mountPath) {
  const input = { projectId: projectId, serviceId: serviceId, mountPath: mountPath,
    environmentId: environmentId };
  if (REGION()) input.region = REGION();
  const d = await gql(
    'mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }',
    { input: input });
  return d.volumeCreate.id;
}

async function setVariables(projectId, environmentId, serviceId, variables, skipDeploys) {
  await gql(
    'mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {'
    + ' variableCollectionUpsert(input: $input) }',
    { input: { projectId: projectId, environmentId: environmentId, serviceId: serviceId,
      variables: variables, skipDeploys: !!skipDeploys } });
}

async function readVariables(projectId, environmentId, serviceId) {
  const d = await gql(
    'query variables($projectId: String!, $environmentId: String!, $serviceId: String) {'
    + ' variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }',
    { projectId: projectId, environmentId: environmentId, serviceId: serviceId });
  return d.variables || {};
}

async function updateInstance(serviceId, environmentId, input) {
  await gql(
    'mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!,'
    + ' $input: ServiceInstanceUpdateInput!) {'
    + ' serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
    { serviceId: serviceId, environmentId: environmentId, input: input });
}

async function createDomain(serviceId, environmentId, targetPort) {
  const input = { serviceId: serviceId, environmentId: environmentId };
  if (targetPort) input.targetPort = targetPort;
  const d = await gql(
    'mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {'
    + ' serviceDomainCreate(input: $input) { id domain } }',
    { input: input });
  return d.serviceDomainCreate.domain;
}

async function deploy(serviceId, environmentId) {
  await gql(
    'mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {'
    + ' serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }',
    { serviceId: serviceId, environmentId: environmentId });
}

async function latestDeployment(projectId, serviceId, environmentId) {
  const d = await gql(
    'query deployments($input: DeploymentListInput!) {'
    + ' deployments(input: $input, first: 1) { edges { node { id status } } } }',
    { input: { projectId: projectId, serviceId: serviceId, environmentId: environmentId } });
  const edge = (((d.deployments || {}).edges) || [])[0];
  return edge ? edge.node : null;
}

async function deleteProject(projectId) {
  await gql('mutation projectDelete($id: String!) { projectDelete(id: $id) }', { id: projectId });
}

/* ── waiting ─────────────────────────────────────────────────────────────── */

/* Polling, not sleeping-and-hoping. Every wait is bounded and every timeout
   says what it was waiting FOR, because "provisioning failed" at minute four
   tells an operator nothing they can act on. */
async function until(what, check, opts) {
  const o = opts || {};
  const every = o.everyMs || 5000;
  const limit = o.timeoutMs || 300000;
  const started = o.now ? o.now() : Date.now();
  const now = o.now || Date.now;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (now() - started > limit) {
      throw new Error('gave up waiting for ' + what + ' after '
        + Math.round(limit / 1000) + 's');
    }
    await new Promise((r) => (o.wait || setTimeout)(r, every));
  }
}

/* ── the secrets an install needs ────────────────────────────────────────── */

/* Minted here, once, per install. Three of them are three ON PURPOSE — a leak
   of one must not mint the others — and the whole reason to generate them in
   code is that "three different values" is exactly the discipline a human
   under time pressure quietly abandons. */
function mintSecrets() {
  const b = (n) => crypto.randomBytes(n).toString('base64url');
  return {
    OUTLET_ROLE_SECRET: b(32),
    SESSION_SECRET: b(32),
    PORTAL_SECRET: b(32),
    PLATFORM_KEY: b(32),
    ONBOARDING_CLAIM_TOKEN: b(9),     // read aloud and typed by a person
    // Postgres rejects some punctuation in a URL-embedded password, and
    // base64url is already URL-safe, so DATABASE_URL composes without escaping.
    POSTGRES_PASSWORD: b(24)
  };
}

/* WHAT RAILWAY'S POSTGRES TEMPLATE SETS, and the image does not. Every value
   below except the password is a reference Railway resolves, so this is the
   template's own shape rather than a connection string assembled here.

   PGDATA is a SUBDIRECTORY of the mount, not the mount itself: initdb refuses
   a data directory that is not empty, and a mounted volume has a lost+found. */
function pgVariables(secrets) {
  return {
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD,
    POSTGRES_DB: 'railway',
    PGDATA: PG_MOUNT + '/pgdata',
    PGHOST: '${{RAILWAY_PRIVATE_DOMAIN}}',
    PGPORT: '5432',
    PGUSER: '${{POSTGRES_USER}}',
    PGPASSWORD: '${{POSTGRES_PASSWORD}}',
    PGDATABASE: '${{POSTGRES_DB}}',
    DATABASE_URL: 'postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}'
      + '@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}',
    SSL_CERT_DAYS: '820'
  };
}

/* Railway resolves ${{Service.VAR}} at deploy time, so the app is handed a
   reference rather than a password this process ever reads back. */
function appVariables(secrets, extra) {
  const v = {
    DATABASE_URL: '${{' + PG_NAME + '.DATABASE_URL}}',
    NODE_ENV: 'production',
    PORT: '8080',
    OUTLET_ROLE_SECRET: secrets.OUTLET_ROLE_SECRET,
    SESSION_SECRET: secrets.SESSION_SECRET,
    PORTAL_SECRET: secrets.PORTAL_SECRET,
    PLATFORM_KEY: secrets.PLATFORM_KEY,
    ONBOARDING_CLAIM_TOKEN: secrets.ONBOARDING_CLAIM_TOKEN,
    /* Explicitly empty unless a real wildcard domain is named: an install on a
       Railway hostname must use the path forms, not subdomains that resolve
       nowhere. src/handle.js reads "set but empty" as a decision, which is
       what this is. */
    PORTAL_BASE_DOMAIN: PORTAL_DOMAIN()
  };
  /* Without both, the install has no email at all and a customer cannot verify
     the address they are claiming it with — but a value that cannot work THERE
     is worse than none. An install with nothing set says "no email transport is
     configured on this install"; one carrying a dangling reference says the
     same thing while a variable sits on the service looking correct, and
     whoever is debugging it checks the key instead of the braces. */
  if (mailReady().ok) {
    v.RESEND_API_KEY = MAIL_KEY();
    v.EMAIL_FROM = MAIL_FROM();
  }
  return Object.assign(v, extra || {});
}

/* ── the sequence ────────────────────────────────────────────────────────── */

/* Returns { ok, made, secrets, baseUrl, steps } — and on failure THROWS an
   error carrying `made`, so the caller can say what exists rather than only
   what went wrong. */
async function provision(opts) {
  const o = opts || {};
  const name = String(o.name || '').trim();
  if (!name) throw new Error('the install needs a name');
  const gate = ready();
  if (!gate.ok) throw new Error(gate.why);

  const onStep = typeof o.onStep === 'function' ? o.onStep : function () {};
  const made = { projectId: null, environmentId: null, appServiceId: null,
    pgServiceId: null, volumeId: null, domain: null, ourProject: false };
  const steps = [];

  const run = async (key, label, fn) => {
    onStep({ key: key, label: label, state: 'running', made: made });
    try {
      const out = await fn();
      steps.push({ key: key, label: label, ok: true });
      onStep({ key: key, label: label, state: 'done', made: made });
      return out;
    } catch (e) {
      steps.push({ key: key, label: label, ok: false, error: e.message });
      onStep({ key: key, label: label, state: 'failed', error: e.message, made: made });
      throw Object.assign(e, { made: made, steps: steps, failedAt: key });
    }
  };

  const secrets = mintSecrets();

  try {
    await run('project', 'Creating the project', async () => {
      const p = await createProject(name);
      made.projectId = p.projectId;
      made.environmentId = p.environmentId;
      made.ourProject = true;      // ours, so ours to roll back
    });

    await run('database', 'Creating the database', async () => {
      /* With its wiring, at creation. This is the step the throwaway rehearsal
         corrected: the image alone publishes nothing, so a service created bare
         here would never have produced a DATABASE_URL for the app to reference. */
      made.pgServiceId = await createService(made.projectId, PG_NAME,
        { image: PG_IMAGE }, pgVariables(secrets));
    });

    await run('volume', 'Attaching its disk', async () => {
      made.volumeId = await createVolume(made.projectId, made.environmentId,
        made.pgServiceId, PG_MOUNT);
    });

    await run('database-url', 'Waiting for the database to answer', async () => {
      /* This step used to read DATABASE_URL back off the database service and
         call that "addressable". Once the wiring moved to creation, it was
         reading back a variable WE had set four seconds earlier: it passed on
         the first ask, always, by construction, and the label was a claim the
         check could not make.

         What it has to establish is that `postgres.railway.internal` RESOLVES,
         because the app dials it on its very first boot and this build exits
         rather than serve on a schema it could not migrate. That name is
         registered when the database's own deployment goes live, so the
         deployment is what to wait for — a fact the platform owns rather than
         one we wrote.

         Skipping it is what failed the second live install. The first passed
         only because its app image had to be built from source, which took
         longer than the database took to start; the second found a warm build
         cache, started three seconds early, crash-looped four times on
         ENOTFOUND and had given up before the database was up. A race the
         build cache decides is not a race to leave in. */
      await until('the database to come up', async () => {
        const d = await latestDeployment(made.projectId, made.pgServiceId, made.environmentId);
        if (!d) return false;
        if (d.status === 'SUCCESS') return true;
        if (d.status === 'FAILED' || d.status === 'CRASHED') {
          throw new Error('the database deploy ' + String(d.status).toLowerCase()
            + ' — read its log in Railway before retrying');
        }
        return false;
      }, { everyMs: o.pollMs || 5000, timeoutMs: o.dbTimeoutMs || 180000,
        wait: o.wait, now: o.now });
    });

    await run('app', 'Creating the app service', async () => {
      /* Variables are set at creation so the FIRST build already has its
         secrets. Creating it bare and setting them afterwards costs a failed
         boot — the app refuses to migrate without them, and in production it
         exits rather than serve on a half-built schema, which is correct
         behaviour that would look like a provisioning bug. */
      made.appServiceId = await createService(made.projectId,
        o.serviceName || slug(name), { repo: REPO() }, appVariables(secrets));
    });

    await run('domain', 'Generating its address', async () => {
      made.domain = await createDomain(made.appServiceId, made.environmentId, 8080);
    });

    await run('settings', 'Setting the health check and the public URL', async () => {
      const instance = { healthcheckPath: '/readyz', healthcheckTimeout: 300 };
      if (REGION()) instance.region = REGION();
      await updateInstance(made.appServiceId, made.environmentId, instance);
      /* PUBLIC_URL is the ONE place the build learns its own hostname —
         nothing else in it spells a domain — so it cannot be set until the
         domain exists. Setting it triggers the deploy we actually want. */
      await setVariables(made.projectId, made.environmentId, made.appServiceId,
        { PUBLIC_URL: 'https://' + made.domain }, true);
      await deploy(made.appServiceId, made.environmentId);
    });

    await run('live', 'Waiting for the first deploy', async () => {
      await until('the first deploy to succeed', async () => {
        const d = await latestDeployment(made.projectId, made.appServiceId, made.environmentId);
        if (!d) return false;
        if (d.status === 'SUCCESS') return true;
        if (d.status === 'FAILED' || d.status === 'CRASHED') {
          throw new Error('the first deploy ' + String(d.status).toLowerCase()
            + ' — read its build log in Railway before retrying');
        }
        return false;
      }, { everyMs: o.pollMs || 5000, timeoutMs: o.deployTimeoutMs || 600000,
        wait: o.wait, now: o.now });
    });

    return {
      ok: true,
      made: made,
      steps: steps,
      secrets: secrets,
      baseUrl: 'https://' + made.domain
    };
  } catch (e) {
    /* Rollback is offered, never taken silently, and ONLY for a project this
       run created. `rollback: true` is a decision a person made on a screen
       that told them what would be destroyed. */
    if (o.rollback && made.ourProject && made.projectId) {
      try {
        await deleteProject(made.projectId);
        e.rolledBack = true;
      } catch (e2) {
        e.rollbackError = e2.message;
      }
    }
    throw e;
  }
}

/* ── THE FLEET'S OWN LOGS ───────────────────────────────────────────────────
   The panel runs ON Railway beside the services it watches, so Railway
   injects RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_ID into its environment
   — nothing to configure. With the same API token the provisioner already
   holds, the panel can list the environment's services and read each one's
   latest deployment log, which is the tab a developer otherwise keeps open
   in a second dashboard. Read-only: nothing here mutates anything. */
async function logServices(environmentId) {
  const d = await gql(
    'query env($id: String!) { environment(id: $id) { serviceInstances { edges { node {'
    + ' serviceId serviceName latestDeployment { id status createdAt } } } } } }',
    { id: environmentId }, { timeoutMs: 15000 });
  return ((d.environment || {}).serviceInstances || { edges: [] }).edges
    .map((e) => e.node)
    .filter((n) => n && n.latestDeployment)
    .map((n) => ({
      serviceId: n.serviceId, name: n.serviceName,
      deploymentId: n.latestDeployment.id,
      status: n.latestDeployment.status,
      deployedAt: n.latestDeployment.createdAt
    }));
}

async function deploymentLogs(deploymentId, limit) {
  const d = await gql(
    'query logs($id: String!, $limit: Int!) {'
    + ' deploymentLogs(deploymentId: $id, limit: $limit) {'
    + ' timestamp severity message } }',
    { id: deploymentId, limit: Math.min(1000, Math.max(1, Number(limit) || 300)) },
    { timeoutMs: 15000 });
  return (d.deploymentLogs || []).map((l) => ({
    ts: l.timestamp, severity: l.severity || 'info', message: l.message
  }));
}

module.exports = {
  ready, provision, mintSecrets, appVariables, pgVariables, slug,
  logServices, deploymentLogs,
  // exported for the tests, which exercise composition rather than the network
  _internal: { gql, until, createProject, createService, createVolume,
    setVariables, readVariables, updateInstance, createDomain, deploy,
    latestDeployment, deleteProject, API, PG_IMAGE, PG_MOUNT, PG_NAME }
};
