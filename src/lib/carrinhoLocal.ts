/**
 * O carrinho guardado NO NAVEGADOR, e de quem ele é (GAP-PRD-193).
 *
 * A vitrine e a página do produto gravam o carrinho em `gs.loja.carrinho`.
 * Desde que o carrinho de quem entrou mora na conta, o navegador também
 * lembra DE QUAL CONTA é a cópia que ele guarda (`gs.loja.carrinho.conta`):
 *
 *   - mesma conta → o servidor é a verdade (o outro aparelho pode ter mudado);
 *   - outra conta, ou nenhuma → o carrinho do aparelho se FUNDE na conta.
 *
 * "Sair" de propósito esquece a cópia (ela está guardada na conta); a sessão
 * que VENCE não esquece nada — o carrinho continua na tela para quem entrar
 * de novo, e aí se funde.
 */
export const CHAVE_DO_CARRINHO = 'gs.loja.carrinho';
const CHAVE_DO_DONO = 'gs.loja.carrinho.conta';
/** Avisa a vitrine aberta que o carrinho foi esquecido (saiu da conta). */
export const CARRINHO_ESQUECIDO = 'gs:carrinho-esquecido';

export function donoDoCarrinhoLocal(): string | null {
  try {
    return localStorage.getItem(CHAVE_DO_DONO);
  } catch {
    return null;
  }
}

export function marcarDonoDoCarrinho(accountId: string | null): void {
  try {
    if (accountId) localStorage.setItem(CHAVE_DO_DONO, accountId);
    else localStorage.removeItem(CHAVE_DO_DONO);
  } catch {
    // Sem storage não há cópia a marcar.
  }
}

/**
 * Sair da conta DE PROPÓSITO: a cópia do carrinho da conta sai do aparelho
 * (ela continua guardada na conta). Num computador compartilhado, o próximo
 * a entrar não herda o carrinho de quem saiu.
 */
export function esquecerCarrinhoDaConta(): void {
  let eraDaConta = false;
  try {
    eraDaConta = Boolean(localStorage.getItem(CHAVE_DO_DONO));
    if (eraDaConta) localStorage.removeItem(CHAVE_DO_CARRINHO);
    localStorage.removeItem(CHAVE_DO_DONO);
  } catch {
    // idem
  }
  // Carrinho que nunca foi da conta (montado sem entrar) fica onde está.
  if (!eraDaConta) return;
  try {
    window.dispatchEvent(new Event(CARRINHO_ESQUECIDO));
  } catch {
    // Fora do navegador não há vitrine aberta.
  }
}
