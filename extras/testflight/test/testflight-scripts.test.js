'use strict';

// Regression tests for the FR-8 TestFlight release failure: build 2609021637
// died in upload-testflight.sh on `DART_DEFINES[@]: unbound variable`
// (bash 3.2 under set -u with an empty array), the EXIT trap turned that fatal
// error into exit status 0, and testflight-autoship.sh then polled App Store
// Connect for 45 minutes for a build that was never uploaded.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The TestFlight extra: extras/testflight/ (docs in extras/README.md).
const scriptsDir = path.resolve(__dirname, '..');
const BASH = '/bin/bash'; // macOS ships bash 3.2 and the release loop runs the scripts under it.
const hasBash = fs.existsSync(BASH);
const uploadScripts = ['upload-testflight.sh', 'upload-admin-testflight.sh'];
const autoshipScript = path.join(scriptsDir, 'testflight-autoship.sh');
const ascPollScript = path.join(scriptsDir, 'asc-poll-build.js');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function runBash(args, options = {}) {
  return spawnSync(BASH, args, { encoding: 'utf8', ...options });
}

test('App Store Connect preflight verifies the Push Notifications bundle capability', (t) => {
  const dir = tempDir(t, 'project-admin-asc-capability-');
  const keyPath = path.join(dir, 'AuthKey_TEST.p8');
  const preloadPath = path.join(dir, 'fake-fetch.js');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(preloadPath, `
global.fetch = async (url) => ({
  ok: true,
  text: async () => JSON.stringify(url.includes('/bundleIdCapabilities')
    ? { data: [{ attributes: { capabilityType: 'PUSH_NOTIFICATIONS' } }] }
    : { data: [{ id: 'BUNDLE123' }] })
});
`);

  const result = spawnSync(process.execPath, ['--require', preloadPath, ascPollScript, '--check-push-capability'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ADMIN_ASC_KEY_ID: 'TESTKEY123',
      PROJECT_ADMIN_ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
      PROJECT_ADMIN_ASC_KEY_PATH: keyPath,
      PROJECT_ADMIN_IOS_BUNDLE_ID: 'com.example.projectadmin',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Push Notifications capability enabled: com\.example\.projectadmin \(BUNDLE123\)/);
});

test('upload scripts never expand an empty array unguarded under set -u', () => {
  for (const name of uploadScripts) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    assert.match(source, /set -euo pipefail/, `${name} keeps set -u`);
    // Any "${arr[@]}" must sit inside the ${arr[@]+"${arr[@]}"} guard.
    const unguarded = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /(?<!\+)"\$\{[A-Z_]+\[@\]\}"/.test(line));
    assert.deepEqual(unguarded, [], `${name} expands an array without the empty-array guard`);
  }
  const upload = fs.readFileSync(path.join(scriptsDir, 'upload-testflight.sh'), 'utf8');
  assert.match(upload, /\$\{DART_DEFINES\[@\]\+"\$\{DART_DEFINES\[@\]\}"\}/);
});

test('upload scripts only report success after the final upload line', () => {
  for (const name of uploadScripts) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    assert.match(source, /^UPLOAD_COMPLETE=0$/m, `${name} starts incomplete`);
    assert.match(source, /^trap finish EXIT$/m, `${name} installs the status-preserving trap`);
    const lines = source.trimEnd().split('\n');
    assert.equal(lines[lines.length - 1], 'UPLOAD_COMPLETE=1', `${name} marks completion as its last line`);
    assert.match(lines[lines.length - 3], /^echo "PROJECT_ADMIN_TESTFLIGHT_BUILD=\$BUILD_NUMBER"$/, `${name} prints the build marker before completing`);
  }
});

test('the EXIT trap turns a fatal shell error into a non-zero exit in bash 3.2', { skip: !hasBash }, (t) => {
  const buildDir = tempDir(t, 'project-admin-trap-');
  for (const name of uploadScripts) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    const block = source.match(/^cleanup\(\) \{[\s\S]*?^trap finish EXIT$/m);
    assert.ok(block, `${name} defines cleanup/finish/trap`);
    const prelude = `set -euo pipefail\nBUILD_DIR="$(mktemp -d "${buildDir}/b.XXXXXX")"\n${block[0]}\n`;
    const cases = [
      { body: 'A=()\necho "${A[@]}"\nUPLOAD_COMPLETE=1\n', expect: 1, label: 'unbound variable' },
      { body: 'f() { return 3; }\nf\nUPLOAD_COMPLETE=1\n', expect: 3, label: 'set -e failure' },
      { body: 'exit 2\n', expect: 2, label: 'explicit exit code' },
      { body: 'echo done\n', expect: 1, label: 'exited 0 before completion' },
      { body: 'echo done\nUPLOAD_COMPLETE=1\n', expect: 0, label: 'completed upload' },
    ];
    for (const { body, expect, label } of cases) {
      const result = runBash(['-c', prelude + body]);
      assert.equal(result.status, expect, `${name}: ${label} should exit ${expect} (stderr: ${result.stderr.trim()})`);
    }
  }
});

function fakeToolchain(t) {
  const bin = tempDir(t, 'project-admin-fake-bin-');
  const calls = path.join(bin, 'calls.log');
  const recorder = '#!/bin/sh\n{ printf "%s" "$(basename "$0")"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"; } >> "$PROJECT_ADMIN_FAKE_CALLS"\n';
  writeExecutable(path.join(bin, 'flutter'), recorder + 'exit 0\n');
  writeExecutable(path.join(bin, 'xcodebuild'), recorder + 'exit 0\n');
  const keyPath = path.join(bin, 'AuthKey_TEST.p8');
  fs.writeFileSync(keyPath, 'not-a-real-key');
  return { bin, calls, keyPath };
}

function runUploadScript(t, extraEnv) {
  const { bin, calls, keyPath } = fakeToolchain(t);
  const tmp = tempDir(t, 'project-admin-upload-tmp-');
  const productRoot = tempDir(t, 'project-admin-flutter-product-');
  fs.writeFileSync(path.join(productRoot, 'pubspec.yaml'), 'name: example\nversion: 1.2.3+1\n');
  fs.mkdirSync(path.join(productRoot, 'ios', 'Runner.xcworkspace'), { recursive: true });
  fs.writeFileSync(path.join(productRoot, 'ios', 'Runner.xcworkspace', 'contents.xcworkspacedata'), '<Workspace/>\n');
  const result = runBash([path.join(scriptsDir, 'upload-testflight.sh'), '2609021637'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PROJECT_ADMIN_FAKE_CALLS: calls,
      PROJECT_ADMIN_ASC_KEY_ID: 'TESTKEY123',
      PROJECT_ADMIN_ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
      PROJECT_ADMIN_ASC_KEY_PATH: keyPath,
      PROJECT_ADMIN_APPLE_TEAM_ID: 'TEAM123',
      PROJECT_ADMIN_IOS_BUNDLE_ID: 'com.example.product',
      PROJECT_ADMIN_PRODUCT_ROOT: productRoot,
      TMPDIR: tmp,
      ...extraEnv,
    },
  });
  const flutterBuild = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').split('\n').find((line) => line.startsWith('flutter [build]'))
    : undefined;
  return { result, flutterBuild };
}

test('upload-testflight.sh reaches the archive step with no dart-defines', { skip: !hasBash }, (t) => {
  const { result, flutterBuild } = runUploadScript(t, { PROJECT_ADMIN_FLUTTER_DART_DEFINE: '' });
  assert.doesNotMatch(result.stderr, /unbound variable/);
  assert.match(result.stderr, /Archive is missing Runner\.app\/Info\.plist/, 'the fake archive stops the run after flutter build');
  assert.equal(result.status, 1);
  assert.ok(flutterBuild, 'flutter build was invoked');
  assert.match(flutterBuild, /\[--build-number\] \[2609021637\]$/, 'no empty trailing argument is passed');
  assert.doesNotMatch(flutterBuild, /--dart-define/);
  assert.doesNotMatch(result.stdout, /PROJECT_ADMIN_TESTFLIGHT_BUILD=/);
});

test('upload-testflight.sh passes a configured Flutter define when requested', { skip: !hasBash }, (t) => {
  const { result, flutterBuild } = runUploadScript(t, { PROJECT_ADMIN_FLUTTER_DART_DEFINE: 'FEATURE_FLAG=true' });
  assert.match(result.stdout, /Flutter define: FEATURE_FLAG=true/);
  assert.ok(flutterBuild, 'flutter build was invoked');
  assert.match(flutterBuild, /\[--dart-define=FEATURE_FLAG=true\]$/);
});

function runAutoship(t, uploadScriptBody) {
  const home = tempDir(t, 'project-admin-autoship-home-');
  const bin = tempDir(t, 'project-admin-autoship-bin-');
  const worktree = tempDir(t, 'project-admin-autoship-worktree-');
  const calls = path.join(bin, 'node-calls.log');
  const buildFile = path.join(bin, 'build-number');
  writeExecutable(
    path.join(bin, 'node'),
    '#!/bin/sh\nprintf "node %s\\n" "$*" >> "$PROJECT_ADMIN_FAKE_CALLS"\ncase "$1:$2:$3" in *project-env.js:value:STATE_DIRECTORY) echo ".project-admin" ;; *project-env.js:value:LOG_DIRECTORY_NAME) echo "ProjectAdminAgentLoops" ;; *project-env.js:value:KIT_SUBDIR) echo "." ;; esac\ncase "$*" in *asc-poll-build.js*) echo "VALID id=fake" ;; esac\nexit 0\n'
  );
  writeExecutable(
    path.join(worktree, 'extras', 'testflight', 'upload-testflight.sh'),
    `#!/bin/sh\nprintf "%s" "$1" > "${buildFile}"\n${uploadScriptBody}`
  );
  const result = runBash(
    [autoshipScript, 'workItems', 'DOC123', 'fable', worktree, 'FR-8 test'],
    { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PROJECT_ADMIN_FAKE_CALLS: calls, PROJECT_ADMIN_TESTFLIGHT_JOB_LABEL: '', PROJECT_ADMIN_IOS_BUNDLE_ID: 'com.example.product' } }
  );
  const nodeCalls = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  const buildNumber = fs.existsSync(buildFile) ? fs.readFileSync(buildFile, 'utf8') : '';
  const logDir = path.join(home, 'Library', 'Logs', 'ProjectAdminAgentLoops');
  const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n') : '';
  return { result, nodeCalls, buildNumber, logs, home };
}

test('autoship hands back when the upload script exits 0 without confirming the upload', { skip: !hasBash }, (t) => {
  // Reproduces build 2609021637: bash 3.2 exited 0 after the unbound-variable crash.
  const { result, nodeCalls, buildNumber, logs, home } = runAutoship(
    t,
    'echo "./scripts/upload-testflight.sh: line 49: DART_DEFINES[@]: unbound variable" >&2\nexit 0\n'
  );
  assert.equal(result.status, 1);
  assert.match(buildNumber, /^\d{10}$/);
  assert.doesNotMatch(nodeCalls, /asc-poll-build\.js/, 'App Store Connect is never polled');
  assert.doesNotMatch(nodeCalls, /verification-pending/);
  assert.match(
    nodeCalls,
    new RegExp(`ask DOC123 --as fable -m TestFlight release blocked: upload script exited 0 without confirming build ${buildNumber} was uploaded: \\./scripts/upload-testflight\\.sh: line 49: DART_DEFINES\\[@\\]: unbound variable\\. Log: `)
  );
  assert.match(logs, /HAND BACK: upload script exited 0 without confirming/);
  assert.doesNotMatch(logs, /Upload accepted; waiting/);
  assert.equal(fs.existsSync(path.join(home, '.project-admin', 'testflight-lock')), false, 'the lock is released');
});

test('autoship hands back a failed upload with its last error line', { skip: !hasBash }, (t) => {
  const { result, nodeCalls, buildNumber } = runAutoship(t, 'echo "Archiving..."\necho "** ARCHIVE FAILED **" >&2\nexit 65\n');
  assert.equal(result.status, 1);
  assert.doesNotMatch(nodeCalls, /asc-poll-build\.js/);
  assert.match(nodeCalls, new RegExp(`ask DOC123 --as fable -m TestFlight release blocked: archive or upload failed \\(exit 65\\): \\*\\* ARCHIVE FAILED \\*\\*\\. Log: .*testflight-DOC123-${buildNumber}\\.log`));
});

test('autoship polls and hands off for acceptance after a confirmed upload', { skip: !hasBash }, (t) => {
  const { result, nodeCalls, buildNumber, logs } = runAutoship(t, 'echo "PROJECT_ADMIN_TESTFLIGHT_BUILD=$1"\necho "Upload accepted by App Store Connect."\nexit 0\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(nodeCalls, new RegExp(`asc-poll-build\\.js ${buildNumber} 45 60`));
  assert.match(nodeCalls, new RegExp(`verification-pending DOC123 --as fable --build ${buildNumber} -m TestFlight build ${buildNumber} is VALID`));
  assert.doesNotMatch(nodeCalls, / ask DOC123/);
  assert.match(logs, /Upload accepted; waiting for App Store Connect processing/);
});
