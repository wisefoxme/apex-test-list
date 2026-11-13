#!/usr/bin/env node
// apex-test-map: maps Apex classes and triggers to their tests and writes the
// // @Tests: annotations apextestlist reads. The code lives in src/map and is
// compiled to lib/map; run `apex-test-map --help` for usage.
import { main } from '../lib/map/cli.js';

process.exitCode = await main(process.argv.slice(2));
