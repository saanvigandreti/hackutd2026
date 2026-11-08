// A real Ketchup run with NVIDIA Nemotron on the GPU health alerts example, exported from its run log.
const run = {
 "events": [
  {
   "t": 0.0,
   "kind": "plan",
   "title": "Plan",
   "detail": "Nemotron will 1) inspect the findings, 2) read the code, 3) draft edits that Ketchup checks, keeping only edits that pass, and 4) review the behavior…"
  },
  {
   "t": 1.6,
   "kind": "plan",
   "title": "Nemotron asked what the upgrade broke",
   "detail": "Need to keep every GPU health alert able to fire for on-call after upgrade, with same configured limits converted to the units 4.9.0 reports. We need…"
  },
  {
   "t": 1.6,
   "kind": "tool",
   "title": "Ketchup sent 11 compiler errors and 34 API changes",
   "detail": "The errors are in 1 affected file."
  },
  {
   "t": 3.1,
   "kind": "plan",
   "title": "Nemotron asked to read 3 files",
   "detail": "Let me read the source files to understand the current state and what needs to change."
  },
  {
   "t": 3.1,
   "kind": "tool",
   "title": "Nemotron read src/gpu-alerts.ts",
   "detail": "29 lines"
  },
  {
   "t": 3.1,
   "kind": "tool",
   "title": "Nemotron read the 4.8.4 API declarations (index.d.ts)",
   "detail": "127 lines"
  },
  {
   "t": 3.1,
   "kind": "tool",
   "title": "Nemotron read the 4.9.0 API declarations (index.d.ts)",
   "detail": "126 lines"
  },
  {
   "t": 39.2,
   "kind": "plan",
   "title": "Nemotron drafted edits for Ketchup to check",
   "detail": "Update each defineRule call: GpuTemperatureHigh: metric name DCGM_FI_DEV_GPU_TEMP → DCGM_FI_DEV_GPU_TEMP_CELSIUS GpuMemoryTemperatureHigh: metric…"
  },
  {
   "t": 40.0,
   "kind": "check",
   "title": "Ketchup's checks failed",
   "detail": "Fixed 11 upgrade errors. 1 error left, first: '}' expected. Failed: Repair compiles, Threshold units match."
  },
  {
   "t": 48.8,
   "kind": "plan",
   "title": "Nemotron asked to read 1 file",
   "detail": "Let me just read the file again and create a clean patch."
  },
  {
   "t": 48.8,
   "kind": "tool",
   "title": "Nemotron read src/gpu-alerts.ts",
   "detail": "29 lines"
  },
  {
   "t": 66.1,
   "kind": "plan",
   "title": "Nemotron drafted edits for Ketchup to check",
   "detail": "Let me try again, being very careful with the exact content."
  },
  {
   "t": 66.1,
   "kind": "tool",
   "title": "Ketchup rejected Nemotron's request",
   "detail": "Tool arguments do not match the declared schema: edits: Expected array, received string. edits arrived as a string starting \"[{\\\"path\\\"…"
  },
  {
   "t": 80.5,
   "kind": "plan",
   "title": "Nemotron drafted edits for Ketchup to check",
   "detail": "I need to send the edits as a proper JSON array. Let me format it correctly."
  },
  {
   "t": 81.2,
   "kind": "check",
   "title": "Ketchup's checks failed",
   "detail": "Fixed 11 upgrade errors. No errors left. Failed: Threshold units match."
  },
  {
   "t": 106.7,
   "kind": "plan",
   "title": "Nemotron drafted edits for Ketchup to check",
   "detail": "The fix should be ratio(limits.idleUtilizationPercent / 100). Let me update the edit."
  },
  {
   "t": 107.5,
   "kind": "check",
   "title": "Ketchup's checks passed",
   "detail": "Fixed 11 upgrade errors. No errors left."
  },
  {
   "t": 126.5,
   "kind": "plan",
   "title": "Nemotron submitted its edits",
   "detail": "I need to submit the patch with summary and rationale."
  },
  {
   "t": 127.3,
   "kind": "review",
   "title": "Behavior review started",
   "detail": "A second, read-only Nemotron pass compares the original and repaired code for lost behavior, such as a dropped registration or a changed unit."
  },
  {
   "t": 129.5,
   "kind": "plan",
   "title": "Reviewer asked to read 4 files",
   "detail": "The JSON describes: Original version: 4.8.4 New version: 4.9.0 The patch changes metric names, units, and helper functions Let me read the source…"
  },
  {
   "t": 129.5,
   "kind": "review",
   "title": "Reviewer read src/gpu-alerts.ts",
   "detail": "29 lines"
  },
  {
   "t": 129.5,
   "kind": "review",
   "title": "Reviewer read the repaired src/gpu-alerts.ts",
   "detail": "29 lines"
  },
  {
   "t": 129.5,
   "kind": "review",
   "title": "Reviewer read the 4.8.4 API declarations (index.d.ts)",
   "detail": "127 lines"
  },
  {
   "t": 129.5,
   "kind": "review",
   "title": "Reviewer read the 4.9.0 API declarations (index.d.ts)",
   "detail": "126 lines"
  },
  {
   "t": 158.3,
   "kind": "plan",
   "title": "Reviewer submitted its verdict",
   "detail": "Let me do that now with the risks list being empty since I found no behavioral differences."
  },
  {
   "t": 158.3,
   "kind": "review",
   "title": "Behavior review found no risks",
   "detail": "The patch correctly migrates all 8 GPU health alert rules from dcgm-exporter 4.8.4 to 4.9.0, with proper metric name updates, unit conversions, and…"
  },
  {
   "t": 158.3,
   "kind": "complete",
   "title": "Draft ready for review",
   "detail": "Ketchup accepted Nemotron's edits: they passed every check. Your original files are unchanged."
  }
 ],
 "diff": [
  [
   "import { celsius, defineRule, mebibytes, megahertz, percent, watts, type Duration } from 'dcgm-exporter';",
   "import { celsius, defineRule, bytes, hertz, ratio, watts, type Duration } from 'dcgm-exporter';"
  ],
  [
   "defineRule({ name: 'GpuIdle', metric: 'DCGM_FI_DEV_GPU_UTIL', below: percent(limits.idleUtilizationPercent), for: limits.sustainedFor, severity: 'warning', summary: 'GPU utilization is below the idle floor' }),",
   "defineRule({ name: 'GpuIdle', metric: 'DCGM_FI_DEV_GPU_UTIL_RATIO', below: ratio(limits.idleUtilizationPercent / 100), for: limits.sustainedFor, severity: 'warning', summary: 'GPU utilization is below the idle floor' }),"
  ],
  [
   "defineRule({ name: 'GpuFramebufferHigh', metric: 'DCGM_FI_DEV_FB_USED', above: mebibytes(limits.framebufferUsedMiB), for: limits.sustainedFor, severity: 'warning', summary: 'GPU framebuffer use is above the fleet limit' }),",
   "defineRule({ name: 'GpuFramebufferHigh', metric: 'DCGM_FI_DEV_FB_USED_BYTES', above: bytes(limits.framebufferUsedMiB * 1024 * 1024), for: limits.sustainedFor, severity: 'warning', summary: 'GPU framebuffer use is above the fleet limit' }),"
  ],
  [
   "defineRule({ name: 'GpuSmClockLow', metric: 'DCGM_FI_DEV_SM_CLOCK', below: megahertz(limits.smClockFloorHz / 1_000_000), for: limits.sustainedFor, severity: 'warning', summary: 'GPU SM clock is below the fleet floor' }),",
   "defineRule({ name: 'GpuSmClockLow', metric: 'DCGM_FI_DEV_SM_CLOCK_HERTZ', below: hertz(limits.smClockFloorHz), for: limits.sustainedFor, severity: 'warning', summary: 'GPU SM clock is below the fleet floor' }),"
  ]
 ],
 "seconds": 158
};
