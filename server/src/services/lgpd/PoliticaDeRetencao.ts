/**
 * ============================================================================
 * O QUE O SISTEMA GUARDA DE GENTE, E POR QUANTO TEMPO (GAP-PRD-073)
 * ============================================================================
 *
 * A LGPD pede que o término do tratamento tenha regra (arts. 15 e 16), e que
 * o titular possa saber o que se guarda dele (art. 18, I e II; art. 9º). Até
 * aqui a regra existia espalhada e muda: a poda das tentativas de login num
 * canto, a do registro de requisições em outro, a trilha de auditoria sem
 * poda nenhuma — e nada disso aparecia para quem responde pelo pedido.
 *
 * Esta lista é a DECLARAÇÃO. Ela é lida em dois lugares — a tela de Clientes
 * (para a gerência responder ao titular) e o documento da exportação (para o
 * titular saber o que fica depois de uma anonimização) — e os prazos que têm
 * poda automática vêm das MESMAS constantes que a poda usa. Mudar o prazo no
 * código muda a frase; não existe uma segunda cópia para envelhecer.
 *
 * As bases legais estão escritas em linguagem de balcão e são o ponto de
 * partida da política da empresa, não parecer jurídico: o dono pode (e deve)
 * pedir que o jurídico ou o contador as confirmem.
 */
import { ACCESS_TOKEN_TTL_SECONDS } from '../api/ApiAuthService.js';
import { RETENCAO_DO_REQUEST_LOG_DIAS } from '../api/ApiIdempotencyService.js';
import { REFRESH_TTL_MS, RETENCAO_DAS_TENTATIVAS_MS } from '../api/SessoesDeApi.js';
import { RETENCAO_DA_AUDITORIA_ANOS } from '../audit/RetencaoDaAuditoria.js';

export interface RegraDeRetencao {
  /** Identificador estável (nome da tabela quando há uma só). */
  chave: string;
  /** O que é guardado, em palavras de quem opera. */
  oQue: string;
  /** Por quanto tempo. */
  prazo: string;
  /** Por que se guarda. */
  base: string;
  /** O que acontece no fim do prazo, ou a pedido do titular. */
  destino: string;
}

const horas = (ms: number) => `${Math.round(ms / 3_600_000)} horas`;
const dias = (ms: number) => `${Math.round(ms / 86_400_000)} dias`;

export const POLITICA_DE_RETENCAO: readonly RegraDeRetencao[] = [
  {
    chave: 'core_customers',
    oQue: 'Cadastro do cliente: nome, CPF/CNPJ, telefone, e-mail, endereço e observações',
    prazo: 'Enquanto houver relacionamento com a operação, ou até o pedido do titular',
    base: 'Execução de contrato e procedimentos preliminares (art. 7º, V)',
    destino:
      'Anonimizado a pedido, em Cadastros › Clientes › Direitos do titular. A linha fica para o histórico apontar para ela; os dados de contato saem.',
  },
  {
    chave: 'documentos_fiscais',
    oQue: 'NFC-e e NF-e emitidas — o XML autorizado, com o CPF/CNPJ do destinatário quando informado',
    prazo: '5 anos',
    base: 'Obrigação legal (art. 7º, II; art. 16, I) — guarda fiscal (CTN, arts. 173 e 174)',
    destino: 'Mantidos. O XML autorizado não é alterado nem pela anonimização.',
  },
  {
    chave: 'vendas_e_financeiro',
    oQue: 'Vendas, orçamentos, ordens de serviço, títulos e crédito de loja ligados ao cliente',
    prazo: '5 anos',
    base: 'Obrigação legal e contábil (art. 16, I) e exercício regular de direitos (art. 7º, VI)',
    destino: 'Mantidos. Depois da anonimização passam a apontar para o cadastro anonimizado.',
  },
  {
    chave: 'pedidos_online',
    oQue: 'Pedidos da loja online: nome, e-mail, documento e endereço de entrega',
    prazo: '5 anos',
    base: 'Obrigação fiscal (art. 16, I) e defesa em reclamação de consumo (CDC, art. 27)',
    destino: 'Mantidos pelo prazo; a anonimização do cadastro não os altera.',
  },
  {
    chave: 'core_audit_log',
    oQue: 'Trilha de auditoria: quem fez o quê, em qual cadastro, e quando',
    prazo: `${RETENCAO_DA_AUDITORIA_ANOS} anos`,
    base: 'Obrigação legal e exercício regular de direitos (art. 7º, II e VI; art. 37)',
    destino: 'Apagada automaticamente depois do prazo.',
  },
  {
    chave: 'core_login_attempts',
    oQue: 'Tentativas de login da equipe: login digitado, IP de origem e resultado',
    prazo: horas(RETENCAO_DAS_TENTATIVAS_MS),
    base: 'Segurança da conta — bloqueio por tentativas (art. 7º, IX; art. 46)',
    destino: 'Apagadas automaticamente depois do prazo.',
  },
  {
    chave: 'api_sessions',
    oQue: 'Sessões de acesso da equipe (usuário, perfil, validade)',
    prazo: `Até vencer ou ser encerrada — no máximo ${dias(REFRESH_TTL_MS)}`,
    base: 'Segurança da conta (art. 46)',
    destino: 'Apagadas automaticamente quando vencem ou são revogadas.',
  },
  {
    chave: 'core_tokens_revogados',
    oQue: 'Acessos encerrados da equipe (saída, troca de operação, renovação): identificador aleatório do acesso, usuário, operação e horário',
    prazo: `Até o acesso encerrado vencer — no máximo ${ACCESS_TOKEN_TTL_SECONDS / 60} minutos`,
    base: 'Segurança da conta (art. 46)',
    destino: 'Apagadas automaticamente depois do vencimento, na poda das sessões e a cada nova gravação; vencidas, não autorizam nada.',
  },
  {
    chave: 'api_request_logs',
    oQue: 'Registro de requisições: método, caminho, status e data — sem dado pessoal',
    prazo: `${RETENCAO_DO_REQUEST_LOG_DIAS} dias`,
    base: 'Segurança e diagnóstico (art. 46)',
    destino: 'Apagado automaticamente depois do prazo.',
  },
];
