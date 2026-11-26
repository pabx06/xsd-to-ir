import {
  HttpBackend,
  HttpClient,
  HttpErrorResponse,
  HttpResponse,
  type HttpEvent,
  type HttpRequest,
} from '@angular/common/http';
import { Injector } from '@angular/core';
import { Observable, type Subscriber } from 'rxjs';
import { EntityCrudHttpService } from '../../src/app/entity-crud-http.service';
import { OrganizationService } from '../../src/app/organization.service';
import { RUNTIME_CONFIG, type RuntimeConfigState } from '../../src/app/runtime-config';
import { TEST_CONFIG } from './records';

export class PendingRequest {
  cancelled = false;
  completed = false;
  constructor(
    readonly request: HttpRequest<unknown>,
    private subscriber: Subscriber<HttpEvent<unknown>>,
  ) {}
  reply(body: unknown, status = 200): void {
    this.completed = true;
    if (status >= 400)
      this.subscriber.error(new HttpErrorResponse({ error: body, status, url: this.request.url }));
    else {
      this.subscriber.next(new HttpResponse({ body, status }));
      this.subscriber.complete();
    }
  }
}
export class ContractBackend extends HttpBackend {
  readonly requests: PendingRequest[] = [];
  handle(request: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    return new Observable((subscriber) => {
      const pending = new PendingRequest(request, subscriber);
      this.requests.push(pending);
      return () => {
        if (!pending.completed) pending.cancelled = true;
      };
    });
  }
  get last(): PendingRequest {
    return this.requests.at(-1)!;
  }
}
export function transport(configuration: RuntimeConfigState = { config: TEST_CONFIG }) {
  const backend = new ContractBackend();
  const injector = Injector.create({
    providers: [
      { provide: RUNTIME_CONFIG, useValue: configuration },
      { provide: HttpClient, useValue: new HttpClient(backend) },
      { provide: EntityCrudHttpService, useFactory: () => new EntityCrudHttpService() },
      { provide: OrganizationService, useFactory: () => new OrganizationService() },
    ],
  });
  return {
    backend,
    http: injector.get(EntityCrudHttpService),
    service: injector.get(OrganizationService),
  };
}
