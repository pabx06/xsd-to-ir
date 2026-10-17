import { Component, Input } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { ButtonModule } from '@openng/optimus-ui/button';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { FieldNode } from './field-node';
import type { FieldIssue, ReferenceCatalog } from './models';
import type { Choice } from './metadata';

@Component({
  selector: 'app-field-editor',
  standalone: true,
  imports: [ReactiveFormsModule, ButtonModule, InputTextModule],
  templateUrl: './field-editor.html',
})
export class FieldEditor {
  @Input({ required: true }) node!: FieldNode;
  @Input({ required: true }) path!: string;
  @Input() references: ReferenceCatalog = {};
  @Input() issues: FieldIssue[] = [];
  get id(): string {
    return `field-${this.path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }
  get errors(): FieldIssue[] {
    return this.issues.filter((issue) => issue.path === this.path);
  }
  choiceLabel(choice: Choice, index: number): string {
    return choice.branches[index]
      .map((name) => this.node.shape!.fields.find((field) => field.name === name)?.label || name)
      .join(' + ');
  }
  pick(event: Event): void {
    const index = Number((event.target as HTMLSelectElement).value);
    const option = this.references[this.node.field.ref!]?.[index];
    if (option) this.node.replace(option.value);
    (event.target as HTMLSelectElement).value = '';
  }
  choose(choice: Choice, event: Event): void {
    this.node.selectChoice(choice, Number((event.target as HTMLSelectElement).value));
  }
}
