// Read-only view of the API's MySQL database: the `moves` table definition (columns, types, nullability, lengths,
// foreign keys, CHECK constraints) and the rows of the tables it references (wards, service_types). Only SELECTs on
// information_schema and those tables; nothing is ever written to the database.
//
// Connection: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME from this project's .env, else from the API
// project's .env (MOVES_API_DIR, default ../hanoi-moving-insights-api), whose mysql2 package is used, so this project
// needs no database driver of its own. The last schema read is kept in cache/db-schema.json for --offline-schema.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, 'cache', 'db-schema.json');
export const TARGET_TABLE = 'moves';

function connectionSettings() {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* optional */ }
  const apiDir = path.resolve(ROOT, process.env.MOVES_API_DIR ?? '../hanoi-moving-insights-api');
  const apiEnvFile = path.join(apiDir, '.env');
  const apiEnv = existsSync(apiEnvFile) ? parseEnv(readFileSync(apiEnvFile, 'utf8')) : {};
  const get = (name) => process.env[name] ?? apiEnv[name];
  return {
    apiDir,
    connection: { host: get('DB_HOST') ?? 'localhost', port: Number(get('DB_PORT') ?? 3306), user: get('DB_USER'), password: get('DB_PASSWORD'), database: get('DB_NAME') },
  };
}

/**
 * Columns a client must supply (what the API's own importer imports): not auto-increment and without a database
 * default, so id / created_at / updated_at are left out.
 */
export function importColumns(schema) {
  return schema.columns.filter((c) => !/auto_increment/i.test(c.extra) && c.default === null && !/DEFAULT_GENERATED/i.test(c.extra));
}

/** CHECK constraints of the form (`col` >= 0) → { col: 0 } (minimum values) */
function parseChecks(checks) {
  const min = {};
  for (const { clause } of checks) {
    const m = clause.match(/^\(*`?(\w+)`?\s*>=\s*(-?\d+)\)*$/);
    if (m) min[m[1]] = Number(m[2]);
  }
  return min;
}

/**
 * { source, database, columns, foreignKeys, minimums, serviceTypes, wards, existingMoves }
 * existingMoves (only with a live connection): the natural-key fields of the moves already stored, for the duplicate
 * check; they hold customer data, so they are never written to the snapshot.
 */
export async function loadDbSchema({ offline = false } = {}) {
  if (offline) {
    if (!existsSync(SNAPSHOT)) throw new Error(`--offline-schema: ${SNAPSHOT} does not exist yet (run once with the database reachable)`);
    return { ...JSON.parse(readFileSync(SNAPSHOT, 'utf8')), source: 'snapshot', existingMoves: null };
  }
  const { apiDir, connection } = connectionSettings();
  if (!connection.user || !connection.database) throw new Error('Database settings missing: set DB_USER / DB_NAME (and DB_PASSWORD) in .env or in the API project .env');
  const require = createRequire(path.join(apiDir, 'package.json'));
  let mysql;
  try { mysql = require('mysql2/promise'); } catch { throw new Error(`mysql2 not found in ${apiDir}/node_modules: run "pnpm install" there or set MOVES_API_DIR`); }
  let db;
  try {
    db = await mysql.createConnection({ ...connection, timezone: 'Z', dateStrings: false, connectTimeout: 10_000 });
  } catch (error) {
    // Never echo the password: only the code and the host
    throw new Error(`Cannot connect to MySQL ${connection.host}:${connection.port}/${connection.database} (${error.code ?? error.message})`);
  }
  try {
    const [columns] = await db.execute(
      `SELECT column_name AS name, data_type AS type, column_type AS columnType, is_nullable = 'YES' AS nullable,
              character_maximum_length AS maxLength, column_default AS \`default\`, extra AS extra
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [connection.database, TARGET_TABLE]);
    if (columns.length === 0) throw new Error(`Table ${connection.database}.${TARGET_TABLE} not found`);
    const [foreignKeys] = await db.execute(
      `SELECT column_name AS \`column\`, referenced_table_name AS \`table\`, referenced_column_name AS referencedColumn
         FROM information_schema.key_column_usage
        WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [connection.database, TARGET_TABLE]);
    const [checks] = await db.execute(
      `SELECT cc.check_clause AS clause FROM information_schema.check_constraints cc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_schema = cc.constraint_schema AND tc.constraint_name = cc.constraint_name
        WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'CHECK'`,
      [connection.database, TARGET_TABLE]);
    const [serviceTypes] = await db.execute('SELECT id, name FROM service_types ORDER BY id');
    const [wards] = await db.execute('SELECT id, code, name FROM wards ORDER BY id');
    const [existingMoves] = await db.execute(`SELECT id, moved_at AS movedAt, origin_address AS originAddress, destination_address AS destinationAddress,
      service_type_id AS serviceTypeId, phone FROM ${TARGET_TABLE}`);
    const schema = {
      database: connection.database,
      readAt: new Date().toISOString(),
      columns: columns.map((c) => ({ ...c, nullable: Boolean(c.nullable), maxLength: c.maxLength === null ? null : Number(c.maxLength), unsigned: /unsigned/i.test(c.columnType) })),
      foreignKeys,
      minimums: parseChecks(checks),
      serviceTypes,
      wards,
    };
    mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(schema, null, 1));
    return { ...schema, source: 'mysql', existingMoves };
  } finally {
    await db.end();
  }
}
