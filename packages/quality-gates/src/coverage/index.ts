import { matchPath, type ScenarioDefinition, type SanitizedObservedTrace } from '@migration-harness/core';

export interface CoverageReport {
  routesCovered: number;
  mutationsCovered: number;
  controlsCovered: number;
  scenariosCovered: number;
  knownErrorScenarios: number;
  isPolicySatisfied: boolean;
}
export function measureCoverage(expected: { routes: string[]; mutations: Array<{ method: string; pathTemplate: string }>; scenarios: ScenarioDefinition[] }, traces: SanitizedObservedTrace[]): CoverageReport {
  const events = traces.flatMap(trace => trace.events);
  const percentage = (total: number, observed: number): number => total === 0 ? 100 : 100 * observed / total;
  const routesCovered = percentage(expected.routes.length, expected.routes.filter(route => events.some(event => event.type === 'NAVIGATION' && matchPath(route, new URL(event.toUrl).pathname) !== undefined)).length);
  const mutationsCovered = percentage(expected.mutations.length, expected.mutations.filter(mutation => events.some(event => event.type === 'HTTP_REQUEST' && event.method === mutation.method && matchPath(mutation.pathTemplate, new URL(event.url).pathname) !== undefined)).length);
  const controls = expected.scenarios.flatMap(scenario => scenario.steps.map(step => ({ scenarioId: scenario.scenarioId, step })));
  const controlsCovered = percentage(controls.length, controls.filter(({ scenarioId, step }) => traces.some(trace => trace.scenarioId === scenarioId && trace.events.some(event => event.type === 'USER_INTERACTION' && event.stepId === step.stepId && event.action === step.action))).length);
  const complete = expected.scenarios.filter(scenario => traces.some(trace => trace.scenarioId === scenario.scenarioId && trace.completion?.status === 'COMPLETED' && scenario.steps.every(step => trace.completion!.completedStepIds.includes(step.stepId))));
  const scenariosCovered = percentage(expected.scenarios.length, complete.length);
  return { routesCovered, mutationsCovered, controlsCovered, scenariosCovered, knownErrorScenarios: complete.filter(scenario => scenario.testDataProfile === 'error_flow').length,
    isPolicySatisfied: expected.scenarios.length > 0 && [routesCovered, mutationsCovered, controlsCovered, scenariosCovered].every(percent => percent === 100),
  };
}
