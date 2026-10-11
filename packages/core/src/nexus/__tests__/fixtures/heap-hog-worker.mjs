// T13537: a "refresh" that grows its heap until its worker limit ends it.
const keep = [];
for (;;) keep.push(new Array(1e5).fill(keep.length));
