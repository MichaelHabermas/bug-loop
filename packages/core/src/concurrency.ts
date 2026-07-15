export async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  worker: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = new Array(inputs.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        const input = inputs[index];
        if (input === undefined) continue;
        results[index] = await worker(input, index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
