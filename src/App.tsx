import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { AppRoutes } from "./router";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import { useEffect } from "react";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";

// ─── QR Redirect Interceptor ───────────────────────────────────
function QrRedirectInterceptor() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const ficha = params.get('ficha');
    if (ficha && location.pathname === '/') {
      navigate(`/equipamento/${ficha}`, { replace: true });
    }
  }, [location, navigate]);

  return null;
}

function App() {
  return (
    <GlobalErrorBoundary>
      <I18nextProvider i18n={i18n}>
        {/*
          `OfficialSessionBootstrap` saiu daqui. Ele hidratava as caches do
          sistema antigo — usuários, oficinas e OS guardados no navegador — e
          fazia a ponte para a sessão legada. O sistema autentica no servidor
          desde a primeira rodada; o que aquilo carregava não era lido por
          ninguém, e ainda assim rodava a cada abertura do aplicativo.
        */}
        <BrowserRouter basename={__BASE_PATH__}>
          <QrRedirectInterceptor />
          <AppRoutes />
        </BrowserRouter>
      </I18nextProvider>
    </GlobalErrorBoundary>
  );
}

export default App;