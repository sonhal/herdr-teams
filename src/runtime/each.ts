/** Runs step for every item, then reports all failures together. */
export async function each<T>(
  items: Iterable<[string, T]>,
  step: (name: string, item: T) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  for (const [name, item] of items) {
    try {
      await step(name, item);
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
