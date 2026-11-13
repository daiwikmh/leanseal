type Listener = (text: string | null) => void;

const listeners = new Set<Listener>();

export function subscribeToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function showToast(text: string, ms = 2600): void {
  listeners.forEach((listener) => listener(text));
  setTimeout(() => listeners.forEach((listener) => listener(null)), ms);
}
