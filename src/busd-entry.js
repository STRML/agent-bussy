// Entry point for the detached daemon process. Binds the HTTP server and stays up.
import { join } from 'node:path';
import { ensureToken, ensureHome, config } from './config.js';
import { createBus } from './server.js';

const cfg = config();
const token = ensureToken();
ensureHome();
const dbPath = join(cfg.home, 'bus.db');

const { server } = createBus({ token, dbPath, config: cfg });

server.on('error', (err) => {
  // Port collision is the common one — a second daemon that slipped past the
  // pidfile guard. Log and exit non-zero rather than run half-bound.
  console.error(`busd failed to bind ${cfg.host}:${cfg.port}: ${err.code || err.message}`);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  console.error(`busd listening on ${cfg.host}:${cfg.port} (db: ${dbPath})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
