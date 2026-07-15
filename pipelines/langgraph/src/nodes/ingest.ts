import { readCursor, readNewEvents, type TriageState } from "@bug-loop/core";
import { EMPTY_SUMMARY } from "../state";

export async function ingestNode(state: TriageState): Promise<Partial<TriageState>> {
  const config = state.config;
  const pipelineConfig = state.pipelineConfig;
  if (!config || !pipelineConfig) throw new Error("ingest requires pipeline and run config");
  const cursor = config.fromStart ? { offset: 0 } : await readCursor(pipelineConfig.cursorPath);
  // Cap at commitCursorOffset (watch batch end) so read boundary == commit boundary.
  const result = await readNewEvents(
    state.logPath,
    cursor,
    config.commitCursorOffset === undefined
      ? undefined
      : { endOffset: config.commitCursorOffset },
  );
  console.log(`[ingest] events=${result.events.length}`);
  return {
    events: result.events,
    actionableEvents: [],
    incidents: [],
    triage: [],
    config: { ...config, nextCursorOffset: result.cursor.offset },
    summary: { ...EMPTY_SUMMARY, eventsRead: result.events.length },
  };
}
