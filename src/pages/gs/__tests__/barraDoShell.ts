/**
 * A barra de conexão do AppShell (`EstadoConexao`, GAP-PRD-045/046) pergunta, em
 * TODA tela, quantas vendas guardadas o servidor recusou. As telas se montam
 * dentro do AppShell, então essa pergunta vai para o `fetch` de mentira de cada
 * teste de tela — que responde pela tela, com o corpo da tela.
 *
 * Esta é a resposta do servidor de verdade quando não há recusa: lista vazia, e
 * a barra não aparece. Ela fica FORA do registro de chamadas do teste, para que
 * "a primeira requisição" e "quantas vezes perguntou" continuem falando da tela.
 */
export function respostaDaBarraDoShell(url: string | URL | Request): Response | null {
  if (!String(url).includes('/core/offline-sales')) return null;
  return new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
