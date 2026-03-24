import { performance } from "node:perf_hooks";

function makeLedger(entries) {
  const list = [];
  for (let i = 0; i < entries; i += 1) {
    list.push({
      entryId: `entry_${i}`,
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      operation: i % 5 === 0 ? "orders.update" : "orders.read",
      contextDelta: {
        orderId: `ord_${Math.floor(i / 10)}`,
        version: i,
        changedFields: i % 5 === 0 ? ["status", "updatedAt"] : ["lastViewedAt"],
      },
      requestId: `req_${i}`,
    });
  }
  return {
    ledgerId: "ledger_1",
    version: entries,
    entries: list,
  };
}

function retrieveFull(ledger) {
  return ledger.entries;
}

function retrieveSummary(ledger) {
  return {
    ledgerId: ledger.ledgerId,
    version: ledger.version,
    totalEntries: ledger.entries.length,
    mutationCount: ledger.entries.filter((entry) => entry.operation.endsWith(".update")).length,
  };
}

function retrieveDelta(ledger, fromVersion) {
  return ledger.entries.filter((entry) => entry.contextDelta.version > fromVersion);
}

function time(name, fn, iterations = 100) {
  const start = performance.now();
  let last;
  for (let i = 0; i < iterations; i += 1) {
    last = fn();
  }
  const ms = performance.now() - start;
  return {
    name,
    iterations,
    totalMs: Number(ms.toFixed(3)),
    avgMs: Number((ms / iterations).toFixed(4)),
    sampleSize: Array.isArray(last) ? last.length : 1,
  };
}

const ledger = makeLedger(5000);

const results = [
  time("full", () => retrieveFull(ledger)),
  time("summary", () => retrieveSummary(ledger)),
  time("delta(last-500)", () => retrieveDelta(ledger, 4500)),
  time("delta(last-50)", () => retrieveDelta(ledger, 4950)),
];

console.log(JSON.stringify({ entries: ledger.entries.length, results }, null, 2));
