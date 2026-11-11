// End-to-end tests: a local mock of the BMKG endpoints serving recorded fixtures, and the MCP server spawned over stdio.
// No internet. Fixtures in test/fixtures were recorded from BMKG on 11 Nov 2026 (Sumber: BMKG).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'mcp-bmkg.mjs');
const FIX = file => fs.readFileSync(path.join(HERE, 'fixtures', file), 'utf8');

let mock;
let base;
let hits = [];
let mode = 'ok'; // ok | slow | html | 429 | 500 | weird

before(async () => {
  mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push({ path: url.pathname, query: url.search, ua: req.headers['user-agent'] });
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    if (mode === 'slow') return setTimeout(() => send(200, FIX('autogempa.json')), 3000);
    if (mode === 'html') return send(200, '<html>maintenance</html>', 'text/html');
    if (mode === '429') return send(429, '{"error":"rate limit"}');
    if (mode === '500') return send(500, 'oops', 'text/plain');
    if (mode === 'weird') return send(200, '{"Infogempa":{"something":1},"data":"x"}');
    if (url.pathname.startsWith('/DataMKG/TEWS/')) {
      const file = url.pathname.slice('/DataMKG/TEWS/'.length);
      if (['autogempa.json', 'gempaterkini.json', 'gempadirasakan.json'].includes(file)) return send(200, FIX(file));
      return send(404, '<html>404</html>', 'text/html');
    }
    if (url.pathname === '/publik/prakiraan-cuaca') {
      const adm4 = url.searchParams.get('adm4');
      if (adm4 === '31.71.03.1001') return send(200, FIX('prakiraan-cuaca-31.71.03.1001.json'));
      if (adm4 === '00.00.00.0000') return send(400, '{"error":"Parameter adm tidak valid"}');
      if (adm4 === '11.22.33.4444') return send(200, '{"lokasi":{"adm4":"11.22.33.4444","desa":"Kosong","timezone":"Asia/Makassar"},"data":[{"lokasi":{},"cuaca":[]}]}');
      return send(404, '{"error":"Data cuaca tidak ditemukan"}');
    }
    send(404, '{"error":"not found"}');
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.address().port}`;
});

const children = new Set();
after(() => {
  for (const c of children) c.kill(); // a failed assertion must not leave a server running
  mock.close();
});

function startMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, MCP_BMKG_BASE_URL: base, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('close', () => children.delete(child));
  let buf = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map();
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    waiting.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const raw = line => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for raw')), 5000);
    waiting.set(null, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(line + '\n');
  });
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const stop = () => new Promise(r => { child.on('close', r); child.stdin.end(); });
  return { request, raw, call, stop, stderr: () => stderr };
}

function jsonBlock(res) {
  const m = /```json\n([\s\S]*?)\n```/.exec(res.content[0].text);
  assert.ok(m, 'answer has a JSON block');
  return JSON.parse(m[1]);
}

function assertAttribution(res) {
  const t = res.content[0].text;
  assert.match(t, /Sumber: BMKG/);
  assert.match(t, /Diambil: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WIB/);
}

test('initialize negotiates protocol and lists 4 read-only tools', async () => {
  const s = startMcp();
  const init = await s.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'mcp-bmkg');
  assert.match(init.result.instructions, /Sumber: BMKG/);
  const unknown = await s.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
  const list = await s.request('tools/list', {});
  const names = list.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['gempa_dirasakan', 'gempa_m5', 'gempa_terbaru', 'prakiraan_cuaca']);
  for (const t of list.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.type, 'object');
  }
  assert.deepEqual((await s.request('ping', {})).result, {});
  assert.equal((await s.request('nope/method', {})).error.code, -32601);
  assert.equal((await s.request('tools/call', { name: 'does_not_exist', arguments: {} })).error.code, -32602);
  await s.stop();
  assert.match(s.stderr(), /mcp-bmkg\] v1\.0\.0 ready/);
});

test('gempa_terbaru returns the latest quake with English JSON fields and attribution', async () => {
  hits = []; mode = 'ok';
  const s = startMcp();
  const res = await s.call('gempa_terbaru', {});
  assert.equal(res.isError, undefined);
  assertAttribution(res);
  assert.match(res.content[0].text, /M 4\.3/);
  assert.match(res.content[0].text, /Gayo Lues/);
  const j = jsonBlock(res);
  assert.equal(j.source, 'BMKG');
  assert.equal(j.dataset, 'autogempa');
  assert.equal(j.earthquake.magnitude, 4.3);
  assert.equal(j.earthquake.depth_km, 5);
  assert.equal(j.earthquake.latitude, 4.15);
  assert.equal(j.earthquake.longitude, 97.49);
  assert.equal(j.earthquake.datetime_utc, '2026-11-10T23:05:21+00:00');
  assert.equal(j.earthquake.shakemap_url, `${base}/DataMKG/TEWS/20261111060521.mmi.jpg`);
  assert.match(j.fetched_at_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(res.structuredContent, j);
  assert.equal(hits[0].path, '/DataMKG/TEWS/autogempa.json');
  assert.match(hits[0].ua, /^mcp-bmkg\/1\.0\.0/);
  await s.stop();
});

test('gempa_m5 lists M5+ quakes, honours limit and min_magnitude', async () => {
  mode = 'ok';
  const s = startMcp();
  const all = jsonBlock(await s.call('gempa_m5', {}));
  assert.equal(all.dataset, 'gempaterkini');
  assert.equal(all.count, 15);
  assert.ok(all.earthquakes.every(q => q.magnitude >= 5));
  assert.ok(all.earthquakes.every(q => typeof q.potential === 'string'));
  const two = await s.call('gempa_m5', { limit: 2 });
  assertAttribution(two);
  assert.equal(jsonBlock(two).count, 2);
  const big = jsonBlock(await s.call('gempa_m5', { min_magnitude: 5.5 }));
  assert.ok(big.earthquakes.every(q => q.magnitude >= 5.5));
  assert.ok(big.count < 15);
  const none = await s.call('gempa_m5', { min_magnitude: 9.9 });
  assert.match(none.content[0].text, /Tidak ada gempa/);
  assert.equal(jsonBlock(none).count, 0);
  await s.stop();
});

test('gempa_dirasakan lists felt quakes with MMI', async () => {
  mode = 'ok';
  const s = startMcp();
  const res = await s.call('gempa_dirasakan', { limit: 5 });
  assertAttribution(res);
  const j = jsonBlock(res);
  assert.equal(j.dataset, 'gempadirasakan');
  assert.equal(j.count, 5);
  assert.equal(j.total_in_feed, 15);
  assert.ok(j.earthquakes.every(q => typeof q.felt_mmi === 'string' && q.felt_mmi.length > 0));
  assert.match(res.content[0].text, /Dirasakan \(MMI\)/);
  await s.stop();
});

test('list tools reject bad arguments with isError', async () => {
  mode = 'ok';
  const s = startMcp();
  for (const args of [{ limit: 0 }, { limit: 16 }, { limit: 2.5 }, { limit: 'abc' }, { min_magnitude: -1 }, { min_magnitude: 'big' }]) {
    const res = await s.call('gempa_dirasakan', args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.content[0].text, /limit|min_magnitude/);
    assert.doesNotMatch(res.content[0].text, /at .*\.mjs/); // no stack trace
  }
  await s.stop();
});

test('prakiraan_cuaca returns the village forecast grouped by day', async () => {
  mode = 'ok';
  const s = startMcp();
  const res = await s.call('prakiraan_cuaca', { adm4: '31.71.03.1001' });
  assert.equal(res.isError, undefined);
  assertAttribution(res);
  const t = res.content[0].text;
  assert.match(t, /Kemayoran/);
  assert.match(t, /Waktu dalam WIB/);
  assert.match(t, /Rabu, 2026-11-11/);
  assert.match(t, /Kamis, 2026-11-12/);
  const j = jsonBlock(res);
  assert.equal(j.location.adm4, '31.71.03.1001');
  assert.equal(j.location.province, 'DKI Jakarta');
  assert.equal(j.location.timezone, 'Asia/Jakarta');
  assert.deepEqual(j.days, ['2026-11-11', '2026-11-12', '2026-11-13']);
  assert.equal(j.count, 17);
  const e = j.forecast[0];
  for (const k of ['local_datetime', 'utc_datetime', 'weather_desc', 'weather_desc_en', 'temperature_c', 'humidity_pct', 'wind_speed_kmh', 'wind_from', 'cloud_cover_pct', 'analysis_date_utc']) {
    assert.ok(k in e, k);
  }
  assert.equal(e.local_datetime, '2026-11-11 23:00:00');
  assert.equal(e.temperature_c, 26);
  assert.equal(e.visibility, null); // BMKG sends null at night: must not crash
  assert.ok(j.forecast.every((x, i, a) => i === 0 || a[i - 1].local_datetime <= x.local_datetime));
  assert.match(j.notes, /tp/);
  await s.stop();
});

test('prakiraan_cuaca days filter and empty forecast', async () => {
  mode = 'ok';
  const s = startMcp();
  const two = jsonBlock(await s.call('prakiraan_cuaca', { adm4: '31.71.03.1001', days: 2 }));
  assert.deepEqual(two.days, ['2026-11-11', '2026-11-12']);
  assert.equal(two.count, 9);
  const empty = await s.call('prakiraan_cuaca', { adm4: '11.22.33.4444' });
  assert.equal(empty.isError, undefined);
  assert.match(empty.content[0].text, /belum memuat prakiraan/);
  assert.match(empty.content[0].text, /WITA/);
  assert.equal(jsonBlock(empty).count, 0);
  await s.stop();
});

test('prakiraan_cuaca validates adm4 locally and maps BMKG 404/400', async () => {
  mode = 'ok';
  hits = [];
  const s = startMcp();
  for (const adm4 of [undefined, '', '3171031001', '31.71.03', '31.71.03.1001; rm -rf /', '31.71.03.1001&adm4=1', 12345]) {
    const res = await s.call('prakiraan_cuaca', adm4 === undefined ? {} : { adm4 });
    assert.equal(res.isError, true, String(adm4));
    assert.match(res.content[0].text, /adm4/);
    assert.match(res.content[0].text, /Sumber data: BMKG/);
  }
  assert.equal(hits.length, 0, 'invalid codes never reach BMKG');
  const bad = await s.call('prakiraan_cuaca', { adm4: '31.71.03.1001', days: 4 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /days/);
  const notFound = await s.call('prakiraan_cuaca', { adm4: '99.99.99.9999' });
  assert.equal(notFound.isError, true);
  assert.match(notFound.content[0].text, /tidak ditemukan/);
  const rejected = await s.call('prakiraan_cuaca', { adm4: '00.00.00.0000' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /menolak/);
  await s.stop();
});

test('responses are cached for 60 s by default, and cache can be disabled', async () => {
  mode = 'ok';
  hits = [];
  const s = startMcp();
  const a = jsonBlock(await s.call('gempa_terbaru', {}));
  const b = jsonBlock(await s.call('gempa_terbaru', {}));
  assert.equal(hits.length, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.fetched_at_utc, a.fetched_at_utc);
  await s.stop();
  hits = [];
  const s2 = startMcp({ MCP_BMKG_CACHE_MS: '0' });
  await s2.call('gempa_terbaru', {});
  await s2.call('gempa_terbaru', {});
  assert.equal(hits.length, 2);
  await s2.stop();
});

test('concurrent identical calls share one upstream request', async () => {
  mode = 'ok';
  hits = [];
  const s = startMcp();
  await Promise.all([s.call('gempa_m5', {}), s.call('gempa_m5', { limit: 3 }), s.call('gempa_m5', { limit: 1 })]);
  assert.equal(hits.length, 1);
  await s.stop();
});

test('timeout, rate limit, server error, non-JSON and unknown format give actionable errors', async () => {
  const cases = [
    ['slow', /tidak menjawab dalam 1 detik/],
    ['429', /60 permintaan per menit/],
    ['500', /HTTP 500/],
    ['html', /bukan JSON/],
    ['weird', /tidak dikenali/],
  ];
  for (const [m, re] of cases) {
    mode = m;
    const s = startMcp({ MCP_BMKG_TIMEOUT_MS: '1000', MCP_BMKG_CACHE_MS: '0' });
    const res = await s.call(m === 'weird' ? 'gempa_dirasakan' : 'gempa_terbaru', {});
    assert.equal(res.isError, true, m);
    assert.match(res.content[0].text, re, m);
    await s.stop();
  }
  mode = 'weird';
  const s = startMcp({ MCP_BMKG_CACHE_MS: '0' });
  const res = await s.call('prakiraan_cuaca', { adm4: '31.71.03.1001' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /tidak dikenali/);
  await s.stop();
  mode = 'ok';
});

test('unreachable BMKG gives a connection error, errors are not cached', async () => {
  const s = startMcp({ MCP_BMKG_BASE_URL: 'http://127.0.0.1:1' });
  const res = await s.call('gempa_terbaru', {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Tidak bisa menghubungi BMKG/);
  await s.stop();
  mode = '500';
  hits = [];
  const s2 = startMcp();
  assert.equal((await s2.call('gempa_terbaru', {})).isError, true);
  mode = 'ok';
  assert.equal((await s2.call('gempa_terbaru', {})).isError, undefined);
  assert.equal(hits.length, 2);
  await s2.stop();
});

test('bad JSON-RPC input never breaks stdout', async () => {
  const s = startMcp();
  const parse = await s.raw('{not json');
  assert.equal(parse.error.code, -32700);
  const ok = await s.request('tools/call', { name: 'gempa_terbaru', arguments: ['not', 'an', 'object'] });
  assert.ok(ok.result.content);
  await s.stop();
});
