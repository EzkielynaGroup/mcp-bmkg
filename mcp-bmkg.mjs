#!/usr/bin/env node
// mcp-bmkg: Indonesian earthquake and weather forecast data from BMKG open data (data.bmkg.go.id), for Claude Desktop,
// Claude Code, Cursor, OpenCode and other MCP clients. One file, no dependencies, Node >= 18, MCP over stdio
// (newline-delimited JSON-RPC). Logs go to stderr only; stdout carries protocol messages. No API key needed.
//
// Data: Badan Meteorologi, Klimatologi, dan Geofisika (BMKG). BMKG's open data terms require every app that uses the
// data to show BMKG as the source, so every answer of this server ends with "Sumber: BMKG".
// This project is independent and not affiliated with BMKG.
//
// Env:
//   MCP_BMKG_BASE_URL     one base URL for both BMKG hosts (testing / mirrors). Unset = https://data.bmkg.go.id for
//                         earthquakes and https://api.bmkg.go.id for forecasts.
//   MCP_BMKG_TIMEOUT_MS   timeout per request, default 10000
//   MCP_BMKG_CACHE_MS     cache lifetime per URL, default 60000 (BMKG allows 60 requests per minute per IP)
import readline from 'node:readline';

const VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';

const env = process.env;
const OVERRIDE = (env.MCP_BMKG_BASE_URL || '').trim().replace(/\/+$/, '');
const DATA_BASE = OVERRIDE || 'https://data.bmkg.go.id';
const API_BASE = OVERRIDE || 'https://api.bmkg.go.id';
const TIMEOUT_MS = positiveInt(env.MCP_BMKG_TIMEOUT_MS, 10000, 1000, 120000);
const CACHE_MS = positiveInt(env.MCP_BMKG_CACHE_MS, 60000, 0, 3600000);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = `mcp-bmkg/${VERSION} (+https://github.com/EzkielynaGroup/mcp-bmkg)`;
const ADM4_RE = /^\d{2}\.\d{2}\.\d{2}\.\d{4}$/;
const SOURCE_NOTE = 'Data: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika), data.bmkg.go.id. '
  + 'Tidak berafiliasi dengan BMKG / not affiliated with BMKG.';

function positiveInt(v, dflt, min, max) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

function log(...args) {
  process.stderr.write('[mcp-bmkg] ' + args.map(a => String(a)).join(' ') + '\n');
}

class ToolError extends Error {}

// ---------- time helpers (Asia/Jakarta is UTC+7 all year, no DST) ----------

const WIB_OFFSET_MS = 7 * 3600 * 1000;

function wibStamp(ms) {
  const iso = new Date(ms + WIB_OFFSET_MS).toISOString(); // shifted clock, read as WIB wall time
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} WIB`;
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------- HTTP with timeout, size limit and a small cache ----------

const cache = new Map(); // url -> { at, data }
const inflight = new Map(); // url -> Promise

async function getJson(url, kind) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_MS) return { ...hit, cached: true };
  if (inflight.has(url)) return inflight.get(url);
  const p = fetchJson(url, kind).then(data => {
    const entry = { at: Date.now(), data };
    if (CACHE_MS > 0) {
      cache.set(url, entry);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    return { ...entry, cached: false };
  }).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

async function fetchJson(url, kind) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  let body;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: ac.signal, redirect: 'follow' });
    body = await readLimited(res);
  } catch (e) {
    if (ac.signal.aborted) {
      throw new ToolError(`BMKG tidak menjawab dalam ${Math.round(TIMEOUT_MS / 1000)} detik. Coba lagi sebentar lagi. / BMKG did not answer within ${Math.round(TIMEOUT_MS / 1000)} s; try again shortly.`);
    }
    if (e instanceof ToolError) throw e;
    throw new ToolError(`Tidak bisa menghubungi BMKG (${e && e.cause && e.cause.code || e.message}). Periksa koneksi internet. / Could not reach BMKG; check the internet connection.`);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = JSON.parse(body); } catch { /* handled below */ }
  if (!res.ok) {
    const msg = json && typeof json.error === 'string' ? json.error.slice(0, 200) : '';
    if (res.status === 404 && kind === 'forecast') {
      throw new ToolError(`Kode wilayah tidak ditemukan di data prakiraan BMKG${msg ? ` ("${msg}")` : ''}. Pastikan kode adm4 kelurahan/desa benar, contoh 31.71.03.1001 (Kemayoran). `
        + '/ BMKG has no forecast for this village code. Check the adm4 code, e.g. 31.71.03.1001.');
    }
    if (res.status === 400 && kind === 'forecast') {
      throw new ToolError(`BMKG menolak kode wilayah${msg ? ` ("${msg}")` : ''}. Gunakan kode adm4 format 00.00.00.0000. / BMKG rejected the code; use an adm4 code like 31.71.03.1001.`);
    }
    if (res.status === 429) {
      throw new ToolError('BMKG membatasi akses (maks. 60 permintaan per menit per IP). Tunggu satu menit lalu coba lagi. / BMKG rate limit (60 requests per minute per IP); wait a minute.');
    }
    throw new ToolError(`BMKG menjawab HTTP ${res.status}. Coba lagi nanti. / BMKG answered HTTP ${res.status}; try again later.`);
  }
  if (json === null || typeof json !== 'object') {
    throw new ToolError('Jawaban BMKG bukan JSON yang valid (mungkin sedang gangguan). / BMKG returned invalid JSON (service may be down).');
  }
  return json;
}

async function readLimited(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new ToolError('Jawaban BMKG terlalu besar (lebih dari 2 MB). / BMKG response too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

// ---------- earthquake data ----------

function quakeUrl(file) {
  return `${DATA_BASE}/DataMKG/TEWS/${file}`;
}

function num(v) {
  const n = Number.parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function str(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : v == null ? null : String(v).slice(0, max);
}

function normalizeQuake(g) {
  if (!g || typeof g !== 'object') return null;
  const [lat, lon] = String(g.Coordinates || '').split(',').map(num);
  const shakemap = typeof g.Shakemap === 'string' && /^[A-Za-z0-9._-]{1,80}\.jpg$/.test(g.Shakemap) ? quakeUrl(g.Shakemap) : null;
  const q = {
    datetime_utc: str(g.DateTime, 40),
    date_local: str(g.Tanggal, 40),
    time_local: str(g.Jam, 40),
    magnitude: num(g.Magnitude),
    depth_km: num(g.Kedalaman),
    latitude: lat ?? null,
    longitude: lon ?? null,
    latitude_text: str(g.Lintang, 40),
    longitude_text: str(g.Bujur, 40),
    region: str(g.Wilayah),
  };
  if (g.Potensi !== undefined) q.potential = str(g.Potensi);
  if (g.Dirasakan !== undefined) q.felt_mmi = str(g.Dirasakan);
  if (g.Shakemap !== undefined) q.shakemap_url = shakemap;
  return q;
}

function quakeList(json) {
  const g = json && json.Infogempa && json.Infogempa.gempa;
  const list = Array.isArray(g) ? g : g && typeof g === 'object' ? [g] : null;
  if (!list) throw new ToolError('Format data gempa BMKG tidak dikenali (mungkin berubah). / Unrecognised BMKG earthquake format.');
  return list.map(normalizeQuake).filter(Boolean);
}

function quakeLine(q, i) {
  const parts = [
    `${i != null ? `${i + 1}. ` : ''}M ${q.magnitude ?? '?'} | ${q.date_local || '?'} ${q.time_local || ''}`.trim(),
    `   Lokasi: ${q.region || '?'}`,
    `   Kedalaman: ${q.depth_km ?? '?'} km | Koordinat: ${q.latitude_text || q.latitude} ${q.longitude_text || q.longitude}`,
  ];
  if (q.potential) parts.push(`   Potensi: ${q.potential}`);
  if (q.felt_mmi) parts.push(`   Dirasakan (MMI): ${q.felt_mmi}`);
  if (q.shakemap_url) parts.push(`   Peta guncangan: ${q.shakemap_url}`);
  return parts.join('\n');
}

function limitArg(v, dflt, max) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ToolError(`"limit" harus bilangan bulat 1-${max}. / "limit" must be an integer from 1 to ${max}.`);
  return n;
}

function minMagArg(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new ToolError('"min_magnitude" harus angka 0-10. / "min_magnitude" must be a number from 0 to 10.');
  return n;
}

function footer(fetched) {
  return `Sumber: BMKG (data.bmkg.go.id). Diambil: ${wibStamp(fetched.at)}${fetched.cached ? ' (cache)' : ''}.`;
}

function result(textBody, data, fetched) {
  const payload = { ...data, source: 'BMKG', source_url: data.source_url, fetched_at_utc: isoUtc(fetched.at), fetched_at_wib: wibStamp(fetched.at), cached: fetched.cached };
  const out = `${textBody}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n${footer(fetched)}`;
  return { content: [{ type: 'text', text: out }], structuredContent: payload };
}

async function gempaTerbaru() {
  const url = quakeUrl('autogempa.json');
  const fetched = await getJson(url, 'quake');
  const [q] = quakeList(fetched.data);
  if (!q) throw new ToolError('BMKG belum memuat data gempa terbaru. / BMKG returned no latest earthquake.');
  const text = 'Gempabumi terbaru menurut BMKG (data "Gempabumi Terbaru", autogempa):\n' + quakeLine(q, null)
    + '\n\nCatatan: ini gempa terbaru yang dipublikasikan BMKG sebagai "Gempabumi Terbaru"; bisa di bawah M 5.0 bila dirasakan. Untuk daftar M 5.0+ gunakan gempa_m5.';
  return result(text, { dataset: 'autogempa', source_url: url, earthquake: q }, fetched);
}

async function quakeListTool(args, file, title, dataset) {
  const limit = limitArg(args.limit, 15, 15);
  const minMag = minMagArg(args.min_magnitude);
  const url = quakeUrl(file);
  const fetched = await getJson(url, 'quake');
  const all = quakeList(fetched.data);
  const list = all.filter(q => minMag === null || (q.magnitude !== null && q.magnitude >= minMag)).slice(0, limit);
  const head = `${title} (${list.length} dari ${all.length} data BMKG${minMag !== null ? `, M >= ${minMag}` : ''}):`;
  const text = list.length ? `${head}\n${list.map(quakeLine).join('\n')}` : `${head}\nTidak ada gempa yang cocok dengan filter. / No earthquakes match the filter.`;
  return result(text, { dataset, source_url: url, count: list.length, total_in_feed: all.length, min_magnitude: minMag, earthquakes: list }, fetched);
}

// ---------- weather forecast ----------

function normalizeForecastEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : num(v));
  return {
    local_datetime: str(e.local_datetime, 40),
    utc_datetime: str(e.utc_datetime, 40),
    weather_desc: str(e.weather_desc, 100),
    weather_desc_en: str(e.weather_desc_en, 100),
    weather_code: n(e.weather),
    temperature_c: n(e.t),
    humidity_pct: n(e.hu),
    cloud_cover_pct: n(e.tcc),
    precipitation_mm: n(e.tp),
    wind_speed_kmh: n(e.ws),
    wind_from: str(e.wd, 10),
    wind_to: str(e.wd_to, 10),
    wind_direction_deg: n(e.wd_deg),
    visibility: str(e.vs_text, 40),
    analysis_date_utc: str(e.analysis_date, 40),
    icon_url: typeof e.image === 'string' && /^https:\/\//.test(e.image) ? e.image.slice(0, 300) : null,
  };
}

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function dayName(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  // Calendar math on a UTC date: no local-timezone shift possible.
  return HARI[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}

async function prakiraanCuaca(args) {
  const adm4 = typeof args.adm4 === 'string' ? args.adm4.trim() : '';
  if (!ADM4_RE.test(adm4)) {
    throw new ToolError('"adm4" wajib berupa kode kelurahan/desa Kemendagri format 00.00.00.0000, contoh 31.71.03.1001 (Kemayoran, Jakarta Pusat). '
      + '/ "adm4" must be a village code like 31.71.03.1001.');
  }
  let days = 3;
  if (args.days !== undefined && args.days !== null && args.days !== '') {
    days = Number(args.days);
    if (!Number.isInteger(days) || days < 1 || days > 3) throw new ToolError('"days" harus 1, 2, atau 3. / "days" must be 1, 2 or 3.');
  }
  const url = `${API_BASE}/publik/prakiraan-cuaca?adm4=${encodeURIComponent(adm4)}`;
  const fetched = await getJson(url, 'forecast');
  const d = fetched.data;
  const block = Array.isArray(d.data) ? d.data[0] : null;
  if (!block || !Array.isArray(block.cuaca)) throw new ToolError('Format data prakiraan BMKG tidak dikenali (mungkin berubah). / Unrecognised BMKG forecast format.');
  const lok = d.lokasi && typeof d.lokasi === 'object' ? d.lokasi : block.lokasi || {};
  const location = {
    adm4: str(lok.adm4, 20) || adm4,
    village: str(lok.desa, 100),
    district: str(lok.kecamatan, 100),
    regency_city: str(lok.kotkab, 100),
    province: str(lok.provinsi, 100),
    latitude: typeof lok.lat === 'number' ? lok.lat : num(lok.lat),
    longitude: typeof lok.lon === 'number' ? lok.lon : num(lok.lon),
    timezone: str(lok.timezone, 40),
  };
  const entries = block.cuaca.flat().map(normalizeForecastEntry).filter(e => e && e.local_datetime)
    .sort((a, b) => a.local_datetime.localeCompare(b.local_datetime));
  const dates = [...new Set(entries.map(e => e.local_datetime.slice(0, 10)))].slice(0, days);
  const kept = entries.filter(e => dates.includes(e.local_datetime.slice(0, 10))).slice(0, 40);
  const tz = location.timezone === 'Asia/Jakarta' ? 'WIB' : location.timezone === 'Asia/Makassar' ? 'WITA' : location.timezone === 'Asia/Jayapura' ? 'WIT' : 'waktu setempat';
  const lines = [
    `Prakiraan cuaca BMKG untuk ${[location.village, location.district, location.regency_city, location.province].filter(Boolean).join(', ')} (adm4 ${location.adm4}).`,
    `Waktu dalam ${tz}. Interval 3 jam.`,
  ];
  for (const date of dates) {
    lines.push('', `${dayName(date)}, ${date}:`);
    for (const e of kept.filter(x => x.local_datetime.startsWith(date))) {
      const extra = [
        e.temperature_c != null ? `${e.temperature_c}°C` : null,
        e.humidity_pct != null ? `lembap ${e.humidity_pct}%` : null,
        e.wind_speed_kmh != null ? `angin ${e.wind_speed_kmh} km/jam${e.wind_from ? ` dari ${e.wind_from}` : ''}` : null,
        e.precipitation_mm ? `tp ${e.precipitation_mm} mm` : null,
      ].filter(Boolean).join(', ');
      lines.push(`- ${e.local_datetime.slice(11, 16)} ${e.weather_desc || '?'}${extra ? ` (${extra})` : ''}`);
    }
  }
  if (!kept.length) lines.push('', 'BMKG belum memuat prakiraan untuk lokasi ini. / BMKG returned no forecast entries.');
  const analysis = kept.find(e => e.analysis_date_utc)?.analysis_date_utc || null;
  if (analysis) lines.push('', `Data dibuat BMKG (analysis_date, UTC): ${analysis}.`);
  const notes = 'Times are local to the village (local_datetime) and UTC (utc_datetime). precipitation_mm is BMKG field "tp", '
    + 'which BMKG does not document on its open data page; it is read as precipitation in mm (unverified).';
  return result(lines.join('\n'), { dataset: 'prakiraan-cuaca', source_url: url, location, analysis_date_utc: analysis, days: dates, count: kept.length, forecast: kept, notes }, fetched);
}

// ---------- tools ----------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const LIST_PROPS = {
  limit: { type: 'integer', minimum: 1, maximum: 15, default: 15, description: 'Maximum number of earthquakes to return (1-15). BMKG publishes the 15 most recent.' },
  min_magnitude: { type: 'number', minimum: 0, maximum: 10, description: 'Optional: only return earthquakes with magnitude >= this value.' },
};

const TOOLS = [
  {
    name: 'gempa_terbaru',
    title: 'Gempa terbaru / Latest earthquake',
    description: 'Gempabumi terbaru dari BMKG: waktu, magnitudo, kedalaman, lokasi, potensi tsunami, wilayah yang merasakan, dan link peta guncangan. '
      + 'Latest earthquake in Indonesia published by BMKG ("Gempabumi Terbaru"; usually M5+, can be smaller when felt). Free, no key.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Gempa terbaru (BMKG)', ...READ_ONLY },
  },
  {
    name: 'gempa_dirasakan',
    title: 'Gempa dirasakan / Felt earthquakes',
    description: 'Daftar 15 gempa terakhir yang dirasakan masyarakat (dengan skala MMI per wilayah) dari BMKG. '
      + 'The 15 most recent earthquakes felt in Indonesia, with MMI intensity by area. Free, no key.',
    inputSchema: { type: 'object', properties: LIST_PROPS, additionalProperties: false },
    annotations: { title: 'Gempa dirasakan (BMKG)', ...READ_ONLY },
  },
  {
    name: 'gempa_m5',
    title: 'Gempa M5+ / Recent M5+ earthquakes',
    description: 'Daftar 15 gempa terakhir bermagnitudo 5.0 ke atas dari BMKG, dengan potensi tsunami. '
      + 'The 15 most recent M 5.0+ earthquakes in and around Indonesia, with tsunami potential. Free, no key.',
    inputSchema: { type: 'object', properties: LIST_PROPS, additionalProperties: false },
    annotations: { title: 'Gempa M5+ (BMKG)', ...READ_ONLY },
  },
  {
    name: 'prakiraan_cuaca',
    title: 'Prakiraan cuaca / Weather forecast',
    description: 'Prakiraan cuaca BMKG per kelurahan/desa (per 3 jam, hingga 3 hari): kondisi, suhu, kelembapan, angin, tutupan awan. '
      + 'Needs the Kemendagri village code "adm4" (format 00.00.00.0000, e.g. 31.71.03.1001 = Kemayoran, Jakarta Pusat). '
      + 'BMKG weather forecast for an Indonesian village, 3-hourly for up to 3 days. Free, no key.',
    inputSchema: {
      type: 'object',
      properties: {
        adm4: { type: 'string', pattern: '^\\d{2}\\.\\d{2}\\.\\d{2}\\.\\d{4}$', description: 'Kemendagri level-4 (kelurahan/desa) code, e.g. 31.71.03.1001.' },
        days: { type: 'integer', minimum: 1, maximum: 3, default: 3, description: 'How many calendar days to return (1-3), counted from the first forecast date (today, local time). Default 3.' },
      },
      required: ['adm4'],
      additionalProperties: false,
    },
    annotations: { title: 'Prakiraan cuaca (BMKG)', ...READ_ONLY },
  },
];

async function callTool(name, args) {
  if (name === 'gempa_terbaru') return gempaTerbaru();
  if (name === 'gempa_dirasakan') return quakeListTool(args, 'gempadirasakan.json', 'Gempa dirasakan terbaru menurut BMKG', 'gempadirasakan');
  if (name === 'gempa_m5') return quakeListTool(args, 'gempaterkini.json', 'Gempa M 5.0+ terbaru menurut BMKG', 'gempaterkini');
  if (name === 'prakiraan_cuaca') return prakiraanCuaca(args);
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `${message}\n\nSumber data: BMKG.` }], isError: true };
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!isRequest) return; // notifications need no answer
  try {
    let res;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        res = {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcp-bmkg', title: 'BMKG Gempa & Cuaca', version: VERSION },
          instructions: 'Indonesian earthquake (gempa_terbaru, gempa_dirasakan, gempa_m5) and village weather forecast (prakiraan_cuaca, needs an adm4 code) '
            + 'from BMKG open data. Always credit "Sumber: BMKG" when you show this data to the user, as BMKG requires.',
        };
        break;
      }
      case 'ping': res = {}; break;
      case 'tools/list': res = { tools: TOOLS }; break;
      case 'resources/list': res = { resources: [] }; break;
      case 'resources/templates/list': res = { resourceTemplates: [] }; break;
      case 'prompts/list': res = { prompts: [] }; break;
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name).slice(0, 100)}` } });
          return;
        }
        const args = (params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) ? params.arguments : {};
        try {
          res = await callTool(name, args);
        } catch (e) {
          if (!(e instanceof ToolError)) log('tool failed:', e && e.stack || e);
          res = errorResult(e instanceof ToolError ? e.message : 'Terjadi kesalahan tak terduga. / Unexpected error.');
        }
        break;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method.slice(0, 100)}` } });
        return;
    }
    send({ jsonrpc: '2.0', id, result: res });
  } catch (e) {
    log('request failed:', e && e.stack || e);
    send({ jsonrpc: '2.0', id, error: { code: e.rpcCode || -32603, message: String(e.message || 'Internal error').slice(0, 200) } });
  }
}

function main() {
  log(`v${VERSION} ready; data ${DATA_BASE}; api ${API_BASE}; timeout ${TIMEOUT_MS} ms; cache ${CACHE_MS} ms. ${SOURCE_NOTE}`);
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
      return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      const p = handle(m && typeof m === 'object' ? m : {}).catch(e => log('fatal handler error:', e && e.stack || e));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

main();
