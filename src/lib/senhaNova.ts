/**
 * A conferência da senha nova que a TELA consegue fazer sem o servidor
 * (GAP-PRD-192): comprimento e as duas digitações iguais. A lista das senhas
 * mais usadas mora no servidor (`PoliticaDoCadastro`), que recusa com a frase
 * que a tela mostra. Ver `components/gs/SenhaNova`.
 */
export const SENHA_MIN = 8;
export const SENHA_MAX = 128;

/** O que impede de enviar, ou `null`. */
export function problemaDaSenhaNova(senha: string, confirmacao: string): string | null {
  if (senha.length < SENHA_MIN) return `A senha precisa de pelo menos ${SENHA_MIN} caracteres.`;
  if (senha.length > SENHA_MAX) return `A senha pode ter no máximo ${SENHA_MAX} caracteres.`;
  if (senha !== confirmacao) return 'As duas senhas não são iguais. Digite a mesma senha nos dois campos.';
  return null;
}
