import pkg from 'playwright'
const { chromium } = pkg
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })
const errs = []
for (const vp of [{width:1440,height:900,name:'desktop 1440'},{width:820,height:1180,name:'tablet 820'},{width:390,height:844,name:'phone 390'},{width:320,height:720,name:'small 320'}]) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 900 })
  await ctx.route(/^https:\/\//, r => r.fulfill({ status:200, contentType:'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64') }))
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(vp.name + ': ' + e.message))
  await p.goto(process.argv[2] + '/admin/login', { waitUntil: 'domcontentloaded' })
  await p.waitForLoadState('networkidle').catch(()=>{})
  await p.fill('input[type=email]','o@axisjourneys.com'); await p.fill('input[type=password]','a-test-owner-password')
  await p.click('button[type=submit]'); await p.waitForURL(/\/admin(?!\/login)/,{timeout:20000}); await p.waitForTimeout(1200)

  const wide = vp.width > 820
  const menu = p.locator('#studio-bar button[aria-expanded]')
  const menuShown = await menu.isVisible().catch(()=>false)
  if (!wide) {
    if (!menuShown) { console.log(vp.name.padEnd(13), 'FAIL: no menu button'); await ctx.close(); continue }
    const box = await menu.boundingBox()
    if (box.height < 44) console.log(vp.name.padEnd(13), `WARN: menu button ${box.height}px tall`)
    await menu.click(); await p.waitForTimeout(500)
  }
  const reach = await p.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
      return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden' && r.left > -5 && r.left < window.innerWidth }
    return [...document.querySelectorAll('#sidebar button, #sidebar a')].filter(vis).map(e=>e.textContent.trim().split('\n')[0].slice(0,16))
  })
  console.log(vp.name.padEnd(13), 'menu:', wide ? 'n/a' : menuShown, '| reachable:', reach.length, '→', reach.join(', ').slice(0,110))

  if (!wide) {
    // Navigate from the drawer and confirm it closes and the route changed.
    await p.locator('#sidebar button').filter({ hasText: /^Settings/ }).first().click()
    await p.waitForTimeout(1400)
    const after = { url: new URL(p.url()).pathname, drawerOpen: await p.locator('#sidebar').evaluate(el => el.getBoundingClientRect().left > -5) }
    console.log(' '.repeat(13), 'tapped Settings →', JSON.stringify(after))
    // And back out again
    await menu.click(); await p.waitForTimeout(400)
    await p.locator('#sidebar button').filter({ hasText: /^Dashboard/ }).first().click()
    await p.waitForTimeout(1400)
    console.log(' '.repeat(13), 'tapped Dashboard →', new URL(p.url()).pathname)
    const sideways = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    console.log(' '.repeat(13), 'scrolls sideways:', sideways)
  }
  await ctx.close()
}
console.log('ERRORS:', errs)
await b.close()
