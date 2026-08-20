const { deserializeXML } = require('./src/xml-deserializer');
const { XMLSerializer, serializeToXML } = require('./src/xml-serializer');
const { validateXML, validateXMLSync } = require('./src/xml-validator');
const { DBAdapter } = require('./src/db-adapter');
const { IRBuilder } = require('./src/ir-builder');
const { parseXSD } = require('./src/xsd-parser');
const { ASSETS_DIRECTORY, getAssetPath, getS30001SchemaPath } = require('./assets');

module.exports = {
  deserializeXML,
  XMLSerializer,
  serializeToXML,
  validateXML,
  validateXMLSync,
  DBAdapter,
  IRBuilder,
  ASSETS_DIRECTORY, getAssetPath, getS30001SchemaPath, parseXSD,
};
