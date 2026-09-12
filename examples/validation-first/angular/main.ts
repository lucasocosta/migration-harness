import 'zone.js';
import '@angular/compiler';
import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

@Component({ selector: 'harness-root', standalone: true, template: `
  <main><h1>Customer profile</h1><label for="email">Email</label>
  <input id="email" type="email" [value]="email" (input)="email = $any($event.target).value" />
  <button type="button" (click)="save()">Save</button>
  <p role="alert" aria-label="Saved" [hidden]="!saved">Saved</p></main>` })
class Profile {
  email = ''; saved = false;
  async save(): Promise<void> {
    const response = await fetch('/api/customer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email }) });
    if (response.ok) { this.saved = true; localStorage.setItem('profile.saved', 'true'); }
  }
}
void bootstrapApplication(Profile);
