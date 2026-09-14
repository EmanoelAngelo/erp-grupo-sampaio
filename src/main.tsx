import { StrictMode } from 'react'
import './i18n'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

/*
 * Service worker: guarda a CASCA para a tela abrir sem servidor.
 *
 * Registrado só em produção. Em desenvolvimento ele atrapalharia o recarregar
 * do Vite, servindo módulo antigo e fazendo parecer que a edição não teve
 * efeito.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sem service worker o sistema segue funcionando com servidor de pé.
      // Falhar aqui não pode impedir o aplicativo de abrir.
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
