/**
 * ============================================================================
 * O PORTAL SÓ PROMETE O E-MAIL QUE VAI CHEGAR (GAP-PRD-200)
 * ============================================================================
 *
 * O QUE ERA: "Se houver uma conta com esse e-mail, enviamos um link para
 * redefinir a senha" — sempre, com o carteiro desligado (`EMAIL_ENABLED=false`
 * no servidor da loja). O pedido entrava na fila, o link vencia em uma hora
 * sem sair, e o cliente esperava um e-mail que não vinha. O mesmo com o
 * código de confirmação ("Código novo enviado") — e sem o código a conta não
 * puxa as compras pelo CPF.
 *
 * O QUE É: a frase depende de o envio estar LIGADO de verdade
 * (`carteiroConfigurado`, lido ao vivo). E continua NEUTRA quanto à conta: a
 * mesma resposta para e-mail com conta e sem conta — o que muda é só o estado
 * do envio da loja, que é igual para todo mundo. Dizer "não enviamos porque
 * não há conta" entregaria a lista de clientes.
 *
 * O CAMINHO MANUAL QUE EXISTE: o código de convite do balcão
 * (`POST /core/customers/:id/convite-portal`). A loja entrega o papel, e o
 * cliente o usa em Minha conta › Meus equipamentos — liga o cadastro dele à
 * conta sem precisar do código por e-mail. Para a SENHA não há atalho no
 * balcão, de propósito: um código de redefinição emitido pelo gerente seria o
 * mesmo sequestro de conta que o GAP-PRD-007 fechou. Sem o envio ligado, o
 * portal diz a verdade — tente mais tarde.
 */
import { carteiroConfigurado } from './EmailService.js';

export interface PromessaDoEnvio {
  /** O envio de e-mails da loja está ligado agora? (o mesmo para todo cliente) */
  envioDeEmailAtivo: boolean;
  message: string;
}

export const ENVIO_DESLIGADO =
  'O envio de e-mails da loja ainda está sendo ativado.';

/** A resposta de "Esqueci minha senha" — igual exista a conta ou não. */
export function promessaDaRecuperacao(): PromessaDoEnvio {
  const ativo = carteiroConfigurado();
  return {
    envioDeEmailAtivo: ativo,
    message: ativo
      ? 'Se houver uma conta com esse e-mail, enviamos um link para redefinir a senha. '
        + 'Confira sua caixa de entrada e o spam — o link vale por 1 hora.'
      : `${ENVIO_DESLIGADO} Por enquanto o link de redefinição de senha não chega por e-mail. `
        + 'Tente de novo mais tarde.',
  };
}

/** A resposta de "Enviar código" na confirmação do e-mail. */
export function promessaDoCodigo(): PromessaDoEnvio {
  const ativo = carteiroConfigurado();
  return {
    envioDeEmailAtivo: ativo,
    message: ativo
      ? 'Código novo enviado. Olhe também a caixa de spam — ele vale por 1 hora.'
      : `${ENVIO_DESLIGADO} Por enquanto o código não chega por e-mail. `
        + 'Para trazer suas compras agora, peça na loja o código de convite e use em '
        + 'Minha conta › Meus equipamentos.',
  };
}

/** O que o portal mostra ANTES do clique — sem sessão, sem conta, igual para todos. */
export function situacaoDoEnvio(): { envioDeEmailAtivo: boolean; message: string | null } {
  const ativo = carteiroConfigurado();
  return {
    envioDeEmailAtivo: ativo,
    message: ativo
      ? null
      : `${ENVIO_DESLIGADO} Links e códigos por e-mail ainda não chegam. `
        + 'Para trazer suas compras agora, peça na loja o código de convite.',
  };
}
