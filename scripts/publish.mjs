// Credentials remain in memory and are never written to the checkout.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const repo = 'nmoubarak2023-sys/Balloon-Simulator-Copy';
const remote = `https://github.com/${repo}.git`;
const roots = [
  process.env.BALLOON_GIT_ROOT,
  path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Git'),
].filter(Boolean);
const gitRoot = roots.find(root => existsSync(path.join(root, 'cmd/git.exe')));
const git = gitRoot ? path.join(gitRoot, 'cmd/git.exe') : 'git.exe';
const searchDirs = [
  ...(gitRoot ? ['cmd', 'mingw64/bin', 'usr/bin', 'mingw64/libexec/git-core'].map(dir => path.join(gitRoot, dir)) : []),
  ...(process.env.PATH || '').split(path.delimiter),
];
const helper = searchDirs.map(dir => path.join(dir, 'git-credential-manager.exe')).find(existsSync);
// GCM itself launches git.exe. An absolute path for our Git call alone is insufficient.
const env = { ...process.env, PATH: searchDirs.join(path.delimiter), GIT_TERMINAL_PROMPT: '0', GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0' };
function run(args, extra = {}) {
  const result = spawnSync(git, args, { cwd, env, encoding: 'utf8', windowsHide: true, ...extra });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Git command failed.');
  return result.stdout.trim();
}
try {
  console.log(`Git: ${git}`);
  console.log(`Git Credential Manager: ${helper || 'not found'}`);
  console.log(run(['--version']));
  if (!helper) throw new Error('Git Credential Manager is missing. Install Git for Windows with Credential Manager enabled.');
  const helperVersion = spawnSync(helper, ['--version'], { cwd, env, encoding: 'utf8', windowsHide: true });
  if (helperVersion.status !== 0) throw new Error(helperVersion.error?.message || 'Git Credential Manager cannot start.');
  console.log(`Credential Manager version: ${helperVersion.stdout.trim()}`);
  if (process.argv.includes('--check-tools')) {
    const foundGit = spawnSync('where.exe', ['git.exe'], { env, encoding: 'utf8', windowsHide: true });
    if (foundGit.status !== 0) throw new Error('Child processes cannot find git.exe on PATH.');
    console.log(`Child-process Git lookup: ${foundGit.stdout.trim()}`);
    process.exit(0);
  }
  if (run(['remote', 'get-url', 'origin']) !== remote) throw new Error('Unexpected origin URL. Publishing stopped.');
  if (run(['branch', '--show-current']) !== 'main') throw new Error('Expected the main branch. Publishing stopped.');
  if (run(['status', '--porcelain'])) throw new Error('Commit the local changes before publishing.');
  console.log(`Publishing the saved website from ${cwd} to ${repo}`);
  const credentialInput = 'protocol=https\nhost=github.com\nusername=nmoubarak2023-sys\n\n';
  let result = spawnSync(helper, ['get'], { input: credentialInput, encoding: 'utf8', env: { ...env, GCM_INTERACTIVE: 'Never' }, windowsHide: true });
  if (result.status !== 0 || !result.stdout.includes('password=')) {
    console.log('GitHub sign-in is required. Complete the browser sign-in.');
    const login = spawnSync(helper, ['github', 'login', '--username', 'nmoubarak2023-sys', '--force'], { env, stdio: 'inherit' });
    if (login.status !== 0) throw new Error('GitHub sign-in failed. Run this publisher in your normal Windows session.');
    result = spawnSync(helper, ['get'], { input: credentialInput, encoding: 'utf8', env: { ...env, GCM_INTERACTIVE: 'Never' }, windowsHide: true });
  }
  const credentials = Object.fromEntries((result.stdout || '').split(/\r?\n/).filter(x => x.includes('=')).map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  const token = credentials.password;
  if (!token) throw new Error('No GitHub credential is available.');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(route, method = 'GET', body) {
    const response = await fetch(`https://api.github.com/repos/${repo}${route}`, { method, headers, body: body && JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${method} ${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const info = await api('');
  if (!info.permissions?.push) throw new Error('The signed-in account needs write access to this repository.');
  const auth = Buffer.from(`${credentials.username || 'x-access-token'}:${token}`).toString('base64');
  run(['-c', 'credential.helper=', 'push', '-u', 'origin', 'main'], { env: { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` } });
  console.log('Source pushed successfully.');
  let pages;
  try { pages = await api('/pages'); } catch (error) { if (!error.message.includes(': 404')) throw error; }
  if (!pages) await api('/pages', 'POST', { build_type: 'workflow' });
  else if (pages.build_type !== 'workflow') await api('/pages', 'PUT', { build_type: 'workflow' });
  await api('/actions/workflows/pages.yml/dispatches', 'POST', { ref: 'main' });
  console.log(`Deployment requested. Check https://github.com/${repo}/actions`);
  console.log('After deployment succeeds: https://nmoubarak2023-sys.github.io/Balloon-Simulator/');
} catch (error) {
  // Never include captured credential-helper output in an error.
  console.error(error.message);
  process.exitCode = 1;
}
