#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./cached-auth.mjs', import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), 'ensemble-cached-auth-bench-'));
const cacheDir = join(tempDir, 'cache');
const noOpPath = join(tempDir, 'node-noop');
const markerPath = join(tempDir, 'inner-command-ran');
const ttlArgs = [
  '--cache-dir',
  cacheDir,
  '--ttl-ms',
  '300000',
];

writeFileSync(
  noOpPath,
  '#!/usr/bin/env node\nprocess.stdout.write("benchmark-token")\n',
  { mode: 0o700 },
);
chmodSync(noOpPath, 0o700);

function runShellCommand(executable, args = []) {
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      'exec "$@"',
      'cached-auth-bench',
      executable,
      ...args,
    ],
    { encoding: 'utf8' },
  );
}

function runCachedAuth(command) {
  return runShellCommand(scriptPath, [
    ...ttlArgs,
    '--',
    ...command,
  ]);
}

function measure(run) {
  const startedAt = performance.now();
  const result = run();
  return { durationMs: performance.now() - startedAt, result };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return (sorted[4] + sorted[5]) / 2;
}

try {
  const seed = runCachedAuth([
    process.execPath,
    '-e',
    'process.stdout.write("benchmark-token")',
  ]);
  if (seed.status !== 0 || seed.stdout !== 'benchmark-token') {
    throw new Error(`could not seed cache: ${seed.stderr}`);
  }

  const noOpDurationsMs = [];
  const hitDurationsMs = [];
  const pairedOverheadsMs = [];
  const markerCommand = [
    process.execPath,
    '-e',
    'require("node:fs").appendFileSync(process.argv[1], "ran\\n"); process.stdout.write("unexpected-token")',
    markerPath,
  ];

  for (let index = 0; index < 10; index += 1) {
    const runNoOp = () => ({
      kind: 'no-op',
      ...measure(() => runShellCommand(noOpPath)),
    });
    const runHit = () => ({
      kind: 'hit',
      ...measure(() => runCachedAuth(markerCommand)),
    });
    const pair = index % 2 === 0
      ? [runNoOp(), runHit()]
      : [runHit(), runNoOp()];
    const noOp = pair.find((sample) => sample.kind === 'no-op');
    const hit = pair.find((sample) => sample.kind === 'hit');

    if (
      pair.some((sample) => sample.result.status !== 0) ||
      !noOp ||
      !hit ||
      noOp.result.stdout !== 'benchmark-token' ||
      hit.result.stdout !== 'benchmark-token'
    ) {
      throw new Error(
        `paired sample ${index + 1} failed: ${pair.map((sample) => sample.result.stderr).join(' | ')}`,
      );
    }
    noOpDurationsMs.push(noOp.durationMs);
    hitDurationsMs.push(hit.durationMs);
    pairedOverheadsMs.push(hit.durationMs - noOp.durationMs);
  }

  if (existsSync(markerPath)) {
    throw new Error('inner command ran during a cache-hit sample');
  }

  const noOpP50Ms = median(noOpDurationsMs);
  const hitP50Ms = median(hitDurationsMs);
  const overheadP50Ms = median(pairedOverheadsMs);
  const thresholdMs = 25;
  const criterionApplies = process.platform === 'darwin';
  process.stdout.write(
    [
      `platform: ${process.platform} ${process.arch}`,
      `Node.js: ${process.version}`,
      `no-op samples (ms): ${noOpDurationsMs.map((value) => value.toFixed(2)).join(', ')}`,
      `cache-hit samples (ms): ${hitDurationsMs.map((value) => value.toFixed(2)).join(', ')}`,
      `paired hit-minus-no-op samples (ms): ${pairedOverheadsMs.map((value) => value.toFixed(2)).join(', ')}`,
      `no-op p50: ${noOpP50Ms.toFixed(2)} ms`,
      `cache-hit p50: ${hitP50Ms.toFixed(2)} ms`,
      `paired hit overhead p50: ${overheadP50Ms.toFixed(2)} ms`,
      `macOS acceptance (<= ${thresholdMs} ms): ${
        criterionApplies ? (overheadP50Ms <= thresholdMs ? 'PASS' : 'FAIL') : 'not applicable'
      }`,
    ].join('\n') + '\n',
  );
  if (criterionApplies && overheadP50Ms > thresholdMs) process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
