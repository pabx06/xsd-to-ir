// xsd-to-ir/assets.js

const path = require('node:path');
const fs = require('node:fs');

const ASSETS_DIRECTORY = __dirname;

/**
 * Resolve an asset path relative to the xsd-to-ir assets directory.
 *
 * @param {...string} segments
 * @returns {string} Absolute file path
 */
function getAssetPath(...segments) {
  const assetPath = path.resolve(ASSETS_DIRECTORY, ...segments);
  const relativePath = path.relative(ASSETS_DIRECTORY, assetPath);

  /* Prevent paths such as ../../some-secret-file */
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error('Asset path is outside the xsd-to-ir assets directory');
  }

  if (!fs.existsSync(assetPath)) {
    throw new Error(`xsd-to-ir asset not found: ${assetPath}`);
  }

  return assetPath;
}

/**
 *
 * @param {'1.1'|'2.0'} version S3000L issue
 * @returns {string} Absolute path to the bundled dataset XSD
 */
function getS3000LSchemaPath(version = '2.0') {
  const issue = version.trim().replace('_', '.');
  if (issue === '1.1') return getAssetPath('s3000l', '1_1', 's3000l_1-1_lsa_dataset.xsd');
  if (issue === '2.0') return getAssetPath('s3000l', '2_0', 's3000l_2-0_lsaDataset.xsd');
  throw new Error(`Unknown S3000L issue: ${version}`);
}

module.exports = {
  ASSETS_DIRECTORY,
  getAssetPath,
  getS3000LSchemaPath,
  getS30001SchemaPath: getS3000LSchemaPath, // Historical spelling used by existing hosts.
};
