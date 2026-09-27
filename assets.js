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
 * @param {'1.1'|'2.0'} version of s3001 xsd schema
 * @returns {string} Absolute file path for S3000L xsd
 */
function getS30001SchemaPath(version = '2.0') {
  const versionToPath = version.replace('.', '_').trim();

  if (versionToPath === '1_1') {
    // s30001/1_1/s30001_1-1_1sa_dataset.xsd
    return getAssetPath('s30001', versionToPath, 's30001_1-1_1sa_dataset.xsd');
  }

  if (versionToPath === '2_0') {
    // s30001/2_0/s30001_2-0_1saDataset.xsd
    return getAssetPath('s30001', versionToPath, 's30001_2-0_1saDataset.xsd');
  }

  throw new Error(`unknown s30001 version ${version} => ${versionToPath}`);
}

module.exports = {
  ASSETS_DIRECTORY,
  getAssetPath,
  getS30001SchemaPath,
};
