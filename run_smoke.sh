#!/bin/bash
set -e
SRC=/sessions/bold-stoic-carson/mnt/outputs
VERIFY=$SRC/verify
WORK=/tmp/kleos-verify
APP=$WORK/app

echo "== setting up work dir =="
rm -rf "$WORK"
mkdir -p "$APP"
cp "$SRC"/server.js "$SRC"/db.js "$SRC"/sprint.js "$SRC"/auth.js "$SRC"/agents.js "$SRC"/content.js "$SRC"/tickets.js "$SRC"/mailer.js "$SRC"/logger.js "$SRC"/voice.js "$SRC"/schema.sql "$SRC"/package.json "$APP"/
cp -r "$SRC"/public "$APP"/public

echo "== installing app deps =="
cd "$APP"
npm install --no-audit --no-fund >/tmp/npm-app.log 2>&1
echo "app deps installed"

echo "== starting embedded postgres =="
mkdir -p "$WORK/pgdata"
export NODE_PATH="$VERIFY/node_modules"
cat > "$WORK/start-pg.js" << 'EOF'
const EmbeddedPostgres = require('embedded-postgres').default;
const pg = new EmbeddedPostgres({
  databaseDir: process.env.PGDATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: 5433,
  persistent: false
});
(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kleos');
  console.log('PG_READY');
})().catch(e => { console.error('PG_START_FAILED', e); process.exit(1); });
EOF
PGDATA_DIR="$WORK/pgdata" node "$WORK/start-pg.js" > "$WORK/pg.log" 2>&1 &
PG_PID=$!

for i in $(seq 1 30); do
  if grep -q PG_READY "$WORK/pg.log" 2>/dev/null; then break; fi
  if ! kill -0 $PG_PID 2>/dev/null; then echo "Postgres process died early"; cat "$WORK/pg.log"; exit 1; fi
  sleep 1
done
if ! grep -q PG_READY "$WORK/pg.log" 2>/dev/null; then
  echo "Postgres never became ready"; cat "$WORK/pg.log"; exit 1
fi
echo "postgres ready"

echo "== writing .env =="
cat > "$APP/.env" << 'EOF'
ANTHROPIC_API_KEY=sk-ant-fake-key-for-smoke-test
ANTHROPIC_MODEL=claude-sonnet-5
DATABASE_URL=postgres://postgres:postgres@localhost:5433/kleos
DATABASE_SSL=false
SESSION_SECRET=smoke-test-secret-not-for-real-use
PORT=3400
NODE_ENV=development
ADMIN_EMAILS=admin@example.com
EOF

echo "== starting app server =="
cd "$APP"
node server.js > "$WORK/app.log" 2>&1 &
APP_PID=$!

for i in $(seq 1 30); do
  if curl -sf http://localhost:3400/api/health >/dev/null 2>&1; then break; fi
  if ! kill -0 $APP_PID 2>/dev/null; then echo "App process died early"; cat "$WORK/app.log"; exit 1; fi
  sleep 1
done
if ! curl -sf http://localhost:3400/api/health >/dev/null 2>&1; then
  echo "App server never became healthy"; cat "$WORK/app.log"; exit 1
fi
echo "app server ready"
curl -s http://localhost:3400/api/health; echo

echo "== running HTTP smoke tests =="
DATABASE_URL="postgres://postgres:postgres@localhost:5433/kleos" BASE_URL="http://localhost:3400" node "$VERIFY/smoke.js"
SMOKE_EXIT=$?

echo "== running content-engine unit tests (mocked model) =="
cp "$VERIFY/content_test.js" "$APP/content_test.js"
(cd "$APP" && node -r dotenv/config content_test.js)
CONTENT_EXIT=$?

echo "== app server log (tail) =="
tail -40 "$WORK/app.log"

echo "== tearing down =="
kill $APP_PID 2>/dev/null || true
kill $PG_PID 2>/dev/null || true
sleep 1

if [ $SMOKE_EXIT -ne 0 ] || [ $CONTENT_EXIT -ne 0 ]; then
  echo "RESULT: FAILURES (http_exit=$SMOKE_EXIT content_exit=$CONTENT_EXIT)"
  exit 1
fi
echo "RESULT: ALL GREEN"
exit 0
