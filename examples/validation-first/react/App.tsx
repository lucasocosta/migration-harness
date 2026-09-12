import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applicationName } from './existing.mjs';

function App() {
  const [email, setEmail] = useState(''), [saved, setSaved] = useState(false);
  async function save() {
    const response = await fetch('/api/customer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    if (response.ok) { setSaved(true); localStorage.setItem('profile.saved', 'true'); }
  }
  return <><header aria-label="Existing React">{applicationName}</header><main><h1>Customer profile</h1>
    <label htmlFor="email">Email</label><input id="email" type="email" value={email} onChange={event => setEmail(event.target.value)} />
    <button type="button" onClick={save}>Save</button><p role="alert" aria-label="Saved" hidden={!saved}>Saved</p></main></>;
}
createRoot(document.querySelector('harness-root')!).render(<App />);
