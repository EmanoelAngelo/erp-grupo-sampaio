/**
 * ============================================================================
 * A IMPLANTAÇÃO DE CADA EMPRESA — um checklist, e não oito telas (GAP-PRD-067)
 * ============================================================================
 *
 * Cada domínio já responde, com honestidade, pelo seu pedaço: o fiscal tem o
 * checklist de emissão, a impressão diz se há impressora, a loja online diz
 * produto por produto o que falta, a logística diz se há transportadora, o
 * Asaas diz se há chave, o carteiro diz se há SMTP. O que não existia era a
 * visão da EMPRESA: para saber se a sexta operação estava pronta, o gestor
 * percorria umas oito telas, trocando de empresa a cada uma, seis vezes.
 *
 * Aqui mora essa visão. Nada é recalculado por fora: cada item chama a MESMA
 * função que a tela do domínio chama, e traduz a resposta para um vocabulário
 * só — o mesmo do checklist fiscal:
 *
 *   PRONTO                  o sistema conferiu e está certo;
 *   AUTO_DETECTADO          o sistema achou o dado, mas só gente sabe se está
 *                           CERTO (a IE digitada, o e-mail do contador): falta
 *                           alguém confirmar;
 *   CONFIRMADO              alguém confirmou, e o dado não mudou desde então;
 *   DIVERGENTE              alguém confirmou e o dado MUDOU (ou piorou) depois
 *                           — ou o domínio acusa um estado errado (CNPJ que não
 *                           fecha, configuração de teste ativa, fila morta);
 *   PENDENTE                falta algo que se resolve numa tela do sistema;
 *   NAO_APLICAVEL           não vale para esta empresa — por regra (loja sem
 *                           bancada) ou marcado por alguém, com o motivo;
 *   BLOQUEADO_EXTERNAMENTE  depende de fora: certificado, SEFAZ, conta do
 *                           Asaas, credencial de transportadora, SMTP, hardware.
 *
 * A CONFIRMAÇÃO GUARDA UMA ASSINATURA. Confirmar "os dados do emitente estão
 * certos" grava um resumo dos valores que estavam lá; se alguém mudar a IE
 * depois, a assinatura não bate e o item vira DIVERGENTE, com quem confirmou e
 * quando. Sem isso, "confirmado" seria um carimbo que sobrevive a qualquer
 * mudança — e deixaria de dizer alguma coisa na primeira edição.
 *
 * Três itens são do GRUPO, não da empresa (e-mail, banco central, backup e
 * versão do banco): aparecem em todas, marcados como globais, para que o
 * checklist de uma empresa não diga PRONTA com o SMTP do servidor faltando.
 *
 * NADA AQUI CHAMA A REDE. Os estados vêm do banco, do cofre (só "tem ou não
 * tem") e do ambiente — o mesmo que as telas de domínio mostram ao abrir.
 */
import { createHash } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';
import { assessProductionUnlock, buildReadiness, isValidCnpj } from '../core/FiscalConfigService.js';
import { getCertificateView } from '../core/CertificateStatusService.js';
import { getAsaasStatus } from '../core/PaymentService.js';
import { getTerminalStatus } from '../core/PdvTerminalService.js';
import { printReadiness } from '../core/PrintEngine.js';
import { listOnlineReadiness } from '../core/CatalogService.js';
import { logisticsReadiness } from '../logistics/LogisticsService.js';
import { originZipOf } from '../logistics/LogisticsReadinessService.js';
import { agendaDoContador, listarDestinatarios } from '../core/ContadorEnvioService.js';
import { emailStatus } from '../notifications/EmailService.js';
import { syncStatus } from '../sync/SyncService.js';
import { estadoDoBackup } from '../backup/estadoDoBackup.js';
import { fraseDaSituacao, versoesDoBancoEmUso } from '../../db/versaoDoEsquema.js';

export type EstadoDeImplantacao =
  | 'PRONTO'
  | 'AUTO_DETECTADO'
  | 'CONFIRMADO'
  | 'PENDENTE'
  | 'DIVERGENTE'
  | 'NAO_APLICAVEL'
  | 'BLOQUEADO_EXTERNAMENTE';

export const ESTADOS_DE_IMPLANTACAO: EstadoDeImplantacao[] = [
  'DIVERGENTE',
  'PENDENTE',
  'AUTO_DETECTADO',
  'BLOQUEADO_EXTERNAMENTE',
  'CONFIRMADO',
  'PRONTO',
  'NAO_APLICAVEL',
];

/** Quem resolve — a mesma régua do checklist fiscal, mais o "externo". */
export type DonoDoItem = 'gestor' | 'dono' | 'contador' | 'sefaz' | 'externo';

export type TipoDeMarca = 'CONFIRMADO' | 'NAO_APLICAVEL';

export interface MarcaDoItem {
  tipo: TipoDeMarca;
  motivo: string | null;
  porId: string | null;
  porNome: string | null;
  em: string;
}

export interface ItemDeImplantacao {
  chave: string;
  titulo: string;
  estado: EstadoDeImplantacao;
  detalhe: string;
  dono: DonoDoItem;
  /** A tela que resolve o item, ou nulo quando é fora do sistema. */
  onde: string | null;
  /** Vale para o grupo inteiro (o mesmo em todas as empresas). */
  global: boolean;
  /** O botão "Confirmar" faz sentido agora (o sistema achou o dado). */
  podeConfirmar: boolean;
  /** O item admite "não se aplica a esta empresa". */
  podeMarcarNaoAplicavel: boolean;
  marca: MarcaDoItem | null;
  /** A leitura do domínio falhou — o estado não foi conferido. */
  falhaDeLeitura: boolean;
}

export interface AreaDeImplantacao {
  area: string;
  titulo: string;
  itens: ItemDeImplantacao[];
}

export type SituacaoDaEmpresa =
  /** Nada pendente, divergente nem por confirmar; nada bloqueado de fora. */
  | 'PRONTA'
  /** O que é do sistema está feito; falta insumo de fora (certificado, SEFAZ…). */
  | 'PRONTA_COM_PENDENCIA_EXTERNA'
  /** Há o que fazer aqui dentro: pendência, divergência ou confirmação. */
  | 'PENDENTE';

export interface ImplantacaoDaEmpresa {
  empresa: { id: string; slug: string; nome: string; razaoSocial: string; tipo: string; ativa: boolean };
  avaliadoEm: string;
  situacao: SituacaoDaEmpresa;
  resumo: Record<EstadoDeImplantacao, number>;
  areas: AreaDeImplantacao[];
}

// ----------------------------------------------------------------------------
// A detecção de cada item
// ----------------------------------------------------------------------------

interface Deteccao {
  estado: Exclude<EstadoDeImplantacao, 'AUTO_DETECTADO' | 'CONFIRMADO'>;
  detalhe: string;
  dono: DonoDoItem;
  /**
   * Os valores que uma confirmação atesta. Só nos itens que pedem gente para
   * dizer "está certo"; a assinatura deles é o que a marca guarda.
   */
  atestado?: unknown;
}

interface Empresa {
  id: string;
  slug: string;
  legal_name: string;
  trade_name: string;
  cnpj: string | null;
  kind: string;
  active: number;
}

interface DefinicaoDoItem {
  chave: string;
  area: string;
  titulo: string;
  onde: string | null;
  global?: boolean;
  /** Pronto pelo sistema ainda pede alguém para dizer que o dado está certo. */
  exigeConfirmacao?: boolean;
  podeNaoAplicar?: boolean;
  detectar: (empresa: Empresa) => Deteccao;
}

const AREAS: Array<{ area: string; titulo: string }> = [
  { area: 'empresa', titulo: 'Empresa' },
  { area: 'pessoas', titulo: 'Pessoas e acessos' },
  { area: 'balcao', titulo: 'Balcão (PDV)' },
  { area: 'estoque', titulo: 'Estoque e catálogo' },
  { area: 'fiscal', titulo: 'Fiscal' },
  { area: 'pagamentos', titulo: 'Pagamentos' },
  { area: 'loja', titulo: 'Loja online e entrega' },
  { area: 'contabilidade', titulo: 'Contabilidade' },
  { area: 'oficina', titulo: 'Oficina' },
  { area: 'grupo', titulo: 'Serviços do grupo (valem para todas)' },
];

const GERENTES = ['gerente_loja', 'gerente_oficina'];
const CAIXAS = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'];

function contar(sql: string, ...args: Array<string | number>): number {
  const row = getConnection().prepare(sql).get(...args) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function lista(nomes: string[], max = 4): string {
  return nomes.length <= max ? nomes.join(', ') : `${nomes.slice(0, max).join(', ')} e mais ${nomes.length - max}`;
}

/** Os itens do checklist fiscal que são CADASTRO DO EMITENTE. */
const CHAVES_DO_EMITENTE = new Set(['emitter', 'cnpj', 'ie', 'crt', 'address', 'ibge']);
/** Os itens do checklist fiscal que o item "certificado" já cobre. */
const CHAVES_DO_CERTIFICADO = new Set(['certificate', 'certificate_validity', 'certificate_icp']);

function donoFiscal(owner: string): DonoDoItem {
  return owner === 'dono' || owner === 'contador' || owner === 'sefaz' ? owner : 'gestor';
}

/** O modelo fiscal (65 NFC-e, 55 NF-e), traduzido para um item. */
function detectarModelo(companyId: string, model: '65' | '55'): Deteccao {
  const r = buildReadiness(companyId, model);
  const falhas = r.items.filter(
    (i) => i.status === 'FAIL' && !CHAVES_DO_EMITENTE.has(i.key) && !CHAVES_DO_CERTIFICADO.has(i.key),
  );
  const divergentes = r.items.filter((i) => i.state === 'DIVERGENTE' && !CHAVES_DO_CERTIFICADO.has(i.key));
  const nome = model === '65' ? 'NFC-e' : 'NF-e';
  if (divergentes.length > 0) {
    return {
      estado: 'DIVERGENTE',
      dono: donoFiscal(divergentes[0].owner),
      detalhe: divergentes.map((i) => `${i.label}: ${i.detail ?? 'divergente'}`).join(' · '),
    };
  }
  const doGestor = falhas.filter((i) => i.owner === 'gestor');
  if (doGestor.length > 0) {
    return {
      estado: 'PENDENTE',
      dono: 'gestor',
      detalhe: doGestor.map((i) => `${i.label}: ${i.detail ?? 'pendente'}`).join(' · '),
    };
  }
  if (falhas.length > 0) {
    return {
      estado: 'BLOQUEADO_EXTERNAMENTE',
      dono: donoFiscal(falhas[0].owner),
      detalhe: falhas.map((i) => `${i.label}: ${i.detail ?? 'pendente'}`).join(' · '),
    };
  }
  if (!r.canEmit) {
    // O que resta é o emitente ou o certificado — cada um tem item próprio.
    return {
      estado: 'BLOQUEADO_EXTERNAMENTE',
      dono: 'dono',
      detalhe: `${nome} espera o cadastro do emitente e o certificado (itens acima).`,
    };
  }
  if (r.readiness !== 'HOMOLOGATED') {
    return {
      estado: 'BLOQUEADO_EXTERNAMENTE',
      dono: 'sefaz',
      detalhe: `${nome} pronta para a homologação: falta transmitir à SEFAZ de homologação e receber um protocolo real.`,
    };
  }
  return { estado: 'PRONTO', dono: 'gestor', detalhe: `${nome} homologada: há autorização real da SEFAZ registrada.` };
}

const ITENS: DefinicaoDoItem[] = [
  // ── Empresa ──────────────────────────────────────────────────────────────
  {
    chave: 'empresa.cadastro',
    area: 'empresa',
    titulo: 'Cadastro da empresa (razão social e CNPJ do cupom)',
    onde: '/sistema/empresas',
    exigeConfirmacao: true,
    detectar: (e) => {
      const cnpj = (e.cnpj ?? '').replace(/\D/g, '');
      if (!e.active) return { estado: 'DIVERGENTE', dono: 'gestor', detalhe: 'A empresa está INATIVA: ninguém entra nela.' };
      if (!cnpj) {
        return {
          estado: 'PENDENTE',
          dono: 'gestor',
          detalhe: 'Sem CNPJ no cadastro: o cabeçalho do cupom e do A4 sai sem ele.',
        };
      }
      if (!isValidCnpj(cnpj)) {
        return { estado: 'DIVERGENTE', dono: 'gestor', detalhe: `O CNPJ gravado (${e.cnpj}) não fecha o dígito verificador.` };
      }
      return {
        estado: 'PRONTO',
        dono: 'gestor',
        detalhe: `${e.legal_name} · CNPJ ${cnpj}.`,
        atestado: { razao: e.legal_name, fantasia: e.trade_name, cnpj },
      };
    },
  },

  // ── Pessoas ──────────────────────────────────────────────────────────────
  {
    chave: 'pessoas.gerente',
    area: 'pessoas',
    titulo: 'Quem gerencia a empresa',
    onde: '/sistema/usuarios',
    detectar: (e) => {
      const nomes = (
        getConnection()
          .prepare(
            `SELECT u.display_name AS nome FROM core_user_companies uc
               JOIN core_users u ON u.id = uc.user_id AND u.active = 1
              WHERE uc.company_id = ? AND uc.profile_code IN (${GERENTES.map(() => '?').join(',')})
              ORDER BY u.display_name`,
          )
          .all(e.id, ...GERENTES) as Array<{ nome: string }>
      ).map((r) => r.nome);
      return nomes.length > 0
        ? { estado: 'PRONTO', dono: 'gestor', detalhe: `Gerente: ${lista(nomes)}.` }
        : {
            estado: 'PENDENTE',
            dono: 'gestor',
            detalhe: 'Nenhum gerente ativo nesta empresa: só o grupo entra nela para configurar.',
          };
    },
  },
  {
    chave: 'pessoas.caixa',
    area: 'pessoas',
    titulo: 'Quem opera o caixa',
    onde: '/sistema/usuarios',
    podeNaoAplicar: true,
    detectar: (e) => {
      const n = contar(
        `SELECT COUNT(*) AS n FROM core_user_companies uc
           JOIN core_users u ON u.id = uc.user_id AND u.active = 1
          WHERE uc.company_id = ? AND uc.profile_code IN (${CAIXAS.map(() => '?').join(',')})`,
        e.id,
        ...CAIXAS,
      );
      return n > 0
        ? { estado: 'PRONTO', dono: 'gestor', detalhe: `${n} pessoa(s) com perfil de caixa.` }
        : { estado: 'PENDENTE', dono: 'gestor', detalhe: 'Ninguém com perfil de caixa: o balcão só abre com o gerente.' };
    },
  },
  {
    chave: 'pessoas.senhas_provisorias',
    area: 'pessoas',
    titulo: 'Senhas provisórias trocadas',
    onde: '/sistema/usuarios',
    detectar: (e) => {
      const logins = (
        getConnection()
          .prepare(
            `SELECT u.login FROM core_user_companies uc
               JOIN core_users u ON u.id = uc.user_id AND u.active = 1
              WHERE uc.company_id = ? AND u.must_change_password = 1
              ORDER BY u.login`,
          )
          .all(e.id) as Array<{ login: string }>
      ).map((r) => r.login);
      return logins.length === 0
        ? { estado: 'PRONTO', dono: 'gestor', detalhe: 'Nenhuma conta ativa com senha provisória.' }
        : {
            estado: 'PENDENTE',
            dono: 'gestor',
            detalhe: `${logins.length} conta(s) ainda com a senha provisória: ${lista(logins)}. O sistema não força a troca — cobre de cada pessoa.`,
          };
    },
  },

  // ── Balcão ───────────────────────────────────────────────────────────────
  {
    chave: 'balcao.caixa_testado',
    area: 'balcao',
    titulo: 'Um caixa completo de teste (abrir, vender, fechar)',
    onde: '/sistema/caixa',
    podeNaoAplicar: true,
    detectar: (e) => {
      const row = getConnection()
        .prepare(
          `SELECT MAX(closed_at) AS fechado FROM core_cash_sessions
            WHERE company_id = ? AND status = 'closed' AND closed_at IS NOT NULL`,
        )
        .get(e.id) as { fechado?: string | null } | undefined;
      return row?.fechado
        ? { estado: 'PRONTO', dono: 'gestor', detalhe: `Último caixa fechado em ${row.fechado.slice(0, 10)}.` }
        : {
            estado: 'PENDENTE',
            dono: 'gestor',
            detalhe: 'Nenhum caixa fechado nesta empresa ainda. Faça um de teste: abrir, vender, sangria, fechar.',
          };
    },
  },
  {
    chave: 'balcao.maquininha',
    area: 'balcao',
    titulo: 'Maquininha integrada',
    onde: '/sistema/integracoes',
    podeNaoAplicar: true,
    detectar: (e) => {
      const t = getTerminalStatus(e.id);
      if (!t.configured) {
        return {
          estado: 'BLOQUEADO_EXTERNAMENTE',
          dono: 'externo',
          detalhe:
            'Nenhuma maquininha integrada: exige o equipamento, o SDK e a credencial do provedor. Sem ela o cartão '
            + 'é lançado à mão, conferindo o comprovante da maquininha avulsa. Se a loja trabalha assim de propósito, '
            + 'marque "não se aplica".',
        };
      }
      if (t.provider === 'mock') {
        return {
          estado: 'DIVERGENTE',
          dono: 'gestor',
          detalhe:
            'A configuração ativa é o SIMULADOR (mock): fora de produção ele aprova sem dinheiro; em produção o '
            + 'cartão trava. Desative-a antes de abrir o balcão.',
        };
      }
      return {
        estado: 'BLOQUEADO_EXTERNAMENTE',
        dono: 'externo',
        detalhe: `Maquininha ${t.provider ?? ''} configurada; falta a homologação com o equipamento real.`,
      };
    },
  },
  {
    chave: 'balcao.impressora',
    area: 'balcao',
    titulo: 'Impressora do cupom',
    onde: '/sistema/configuracoes/impressoras',
    podeNaoAplicar: true,
    detectar: (e) => {
      const p = printReadiness(e.id);
      if (!p.configured) return { estado: 'PENDENTE', dono: 'gestor', detalhe: p.message };
      if (p.readiness === 'BROWSER_ONLY') return { estado: 'PRONTO', dono: 'gestor', detalhe: p.message };
      return { estado: 'BLOQUEADO_EXTERNAMENTE', dono: 'externo', detalhe: p.message };
    },
  },

  // ── Estoque ──────────────────────────────────────────────────────────────
  {
    chave: 'estoque.produtos',
    area: 'estoque',
    titulo: 'Produtos cadastrados',
    onde: '/sistema/produtos',
    detectar: (e) => {
      const n = contar('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND active = 1', e.id);
      return n > 0
        ? { estado: 'PRONTO', dono: 'gestor', detalhe: `${n} produto(s) ativo(s).` }
        : { estado: 'PENDENTE', dono: 'gestor', detalhe: 'Nenhum produto ativo: o balcão não tem o que vender.' };
    },
  },
  {
    chave: 'estoque.saldo_inicial',
    area: 'estoque',
    titulo: 'Estoque inicial lançado',
    onde: '/sistema/estoque/inventario',
    detectar: (e) => {
      const ativos = contar('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND active = 1', e.id);
      const comSaldo = contar(
        `SELECT COUNT(*) AS n FROM core_stock s JOIN core_products p ON p.id = s.product_id
          WHERE s.company_id = ? AND p.active = 1 AND s.quantity > 0`,
        e.id,
      );
      if (ativos === 0) return { estado: 'PENDENTE', dono: 'gestor', detalhe: 'Sem produto ativo, não há estoque a lançar.' };
      return comSaldo > 0
        ? { estado: 'PRONTO', dono: 'gestor', detalhe: `${comSaldo} de ${ativos} produto(s) com saldo.` }
        : {
            estado: 'PENDENTE',
            dono: 'gestor',
            detalhe: 'Nenhum produto com saldo. Lance o estoque inicial por inventário, não por ajuste solto.',
          };
    },
  },

  // ── Fiscal ───────────────────────────────────────────────────────────────
  {
    chave: 'fiscal.emitente',
    area: 'fiscal',
    titulo: 'Dados do emitente (CNPJ, IE, regime, endereço, IBGE)',
    onde: '/sistema/fiscal/configuracao',
    exigeConfirmacao: true,
    detectar: (e) => {
      const r = buildReadiness(e.id, '65');
      const itens = r.items.filter((i) => CHAVES_DO_EMITENTE.has(i.key));
      const divergente = itens.find((i) => i.state === 'DIVERGENTE');
      if (divergente) return { estado: 'DIVERGENTE', dono: 'gestor', detalhe: `${divergente.label}: ${divergente.detail}` };
      const falhas = itens.filter((i) => i.status === 'FAIL');
      const doGestor = falhas.filter((i) => i.owner !== 'contador');
      if (doGestor.length > 0) {
        return { estado: 'PENDENTE', dono: 'gestor', detalhe: doGestor.map((i) => i.detail).join(' ') };
      }
      if (falhas.length > 0) {
        return {
          estado: 'BLOQUEADO_EXTERNAMENTE',
          dono: 'contador',
          detalhe: `${falhas.map((i) => i.label).join(', ')}: resposta do contador (Fiscal › Configuração).`,
        };
      }
      return {
        estado: 'PRONTO',
        dono: 'gestor',
        detalhe: itens.map((i) => `${i.label}: ${i.known ?? '—'}`).join(' · '),
        atestado: itens.map((i) => [i.key, i.known]),
      };
    },
  },
  {
    chave: 'fiscal.certificado',
    area: 'fiscal',
    titulo: 'Certificado digital A1',
    onde: '/sistema/fiscal/certificado',
    podeNaoAplicar: true,
    detectar: (e) => {
      const c = getCertificateView(e.id);
      if (!c.configured) return { estado: 'BLOQUEADO_EXTERNAMENTE', dono: 'dono', detalhe: c.message };
      if (c.situation === 'vencido') return { estado: 'DIVERGENTE', dono: 'dono', detalhe: c.message };
      return { estado: 'PRONTO', dono: 'dono', detalhe: c.message };
    },
  },
  {
    chave: 'fiscal.nfce',
    area: 'fiscal',
    titulo: 'NFC-e (cupom fiscal)',
    onde: '/sistema/fiscal/configuracao',
    podeNaoAplicar: true,
    detectar: (e) => detectarModelo(e.id, '65'),
  },
  {
    chave: 'fiscal.nfe',
    area: 'fiscal',
    titulo: 'NF-e (nota da venda online e de atacado)',
    onde: '/sistema/fiscal/configuracao',
    podeNaoAplicar: true,
    detectar: (e) => detectarModelo(e.id, '55'),
  },
  {
    chave: 'fiscal.producao',
    area: 'fiscal',
    titulo: 'Emissão em produção liberada',
    onde: '/sistema/fiscal/configuracao',
    podeNaoAplicar: true,
    detectar: (e) => {
      const a = assessProductionUnlock(e.id);
      if (a.unlocked) {
        return { estado: 'PRONTO', dono: 'gestor', detalhe: `Liberada em ${String(a.unlockedAt ?? '').slice(0, 10)}.` };
      }
      if (a.canUnlock) {
        return {
          estado: 'PENDENTE',
          dono: 'gestor',
          detalhe: 'A homologação passou: a liberação da produção é um clique em Fiscal › Configuração.',
        };
      }
      return { estado: 'BLOQUEADO_EXTERNAMENTE', dono: 'sefaz', detalhe: a.blockingReasons[0] ?? 'Falta a homologação.' };
    },
  },

  // ── Pagamentos ───────────────────────────────────────────────────────────
  {
    chave: 'pagamentos.asaas',
    area: 'pagamentos',
    titulo: 'Cobrança online (Asaas) desta empresa',
    onde: '/sistema/integracoes/asaas',
    podeNaoAplicar: true,
    detectar: (e) => {
      const s = getAsaasStatus({ companyId: e.id });
      if (s.readiness === 'PRODUCTION_ENABLED') {
        return { estado: 'PRONTO', dono: 'dono', detalhe: 'Conta de produção configurada e liberada.' };
      }
      if (s.readiness === 'READY_FOR_SANDBOX_TEST') {
        return {
          estado: 'BLOQUEADO_EXTERNAMENTE',
          dono: 'dono',
          detalhe: `Chave de sandbox configurada. Para produção falta: ${s.productionBlockedBy.join('; ') || 'a chave de produção'}.`,
        };
      }
      return {
        estado: 'BLOQUEADO_EXTERNAMENTE',
        dono: 'dono',
        detalhe: 'Sem chave do Asaas desta empresa: PIX e boleto online não saem. A chave é da conta da própria operação.',
      };
    },
  },

  // ── Loja online ──────────────────────────────────────────────────────────
  {
    chave: 'loja.catalogo',
    area: 'loja',
    titulo: 'Produtos na loja online',
    onde: '/sistema/produtos/prontidao-online',
    podeNaoAplicar: true,
    detectar: (e) => {
      const linhas = listOnlineReadiness(e.id);
      const publicados = linhas.filter((l) => l.publishOnline && l.ready).length;
      const prontos = linhas.filter((l) => l.readyToPublish).length;
      if (publicados > 0) {
        return { estado: 'PRONTO', dono: 'gestor', detalhe: `${publicados} produto(s) publicado(s) e vendável(is); ${prontos} pronto(s) para publicar.` };
      }
      return {
        estado: 'PENDENTE',
        dono: 'gestor',
        detalhe:
          prontos > 0
            ? `Nenhum produto publicado; ${prontos} já está(ão) pronto(s) — é um clique.`
            : 'Nenhum produto pronto para a vitrine (foto, preço, medidas e saldo). Se a empresa não vende online, marque "não se aplica".',
      };
    },
  },
  {
    chave: 'loja.entrega',
    area: 'loja',
    titulo: 'Entrega: CEP de origem e transportadora',
    onde: '/sistema/loja/logistica',
    podeNaoAplicar: true,
    exigeConfirmacao: true,
    detectar: (e) => {
      const cep = originZipOf(e.id);
      if (!cep) {
        return {
          estado: 'PENDENTE',
          dono: 'gestor',
          detalhe: 'Sem CEP de origem: ele vem do endereço fiscal do emitente (Fiscal › Configuração).',
        };
      }
      const l = logisticsReadiness(e.id);
      const configuradas = l.providers.filter((p) => p.configured).map((p) => p.carrier);
      if (configuradas.length === 0) {
        return {
          estado: 'BLOQUEADO_EXTERNAMENTE',
          dono: 'externo',
          detalhe: `CEP de origem ${cep}. Nenhuma transportadora com credencial: o contrato e o token são do dono.`,
        };
      }
      if (!l.readyForHomologation) {
        return {
          estado: 'BLOQUEADO_EXTERNAMENTE',
          dono: 'externo',
          detalhe: `CEP de origem ${cep}; ${lista(configuradas)} com credencial, ainda sem ambiente conferido: ${l.blockingReasons[0] ?? ''}`,
        };
      }
      return {
        estado: 'PRONTO',
        dono: 'gestor',
        detalhe: `CEP de origem ${cep}; transportadora(s): ${lista(configuradas)}.`,
        atestado: { cep, configuradas },
      };
    },
  },

  // ── Contabilidade ────────────────────────────────────────────────────────
  {
    chave: 'contabilidade.contador',
    area: 'contabilidade',
    titulo: 'Contador que recebe o fechamento',
    onde: '/sistema/fiscal/fechamento',
    exigeConfirmacao: true,
    detectar: (e) => {
      const ativos = listarDestinatarios(e.id).filter((d) => d.active);
      if (ativos.length === 0) {
        return {
          estado: 'PENDENTE',
          dono: 'contador',
          detalhe: 'Nenhum e-mail de contador cadastrado: o pacote do mês não tem para quem ir.',
        };
      }
      const agenda = agendaDoContador(e.id);
      const quando = agenda?.active ? ` Envio automático no dia ${agenda.dayOfMonth}.` : ' Sem envio automático agendado.';
      return {
        estado: 'PRONTO',
        dono: 'contador',
        detalhe: `${ativos.map((d) => `${d.name} <${d.email}>`).join(', ')}.${quando}`,
        atestado: ativos.map((d) => d.email.toLowerCase()).sort(),
      };
    },
  },

  // ── Oficina ──────────────────────────────────────────────────────────────
  {
    chave: 'oficina.bancada',
    area: 'oficina',
    titulo: 'Bancada da oficina',
    onde: '/sistema/oficina/oficinas',
    detectar: (e) => {
      const nomes = (
        getConnection()
          .prepare('SELECT name FROM core_workshops WHERE company_id = ? AND active = 1 ORDER BY name')
          .all(e.id) as Array<{ name: string }>
      ).map((r) => r.name);
      if (nomes.length > 0) return { estado: 'PRONTO', dono: 'gestor', detalhe: `Bancada(s): ${lista(nomes)}.` };
      return e.kind === 'workshop'
        ? { estado: 'PENDENTE', dono: 'gestor', detalhe: 'Oficina sem bancada ativa: o gerente entra e não vê ordem de serviço.' }
        : { estado: 'NAO_APLICAVEL', dono: 'gestor', detalhe: 'Loja sem bancada de oficina.' };
    },
  },

  // ── Grupo ────────────────────────────────────────────────────────────────
  {
    chave: 'grupo.email',
    area: 'grupo',
    titulo: 'E-mail de saída (SMTP)',
    onde: '/sistema/loja/emails',
    global: true,
    detectar: (e) => {
      const s = emailStatus(e.id);
      if (s.readiness !== 'READY') {
        return {
          estado: 'BLOQUEADO_EXTERNAMENTE',
          dono: 'dono',
          detalhe: `Falta no .env do servidor: ${s.missing.join(', ')}. A fila acumula (${s.pending} pendente(s) desta empresa); depois de preencher, reinicie a API.`,
        };
      }
      if (s.failed > 0) {
        return { estado: 'DIVERGENTE', dono: 'gestor', detalhe: `${s.failed} e-mail(s) desta empresa falharam de vez — veja o motivo em E-mails.` };
      }
      return { estado: 'PRONTO', dono: 'dono', detalhe: `SMTP configurado; ${s.sent} enviado(s), ${s.pending} na fila.` };
    },
  },
  {
    chave: 'grupo.central',
    area: 'grupo',
    titulo: 'Banco central (sincronização)',
    onde: '/sistema/integracoes/central',
    global: true,
    podeNaoAplicar: true,
    detectar: () => {
      const s = syncStatus();
      if (s.outbox.dead > 0) {
        return {
          estado: 'DIVERGENTE',
          dono: 'gestor',
          detalhe: `${s.outbox.dead} evento(s) esgotaram as tentativas e pararam — reative em Banco central.`,
        };
      }
      if (s.readiness === 'READY_FOR_CREDENTIAL') {
        return {
          estado: 'BLOQUEADO_EXTERNAMENTE',
          dono: 'dono',
          detalhe: `Sem credencial da central (${s.missing.join(', ')}): a fila acumula, nada se perde.`,
        };
      }
      if (s.readiness !== 'SYNC_READY') {
        return {
          estado: 'PENDENTE',
          dono: 'dono',
          detalhe:
            s.readiness === 'READY_FOR_SCHEMA'
              ? 'Credencial presente; falta aplicar o esquema na central (docs/supabase).'
              : 'Esquema aplicado; falta a carga inicial (bootstrap).',
        };
      }
      return { estado: 'PRONTO', dono: 'dono', detalhe: `Sincronizando; ${s.outbox.pending} evento(s) na fila.` };
    },
  },
  {
    chave: 'grupo.backup',
    area: 'grupo',
    titulo: 'Backup do banco e das fotos',
    onde: '/sistema/configuracoes/backup',
    global: true,
    detectar: () => {
      const b = estadoDoBackup();
      const falhou = b.itens.filter((i) => i.estado === 'FALHOU');
      const pendente = b.itens.filter((i) => i.estado === 'PENDENTE');
      if (falhou.length > 0) {
        return { estado: 'DIVERGENTE', dono: 'dono', detalhe: falhou.map((i) => `${i.titulo}: ${i.detalhe}`).join(' · ') };
      }
      if (pendente.length > 0) {
        return { estado: 'PENDENTE', dono: 'dono', detalhe: pendente.map((i) => i.titulo).join(', ') + '.' };
      }
      return { estado: 'PRONTO', dono: 'dono', detalhe: 'Cópia diária, outro disco, bucket e fotos em dia.' };
    },
  },
  {
    chave: 'grupo.versao_do_banco',
    area: 'grupo',
    titulo: 'Banco na versão desta build',
    onde: '/sistema/configuracoes/sistema',
    global: true,
    detectar: () => {
      const v = versoesDoBancoEmUso();
      if (v.situacao === 'EM_DIA') return { estado: 'PRONTO', dono: 'gestor', detalhe: fraseDaSituacao(v) };
      return {
        estado: v.situacao === 'ADIANTADO' ? 'DIVERGENTE' : 'PENDENTE',
        dono: 'dono',
        detalhe: fraseDaSituacao(v),
      };
    },
  },
];

const ITENS_POR_CHAVE = new Map(ITENS.map((i) => [i.chave, i]));

export function itemExiste(chave: string): boolean {
  return ITENS_POR_CHAVE.has(chave);
}

// ----------------------------------------------------------------------------
// Marcas (confirmação e "não se aplica")
// ----------------------------------------------------------------------------

function assinaturaDe(atestado: unknown): string {
  return createHash('sha256').update(JSON.stringify(atestado ?? null)).digest('hex').slice(0, 24);
}

interface LinhaDeMarca {
  item: string;
  tipo: TipoDeMarca;
  assinatura: string | null;
  motivo: string | null;
  user_id: string | null;
  nome: string | null;
  created_at: string;
}

function marcasDaEmpresa(companyId: string): Map<string, LinhaDeMarca> {
  const linhas = getConnection()
    .prepare(
      `SELECT m.item, m.tipo, m.assinatura, m.motivo, m.user_id, u.display_name AS nome, m.created_at
         FROM core_implantacao_marcas m
         LEFT JOIN core_users u ON u.id = m.user_id
        WHERE m.company_id = ?`,
    )
    .all(companyId) as unknown as LinhaDeMarca[];
  return new Map(linhas.map((l) => [l.item, l]));
}

function empresaPorId(companyId: string): Empresa {
  ensureCoreSchema();
  const e = getConnection()
    .prepare('SELECT id, slug, legal_name, trade_name, cnpj, kind, active FROM core_companies WHERE id = ?')
    .get(companyId) as Empresa | undefined;
  if (!e) throw new ApiError('CORE_COMPANY_NOT_FOUND', 'Empresa não encontrada.', 404);
  return e;
}

function detectarComSeguranca(def: DefinicaoDoItem, empresa: Empresa): Deteccao & { falhou: boolean } {
  try {
    return { ...def.detectar(empresa), falhou: false };
  } catch (err) {
    return {
      estado: 'PENDENTE',
      dono: 'gestor',
      detalhe: `Não foi possível conferir agora: ${(err as Error).message}`,
      falhou: true,
    };
  }
}

function montarItem(def: DefinicaoDoItem, empresa: Empresa, marca: LinhaDeMarca | undefined): ItemDeImplantacao {
  const d = detectarComSeguranca(def, empresa);
  const marcaPublica: MarcaDoItem | null = marca
    ? { tipo: marca.tipo, motivo: marca.motivo, porId: marca.user_id, porNome: marca.nome, em: marca.created_at }
    : null;
  const quem = marca ? `${marca.nome ?? 'alguém'} em ${marca.created_at.slice(0, 10)}` : '';

  let estado: EstadoDeImplantacao = d.estado;
  let detalhe = d.detalhe;

  if (marca?.tipo === 'NAO_APLICAVEL' && def.podeNaoAplicar) {
    estado = 'NAO_APLICAVEL';
    detalhe = `Marcado como "não se aplica" por ${quem}: ${marca.motivo ?? ''}`;
  } else if (d.estado === 'PRONTO' && def.exigeConfirmacao) {
    if (!marca || marca.tipo !== 'CONFIRMADO') {
      estado = 'AUTO_DETECTADO';
      detalhe = `${d.detalhe} Confira e confirme.`;
    } else if (marca.assinatura === assinaturaDe(d.atestado)) {
      estado = 'CONFIRMADO';
      detalhe = `${d.detalhe} Confirmado por ${quem}.`;
    } else {
      estado = 'DIVERGENTE';
      detalhe = `Confirmado por ${quem}, mas o dado MUDOU desde então: ${d.detalhe} Confira de novo.`;
    }
  } else if (marca?.tipo === 'CONFIRMADO' && d.estado !== 'PRONTO' && d.estado !== 'NAO_APLICAVEL') {
    estado = 'DIVERGENTE';
    detalhe = `Confirmado por ${quem}, mas hoje: ${d.detalhe}`;
  }

  return {
    chave: def.chave,
    titulo: def.titulo,
    estado,
    detalhe,
    dono: d.dono,
    onde: def.onde,
    global: Boolean(def.global),
    podeConfirmar: Boolean(def.exigeConfirmacao) && d.estado === 'PRONTO' && !d.falhou,
    podeMarcarNaoAplicavel: Boolean(def.podeNaoAplicar),
    marca: marcaPublica,
    falhaDeLeitura: d.falhou,
  };
}

function situacaoDe(resumo: Record<EstadoDeImplantacao, number>): SituacaoDaEmpresa {
  if (resumo.PENDENTE + resumo.DIVERGENTE + resumo.AUTO_DETECTADO > 0) return 'PENDENTE';
  if (resumo.BLOQUEADO_EXTERNAMENTE > 0) return 'PRONTA_COM_PENDENCIA_EXTERNA';
  return 'PRONTA';
}

export function implantacaoDaEmpresa(companyId: string, agora: Date = new Date()): ImplantacaoDaEmpresa {
  const empresa = empresaPorId(companyId);
  const marcas = marcasDaEmpresa(companyId);
  const itens = ITENS.map((def) => ({ area: def.area, item: montarItem(def, empresa, marcas.get(def.chave)) }));

  const resumo = Object.fromEntries(ESTADOS_DE_IMPLANTACAO.map((e) => [e, 0])) as Record<EstadoDeImplantacao, number>;
  for (const { item } of itens) resumo[item.estado] += 1;

  return {
    empresa: {
      id: empresa.id,
      slug: empresa.slug,
      nome: empresa.trade_name,
      razaoSocial: empresa.legal_name,
      tipo: empresa.kind,
      ativa: empresa.active === 1,
    },
    avaliadoEm: agora.toISOString(),
    situacao: situacaoDe(resumo),
    resumo,
    areas: AREAS.map(({ area, titulo }) => ({
      area,
      titulo,
      itens: itens.filter((i) => i.area === area).map((i) => i.item),
    })).filter((a) => a.itens.length > 0),
  };
}

/** O resumo de cada empresa — para a lista de Empresas mostrar a situação. */
export function resumoDasEmpresas(companyIds: string[]): Array<{
  empresaId: string;
  situacao: SituacaoDaEmpresa;
  resumo: Record<EstadoDeImplantacao, number>;
}> {
  return companyIds.map((id) => {
    const r = implantacaoDaEmpresa(id);
    return { empresaId: id, situacao: r.situacao, resumo: r.resumo };
  });
}

/**
 * Grava a marca de um item. A regra de quem pode vem da rota; aqui mora a
 * regra do ITEM: confirmar só o que o sistema achou pronto (e só nos itens que
 * pedem confirmação), e "não se aplica" só nos itens que admitem, com motivo.
 */
export function marcarItem(input: {
  companyId: string;
  item: string;
  tipo: TipoDeMarca;
  motivo?: string | null;
  userId: string;
  agora?: Date;
}): ItemDeImplantacao {
  const empresa = empresaPorId(input.companyId);
  const def = ITENS_POR_CHAVE.get(input.item);
  if (!def) throw new ApiError('IMPLANTACAO_ITEM_DESCONHECIDO', 'Item de implantação desconhecido.', 404);

  let assinatura: string | null = null;
  let motivo: string | null = null;
  if (input.tipo === 'CONFIRMADO') {
    if (!def.exigeConfirmacao) {
      throw new ApiError('IMPLANTACAO_NAO_CONFIRMAVEL', 'Este item é conferido pelo sistema; não há o que confirmar.', 409);
    }
    const d = detectarComSeguranca(def, empresa);
    if (d.estado !== 'PRONTO' || d.falhou) {
      throw new ApiError('IMPLANTACAO_NADA_A_CONFIRMAR', `Ainda não há o que confirmar: ${d.detalhe}`, 409);
    }
    assinatura = assinaturaDe(d.atestado);
  } else if (input.tipo === 'NAO_APLICAVEL') {
    if (!def.podeNaoAplicar) {
      throw new ApiError('IMPLANTACAO_SEMPRE_APLICAVEL', 'Este item vale para toda empresa; não pode ser dispensado.', 409);
    }
    motivo = String(input.motivo ?? '').trim();
    if (motivo.length < 5) {
      throw new ApiError('IMPLANTACAO_MOTIVO_OBRIGATORIO', 'Diga por que não se aplica (ao menos 5 caracteres).', 400);
    }
    motivo = motivo.slice(0, 300);
  } else {
    throw new ApiError('IMPLANTACAO_MARCA_INVALIDA', 'Marca inválida: use CONFIRMADO ou NAO_APLICAVEL.', 400);
  }

  getConnection()
    .prepare(
      `INSERT INTO core_implantacao_marcas (company_id, item, tipo, assinatura, motivo, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, item) DO UPDATE SET
         tipo = excluded.tipo, assinatura = excluded.assinatura, motivo = excluded.motivo,
         user_id = excluded.user_id, created_at = excluded.created_at`,
    )
    .run(input.companyId, input.item, input.tipo, assinatura, motivo, input.userId, (input.agora ?? new Date()).toISOString());

  return montarItem(def, empresa, marcasDaEmpresa(input.companyId).get(input.item));
}

/** Tira a marca; o item volta ao que o sistema detecta. */
export function desmarcarItem(companyId: string, item: string): { removida: boolean; item: ItemDeImplantacao } {
  const empresa = empresaPorId(companyId);
  const def = ITENS_POR_CHAVE.get(item);
  if (!def) throw new ApiError('IMPLANTACAO_ITEM_DESCONHECIDO', 'Item de implantação desconhecido.', 404);
  const r = getConnection()
    .prepare('DELETE FROM core_implantacao_marcas WHERE company_id = ? AND item = ?')
    .run(companyId, item);
  return { removida: Number(r.changes) > 0, item: montarItem(def, empresa, undefined) };
}

/** Para os testes e a documentação: as chaves na ordem da tela. */
export function chavesDosItens(): string[] {
  return ITENS.map((i) => i.chave);
}

/** Reexportado para a rota não precisar saber de onde vem o ambiente. */
export function ambienteDoServidor(): string {
  return loadEnv().DEVORA_API_ENV;
}
