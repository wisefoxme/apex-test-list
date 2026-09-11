export default {
  entry: [
    'src/commands/**/*.ts',
    'src/action/*.ts',
    'bin/dev.js',
    'bin/run.js',
    'scripts/**/*.{ts,mjs}',
    '**/*.{nut,test,perf}.ts',
    'vitest*.config.ts',
    '.github/**/*.yml',
  ],
  project: ['**/*.{ts,js,mjs}'],
  ignore: ['**/*.{json,yml,yaml}'],
  ignoreExportsUsedInFile: true,
};
