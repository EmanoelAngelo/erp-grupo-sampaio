/**
 * "Esqueci minha senha" da equipe — cliente (GAP-PRD-160).
 *
 * As rotas de `/auth/senha/*` são públicas (quem as usa não tem sessão) e
 * nunca dizem se uma conta existe. As de `/core/team/recuperacao-de-senha`
 * são do dono: ligar ou desligar a recuperação por e-mail nesta operação.
 */
import { apiRequest, exigirCampos } from '@/lib/api/client';

export interface RecuperacaoDaOperacao {
  emailLigado: boolean;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
  /** O SMTP está configurado? Sem ele, o código espera na fila. */
  carteiroPronto: boolean;
  /** O que falta no SMTP, nas palavras que o servidor usa. */
  faltaNoCarteiro: string[];
}

/**
 * Contrato conferido na borda: um corpo sem `faltaNoCarteiro` (versão da tela
 * diferente da do servidor) vira `API_CONTRACT_BROKEN`, que o cartão já trata,
 * em vez de `undefined.length` apagando a tela de Usuários e equipe.
 */
function conferirRecuperacao(corpo: RecuperacaoDaOperacao | undefined | null): RecuperacaoDaOperacao {
  return exigirCampos(corpo, 'emailLigado', 'atualizadoEm', 'atualizadoPor', 'carteiroPronto', 'faltaNoCarteiro');
}

export const recuperacaoApi = {
  /** A tela de login deve oferecer o caminho? Falha de rede = não oferece. */
  disponivel: (): Promise<boolean> =>
    apiRequest<{ disponivel: boolean }>('/auth/senha/recuperacao', { anonymous: true })
      .then((r) => r?.disponivel === true)
      .catch(() => false),

  pedirCodigo: (identificador: string) =>
    apiRequest<{ ok: boolean; mensagem: string }>('/auth/senha/esqueci', {
      method: 'POST',
      anonymous: true,
      body: { identificador },
    }),

  recuperar: (input: { identificador: string; codigo: string; novaSenha: string }) =>
    apiRequest<{ ok: boolean }>('/auth/senha/recuperar', {
      method: 'POST',
      anonymous: true,
      body: input,
    }),

  daOperacao: () =>
    apiRequest<RecuperacaoDaOperacao>('/core/team/recuperacao-de-senha').then(conferirRecuperacao),

  definir: (emailLigado: boolean) =>
    apiRequest<RecuperacaoDaOperacao>('/core/team/recuperacao-de-senha', {
      method: 'PUT',
      body: { emailLigado },
    }).then(conferirRecuperacao),
};
