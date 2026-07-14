import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type {
  Incident,
  IncidentTriage,
  LogEvent,
  TriageRunConfig,
  TriageState,
  TriageSummary,
} from "@bug-loop/shared";
import {
  dedupeNode,
  detectNode,
  detectWithClassifier,
  ingestNode,
  reproduceNode,
  routeNode,
  routeWithClassifier,
  ticketNode,
} from "./nodes";
import type { Classifier } from "./classifier";

const TriageAnnotation = Annotation.Root({
  logPath: Annotation<string>,
  events: Annotation<LogEvent[]>,
  actionableEvents: Annotation<LogEvent[]>,
  incidents: Annotation<Incident[]>,
  triage: Annotation<IncidentTriage[]>,
  config: Annotation<TriageRunConfig | undefined>,
  summary: Annotation<TriageSummary | undefined>,
  retryCount: Annotation<number>,
  errors: Annotation<string[]>,
});

export interface InitialStateOptions extends TriageRunConfig {
  logPath: string;
}

export function createInitialState(options: InitialStateOptions): TriageState {
  return {
    logPath: options.logPath,
    events: [],
    actionableEvents: [],
    incidents: [],
    triage: [],
    config: {
      cursorPath: options.cursorPath,
      fromStart: options.fromStart,
      baseUrl: options.baseUrl,
    },
    retryCount: 0,
    errors: [],
  };
}

export interface GraphOptions {
  classifier?: Classifier;
}

export function createTriageGraph(options: GraphOptions = {}) {
  const checkpointer = new MemorySaver();
  const classifier = options.classifier;
  const detect = classifier
    ? (state: TriageState) => detectWithClassifier(state, classifier)
    : detectNode;
  const route = classifier
    ? (state: TriageState) => routeWithClassifier(state, classifier)
    : routeNode;
  return new StateGraph(TriageAnnotation)
    .addNode("ingest", ingestNode)
    .addNode("detect", detect)
    .addNode("dedupe", dedupeNode)
    .addNode("reproduce", reproduceNode)
    .addNode("route", route)
    .addNode("ticket", ticketNode)
    .addEdge(START, "ingest")
    .addEdge("ingest", "detect")
    .addEdge("detect", "dedupe")
    .addConditionalEdges(
      "dedupe",
      (state) => (state.incidents.length === 0 ? END : "reproduce"),
      [END, "reproduce"],
    )
    .addEdge("reproduce", "route")
    .addEdge("route", "ticket")
    .addEdge("ticket", END)
    .compile({
      checkpointer,
      // Replace MemorySaver with a durable checkpointer when runs must survive process exit.
    });
}

// Day 3 routing seam:
// "mechanical" -> fix -> verify -> { ticket/PR | fix retry }
// "needs-human" -> END
