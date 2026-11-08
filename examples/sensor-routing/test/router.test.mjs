import assert from "node:assert/strict";
import test from "node:test";
import { parseRoutingConfig } from "../src/config.ts";
import { routeEvent } from "../src/router.ts";

test("parses arbitrary sensor keys and fractional thresholds", () => {
  assert.deepEqual(parseRoutingConfig({
    routesBySensor: {
      "cold-room/α": [{ channel: "cooling", when: "at-least", threshold: 4.5 }],
      "": [],
    },
  }), {
    routesBySensor: {
      "cold-room/α": [{ channel: "cooling", when: "at-least", threshold: 4.5 }],
      "": [],
    },
  });
});

test("routes at the inclusive and exclusive threshold boundaries", () => {
  const config = parseRoutingConfig({
    routesBySensor: {
      freezer: [
        { channel: "warm", when: "at-least", threshold: -18 },
        { channel: "cold", when: "below", threshold: -18 },
      ],
    },
  });

  assert.deepEqual(routeEvent({ config, event: { sensorId: "freezer", value: -18 } }), ["warm"]);
  assert.deepEqual(routeEvent({ config, event: { sensorId: "freezer", value: -18.1 } }), ["cold"]);
});

test("returns all matching channels in configuration order", () => {
  const config = parseRoutingConfig({
    routesBySensor: {
      pump: [
        { channel: "archive", when: "at-least", threshold: 0 },
        { channel: "warning", when: "at-least", threshold: 20 },
        { channel: "low", when: "below", threshold: 5 },
      ],
      other: [{ channel: "unrelated", when: "at-least", threshold: 0 }],
    },
  });

  assert.deepEqual(routeEvent({ config, event: { sensorId: "pump", value: 25 } }), ["archive", "warning"]);
  assert.deepEqual(routeEvent({ config, event: { sensorId: "pump", value: -1 } }), ["low"]);
});

test("returns no routes for missing sensors, empty rules, or unmatched values", () => {
  const config = parseRoutingConfig({
    routesBySensor: {
      active: [{ channel: "alarm", when: "at-least", threshold: 10 }],
      idle: [],
    },
  });

  assert.deepEqual(routeEvent({ config, event: { sensorId: "active", value: 10 } }), ["alarm"]);
  for (const sensorId of ["missing", "idle", "toString"]) {
    assert.deepEqual(routeEvent({ config, event: { sensorId, value: 10 } }), []);
  }
  assert.deepEqual(routeEvent({ config, event: { sensorId: "active", value: 9 } }), []);
  assert.deepEqual(routeEvent({ config: parseRoutingConfig({ routesBySensor: {} }), event: { sensorId: "active", value: 10 } }), []);
});

test("routes an explicitly configured object-property name", () => {
  const config = parseRoutingConfig({
    routesBySensor: {
      toString: [{ channel: "diagnostic", when: "below", threshold: 1 }],
    },
  });

  assert.deepEqual(routeEvent({ config, event: { sensorId: "toString", value: 0 } }), ["diagnostic"]);
});

test("rejects invalid configuration shapes and route values", () => {
  for (const input of [null, {}, { routesBySensor: [] }, { routesBySensor: {}, extra: true }]) {
    assert.throws(() => parseRoutingConfig(input));
  }
  for (const rule of [
    { channel: "", when: "at-least", threshold: 1 },
    { channel: "alarm", when: "equal", threshold: 1 },
    { channel: "alarm", when: "below", threshold: "1" },
    { channel: "alarm", when: "below", threshold: Infinity },
    { channel: "alarm", when: "below", threshold: NaN },
    { channel: "alarm", when: "below" },
    { channel: "alarm", when: "below", threshold: 1, extra: true },
  ]) {
    assert.throws(() => parseRoutingConfig({ routesBySensor: { sensor: [rule] } }));
  }
  assert.throws(() => parseRoutingConfig({ routesBySensor: { sensor: { channel: "alarm" } } }));
});

test("rejects invalid events before routing", () => {
  const config = parseRoutingConfig({ routesBySensor: {} });
  for (const event of [
    null,
    { sensorId: "sensor" },
    { sensorId: 12, value: 1 },
    { sensorId: "sensor", value: "1" },
    { sensorId: "sensor", value: Infinity },
    { sensorId: "sensor", value: NaN },
    { sensorId: "sensor", value: 1, extra: true },
  ]) {
    assert.throws(() => routeEvent({ config, event }));
  }
});
