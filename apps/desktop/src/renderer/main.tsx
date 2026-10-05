import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './styles/tokens.css';
import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppBody, TitleBar } from './components/TitleBar.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { CallWindowHost } from './features/voice/index.js';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <TitleBar />
    <AppBody>
      <App />
    </AppBody>
    <UpdateBanner />
    {/* The call's mini window while I share my screen: mounted for the page's whole life. */}
    <CallWindowHost />
  </StrictMode>,
);
