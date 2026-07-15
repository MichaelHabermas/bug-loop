import type { Incident, ReproResult, RouteDecision } from "./types";

export type RoutingPolicyDecision =
  | { kind: "authorized"; incidentClass: string; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "unknown"; reason: string };

export interface RoutingPolicyInput {
  incident: Incident;
  repro: ReproResult;
}

export interface RoutingPolicy {
  readonly authorizedClasses: readonly string[];
  evaluate(input: RoutingPolicyInput): RoutingPolicyDecision;
}

export type UnknownRouteResolution =
  | {
      kind: "authorized";
      incidentClass: string;
      reason: string;
      fixBrief?: string;
    }
  | { kind: "needs-human"; reason: string };

export interface UnknownRouteResolverInput extends RoutingPolicyInput {
  authorizedClasses: readonly string[];
}

export interface UnknownRouteResolver {
  resolve(input: UnknownRouteResolverInput): Promise<UnknownRouteResolution>;
}

export interface RouteIncidentInput extends RoutingPolicyInput {
  policy: RoutingPolicy;
  resolver?: UnknownRouteResolver;
}

function authorizedRoute(
  incidentClass: string,
  reason: string,
  repro: ReproResult,
  fixBrief?: string,
): RouteDecision {
  if (!repro.reproduced) {
    return {
      kind: "needs-human",
      reason: `${reason} The incident did not reproduce, so an automatic fix would be speculative.`,
    };
  }
  return {
    kind: "mechanical",
    incidentClass,
    reason,
    ...(fixBrief === undefined ? {} : { fixBrief }),
  };
}

export async function routeIncident(input: RouteIncidentInput): Promise<RouteDecision> {
  const decision = input.policy.evaluate(input);
  switch (decision.kind) {
    case "authorized":
      return authorizedRoute(decision.incidentClass, decision.reason, input.repro);
    case "deny":
      return { kind: "needs-human", reason: decision.reason };
    case "unknown": {
      if (!input.resolver) {
        return {
          kind: "needs-human",
          reason: `${decision.reason} No agent tier is available to map the incident to an authorized class.`,
        };
      }
      const resolution = await input.resolver.resolve({
        incident: input.incident,
        repro: input.repro,
        authorizedClasses: input.policy.authorizedClasses,
      });
      if (resolution.kind === "needs-human") {
        return { kind: "needs-human", reason: resolution.reason };
      }
      if (!input.policy.authorizedClasses.includes(resolution.incidentClass)) {
        return {
          kind: "needs-human",
          reason: `Agent-mapped class ${resolution.incidentClass} is not authorized by the consumer policy.`,
        };
      }
      return authorizedRoute(
        resolution.incidentClass,
        resolution.reason,
        input.repro,
        resolution.fixBrief,
      );
    }
  }
}
