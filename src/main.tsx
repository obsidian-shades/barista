import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import * as store from './store';
import './styles.css';

// Dev-only handles for the browser console and the UI checks: the same store the app renders from.
if (import.meta.env.DEV) {
  const w = window as unknown as { __barista?: typeof store.useApp; __baristaAPI?: typeof store };
  w.__barista = store.useApp;
  w.__baristaAPI = store;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
