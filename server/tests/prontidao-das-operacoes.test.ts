/**
 * ============================================================================
 * O QUE CADA OPERAÇÃO AINDA PRECISA CADASTRAR OU INSTALAR (GAP-PRD-083, GAP-PRD-203)
 * ============================================================================
 *
 * Medido no banco operacional (somente leitura, 11/09/2026): as seis operações
 * com ZERO taxa de operadora de cartão; cinco sem impressora nenhuma; zero
 * agente local. Nada disso é defeito — o cartão segue pelo caminho declarado
 * (recebido no dia, valor cheio) e o cupom sai pelo navegador —, mas a
 * prontidão de go-live não dizia nada, e o dono não tinha onde ver, operação
 * por operação, o que ainda depende dele.
 *
 * Os casos cobram a lista `configurationPending` da prontidão:
 *
 *   - operação sem taxa de operadora e sem impressora de cupom aparece com as
 *     duas pendências, com quem resolve e em que tela;
 *   - cadastrada a taxa e a impressora, a pendência some — só daquela operação;
 *   - impressora de agente sem agente, ou sem página de teste confirmada, é
 *     pendência de equipamento com a frase do que falta;
 *   - nada disto derruba o núcleo: `coreStatus` continua o mesmo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createAcquirer, setRate } from '../src/services/core/AcquirerService.js';
import { upsertPrinter } from '../src/services/core/PrintEngine.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  evaluateCoreProductionReadiness,
  pendenciasDeConfiguracao,
} from '../src/services/system-admin/CoreProductionReadinessService.js';

let gringa: string;
let meMimei: string;

beforeEach(() => {
  resetDbForTests();
  gringa = upsertCompany({ slug: 'gringa-pront', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  meMimei = upsertCompany({ slug: 'me-mimei-pront', legalName: 'Me Mimei Ltda', tradeName: 'Me Mimei' });
});

const daOperacao = (companyId: string) => pendenciasDeConfiguracao().filter((p) => p.companyId === companyId);

describe('a lista do que falta, operação por operação', () => {
  it('sem taxa e sem impressora: as duas pendências, com quem resolve e onde', () => {
    const itens = daOperacao(gringa);
    expect(itens.map((i) => i.area).sort()).toEqual(['impressora', 'operadora_de_cartao']);
    const taxa = itens.find((i) => i.area === 'operadora_de_cartao')!;
    expect(taxa).toMatchObject({ companyName: 'Gringa', quem: 'dono', onde: 'Financeiro › Operadoras de cartão' });
    expect(taxa.mensagem).toMatch(/recebida no dia, pelo valor cheio/);
    expect(itens.find((i) => i.area === 'impressora')).toMatchObject({ quem: 'equipamento', onde: 'Configurações › Impressoras' });
  });

  it('cadastradas a taxa e a impressora de cupom, a pendência some — só daquela operação', () => {
    const op = createAcquirer(gringa, { name: 'Stone' });
    setRate(gringa, { acquirerId: op.id, paymentMethod: 'credito', installments: 1, feeBps: 350, settlementDays: 30 });
    upsertPrinter({ companyId: gringa, name: 'Cupom do balcão', kind: 'cupom', transport: 'browser', paperWidthMm: 80 });

    expect(daOperacao(gringa)).toHaveLength(0);
    expect(daOperacao(meMimei).map((i) => i.area).sort()).toEqual(['impressora', 'operadora_de_cartao']);
  });

  it('operadora desativada não conta como taxa cadastrada', () => {
    const op = createAcquirer(gringa, { name: 'ZZ-TESTE' });
    setRate(gringa, { acquirerId: op.id, paymentMethod: 'debito', installments: 1, feeBps: 150, settlementDays: 1 });
    // O banco da Preço Justo tem exatamente isto: uma operadora de teste inativa.
    getConnection().prepare('UPDATE core_acquirers SET active = 0 WHERE id = ?').run(op.id);
    expect(daOperacao(gringa).some((i) => i.area === 'operadora_de_cartao')).toBe(true);
  });

  it('impressora de agente sem agente no ar é pendência de equipamento com a frase do que falta', () => {
    upsertPrinter({
      companyId: gringa,
      name: 'Térmica 80',
      kind: 'cupom',
      transport: 'agent',
      agentDevice: 'tcp:192.168.0.50:9100',
    });
    const agente = daOperacao(gringa).find((i) => i.area === 'agente_local');
    expect(agente).toMatchObject({ quem: 'equipamento' });
    expect(agente!.mensagem).toMatch(/Impressora de agente "Térmica 80": Nenhum agente local pareado/);
    // Já tem impressora de cupom cadastrada: a pendência de "nenhuma impressora" some.
    expect(daOperacao(gringa).some((i) => i.area === 'impressora')).toBe(false);
  });
});

describe('não bloqueia o núcleo', () => {
  it('a prontidão traz a lista e o coreStatus continua o mesmo', () => {
    const r = evaluateCoreProductionReadiness();
    expect(r.configurationPending.length).toBeGreaterThanOrEqual(4);
    expect(r.criticalBlockers.some((b) => /operadora|impressora/i.test(b))).toBe(false);
    const op = createAcquirer(gringa, { name: 'Stone' });
    setRate(gringa, { acquirerId: op.id, paymentMethod: 'credito', installments: 1, feeBps: 350, settlementDays: 30 });
    expect(evaluateCoreProductionReadiness().coreStatus).toBe(r.coreStatus);
  });
});
