import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = process.cwd();
const submit = randomBytes(24).toString('hex'),
  pair = randomBytes(24).toString('hex');
const server = spawn(process.execPath, ['relay/relay.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: '0', SNEAKPEEK_TOKEN: submit, SNEAKPEEK_PAIR_CODE: pair },
});
let browser;
try {
  const [line] = await once(server.stdout, 'data');
  const url = String(line).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const hook = (tool, args) => {
    const child = spawn(process.execPath, ['hook/sneakpeek-hook.mjs'], {
      cwd: root,
      env: { ...process.env, SNEAKPEEK_TOKEN: submit, SNEAKPEEK_URL: url },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const done = once(child, 'close').then(() => out);
    child.stdin.end(
      JSON.stringify({
        tool_name: tool,
        tool_input: args,
        cwd: root,
        session_id: 'wearables-demo',
        hook_event_name: 'PermissionRequest',
      }),
    );
    return done;
  };
  await page.goto(url + '/#pair=' + pair);
  await page.getByText('All clear').waitFor();
  assert(!page.url().includes(pair));
  await page.reload();
  await page.getByText('All clear').waitFor();
  let output = hook('Read', { file_path: path.join(root, 'README.md') });
  await page.getByText('./README.md').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'later');
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await page.getByRole('button', { name: 'Confirm' }).waitFor();
  await page.waitForTimeout(3200);
  await page.getByRole('button', { name: 'Approve' }).waitFor();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'Approve' }).waitFor();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  assert.equal(JSON.parse(await output).hookSpecificOutput.decision.behavior, 'allow');
  await page.getByText('All clear').waitFor();
  output = hook('Bash', { command: 'echo ' + 'long'.repeat(80) + ' && echo last-part' });
  await page.getByText('Terminal approval').waitFor();
  assert.equal(await page.locator('#allow').isVisible(), false);
  assert((await page.locator('#what').innerText()).endsWith('echo last-part'));
  assert(await page.locator('#what').evaluate((el) => el.scrollHeight <= el.clientHeight));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  assert.equal(JSON.parse(await output).hookSpecificOutput.decision.behavior, 'deny');
  await page.getByText('All clear').waitFor();
  output = hook('Glob', { pattern: '*.md' });
  await page.getByText('*.md', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await output, '');
  await page.getByText('All clear').waitFor();
  const stop = once(server, 'exit');
  server.kill();
  await stop;
  await page.getByRole('heading', { name: 'Relay offline' }).waitFor();
  assert.equal(await page.locator('#actions').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(
    'Chrome passed pairing, reload, focus, held key, expiry, disarm, approval, denial, defer, offline and layout at 600x600.',
  );
} finally {
  await browser?.close();
  server.kill();
}
