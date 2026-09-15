/**
 * O RESUMO FISCAL DO BALCÃO — auditoria P0 da Preço Justo.
 *
 * ## O defeito
 *
 * O selo do PDV dizia "FISCAL NÃO CONFIGURADO — Esta operação ainda não emite
 * nota." e mais nada. A causa real estava no checklist (`buildReadiness`) e
 * não chegava ao balcão com nome: na Preço Justo, o A1 estava no cofre SEM a
 * senha selada (gravado antes de a senha passar a ser guardada) e não havia
 * CSC gravado para o ambiente — dois gestos do administrador que o caixa não
 * tinha como repassar, porque a frase não os nomeava. A lista só aparecia num
 * clique que ninguém sabia que existia.
 *
 * E a classificação escondia uma falha atrás da outra: bastava UM produto sem
 * NCM para a situação virar "PENDENTE — faltam dados em produtos", mesmo com o
 * certificado e o CSC faltando. Configuração ausente é o problema maior, e
 * agora vence.
 *
 * Por fim, "FISCAL OK" aparecia com nota autorizada pelo SIMULADOR em
 * homologação: o checklist chama de HOMOLOGATED qualquer nota com protocolo.
 * Em homologação a nota não tem valor fiscal nenhum, e o selo passa a dizer
 * isso — "pronto" só existe em produção.
 *
 * ## O que o balcão recebe
 *
 * A situação, o ambiente, UMA frase com o que falta e quem resolve, e a lista
 * item a item — em texto próprio do balcão. O detalhe técnico do checklist
 * fica na tela do administrador: daqui não sai CSC ID, titular nem CNPJ do
 * certificado, nada que aponte para o segredo.
 */
import { buildReadiness, getFiscalConfig, type ReadinessItem } from './FiscalConfigService.js';
import { listFiscalPendencies } from './FiscalContingencyService.js';
import { periodoAtivo } from './FiscalContingenciaOffline.js';
import { MODEL_NFCE, rotuloDoAmbienteDaSerie } from './FiscalKeyService.js';

export type SituacaoFiscalDoPdv = 'READY' | 'TEST_ONLY' | 'PENDING' | 'NOT_CONFIGURED';

/** Quem o caixa precisa chamar. "Gestor" e "dono" são, para o balcão, o administrador. */
export type QuemResolve = 'administrador' | 'contador' | 'SEFAZ';

export interface FaltaFiscalDoPdv {
  key: string;
  label: string;
  /** A frase do balcão — sem segredo e sem jargão do checklist. */
  texto: string;
  quemResolve: QuemResolve;
  /** Onde o administrador resolve. */
  onde: string;
}

export interface ResumoFiscalDoPdv {
  situacao: SituacaoFiscalDoPdv;
  readiness: string;
  canEmit: boolean;
  ambiente: 'homologation' | 'production';
  /** Uma frase: o que falta e quem resolve — ou por que ainda não vale. */
  resumo: string;
  faltas: FaltaFiscalDoPdv[];
  /** Compatibilidade: a mesma lista, no formato antigo, com o texto do balcão. */
  blocking: { key: string; label: string; detail: string }[];
  pendencies: ReturnType<typeof listFiscalPendencies>;
  pendencyCount: number;
  contingencia: ReturnType<typeof periodoAtivo>;
  /** Quando o servidor conferiu — o selo mostra, para ninguém ler estado velho como novo. */
  verificadoEm: string;
}

const QUEM: Record<string, QuemResolve> = {
  dono: 'administrador',
  gestor: 'administrador',
  contador: 'contador',
  sefaz: 'SEFAZ',
};

const ONDE_EMITENTE = 'Fiscal › Configuração › Emitente';
const ONDE_CERTIFICADO = 'painel administrativo › Fiscal › Certificado';

/**
 * O texto do balcão para cada item que trava.
 *
 * Lista FECHADA para os itens de configuração: o `detail` do checklist é
 * escrito para quem configura, e o do certificado e o do CSC carregam o que o
 * caixa não precisa ver (titular, CSC ID). Os itens de catálogo passam o
 * `detail` como está — contagens de produtos, nada de segredo.
 */
function paraOBalcao(item: ReadinessItem, ambiente: string): { texto: string; onde: string } {
  switch (item.key) {
    case 'emitter':
      return { texto: 'A razão social do emitente não está cadastrada.', onde: ONDE_EMITENTE };
    case 'cnpj':
      return { texto: 'O CNPJ do emitente está ausente ou inválido.', onde: ONDE_EMITENTE };
    case 'ie':
      return {
        texto: 'A inscrição estadual (CGC/TE, no RS) do emitente está ausente ou não confere.',
        onde: ONDE_EMITENTE,
      };
    case 'crt':
      return { texto: 'O regime tributário (CRT) do emitente não foi informado.', onde: ONDE_EMITENTE };
    case 'address':
      return {
        texto: 'O endereço do emitente está incompleto (logradouro, número, bairro, município, UF e CEP).',
        onde: ONDE_EMITENTE,
      };
    case 'ibge':
      return {
        texto: 'O código IBGE do município do emitente está ausente ou não confere.',
        onde: ONDE_EMITENTE,
      };
    case 'certificate':
      return {
        texto:
          item.state === 'DIVERGENTE'
            ? 'O certificado digital A1 carregado não é do CNPJ desta operação.'
            : item.known
              ? 'O certificado digital A1 está carregado, mas sem a senha guardada: precisa ser '
                + 'reenviado com a senha.'
              : 'Nenhum certificado digital A1 foi carregado para esta operação.',
        onde: ONDE_CERTIFICADO,
      };
    case 'certificate_validity':
      return { texto: 'O certificado digital A1 está vencido.', onde: ONDE_CERTIFICADO };
    case 'certificate_icp':
      return {
        texto: 'O certificado A1 carregado é de teste (autoassinado) — a SEFAZ não o aceita.',
        onde: ONDE_CERTIFICADO,
      };
    case 'serie':
      return {
        texto: `Não há série da NFC-e configurada para ${ambiente}.`,
        onde: 'Fiscal › Configuração › Numeração das notas',
      };
    case 'csc':
      return {
        texto: `O CSC (código do QR Code da NFC-e) de ${ambiente} não está gravado.`,
        onde: 'Fiscal › Configuração › CSC (o código sai do portal da SEFAZ)',
      };
    default:
      return item.key.startsWith('product')
        ? {
            texto: item.detail ?? `${item.label}: pendente.`,
            onde: 'Catálogo › Produtos e Grupos tributários',
          }
        : { texto: `${item.label}: pendente.`, onde: 'Fiscal › Configuração' };
  }
}

function juntar(partes: string[]): string {
  if (partes.length <= 1) return partes.join('');
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

export function resumoFiscalDoPdv(companyId: string, now = new Date()): ResumoFiscalDoPdv {
  const readiness = buildReadiness(companyId, MODEL_NFCE, now);
  const ambiente = getFiscalConfig(companyId).environment === 'production' ? 'production' : 'homologation';
  const rotulo = rotuloDoAmbienteDaSerie(ambiente);
  const pendencies = listFiscalPendencies(companyId);

  const falhas = readiness.items.filter((i) => i.status === 'FAIL');
  const deConfiguracao = falhas.filter((i) => !i.key.startsWith('product'));

  /*
    A ORDEM DE GRAVIDADE: configuração ausente vence catálogo incompleto. Era
    o contrário — um produto sem NCM fazia o selo dizer "faltam dados em
    produtos" com o certificado e o CSC faltando, e o administrador ia mexer
    no catálogo enquanto a loja inteira seguia sem emitir.
  */
  const situacao: SituacaoFiscalDoPdv =
    falhas.length === 0
      ? readiness.readiness === 'HOMOLOGATED' && ambiente === 'production'
        ? 'READY'
        : 'TEST_ONLY'
      : deConfiguracao.length > 0
        ? 'NOT_CONFIGURED'
        : 'PENDING';

  const faltas: FaltaFiscalDoPdv[] = falhas.map((item) => ({
    key: item.key,
    label: item.label,
    ...paraOBalcao(item, rotulo),
    quemResolve: QUEM[item.owner] ?? 'administrador',
  }));

  const quem = juntar([...new Set(faltas.map((f) => f.quemResolve))]);
  const resumo =
    situacao === 'NOT_CONFIGURED'
      ? `Esta operação ainda não emite NFC-e. Falta: ${faltas.map((f) => f.label).join('; ')}. `
        + `Quem resolve: ${quem}.`
      : situacao === 'PENDING'
        ? `Faltam dados fiscais em produtos: ${faltas.map((f) => f.label).join('; ')}. `
          + `Quem resolve: ${quem}.`
        : ambiente === 'homologation'
          ? 'A NFC-e está em HOMOLOGAÇÃO (teste): a nota emitida aqui não tem valor fiscal.'
          : situacao === 'READY'
            ? 'NFC-e configurada e autorizada pela SEFAZ.'
            : 'A emissão está configurada, mas ainda não houve autorização real da SEFAZ.';

  return {
    situacao,
    readiness: readiness.readiness,
    canEmit: readiness.canEmit,
    ambiente,
    resumo,
    faltas,
    blocking: faltas.map((f) => ({ key: f.key, label: f.label, detail: f.texto })),
    pendencies,
    pendencyCount: pendencies.length,
    // O balcão precisa saber que está em contingência off-line: a NFC-e sai
    // com tpEmis 9 e o cliente leva o DANFCE de contingência (GAP-PRD-098).
    contingencia: periodoAtivo(companyId),
    verificadoEm: now.toISOString(),
  };
}
