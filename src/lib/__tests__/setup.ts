import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { afterAll } from 'vitest';
import { configure } from '@testing-library/react';

// Required for React 19 act() in vitest/jsdom render tests
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
  ============================================================================
  O ORÇAMENTO DAS ESPERAS DA TELA: 5 s, E NÃO 1 s
  ============================================================================

  `waitFor` e `findBy*` desistem, por padrão, em 1 s — um número calibrado
  para uma máquina OCIOSA. Na suíte inteira, com os forks disputando os
  núcleos, esperas por condições CERTAS (a marca que a resposta desenha, a
  tela de venda concluída com o foco dentro, a nota que voltou autorizada, a
  entrada estornada) levaram de 1,1 s a 2,2 s, e só não caíam porque o próprio
  relógio do `waitFor` também ficava sem vez de rodar.

  O orçamento é UM, para a suíte inteira, dimensionado para a máquina
  saturada; o `testTimeout` de 30 s continua sendo quem pega travamento.

  ORÇAMENTO NÃO CONSERTA CORRIDA. Corrida é o teste esperar uma coisa e ler
  outra de forma síncrona logo depois: nenhuma espera maior salva a leitura
  que acontece antes de o dado chegar. Provado assim: com este orçamento,
  desfazer um dos consertos de corrida do 97f8aad (filaFiscalNaTela) deixa o
  teste vermelho sob o detector do mesmo jeito. Espera que precise de mais de
  5 s é defeito a investigar, não número a aumentar.
*/
configure({ asyncUtilTimeout: 5_000 });

/*
  ============================================================================
  O ARQUIVO SÓ ACABA DEPOIS DO ÚLTIMO RENDER QUE O REACT AGENDOU
  ============================================================================

  Toda atualização de estado fora do `act` — a resposta de um `fetch` — o
  React desenha numa tarefa do agendador (`scheduler`), e depois de cada
  commit agenda mais uma, a dos efeitos passivos. A primeira coisa que essa
  tarefa faz é ler `window.event`. Quando o último caso de um arquivo termina
  com uma dessas na fila, o Vitest desmonta o jsdom antes de ela rodar, e ela
  estoura "ReferenceError: window is not defined" como erro solto da suíte,
  sem apontar caso nenhum. Sob o detector que adia o setImmediate apareceu em
  turnosDoCaixa, pdvRecusasDoFinalizar, entrarComGoogle, vendaConcluidaEstados
  e outros — sempre no último caso, e só quando ele acaba colado no último
  commit.

  O `afterAll` abaixo entra na FILA do próprio agendador com a prioridade mais
  baixa (Idle): só roda quando todas as tarefas que o React já agendou — e as
  que elas agendarem — tiverem rodado. Não é pausa por relógio: é esperar a
  fila esvaziar. Nenhuma asserção muda; muda só que o jsdom vai embora DEPOIS
  do último render. O agendador vem pelo mesmo `require` que o react-dom usa
  (sem cópia aninhada), para ser a mesma fila.
*/
const agendador = createRequire(import.meta.url)('scheduler') as {
  unstable_scheduleCallback: (prioridade: number, tarefa: () => null) => unknown;
  unstable_IdlePriority: number;
};
afterAll(
  () =>
    new Promise<void>((filaVazia) => {
      agendador.unstable_scheduleCallback(agendador.unstable_IdlePriority, () => {
        filaVazia();
        return null;
      });
    }),
);

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
