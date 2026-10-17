import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from '../generated/organization.schema.json';
import type { FieldIssue, OrganizationValue } from './models';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false });
addFormats(ajv);
const validate = ajv.compile(schema);
export function validateOrganization(
  value: OrganizationValue | unknown,
  uid = 'org1',
  crud = 'I',
): FieldIssue[] {
  if (validate({ ...(value as object), uid, crud })) return [];
  const issues = (validate.errors || [])
    .filter((error) => !['if', 'anyOf', 'oneOf', 'not'].includes(error.keyword))
    .map((error) => {
      const field =
        error.keyword === 'required'
          ? error.params['missingProperty']
          : error.keyword === 'additionalProperties'
            ? error.params['additionalProperty']
            : '';
      return {
        path: error.instancePath + (field ? `/${field}` : ''),
        message: error.message || 'Value is not valid.',
      };
    });
  if (!issues.length)
    issues.push({ path: '', message: 'Select one permitted form for each choice or reference.' });
  return issues.filter(
    (issue, index) =>
      issues.findIndex((other) => other.path === issue.path && other.message === issue.message) ===
      index,
  );
}
