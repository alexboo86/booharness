/**
 * Board machine panel (operator decisions #12680, #12718): CPU, memory and disk of this Mac and
 * every host in hosts.json. This Mac's CPU is read in-process on every request and its memory is
 * the latest background vm_stat. Probing a host (and any disk) means a child process, ssh for a
 * host, so the board never waits on one: the last reading is served at once with its age, one aging past REFRESH_AFTER_MS is refreshed
 * in the background (one probe in flight per machine), and before the first reading exists the
 * entry is a probing placeholder. A failed probe is kept as the failure (with its timestamp), never
 * as a zero reading.
 */
import { readHosts } from './config.ts';
import { macLoadNow, PROBE_TIMEOUT_MS, probeDisk, probeLoad, type DiskProbe, type FreeMemRunner, type LoadProbe, type Target } from './placement.ts';

export type MachineReading = {
  /** 'mac' for this Mac (the board's local chip), else the hosts.json name. */
  name: string;
  /** ISO time of the load reading (success or failure); null while the first probe is still in flight. */
  at: string | null;
  /** null while the first probe is still in flight: the card says probing, never 0%. */
  load: LoadProbe | null;
  /** ISO time of the memory reading: this Mac's comes from the latest background vm_stat. */
  memAt: string | null;
  /** ISO time of the disk reading; this Mac's load is live while its disk comes from the cached probe. */
  diskAt: string | null;
  disk: DiskProbe | null;
};

/** A probed reading is at most this old once its refresh lands: the refresh starts early enough for a probe that runs to its timeout. */
export const MACHINE_TTL_MS = 15_000;
const REFRESH_AFTER_MS = MACHINE_TTL_MS - PROBE_TIMEOUT_MS;

type Machine = { name: string; target: Target; diskPath: string };

/** The Mac always, then every host; a malformed hosts.json costs the host cards, never the Mac's. */
function machines(stateDir: string): { list: Machine[]; hostsError: string | null } {
  const list: Machine[] = [{ name: 'mac', target: 'local', diskPath: stateDir }];
  try {
    for (const [name, host] of Object.entries(readHosts(stateDir))) list.push({ name, target: name, diskPath: host.repo });
  } catch (error) {
    return { list, hostsError: (error as Error).message };
  }
  return { list, hostsError: null };
}

type Probed = { at: string; load: LoadProbe | null; disk: DiskProbe };
const cache = new Map<string, Probed>();
const inFlight = new Map<string, Promise<void>>();

/** This Mac's load is never probed here: it is read live per request. */
function refresh(machine: Machine): void {
  if (inFlight.has(machine.name)) return;
  // Spawn after the poll returns. probeLoad/probeDisk run until their first await, and that
  // stretch is the ssh/disk spawn; a board poll must not pay it (task 2098).
  const current = new Promise<void>((resolve) => {
    setImmediate(() => {
      void (async () => {
        try {
          const [load, disk] = await Promise.all([machine.target === 'local' ? null : probeLoad(machine.target), probeDisk(machine.target, machine.diskPath)]);
          cache.set(machine.name, { at: new Date().toISOString(), load, disk });
        } catch (error) {
          const failed = { ok: false as const, error: `${machine.name}: ${(error as Error).message}` };
          cache.set(machine.name, { at: new Date().toISOString(), load: failed, disk: failed });
        } finally { resolve(); }
      })();
    });
  });
  inFlight.set(machine.name, current);
  const clear = () => { if (inFlight.get(machine.name) === current) inFlight.delete(machine.name); };
  void current.then(clear, clear);
}

/**
 * One entry per machine, never waiting on a probe: this Mac's load read now, and the cached probe
 * (or a probing placeholder before the first) while a background refresh runs.
 */
export function machineLoads(stateDir: string, run?: FreeMemRunner): MachineReading[] {
  const { list, hostsError } = machines(stateDir);
  const readings = list.map((machine): MachineReading => {
    const cached = cache.get(machine.name);
    if (!cached || Date.now() - Date.parse(cached.at) >= REFRESH_AFTER_MS) refresh(machine);
    const disk = { diskAt: cached?.at ?? null, disk: cached?.disk ?? null };
    if (machine.target === 'local') {
      const mac = macLoadNow(run);
      return { name: machine.name, at: mac && new Date().toISOString(), load: mac?.load ?? null, memAt: mac?.memAt ?? null, ...disk };
    }
    return { name: machine.name, at: cached?.at ?? null, load: cached?.load ?? null, memAt: cached?.at ?? null, ...disk };
  });
  if (hostsError) {
    const error = `hosts.json: ${hostsError}`, at = new Date().toISOString();
    readings.push({ name: 'hosts.json', at, load: { ok: false, error }, memAt: at, diskAt: at, disk: { ok: false, error } });
  }
  return readings;
}
