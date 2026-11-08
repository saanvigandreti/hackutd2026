import { parseSensorEvent, type RoutingConfig } from "./config.ts";

export function routeEvent({ config, event }: {
  config: RoutingConfig;
  event: unknown;
}): string[] {
  const { sensorId, value } = parseSensorEvent(event);
  const rules = Object.hasOwn(config.routesBySensor, sensorId)
    ? config.routesBySensor[sensorId] ?? []
    : [];

  return rules
    .filter((rule) => rule.when === "at-least"
      ? value >= rule.threshold
      : value < rule.threshold)
    .map((rule) => rule.channel);
}
