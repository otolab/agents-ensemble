async function waitForCompletion<T>(signal: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function waitForSignal<T>(signal: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  return waitForCompletion(signal, timeoutMs, `${label} did not complete`);
}

export async function waitForNotification(signal: Promise<void>, label: string, timeoutMs: number): Promise<void> {
  await waitForCompletion(signal, timeoutMs, `${label} did not arrive`);
}
