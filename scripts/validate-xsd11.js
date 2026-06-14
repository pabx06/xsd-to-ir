#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_XSD = 's3000l/s3000l_2-0_lsaDataset.xsd';
const DEFAULT_XML = 'test/fixtures/s3000l-minimal-valid.xml';
const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, '.cache', 'xsd11');
const JAVA_SOURCE = path.join(PROJECT_ROOT, 'scripts', 'Xsd11Validator.java');
const SELF_TEST = {
  xsd: path.join(PROJECT_ROOT, 'test', 'fixtures', 'xsd11-assert-smoke.xsd'),
  validXml: path.join(PROJECT_ROOT, 'test', 'fixtures', 'xsd11-assert-valid.xml'),
  invalidXml: path.join(PROJECT_ROOT, 'test', 'fixtures', 'xsd11-assert-invalid.xml'),
};

const ARTIFACTS = [
  {
    name: 'xercesImpl-xsd11-shaded',
    file: 'xercesImpl-xsd11-shaded-2.12-beta-r1667115.jar',
    url: 'https://repo1.maven.org/maven2/org/opengis/cite/xerces/xercesImpl-xsd11-shaded/2.12-beta-r1667115/xercesImpl-xsd11-shaded-2.12-beta-r1667115.jar',
    sha256: '0df3f750c0ca4551bce44fc02cf75ccd74f3dcfd3e4c1f87094f49a29602f936',
  },
  {
    name: 'java-cup',
    file: 'java-cup-10k.jar',
    url: 'https://repo1.maven.org/maven2/edu/princeton/cup/java-cup/10k/java-cup-10k.jar',
    sha256: '15894fad0a81611e351b5200bbc3bd21359fc6aed53af54a48998390e4b2700d',
  },
];

function parseArgs(argv) {
  const out = {
    cacheDir: process.env.XSD11_CACHE_DIR || DEFAULT_CACHE_DIR,
    skipSelfTest: process.env.XSD11_SKIP_SELF_TEST === '1',
    xsd: process.env.XSD11_TEST_XSD || DEFAULT_XSD,
    xml: process.env.XSD11_TEST_XML || DEFAULT_XML,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--cache-dir') out.cacheDir = argv[++i];
    else if (arg === '--required') {
      // Kept for compatibility with the former hook API. The default path is always required now.
    } else if (arg === '--skip-self-test') out.skipSelfTest = true;
    else if (arg === '--xsd') out.xsd = argv[++i];
    else if (arg === '--xml') out.xml = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function usage() {
  return [
    'Usage: node scripts/validate-xsd11.js [--xsd schema.xsd] [--xml sample.xml]',
    '',
    'Default behavior:',
    '  - downloads pinned Xerces XSD 1.1 runtime jars into .cache/xsd11',
    '  - verifies jar SHA-256 checksums',
    '  - compiles scripts/Xsd11Validator.java',
    '  - runs an xs:assert self-test',
    '  - validates the supplied XML against the supplied XSD with XML Schema 1.1',
    '',
    'Environment:',
    '  XSD11_CACHE_DIR       Override cache directory',
    '  XSD11_SKIP_SELF_TEST  Set to 1 to skip the built-in xs:assert self-test',
    '  XSD11_TEST_XML        Default XML fixture path',
    '  XSD11_TEST_XSD        Default XSD path',
    '',
    'Requires a JDK on PATH: java and javac.',
  ].join('\n');
}

function resolvePath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function assertFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} file does not exist: ${filePath}`);
  }
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: opts.capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result;
}

function requireTool(command, installHint) {
  const result = run(command, ['-version'], { capture: true });
  if (result.status !== 0) {
    throw new Error(`${command} is required for XSD 1.1 validation. ${installHint}`);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'xsd-to-ir-xsd11-validator' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        download(response.headers.location, dest).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const tmp = `${dest}.tmp-${process.pid}`;
      const file = fs.createWriteStream(tmp);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmp, dest);
          resolve();
        });
      });
      file.on('error', (err) => {
        fs.rmSync(tmp, { force: true });
        reject(err);
      });
    });

    request.on('error', reject);
  });
}

async function ensureArtifact(cacheDir, artifact) {
  const jarPath = path.join(cacheDir, artifact.file);
  if (fs.existsSync(jarPath) && sha256File(jarPath) === artifact.sha256) {
    return jarPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`Downloading ${artifact.name} for XSD 1.1 validation...`);
  await download(artifact.url, jarPath);

  const actual = sha256File(jarPath);
  if (actual !== artifact.sha256) {
    fs.rmSync(jarPath, { force: true });
    throw new Error(`Checksum mismatch for ${artifact.name}: expected ${artifact.sha256}, got ${actual}`);
  }
  return jarPath;
}

async function ensureArtifacts(cacheDir) {
  const jars = [];
  for (const artifact of ARTIFACTS) {
    jars.push(await ensureArtifact(cacheDir, artifact));
  }
  return jars;
}

function compileValidator(cacheDir, classpath) {
  const classesDir = path.join(cacheDir, 'classes');
  const classFile = path.join(classesDir, 'Xsd11Validator.class');
  fs.mkdirSync(classesDir, { recursive: true });

  const sourceMtime = fs.statSync(JAVA_SOURCE).mtimeMs;
  const classMtime = fs.existsSync(classFile) ? fs.statSync(classFile).mtimeMs : 0;
  if (classMtime >= sourceMtime) return classesDir;

  const result = run('javac', [
    '-cp', classpath,
    '-d', classesDir,
    JAVA_SOURCE,
  ], { capture: true });

  if (result.status !== 0) {
    throw new Error(`Failed to compile Xsd11Validator.java:\n${result.stderr || result.stdout}`);
  }

  return classesDir;
}

function runJavaValidator(classesDir, jars, xsd, xml, opts = {}) {
  const classpath = [classesDir, ...jars].join(path.delimiter);
  return run('java', [
    '-cp', classpath,
    'Xsd11Validator',
    '--xsd', xsd,
    '--xml', xml,
  ], opts);
}

function assertPassed(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stderr || result.stdout}`);
  }
}

function assertFailedWithAssertion(result, label) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (result.status === 0) {
    throw new Error(`${label} unexpectedly passed; XSD 1.1 assertions are not being enforced`);
  }
  if (!/cvc-assertion|Assertion evaluation|assert/i.test(output)) {
    throw new Error(`${label} failed, but not with an assertion error:\n${output}`);
  }
}

function runSelfTest(classesDir, jars) {
  assertFile(SELF_TEST.xsd, 'XSD 1.1 self-test schema');
  assertFile(SELF_TEST.validXml, 'XSD 1.1 valid self-test XML');
  assertFile(SELF_TEST.invalidXml, 'XSD 1.1 invalid self-test XML');

  assertPassed(
    runJavaValidator(classesDir, jars, SELF_TEST.xsd, SELF_TEST.validXml, { capture: true }),
    'XSD 1.1 valid self-test',
  );
  assertFailedWithAssertion(
    runJavaValidator(classesDir, jars, SELF_TEST.xsd, SELF_TEST.invalidXml, { capture: true }),
    'XSD 1.1 invalid self-test',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const xsd = resolvePath(args.xsd);
  const xml = resolvePath(args.xml);
  const cacheDir = resolvePath(args.cacheDir);

  assertFile(xsd, 'XSD');
  assertFile(xml, 'XML');
  assertFile(JAVA_SOURCE, 'Java validator source');

  requireTool('java', 'Install a JDK, for example openjdk-17-jdk-headless in CI.');
  requireTool('javac', 'Install a JDK, for example openjdk-17-jdk-headless in CI.');

  const jars = await ensureArtifacts(cacheDir);
  const classpath = jars.join(path.delimiter);
  const classesDir = compileValidator(cacheDir, classpath);

  if (!args.skipSelfTest) runSelfTest(classesDir, jars);

  const result = runJavaValidator(classesDir, jars, xsd, xml);
  return result.status || 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
