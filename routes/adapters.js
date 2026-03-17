const { Router } = require('express');
const registry = require('../adapters/registry');
const { requireRole } = require('../auth');

const router = Router();

// GET /api/adapters/status — list all adapters with health
router.get('/status', (req, res) => {
  const adapters = registry.getAll();
  const statuses = adapters.map(a => ({
    id: a.id,
    parishId: a.parishId,
    sourceType: a.sourceType,
    schedule: a.schedule,
    ...a.healthCheck()
  }));
  res.json(statuses);
});

// POST /api/adapters/:id/run — manually trigger an adapter
router.post('/:id/run', requireRole('admin'), async (req, res) => {
  const adapter = registry.get(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'Adapter not found' });

  try {
    const result = await adapter.run();
    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

module.exports = router;
