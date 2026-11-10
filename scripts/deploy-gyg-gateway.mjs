#!/usr/bin/env node
// Deploy cổng GetYourGuide (apps/gyg-gateway) lên Cloudflare và đặt bí mật cho nó.
//
//   node --env-file=.env.cloud scripts/deploy-gyg-gateway.mjs
//
// Cần trong file env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GYG_CONNECTION_ID,
// GYG_INBOUND_USERNAME, GYG_INBOUND_PASSWORD. Bí mật đi qua stdin của `wrangler secret put` và được che
// trong mọi dòng in ra.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'gyg-gateway')
const e = process.env
const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GYG_CONNECTION_ID', 'GYG_INBOUND_USERNAME', 'GYG_INBOUND_PASSWORD']
const missing = names.filter((n) => !e[n])
if (missing.length) {
  console.error('Thiếu biến:', missing.join(', '))
  process.exit(1)
}
const secrets = [e.SUPABASE_SERVICE_ROLE_KEY, e.GYG_INBOUND_PASSWORD, e.GYG_INBOUND_USERNAME]
const mask = (s) => secrets.reduce((acc, v) => acc.split(v).join('***'), s || '')

function wrangler(args, input) {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd, shell: true, encoding: 'utf8', input, maxBuffer: 1 << 24 })
  const lines = mask(`${r.stdout}${r.stderr}`).split('\n').filter((l) => l.trim() && !/update available|─/.test(l))
  console.log(`--- wrangler ${args.slice(0, 2).join(' ')} (exit ${r.status})\n${lines.slice(-8).join('\n')}`)
  if (r.status !== 0) process.exit(1)
}

wrangler(['deploy', '--var', `SUPABASE_URL:${e.SUPABASE_URL}`, '--var', `GYG_CONNECTION_ID:${e.GYG_CONNECTION_ID}`])
for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'GYG_INBOUND_USERNAME', 'GYG_INBOUND_PASSWORD']) {
  wrangler(['secret', 'put', name], e[name])
}
console.log('\nXong. Khai trên cổng Integrator: URL Worker ở trên, cùng GYG_INBOUND_USERNAME / GYG_INBOUND_PASSWORD trong .env.cloud.')
