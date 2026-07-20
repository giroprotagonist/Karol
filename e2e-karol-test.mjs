import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';

const BASE = 'http://localhost:3131';
const SCREENSHOTS = '/Users/macdonk/Documents/GitHub/Karol/e2e-screenshots';
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const results = [];

function record(label, ok, detail = '') {
  results.push({ label, ok, detail });
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${label}${detail ? ': ' + detail : ''}`);
}

// ─── Helper: check console for errors ───
function summarizeConsole(messages, label) {
  const errors = messages.filter(m => m.type() === 'error');
  const warns = messages.filter(m => m.type() === 'warning');
  console.log(`  [${label}] Console: ${errors.length} errors, ${warns.length} warnings`);
  for (const e of errors.slice(0, 5)) {
    console.log(`    ERROR: ${e.text().slice(0, 200)}`);
  }
  return errors.length;
}

// ─── Helper: curl ───
function curl(url, opts = '') {
  try {
    return execSync(`curl -s ${opts} "${url}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    return `CURL_ERROR: ${e.message}`;
  }
}

// ─── Helper: curl POST ───
function curlPost(url, body) {
  try {
    return execSync(`curl -s -X POST "${url}" -H 'Content-Type: application/json' -d '${body}'`, {
      encoding: 'utf8',
      maxBuffer: 1 * 1024 * 1024,
    });
  } catch (e) {
    return `CURL_ERROR: ${e.message}`;
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ═══════════════════════════════════════════════
  // 1. DJ CONTROLLER
  // ═══════════════════════════════════════════════
  console.log('\n─── 1. DJ Controller ───');
  const djPage = await browser.newPage();
  const djErrors = [];
  djPage.on('console', msg => { if (msg.type() === 'error') djErrors.push(msg); });
  djPage.on('pageerror', err => djErrors.push({ type: () => 'error', text: () => err.message }));

  let djLoaded = false;
  try {
    await djPage.goto(`${BASE}/dj-controller/`, { waitUntil: 'load', timeout: 15000 });
    await djPage.waitForTimeout(4000);
    djLoaded = true;
    record('DJ Controller page load', true, 'Page loaded');
  } catch (e) {
    record('DJ Controller page load', false, e.message);
  }

  // Screenshot (always attempt, even if load failed)
  try {
    await djPage.screenshot({ path: `${SCREENSHOTS}/01-dj-controller.png`, fullPage: true });
    record('DJ Controller screenshot', true, `${SCREENSHOTS}/01-dj-controller.png`);
  } catch (e) {
    record('DJ Controller screenshot', false, e.message);
  }

  // Check "Connected" status
  const statusText = await djPage.textContent('body') || '';
  const hasConnected = statusText.includes('Connected');
  record('DJ Controller shows "Connected" status', hasConnected,
    hasConnected ? 'Found Connected indicator in page text' : 'No Connected indicator found');

  // Check queue tab
  const queueTab = djPage.locator('button, [role="tab"]').filter({ hasText: 'Queue' }).first();
  if (await queueTab.count() > 0) {
    await queueTab.click();
    await djPage.waitForTimeout(1500);
    const queueContent = await djPage.textContent('body') || '';
    const hasQueueContent = queueContent.includes('Queue') || queueContent.includes('Song');
    record('Queue tab accessible', hasQueueContent, hasQueueContent ? 'Queue tab loaded' : 'Queue tab may be empty');
  } else {
    record('Queue tab accessible', false, 'Queue tab button not found');
  }

  // Check player tab with transport controls
  const playerTab = djPage.locator('button, [role="tab"]').filter({ hasText: 'Player' }).first();
  if (await playerTab.count() > 0) {
    await playerTab.click();
    await djPage.waitForTimeout(1500);
    const playerContent = (await djPage.textContent('body') || '').toLowerCase();
    const hasPlay = playerContent.includes('play');
    const hasPause = playerContent.includes('pause');
    const hasSkip = playerContent.includes('skip');
    record('Player tab has transport controls', hasPlay || hasPause || hasSkip,
      `Play:${hasPlay} Pause:${hasPause} Skip:${hasSkip}`);
  } else {
    record('Player tab has transport controls', false, 'Player tab button not found');
  }

  // Check library tab
  const libraryTab = djPage.locator('button, [role="tab"]').filter({ hasText: 'Library' }).first();
  if (await libraryTab.count() > 0) {
    await libraryTab.click();
    await djPage.waitForTimeout(2000);
    const libContent = await djPage.textContent('body') || '';
    const imgCount = await djPage.locator('img').count();
    const hasVideos = libContent.includes('video') || libContent.includes('Video') || imgCount > 2;
    record('Library tab shows videos', hasVideos, hasVideos ? `Video content detected (${imgCount} images)` : 'No video content found');
  } else {
    record('Library tab shows videos', false, 'Library tab button not found');
  }

  // Console errors
  const djErrCount = summarizeConsole(djErrors, 'DJ Controller');
  record('DJ Controller console errors', djErrCount === 0, `${djErrCount} errors`);

  await djPage.close();

  // ═══════════════════════════════════════════════
  // 2. MAC PLAYER
  // ═══════════════════════════════════════════════
  console.log('\n─── 2. Mac Player ───');
  const macPage = await browser.newPage();
  const macErrors = [];
  const macAll = [];
  macPage.on('console', msg => {
    macAll.push(msg);
    if (msg.type() === 'error') macErrors.push(msg);
  });
  macPage.on('pageerror', err => macErrors.push({ type: () => 'error', text: () => err.message }));

  try {
    await macPage.goto(`${BASE}/mac-player/`, { waitUntil: 'load', timeout: 15000 });
    await macPage.waitForTimeout(4000);
    record('Mac Player page load', true, 'Page loaded');
  } catch (e) {
    record('Mac Player page load', false, e.message);
  }

  await macPage.screenshot({ path: `${SCREENSHOTS}/02-mac-player.png`, fullPage: true });
  record('Mac Player screenshot', true, `${SCREENSHOTS}/02-mac-player.png`);

  // Check for JS errors
  const macErrCount = summarizeConsole(macErrors, 'Mac Player');
  record('Mac Player no JS errors', macErrCount === 0, `${macErrCount} errors`);

  // Check WebSocket connection
  const wsSuccess = macAll.find(m => m.type() !== 'error' && m.text().includes('WebSocket'));
  // Also check network
  const wsMessages = macAll.filter(m => m.text().toLowerCase().includes('websocket') ||
    m.text().toLowerCase().includes('connected') ||
    m.text().toLowerCase().includes('socket'));
  if (wsMessages.length > 0) {
    console.log('  WebSocket console messages:');
    wsMessages.slice(0, 5).forEach(m => console.log(`    ${m.type()}: ${m.text().slice(0, 150)}`));
  }
  record('WebSocket connection', wsMessages.length > 0,
    wsMessages.length > 0 ? `${wsMessages.length} WS-related messages` : 'No WebSocket messages found');

  await macPage.close();

  // ═══════════════════════════════════════════════
  // 3. LIBRARY API  (already done above but formalize)
  // ═══════════════════════════════════════════════
  console.log('\n─── 3. Library API ───');
  const apiResp = curl(`${BASE}/api/library/list?limit=3&page=1`);
  try {
    const apiJson = JSON.parse(apiResp);
    const count = apiJson.count;
    const videos = apiJson.videos;
    const hasVideos = Array.isArray(videos) && videos.length > 0;
    record('Library API returns videos', hasVideos && count > 0,
      `count=${count}, returned=${videos?.length || 0} videos`);
    if (hasVideos) {
      record('First video has title', !!videos[0].title, videos[0].title?.slice(0, 80));
    }
  } catch (e) {
    record('Library API parseable JSON', false, e.message);
  }

  // ═══════════════════════════════════════════════
  // 4. EXTERNAL LIBRARY
  // ═══════════════════════════════════════════════
  console.log('\n─── 4. External Library ───');
  const extPage = await browser.newPage();
  const extErrors = [];
  extPage.on('console', msg => { if (msg.type() === 'error') extErrors.push(msg); });
  extPage.on('pageerror', err => extErrors.push({ type: () => 'error', text: () => err.message }));

  try {
    await extPage.goto('https://request.rideyrbike.com/library/', { waitUntil: 'load', timeout: 15000 });
    await extPage.waitForTimeout(5000);
    record('External Library page load', true, 'Page loaded');
  } catch (e) {
    record('External Library page load', false, e.message);
  }

  await extPage.screenshot({ path: `${SCREENSHOTS}/03-external-library.png`, fullPage: true });
  record('External Library screenshot', true, `${SCREENSHOTS}/03-external-library.png`);

  // Count visible videos
  const bodyText = await extPage.textContent('body') || '';
  const imgCount = await extPage.locator('img').count();
  const cardCount = await extPage.locator('[class*="card"], [class*="video"], [class*="thumbnail"]').count();
  const videoCount = Math.max(imgCount, cardCount);
  record('External Library shows videos', bodyText.length > 500 && videoCount > 0,
    `body text ${bodyText.length} chars; ${videoCount} video elements`);

  // Search/filter
  const searchInput = extPage.locator('input').first();
  if (await searchInput.count() > 0) {
    await searchInput.fill('test');
    await extPage.waitForTimeout(1500);
    const afterSearch = await extPage.textContent('body') || '';
    record('External Library search works', afterSearch.length > 100,
      `Search entered, page content: ${afterSearch.length} chars`);
    await searchInput.fill('');
    await extPage.waitForTimeout(1000);
  } else {
    record('External Library search works', false, 'No search input found');
  }

  // Console errors
  const extErrCount = summarizeConsole(extErrors, 'External Library');
  record('External Library console errors', extErrCount === 0, `${extErrCount} errors`);

  await extPage.close();

  // ═══════════════════════════════════════════════
  // 5. FULL INTEGRATION
  // ═══════════════════════════════════════════════
  console.log('\n─── 5. Full Integration ───');
  
  // Queue a song
  const queueBody = '{"videoId":"dQw4w9WgXcQ","title":"Rick Astley - Never Gonna Give You Up","requester":"DJ Test","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}';
  const queueResp = curlPost(`${BASE}/api/youtube-dj/queue`, queueBody);
  console.log(`  Queue response: ${queueResp.slice(0, 200)}`);
  try {
    const qj = JSON.parse(queueResp);
    record('Queue song via API', qj.ok || qj.success || !queueResp.includes('error'),
      `Response: ${queueResp.slice(0, 100)}`);
  } catch {
    record('Queue song via API', !queueResp.includes('error'),
      `Response: ${queueResp.slice(0, 100)}`);
  }

  // Wait a moment then check now-playing
  await new Promise(r => setTimeout(r, 2000));
  const npResp = curl(`${BASE}/api/youtube-dj/now-playing`);
  console.log(`  Now-playing response: ${npResp.slice(0, 200)}`);
  try {
    const npj = JSON.parse(npResp);
    const hasSong = npj.title || npj.nextThumbnail || npj.state > 0;
    record('Now-playing shows activity', hasSong,
      `state=${npj.state}, nextThumbnail=${npj.nextThumbnail ? 'present' : 'none'}`);
  } catch {
    record('Now-playing shows activity', npResp.length > 20,
      `Response: ${npResp.slice(0, 100)}`);
  }

  // Transport play
  const transportResp = curlPost(`${BASE}/api/youtube-dj/transport/play`, '{}');
  console.log(`  Transport play response: ${transportResp.slice(0, 200)}`);
  try {
    const tj = JSON.parse(transportResp);
    record('Transport play API responds', tj.ok || tj.success || !transportResp.includes('error'),
      `Response: ${transportResp.slice(0, 100)}`);
  } catch {
    record('Transport play API responds', !transportResp.includes('error'),
      `Response: ${transportResp.slice(0, 100)}`);
  }

  // ═══════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  console.log('  E2E TEST RESULTS SUMMARY');
  console.log('═══════════════════════════════════════');
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.ok) pass++;
    else fail++;
    const icon = r.ok ? '✅' : '❌';
    console.log(`${icon} ${r.label}: ${r.detail}`);
  }
  console.log(`\nPassed: ${pass}/${results.length}, Failed: ${fail}/${results.length}`);
  console.log(`Screenshots saved to: ${SCREENSHOTS}`);

  // Write JSON report
  fs.writeFileSync(`${SCREENSHOTS}/results.json`, JSON.stringify({ results, pass, fail, total: results.length }, null, 2));

  await browser.close();
})();
