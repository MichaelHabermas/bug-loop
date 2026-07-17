export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Kill the process and return exit code 124 after this many ms (guards hung worker CLIs). */
  timeoutMs?: number;
}

export type ProcessRunner = (
  command: string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = async (command, options) => {
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? Bun.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        process.kill(9);
      }, options.timeoutMs)
    : undefined;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (timedOut) {
      const note = `process timed out after ${options.timeoutMs}ms and was killed`;
      return { exitCode: 124, stdout, stderr: stderr ? `${stderr}\n${note}` : note };
    }
    return { exitCode, stdout, stderr };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export function requireSuccess(command: string[], result: ProcessResult): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${command.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
  );
}
