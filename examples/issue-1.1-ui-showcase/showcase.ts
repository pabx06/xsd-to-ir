/**
 * S3000L Issue 1.1 — clean UI TypeScript showcase.
 * Run from the repository root: npm run example:ui:1_1
 * The runner generates types.ts and ui-json-schema.json from the bundled XSD.
 * In your IDE, hover over fields or use Go to Definition to explore types.ts.
 * The referenced organizations and breakdown element revisions are illustrative IDs;
 * loading and resolving those records belongs to the application.
 */
import type { Entities, ValueTypes } from './types';

export type Product = Entities['product'];
export type ProductIdentifier = ValueTypes['productIdentifier'];
export type OrganizationReference = ValueTypes['organizationReference'];
// This wrapper is an anonymous inline complex type in the IR and a JSON database cell.
// Access its complete nested type directly through Product; no anonymous name to copy.
export type Breakdown = NonNullable<Product['bkdns']>['bkdn'][number];

// 1. The minimum Product: required fields, including a nonempty identifier array.
export const minimalProduct: Product = {
  uid: 'prod1',
  crud: 'I',
  prodId: [{ id: '001234' }],
};

// 2. A business attribute is a normal property in the UI.
// The exactly-one reference assertion permits a UID OR a natural identifier.
export const ownerByUid: OrganizationReference = { uidRef: 'org1' };
export const ownerByIdentifier: OrganizationReference = { orgId: { id: 'OWNER-01' } };

// 3. Deeply nested inline values are typed, even though bkdns is stored as JSON.
// beChildRef points to another usage in this breakdown revision.
export const systemsBreakdown: Breakdown = {
  uid: 'bkdn1',
  crud: 'I',
  bkdnType: { code: 'SY' },
  bkdnRev: [{
    uid: 'bkdnr1',
    crud: 'I',
    bkdnRevId: { id: 'A', class: 'REV' },
    status: { code: 'A' },
    beUsage: [
      {
        uid: 'beu1',
        beRef: { uidRef: 'ber1' },
        beChild: [{
          uid: 'bes1',
          beChildRef: { uidRef: 'beu2' },
        }],
      },
      {
        uid: 'beu2',
        beRef: { uidRef: 'ber2' },
      },
    ],
  }],
};

export const exampleProduct: Product = {
  uid: 'prod1',
  crud: 'I',
  prodId: [{ id: '001234', class: 'PID', setBy: ownerByUid }],
  // Issue 1.1 uses name[].descr. Issue 2.0 has its own generated field names.
  name: [{ descr: 'Example aircraft', lang: 'en' }],
  bkdns: { bkdn: [systemsBreakdown] },
};

// 4. Omission and explicit XML nil remain distinct.
// minimalProduct omits name; this example explicitly sets one name occurrence to nil.
export const productWithNilName: Product = { ...minimalProduct, name: [null] };

// 5. A form-edit helper. Suggestions and checking work all the way into nested values.
// For this example, assume the recipient already knows the product, so the action is U.
// The backend must determine the action from record history in a real save operation.
export function renameProduct(product: Product, description: string): Product {
  return { ...product, crud: 'U', name: [{ descr: description, lang: 'en' }] };
}

export function productHeading(product: Product): string {
  const description = product.name?.[0]?.descr ?? 'Unnamed product';
  return description + ' (' + product.prodId[0].id + ')';
}

export function breakdownRows(product: Product) {
  return (product.bkdns?.bkdn ?? []).map((breakdown) => ({
    uid: breakdown.uid,
    type: breakdown.bkdnType.code,
    revisions: (breakdown.bkdnRev ?? []).flatMap((revision) => revision ? [{
      identifier: revision.bkdnRevId.id,
      usages: (revision.beUsage ?? []).flatMap((usage) => usage ? [{
        uid: usage.uid,
        revisionUid: usage.beRef.uidRef,
        children: (usage.beChild ?? []).flatMap((child) => child ? [child.beChildRef.uidRef] : []),
      }] : []),
    }] : []),
  }));
}

// Try uncommenting one line at a time to see the compiler reject invalid inputs:
// exampleProduct.prodId[0].id = 1234;                    // Identifier must be a string.
// exampleProduct.prodId = { id: '001234' };              // Repeated fields are arrays.
// exampleProduct.prodId = [];                           // At least one identifier is required.
// exampleProduct.crud = 'INVALID';                      // Only declared enum values are accepted.
// systemsBreakdown.bkdnType.code = 'INVALID';            // Nested enums are checked too.
// const missing: Product = { uid: 'p', crud: 'I' };       // prodId is required.
// const both: OrganizationReference = { uidRef: 'org1', orgId: { id: 'ORG1' } }; // Exactly one form.
