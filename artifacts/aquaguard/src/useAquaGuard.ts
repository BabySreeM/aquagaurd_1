import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getDatabase,
  onChildAdded,
  onValue,
  ref,
  set,
  type Database,
} from 'firebase/database';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type Phase =
  | 'NORMAL'
  | 'FAULT_DETECTED'
  | 'ISOLATED'
  | 'BYPASS_ACTIVE'
  | 'CRITICAL_RESERVE'
  | 'HALTED';
export type ValveState = 'OPEN' | 'CLOSED' | 'NO_SIGNAL';
export type TankId = 'A' | 'B' | 'C';
export type EventKind = 'alert' | 'command' | 'system';
export type AlertValue = boolean | null;

export interface Tank {
  id: TankId;
  name: string;
  level: number;
  valve: ValveState;
  priority: boolean;
  flow: number;
  trend: number[];
}

export interface AquaEvent {
  id: string;
  time: string;
  kind: EventKind;
  title: string;
  detail: string;
}

export interface AquaData {
  phase: Phase;
  faultBranch: TankId;
  tanks: Tank[];
  source: { level: number; flow: number; valve: ValveState; critical: AlertValue };
  headerFlow: number;
  bypassFlow: number;
  waterSaved: number;
  lastUpdated: number;
  startedAt: number;
  phaseStartedAt: number;
  events: AquaEvent[];
  priorityTank: TankId;
  emergencyStopped: boolean;
  alerts: {
    leakDetected: AlertValue;
    bucketLeakSensor: AlertValue;
    sourceCritical: AlertValue;
  };
}

interface RemoteEvent {
  timestamp?: number;
  type?: string;
  message?: string;
}

interface RemoteSchema {
  system?: {
    phase?: Phase;
    pump_on?: boolean;
    last_updated?: number;
  };
  tanks?: Record<TankId, { level_cm?: number; level_pct?: number; is_critical?: boolean }>;
  source?: { level_pct?: number; critical?: boolean };
  valves?: { SV1?: ValveState; SV2?: ValveState; SV3?: ValveState; bypass_manual?: ValveState };
  flow?: {
    main_header_lpm?: number;
    branch_A_lpm?: number;
    branch_B_inferred_lpm?: number;
    branch_C_inferred_lpm?: number;
  };
  alerts?: {
    leak_detected?: boolean;
    bucket_leak_sensor?: boolean;
    source_critical?: boolean;
  };
  commands?: { estop_triggered?: boolean; priority_tank?: TankId };
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const hasFirebaseConfig = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.databaseURL &&
    firebaseConfig.projectId,
);

const tankSeeds: Tank[] = [
  { id: 'A', name: 'North reserve', level: 74, valve: 'OPEN', priority: true, flow: 12.8, trend: [59, 62, 61, 66, 68, 70, 74] },
  { id: 'B', name: 'Process line', level: 58, valve: 'OPEN', priority: false, flow: 8.4, trend: [65, 64, 63, 62, 60, 59, 58] },
  { id: 'C', name: 'South reserve', level: 42, valve: 'OPEN', priority: false, flow: 6.1, trend: [49, 49, 47, 46, 45, 44, 42] },
];

const initialEvents: AquaEvent[] = [
  { id: 'seed-1', time: '09:42:18', kind: 'system', title: 'System armed', detail: 'ESP32 gateway joined operator session' },
  { id: 'seed-2', time: '09:41:54', kind: 'command', title: 'Priority set to Tank A', detail: 'Operator allocation policy updated' },
  { id: 'seed-3', time: '09:40:21', kind: 'system', title: 'Telemetry heartbeat', detail: 'All sensors reporting within threshold' },
  { id: 'seed-4', time: '09:37:06', kind: 'command', title: 'Automated logic enabled', detail: 'Manual overrides released' },
];

function makeSeed(): AquaData {
  const now = Date.now();
  return {
    phase: 'NORMAL',
    faultBranch: 'A',
    tanks: tankSeeds.map((tank) => ({ ...tank, trend: [...tank.trend] })),
    source: { level: 88, flow: 27.3, valve: 'OPEN', critical: false },
    headerFlow: 27.3,
    bypassFlow: 0,
    waterSaved: 1240,
    lastUpdated: now,
    startedAt: now - 1000 * 60 * 14,
    phaseStartedAt: now - 1000 * 60 * 2,
    events: initialEvents,
    priorityTank: 'A',
    emergencyStopped: false,
    alerts: { leakDetected: false, bucketLeakSensor: false, sourceCritical: false },
  };
}

function makeUnavailable(): AquaData {
  const now = Date.now();
  return {
    phase: 'NORMAL',
    faultBranch: 'A',
    tanks: tankSeeds.map((tank) => ({
      ...tank,
      level: 0,
      flow: 0,
      valve: 'NO_SIGNAL',
      priority: tank.id === 'A',
      trend: [0, 0, 0, 0, 0, 0, 0],
    })),
    source: { level: 0, flow: 0, valve: 'NO_SIGNAL', critical: null },
    headerFlow: 0,
    bypassFlow: 0,
    waterSaved: 0,
    lastUpdated: 0,
    startedAt: now,
    phaseStartedAt: now,
    events: [],
    priorityTank: 'A',
    emergencyStopped: false,
    alerts: { leakDetected: null, bucketLeakSensor: null, sourceCritical: null },
  };
}

function toEventKind(value: string | undefined): EventKind {
  return value === 'alert' || value === 'command' ? value : 'system';
}

function toValve(value: unknown): ValveState {
  return value === 'OPEN' || value === 'CLOSED' ? value : 'NO_SIGNAL';
}

function normalizeRemoteEvent(id: string, value: RemoteEvent): AquaEvent {
  const timestamp = Number(value.timestamp ?? Date.now());
  return {
    id,
    time: new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    kind: toEventKind(value.type),
    title: value.type ? value.type.replaceAll('_', ' ') : 'Telemetry event',
    detail: value.message ?? '',
  };
}

function getFirebaseDatabase(): Database {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getDatabase(app);
}

export function useAquaGuard() {
  const [data, setData] = useState<AquaData>(() => {
    try {
      const saved = localStorage.getItem('aquaguard-demo-state');
      return localStorage.getItem('aquaguard-demo') === 'true' && saved
        ? (JSON.parse(saved) as AquaData)
        : makeUnavailable();
    } catch {
      return makeUnavailable();
    }
  });
  const [demoMode, setDemoMode] = useState(
    () => localStorage.getItem('aquaguard-demo') === 'true',
  );
  const [replaying, setReplaying] = useState(false);
  const [connection, setConnection] = useState<
    'demo' | 'disconnected' | 'connecting' | 'connected'
  >(demoMode ? 'demo' : 'disconnected');
  const [now, setNow] = useState(() => Date.now());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const database = useRef<Database | null>(null);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (demoMode) {
      localStorage.setItem('aquaguard-demo-state', JSON.stringify(data));
    }
  }, [data, demoMode]);

  useEffect(() => {
    if (demoMode || !hasFirebaseConfig) {
      if (!demoMode) setConnection('disconnected');
      return;
    }

    let cancelled = false;
    const db = getFirebaseDatabase();
    database.current = db;
    const rootRef = ref(db);
    const eventsRef = ref(db, 'events');

    const unsubscribeTelemetry = onValue(
      rootRef,
      (snapshot) => {
        if (cancelled) return;
        const remote = snapshot.val() as RemoteSchema | null;
        if (!remote?.system) {
          setConnection('disconnected');
          return;
        }

        const remoteTanks: NonNullable<RemoteSchema['tanks']> = remote.tanks ?? {};
        const valves = remote.valves ?? {};
        const flows = remote.flow ?? {};
        const remotePriority = remote.commands?.priority_tank;
        const priorityTank =
          remotePriority === 'A' || remotePriority === 'B' || remotePriority === 'C'
            ? remotePriority
            : 'A';
        const flowByTank: Record<TankId, number | undefined> = {
          A: flows.branch_A_lpm,
          B: flows.branch_B_inferred_lpm,
          C: flows.branch_C_inferred_lpm,
        };
        const valveByTank: Record<TankId, ValveState> = {
          A: toValve(valves.SV1),
          B: toValve(valves.SV2),
          C: toValve(valves.SV3),
        };
        const tanks = (['A', 'B', 'C'] as TankId[]).map((id, index) => {
          const incoming = remoteTanks[id] ?? {};
          const fallback = tankSeeds[index];
          const level = Number(incoming.level_pct ?? 0);
          return {
            ...fallback,
            id,
            level,
            valve: valveByTank[id],
            flow: Number(flowByTank[id] ?? 0),
            priority: id === priorityTank,
            trend: [...fallback.trend.slice(1), level],
          };
        });
        const sourceLevel = Number(remote.source?.level_pct ?? 0);
        const lastUpdated = Number(remote.system.last_updated ?? 0);
        setData((previous) => ({
          ...previous,
          phase: remote.system?.phase ?? 'NORMAL',
          tanks,
          priorityTank,
          lastUpdated,
          emergencyStopped: Boolean(remote.commands?.estop_triggered),
          source: {
            level: sourceLevel,
            flow: Number(flows.main_header_lpm ?? 0),
            valve:
              remote.system?.pump_on === true
                ? 'OPEN'
                : remote.system?.pump_on === false
                  ? 'CLOSED'
                  : 'NO_SIGNAL',
            critical:
              typeof remote.source?.critical === 'boolean'
                ? remote.source.critical
                : null,
          },
          headerFlow: Number(flows.main_header_lpm ?? 0),
          bypassFlow: 0,
          alerts: {
            leakDetected:
              typeof remote.alerts?.leak_detected === 'boolean'
                ? remote.alerts.leak_detected
                : null,
            bucketLeakSensor:
              typeof remote.alerts?.bucket_leak_sensor === 'boolean'
                ? remote.alerts.bucket_leak_sensor
                : null,
            sourceCritical:
              typeof remote.alerts?.source_critical === 'boolean'
                ? remote.alerts.source_critical
                : null,
          },
        }));
        setConnection('connected');
      },
      () => {
        if (!cancelled) setConnection('disconnected');
      },
    );

    const unsubscribeEvents = onChildAdded(eventsRef, (child) => {
      const value = child.val() as RemoteEvent | null;
      if (!value || cancelled) return;
      const event = normalizeRemoteEvent(child.key ?? `event-${Date.now()}`, value);
      setData((previous) =>
        previous.events.some((item) => item.id === event.id)
          ? previous
          : { ...previous, events: [event, ...previous.events].slice(0, 80) },
      );
    });

    setConnection('connecting');
    return () => {
      cancelled = true;
      unsubscribeTelemetry();
      unsubscribeEvents();
      database.current = null;
    };
  }, [demoMode]);

  useEffect(() => {
    return () => timers.current.forEach((timer) => clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!demoMode || data.emergencyStopped) return;
    const ticker = window.setInterval(() => {
      setData((previous) => {
        const drift = (Math.random() - 0.5) * 1;
        const isCriticalReserve = previous.phase === 'CRITICAL_RESERVE';
        const tanks = previous.tanks.map((tank) => {
          if (isCriticalReserve) {
            return tank.id === previous.priorityTank
              ? {
                  ...tank,
                  level: Math.min(100, tank.level + 0.8),
                  flow: 8.9,
                  trend: [...tank.trend.slice(1), Math.min(100, tank.level + 0.8)],
                  valve: 'OPEN' as ValveState,
                }
              : {
                  ...tank,
                  level: Math.max(12, tank.level - 0.8),
                  flow: 0,
                  trend: [...tank.trend.slice(1), Math.max(12, tank.level - 0.8)],
                  valve: 'CLOSED' as ValveState,
                };
          }
          return {
            ...tank,
            level: Math.max(0, Math.min(100, tank.level + drift)),
            trend: [
              ...tank.trend.slice(1),
              Math.max(0, Math.min(100, tank.level + drift)),
            ],
          };
        });
        return {
          ...previous,
          tanks,
          lastUpdated: Date.now(),
          waterSaved:
            isCriticalReserve ? previous.waterSaved + 3 : previous.waterSaved,
          source: {
            ...previous.source,
            level: Math.max(
              previous.source.critical ? 12 : 0,
              previous.source.level + (isCriticalReserve ? -0.2 : drift * 0.4),
            ),
          },
        };
      });
    }, 2500);
    return () => window.clearInterval(ticker);
  }, [data.emergencyStopped, demoMode]);

  const log = useCallback((kind: EventKind, title: string, detail: string) => {
    setData((previous) => ({
      ...previous,
      lastUpdated: Date.now(),
      events: [
        {
          id: `local-${Date.now()}-${Math.random()}`,
          time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          kind,
          title,
          detail,
        },
        ...previous.events,
      ].slice(0, 80),
    }));
  }, []);

  const writeCommand = useCallback(
    (path: string, value: boolean | string) => {
      if (demoMode || !hasFirebaseConfig || !database.current) return;
      void set(ref(database.current, path), value).catch(() =>
        setConnection('disconnected'),
      );
    },
    [demoMode],
  );

  const setPhase = useCallback(
    (phase: Phase, note?: string, branch?: TankId) => {
      setData((previous) => {
        const activeBranch = branch ?? previous.faultBranch;
        const targetIndex = ['A', 'B', 'C'].indexOf(activeBranch);
        const next: AquaData = {
          ...previous,
          phase,
          faultBranch: activeBranch,
          phaseStartedAt: Date.now(),
          lastUpdated: Date.now(),
          bypassFlow: 0,
        };
        if (phase === 'NORMAL') {
          next.alerts = {
            leakDetected: false,
            bucketLeakSensor: false,
            sourceCritical: false,
          };
          next.tanks = previous.tanks.map((tank) => ({
            ...tank,
            valve: 'OPEN',
            flow: tank.id === 'A' ? 12.8 : tank.id === 'B' ? 8.4 : 6.1,
          }));
          next.headerFlow = 27.3;
          next.source = { ...next.source, level: 88, flow: 27.3, valve: 'OPEN', critical: false };
        }
        if (phase === 'FAULT_DETECTED') {
          next.alerts = { ...next.alerts, leakDetected: true };
          next.tanks = previous.tanks.map((tank) =>
            tank.id === activeBranch
              ? { ...tank, flow: 1.1, valve: 'NO_SIGNAL' }
              : tank,
          );
        }
        if (phase === 'ISOLATED') {
          next.tanks = previous.tanks.map((tank) =>
            tank.id === activeBranch ? { ...tank, flow: 0, valve: 'CLOSED' } : tank,
          );
        }
        if (phase === 'BYPASS_ACTIVE') {
          next.tanks = previous.tanks.map((tank) =>
            tank.id === activeBranch ? { ...tank, flow: 10.6, valve: 'CLOSED' } : tank,
          );
          next.bypassFlow = 10.6;
          next.headerFlow = 24.2;
        }
        if (phase === 'CRITICAL_RESERVE') {
          next.alerts = { ...next.alerts, sourceCritical: true };
          next.tanks = previous.tanks.map((tank) =>
            tank.id === previous.priorityTank
              ? {
                  ...tank,
                  level: Math.min(100, tank.level + 2),
                  flow: 8.9,
                  valve: 'OPEN',
                }
              : {
                  ...tank,
                  level: Math.max(12, tank.level - 4),
                  flow: 0,
                  valve: 'CLOSED',
                },
          );
        }
        if (targetIndex >= 0 && phase === 'BYPASS_ACTIVE') {
          next.tanks[targetIndex] = {
            ...next.tanks[targetIndex],
            valve: 'CLOSED',
            flow: 10.6,
          };
        }
        return next;
      });
      if (note) log('system', phase.replaceAll('_', ' '), note);
    },
    [log],
  );

  const enterDemo = useCallback(() => {
    setDemoMode(true);
    setConnection('demo');
    localStorage.setItem('aquaguard-demo', 'true');
    setData({
      ...makeSeed(),
      events: [
        {
          id: `demo-${Date.now()}`,
          time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          kind: 'system',
          title: 'Demo mode started',
          detail: 'Simulated telemetry is now the active source',
        },
        ...initialEvents,
      ],
    });
  }, []);

  const exitDemo = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current = [];
    setReplaying(false);
    setDemoMode(false);
    localStorage.removeItem('aquaguard-demo');
    localStorage.removeItem('aquaguard-demo-state');
    setData(makeUnavailable());
    setConnection(hasFirebaseConfig ? 'connecting' : 'disconnected');
  }, []);

  const startDemoSequence = useCallback(
    (branch: TankId) => {
      timers.current.forEach((timer) => clearTimeout(timer));
      timers.current = [];
      setDemoMode(true);
      setConnection('demo');
      localStorage.setItem('aquaguard-demo', 'true');
      setData({ ...makeSeed(), faultBranch: branch });
      setReplaying(true);
      const steps: [Phase, number, string][] = [
        ['FAULT_DETECTED', 900, `Pressure variance detected on branch ${branch}`],
        ['ISOLATED', 2400, `SV${branch === 'A' ? '1' : branch === 'B' ? '2' : '3'} closed; branch ${branch} isolated`],
        ['BYPASS_ACTIVE', 4000, `Bypass opened; Tank ${branch} receiving protected supply`],
        ['CRITICAL_RESERVE', 6500, 'Source reserve below critical threshold'],
      ];
      timers.current = steps.map(([phase, delay, note]) =>
        setTimeout(() => setPhase(phase, note, branch), delay),
      );
      timers.current.push(setTimeout(() => setReplaying(false), 7600));
    },
    [setPhase],
  );

  const replayDemo = useCallback(() => startDemoSequence('A'), [startDemoSequence]);

  const simulateLeak = useCallback(
    (branch: 'A' | 'B') => startDemoSequence(branch),
    [startDemoSequence],
  );

  const simulateSourceCritical = useCallback(() => {
    setPhase('CRITICAL_RESERVE', 'Source reservoir below 25% reserve threshold');
    setData((previous) => ({
      ...previous,
      source: { ...previous.source, level: 23, flow: 8.2, critical: true },
      alerts: { ...previous.alerts, sourceCritical: true },
    }));
  }, [setPhase]);

  const confirmBypass = useCallback(() => {
    if (data.phase !== 'ISOLATED' || (!demoMode && connection !== 'connected')) return;
    setPhase(
      'BYPASS_ACTIVE',
      `Operator confirmed bypass opened; Tank ${data.faultBranch} receiving protected supply`,
    );
    writeCommand('commands/bypass_confirm', true);
  }, [connection, data.faultBranch, data.phase, demoMode, setPhase, writeCommand]);

  const emergencyStop = useCallback(() => {
    if (!demoMode && connection !== 'connected') return;
    setReplaying(false);
    timers.current.forEach((timer) => clearTimeout(timer));
    setPhase('HALTED', 'Emergency stop latched by operator');
    setData((previous) => ({
      ...previous,
      emergencyStopped: true,
      headerFlow: 0,
      bypassFlow: 0,
      source: { ...previous.source, flow: 0, valve: 'CLOSED' },
      tanks: previous.tanks.map((tank) => ({
        ...tank,
        flow: 0,
        valve: 'CLOSED',
      })),
    }));
    writeCommand('commands/estop_triggered', true);
  }, [connection, demoMode, setPhase, writeCommand]);

  const resume = useCallback(() => {
    if (!data.emergencyStopped) return;
    setData((previous) => ({ ...previous, emergencyStopped: false }));
    setPhase('NORMAL', 'Recovery acknowledged; automated logic resumed');
    writeCommand('commands/estop_triggered', false);
  }, [data.emergencyStopped, setPhase, writeCommand]);

  const reset = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    setReplaying(false);
    setData(demoMode ? makeSeed() : makeUnavailable());
    log('command', 'System reset', demoMode ? 'Demo telemetry returned to baseline' : 'Command flags cleared');
    writeCommand('commands/estop_triggered', false);
    writeCommand('commands/bypass_confirm', false);
  }, [demoMode, log, writeCommand]);

  const setPriority = useCallback(
    (tank: TankId) => {
      setData((previous) => ({
        ...previous,
        priorityTank: tank,
        tanks: previous.tanks.map((item) => ({
          ...item,
          priority: item.id === tank,
        })),
      }));
      log('command', `Priority set to Tank ${tank}`, 'Allocation policy updated');
      writeCommand('commands/priority_tank', tank);
    },
    [log, writeCommand],
  );

  const overrideValve = useCallback(
    (tank: TankId, valve: ValveState) => {
      const valveId = tank === 'A' ? 'SV1' : tank === 'B' ? 'SV2' : 'SV3';
      setData((previous) => ({
        ...previous,
        tanks: previous.tanks.map((item) =>
          item.id === tank ? { ...item, valve } : item,
        ),
      }));
      log(
        'command',
        `Manual override: ${valveId} ${valve}`,
        'Automated logic remains suspended for this valve',
      );
      writeCommand(`commands/manual_valve_override/${valveId}`, valve);
    },
    [log, writeCommand],
  );

  const phaseDuration = Math.max(0, Math.floor((now - data.phaseStartedAt) / 1000));
  const staleSeconds = data.lastUpdated
    ? Math.max(0, Math.floor((now - data.lastUpdated) / 1000))
    : 0;
  const liveDataAvailable =
    demoMode || (connection === 'connected' && data.lastUpdated > 0);

  return useMemo(
    () => ({
      data,
      demoMode,
      replaying,
      connection,
      hasFirebaseConfig,
      liveDataAvailable,
      staleSeconds,
      phaseDuration,
      enterDemo,
      exitDemo,
      replayDemo,
      simulateLeak,
      simulateSourceCritical,
      confirmBypass,
      emergencyStop,
      resume,
      reset,
      setPriority,
      overrideValve,
      setPhase,
      writeCommand,
    }),
    [
      connection,
      data,
      demoMode,
      emergencyStop,
      enterDemo,
      exitDemo,
      liveDataAvailable,
      now,
      overrideValve,
      phaseDuration,
      replayDemo,
      replaying,
      reset,
      resume,
      setPhase,
      setPriority,
      simulateLeak,
      simulateSourceCritical,
      staleSeconds,
      writeCommand,
    ],
  );
}

export type AquaGuardApi = ReturnType<typeof useAquaGuard>;