/**
 * Quem pode o quê — o catálogo que faltava.
 *
 * O DEFEITO QUE ISTO CONSERTA
 *
 * `requirePermission('asaas.charge.create')` comparava a string da permissão
 * com os CÓDIGOS DE PERFIL do token. Perfil é `gestor`, `mecanico`,
 * `operador_caixa_loja`; permissão é `asaas.charge.create`. A comparação nunca
 * casava, e o único jeito de passar era o atalho do `admin_geral` na linha
 * seguinte.
 *
 * Resultado: **235 rotas em 18 roteadores respondiam só ao administrador**.
 * Fiscal, CRM, BI, oficina, locação, promoções, logística, terminais, e-commerce
 * e automações existiam, estavam testados, e devolviam 403 para todo mundo que
 * não fosse admin. Não era funcionalidade faltando — era funcionalidade
 * inalcançável, que é pior, porque parece pronta.
 *
 * POR QUE MÓDULO × AÇÃO, E NÃO UMA LISTA DE 162 LINHAS
 *
 * As 162 permissões seguem um formato: `modulo.recurso.acao`. Declarar uma a
 * uma seria 162 chances de esquecer alguma — e permissão esquecida vira 403 em
 * produção, no meio do atendimento. Declarando por MÓDULO, permissão nova
 * nasce coberta pela regra do módulo a que pertence.
 *
 * A granularidade fina vem na rodada da matriz de permissões, quando isto virar
 * tabela e tela. Este arquivo é o dado que aquela migração vai semear.
 *
 * FALHA FECHADA. Módulo não declarado nega. Um módulo novo que ninguém mapeou
 * devolve 403 até alguém decidir de quem ele é — o contrário abriria porta por
 * esquecimento.
 */

/*
  O SUCESSOR DESTE ARQUIVO (RBAC granular, F1).

  O parágrafo acima prometia: "quando isto virar tabela e tela, este arquivo é
  o dado que aquela migração vai semear". Virou: o catálogo de capabilities
  (`Capabilities.ts`, reexportado aqui) e os modelos de permissão. A matriz de
  módulos abaixo não é mais o que a rota pergunta — `requirePermission` traduz
  a rota para capability (`TraducaoDePermissoes.ts`) —, e fica só como a
  descrição do acesso de HOJE que a linha de base congelou (T0). Sai na F5.
*/
export * from './Capabilities.js';

/**
 * Ações que só olham.
 *
 * Tudo que não está aqui ESCREVE, e escrever exige estar na lista de escrita do
 * módulo. Na dúvida a ação é tratada como escrita: uma ação nova classificada
 * como leitura por engano seria uma porta aberta silenciosa.
 */
const ACOES_DE_LEITURA = new Set([
  'view',
  'list',
  'status',
  'health',
  'readiness',
  'preview',
  'export',
]);

/** Perfis que respondem por tudo. É a MESMA regra do `requireProfile`. */
const RESPONDEM_POR_TUDO = ['admin_geral', 'gestor'];

interface RegraDeModulo {
  /** Quem consulta. Quem escreve também consulta, sem precisar repetir aqui. */
  ler: string[];
  /** Quem altera. */
  escrever: string[];
}

/**
 * O que cada perfil faz em cada módulo.
 *
 * Lista vazia não é esquecimento: significa "só a gestão", e está escrito assim
 * de propósito nos módulos que mexem em credencial, release e recuperação —
 * ninguém além de quem responde pelo grupo ativa produção de um provedor.
 */
const MODULOS: Record<string, RegraDeModulo> = {
  /*
    `fiscal`, `crm` e `corporate-bi` moravam aqui e saíram na F1 do RBAC
    granular: nenhuma rota viva pedia `requirePermission` desses módulos (o
    fiscal e o CRM do núcleo guardam por `requireProfile`, e o BI do grupo
    saiu com o roteador /bi no GAP-PRD-075). Módulo que nenhuma rota cobra é
    alcance prometido que ninguém confere.
  */

  // Maquininha. O CAIXA COBRA — sem escrita aqui, o PDV não fecha venda em
  // cartão, que é o caminho mais usado do balcão.
  'payment-terminal': {
    ler: ['atendente'],
    escrever: ['gerente_loja', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'],
  },

  /*
    workshop, rentals e oms moravam aqui e saíram na rodada 36.

    A varredura antes de tirar: as vinte e três chamadas requirePermission
    desses três módulos estavam TODAS dentro dos três roteadores legados que a
    rodada apagou — nenhuma rota viva os pedia. As rotas de oficina e locação
    que a empresa usa vivem em core.ts e guardam com requireProfile, que é
    outro mecanismo e não passa por esta matriz; o BI do grupo pede
    corporate-bi.workshop e corporate-bi.rentals, cujo módulo é corporate-bi e
    continua declarado acima.

    Ficam FORA de propósito, e não esquecidos: módulo não declarado NEGA. Se
    uma rota nova escrever workshop.x.view sem declarar o módulo, ela cai no
    teste de cobertura de permissions.test.ts antes de cair em produção.
  */
  logistics: { ler: ['atendente'], escrever: ['gerente_loja', 'estoquista'] },

  /*
    Aqui moravam os módulos promotion e ecommerce. Saíram na rodada 36 junto com os
    roteadores que os cobravam: o motor de promoções morto (12 rotas sem
    chamador) e a loja fantasma (22 rotas, 23 tabelas vazias). Um módulo na
    matriz que nenhuma rota cobra é alcance prometido que ninguém confere —
    e a regra desta matriz é falhar fechada, não prometer. A loja REAL
    (/loja) não usa requirePermission: o cliente entra por x-portal-token, e
    o gestor pelas rotas /core/storefront/*, que declaram requireProfile.
  */
  // Cobrança online: quem mexe em chave e em ativar produção é a gerência.
  asaas: { ler: ['atendente'], escrever: ['gerente_loja'] },

  // `integrations` morava aqui e saiu com o roteador /integrations
  // (GAP-PRD-075): cada credencial é guardada pela porta do próprio domínio.
  // `automation` morava aqui e saiu com o roteador /automations (GAP-PRD-075):
  // nenhuma rota viva o cobrava.
  api: { ler: [], escrever: [] },
  'system-release': { ler: [], escrever: [] },
  'system-recovery': { ler: [], escrever: [] },
  'system-reconciliation': { ler: [], escrever: [] },
  'system-readiness': { ler: [], escrever: [] },
  'system-homologation': { ler: [], escrever: [] },
  'system-health': { ler: [], escrever: [] },
  'system-backup': { ler: [], escrever: [] },
  // `system-audit` saiu com `GET /system/audit` (verificação do GAP-PRD-075):
  // nenhuma rota viva o cobrava. Quem lê a trilha é `/core/audit`.
};

/** Os módulos declarados. Serve para o teste cobrar que nenhum ficou de fora. */
export const MODULOS_DECLARADOS = Object.keys(MODULOS);

/** A ação de uma permissão é o último segmento: `asaas.charge.create` → create. */
export function acaoDe(permissao: string): string {
  const partes = permissao.split('.');
  return partes[partes.length - 1] ?? '';
}

/** O módulo é o primeiro segmento. */
export function moduloDe(permissao: string): string {
  return permissao.split('.')[0] ?? '';
}

export function ehLeitura(permissao: string): boolean {
  return ACOES_DE_LEITURA.has(acaoDe(permissao));
}

/**
 * Os perfis do token dão conta desta permissão?
 *
 * Sem efeito colateral e sem banco — é uma pergunta sobre dois valores, e é
 * assim que dá para cobrar o comportamento em teste sem levantar servidor.
 */
export function temPermissao(perfis: readonly string[], permissao: string): boolean {
  if (perfis.some((p) => RESPONDEM_POR_TUDO.includes(p))) return true;

  const regra = MODULOS[moduloDe(permissao)];
  // Falha fechada: módulo que ninguém declarou não libera ninguém.
  if (!regra) return false;

  const permitidos = ehLeitura(permissao)
    ? [...regra.ler, ...regra.escrever]
    : regra.escrever;

  return permitidos.some((p) => perfis.includes(p));
}
