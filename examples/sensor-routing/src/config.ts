import { z } from "zod";

const routeSchema = z.object({
  channel: z.string().min(1),
  when: z.enum(["at-least", "below"]),
  threshold: z.number().finite(),
}).strict();

const routingConfigSchema = z.object({
  routesBySensor: z.record(z.array(routeSchema)),
}).strict();

const sensorEventSchema = z.object({
  sensorId: z.string(),
  value: z.number().finite(),
}).strict();

export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export function parseRoutingConfig(input: unknown): RoutingConfig {
  return routingConfigSchema.parse(input);
}

export function parseSensorEvent(input: unknown) {
  return sensorEventSchema.parse(input);
}
