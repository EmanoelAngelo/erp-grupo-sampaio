/**
 * Entregar ao navegador um arquivo que JÁ está na memória.
 *
 * ## Por que existe um passo entre buscar e salvar
 *
 * O caminho óbvio para baixar um arquivo é um `<a href>` apontando para a
 * rota. Aqui ele não funciona, e o motivo é estrutural: `authMiddleware` lê o
 * token SÓ do cabeçalho `Authorization` — não há cookie nem `?token=` — e uma
 * navegação disparada por link ou por `window.open` não manda cabeçalho
 * nenhum. O resultado é 401 no lugar do arquivo, que foi exatamente o defeito
 * que a janela de impressão do PDV carregou por rodadas: a janela abria e
 * mostrava "autenticação obrigatória" em vez do cupom.
 *
 * Então o arquivo é buscado por `apiBinary` (com o Bearer), vira `Blob`, e é
 * só aí que ele ganha um endereço — `blob:`, local, que não passa por rota
 * nenhuma e por isso não precisa de token.
 *
 * ## O `revokeObjectURL` não é higiene: é vazamento
 *
 * Cada `createObjectURL` prende o Blob inteiro na memória da aba até alguém
 * soltar, e o pacote do contador pode ter dezenas de megabytes. Quem baixa o
 * mês de janeiro, fevereiro e março sem recarregar a página estaria com os
 * três presos ao mesmo tempo.
 *
 * A soltura fica no `setTimeout` porque revogar na linha seguinte ao clique
 * chega cedo demais: em vários navegadores o download ainda não leu o
 * endereço, e o arquivo sai vazio ou nem sai.
 */

/** Sobra generosa para o navegador começar a leitura antes de soltarmos o Blob. */
const FOLGA_ANTES_DE_SOLTAR_MS = 60_000;

/**
 * Salva o arquivo na pasta de downloads, com o nome que a API deu.
 *
 * Recebe o `Blob` pronto, e não um caminho de rota, porque quem chama já
 * precisou tratar o erro da requisição — 404 de nota sem XML e 413 de pacote
 * grande demais são mensagens diferentes na tela, e escondê-las dentro de um
 * utilitário de download as transformaria todas em "falha ao baixar".
 */
export function salvarArquivo(blob: Blob, nomeArquivo: string): void {
  const endereco = URL.createObjectURL(blob);
  const ancora = document.createElement('a');
  ancora.href = endereco;
  ancora.download = nomeArquivo;
  // Fora do documento o clique não dispara em parte dos navegadores; entrar e
  // sair é o que faz o gesto valer sem a âncora nunca aparecer na tela.
  document.body.appendChild(ancora);
  ancora.click();
  ancora.remove();
  setTimeout(() => URL.revokeObjectURL(endereco), FOLGA_ANTES_DE_SOLTAR_MS);
}
