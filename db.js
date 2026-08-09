// db.js — single Postgres pool + one-shot schema migration.
//
// Every route in this app reads/writes through pool.query() (or the query()
// helper below). There is no ORM: the schema is small and stable enough that
// hand-written SQL in sprint.js/auth.js is easier to audit than a generated
// layer, and it keeps the dependency footprint of this app small.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn(
    '\n⚠️  DATABASE_URL is not set. Copy .env.example to .env and point it at a ' +
    'Postgres database before running the server.\n'
  );
}

// Most managed Postgres hosts (Railway, Render, Supabase, Neon, RDS) require
// SSL and hand you a connection string over the public internet; local
// Postgres usually does not speak SSL at all. Default to "on" and let
// DATABASE_SSL=false opt out for local development.
const useSSL = process.env.DATABASE_SSL !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  // Errors on idle clients (e.g. a dropped connection) must not crash the
  // whole process — log and let the pool recover.
  console.error('Unexpected Postgres pool error:', err);
});

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = {
  pool,
  migrate,
  query: (text, params) => pool.query(text, params)
};
