import { readNewEvents, type TriageState } from "@bug-loop/shared";
import { readCursor } from "../cursor";
import { EMPTY_SUMMARY } from "../state";

export async function ingestNode(state: TriageState): Promise<Partial<TriageState>> {
  const config = state.config;
  if (!config) throw new Error("ingest requires state.config");
  const cursor = config.fromStart ? { offset: 0 } : await readCursor(config.cursorPath);
  const result = await readNewEvents(state.logPath, cursor);
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
