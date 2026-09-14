/**
 * ============================================================================
 * O SIMULADOR DE DF-e NÃO RESPONDE POR PRODUÇÃO — GAP-PRD-168
 * ============================================================================
 *
 * A ficha diz que o XML por e-mail e a Distribuição DF-e dependem só de
 * insumo externo (credencial IMAP, certificado A1, homologação). Revalidando,
 * havia UMA linha de código entre o insumo e o go-live: sem a senha do A1,
 * `adapterRealOuSimulador` cai no simulador sempre que `DEVORA_API_ENV` não é
 * 'production' — e o padrão dela é 'development'. Com `NODE_ENV=production` e
 * a variável do projeto esquecida, a consulta gravaria documentos INVENTADOS na
 * empresa real, e a manifestação (ato com efeito jurídico) sairia com protocolo
 * de ensaio.
 *
 * Nasceu VERMELHO: sem a trava, os dois casos de produção abaixo respondiam
 * com documentos e protocolo do simulador. O caminho de desenvolvimento (a
 * suíte `dfe-e-manifestacao`) continua igual.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import {
  consultarDistribuicao,
  exigirAdapterDeVerdade,
  manifestarDfe,
} from '../src/services/core/DfeDistribuicaoService.js';
import type { SefazAdapter } from '../src/services/core/SefazAdapter.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

let empresa: string;
const nodeEnvOriginal = process.env.NODE_ENV;

function documentos(): number {
  return (
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_dfe_documents WHERE company_id = ?').get(empresa) as {
      n: number;
    }
  ).n;
}

beforeEach(async () => {
  resetDbForTests();
  empresa = await upsertCompany({ slug: 'loja-dfe-prod', tradeName: 'Loja DF-e', legalName: 'Loja DF-e Ltda' });
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'Loja DF-e Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(empresa);
});

afterEach(() => {
  if (nodeEnvOriginal === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnvOriginal;
});

describe('GAP-PRD-168 — a trava do simulador', () => {
  it('NODE_ENV=production: a consulta pelo simulador é recusada e nada entra no banco', async () => {
    process.env.NODE_ENV = 'production';
    await expect(
      consultarDistribuicao({ companyId: empresa, userId: 'u-1', adapter: new SefazTestAdapter() }),
    ).rejects.toMatchObject({ code: 'CORE_DFE_SIMULADOR_EM_PRODUCAO' });
    expect(documentos()).toBe(0);
  });

  it('empresa com ambiente fiscal de PRODUÇÃO: nem consulta nem manifestação pelo simulador', async () => {
    // Um documento que já está lá (de uma consulta de homologação anterior).
    await consultarDistribuicao({ companyId: empresa, userId: 'u-1', adapter: new SefazTestAdapter() });
    const chave = (
      getConnection().prepare('SELECT access_key FROM core_dfe_documents WHERE company_id = ? LIMIT 1').get(empresa) as {
        access_key: string;
      }
    ).access_key;
    const antes = documentos();

    getConnection().prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?").run(empresa);

    await expect(
      consultarDistribuicao({ companyId: empresa, userId: 'u-1', adapter: new SefazTestAdapter() }),
    ).rejects.toMatchObject({ code: 'CORE_DFE_SIMULADOR_EM_PRODUCAO' });
    // O documento da homologação já é recusado antes, pelo AMBIENTE (DFE-AMBIENTE):
    // a numeração da produção é outra, e o certificado nem chega a ser pedido.
    await expect(
      manifestarDfe({ companyId: empresa, userId: 'u-1', accessKey: chave, tipo: 'ciencia', adapter: new SefazTestAdapter() }),
    ).rejects.toMatchObject({ code: 'CORE_DFE_OUTRO_AMBIENTE' });
    // Um documento de PRODUÇÃO (o que a consulta real grava): a trava do simulador
    // continua na porta da manifestação.
    const chaveDeProducao = '4'.repeat(44);
    getConnection()
      .prepare(
        `INSERT INTO core_dfe_documents (id, company_id, environment, nsu, schema_type, access_key, received_at)
         VALUES ('dfe-producao', ?, 'production', '1', 'resNFe', ?, ?)`,
      )
      .run(empresa, chaveDeProducao, new Date().toISOString());
    await expect(
      manifestarDfe({
        companyId: empresa, userId: 'u-1', accessKey: chaveDeProducao, tipo: 'ciencia', adapter: new SefazTestAdapter(),
      }),
    ).rejects.toMatchObject({ code: 'CORE_DFE_SIMULADOR_EM_PRODUCAO' });

    expect(documentos()).toBe(antes + 1);
    const eventos = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_fiscal_events WHERE company_id = ? AND event_type LIKE 'dfe_%'")
      .get(empresa) as { n: number };
    expect(eventos.n).toBe(0);
  });

  it('o adapter REAL passa em produção — a trava é do simulador, não da função', () => {
    const real = { isReal: true, name: 'sefaz-real-dublado' } as unknown as SefazAdapter;
    expect(() => exigirAdapterDeVerdade(real, empresa, { apiEnv: 'production', nodeEnv: 'production' })).not.toThrow();
  });

  it('DEVORA_API_ENV=production também trava; desenvolvimento em homologação segue com o simulador', () => {
    const simulador = new SefazTestAdapter();
    expect(() => exigirAdapterDeVerdade(simulador, empresa, { apiEnv: 'production', nodeEnv: 'development' })).toThrow(
      /SEFAZ de verdade/,
    );
    expect(() => exigirAdapterDeVerdade(simulador, empresa, { apiEnv: 'development', nodeEnv: 'development' })).not.toThrow();
  });
});
