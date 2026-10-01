// A minimal observable store. Shaped like zustand's StoreApi, so `useStore(session.store, selector)` works
// in React, and it's trivial to adapt to Vue, Svelte, Solid or plain JS via `subscribe`.

export type Listener<T> = (state: T, previous: T) => void;

export interface Store<T> {
  getState(): T;
  getInitialState(): T;
  setState(partial: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: Listener<T>): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();

  return {
    getState: () => state,
    getInitialState: () => initial,
    setState(partial) {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
