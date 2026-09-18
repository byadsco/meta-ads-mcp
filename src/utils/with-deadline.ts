export interface DeadlineResult<T> {
  settled: boolean;
  value?: T;
}

/**
 * Waits for a promise up to `ms`, then gives up waiting without cancelling
 * it. The promise keeps running and may settle later; the caller gets
 * `settled: false` and moves on. The timer is unref'd so it never keeps the
 * process alive on its own.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ settled: false });
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ settled: false });
      },
    );
  });
}
