export function createBusyServices() {
  let busy: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => busy,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setBusy(names: readonly string[], active: boolean) {
      if (names.length === 0) {
        return;
      }
      const next = new Set(busy);
      for (const name of names) {
        if (active) {
          next.add(name);
        } else {
          next.delete(name);
        }
      }
      busy = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

export type BusyServices = ReturnType<typeof createBusyServices>;
