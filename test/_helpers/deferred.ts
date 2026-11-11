export function deferred<T>() {
  let fulfill = (_value: T | PromiseLike<T>): void => {
    throw new Error("Promise executor did not run");
  };
  let fail = (_reason?: unknown): void => {
    throw new Error("Promise executor did not run");
  };
  const promise = new Promise<T>((resolve, reject) => {
    fulfill = resolve;
    fail = reject;
  });
  return { promise, resolve: fulfill, reject: fail };
}
