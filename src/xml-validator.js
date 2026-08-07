/**
 * xml-validator.js
 *
 * Performs runtime-lightweight XML validation.
 *
 * When available, optional libxmljs2 runs XSD 1.0-style validation through
 * native libxml2 bindings. Full S3000L XSD 1.1 acceptance validation lives in
 * scripts/validate-xsd11.js.
 *
 * Falls back to a structural "well-formed + envelope check" when libxmljs2
 * is not installed or rejects an unsupported XSD grammar, so the rest of the
 * pipeline can still run in environments where native compilation or XSD 1.1
 * validation is unavailable.
 *
 * Usage:
 *   const { validateXML, ValidationError } = require('./xml-validator');
 *
 *   // throws ValidationError on failure, returns void on success
 *   await validateXML(xmlString, '/path/to/s3000l_2-0_lsaDataset.xsd');
 *
 *   // soft mode — returns { valid, errors } instead of throwing
 *   const result = await validateXML(xmlString, xsdPath, { throw: false });
 *
 *   // deterministic structural-only validation, useful for S3000L XSD 1.1
 *   // schemas when libxmljs2 cannot evaluate the schema grammar
 *   const result = await validateXML(xmlString, xsdPath, { structuralOnly: true });
 */

const fs = require('fs');
const path = require('path');

// ─── ValidationError ─────────────────────────────────────────────────────────

class ValidationError extends Error {
  /**
   * @param {string}   message   Human-readable summary
   * @param {object[]} errors    Array of { line, col, message } from libxml
   */
  constructor(message, errors = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

// ─── libxmljs2 loader (optional dep) ─────────────────────────────────────────

let libxml = null;

function _tryLoadLibxml() {
  if (libxml !== null) return libxml;
  try {
    // Optional native dependency: loading here lets installs without node-gyp still run.
    // eslint-disable-next-line global-require
    libxml = require('libxmljs2');
  } catch {
    libxml = false; // mark as unavailable
  }
  return libxml;
}

// ─── fast-xml-parser (already a hard dep) ────────────────────────────────────

const { XMLParser, XMLValidator } = require('fast-xml-parser');

const _fxpParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Lightweight well-formedness check using fast-xml-parser.
 * Also verifies that the root element is <lsaDataset>.
 */
function _structuralCheck(xmlString) {
  const wellFormed = XMLValidator.validate(xmlString, {
    allowBooleanAttributes: true,
  });

  if (wellFormed !== true) {
    const err = wellFormed.err || {};
    const location = err.line
      ? ` at line ${err.line}, col ${err.col}`
      : '';

    throw new ValidationError(
      `XML is not well-formed${location}: ${err.msg || 'parse error'}`,
      [{ line: err.line, col: err.col, message: err.msg || 'parse error' }],
    );
  }

  let parsed;
  try {
    parsed = _fxpParser.parse(xmlString);
  } catch (e) {
    throw new ValidationError(`XML is not well-formed: ${e.message}`);
  }

  // Verify S3000L root element
  const keys = Object.keys(parsed).filter((k) => !k.startsWith('?'));

  if (keys.length === 0) {
    throw new ValidationError('XML has no root element');
  }

  const root = keys[0].replace(/^[^:]+:/, ''); // strip namespace prefix

  if (root !== 'lsaDataset' && root !== 'lsaDataSet') {
    throw new ValidationError(
      `Expected root element <lsaDataset>, found <${root}>`,
    );
  }

  const rootNode = parsed[keys[0]];

  // Verify required envelope fields exist directly on lsaDataset.
  if (root === 'lsaDataset') {
    for (const required of ['msgId', 'logisticsSupportAnalysisData']) {
      if (!rootNode || rootNode[required] === undefined) {
        throw new ValidationError(
          `Missing required envelope element <${required}> in lsaDataset (v 2.0)`,
        );
      }
    }
  } else {
    for (const required of ['msgId', 'msgContent']) {
      if (!rootNode || rootNode[required] === undefined) {
        throw new ValidationError(
          `Missing required envelope element <${required}> in lsaDataSet (v 1.1)`,
        );
      }
    }
  }
}

function _resultOrThrow(err, shouldThrow, engine) {
  if (shouldThrow) throw err;
  return { valid: false, errors: err.errors.length ? err.errors : [{ message: err.message }], engine };
}

function _structuralResult(xmlString, shouldThrow, warnings = []) {
  try {
    _structuralCheck(xmlString);
  } catch (err) {
    return _resultOrThrow(err, shouldThrow, 'structural');
  }

  return {
    valid: true, errors: [], engine: 'structural', warnings,
  };
}

function _validateXMLCore(xml, xsdPath, opts = {}) {
  const shouldThrow = opts.throw !== false;
  const xmlString = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  const absXsd = path.resolve(xsdPath);
  const structuralOnly = opts.structuralOnly === true || opts.engine === 'structural';

  if (!fs.existsSync(absXsd)) {
    const err = new ValidationError(`XSD file not found: ${absXsd}`);
    return _resultOrThrow(err, shouldThrow, 'none');
  }

  // ── Try libxmljs2 (XSD 1.0 validation) ───────────────────────────────────
  const lib = structuralOnly ? false : _tryLoadLibxml();

  if (lib) {
    if (opts.verbose) process.stderr.write('  [xml-validator] using libxmljs2\n');

    let xmlDoc; let
      xsdDoc;
    try {
      xmlDoc = lib.parseXml(xmlString);
    } catch (e) {
      const err = new ValidationError(`XML parse error: ${e.message}`);
      return _resultOrThrow(err, shouldThrow, 'libxmljs2');
    }

    try {
      const xsdString = fs.readFileSync(absXsd, 'utf8');
      xsdDoc = lib.parseXml(xsdString);
    } catch (e) {
      const err = new ValidationError(`XSD parse error: ${e.message}`);
      return _resultOrThrow(err, shouldThrow, 'libxmljs2');
    }

    let valid;
    try {
      valid = xmlDoc.validate(xsdDoc);
    } catch (e) {
      const err = new ValidationError(`XSD validation engine failed: ${e.message}`);
      if (opts.allowStructuralFallback !== false) {
        return _structuralResult(xmlString, shouldThrow, [{
          engine: 'libxmljs2',
          message: err.message,
        }]);
      }
      return _resultOrThrow(err, shouldThrow, 'libxmljs2');
    }

    const errors = xmlDoc.validationErrors.map((e) => ({
      line: e.line,
      col: e.column,
      message: e.message.trim(),
      level: e.level,
    }));

    if (!valid) {
      const summary = `XSD validation failed (${errors.length} error(s)):\n${
        errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n')}`;
      const err = new ValidationError(summary, errors);
      if (shouldThrow) throw err;
    }

    return { valid, errors, engine: 'libxmljs2' };
  }

  // ── Fallback: structural check only ──────────────────────────────────────
  if (opts.verbose) {
    process.stderr.write(
      '  [xml-validator] using structural check only\n',
    );
  }

  return _structuralResult(xmlString, shouldThrow);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Validate an XML message against the XSD.
 *
 * @param {string|Buffer} xml      The XML content to validate.
 * @param {string}        xsdPath  Path to the entry XSD file.
 * @param {object}        [opts]
 * @param {boolean}       [opts.throw=true]   If false, return result object
 *                                             instead of throwing.
 * @param {boolean}       [opts.verbose=false] Log validation details.
 * @param {boolean}       [opts.structuralOnly=false] Skip libxmljs2 and only
 *                                                     check well-formedness
 *                                                     plus S3000L envelope.
 * @param {boolean}       [opts.allowStructuralFallback=true] Fall back to
 *                                                            structural mode
 *                                                            if libxmljs2
 *                                                            rejects the XSD
 *                                                            grammar.
 *
 * @returns {{ valid: boolean, errors: object[], engine: string }}
 *          Only when opts.throw === false.
 * @throws  {ValidationError}  When validation fails and opts.throw === true.
 */
async function validateXML(xml, xsdPath, opts = {}) {
  return _validateXMLCore(xml, xsdPath, opts);
}

// ─── sync convenience wrapper ─────────────────────────────────────────────────

/**
 * Synchronous variant — useful in scripts where async isn't convenient.
 * Same signature as validateXML but returns synchronously.
 */
function validateXMLSync(xml, xsdPath, opts = {}) {
  return _validateXMLCore(xml, xsdPath, opts);
}

module.exports = { validateXML, validateXMLSync, ValidationError };
