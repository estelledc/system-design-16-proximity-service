import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url);
const expected = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-postgis-authority-and-materialized-search-sessions.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'package.json',
  'scripts/postgres-benchmark.mjs',
  'scripts/postgres-smoke.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/crypto.js',
  'src/errors.js',
  'src/http.js',
  'src/index.js',
  'src/main.js',
  'src/repository.js',
  'src/service.js',
  'test/integration/postgis.test.js',
  'test/unit/contracts.test.js',
  'test/unit/crypto.test.js',
  'test/unit/http.test.js',
  'test/unit/service.test.js',
];

async function walk(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await walk(new URL(`${entry.name}/`, directory), relative));
    else paths.push(relative);
  }
  return paths;
}

for (const path of expected) {
  assert.equal((await stat(new URL(path, root))).isFile(), true, `missing required file: ${path}`);
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(packageJson.dependencies.pg, '8.23.0');
assert.equal(packageJson.engines.node, '>=22');
for (const script of ['lint', 'test', 'test:postgres', 'smoke:postgres', 'benchmark:postgres', 'audit', 'check', 'check:ci']) {
  assert.equal(typeof packageJson.scripts[script], 'string', `missing package script: ${script}`);
}

const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.packages[''].dependencies.pg, '8.23.0');

const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /postgis\/postgis:17-3\.5-alpine/);
assert.match(workflow, /permissions:\n  contents: read/);
const actionUses = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
assert.ok(actionUses.length >= 2);
assert.ok(actionUses.every((reference) => /^[0-9a-f]{40}$/.test(reference)), 'actions must use full commit pins');

const schema = await readFile(new URL('sql/schema.sql', root), 'utf8');
assert.match(schema, /geography\(Point, 4326\)/);
assert.match(schema, /USING gist \(location\)/);
const sessionBlock = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS search_sessions'), schema.indexOf('CREATE TABLE IF NOT EXISTS search_session_results'));
assert.equal(/latitude|longitude/.test(sessionBlock), false, 'search session metadata must not store raw query coordinates');
const repository = await readFile(new URL('src/repository.js', root), 'utf8');
for (const contract of ['ST_DWithin', 'ST_Distance', 'REPEATABLE READ', 'LIMIT 501', 'ORDER BY distance_mm ASC, p.place_id ASC']) {
  assert.ok(repository.includes(contract), `missing repository contract: ${contract}`);
}

const files = await walk(root);
const portable = files.filter((path) => /\.(?:md|js|mjs|json|sql|ya?ml)$/.test(path));
const forbidden = [
  /\/Users\//,
  /\/private\/tmp\//,
  /file:\/\//,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
];
for (const path of portable) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const pattern of forbidden) assert.equal(pattern.test(contents), false, `${path} contains forbidden portable data`);
}

for (const path of files.filter((value) => value.endsWith('.md'))) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = normalize(join(dirname(path), decodeURIComponent(target)));
    assert.equal((await stat(new URL(resolved, root))).isFile(), true, `${path} has broken link: ${target}`);
  }
}

execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
process.stdout.write(`${JSON.stringify({ evidence: 'repository_policy_check', files: files.length, markdownLinksChecked: true })}\n`);
