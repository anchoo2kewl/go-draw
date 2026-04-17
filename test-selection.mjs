import { chromium } from 'playwright';

const DRAW_ID = 'p183bs37z6';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[go-draw]')) logs.push(text);
  });

  await page.goto(`http://localhost:8090/draw/${DRAW_ID}/edit`);
  await page.waitForSelector('canvas');
  await page.waitForTimeout(1500);

  // Inject a function to expose internal state via window
  await page.evaluate(() => {
    // Override render to expose selectedIds size after each render
    const origRender = window._godrawRender;
    // We can't access the closure, but we CAN add a click listener
    // that probes the canvas pixel colors to detect selection handles
  });

  // Instead of trying to access closure vars, let's scan the canvas visually.
  // But first, let's figure out where the elements are by doing a grid of clicks
  // and checking which ones "hit" vs "miss" based on console logs.

  console.log('=== Scanning canvas for hit regions ===');
  const hits = [];
  for (let x = 200; x <= 1300; x += 100) {
    for (let y = 100; y <= 800; y += 100) {
      logs.length = 0;
      await page.mouse.click(x, y);
      await page.waitForTimeout(50);
      const hitLog = logs.find(l => l.includes('click hit:'));
      if (hitLog && !hitLog.includes('MISS')) {
        hits.push({ x, y, log: hitLog });
      }
    }
  }

  if (hits.length === 0) {
    console.log('No hits found! Taking screenshot to see layout.');
    await page.screenshot({ path: '/tmp/go-draw-test/no-hits.png' });
    console.log('Screenshot: /tmp/go-draw-test/no-hits.png');

    // Debug: try extreme positions
    for (const [x, y] of [[100,100],[1300,800],[700,450],[200,200],[1100,700]]) {
      logs.length = 0;
      await page.mouse.click(x, y);
      await page.waitForTimeout(30);
      const hitLog = logs.find(l => l.includes('click hit:'));
      console.log(`  (${x},${y}): ${hitLog || 'no log'}`);
    }
  } else {
    console.log(`Found ${hits.length} hit positions:`);
    for (const h of hits) {
      console.log(`  (${h.x}, ${h.y}): ${h.log}`);
    }

    // Now test: click on one hit, check if selection is narrow
    const firstHit = hits[0];
    // Clear selection
    await page.mouse.click(50, 50);
    await page.waitForTimeout(200);

    console.log(`\n=== Click on single element at (${firstHit.x}, ${firstHit.y}) ===`);
    logs.length = 0;
    await page.mouse.click(firstHit.x, firstHit.y);
    await page.waitForTimeout(300);
    for (const l of logs) console.log(`  ${l}`);

    await page.screenshot({ path: '/tmp/go-draw-test/single-click.png' });
    console.log('Screenshot: /tmp/go-draw-test/single-click.png');
  }

  await browser.close();
}

test().catch(err => { console.error(err); process.exit(1); });
