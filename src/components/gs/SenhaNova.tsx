/**
 * A SENHA NOVA, COM CONFIRMAÇÃO — criar conta, redefinir pelo link e trocar
 * na conta (GAP-PRD-192).
 *
 * As três telas pediam a senha uma vez só: um dedo escorregado no celular
 * criava uma senha que a pessoa não sabia qual era, e o único caminho de
 * volta era a recuperação por e-mail. Aqui a senha é digitada duas vezes e a
 * tela confere ANTES de enviar.
 *
 * A tela confere só o que dá para conferir sem o servidor (as duas iguais, e
 * o comprimento). A lista das senhas mais usadas mora no servidor
 * (`PoliticaDoCadastro`), que recusa com a frase que esta tela mostra.
 */

import { SENHA_MAX, SENHA_MIN } from '@/lib/senhaNova';

const CAMPO = 'px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]';

export function SenhaNovaComConfirmacao({
  senha,
  confirmacao,
  onSenha,
  onConfirmacao,
  rotulo = 'Senha',
  rotuloConfirmacao = 'Confirme a senha',
}: {
  senha: string;
  confirmacao: string;
  onSenha: (valor: string) => void;
  onConfirmacao: (valor: string) => void;
  rotulo?: string;
  rotuloConfirmacao?: string;
}) {
  const diferentes = confirmacao.length > 0 && confirmacao !== senha;
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-[length:var(--gs-text-sm)] font-semibold">{rotulo}</span>
        <input
          required
          type="password"
          autoComplete="new-password"
          aria-label={rotulo}
          minLength={SENHA_MIN}
          maxLength={SENHA_MAX}
          value={senha}
          onChange={(e) => onSenha(e.target.value)}
          className={CAMPO}
        />
        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Mínimo de {SENHA_MIN} caracteres. Evite as óbvias (12345678, senha123, o nome do time):
          uma frase curta que só você conheça é mais forte e mais fácil de lembrar.
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[length:var(--gs-text-sm)] font-semibold">{rotuloConfirmacao}</span>
        <input
          required
          type="password"
          autoComplete="new-password"
          aria-label={rotuloConfirmacao}
          aria-invalid={diferentes || undefined}
          value={confirmacao}
          onChange={(e) => onConfirmacao(e.target.value)}
          className={CAMPO}
        />
        {diferentes && (
          <span role="status" className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">
            As duas senhas ainda não são iguais.
          </span>
        )}
      </label>
    </>
  );
}
