// Run with:  node server/kv.test.mjs
import assert from "node:assert/strict";
import { createKv } from "./kv.js";

let pass = 0, fail = 0;
const test = async (name, fn) => { try { await fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };

// A fake Upstash that remembers lists/values and records every command + its size.
const fakeUpstash = () => {
  const store = {}; const sent = [];
  const fetchImpl = async (url, opts) => {
    const cmd = JSON.parse(opts.body); sent.push({ cmd, bytes: opts.body.length });
    const [op, key, ...rest] = cmd; let result = null;
    if (op === "GET") result = store[key] ?? null;
    else if (op === "SET") { store[key] = rest[0]; result = "OK"; }
    else if (op === "RPUSH") { store[key] = [...(store[key] || []), ...rest]; result = store[key].length; }
    else if (op === "LRANGE") result = store[key] || [];
    else if (op === "LTRIM") { const n = Math.abs(Number(rest[0])); store[key] = (store[key] || []).slice(-n); result = "OK"; }
    else if (op === "DEL") { delete store[key]; result = 1; }
    return { json: async () => ({ result }) };
  };
  return { fetchImpl, store, sent };
};

await test("disabled (no credentials): every call is a harmless no-op", async () => {
  const kv = createKv({ url: "", token: "" });
  assert.equal(kv.enabled, false);
  assert.equal(await kv.get("x"), null);
  await kv.set("x", 1); await kv.rpush("l", 1);
  assert.deepEqual(await kv.lrange("l"), []);
});
await test("set/get round-trips JSON", async () => {
  const f = fakeUpstash(); const kv = createKv({ url: "u", token: "t", fetchImpl: f.fetchImpl });
  await kv.set("k", { a: [1, 2] });
  assert.deepEqual(await kv.get("k"), { a: [1, 2] });
});
await test("APPENDING sends only the new entry, however long the list is", async () => {
  const f = fakeUpstash(); const kv = createKv({ url: "u", token: "t", fetchImpl: f.fetchImpl });
  const snap = (i) => ({ time: i, week: 4, matchups: Array.from({ length: 5 }, (_, k) => ({ id: `m${k}`, winProbA: 50 + (i % 40) })) });
  for (let i = 0; i < 1000; i++) await kv.rpush("oddsLog", snap(i));
  const sizes = f.sent.map((s) => s.bytes);
  assert.ok(Math.max(...sizes) < 400, `largest append was ${Math.max(...sizes)} bytes`);
  assert.equal((await kv.lrange("oddsLog")).length, 1000);
});
await test("the OLD way (re-uploading the whole list) is far bigger — the reason for this change", async () => {
  const f = fakeUpstash(); const kv = createKv({ url: "u", token: "t", fetchImpl: f.fetchImpl });
  const all = Array.from({ length: 1000 }, (_, i) => ({ time: i, week: 4, matchups: Array.from({ length: 5 }, (_, k) => ({ id: `m${k}`, winProbA: 50 })) }));
  await kv.set("oddsSnapshots", all);
  assert.ok(f.sent[0].bytes > 100000, "re-uploading 1000 entries costs >100KB per write");
});
await test("lrange returns entries in order, parsed", async () => {
  const f = fakeUpstash(); const kv = createKv({ url: "u", token: "t", fetchImpl: f.fetchImpl });
  await kv.rpush("l", { n: 1 }); await kv.rpush("l", { n: 2 });
  assert.deepEqual(await kv.lrange("l"), [{ n: 1 }, { n: 2 }]);
});
await test("keepLast trims to the newest entries", async () => {
  const f = fakeUpstash(); const kv = createKv({ url: "u", token: "t", fetchImpl: f.fetchImpl });
  for (let i = 1; i <= 10; i++) await kv.rpush("l", { n: i });
  await kv.keepLast("l", 3);
  assert.deepEqual((await kv.lrange("l")).map((x) => x.n), [8, 9, 10]);
});
await test("replaceList swaps a list wholesale, in chunks", async () => {
  const f = fakeUpstash(); const kv = createKv({ url: "u", token: "t", fetchImpl: f.fetchImpl });
  await kv.rpush("l", { old: true });
  await kv.replaceList("l", Array.from({ length: 1200 }, (_, i) => ({ n: i })));
  const out = await kv.lrange("l");
  assert.equal(out.length, 1200); assert.equal(out[0].n, 0); assert.equal(out[1199].n, 1199);
  assert.ok(f.sent.filter((s) => s.cmd[0] === "RPUSH").length >= 3, "should chunk large replacements");
});
await test("a network failure never throws — it just returns nothing", async () => {
  const warnings = [];
  const kv = createKv({ url: "u", token: "t", fetchImpl: async () => { throw new Error("offline"); }, warn: (m) => warnings.push(m) });
  assert.equal(await kv.get("x"), null);
  await kv.rpush("l", 1);
  assert.deepEqual(await kv.lrange("l"), []);
  assert.ok(warnings.length >= 3);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
