const cron = require('node-cron');
const registry = require('./adapters/registry');
const { generateEvents } = require('./schedule-generator');

const scheduledJobs = new Map();

function start() {
  // Daily 2am AEST/AEDT schedule generation
  const genJob = cron.schedule('0 15 * * *', () => {
    console.log('[scheduler] Running daily schedule generation');
    try {
      const result = generateEvents();
      console.log(`[scheduler] Schedule generation: ${result.generated} generated, ${result.cleaned} cleaned`);
    } catch (err) {
      console.error('[scheduler] Schedule generation failed:', err.message);
    }
  });
  scheduledJobs.set('schedule-generator', genJob);
  console.log('Scheduled schedule-generator: 0 15 * * * (daily 2am Sydney)');

  const adapters = registry.getAll();

  for (const adapter of adapters) {
    if (!adapter.schedule) continue;

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
