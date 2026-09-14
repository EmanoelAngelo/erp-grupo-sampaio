/**
 * ============================================================================
 * O QUE FALTA PARA AS COMUNICAÇÕES DESTA EMPRESA FUNCIONAREM (GAP-PRD-130)
 * ============================================================================
 *
 * O e-mail ao cliente, o pacote mensal do contador e a entrada de NF-e por
 * e-mail já estão programados: montam, enfileiram, agendam. O que falta em
 * cada empresa é CONFIGURAÇÃO — a senha SMTP no `.env`, o endereço do
 * escritório de contabilidade, a agenda do dia 1, o usuário do contador, a
 * senha de aplicativo da caixa de notas.
 *
 * O problema que a auditoria viu não era falta de mecanismo: era não haver UM
 * lugar que dissesse, por empresa, o que está faltando. A fila acumulava
 * (1 pagamento_confirmado da Gringa desde 16/08), nenhuma das seis tinha
 * destinatário do contador nem usuário contador, e isso só aparecia abrindo
 * três telas e uma consulta ao banco.
 *
 * Esta é a lista. Cada item diz o que se vê, o que fazer, quem fornece o
 * insumo e onde. Nada aqui muda estado: é leitura, da empresa do token.
 *
 * Tudo que ela aponta como "falta" se resolve SEM programação — é o critério
 * de "configuração externa": com o insumo em mãos, nenhuma linha de código.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { emailStatus } from './EmailService.js';
import { lerIdentidade } from './IdentidadeDoRemetente.js';
import { agendaDoContador, listarDestinatarios } from '../core/ContadorEnvioService.js';
import { getInboxStatus } from '../core/MailInboxService.js';
import { getSchedulerSettings } from '../core/MailInboxScheduler.js';

export type SituacaoDoItem = 'ok' | 'falta' | 'opcional';

export type ChaveDoItem =
  | 'carteiro'
  | 'fila'
  | 'remetente'
  | 'contador_destinatario'
  | 'contador_agenda'
  | 'contador_usuario'
  | 'caixa_nfe';

/** Quem fornece o que falta. */
export type QuemFornece = 'dono' | 'gerente' | 'contador';

export interface ItemDaProntidao {
  chave: ChaveDoItem;
  rotulo: string;
  situacao: SituacaoDoItem;
  /** O que o sistema vê agora. */
  detalhe: string;
  /** O passo seguinte — nulo quando está tudo certo. */
  oQueFazer: string | null;
  quem: QuemFornece | null;
  /** A tela onde se resolve (caminho do ERP) ou o lugar fora dele. */
  onde: { rotulo: string; caminho: string | null } | null;
}

export interface ProntidaoDasComunicacoes {
  companyId: string;
  /** Nenhum item obrigatório faltando. */
  pronto: boolean;
  faltam: number;
  itens: ItemDaProntidao[];
}

const FILA = { rotulo: 'E-mails para o cliente', caminho: '/sistema/loja/emails' };
const FECHAMENTO = { rotulo: 'Fiscal › Fechamento do contador', caminho: '/sistema/fiscal/fechamento' };
const EQUIPE = { rotulo: 'Usuários e equipe', caminho: '/sistema/usuarios' };
const CAIXA = { rotulo: 'Compras › NF-e por e-mail', caminho: '/sistema/compras/nfe-email' };

function diaBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function itemDoCarteiro(companyId: string): ItemDaProntidao[] {
  const status = emailStatus(companyId);
  const maisAntiga = getConnection()
    .prepare(
      `SELECT MIN(created_at) AS desde FROM core_email_queue
        WHERE company_id = ? AND status = 'pending'`,
    )
    .get(companyId) as { desde: string | null } | undefined;
  const esperando =
    status.pending > 0
      ? ` ${status.pending} mensagem(ns) desta empresa esperam na fila (a mais antiga desde ${diaBR(maisAntiga?.desde)}) e saem sozinhas quando ele ligar.`
      : ' Nenhuma mensagem desta empresa está esperando.';

  const carteiro: ItemDaProntidao =
    status.missing.length === 0
      ? {
          chave: 'carteiro',
          rotulo: 'Envio de e-mail (SMTP)',
          situacao: 'ok',
          detalhe: 'O carteiro está ligado: as mensagens saem a cada minuto.',
          oQueFazer: null,
          quem: null,
          onde: FILA,
        }
      : {
          chave: 'carteiro',
          rotulo: 'Envio de e-mail (SMTP)',
          situacao: 'falta',
          detalhe: `Nada sai enquanto faltar no .env do servidor: ${status.missing.join(', ')}.${esperando}`,
          oQueFazer:
            'Preencher as variáveis EMAIL_* no .env do servidor, como no .env.production.example (no Gmail, com senha de app). O servidor relê o arquivo a cada minuto — não precisa reiniciar. A conta vale para as seis empresas.',
          quem: 'dono',
          onde: { rotulo: '.env do servidor', caminho: null },
        };

  const fila: ItemDaProntidao =
    status.failed > 0
      ? {
          chave: 'fila',
          rotulo: 'Mensagens que desistiram',
          situacao: 'falta',
          detalhe: `${status.failed} mensagem(ns) desta empresa desistiram depois das tentativas.`,
          oQueFazer: 'Abrir a fila, ler o motivo de cada uma e usar "Reenviar".',
          quem: 'gerente',
          onde: FILA,
        }
      : {
          chave: 'fila',
          rotulo: 'Mensagens que desistiram',
          situacao: 'ok',
          detalhe: 'Nenhuma mensagem desta empresa desistiu.',
          oQueFazer: null,
          quem: null,
          onde: FILA,
        };

  return [carteiro, fila];
}

function itemDoRemetente(companyId: string): ItemDaProntidao {
  const identidade = lerIdentidade(companyId);
  // O padrão (assinar como o grupo) já funciona: não é pendência, é escolha.
  return {
    chave: 'remetente',
    rotulo: 'Quem assina os e-mails',
    situacao: 'ok',
    detalhe:
      identidade.modo === 'empresa'
        ? `Assina como a empresa${identidade.nomeRemetente ? ` ("${identidade.nomeRemetente}")` : ''}.`
        : 'Assina como o grupo — o padrão, que já funciona. Trocar para o nome da empresa é escolha do dono.',
    oQueFazer: null,
    quem: null,
    onde: FILA,
  };
}

function itensDoContador(companyId: string): ItemDaProntidao[] {
  const ativos = listarDestinatarios(companyId).filter((d) => d.active);
  const destinatario: ItemDaProntidao =
    ativos.length > 0
      ? {
          chave: 'contador_destinatario',
          rotulo: 'Para quem vai o pacote do contador',
          situacao: 'ok',
          detalhe: `${ativos.length} destinatário(s): ${ativos.map((d) => d.email).join(', ')}.`,
          oQueFazer: null,
          quem: null,
          onde: FECHAMENTO,
        }
      : {
          chave: 'contador_destinatario',
          rotulo: 'Para quem vai o pacote do contador',
          situacao: 'falta',
          detalhe:
            'Nenhum destinatário cadastrado: o pacote do mês é montado, mas não tem para quem ir (o envio responde "sem destinatário").',
          oQueFazer:
            'Cadastrar o e-mail do escritório de contabilidade desta empresa em Fechamento do contador › Envio ao contador por e-mail › Quem recebe.',
          quem: 'contador',
          onde: FECHAMENTO,
        };

  const agenda = agendaDoContador(companyId);
  const itemDaAgenda: ItemDaProntidao =
    agenda?.active
      ? {
          chave: 'contador_agenda',
          rotulo: 'Envio automático do pacote',
          situacao: 'ok',
          detalhe: `Todo dia ${agenda.dayOfMonth}, o pacote do mês anterior sai sozinho${agenda.lastSentPeriod ? ` (último: ${agenda.lastSentPeriod})` : ''}.`,
          oQueFazer: null,
          quem: null,
          onde: FECHAMENTO,
        }
      : {
          chave: 'contador_agenda',
          rotulo: 'Envio automático do pacote',
          situacao: 'falta',
          detalhe: 'Sem agenda ligada: o pacote só sai quando alguém clicar em "Enviar pacote por e-mail".',
          oQueFazer:
            'Ligar a agenda em Fechamento do contador › Envio ao contador por e-mail › Envio automático, no dia combinado com o escritório (1 a 28).',
          quem: 'gerente',
          onde: FECHAMENTO,
        };

  const contadores = getConnection()
    .prepare(
      `SELECT u.display_name AS nome, u.last_login_at AS ultimo
         FROM core_user_companies uc
         JOIN core_users u ON u.id = uc.user_id
        WHERE uc.company_id = ? AND uc.profile_code = 'contador' AND u.active = 1
        ORDER BY u.display_name`,
    )
    .all(companyId) as unknown as { nome: string; ultimo: string | null }[];
  const usuario: ItemDaProntidao =
    contadores.length > 0
      ? {
          chave: 'contador_usuario',
          rotulo: 'Acesso do contador ao sistema',
          situacao: 'ok',
          detalhe: contadores
            .map((c) => `${c.nome} (${c.ultimo ? `último acesso em ${diaBR(c.ultimo)}` : 'ainda não entrou'})`)
            .join('; '),
          oQueFazer: null,
          quem: null,
          onde: EQUIPE,
        }
      : {
          chave: 'contador_usuario',
          rotulo: 'Acesso do contador ao sistema',
          situacao: 'falta',
          detalhe:
            'Nenhum usuário do escritório de contabilidade nesta empresa: o contador não entra sozinho para baixar o pacote e os XML.',
          oQueFazer:
            'Criar o usuário com o perfil "Escritório de contabilidade (externo)" em Usuários e equipe, com o login e o e-mail que o escritório passar.',
          quem: 'dono',
          onde: EQUIPE,
        };

  return [destinatario, itemDaAgenda, usuario];
}

function itemDaCaixa(companyId: string): ItemDaProntidao {
  const s = getInboxStatus(companyId);
  const base = { chave: 'caixa_nfe' as const, rotulo: 'NF-e de compra por e-mail', onde: CAIXA };

  if (!s.inbox) {
    return {
      ...base,
      situacao: 'opcional',
      detalhe: 'Nenhuma caixa cadastrada: as notas de compra entram pelo upload do XML.',
      oQueFazer:
        'Opcional: cadastrar o e-mail que recebe as notas dos fornecedores, com a senha de aplicativo.',
      quem: 'dono',
    };
  }
  if (s.readiness === 'READY_FOR_CREDENTIAL') {
    return {
      ...base,
      situacao: 'falta',
      detalhe: `${s.inbox.address} está cadastrada, mas sem senha.`,
      oQueFazer: 'Informar a senha de aplicativo do provedor e usar "Testar conexão".',
      quem: 'dono',
    };
  }
  if (s.readiness === 'CREDENTIAL_REJECTED' || s.readiness === 'CONNECTION_FAILING') {
    return {
      ...base,
      situacao: 'falta',
      detalhe: `${s.inbox.address}: ${s.inbox.last_error ?? 'a última leitura falhou.'}`,
      oQueFazer:
        s.readiness === 'CREDENTIAL_REJECTED'
          ? 'Gerar uma senha de aplicativo no provedor, salvar na tela e usar "Testar conexão".'
          : 'Conferir servidor, porta e pasta e usar "Testar conexão".',
      quem: s.readiness === 'CREDENTIAL_REJECTED' ? 'dono' : 'gerente',
    };
  }

  const agenda = getSchedulerSettings(companyId);
  if (!agenda?.autoEnabled) {
    return {
      ...base,
      situacao: 'falta',
      detalhe: `${s.inbox.address} conecta, mas a leitura automática está desligada: as notas só entram quando alguém clicar em "Ler agora".`,
      oQueFazer: 'Ativar a leitura automática na tela da caixa.',
      quem: 'gerente',
    };
  }
  const pendentes = Number(s.inbox.imap_pending ?? 0);
  return {
    ...base,
    situacao: 'ok',
    detalhe: `Lendo ${s.inbox.address} a cada ${agenda.intervalMinutes} min${pendentes > 0 ? `; ${pendentes} mensagem(ns) aguardam a próxima leitura` : ''}.`,
    oQueFazer: null,
    quem: null,
  };
}

export function prontidaoDasComunicacoes(companyId: string): ProntidaoDasComunicacoes {
  ensureCoreSchema();
  const itens: ItemDaProntidao[] = [
    ...itemDoCarteiro(companyId),
    itemDoRemetente(companyId),
    ...itensDoContador(companyId),
    itemDaCaixa(companyId),
  ];
  const faltam = itens.filter((i) => i.situacao === 'falta').length;
  return { companyId, pronto: faltam === 0, faltam, itens };
}
