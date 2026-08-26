# AquaGuard

AquaGuard is an operator-facing prototype for an ESP32 water distribution and leak-isolation system. It is intentionally an operations instrument: the operator sees the hydraulic topology, phase, source reserve, valve states, response timing, and an append-only event trail before issuing a command.

## Run locally

```bash
pnpm install
pnpm --filter @workspace/aquaguard dev
```

The frontend expects the workspace runtime to provide `PORT` and `BASE_PATH`. Copy `.env.example` to `.env` and fill the Firebase values only when a Realtime Database is available. If the Firebase variables are missing, the UI stays in an explicit **NO LINK** state and does not fabricate hardware telemetry. Use **Run in Demo Mode** to opt into the simulated source. Demo state is persisted in local storage, and can be exited or replayed from any view.

## Realtime Database schema

The ESP32 writes this exact shape at the database root. Timestamps are Unix milliseconds. AquaGuard reads telemetry from these paths and writes operator commands only under `/commands`.

```json
{
  "system": { "phase": "NORMAL", "pump_on": true, "last_updated": 1710000000000 },
  "tanks": {
    "A": { "level_cm": 118, "level_pct": 74, "is_critical": false },
    "B": { "level_cm": 93, "level_pct": 58, "is_critical": false },
    "C": { "level_cm": 67, "level_pct": 42, "is_critical": false }
  },
  "source": { "level_pct": 88, "critical": false },
  "valves": { "SV1": "OPEN", "SV2": "OPEN", "SV3": "OPEN", "bypass_manual": "CLOSED" },
  "flow": {
    "main_header_lpm": 27.3,
    "branch_A_lpm": 12.8,
    "branch_B_inferred_lpm": 8.4,
    "branch_C_inferred_lpm": 6.1
  },
  "alerts": { "leak_detected": false, "bucket_leak_sensor": false, "source_critical": false },
  "commands": { "bypass_confirm": false, "estop_triggered": false, "priority_tank": "A" },
  "events": {
    "-push-id": { "timestamp": 1710000000000, "type": "system", "message": "System armed" }
  }
}
```

`system.phase` is one of `NORMAL`, `FAULT_DETECTED`, `ISOLATED`, `BYPASS_ACTIVE`, or `CRITICAL_RESERVE`. The ESP32 owns this state machine; the dashboard never writes it. In `BYPASS_ACTIVE`, the active fault branch valve should be `CLOSED` while the bypass route carries positive flow to that branch.

Operator writes:

- `/commands/bypass_confirm = true` after the operator confirms the bypass is open.
- `/commands/estop_triggered = true` or `false` for Emergency Stop and Resume.
- `/commands/priority_tank = "A" | "B" | "C"` for allocation priority.
- `/commands/manual_valve_override/SV1|SV2|SV3 = "OPEN" | "CLOSED"` for commissioning overrides.

## Demo sequence

Replay runs `NORMAL → FAULT_DETECTED → ISOLATED → BYPASS_ACTIVE → CRITICAL_RESERVE`. The controls also expose independent branch A/B leak simulation and a source-critical simulation. Emergency Stop closes every valve and sets flow to zero; Resume is intentionally disabled until the stop is latched.