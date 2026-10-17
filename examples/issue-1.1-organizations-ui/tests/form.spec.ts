import { describe, expect, it } from 'vitest';
import { FieldNode } from '../src/app/field-node';
import { organizationFields, shapeOf, type Field, initialValue } from '../src/app/metadata';
import { seedSnapshot } from '../src/app/seeds';

const field = (name: string) => organizationFields.find((item) => item.name === name)!;
describe('generated recursive forms', () => {
  it('shows annotated enum meanings while keeping the original codes', () => {
    const code = shapeOf('documentAssignmentRole').fields.find((item) => item.name === 'code')!;
    const node = new FieldNode(code, 'REF');
    expect(node.enumLabel('DRW')).toBe('Drawing reference (DRW)');
    expect(node.enumLabel('DSG')).toBe('Design document reference (DSG)');
    expect(node.enumLabel('UNKNOWN')).toBe('UNKNOWN');
    node.form.controls.scalar.setValue('DRW');
    expect(node.read()).toBe('DRW');
    expect(node.constraints.enum).toEqual(['REF', 'DRW', 'DSG', 'DIR', 'SCE', 'VER']);
    node.dispose();
  });
  it('preserves untouched nested data without creating recursive controls', () => {
    const value = seedSnapshot().records[0].value.docs;
    const node = new FieldNode(field('docs'), value);
    expect(node.children).toBeUndefined();
    expect(node.read()).toEqual(value);
    node.toggle();
    expect(node.children?.[0].items).toBeUndefined();
    expect(node.read()).toEqual(value);
    node.dispose();
  });
  it('keeps absence, explicit null, and empty text distinct', () => {
    const node = new FieldNode(field('name'), undefined);
    expect(node.read()).toBeUndefined();
    node.form.controls.presence.setValue('null');
    expect(node.read()).toBeNull();
    node.form.controls.presence.setValue('value');
    expect(node.read()).toEqual({ descr: '' });
    node
      .children!.find((child) => child.field.name === 'descr')!
      .form.controls.scalar.setValue('001234');
    expect(node.read()).toEqual({ descr: '001234' });
    node.form.controls.presence.setValue('absent');
    expect(node.read()).toBeUndefined();
    node.dispose();
  });
  it('adds, removes, and reorders repeated values without losing nested identity', () => {
    const node = new FieldNode(field('orgId'), [{ id: '001' }, { id: '002' }]);
    node.materialize();
    node.move(1, -1);
    expect(node.read()).toEqual([{ id: '002' }, { id: '001' }]);
    node.add();
    expect(node.items!.length).toBe(3);
    node.remove(1);
    expect(node.read()).toEqual([{ id: '002' }, { id: '' }]);
    node.dispose();
  });
  it('offers the permitted fields and exclusive document/applicability/reference forms', () => {
    expect(shapeOf('organizationIdentifier').fields.map((f) => f.name)).not.toContain('setBy');
    expect(shapeOf('organizationName').fields.map((f) => f.name)).not.toContain('providedBy');
    const document: Field = {
      name: 'doc',
      label: 'Document',
      ref: 'documentAssignment',
      kind: 'object',
      min: 1,
      max: 1,
      required: true,
      nullable: false,
      system: false,
      constraints: {},
    };
    const node = new FieldNode(document, {
      docRef: { uidRef: 'doc1' },
      uid: 'docasg101',
      crud: 'R',
    });
    node.materialize();
    node.selectChoice(node.shape!.choices[0], 1);
    expect(node.read()).toEqual({ docIssRef: { uidRef: '' }, uid: 'docasg101', crud: 'R' });
    const reference = shapeOf('documentIssueReference');
    expect(reference.choices[0].branches).toEqual([
      ['uidRef'],
      ['docId', 'docIssId'],
      ['dmc', 'dmIssId'],
      ['pmc', 'pmIssId'],
    ]);
    const applicability = field('orgId').ref!;
    const applicField = shapeOf(applicability).fields.find((f) => f.name === 'applic')!;
    expect(shapeOf(applicField.ref!).choices[0].branches).toEqual([
      ['applicDef'],
      ['datedApplicDef'],
      ['applicRef'],
    ]);
    node.dispose();
  });
  it('materializes a finite initial value for every reachable type', () => {
    // Cycles must remain optional until the user expands them.
    const applic = shapeOf('organizationIdentifier').fields.find((f) => f.name === 'applic')!;
    expect(JSON.stringify(initialValue(applic)).length).toBeLessThan(1000);
  });
});
