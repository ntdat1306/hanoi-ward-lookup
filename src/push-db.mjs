// Inserts output/moves-db.json into the database through hanoi-moving-insights-api's own import script
// (`pnpm db:import-moves`): it connects with that project's .env, resolves ward codes and service type names to
// ids, validates every record exactly like the API and inserts them in one transaction (all or nothing).
//
//   pnpm push-db [--json <file>] [--replace]
//
// Without --replace the import refuses a non-empty moves table; --replace deletes every existing move first.
// The API project is the sibling folder ../hanoi-moving-insights-api unless MOVES_API_DIR (in .env) says otherwise.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* optional */ }

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const json = path.resolve(arg('--json') ?? path.join(ROOT, 'output', 'moves-db.json'));
const replace = process.argv.includes('--replace');
const apiDir = path.resolve(ROOT, process.env.MOVES_API_DIR ?? '../hanoi-moving-insights-api');

if (!existsSync(json)) {
  console.error(`${json} not found: run "pnpm export-json" first`);
  process.exit(1);
}
if (!existsSync(path.join(apiDir, 'package.json')) || !existsSync(path.join(apiDir, '.env'))) {
  console.error(`${apiDir} is not the API project with its .env (set MOVES_API_DIR in .env)`);
  process.exit(1);
}

console.log(`Importing ${json}\n  via ${apiDir} (pnpm db:import-moves${replace ? ' --replace' : ''})`);
// One command string: on Windows pnpm is a .cmd, which needs a shell
const command = `pnpm db:import-moves "${json}"${replace ? ' --replace' : ''}`;
const result = spawnSync(command, { cwd: apiDir, stdio: 'inherit', shell: true });
process.exitCode = result.status ?? 1;
