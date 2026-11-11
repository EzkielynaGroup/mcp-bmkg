# mcp-bmkg

An [MCP](https://modelcontextprotocol.io) server that gives your AI assistant **Indonesian earthquake data and village-level weather forecasts from BMKG open data**. No API key, no account, one file, zero dependencies.

Example: *"Was there a strong earthquake in Indonesia today? And what's the weather in Kemayoran (31.71.03.1001) tomorrow afternoon?"*

> 🇮🇩 Bahasa Indonesia: lihat [bagian di bawah](#bahasa-indonesia).

- Works in Claude Desktop, Claude Code, Cursor, OpenCode and any MCP client that runs local stdio servers.
- Answers in Indonesian, with a JSON block that uses English field names (easy for code and agents).
- Every answer ends with **"Sumber: BMKG"** and the fetch time in WIB, as BMKG's open data terms require.
- 60-second cache and a 10-second timeout per request, so it stays well inside BMKG's limit of 60 requests per minute per IP.

## Tools

| Tool | What it returns | Input |
|---|---|---|
| `gempa_terbaru` | The latest earthquake BMKG published as "Gempabumi Terbaru": time (WIB + UTC), magnitude, depth, coordinates, nearest region, tsunami potential, felt areas (MMI) and the shakemap image link. Usually M 5.0+, but BMKG also uses this feed for smaller quakes that were felt. | none |
| `gempa_dirasakan` | The 15 most recent **felt** earthquakes, with MMI intensity per area. | `limit` (1-15), `min_magnitude` |
| `gempa_m5` | The 15 most recent **M 5.0+** earthquakes, with tsunami potential. | `limit` (1-15), `min_magnitude` |
| `prakiraan_cuaca` | 3-hourly forecast for one kelurahan/desa for up to 3 days: weather (ID + EN), temperature, humidity, wind, cloud cover, visibility. | `adm4` (required, e.g. `31.71.03.1001`), `days` (1-3) |

All tools are read-only and free. Example JSON (shortened) from `gempa_m5`:

```json
{
  "dataset": "gempaterkini",
  "count": 1,
  "earthquakes": [
    { "datetime_utc": "2026-11-10T15:51:37+00:00", "time_local": "22:51:37 WIB", "magnitude": 5.1, "depth_km": 10,
      "latitude": -0.93, "longitude": 128.6, "region": "116 km TimurLaut HALMAHERASELATAN-MALUT", "potential": "Tidak berpotensi tsunami" }
  ],
  "source": "BMKG",
  "fetched_at_wib": "2026-11-11 23:17:52 WIB"
}
```

## Install

Requires **Node.js 18+** (`node -v`). With npx there is nothing else to install: your app runs `npx -y mcp-bmkg`.

**Claude Desktop**: Settings → Developer → Edit Config (`claude_desktop_config.json`), then fully quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "bmkg": {
      "command": "npx",
      "args": ["-y", "mcp-bmkg"]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add bmkg -- npx -y mcp-bmkg
```

Add `--scope user` to make it available in every project. Check with `claude mcp list`.

**Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), same JSON as Claude Desktop.

**OpenCode**: `opencode.json` in the project, or `~/.config/opencode/opencode.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bmkg": {
      "type": "local",
      "command": ["npx", "-y", "mcp-bmkg"],
      "enabled": true
    }
  }
}
```

**Windows**: if the app cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "mcp-bmkg"]`.

**From source**: `git clone https://github.com/EzkielynaGroup/mcp-bmkg.git`, then use `"command": "node"` with `"args": ["/full/path/to/mcp-bmkg.mjs"]`.

## Configuration (optional)

| Variable | Default | Notes |
|---|---|---|
| `MCP_BMKG_TIMEOUT_MS` | `10000` | timeout per request (1000-120000) |
| `MCP_BMKG_CACHE_MS` | `60000` | cache lifetime per URL; `0` disables the cache |
| `MCP_BMKG_BASE_URL` | unset | one base URL for both BMKG hosts, for tests or a mirror. Unset = `https://data.bmkg.go.id` (earthquakes) and `https://api.bmkg.go.id` (forecasts) |

## Finding the `adm4` village code

`prakiraan_cuaca` needs the **Kemendagri level-4 region code** of a kelurahan/desa, written `PP.KK.CC.DDDD` (province, regency/city, district, village). BMKG's forecast page refers to *Keputusan Menteri Dalam Negeri Nomor 100.1.1-6117 Tahun 2022* for these codes and gives the example `31.71.03.1001` = Kelurahan Kemayoran, Jakarta Pusat.

This server does **not** bundle a code lookup: the full list has more than 80,000 villages, and BMKG does not publish a search endpoint for it. Ways to find a code:

1. The Kemendagri decision on region codes (the attachment lists every village with its code).
2. Community datasets on GitHub that republish the Kemendagri list (search "kode wilayah kemendagri"). Check their license and which decision year they follow.
3. Statistics Indonesia (BPS) uses its own codes, which do not always match Kemendagri codes. Do not mix them.

If a code is wrong or BMKG has no forecast for it, the tool says so ("Kode wilayah tidak ditemukan") instead of guessing.

## Data source and terms

All data comes live from **BMKG (Badan Meteorologi, Klimatologi, dan Geofisika)** open data, checked on 11 Nov 2026:

| Data | Endpoint | Updated (per BMKG) |
|---|---|---|
| Latest earthquake | `https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json` | on every event |
| 15 latest M 5.0+ | `https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json` | on every event |
| 15 latest felt | `https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json` | on every event |
| Shakemap image | `https://data.bmkg.go.id/DataMKG/TEWS/<Shakemap>` | per event |
| Village forecast | `https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=<code>` | twice a day, 3-hourly, 3 days |

Terms, from [data.bmkg.go.id](https://data.bmkg.go.id/gempabumi/) and [its forecast page](https://data.bmkg.go.id/prakiraan-cuaca/): users must credit BMKG as the data source and show that credit in their app: *"Wajib untuk mencantumkan BMKG ... sebagai sumber data dan menampilkannya pada aplikasi/sistem Anda."* The access limit is 60 requests per minute per IP. This server therefore ends every answer with "Sumber: BMKG" and caches responses for 60 seconds. If you show results to other people, keep that credit.

This server does not redistribute BMKG data; it fetches it at request time. The recorded responses in `test/fixtures/` (BMKG data, 11 Nov 2026) are used only by the offline tests and are not part of the npm package. This project is independent and is **not affiliated with BMKG**.

Not documented by BMKG: the forecast field `tp`. The server passes it on as `precipitation_mm`, which is our reading of it (unverified).

## Safety and limits

- Read-only. No files are written, no key or account is used.
- `adm4` is validated locally (`00.00.00.0000`) before any request; invalid input never reaches BMKG.
- Timeout per request (default 10 s), responses over 2 MB are rejected, at most 15 quakes and 40 forecast rows per answer.
- Errors come back as short Indonesian + English messages (timeout, rate limit, code not found, BMKG down), never as stack traces.
- Logs go to stderr; stdout carries only MCP messages.
- For emergencies, follow BMKG's own channels and your local authorities. This tool relays BMKG data and adds no warnings of its own.

## FAQ

**Is there a free API for Indonesian earthquake data?**
Yes. BMKG publishes the latest quake, the 15 latest M 5.0+ quakes and the 15 latest felt quakes as free JSON at data.bmkg.go.id, with no key. This server wraps those feeds for AI assistants.

**How do I get BMKG weather forecasts by village in Claude or Cursor?**
Add this server (`npx -y mcp-bmkg`) and ask for the forecast with the village's Kemendagri `adm4` code, for example "prakiraan cuaca 31.71.03.1001 besok".

**Do I need to credit BMKG when I use its data?**
Yes. BMKG's open data pages require users to show BMKG as the data source in their app or system. Every answer from this server includes "Sumber: BMKG".

**How often is BMKG data updated?**
Earthquake feeds update on every event; village forecasts are produced twice a day in 3-hour steps for 3 days. This server caches each URL for 60 seconds.

**Does `gempa_terbaru` only show M 5.0+ earthquakes?**
Not always. It mirrors BMKG's "Gempabumi Terbaru" feed, which can show a smaller quake when it was felt. Use `gempa_m5` for the M 5.0+ list.

## Development

```bash
node --test test/
```

The tests spawn the server over stdio against a local mock of the BMKG endpoints serving recorded fixtures: no internet needed. They cover every tool plus timeouts, rate limits, bad codes, invalid JSON and caching.

---

## Bahasa Indonesia

Server MCP untuk **data gempabumi dan prakiraan cuaca per kelurahan/desa dari data terbuka BMKG**. Tanpa API key, cukup Node.js 18+. Contoh: *"Ada gempa kuat hari ini? Lalu bagaimana cuaca di Kemayoran (31.71.03.1001) besok siang?"*

**Tools**

- `gempa_terbaru`: gempa terbaru versi BMKG (waktu WIB/UTC, magnitudo, kedalaman, koordinat, wilayah, potensi tsunami, wilayah yang merasakan, link peta guncangan). Biasanya M 5.0+, tetapi BMKG juga memakai feed ini untuk gempa lebih kecil yang dirasakan.
- `gempa_dirasakan`: 15 gempa terakhir yang dirasakan, dengan skala MMI. Opsi `limit`, `min_magnitude`.
- `gempa_m5`: 15 gempa terakhir M 5.0+, dengan potensi tsunami. Opsi `limit`, `min_magnitude`.
- `prakiraan_cuaca`: prakiraan per 3 jam hingga 3 hari untuk satu kelurahan/desa. Wajib `adm4`, opsi `days` (1-3).

**Pasang**: tambahkan `npx -y mcp-bmkg` ke aplikasi Anda (contoh konfigurasi Claude Desktop, Claude Code, Cursor, OpenCode ada di atas). Di Windows gunakan `cmd /c npx -y mcp-bmkg` bila `npx` tidak bisa dijalankan langsung.

**Kode adm4**: kode wilayah Kemendagri tingkat IV (kelurahan/desa), format `00.00.00.0000`, contoh `31.71.03.1001` (Kemayoran). BMKG merujuk Kepmendagri Nomor 100.1.1-6117 Tahun 2022. Server ini tidak menyertakan daftar kode (lebih dari 80.000 desa); cari di lampiran keputusan Kemendagri atau dataset komunitas yang menyalinnya (periksa lisensinya). Kode BPS berbeda, jangan dicampur.

**Sumber dan ketentuan**: semua data diambil langsung dari BMKG (data.bmkg.go.id dan api.bmkg.go.id). BMKG mewajibkan pengguna mencantumkan BMKG sebagai sumber data dan menampilkannya di aplikasi, dengan batas akses 60 permintaan per menit per IP. Karena itu setiap jawaban berakhir dengan "Sumber: BMKG" beserta waktu pengambilan (WIB), dan jawaban di-cache 60 detik. Proyek ini independen dan tidak berafiliasi dengan BMKG. Field `tp` pada prakiraan tidak dijelaskan oleh BMKG; kami menampilkannya sebagai `precipitation_mm` (belum terverifikasi).

**Batasan**: hanya membaca data, tidak menyimpan file, tanpa key. Timeout 10 detik, cache 60 detik. Untuk keadaan darurat, ikuti kanal BMKG dan pemerintah daerah setempat.

---

Made by Ezkielyna, an independent AI API gateway for Indonesian developers (QRIS): [ezkielyna.store](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=mcp-bmkg).

## License

MIT for the code. Data belongs to BMKG and is fetched at runtime under BMKG's open data terms (credit "BMKG" as the source).
