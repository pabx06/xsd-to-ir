'use strict';

/**
 * xml-validator.js
 *
 * Validates an XML string or Buffer against an XSD file using libxmljs2
 * (native libxml2 bindings — the most spec-complete validator available
 * in Node.js).
 *
 * Falls back to a structural "well-formed + envelope check" when libxmljs2
 * is not installed, so the rest of the pipeline can still run in
 * environments where native compilation is unavailable.
 *
 * Usage:
 *   const { validateXML, ValidationError } = require('./xml-validator');
 *
 *   // throws ValidationError on failure, returns void on success
 *   await validateXML(xmlString, '/path/to/s3000l_3-0_lsaDataset.xsd');
 *
 *   // soft mode — returns { valid, errors } instead of throwing
 *   const result = await validateXML(xmlString, xsdPath, { throw: false });
 */

const fs   = require('fs');
const path = require('path');

// ─── ValidationError ─────────────────────────────────────────────────────────

class ValidationError extends Error {
  /**
   * @param {string}   message   Human-readable summary
   * @param {object[]} errors    Array of { line, col, message } from libxml
   */
  constructor(message, errors = []) {
    super(message);
    this.name   = 'ValidationError';
    this.errors = errors;
  }
}

// ─── libxmljs2 loader (optional dep) ─────────────────────────────────────────

let libxml = null;

function _tryLoadLibxml() {
  if (libxml !== null) return libxml;
  try {
    libxml  = require('libxmljs2');
  } catch {
    libxml  = false; // mark as unavailable
  }
  return libxml;
}

// ─── fast-xml-parser (already a hard dep) ────────────────────────────────────

const { XMLParser } = require('fast-xml-parser');

const _fxpParser = new XMLParser({
  ignoreAttributes   : false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Lightweight well-formedness check using fast-xml-parser.
 * Also verifies that the root element is <lsaDataset>.
 */
function _structuralCheck(xmlString) {
  let parsed;
  try {
    parsed = _fxpParser.parse(xmlString);
  } catch (e) {
    throw new ValidationError(`XML is not well-formed: ${e.message}`);
  }

  // Verify S3000L root element
  const keys = Object.keys(parsed).filter(k => !k.startsWith('?'));
  if (keys.length === 0) {
    throw new ValidationError('XML has no root element');
  }
  const root = keys[0].replace(/^[^:]+:/, ''); // strip namespace prefix
  if (root !== 'lsaDataset') {
    throw new ValidationError(
      `Expected root element <lsaDataset>, found <${root}>`
    );
  }

  // Verify required header fields exist somewhere in the tree
  const xmlLower = xmlString.toLowerCase();
  for (const required of ['msgid', 'msgdate', 'msgtype']) {
    if (!xmlLower.includes(required)) {
      throw new ValidationError(
        `Missing required header element <${required}> in lsaDataset`
      );
    }
  }
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
 *
 * @returns {{ valid: boolean, errors: object[], engine: string }}
 *          Only when opts.throw === false.
 * @throws  {ValidationError}  When validation fails and opts.throw === true.
 */
async function validateXML(xml, xsdPath, opts = {}) {
  const shouldThrow = opts.throw !== false;
  const xmlString   = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
  const absXsd      = path.resolve(xsdPath);

  if (!fs.existsSync(absXsd)) {
    const err = new ValidationError(`XSD file not found: ${absXsd}`);
    if (shouldThrow) throw err;
    return { valid: false, errors: [{ message: err.message }], engine: 'none' };
  }

  // ── Try libxmljs2 (full XSD 1.0 validation) ──────────────────────────────
  const lib = _tryLoadLibxml();

  if (lib) {
    if (opts.verbose) process.stderr.write('  [xml-validator] using libxmljs2\n');

    let xmlDoc, xsdDoc;
    try {
      xmlDoc = lib.parseXml(xmlString);
    } catch (e) {
      const err = new ValidationError(`XML parse error: ${e.message}`);
      if (shouldThrow) throw err;
      return { valid: false, errors: [{ message: err.message }], engine: 'libxmljs2' };
    }

    try {
      const xsdString = fs.readFileSync(absXsd, 'utf8');
      xsdDoc = lib.parseXml(xsdString);
    } catch (e) {
      const err = new ValidationError(`XSD parse error: ${e.message}`);
      if (shouldThrow) throw err;
      return { valid: false, errors: [{ message: err.message }], engine: 'libxmljs2' };
    }

    const valid  = xmlDoc.validate(xsdDoc);
    const errors = xmlDoc.validationErrors.map(e => ({
      line   : e.line,
      col    : e.column,
      message: e.message.trim(),
      level  : e.level,
    }));

    if (!valid) {
      const summary = `XSD validation failed (${errors.length} error(s)):\n` +
        errors.map(e => `  line ${e.line}: ${e.message}`).join('\n');
      const err = new ValidationError(summary, errors);
      if (shouldThrow) throw err;
    }

    return { valid, errors, engine: 'libxmljs2' };
  }

  // ── Fallback: structural check only ──────────────────────────────────────
  if (opts.verbose) {
    process.stderr.write(
      '  [xml-validator] libxmljs2 not available — using structural check only\n'
    );
  }

  try {
    _structuralCheck(xmlString);
  } catch (err) {
    if (shouldThrow) throw err;
    return { valid: false, errors: [{ message: err.message }], engine: 'structural' };
  }

  return { valid: true, errors: [], engine: 'structural' };
}

// ─── sync convenience wrapper ─────────────────────────────────────────────────

/**
 * Synchronous variant — useful in scripts where async isn't convenient.
 * Same signature as validateXML but returns synchronously.
 */
function validateXMLSync(xml, xsdPath, opts = {}) {
  // validateXML is actually synchronous internally; wrap to avoid Promise
  let result;
  const promise = validateXML(xml, xsdPath, opts);
  // Since the implementation is sync (no real async ops), extract value
  promise.then(r => { result = r; }).catch(e => { throw e; });
  if (result === undefined) {
    // If genuinely async (future extension), throw a clear error
    throw new Error('validateXMLSync: async operation detected — use validateXML instead');
  }
  return result;
}

module.exports = { validateXML, validateXMLSync, ValidationError };
