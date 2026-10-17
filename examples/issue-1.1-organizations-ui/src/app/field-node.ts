import { FormControl, FormGroup } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  initialValue,
  isObject,
  itemField,
  repeated,
  shapeOf,
  type Choice,
  type Field,
  type Shape,
} from './metadata';
import type { JsonObject } from './models';

export type Presence = 'absent' | 'null' | 'value';
/** Controls are created only for existing data or when a user expands a branch. */
export class FieldNode {
  readonly form: FormGroup<{ presence: FormControl<Presence>; scalar: FormControl<unknown> }>;
  children: FieldNode[] | undefined;
  items: FieldNode[] | undefined;
  expanded = false;
  private original: unknown;
  private subscriptions = new Subscription();
  constructor(
    readonly field: Field,
    value: unknown,
    private changed: () => void = () => {},
  ) {
    this.original = structuredClone(value);
    this.form = new FormGroup({
      presence: new FormControl<Presence>(
        value === undefined ? 'absent' : value === null ? 'null' : 'value',
        { nonNullable: true },
      ),
      scalar: new FormControl(value),
    });
    this.subscriptions.add(
      this.form.controls.presence.valueChanges.subscribe((state) => {
        if (state === 'value' && this.original == null) {
          this.original = initialValue(this.field);
          this.form.controls.scalar.setValue(this.original, { emitEvent: false });
        }
        if (state === 'value') {
          this.expanded = true;
          this.materialize();
        }
        this.changed();
      }),
    );
    this.subscriptions.add(this.form.controls.scalar.valueChanges.subscribe(() => this.changed()));
  }
  get presence(): Presence {
    return this.form.controls.presence.value;
  }
  get shape(): Shape | undefined {
    return this.field.ref ? shapeOf(this.field.ref) : undefined;
  }
  get isArray(): boolean {
    return repeated(this.field);
  }
  get isObject(): boolean {
    return !this.isArray && !!this.shape && !this.shape.scalar;
  }
  get constraints() {
    return this.shape?.scalar?.constraints || this.field.constraints;
  }
  get kind(): string {
    return this.shape?.scalar?.jsonType || this.field.kind;
  }
  enumLabel(value: unknown): string {
    const code = String(value);
    const labels = this.shape?.scalar?.enumLabels || this.field.enumLabels;
    const label = labels && Object.hasOwn(labels, code) ? labels[code] : undefined;
    return label && label !== code ? `${label} (${code})` : code;
  }
  materialize(): void {
    if (this.presence !== 'value') return;
    if (this.isArray && !this.items)
      this.items = (Array.isArray(this.original) ? this.original : []).map(
        (value) => new FieldNode(itemField(this.field), value, this.changed),
      );
    if (this.isObject && !this.children) {
      const value = isObject(this.original) ? this.original : {};
      this.children = this.shape!.fields.map(
        (field) => new FieldNode(field, value[field.name], this.changed),
      );
    }
  }
  toggle(): void {
    this.expanded = !this.expanded;
    if (this.expanded) this.materialize();
  }
  read(): unknown {
    if (this.presence === 'absent') return undefined;
    if (this.presence === 'null') return null;
    if (this.isArray)
      return this.items ? this.items.map((item) => item.read()) : structuredClone(this.original);
    if (this.isObject) {
      if (!this.children) return structuredClone(this.original);
      const result: JsonObject = isObject(this.original) ? structuredClone(this.original) : {};
      for (const child of this.children) {
        const value = child.read();
        if (value === undefined) delete result[child.field.name];
        else result[child.field.name] = value;
      }
      return result;
    }
    return this.form.controls.scalar.value;
  }
  replace(value: unknown): void {
    this.children?.forEach((child) => child.dispose());
    this.items?.forEach((item) => item.dispose());
    this.children = undefined;
    this.items = undefined;
    this.original = structuredClone(value);
    this.form.controls.scalar.setValue(value, { emitEvent: false });
    this.form.controls.presence.setValue(
      value === undefined ? 'absent' : value === null ? 'null' : 'value',
      { emitEvent: false },
    );
    if (this.expanded) this.materialize();
    this.changed();
  }
  add(): void {
    this.materialize();
    this.items!.push(
      new FieldNode(itemField(this.field), initialValue(itemField(this.field)), this.changed),
    );
    const added = this.items!.at(-1)!;
    added.expanded = true;
    added.materialize();
    this.changed();
  }
  remove(index: number): void {
    this.items!.splice(index, 1)[0].dispose();
    this.changed();
  }
  move(index: number, direction: number): void {
    const target = index + direction;
    if (!this.items || target < 0 || target >= this.items.length) return;
    [this.items[index], this.items[target]] = [this.items[target], this.items[index]];
    this.changed();
  }
  selected(choice: Choice): number {
    const value = this.read();
    if (!isObject(value)) return -1;
    return choice.branches.findIndex((branch) => branch.some((name) => Object.hasOwn(value, name)));
  }
  selectChoice(choice: Choice, index: number): void {
    this.materialize();
    const names = new Set(choice.branches.flat());
    const selected = new Set(choice.branches[index] || []);
    for (const child of this.children || []) {
      if (!names.has(child.field.name)) continue;
      if (!selected.has(child.field.name)) child.replace(undefined);
      else if (child.presence === 'absent') child.replace(initialValue(child.field));
    }
    this.changed();
  }
  visible(child: FieldNode): boolean {
    return (this.shape?.choices || [])
      .filter((choice) => !choice.repeated && choice.branches.flat().includes(child.field.name))
      .every((choice) => (choice.branches[this.selected(choice)] || []).includes(child.field.name));
  }
  summary(): string {
    const value = this.read();
    if (value === undefined) return 'Not supplied';
    if (value === null) return 'Explicit null';
    if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
    if (isObject(value)) {
      for (const name of ['descr', 'id', 'uidRef', 'uid', 'code'])
        if (typeof value[name] === 'string') return value[name] as string;
      return `${Object.keys(value).filter((name) => !['uid', 'crud'].includes(name)).length} fields supplied`;
    }
    return String(value);
  }
  dispose(): void {
    this.subscriptions.unsubscribe();
    this.children?.forEach((child) => child.dispose());
    this.items?.forEach((item) => item.dispose());
  }
}
