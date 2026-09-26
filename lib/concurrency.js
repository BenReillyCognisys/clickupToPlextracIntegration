// A cap on how many of something run at once; the rest wait their turn in order.
//
//   const renders = limiter(4);
//   await renders(() => renderPdf(...));   // at most 4 renderPdf calls in flight
//
// Queued work is never dropped, and one task failing doesn't affect the others.
function limiter(max) {
  const limit = Math.max(1, Number(max) || 1);
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

module.exports = { limiter };
