// Analytics-only guardrail: no D1 table queries or writes.
// node scripts/d1-read-budget.mjs [--watch] [--top]
// --watch checks every 10 minutes; --top includes production's top five SQL groups.
// Use the existing Wrangler login, or a scoped Cloudflare analytics API token.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execute = promisify(execFile);
const account = process.env.CCH_CLOUDFLARE_ACCOUNT_ID || '21e0ff427cc08e577d7977eb53319e36';
const wrangler = ['node_modules/wrangler/bin/wrangler.js'];
const childOptions = { env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/cch-budget-wrangler.log' }, maxBuffer: 4 * 1024 * 1024 };

async function check() {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const authDir = await mkdtemp(join(tmpdir(), 'cch-budget-auth-'));
    try {
      const { stdout } = await execute(process.execPath, [...wrangler, 'auth', 'token', '--json'], {
        ...childOptions, env: { ...childOptions.env, WRANGLER_LOG_PATH: join(authDir,'auth.log') }
      });
      token = JSON.parse(stdout).token;
    } finally {
      // Wrangler mirrors stdout into its debug log; discard the token log.
      await rm(authDir, { recursive: true, force: true });
    }
  }
  if (!token) throw new Error('Cloudflare analytics authentication unavailable');
  const now = new Date(), start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query Budget($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) {
        viewer { accounts(filter: {accountTag: $accountTag}) {
          d1AnalyticsAdaptiveGroups(limit: 10000, filter: $filter) {
            sum { rowsRead } dimensions { databaseId }
          }
        }}
      }`,
      variables: { accountTag: account, filter: { AND: [{ datetimeHour_geq: start.toISOString(), datetimeHour_leq: now.toISOString() }] } }
    }), signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Cloudflare analytics failed (${response.status}); check analytics permissions`);
  const groups = body.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error('Cloudflare returned no D1 analytics dataset');
  const rows = groups.reduce((sum, group) => sum + Number(group.sum.rowsRead), 0);
  if (!Number.isFinite(rows)) throw new Error('Invalid analytics row count');
  const report = { at: now.toISOString(), utc_day: start.toISOString().slice(0,10), account_rows_read: rows,
    threshold: 3000000, warning: rows >= 3000000, source: 'Cloudflare GraphQL account analytics', databases: groups };
  console.log(JSON.stringify(report));
  if (rows >= 3000000) console.warn(`WARNING: D1 account daily reads ${rows.toLocaleString('en-US')} exceed 3,000,000; the free cap is 5,000,000. Analytics may lag.`);
  if (process.argv.includes('--top')) {
    const { stdout } = await execute(process.execPath, [...wrangler, 'd1','insights','cybercabhunter_db','--timePeriod','1d','--sort-type','sum','--sort-by','reads','--limit','5','--json'], childOptions);
    console.log(stdout.trim());
  }
}
async function run() {
  try { await check(); } catch {
    // Do not echo child-process output or auth objects: stdout can contain a token.
    console.error('D1 usage check failed. Verify Wrangler login and account Analytics Read access.');
    if (!process.argv.includes('--watch')) process.exitCode = 1;
  }
}
await run();
if (process.argv.includes('--watch')) setInterval(run, 10 * 60 * 1000);
