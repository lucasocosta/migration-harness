import { Component, Injectable, Input, Output, EventEmitter, inject } from '@angular/core';
import { FormArray, FormControl, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { uniqueEmail } from './validators';

export function emailExists(): boolean { return true; }

export class LegacyToken {}

@Injectable({ providedIn: 'root' })
export class SignupService { endpoint(): string { return '/api/signup'; } }

@Injectable({ providedIn: LegacyToken })
export class TokenService { read(): string { return 'token'; } }

@Component({ selector: 'badge-root', standalone: true, providers: [SignupService], template: '<button type="button" (click)="dismiss()">dismiss</button><p>{{ label }}</p>' })
export class BadgeComponent {
  @Input() label: string = '';
  @Output() dismissed = new EventEmitter<void>();
  dismiss(): void { this.dismissed.emit(); }
}

@Component({ selector: 'signup-root', standalone: true, template: '<form [formGroup]="form" (ngSubmit)="submit()"><input formControlName="nickname"><input type="number" formControlName="age"><input type="email" formControlName="email"><button type="submit" [disabled]="form.invalid">Join</button></form>' })
export class SignupComponent {
  @Input() coupon: string = '';
  @Input('customerName') name: string = 'guest';
  @Output() accepted = new EventEmitter<string>();
  form = new FormGroup({
    nickname: new FormControl('', [Validators.required, Validators.minLength(3)]),
    age: new FormControl(18, [Validators.min(18), Validators.max(120)]),
    email: new FormControl('', Validators.pattern('.+@.+')),
  });
  submit(): void { if (this.form.valid) this.accepted.emit(this.form.getRawValue().nickname); }
}

@Component({ selector: 'audit-root', standalone: true, template: '<form [formGroup]="audit"><input formControlName="email"><button [disabled]="audit.invalid">Send</button></form>' })
export class AuditComponent {
  audit = new FormGroup({ email: new FormControl('', { asyncValidators: [emailExists] }) });
}

@Component({ selector: 'inventory-root', standalone: true, template: '<form [formGroup]="stock"><div formArrayName="rows"></div></form>' })
export class InventoryComponent {
  stock = new FormGroup({ rows: new FormArray([]) });
}

@Component({ selector: 'search-root', standalone: true, template: '<input formControlName="term">' })
export class SearchComponent {
  search = new FormControl('', Validators.required);
  constructor(private readonly http: HttpClient) {}
  watch(): void { this.search.valueChanges.subscribe(term => this.http.get('/api/search?q=' + term)); }
}

@Component({ selector: 'ping-root', standalone: true, template: '<input formControlName="name">' })
export class PingComponent {
  private destroy$ = new Subject<void>();
  profile = new FormGroup({ name: new FormControl('') });
  watch(): void { this.profile.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(values => console.log(values)); }
}

@Component({ selector: 'draft-root', standalone: true, template: '<form [formGroup]="draft"><input formControlName="title"><p>{{ title }}</p></form>' })
export class DraftComponent {
  title = '';
  draft = new FormGroup({ title: new FormControl('') });
  watch(): void { this.draft.valueChanges.subscribe(values => { this.title = values.title; }); }
}

@Component({ selector: 'news-root', standalone: true, template: '<input [(ngModel)]="headline">' })
export class NewsletterComponent {
  @Input() headline: string = '';
}

@Component({ selector: 'checkout-root', standalone: true, template: '<form [formGroup]="order"><input formControlName="item"></form>' })
export class CheckoutComponent {
  fb = inject(FormBuilder);
  order = this.fb.group({ item: new FormControl('', Validators.required) });
}

@Component({ selector: 'review-root', standalone: true, template: '<form [formGroup]="review"><input formControlName="comment"><input formControlName="email"></form>' })
export class ReviewComponent {
  fb = inject(FormBuilder);
  review = this.fb.group({ comment: ['', [Validators.required, Validators.minLength(5)]], email: ['', [Validators.required], [uniqueEmail]] });
}

@Component({ selector: 'draft-order-root', standalone: true, template: '<form [formGroup]="draftOrder"><input formControlName="item"></form>' })
export class DraftOrderComponent {
  fb = inject(FormBuilder);
  defaults = { item: new FormControl('') };
  draftOrder = this.fb.group({ ...this.defaults, note: '' });
}
