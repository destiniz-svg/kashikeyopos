import pkg from 'playwright'
const { chromium } = pkg
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })
for (const vp of [{width:1440,height:900,name:'desktop'},{width:820,height:1180,name:'tablet 820'},{width:390,height:844,name:'phone 390'}]) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height } })
  await ctx.route(/^https:\/\//, r => r.fulfill({ status:200, contentType:'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64') }))
  const p = await ctx.newPage()
  await p.goto(process.argv[2] + '/admin/login', { waitUntil: 'domcontentloaded' })
  await p.waitForLoadState('networkidle').catch(()=>{})
  await p.fill('input[type=email]','o@axisjourneys.com'); await p.fill('input[type=password]','a-test-owner-password')
  await p.click('button[type=submit]'); await p.waitForURL(/\/admin(?!\/login)/,{timeout:20000}); await p.waitForTimeout(1500)
  const info = await p.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden' }
    const sb = document.querySelector('#sidebar')
    const clickable = [...document.querySelectorAll('a[href],button')].filter(vis)
    return {
      sidebarPresent: !!sb,
      sidebarVisible: sb ? vis(sb) : false,
      navLinksVisible: clickable.filter(e => /dashboard|properties|offers|destinations|homepage|enquiries|media|settings|team/i.test(e.textContent||'')).map(e=>e.textContent.trim().slice(0,22)),
      totalClickable: clickable.length,
    }
  })
  console.log(vp.name.padEnd(12), JSON.stringify(info))
  await ctx.close()
}
await b.close()
