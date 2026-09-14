/**
 * A PRONTIDÃO QUE ENXERGA O GRUPO TRIBUTÁRIO (GAP-PRD-095).
 *
 * ## O defeito
 *
 * O banco da loja tem um grupo `SIMPLES-101` com CSOSN 101 e sem `pCredSN`,
 * sem CST de PIS, sem CST de COFINS. O checklist dizia "pode emitir", o painel
 * do PDV mostrava o botão, e toda venda morria no clique com a recusa da
 * tributação — que nomeia o campo que falta. O sistema SABIA, e não dizia
 * antes: `buildReadiness` nunca olhava `core_tax_groups`.
 *
 * ## O que este módulo faz
 *
 * Roda a MESMA régua da emissão (`diagnosticarTributacao`, a leitura que anota
 * em vez de recusar) sobre o catálogo e sobre a venda:
 *
 *  - no checklist, um item `product_tax_group` com dono CONTADOR, que conta
 *    quantos produtos têm tributação que fecha e diz, por grupo, TUDO o que
 *    falta — a lista que o contador leva numa reunião só;
 *  - na venda, os motivos de cada item, para o painel do balcão dizer antes do
 *    clique em vez de recusar depois.
 *
 * O catálogo não é percorrido produto a produto: a regra do grupo depende só do
 * PERFIL do produto (o grupo que vale para ele). CFOP e origem também entram
 * na régua, mas são CLASSIFICAÇÃO da mercadoria — o checklist já os conta nos
 * itens de catálogo, e a validação da venda os cobra item a item — e por isso
 * não se repetem aqui. Uma consulta agrupada por perfil, e uma avaliação por
 * perfil: o custo não cresce com o catálogo.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { diagnosticarTributacao, resumoDoGrupo } from './TributacaoDoItem.js';
import type { ReadinessItem } from './FiscalConfigService.js';
import type { NfceSale } from './FiscalXmlNfce.js';

/** A base do ensaio: qualquer valor serve — a régua do grupo não depende dele. */
const BASE_DE_ENSAIO = 10_000;

const ROTULO = 'Tributação dos produtos (grupo tributário)';

const ONDE_RESOLVER =
  'Quem informa é o contador; a gerência grava em Catálogo › Grupos tributários (e as '
  + 'alíquotas em Catálogo › Alíquotas).';

function faltasDoPerfil(companyId: string, perfil: string | null) {
  const d = diagnosticarTributacao({
    companyId,
    ufDestinatario: null,
    produto: {
      id: 'prontidao',
      description: 'produto do catálogo',
      taxProfile: perfil,
      origin: null,
      cfop: null,
      ncm: null,
      cest: null,
      totalCents: BASE_DE_ENSAIO,
    },
  });
  return {
    grupo: d.grupo,
    faltas: d.faltas.filter((f) => f.tipo === 'tributacao').map((f) => f.oQue),
  };
}

function contar(done: number, total: number) {
  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100) };
}

/**
 * O item do checklist.
 *
 * FAIL quando algum produto ativo não tem tributação que feche (a venda dele é
 * recusada — o checklist não pode dizer "pode emitir"). PENDING quando só um
 * grupo SEM produto está quebrado, ou quando não há grupo nem produto: é aviso,
 * e não bloqueio — não há venda a recusar hoje.
 */
export function itemDeProntidaoDaTributacao(companyId: string): ReadinessItem {
  ensureCoreSchema();
  const db = getConnection();

  const grupos = db
    .prepare(
      `SELECT code, csosn, cst_icms, icms_rate_code FROM core_tax_groups
        WHERE company_id = ? AND active = 1
        ORDER BY code`,
    )
    .all(companyId) as unknown as {
    code: string;
    csosn: string | null;
    cst_icms: string | null;
    icms_rate_code: string | null;
  }[];

  const porPerfil = db
    .prepare(
      `SELECT UPPER(TRIM(COALESCE(tax_profile, ''))) AS perfil, COUNT(*) AS n
         FROM core_products
        WHERE company_id = ? AND active = 1
        GROUP BY UPPER(TRIM(COALESCE(tax_profile, '')))`,
    )
    .all(companyId) as unknown as { perfil: string; n: number }[];

  let total = 0;
  let emitem = 0;
  const usados = new Set<string>();
  const travas = new Map<string, { rotulo: string; faltas: string[]; produtos: number }>();

  for (const { perfil, n } of porPerfil) {
    const quantos = Number(n);
    total += quantos;
    const { grupo, faltas } = faltasDoPerfil(companyId, perfil || null);
    if (grupo) usados.add(grupo);
    if (faltas.length === 0) {
      emitem += quantos;
      continue;
    }
    const rotulo = grupo ?? (perfil ? `perfil ${perfil}` : 'sem perfil');
    const chave = `${rotulo}\u0000${faltas.join('\u0000')}`;
    const atual = travas.get(chave) ?? { rotulo, faltas, produtos: 0 };
    atual.produtos += quantos;
    travas.set(chave, atual);
  }

  // Grupo quebrado que nenhum produto usa hoje: não trava venda, mas travará
  // a primeira que o usar — e o contador precisa saber agora.
  const semUso: string[] = [];
  for (const g of grupos) {
    if (usados.has(g.code)) continue;
    const { faltas } = faltasDoPerfil(companyId, g.code);
    if (faltas.length > 0) semUso.push(`${g.code}: ${faltas.join('; ')}`);
  }

  const known = grupos.length > 0 ? grupos.map(resumoDoGrupo).join(', ') : null;
  const base = {
    key: 'product_tax_group',
    label: ROTULO,
    owner: 'contador' as const,
    source: grupos.length > 0 ? ('cadastro' as const) : null,
    known,
    counts: contar(emitem, total),
  };

  if (emitem < total) {
    const blocos = [...travas.values()].map(
      (t) => `${t.rotulo} (${t.produtos} produto(s)): ${t.faltas.join('; ')}`,
    );
    return {
      ...base,
      status: 'FAIL',
      state: 'PENDENTE',
      detail:
        `${total - emitem} de ${total} produto(s) ativo(s) não têm tributação que feche — a venda `
        + `deles é recusada. ${blocos.join(' | ')}. ${ONDE_RESOLVER}`
        + (semUso.length > 0
          ? ` Grupos sem produto que também não fechariam: ${semUso.join(' | ')}.`
          : ''),
    };
  }

  if (semUso.length > 0) {
    return {
      ...base,
      status: 'PENDING',
      state: 'PENDENTE',
      detail:
        `Nenhum produto ativo trava, mas ${semUso.length} grupo(s) sem produto não fechariam no `
        + `dia em que alguém os usar: ${semUso.join(' | ')}. ${ONDE_RESOLVER}`,
    };
  }

  if (grupos.length === 0) {
    return {
      ...base,
      status: 'PENDING',
      state: 'PENDENTE',
      detail:
        'Nenhum grupo tributário ativo nesta operação: a primeira venda será recusada. Cadastre o '
        + 'grupo em Catálogo › Grupos tributários com o que o contador informar — CSOSN (ou CST '
        + 'de ICMS e a alíquota, fora do Simples), CST de PIS e de COFINS e CFOP.',
    };
  }

  return { ...base, status: 'PASS', state: 'CONFIRMADO', detail: null };
}

/**
 * Os motivos pelos quais a tributação DESTA venda não fecharia — todos, item a
 * item, na linguagem da recusa (que é a que o caixa repassa ao gerente).
 *
 * CFOP e origem ficam de fora: a validação da venda (`validateNfce`) já os
 * cobra, e repeti-los faria o caixa achar que são duas pendências.
 */
export function motivosDaTributacaoDaVenda(
  sale: NfceSale,
  ufDestinatario: string | null,
): string[] {
  const motivos: string[] = [];
  sale.items.forEach((item, index) => {
    const d = diagnosticarTributacao({
      companyId: sale.companyId,
      ufDestinatario,
      produto: {
        id: item.productId || String(index + 1),
        description: item.description,
        taxProfile: item.taxProfile ?? null,
        origin: item.origin,
        cfop: item.cfop,
        ncm: item.ncm,
        cest: item.cest,
        totalCents: item.totalCents,
      },
    });
    for (const f of d.faltas) {
      if (f.tipo === 'tributacao') {
        motivos.push(`det[${index + 1}] ${item.description} — ${f.oQue}. ${f.onde}`);
      }
    }
  });
  return motivos;
}
