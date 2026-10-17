import { Injectable, InjectionToken, inject } from '@angular/core';
import type { KeyValueStorage } from './models';
import { OrganizationStore } from './organization-store';

export const DEMO_STORAGE = new InjectionToken<KeyValueStorage>('Demo storage', {
  providedIn: 'root',
  factory: () => ({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  }),
});
@Injectable({ providedIn: 'root' })
export class OfflineOrganizationService extends OrganizationStore {
  constructor() {
    super(inject(DEMO_STORAGE));
  }
}
