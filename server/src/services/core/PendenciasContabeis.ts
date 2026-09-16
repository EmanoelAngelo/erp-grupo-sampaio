/**
 * AS PENDÊNCIAS CONTÁBEIS DA EMPRESA — o que o contador ainda não confirmou (P0 fiscal).
 *
 * ## Por que existe
 *
 * O contador do Preço Justo informou o essencial (Simples, CRT 1, CSOSN 101,
 * CFOP 5102/6102, PIS/COFINS CST 49) e deixou em aberto o resto: o percentual
 * do pCredSN que o CSOSN 101 exige, se o CST 49 vale para PIS E COFINS, ST,
 * CEST, FCP, DIFAL, IPI, benefícios, a natureza da operação, as exceções por
 * produto, a devolução, o prazo de cancelamento e a contingência.
 *
 * O sistema NÃO inventa nenhum desses valores: o que falta é recusado na
 * emissão (com o nome do campo) ou sai com o padrão declarado. Esta lista é o
 * outro lado dessa recusa — tudo o que depende do contador, por empresa, numa
 * página só, para a reunião com ele render em vez de virar uma pendência por
 * nota rejeitada.
 *
 * Cada item diz o que IMPEDE: a emissão (a venda é recusada hoje), a produção
 * (sai em homologação, não em produção), ou nada (é confirmação pendente).
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { listarOperacoes } from './FiscalOperacoes.js';
import { lerPoliticaDeContingencia } from './FiscalContingenciaOffline.js';
import type { ReadinessItem } from './FiscalConfigService.js';

export interface PendenciaContabil {
  /** Chave estável, para a tela agrupar e o teste conferir. */
  chave: string;
  tema: string;
  descricao: string;
  impede: 'emissao' | 'producao' | 'nada';
  onde: string;
}

const ONDE_GRUPOS = 'Catálogo › Grupos tributários (quem informa é o contador)';
const ONDE_OPERACOES = 'Fiscal › Operações fiscais (quem confirma é o contador)';

export function pendenciasContabeis(companyId: string): PendenciaContabil[] {
  ensureCoreSchema();
  const db = getConnection();
  const pendencias: PendenciaContabil[] = [];

  // 1. As operações: natureza, CFOP e grupo da devolução, prazo de cancelamento.
  for (const op of listarOperacoes(companyId)) {
    op.pendencias.forEach((descricao, i) => {
      pendencias.push({
        chave: `operacao:${op.operacao}:${i}`,
        tema: op.rotulo,
        descricao,
        impede: op.operacao.startsWith('devolucao_') && !op.confirmadaPeloContador && i === 0 ? 'producao' : 'nada',
        onde: ONDE_OPERACOES,
      });
    });
  }

  // 2. Os grupos tributários ativos.
  const grupos = db
    .prepare(
      `SELECT code, csosn, p_cred_sn, cst_pis, cst_cofins FROM core_tax_groups
        WHERE company_id = ? AND active = 1 ORDER BY code`,
    )
    .all(companyId) as unknown as {
    code: string;
    csosn: string | null;
    p_cred_sn: string | null;
    cst_pis: string | null;
    cst_cofins: string | null;
  }[];
  for (const g of grupos) {
    const pCred = String(g.p_cred_sn ?? '').trim();
    if (g.csosn === '101' && !pCred) {
      pendencias.push({
        chave: `grupo:${g.code}:pcredsn`,
        tema: `Grupo ${g.code} — CSOSN 101`,
        descricao:
          'O CSOSN 101 exige o percentual de crédito do Simples (pCredSN), e o contador ainda não o '
          + 'informou: a venda dos produtos deste grupo é recusada até ele entrar no grupo.',
        impede: 'emissao',
        onde: ONDE_GRUPOS,
      });
    } else if (g.csosn === '101') {
      pendencias.push({
        chave: `grupo:${g.code}:pcredsn-revisao`,
        tema: `Grupo ${g.code} — CSOSN 101`,
        descricao:
          `O pCredSN gravado é ${pCred}%. Ele é o percentual de ICMS da faixa do Simples e muda com a `
          + 'faixa — confirme com o contador a cada mudança.',
        impede: 'nada',
        onde: ONDE_GRUPOS,
      });
    }
    if (g.cst_pis === '49' || g.cst_cofins === '49') {
      pendencias.push({
        chave: `grupo:${g.code}:cst49`,
        tema: `Grupo ${g.code} — PIS/COFINS`,
        descricao:
          `PIS no CST ${g.cst_pis ?? '—'} e COFINS no CST ${g.cst_cofins ?? '—'} (sem destaque, base e `
          + 'valor zerados): confirme com o contador se o CST 49 vale para os DOIS tributos.',
        impede: 'nada',
        onde: ONDE_GRUPOS,
      });
    }
  }

  /*
    3. As exceções por produto: CFOP próprio diferente do grupo.

    DEFEITO (auditoria P0 fiscal): o `JOIN` casava o grupo SÓ pelo
    `tax_profile` do produto. O produto SEM perfil — que é o caso normal da
    Preço Justo, com um único grupo ativo — nunca casava, e a exceção dele
    ficava invisível para o contador: o catálogo inteiro podia estar com CFOP
    próprio divergente do grupo e a lista dizia que não havia exceção nenhuma.

    A regra do grupo que vale para o produto é a da EMISSÃO (`acharGrupo` em
    TributacaoDoItem: o grupo do perfil, ou o grupo único da operação quando
    não há perfil), e é a mesma que o item de catálogo do `buildReadiness` já
    usa. Copiá-la aqui é o que faz as três contagens falarem do mesmo grupo.

    Com DOIS ou mais grupos ativos e produto sem perfil, o subselect devolve
    NULL e o produto continua de fora — corretamente: ali não há grupo que
    valha, e essa falta já é FAIL no item da tributação, com o produto nomeado.
  */
  const excecoes = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM core_products p
         JOIN core_tax_groups g
           ON g.company_id = p.company_id AND g.active = 1
          AND g.code = COALESCE(
                NULLIF(UPPER(TRIM(COALESCE(p.tax_profile, ''))), ''),
                (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(u.code) END
                   FROM core_tax_groups u
                  WHERE u.company_id = p.company_id AND u.active = 1))
        WHERE p.company_id = ? AND p.active = 1
          AND TRIM(COALESCE(p.cfop, '')) <> ''
          AND TRIM(p.cfop) <> COALESCE(g.cfop_internal, '')
          AND TRIM(p.cfop) <> COALESCE(g.cfop_external, '')`,
    )
    .get(companyId) as { n: number };
  if (Number(excecoes.n) > 0) {
    pendencias.push({
      chave: 'produtos:cfop-proprio',
      tema: 'Exceções por produto',
      descricao:
        `${Number(excecoes.n)} produto(s) têm CFOP próprio diferente do grupo tributário. Confirme cada `
        + 'exceção com o contador — e o CFOP interestadual delas, que o sistema não deduz (a nota para '
        + 'outra UF é recusada até ele existir).',
      impede: 'nada',
      onde: 'Cadastro do produto',
    });
  }

  // 4. O que o sistema não monta sem cadastro do contador — declarado, não escondido.
  pendencias.push({
    chave: 'difal',
    tema: 'DIFAL — venda a consumidor de outra UF',
    descricao:
      'Na NF-e para consumidor final NÃO contribuinte de outra UF (indIEDest 9, idDest 2) o sistema não '
      + 'monta o grupo ICMSUFDest (DIFAL e FCP da UF de destino). Confirme com o contador se a operação '
      + 'do Simples o exige na UF de destino antes de vender para fora do RS.',
    impede: 'nada',
    onde: 'Contador',
  });
  pendencias.push({
    chave: 'st-ipi-beneficio',
    tema: 'ST, IPI, FCP e benefícios',
    descricao:
      'Substituição tributária calculada pela própria empresa (CSOSN 201/202/203), IPI com valor, FCP e '
      + 'benefício fiscal (cBenef) só saem com cadastro do contador — sem ele, a emissão recusa, nomeando '
      + 'o produto. CEST entra pelo grupo ou pelo produto, quando o contador o informar.',
    impede: 'nada',
    onde: ONDE_GRUPOS,
  });

  // 5. A contingência da NFC-e.
  if (lerPoliticaDeContingencia(companyId).modo !== 'OFFLINE_NFCE') {
    pendencias.push({
      chave: 'contingencia',
      tema: 'Contingência da NFC-e',
      descricao:
        'A modalidade off-line (tpEmis 9) e o prazo de transmissão da UF não foram decididos: com a SEFAZ '
        + 'fora, a NFC-e espera na fila (nada sai em contingência).',
      impede: 'nada',
      onde: 'Fiscal › Documentos › Contingência (decisão do dono, com o contador)',
    });
  }

  return pendencias;
}

/**
 * O item do checklist (`buildReadiness`) — pronto para quem é dono daquele
 * arquivo ligar com uma linha (`items.push(itemDePendenciasContabeis(companyId))`).
 *
 * NUNCA é FAIL: o que impede a emissão já é FAIL no item da tributação
 * (`product_tax_group`), com o produto nomeado; repetir aqui faria o portão
 * contar a mesma falta duas vezes. Este item INFORMA — dono: o contador.
 */
export function itemDePendenciasContabeis(companyId: string): ReadinessItem {
  const confirmacoes = pendenciasContabeis(companyId).filter((p) => p.impede !== 'emissao');
  const temas = [...new Set(confirmacoes.map((p) => p.tema))];
  return {
    key: 'accountant_pending',
    label: 'Pendências contábeis (o que o contador ainda não confirmou)',
    status: confirmacoes.length > 0 ? 'PENDING' : 'PASS',
    state: confirmacoes.length > 0 ? 'PENDENTE' : 'CONFIRMADO',
    detail:
      confirmacoes.length > 0
        ? `${confirmacoes.length} ponto(s) dependem do contador: ${temas.join('; ')}. A lista completa, com o `
          + 'que cada um impede, está em Fiscal › Pendências contábeis.'
        : null,
    source: null,
    owner: 'contador',
    known: null,
    counts: null,
  };
}
