// Tiny Upstash (Redis over HTTPS) client.
//
// Every byte sent to Upstash leaves the Render server, so what we SEND matters
// as much as what we fetch. Two rules keep it small:
//   - values that change rarely (season history, player history) use set()
//   - the odds log, which grows all week, is APPENDED to with rpush() — one
//     ~200-byte entry per change — instead of re-uploading the whole list.
//
// If Upstash isn't configured, every call quietly does nothing.

export function createKv({ url, token, fetchImpl = fetch, warn = console.warn }) {
  const enabled = Boolean(url && token);

  async function run(command) {
    if (!enabled) return null;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const data = await res.json();
      return data.result === undefined ? null : data.result;
    } catch (err) {
      warn(`[kv ${command[0]}] failed:`, err.message);
      return null;
    }
  }

  return {
    enabled,
    async get(key) {
      const raw = await run(["GET", key]);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async set(key, value) {
      await run(["SET", key, JSON.stringify(value)]);
    },
    // Append one entry to a list (cheap: sends only the new entry).
    async rpush(key, value) {
      await run(["RPUSH", key, JSON.stringify(value)]);
    },
    // Read a whole list back, parsed.
    async lrange(key) {
      const rows = await run(["LRANGE", key, "0", "-1"]);
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    },
    // Keep only the newest `n` entries.
    async keepLast(key, n) {
      await run(["LTRIM", key, String(-n), "-1"]);
    },
    // Replace a list wholesale (used rarely: one-time migration, weekly cleanup).
    async replaceList(key, values) {
      if (!enabled) return;
      await run(["DEL", key]);
      for (let i = 0; i < values.length; i += 500) {
        await run(["RPUSH", key, ...values.slice(i, i + 500).map((v) => JSON.stringify(v))]);
      }
    },
  };
}
