/**
 * ============================================================================
 * OS LOGINS PADRÃO DO GRUPO SAMPAIO — a base para ninguém ficar sem entrar
 * ============================================================================
 *
 * Sem o acesso rápido, cada parte do sistema precisa de uma conta de verdade
 * desde o primeiro dia. Estas são as contas oficiais do bootstrap (decisão do
 * dono, 2026-09-13), além do `admin`:
 *
 *   - o PDV de cada operação: o login é o NOME da operação, e a conta é
 *     operadora de caixa daquela empresa e só dela (sem painel do gestor);
 *   - o painel do gestor de cada operação: `ADMIN-<operação>`, gerente daquela
 *     empresa e só dela — administra a própria loja, nenhuma outra;
 *   - as duas bancadas da Oficina, cada uma com o seu escopo operacional:
 *     `OFICINA-PJ MOTORS` é técnico da Oficina de Mobilidade Elétrica (a
 *     bancada da empresa Oficina que atende as motos da PJ Motors), e
 *     `OFICINA-PREÇO JUSTO` é técnico da Oficina de Celulares (a bancada da
 *     Preço Justo). Técnico vê só a bancada de que é membro; nenhum dos dois
 *     administra a empresa.
 *
 * O acesso vem dos MODELOS de sistema (as capabilities e os escopos de cada
 * vínculo), nunca do nome da conta: renomear uma delas não muda o que ela pode.
 *
 * O login é mostrado e digitado como está aqui — com espaço, hífen e acento. A
 * busca aceita maiúsculas/minúsculas e espaços por fora (`chaveDoLogin`); o
 * acento conta.
 *
 * A senha é PROVISÓRIA e vem só de `DEVORA_BOOTSTRAP_LOGINS_PASSWORD`: sem ela,
 * nenhuma destas contas nasce (o `admin` continua pela variável dele). Conta
 * que já existe nunca é tocada — nem senha, nem vínculo, nem personalização.
 */

export const VARIAVEL_DA_SENHA_DOS_LOGINS = 'DEVORA_BOOTSTRAP_LOGINS_PASSWORD';

export type PapelDoLoginPadrao = 'pdv' | 'gestor' | 'oficina';

export interface LoginPadrao {
  /** O login e o nome mostrado — exatamente como o dono definiu. */
  readonly login: string;
  /** O slug da empresa (as seis de `EMPRESAS_DO_GRUPO`). */
  readonly empresa: string;
  /** O modelo de sistema do vínculo. */
  readonly modelo: string;
  /** Técnico de oficina: o slug da bancada de que é membro. */
  readonly bancada?: string;
  readonly papel: PapelDoLoginPadrao;
}

export const LOGINS_PADRAO: readonly LoginPadrao[] = [
  { login: 'PREÇO JUSTO', empresa: 'preco-justo', modelo: 'operador_caixa_loja', papel: 'pdv' },
  { login: 'ME MIMEI', empresa: 'me-mimei', modelo: 'operador_caixa_loja', papel: 'pdv' },
  { login: 'GRINGA', empresa: 'gringa', modelo: 'operador_caixa_loja', papel: 'pdv' },
  { login: 'CONCEITO', empresa: 'conceito', modelo: 'operador_caixa_loja', papel: 'pdv' },
  { login: 'PJ MOTORS', empresa: 'pj-motors', modelo: 'operador_caixa_loja', papel: 'pdv' },
  { login: 'OFICINA', empresa: 'oficina', modelo: 'operador_caixa_oficina', papel: 'pdv' },

  { login: 'ADMIN-PREÇO JUSTO', empresa: 'preco-justo', modelo: 'gerente_loja', papel: 'gestor' },
  { login: 'ADMIN-ME MIMEI', empresa: 'me-mimei', modelo: 'gerente_loja', papel: 'gestor' },
  { login: 'ADMIN-GRINGA', empresa: 'gringa', modelo: 'gerente_loja', papel: 'gestor' },
  { login: 'ADMIN-CONCEITO', empresa: 'conceito', modelo: 'gerente_loja', papel: 'gestor' },
  { login: 'ADMIN-PJ MOTORS', empresa: 'pj-motors', modelo: 'gerente_loja', papel: 'gestor' },
  { login: 'ADMIN-OFICINA', empresa: 'oficina', modelo: 'gerente_oficina', papel: 'gestor' },

  { login: 'OFICINA-PJ MOTORS', empresa: 'oficina', modelo: 'mecanico', bancada: 'oficina-mobilidade', papel: 'oficina' },
  { login: 'OFICINA-PREÇO JUSTO', empresa: 'preco-justo', modelo: 'mecanico', bancada: 'oficina-celulares', papel: 'oficina' },
];
