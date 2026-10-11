// Read-only benchmark. It never logs query result rows (which can contain VINs).
// node scripts/measure-daily-reads.mjs [config] [database binding]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDaily } from '../worker/daily.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execute = promisify(execFile);
const config = process.argv[2] || 'wrangler.preview.jsonc';
const database = process.argv[3] || 'cybercabhunter_db';
const metrics = [];
const logDir = await mkdtemp(join(tmpdir(), 'cch-daily-measure-'));
const sql = {
  prepare(query) {
    let params = [];
    const statement = {
      bind(...values) { params = values; return statement; },
      async all() {
        let index = 0;
        // These queries contain no literal '?' and binds are dates only.
        const command = query.replace(/\?/g, () => `'${String(params[index++]).replace(/'/g, "''")}'`);
        const { stdout } = await execute(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', database,
          '-c', config, '--remote', '--json', '--command', command], {
          env: { ...process.env, WRANGLER_LOG_PATH: join(logDir,'wrangler.log') }, maxBuffer: 4 * 1024 * 1024
        });
        const [result] = JSON.parse(stdout);
        if (!result?.success) throw new Error('Benchmark query failed');
        metrics.push({ query, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written,
          duration_ms: result.meta.duration, rows_returned: result.results.length });
        return result;
      },
      async first() { return (await statement.all()).results[0] || null; }
    };
    return statement;
  }
};
let result;
try { result = await buildDaily(sql); } finally { await rm(logDir, { recursive: true, force: true }); }
console.log(JSON.stringify({ at: new Date().toISOString(), config, errors: result.errors,
  queries: metrics, total_rows_read: metrics.reduce((sum, query) => sum + query.rows_read, 0) }, null, 2));
if (Object.keys(result.errors).length) process.exitCode = 1;
