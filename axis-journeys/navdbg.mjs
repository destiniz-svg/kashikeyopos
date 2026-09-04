import pkg from 'playwright'
const { chromium } = pkg
const base = process.argv[2]
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.route(/^https:\/\//, r => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64') }))
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push('uncaught: ' + e.message))
p.on('console', m => { if (m.type()==='error') errs.push('console: ' + m.text().slice(0,120)) })

const at = async () => ({ url: new URL(p.url()).pathname, h1: await p.locator('h1').first().innerText().catch(()=>'(none)') })

await p.goto(base + '/admin/login', { waitUntil: 'domcontentloaded' })
await p.waitForLoadState('networkidle').catch(()=>{})
await p.fill('input[type=email]','o@axisjourneys.com'); await p.fill('input[type=password]','a-test-owner-password')
await p.click('button[type=submit]')
await p.waitForURL(/\/admin(?!\/login)/, { timeout: 20000 })
await p.waitForTimeout(1500)
console.log('after login      ', JSON.stringify(await at()))

// Click through the sidebar the way an editor does.
for (const label of ['Properties','Offers','Enquiries']) {
  const link = p.locator(`#sidebar a, #sidebar button, nav a, nav button, aside a, aside button`).filter({ hasText: new RegExp('^'+label,'i') }).first()
  const n = await link.count()
  if (!n) { console.log(`  "${label}" control not found`); continue }
  await link.click()
  await p.waitForTimeout(1200)
  console.log(`clicked ${label.padEnd(12)}`, JSON.stringify(await at()))
}
// Into an editor
const row = p.locator('text=Baros Maldives').first()
if (await row.count()) { await row.click(); await p.waitForTimeout(1500); console.log('opened a property ', JSON.stringify(await at())) }

console.log('--- browser BACK ---')
for (let i=0;i<3;i++){ await p.goBack({ waitUntil:'domcontentloaded' }).catch(e=>console.log('  goBack threw:', e.message.slice(0,60))); await p.waitForTimeout(1200); console.log('  back ->', JSON.stringify(await at())) }
console.log('--- browser FORWARD ---')
for (let i=0;i<2;i++){ await p.goForward({ waitUntil:'domcontentloaded' }).catch(e=>console.log('  goForward threw:', e.message.slice(0,60))); await p.waitForTimeout(1200); console.log('  fwd  ->', JSON.stringify(await at())) }
console.log('ERRORS:', errs.slice(0,6))
await b.close()
