import { join } from "node:path";
import { createLeakyServicePipelineConfig } from "@bug-loop/leaky-service/bug-loop";
import type { PipelineConfig } from "@bug-loop/core";

export function createAgentSdkConfig(baseUrl: string): PipelineConfig {
  return createLeakyServicePipelineConfig({
    cursorPath: join(import.meta.dir, "../.cursor.json"),
    baseUrl,
    fixer: "grok",
  });
}
