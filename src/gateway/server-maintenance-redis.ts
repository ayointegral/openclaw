import type { EventBus } from "../events/redis-event-bus.js";
import type { TaskStore } from "../tasks/redis-task-store.js";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EVENT_STREAM_MAX_LEN = 10_000;

export function startRedisMaintenanceTimer(opts: {
  taskStore: TaskStore | null;
  eventBus: EventBus | null;
  log: { info: (msg: string) => void; error: (msg: string) => void };
}): (() => void) | null {
  const { taskStore, eventBus, log } = opts;
  if (!taskStore && !eventBus) {
    return null;
  }

  const run = async () => {
    try {
      let purged = 0;
      if (taskStore) {
        // Purge completed/failed tasks older than 7 days for the default agent
        purged += await taskStore.purge("default", TASK_MAX_AGE_MS);
      }
      if (eventBus) {
        await eventBus.trimGlobal(EVENT_STREAM_MAX_LEN);
      }
      if (purged > 0) {
        log.info(`[redis-maintenance] purged ${purged} stale tasks`);
      }
    } catch (err) {
      log.error(`[redis-maintenance] cleanup failed: ${String(err)}`);
    }
  };

  // Run once at startup (delayed), then on interval
  const startupTimeout = setTimeout(run, 30_000);
  const interval = setInterval(run, CLEANUP_INTERVAL_MS);

  return () => {
    clearTimeout(startupTimeout);
    clearInterval(interval);
  };
}
