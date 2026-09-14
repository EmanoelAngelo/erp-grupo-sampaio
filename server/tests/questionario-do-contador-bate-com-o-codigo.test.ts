/**
 * ============================================================================
 * O QUESTIONÁRIO DO CONTADOR BATE COM O CÓDIGO (GAP-PRD-178)
 * ============================================================================
 *
 * ## O defeito
 *
 * `docs/QUESTIONARIO-CONTADOR.md` é o roteiro da reunião única com o contador.
 * A seção 4 pedia a ele que classificasse NCM, CEST e origem "por planilha" —
 * enquanto `FiscalSuggestionService` já sugere os três a partir de cada XML de
 * entrada, com procedência, contagem e confirmação em lote. A seção "o que NÃO
 * precisamos perguntar" não dizia isso. Resultado: uma tarde de trabalho do
 * contador sobre o que as notas do fornecedor já tinham dito.
 *
 * E a seção 2.2 dizia que o Devora recusava de propósito os CSOSN 500 e 900 —
 * o que deixou de ser verdade com o GAP-PRD-021.
 *
 * ## O que este arquivo crava
 *
 * Que o roteiro e o código dizem a MESMA coisa, lendo as duas pontas: os
 * campos sugeridos vêm de `CAMPOS_SUGERIVEIS`, os códigos de ICMS emitidos vêm
 * de `TabelasDoIcms`, e o nome da tela que o roteiro manda abrir é conferido
 * no arquivo da tela. Se um lado mudar sem o outro, este caso fica vermelho.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAMPOS_SUGERIVEIS } from '../src/services/core/FiscalSuggestionService.js';
import {
  CRTS_DO_LEIAUTE,
  CSOSN_EMITIDOS,
  CSOSN_ST_POR_FORA,
  CST_ICMS_EMITIDOS,
  CST_ICMS_ST_POR_FORA,
} from '../src/services/core/TabelasDoIcms.js';

const QUESTIONARIO = readFileSync(
  new URL('../../docs/QUESTIONARIO-CONTADOR.md', import.meta.url),
  'utf8',
);
const TELA_FISCAL = readFileSync(
  new URL('../../src/pages/gs/FiscalPage.tsx', import.meta.url),
  'utf8',
);

/** Uma seção do roteiro: do título até o próximo título de mesmo nível ou acima. */
function secao(inicio: RegExp): string {
  const m = inicio.exec(QUESTIONARIO);
  if (!m) throw new Error(`seção não encontrada no questionário: ${inicio}`);
  const resto = QUESTIONARIO.slice(m.index + m[0].length);
  const fim = resto.search(/\n#{2,3} /);
  return m[0] + (fim < 0 ? resto : resto.slice(0, fim));
}

const NOME_NO_ROTEIRO: Record<string, string> = { ncm: 'NCM', cest: 'CEST', origin: 'origem' };

describe('produtos: o contador confirma o que o XML disse, e classifica só o resto', () => {
  const produtos = secao(/^## 4\./m);

  it('cada campo que o sistema sugere aparece no roteiro como SUGERIDO do XML', () => {
    for (const campo of CAMPOS_SUGERIVEIS) {
      expect(produtos, `o roteiro não fala de ${campo}`).toContain(NOME_NO_ROTEIRO[campo]);
    }
    expect(produtos).toMatch(/sugere/i);
    expect(produtos).toMatch(/XML/);
    expect(produtos).toMatch(/confirm/i);
  });

  it('a planilha fica para o que ficar PENDENTE ou DIVERGENTE — não para tudo', () => {
    expect(produtos).toContain('PENDENTE');
    expect(produtos).toContain('DIVERGENTE');
    // A pergunta antiga, que mandava o contador revisar a planilha inteira.
    expect(produtos).not.toMatch(/revisa uma planilha nossa/);
  });

  it('o CFOP nunca é sugerido — no código e no roteiro', () => {
    expect(CAMPOS_SUGERIVEIS as readonly string[]).not.toContain('cfop');
    expect(produtos).toMatch(/CFOP nunca é sugerido/);
  });

  it('a tela que o roteiro manda abrir existe com esse nome', () => {
    expect(produtos).toContain('Sugestões do XML do fornecedor');
    expect(TELA_FISCAL).toContain('title="Sugestões do XML do fornecedor"');
  });
});

describe('o que NÃO precisamos perguntar', () => {
  const naoPerguntar = secao(/^### O que NÃO precisamos perguntar/m);

  it('diz que NCM, CEST e origem vêm do XML do fornecedor', () => {
    expect(naoPerguntar).toMatch(/NCM, o CEST e a origem/);
    expect(naoPerguntar).toMatch(/XML do fornecedor/);
  });

  it('diz que o checklist já lista o que falta em cada grupo tributário', () => {
    expect(naoPerguntar).toMatch(/grupo tributário/);
    expect(naoPerguntar).toMatch(/pCredSN/);
  });
});

describe('regime e ST: o roteiro descreve o que a emissão monta', () => {
  const regime = secao(/^## 2\./m);
  const tributacao = secao(/^## 3\./m);

  it('pergunta os quatro CRT do leiaute', () => {
    for (const crt of CRTS_DO_LEIAUTE) expect(regime).toContain(`CRT ${crt}`);
  });

  it('a ST recolhida pelo fornecedor sai (CSOSN 500 / CST 60) — e o roteiro diz isso', () => {
    expect(CSOSN_EMITIDOS.has('500')).toBe(true);
    expect(CST_ICMS_EMITIDOS.has('60')).toBe(true);
    expect(regime).toContain('CSOSN 500');
    expect(regime).toContain('CST 60');
    // A frase que deixou de ser verdade com o GAP-PRD-021.
    expect(regime).not.toMatch(/recusa CSOSN de ST de propósito/);
  });

  it('a ST cobrada por esta empresa é recusada — e o roteiro nomeia os mesmos códigos', () => {
    for (const c of [...CSOSN_ST_POR_FORA, ...CST_ICMS_ST_POR_FORA]) {
      expect(regime, `o roteiro não nomeia o ${c}`).toContain(c);
    }
    expect(regime).toMatch(/por fora/);
  });

  it('os CST de ICMS que o roteiro pede são exatamente os que a emissão monta', () => {
    const lista = /CST de ICMS \(([^)]+)\)/.exec(tributacao)?.[1] ?? '';
    const pedidos = lista.split(/,|\bou\b/).map((s) => s.trim()).filter(Boolean);
    expect(new Set(pedidos)).toEqual(new Set(CST_ICMS_EMITIDOS));
  });
});
