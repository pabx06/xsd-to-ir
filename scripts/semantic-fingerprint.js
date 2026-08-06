#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const espree = require('espree');
const { version: ESPREE_VERSION } = require('espree/package.json');

const ALGORITHM = 'sha256';
const SCHEMA_VERSION = 1;
const POLICY_VERSION = 1;
const EXTENSIONS = new Set(['.cjs', '.js']);
const EXCLUDED_DIRECTORIES = new Set([
  '.cache',
  '.code-graph',
  '.git',
  'coverage',
  'node_modules',
  'output',
]);
const POSITION_KEYS = new Set(['end', 'loc', 'range', 'start']);

class UsageError extends Error {}

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function usage() {
  return [
    'Usage: node scripts/semantic-fingerprint.js [root] [--json]',
    '',
    'Arguments:',
    '  root     JavaScript file or repository directory (default: current directory)',
    '',
    'Options:',
    '  --json   Print the deterministic per-file and per-function manifest',
    '  -h, --help',
    '           Show this help',
    '',
    'Without --json, only the order-independent semantic SHA-256 is printed.',
    'The fingerprint covers .js and .cjs files. It ignores comments, formatting,',
    'literal spelling, and the order of unique top-level named function declarations.',
    'All other statement and declaration order remains significant.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { help: false, json: false, root: '.' };
  const positionals = [];
  let positionalOnly = false;

  for (const arg of argv) {
    if (!positionalOnly && arg === '--') positionalOnly = true;
    else if (!positionalOnly && (arg === '--help' || arg === '-h')) args.help = true;
    else if (!positionalOnly && arg === '--json') args.json = true;
    else if (!positionalOnly && arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }

  if (positionals.length > 1) throw new UsageError('Expected at most one root path');
  if (positionals.length === 1) args.root = positionals[0];
  return args;
}

function sha256(value) {
  return crypto.createHash(ALGORITHM).update(value).digest('hex');
}

function digest(domain, value) {
  const hash = crypto.createHash(ALGORITHM);
  hash.update(domain);
  hash.update('\0');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

function sortedRegexFlags(flags) {
  return [...flags].sort(compareText).join('');
}

function normalizeAstValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: 'Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    return Object.is(value, -0) ? { $number: '-0' } : value;
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof RegExp) {
    return {
      $regexp: value.source,
      flags: sortedRegexFlags(value.flags),
    };
  }
  if (Array.isArray(value)) return value.map(normalizeAstValue);
  if (typeof value !== 'object') throw new Error(`Unsupported AST value type: ${typeof value}`);

  const isLiteral = value.type === 'Literal';
  const out = {};
  for (const key of Object.keys(value).sort(compareText)) {
    if (POSITION_KEYS.has(key)) continue;
    if (isLiteral && key === 'raw') continue;

    if (isLiteral && key === 'regex' && value.regex) {
      out.regex = normalizeAstValue({
        ...value.regex,
        flags: sortedRegexFlags(value.regex.flags || ''),
      });
    } else {
      out[key] = normalizeAstValue(value[key]);
    }
  }
  return out;
}

function extractHashbang(source) {
  const match = source.match(/^#![^\r\n]*/);
  return match ? match[0] : null;
}

function parseJavaScript(source, relativePath) {
  try {
    return espree.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
    });
  } catch (err) {
    const location = err.lineNumber ? `:${err.lineNumber}:${err.column || 0}` : '';
    throw new Error(`${relativePath}${location}: ${err.message}`);
  }
}

function fingerprintFile(filePath, relativePath) {
  const contents = fs.readFileSync(filePath);
  let source = contents.toString('utf8');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  const hashbang = extractHashbang(source);
  const ast = parseJavaScript(source, relativePath);
  const declarations = [];
  const nonFunctions = [];
  const names = new Set();

  for (const node of ast.body) {
    if (node.type !== 'FunctionDeclaration') {
      nonFunctions.push(node);
      continue;
    }
    if (!node.id || !node.id.name) {
      throw new Error(`${relativePath}: unnamed top-level function declaration`);
    }
    if (names.has(node.id.name)) {
      throw new Error(`${relativePath}: duplicate top-level function declaration: ${node.id.name}`);
    }

    names.add(node.id.name);
    declarations.push(node);
  }

  const functions = declarations
    .map((node) => ({
      hash: digest('semantic-fingerprint/function/v1', normalizeAstValue(node)),
      name: node.id.name,
    }))
    .sort((a, b) => compareText(a.name, b.name));

  const normalizedProgram = normalizeAstValue(ast);
  const normalizedNonFunctions = normalizeAstValue({ ...ast, body: nonFunctions });
  const nonFunctionHash = digest('semantic-fingerprint/non-functions/v1', {
    hashbang,
    program: normalizedNonFunctions,
  });
  const orderedHash = digest('semantic-fingerprint/ordered-file/v1', {
    hashbang,
    program: normalizedProgram,
  });
  const semanticHash = digest('semantic-fingerprint/semantic-file/v1', {
    functions,
    nonFunctionHash,
  });

  return {
    path: relativePath,
    sourceHash: sha256(contents),
    orderedHash,
    semanticHash,
    nonFunctionHash,
    functions,
  };
}

function hasSupportedExtension(filePath) {
  return EXTENSIONS.has(path.extname(filePath));
}

function portableRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function collectDirectoryFiles(root) {
  const files = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareText(a.name, b.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (EXCLUDED_DIRECTORIES.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported: ${portableRelativePath(root, entryPath)}`);
      }
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && hasSupportedExtension(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  visit(root);
  return files;
}

function resolveInput(rootValue) {
  const input = path.resolve(rootValue);
  let stats;
  try {
    stats = fs.lstatSync(input);
  } catch (err) {
    throw new Error(`Cannot access root path ${input}: ${err.message}`);
  }

  if (stats.isSymbolicLink()) throw new Error(`Root path cannot be a symbolic link: ${input}`);
  if (stats.isFile()) {
    if (!hasSupportedExtension(input)) throw new Error(`Root file must have a .js or .cjs extension: ${input}`);
    return { base: path.dirname(input), files: [input] };
  }
  if (!stats.isDirectory()) throw new Error(`Root path is not a file or directory: ${input}`);
  return { base: input, files: collectDirectoryFiles(input) };
}

function repositoryHash(domain, files, field, context = {}) {
  return digest(domain, {
    ...context,
    files: files.map((file) => [file.path, file[field]]),
  });
}

function generateManifest(rootValue) {
  const input = resolveInput(rootValue);
  if (input.files.length === 0) throw new Error(`No .js or .cjs files found under ${path.resolve(rootValue)}`);

  const files = input.files
    .map((filePath) => fingerprintFile(filePath, portableRelativePath(input.base, filePath)))
    .sort((a, b) => compareText(a.path, b.path));
  const parser = {
    name: 'espree',
    version: ESPREE_VERSION,
    ecmaVersion: 'latest',
    sourceType: 'script',
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    scope: {
      extensions: [...EXTENSIONS].sort(compareText),
      excludedDirectories: [...EXCLUDED_DIRECTORIES].sort(compareText),
    },
    policy: {
      version: POLICY_VERSION,
      comments: 'ignored',
      formatting: 'ignored',
      topLevelFunctionDeclarationOrder: 'ignored when names are unique',
      allOtherOrder: 'preserved',
    },
    parser,
    sourceHash: repositoryHash('semantic-fingerprint/source-repository/v1', files, 'sourceHash'),
    orderedHash: repositoryHash('semantic-fingerprint/ordered-repository/v1', files, 'orderedHash', {
      parser,
      policyVersion: POLICY_VERSION,
    }),
    semanticHash: repositoryHash('semantic-fingerprint/semantic-repository/v1', files, 'semanticHash', {
      parser,
      policyVersion: POLICY_VERSION,
    }),
    fileCount: files.length,
    functionCount: files.reduce((count, file) => count + file.functions.length, 0),
    files,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const manifest = generateManifest(args.root);
  const output = args.json ? JSON.stringify(manifest, null, 2) : manifest.semanticHash;
  process.stdout.write(`${output}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`semantic-fingerprint: ${err.message}\n`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
