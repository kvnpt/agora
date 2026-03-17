const fs = require('fs');
const path = require('path');

const adapters = new Map();

function discover() {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith('.js') &&
    f !== 'base.js' &&
    f !== 'registry.js' &&
    !f.startsWith('_')
  );

  for (const file of files) {
    try {
      const mod = require(path.join(dir, file));
      // Module can export a single adapter or an array of adapters
      const instances = Array.isArray(mod) ? mod : [mod];
      for (const adapter of instances) {
        if (adapter && adapter.id) {
          adapters.set(adapter.id, adapter);
          console.log(`Registered adapter: ${adapter.id} (${adapter.sourceType})`);
        }
      }
    } catch (err) {
      console.error(`Failed to load adapter ${file}:`, err.message);
    }
  }

  return adapters;
}

function getAll() {
  return Array.from(adapters.values());
}

function get(id) {
  return adapters.get(id);
}

module.exports = { discover, getAll, get };
