// T13539: posts a result, then keeps a ref'd handle open forever.
import { parentPort } from 'node:worker_threads';
parentPort?.postMessage({ mode: 'incremental', reason: 'posted, then held open' });
setInterval(() => {}, 1_000);
