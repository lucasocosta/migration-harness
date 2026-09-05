import { Component } from '@angular/core';

@Component({
  selector: 'harness-root',
  standalone: true,
  template: `
    <main>
      <h1>Customer profile</h1>
      <label for="email">Email</label>
      <input id="email" type="email" [value]="email" (input)="setEmail($event)" />
      <button type="button" (click)="save()">Save</button>
      <p role="alert" aria-label="Saved" [hidden]="!saved">Saved</p>
    </main>
  `,
})
export class CustomerProfileComponent {
  email = 'customer@example.test';
  saved = false;

  setEmail(event: Event): void {
    this.email = (event.target as HTMLInputElement).value;
  }

  async save(): Promise<void> {
    const response = await fetch('/api/customers/123', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email }),
    });
    if (response.status === 204) {
      localStorage.setItem('profile.saved', 'true');
      this.saved = true;
    }
  }
}
