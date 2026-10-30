#!/usr/bin/env node
/**
 * 使い捨て: project `.ensemble/` に残っているランタイム状態を user 層へ移す。
 *
 * 0.16.0 の `resolveEnsemblePaths` / ADR 0044 と同じ配置先を使う。
 * アプリ本体は読み取り fallback + 利用時コピーだが、旧ファイルをまとめて片付けたいとき用。
 *
 *   node scripts/migrate-project-ensemble-runtime-to-user.mjs --repo-root /path/to/repo
 *   node scripts/migrate-project-ensemble-runtime-to-user.mjs --dry-run
 *
 * 環境変数 ENSEMBLE_USER_ROOT があれば ~/.ensemble の代わりに使う。
 * 移動先に既にあるファイルはスキップする（user 側を優先）。
 */

import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rename,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';

const ENSEMBLE_USER_ROOT_ENV = 'ENSEMBLE_USER_ROOT';
const SIDEcar_FILES = new Set(['open-questions.yaml', 'session-state.yaml']);

function usage() {
  process.stderr.write(
    `Usage: migrate-project-ensemble-runtime-to-user.mjs [--repo-root <path>] [--dry-run]\n`,
  );
}

function parseArgs(argv) {
  let repoRoot = process.cwd();
  let dryRun = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--repo-root') {
      const value = argv[++i];
      if (!value) throw new Error('--repo-root requires a path');
      repoRoot = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { repoRoot, dryRun };
}

function resolveUserRoot() {
  const configured = process.env[ENSEMBLE_USER_ROOT_ENV];
  if (configured !== undefined && configured !== '') {
    return normalize(resolve(configured));
  }
  return join(homedir(), '.ensemble');
}

function resolvePaths(repoRoot) {
  const normalizedRepoRoot = normalize(resolve(repoRoot));
  const userRoot = resolveUserRoot();
  const projectRoot = join(normalizedRepoRoot, '.ensemble');
  const repoKey = createHash('sha256').update(normalizedRepoRoot).digest('hex');
  const sessionsDir = join(userRoot, 'sessions', repoKey);
  const legacySessionsDir = join(projectRoot, 'sessions');
  const operatorAgentDir = join(userRoot, 'operator-agent', repoKey);

  return {
    normalizedRepoRoot,
    repoKey,
    userRoot,
    projectRoot,
    sessionsDir,
    legacySessionsDir,
    operatorAgentDir,
    legacyOperatorSession: join(projectRoot, 'operator-agent', 'session.json'),
    legacyOperatorWatch: join(
      projectRoot,
      'operator-agent',
      'watch-state.json',
    ),
    operatorSession: join(operatorAgentDir, 'session.json'),
    operatorWatch: join(operatorAgentDir, 'watch-state.json'),
    piSessionsDir: join(sessionsDir, 'pi'),
    legacyPiSessionsDir: join(projectRoot, 'pi', 'sessions'),
    operatorPiSessionsDir: join(operatorAgentDir, 'pi-sessions'),
  };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function ensureDir(path, dryRun) {
  if (dryRun) return;
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function moveFile(src, dest, dryRun, log) {
  if (!(await pathExists(src))) return false;
  if (await pathExists(dest)) {
    log(`skip (dest exists): ${dest}`);
    return false;
  }
  log(`move: ${src} -> ${dest}`);
  if (dryRun) return true;
  await ensureDir(dirname(dest), false);
  await rename(src, dest);
  await chmod(dest, 0o600).catch(() => {});
  return true;
}

async function copyFileIfMissing(src, dest, dryRun, log) {
  if (!(await pathExists(src))) return false;
  if (await pathExists(dest)) {
    log(`skip copy (dest exists): ${dest}`);
    return false;
  }
  log(`copy: ${src} -> ${dest}`);
  if (dryRun) return true;
  await ensureDir(dirname(dest), false);
  await copyFile(src, dest);
  await chmod(dest, 0o600).catch(() => {});
  return true;
}

async function migrateLegacySessionsDir(paths, dryRun, log) {
  const { legacySessionsDir, sessionsDir } = paths;
  if (!(await pathExists(legacySessionsDir))) {
    log(`no legacy sessions dir: ${legacySessionsDir}`);
    return;
  }

  const entries = await readdir(legacySessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(legacySessionsDir, entry.name);
    if (entry.isFile()) {
      if (entry.name.endsWith('.json') || entry.name.endsWith('.tool-calls')) {
        await moveFile(src, join(sessionsDir, entry.name), dryRun, log);
      }
      continue;
    }
    if (!entry.isDirectory()) continue;

    const agentId = entry.name;
    const destAgentDir = join(sessionsDir, agentId);
    for (const fileName of SIDEcar_FILES) {
      await moveFile(
        join(src, fileName),
        join(destAgentDir, fileName),
        dryRun,
        log,
      );
    }
  }
}

async function migratePiTranscripts(paths, dryRun, log) {
  const { legacyPiSessionsDir, piSessionsDir, operatorPiSessionsDir } = paths;
  if (!(await pathExists(legacyPiSessionsDir))) {
    log(`no legacy Pi sessions dir: ${legacyPiSessionsDir}`);
    return;
  }

  const entries = await readdir(legacyPiSessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = join(legacyPiSessionsDir, entry.name);
    const conductorDest = join(piSessionsDir, entry.name);
    const moved = await moveFile(src, conductorDest, dryRun, log);
    if (moved || dryRun) {
      await copyFileIfMissing(
        conductorDest,
        join(operatorPiSessionsDir, entry.name),
        dryRun,
        log,
      );
    } else {
      await copyFileIfMissing(
        src,
        join(operatorPiSessionsDir, entry.name),
        dryRun,
        log,
      );
    }
  }
}

async function migrateOperatorAgentState(paths, dryRun, log) {
  await moveFile(
    paths.legacyOperatorSession,
    paths.operatorSession,
    dryRun,
    log,
  );
  await moveFile(
    paths.legacyOperatorWatch,
    paths.operatorWatch,
    dryRun,
    log,
  );
}

async function main() {
  const { repoRoot, dryRun } = parseArgs(process.argv);
  const paths = resolvePaths(repoRoot);
  const lines = [];
  const log = (message) => {
    lines.push(message);
  };

  log(`repoRoot: ${paths.normalizedRepoRoot}`);
  log(`repoKey: ${paths.repoKey}`);
  log(`userRoot: ${paths.userRoot}`);
  log(`sessionsDir: ${paths.sessionsDir}`);
  if (dryRun) log('(dry-run)');

  await migrateLegacySessionsDir(paths, dryRun, log);
  await migratePiTranscripts(paths, dryRun, log);
  await migrateOperatorAgentState(paths, dryRun, log);

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
