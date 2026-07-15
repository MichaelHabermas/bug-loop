import {
  heuristicRegressionTestSpec,
  routeIncident,
  type IncidentTriage,
  type RoutingPolicy,
  type TriageState,
} from "@bug-loop/core";

export async function routeWithPolicy(
  state: TriageState,
  policy: RoutingPolicy,
): Promise<Partial<TriageState>> {
  const triage: IncidentTriage[] = [];
  for (const item of state.triage ?? []) {
    const repro = item.repro ?? {
      reproduced: false,
      command: "",
      evidence: "Reproduction stage did not return a result.",
    };
    const route = await routeIncident({ policy, incident: item.incident, repro });
    triage.push({
      ...item,
      route: {
        ...route,
        regressionTest: route.kind === "needs-human" || !route.regressionTest
          ? heuristicRegressionTestSpec(
              route,
              item.incident,
              repro,
              state.pipelineConfig?.testScope[0] ?? "test",
            )
          : route.regressionTest,
      },
    });
  }
  const mechanical = triage.filter((item) => item.route?.kind === "mechanical").length;
  console.log(`[route] mechanical=${mechanical} needs-human=${triage.length - mechanical}`);
  return { triage };
}

export async function routeNode(
  state: TriageState,
  policy: RoutingPolicy,
): Promise<Partial<TriageState>> {
  return routeWithPolicy(state, policy);
}
