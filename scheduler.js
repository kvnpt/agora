const cron = require('node-cron');
const registry = require('./adapters/registry');

const scheduledJobs = new Map();

function start() {
  const adapters = registry.getAll();

  for (const adapter of adapters) {
    if (!adapter.schedule) continue;
    if (adapter.parishId === '*' && adapter.id === 'manual') {
      // Manual adapter runs on schedule
    }

    if (!cron.validate(adapter.schedule)) {
      console.error(`Invalid cron schedule for ${adapter.id}: ${adapter.schedule}`);
      continue;
    }

    const job = cron.schedule(adapter.schedule, async () => {
      console.log(`[scheduler] Running adapter: ${adapter.id}`);
      try {
        await adapter.run();
      } catch (err) {
        console.error(`[scheduler] Adapter ${adapter.id} failed:`, err.message);
      }
    });

    scheduledJobs.set(adapter.id, job);
    console.log(`Scheduled adapter ${adapter.id}: ${adapter.schedule}`);
  }
}

function stop() {
  for (const [id, job] of scheduledJobs) {
    job.stop();
    console.log(`Stopped adapter ${id}`);
  }
  scheduledJobs.clear();
}

module.exports = { start, stop };
