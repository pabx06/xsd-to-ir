#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { parseXSD } = require('../src/xsd-parser');
const { IRBuilder } = require('../src/ir-builder');
const { buildVisualizationModel } = require('../src/visualization-model');

const DEFAULT_XSD = path.join(__dirname, '..', 's3000l', '1_1', 's3000l_1-1_lsa_dataset.xsd');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function parseArgs(argv) {
  const opts = {
    xsdFile: DEFAULT_XSD,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') opts.host = argv[++index];
    else if (arg === '--port') opts.port = Number(argv[++index]);
    else if (arg === '--open') opts.open = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (!arg.startsWith('--')) opts.xsdFile = arg;
  }

  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  return opts;
}

function contentTypeFor(filePath) {
  return STATIC_FILES.get(filePath)?.[1] || 'application/octet-stream';
}

function createVisualizationServer({ model, staticDir }) {
  if (!model) throw new TypeError('A visualization model is required');
  const root = path.resolve(staticDir || path.join(__dirname, '..', 'visualizer'));

  return http.createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://localhost').pathname;
    if (requestPath === '/api/model') {
      const body = JSON.stringify(model);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }

    const asset = STATIC_FILES.get(requestPath);
    if (!asset) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const filePath = path.join(root, asset[0]);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid asset path');
      return;
    }

    try {
      const body = fs.readFileSync(filePath);
      response.writeHead(200, { 'Content-Type': contentTypeFor(requestPath) });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Unable to load viewer asset: ${error.message}`);
    }
  });
}

function openBrowser(url) {
  let command = 'xdg-open';
  let args = [url];
  if (process.platform === 'darwin') command = 'open';
  if (process.platform === 'win32') {
    command = 'start';
    args = ['', url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function printHelp() {
  console.log('Usage: node scripts/visualize.js [path/to/schema.xsd] [options]');
  console.log('');
  console.log('Options:');
  console.log('  --host <host>  Bind address (default: 127.0.0.1)');
  console.log('  --port <port>  HTTP port, or 0 for an available port (default: 4173)');
  console.log('  --open         Open the viewer in the default browser');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return null;
  }

  console.log(`Parsing XSD: ${opts.xsdFile}`);
  const schema = parseXSD(opts.xsdFile);
  const ir = new IRBuilder(schema).build();
  const model = buildVisualizationModel(ir, { source: path.resolve(opts.xsdFile) });
  const server = createVisualizationServer({ model });

  server.listen(opts.port, opts.host, () => {
    const address = server.address();
    const url = `http://${opts.host}:${address.port}/`;
    console.log(`S3000L Issue ${model.dialect || 'generic'} IR viewer: ${url}`);
    console.log(`Entities: ${model.stats.entities} | Relations: ${model.stats.relations}`);
    if (opts.open) openBrowser(url);
  });

  return server;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Unable to start visualizer: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  createVisualizationServer,
  parseArgs,
};
