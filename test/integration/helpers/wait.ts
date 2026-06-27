/**
 * Poll `read()` until `predicate(value)` is true or `timeoutMs` elapses, then
 * return the last value read (whether or not it satisfied the predicate). Lets
 * callers assert on the final observed value so a genuine failure surfaces the
 * real data rather than a timeout. Shared by the real-tmux integration tests,
 * whose assertions race async tmux/kernel state (SIGWINCH delivery, window
 * rename propagation) that only settles after a few poll cycles under CI load.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
  pollMs = 50,
): Promise<T> {
  const start = Date.now();
  /* eslint-disable no-await-in-loop -- polling */
  let value = await read();
  while (!predicate(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    value = await read();
  }
  /* eslint-enable no-await-in-loop */
  return value;
}
