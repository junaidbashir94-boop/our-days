const {chromium}=require('C:/Users/junib/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',route=>route.abort());
  await page.goto('http://127.0.0.1:4173');
  await page.waitForTimeout(500);
  const results=[];
  for(const [name,tab] of [['home','home'],['meet','meetups'],['calendar','calendar'],['plans','events'],['me','more']]){
    await page.locator(`#mobileBottomNav [data-tab="${tab}"]`).click();
    await page.waitForTimeout(150);
    if(name==='meet'){
      const cards=await page.locator('.opportunity-row').count();
      if(cards===0)throw Error('Meet must show opportunities for the fixture');
      await page.locator('[data-result-mode="everyone"]').click();
      const counts=await page.locator('.opportunity-count').allTextContents();
      if(counts.some(x=>!x.includes('4/4')))throw Error('Everyone-free filter includes partial overlap');
      await page.locator('[data-result-mode="all"]').click();
      const first=page.locator('[data-create-meetup-event]').first();
      const expectedEnd=Number(await first.getAttribute('data-end-min'))%1440;
      await first.click();
      const end=await page.locator('#eventEndTime').inputValue();
      const expected=String(Math.floor(expectedEnd/60)).padStart(2,'0')+':'+String(expectedEnd%60).padStart(2,'0');
      if(end!==expected)throw Error('Plan did not inherit opportunity end time');
      await page.keyboard.press('Escape');
    }
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    results.push({screen:name,viewport:'390×844',overflow});
    await page.screenshot({path:`../../outputs/${name}-preview.png`,fullPage:true});
  }
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#mainTabs [data-tab="home"]').click();
  results.push({screen:'home',viewport:'1280×900',overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
  await page.screenshot({path:'../../outputs/desktop-preview.png',fullPage:true});
  console.log(JSON.stringify({errors,results},null,2));
  await browser.close();
  if(errors.length||results.some(x=>x.overflow))process.exitCode=1;
})();
