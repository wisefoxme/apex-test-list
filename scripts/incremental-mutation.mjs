#!/usr/bin/env node
// Run Stryker only against `src/**/*.ts` files that changed vs the merge-base
// with the base branch, then post surviving mutants as a PR comment.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const baseBranch = process.env.MUTATION_BASE_BRANCH ?? 'origin/master';
const REPORT_PATH = 'reports/mutation/mutation-testing-report.json';
const COMMENT_MARKER = '<!-- stryker-incremental-report -->';

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf-8' });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return (result.stdout ?? '').trim();
}

function listChangedSourceFiles() {
  // --diff-filter=AM picks up Added and Modified files; deletions are skipped
  // because there is nothing left to mutate. Renames/copies are reported as
  // adds + deletes by default with --no-renames (omit; default is fine here).
  const output = git('--no-pager', 'diff', '--name-only', '--diff-filter=AM', `--merge-base`, baseBranch, '--', 'src');
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts'));
}

// ---------------------------------------------------------------------------
// Stryker JSON report parsing
// ---------------------------------------------------------------------------

function extractOriginal(source, location) {
  const lines = source.split('\n');
  const { start, end } = location;
  if (start.line === end.line) {
    return (lines[start.line - 1] ?? '').slice(start.column - 1, end.column - 1);
  }
  return (lines[start.line - 1] ?? '').slice(start.column - 1);
}

function parseSurvivors(reportPath) {
  if (!existsSync(reportPath)) return null;
  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  const survivors = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    for (const mutant of data.mutants ?? []) {
      if (mutant.status === 'Survived') {
        survivors.push({
          file,
          line: mutant.location.start.line,
          mutatorName: mutant.mutatorName,
          original: extractOriginal(data.source, mutant.location),
          replacement: mutant.replacement ?? '—',
        });
      }
    }
  }
  survivors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return survivors;
}

// ---------------------------------------------------------------------------
// GitHub PR comment
// ---------------------------------------------------------------------------

function getPRNumber() {
  // GITHUB_REF format: refs/pull/123/merge
  const refMatch = (process.env.GITHUB_REF ?? '').match(/refs\/pull\/(\d+)\//);
  if (refMatch) return parseInt(refMatch[1], 10);

  // Fallback: read from the event payload file
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
      const number = event.pull_request?.number ?? event.number;
      if (number) return number;
    } catch {
      // ignore parse errors
    }
  }
  return null;
}

function formatComment(survivors, changedFiles) {
  const fileList = changedFiles.map((f) => `\`${f}\``).join(', ');
  const header = `${COMMENT_MARKER}\n## 🧬 Mutation Testing (incremental)\n_Scanned: ${fileList}_\n`;

  if (survivors.length === 0) {
    return `${header}\n✅ All mutants killed — no survivors on changed files.`;
  }

  const rows = survivors.map(
    ({ file, line, mutatorName, original, replacement }) =>
      `| \`${file}\` | ${line} | ${mutatorName} | \`${original}\` | \`${replacement}\` |`,
  );

  return [
    header,
    `⚠️ **${survivors.length} survived mutant(s)** — consider adding tests to kill them.\n`,
    '| File | Line | Mutator | Original | Mutant |',
    '|------|------|---------|----------|--------|',
    ...rows,
  ].join('\n');
}

async function upsertPRComment(token, repo, prNumber, body) {
  const base = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const listResp = await fetch(`${base}/issues/${prNumber}/comments?per_page=100`, { headers });
  if (!listResp.ok) throw new Error(`Failed to list comments: ${listResp.status} ${listResp.statusText}`);

  const comments = await listResp.json();
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));

  const payload = JSON.stringify({ body });
  if (existing) {
    const patchResp = await fetch(`${base}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers,
      body: payload,
    });
    if (!patchResp.ok) throw new Error(`Failed to update comment: ${patchResp.status} ${patchResp.statusText}`);
  } else {
    const postResp = await fetch(`${base}/issues/${prNumber}/comments`, {
      method: 'POST',
      headers,
      body: payload,
    });
    if (!postResp.ok) throw new Error(`Failed to create comment: ${postResp.status} ${postResp.statusText}`);
  }
}

async function reportToGitHub(changedFiles) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = getPRNumber();

  if (!token || !repo || !prNumber) {
    console.log('[incremental-mutation] GitHub context not available; skipping PR comment.');
    return;
  }

  const survivors = parseSurvivors(REPORT_PATH);
  if (survivors === null) {
    console.log('[incremental-mutation] No JSON report found; skipping PR comment.');
    return;
  }

  const body = formatComment(survivors, changedFiles);
  try {
    await upsertPRComment(token, repo, prNumber, body);
    console.log(`[incremental-mutation] Posted ${survivors.length} survivor(s) to PR #${prNumber} (repo: ${repo}).`);
  } catch (err) {
    console.error(`[incremental-mutation] Failed to post GitHub comment: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let files;
  try {
    files = listChangedSourceFiles();
  } catch (error) {
    console.error(`[incremental-mutation] ${error.message}`);
    console.error(
      `[incremental-mutation] Ensure the base branch "${baseBranch}" is fetched (use 'fetch-depth: 0' in CI).`,
    );
    process.exit(1);
  }

  if (files.length === 0) {
    console.log('[incremental-mutation] No source files changed; skipping mutation testing.');
    return;
  }

  console.log(`[incremental-mutation] Running Stryker against ${files.length} changed file(s):`);
  for (const file of files) console.log(`  - ${file}`);

  const args = ['stryker', 'run', '--mutate', files.join(',')];
  const stryker = spawnSync('npx', args, { stdio: 'inherit', shell: true });
  const exitCode = stryker.status ?? 1;

  await reportToGitHub(files);

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[incremental-mutation] Unexpected error:', err.message);
  process.exit(1);
});
