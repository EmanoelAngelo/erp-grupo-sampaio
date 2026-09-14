import 'fake-indexeddb/auto';

// Required for React 19 act() in vitest/jsdom render tests
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
  ============================================================================
  A SUÍTE DE TELA NÃO SAI PARA A REDE
  ============================================================================

  O cliente HTTP deriva a API de `host:8787` quando `VITE_API_BASE_URL` não
  existe, e no jsdom o host é `localhost`. Teste cujo dublê de `fetch` não
  cobria uma rota fazia a requisição DE VERDADE — e, na máquina da loja, quem
  responde em `localhost:8787` é a API de produção, que grava cada requisição no
  banco operacional. A auditoria de prontidão mediu isso: 48 linhas em
  `api_request_logs` do banco real vieram de testes de tela (GAP-PRD-135).

  A partir daqui, `fetch` e `XMLHttpRequest` reais não existem na suíte. Quem
  precisa de resposta troca o `fetch` por um dublê (`vi.spyOn`, `vi.stubGlobal`
  ou atribuição direta); quem esquece recebe `TypeError` — o mesmo que o
  navegador devolve quando a rede cai —, nunca uma resposta de produção.
*/
const REDE_BLOQUEADA =
  'Rede real bloqueada na suíte de tela: dublê o fetch deste teste (a porta 8787 desta máquina é a API de produção).';

function urlDe(entrada: unknown): string {
  if (typeof entrada === 'string') return entrada;
  if (entrada instanceof URL) return entrada.href;
  if (entrada && typeof entrada === 'object' && 'url' in entrada) return String((entrada as { url: unknown }).url);
  return String(entrada);
}

export const fetchBloqueado = (async (entrada: unknown) => {
  throw new TypeError(`${REDE_BLOQUEADA} (${urlDe(entrada)})`);
}) as typeof fetch;

globalThis.fetch = fetchBloqueado;
if (typeof window !== 'undefined') window.fetch = fetchBloqueado;

if (typeof XMLHttpRequest !== 'undefined') {
  XMLHttpRequest.prototype.send = function send(): void {
    throw new TypeError(REDE_BLOQUEADA);
  };
}
