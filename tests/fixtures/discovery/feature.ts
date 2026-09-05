import { Component, Directive, Injectable, Pipe } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class CustomerService { get() { return fetch('/api/customers/123'); } }
@Component({ selector: 'child-view', standalone: true, template: '<span>Child</span>' })
export class ChildComponent {}
@Directive({ selector: '[marker]', standalone: true })
export class MarkerDirective {}
@Pipe({ name: 'upper', standalone: true })
export class UpperPipe { transform(value: string) { return value.toUpperCase(); } }
@Component({ selector: 'feature-root', standalone: true, imports: [ChildComponent, MarkerDirective, UpperPipe], template: '<child-view></child-view><p marker>{{ "value" | upper }}</p>' })
export class FeatureComponent { constructor(readonly service: CustomerService) {} }
@Component({ selector: 'other-root', standalone: true, template: '<p>Other</p>' })
export class UnrelatedComponent {}
export const AuthGuard = () => true;
export class CustomerResolver { resolve() { return 'customer'; } }
