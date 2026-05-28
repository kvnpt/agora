const { Router } = require('express');
const registry = require('../adapters/registry');

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

module.exports = router;
