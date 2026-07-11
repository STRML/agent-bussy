#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2))
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
