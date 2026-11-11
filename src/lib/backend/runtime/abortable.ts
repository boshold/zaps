export async function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  message: string | Error,
): Promise<T> {
  let cancel: (() => void) | undefined = undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(typeof message === "string" ? new Error(message) : message);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (cancel) {
      signal.removeEventListener("abort", cancel);
    }
  }
}
