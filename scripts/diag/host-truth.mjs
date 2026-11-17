// Ask the running Host what it is actually serving. Read-only, no secrets printed.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 24547);
const authority = `127.0.0.1:${port}`;
const credentials = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const at = credentials.indexOf('client-connection/browser-session');
const secretMatch = credentials.slice(at).match(/secret:\s*([A-Za-z0-9_-]+)/);
const secret = Buffer.from(secretMatch[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64u = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const name = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`;
const now = Date.now();
const payload = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 86_400_000 }), 'utf8'));
const cookie = `${name}=v1.${payload}.${b64u(createHmac('sha256', secret).update(payload).digest())}`;

const get = async (path) => {
  const response = await fetch(`http://${authority}${path}`, { headers: { cookie } });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};

const stats = await get(process.argv[3] === 'all' ? '/api/loci/stats?all=1' : '/api/loci/stats');
if (stats.body === null) {
  console.log('stats failed:', stats.status);
  process.exit(1);
}
console.log('pluginVersion served by the Host:', stats.body.pluginVersion);
const mu = stats.body.mu ?? {};
console.log('axis entries:', (mu.entries ?? []).length, '· now', Number(mu.now ?? 0).toFixed(1));
console.log('regions:', JSON.stringify(mu.regions));
console.log('R:', mu.parameters?.entranceDepth);

// Does the schema the Host reports match what is installed?
console.log('schema reported:', stats.body.store?.schemaVersion ?? stats.body.schema ?? '(not in payload)');
