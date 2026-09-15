/**
 * AS MINIATURAS QUE NÃO CARREGARAM — lembradas até a rede voltar.
 *
 * O balcão pode ficar sem servidor (G-offline-sync) com a lista da busca na
 * tela, ou o carrinho restaurado. A miniatura que está no cache do navegador
 * continua aparecendo — os arquivos de /uploads/produtos saem com cache
 * imutável —; a que não está falha. Sem memória da falha, cada nova
 * renderização (e o PDV renderiza a cada tecla) pediria de novo o mesmo
 * arquivo, desenhando a imagem quebrada por um instante antes de cair no
 * espaço neutro: o laço de recarga que a tela não pode ter.
 *
 * Aqui a falha fica anotada por URL: a tela vai direto ao espaço neutro, sem
 * pedir outra vez. O evento `online` do navegador esquece tudo — com a rede
 * de volta, cada miniatura tem uma nova chance, uma vez.
 *
 * Mora fora do componente porque arquivo de componente que exporta outra
 * coisa quebra o fast refresh do Vite (ver `pdvTypes.ts`).
 */

const falhas = new Set<string>();
const ouvintes = new Set<() => void>();
let versao = 0;

function avisar(): void {
  versao += 1;
  for (const ouvinte of ouvintes) ouvinte();
}

function aoVoltarARede(): void {
  if (falhas.size === 0) return;
  falhas.clear();
  avisar();
}

/** Para `useSyncExternalStore`: assina as mudanças da lista de falhas. */
export function assinarFalhasDeMiniatura(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  if (ouvintes.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('online', aoVoltarARede);
  }
  return () => {
    ouvintes.delete(ouvinte);
    if (ouvintes.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('online', aoVoltarARede);
    }
  };
}

/** A versão da lista — muda a cada falha anotada ou esquecida. */
export function versaoDasFalhasDeMiniatura(): number {
  return versao;
}

export function miniaturaFalhou(url: string): boolean {
  return falhas.has(url);
}

export function anotarFalhaDeMiniatura(url: string): void {
  if (falhas.has(url)) return;
  falhas.add(url);
  avisar();
}

/** Esquece todas as falhas (o `online` faz isto; os testes também). */
export function esquecerFalhasDeMiniatura(): void {
  falhas.clear();
  avisar();
}
