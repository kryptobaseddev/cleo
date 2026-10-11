// T13539: replies, then keeps a ref'd handle open forever.
process.once('message', () => {
  process.send?.({ ok: true, summary: { mode: 'incremental', reason: 'posted, then held open' } });
  setInterval(() => {}, 1_000);
});
