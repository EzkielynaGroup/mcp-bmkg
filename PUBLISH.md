# Publish notes: mcp-bmkg

**GitHub description** (<= 120 chars):
MCP server for Indonesian earthquakes and village weather forecasts from BMKG open data. No API key, zero deps.

**Topics**: mcp, model-context-protocol, mcp-server, bmkg, indonesia, earthquake, gempa, weather-forecast, cuaca, claude, cursor, opencode, open-data

**Homepage**: https://www.npmjs.com/package/mcp-bmkg

**Owner actions before/after publishing**
1. Create `EzkielynaGroup/mcp-bmkg` (public), push `main`.
2. `npm publish` (name `mcp-bmkg` was free on npm on 11 Nov 2026; re-check with `npm view mcp-bmkg` right before publishing).
3. Publish `server.json` to the MCP registry with `mcp-publisher` (namespace `io.github.EzkielynaGroup`).
4. Keep "Sumber: BMKG" in every answer and in any screenshot/demo (BMKG open data terms).
5. Optional: re-record `test/fixtures/` if BMKG changes its JSON shape (fixtures are from 11 Nov 2026).
