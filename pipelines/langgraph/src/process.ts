export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runProcess(
  command: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<ProcessResult> {
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? Bun.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function requireSuccess(command: string[], result: ProcessResult): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${command.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
  );
}
