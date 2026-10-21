import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../app/globals.css';
import { InfiniteCanvasApplication } from './app/InfiniteCanvasApplication.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Portable application root is missing');

createRoot(root).render(
  <StrictMode>
    <InfiniteCanvasApplication />
  </StrictMode>,
);
