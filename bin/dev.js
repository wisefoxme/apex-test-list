#!/usr/bin/env node
// eslint-disable-next-line node/shebang
// oclif's dev-mode command discovery (development: true) reads tsconfig.json
// via typescript's classic compiler API to locate src/*.ts, but TypeScript 7
// removed that API, so discovery silently finds zero commands. Until
// @oclif/core supports TS7, this runs the compiled ./lib output instead —
// run `npm run compile` (or a watch) before using this script.
async function main() {
  const { execute } = await import('@oclif/core');
  await execute({ dir: import.meta.url });
}

await main();
