/**
 * Filtro de listagem — o tipo e a regra, sem interface.
 *
 * Mora fora de `ui.tsx` porque lá só entram componentes: misturar função pura
 * com componente no mesmo módulo quebra o Fast Refresh, e o lint recusa. A
 * separação também é honesta — isto aqui é regra de dado, roda sem React e é
 * testável sem montar tela nenhuma.
 */

/** Um campo que a listagem aceita filtrar. */
export interface CampoFiltravel {
  campo: string;
  rotulo: string;
  /** Ausente = campo livre, digitado. Presente = escolha fechada. */
  opcoes?: { valor: string; rotulo: string }[];
}

/** Um filtro que o usuário aplicou. */
export interface FiltroAtivo {
  campo: string;
  valor: string;
}

/**
 * Aplica os filtros ativos a uma lista.
 *
 * Comparação por texto, sem diferenciar maiúscula nem acento — quem digita
 * "camara" espera achar "Câmara". Filtro que exige grafia exata é filtro que o
 * usuário conclui estar quebrado.
 *
 * O intervalo `[̀-ͯ]` são as marcas de acento que o `NFD` separa da
 * letra. Escrevê-lo errado já custou caro uma vez: um escape mal formado virou
 * um intervalo que apagava DÍGITOS do valor comparado, e buscar por código
 * passava a casar com qualquer coisa. `filtros.test.ts` cobre esse caso.
 */
export function aplicarFiltros<T>(
  itens: T[],
  ativos: FiltroAtivo[],
  ler: (item: T, campo: string) => unknown,
): T[] {
  if (ativos.length === 0) return itens;
  const normalizar = (v: unknown) =>
    String(v ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  return itens.filter((item) =>
    ativos.every((f) => normalizar(ler(item, f.campo)).includes(normalizar(f.valor))),
  );
}
