/**
 * Chave de acesso e numeração fiscal.
 *
 * A CHAVE DE ACESSO tem 44 dígitos com estrutura fixa e dígito verificador por
 * módulo 11. Ela não é um identificador nosso: é o que a SEFAZ usa para achar
 * o documento, o que vai no QR Code do cupom e o que o consumidor digita no
 * site da Receita. Um dígito errado torna o documento inconsultável.
 *
 * A implementação anterior montava a chave com `6526${Date.now()}` — 44
 * caracteres de comprimento certo e conteúdo sem significado nenhum.
 *
 * A NUMERAÇÃO é server-side e por (empresa, modelo, série). Dois PDVs não
 * podem receber o mesmo número, e número entregue não volta para a fila: se a
 * emissão falhar, aquele número fica queimado e o caminho legal é inutilizá-lo,
 * não reaproveitá-lo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

/** Modelos que este núcleo emite. 55 = NF-e, 65 = NFC-e. */
export const MODEL_NFE = '55';
export const MODEL_NFCE = '65';

/** Ambiente da SEFAZ: 1 = produção, 2 = homologação. */
export type FiscalEnvironment = 'homologation' | 'production';

export function environmentCode(env: FiscalEnvironment): '1' | '2' {
  return env === 'production' ? '1' : '2';
}

/**
 * Dígito verificador da chave de acesso — módulo 11, pesos 2..9 cíclicos da
 * direita para a esquerda.
 *
 * Resto 0 ou 1 produz DV zero. É a regra do manual, e é justamente o caso que
 * uma implementação apressada erra: `11 - resto` daria 11 ou 10, que não são
 * dígitos.
 */
export function accessKeyCheckDigit(key43: string): string {
  if (!/^\d{43}$/.test(key43)) {
    throw new ApiError('CORE_FISCAL_KEY_INVALID', 'A chave precisa ter 43 dígitos antes do DV.', 400);
  }
  let peso = 2;
  let soma = 0;
  for (let i = key43.length - 1; i >= 0; i -= 1) {
    soma += Number(key43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto === 0 || resto === 1 ? '0' : String(11 - resto);
}

export interface AccessKeyInput {
  /** Código IBGE da UF do emitente (2 dígitos). */
  ufCode: string;
  /**
   * AAMM da emissão, no fuso do EMITENTE — vem de `momentoFiscal`, junto do
   * `dhEmi` e do mesmo cálculo.
   *
   * Era derivado aqui de `issuedAt.getFullYear()/getMonth()`: o fuso da MÁQUINA
   * do servidor. A chave e o `dhEmi` viravam dois relógios diferentes
   * respondendo "quando foi esta nota", e na venda das 22h do dia 31 eles
   * discordavam do mês. Chave incoerente com a data de emissão é rejeição, com
   * a venda já registrada e o número já queimado.
   */
  aamm: string;
  cnpj: string;
  model: string;
  serie: number;
  number: number;
  /** 1 = normal, 9 = contingência. */
  emissionType: string;
  /** Código numérico aleatório de 8 dígitos (cNF). */
  numericCode: string;
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function pad(value: string | number, size: number): string {
  return String(value).replace(/\D/g, '').padStart(size, '0').slice(-size);
}

/**
 * Monta a chave de 44 dígitos.
 *
 * Layout: cUF(2) AAMM(4) CNPJ(14) mod(2) série(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
 */
export function buildAccessKey(input: AccessKeyInput): string {
  const cnpj = digits(input.cnpj);
  if (cnpj.length !== 14) {
    throw new ApiError(
      'CORE_FISCAL_CNPJ_INVALID',
      'A chave de acesso exige o CNPJ do emitente com 14 dígitos.',
      400,
    );
  }

  /*
    O AAMM chega pronto e é CONFERIDO, não recalculado: quem monta a chave não
    tem como saber o fuso do emitente, e adivinhá-lo aqui recriaria o segundo
    relógio que esta rodada eliminou.
  */
  const aamm = digits(input.aamm ?? '');
  const mesDoAamm = Number(aamm.slice(2, 4));
  if (aamm.length !== 4 || mesDoAamm < 1 || mesDoAamm > 12) {
    throw new ApiError(
      'CORE_FISCAL_AAMM_INVALID',
      `AAMM inválido para a chave de acesso: "${input.aamm}". `
        + 'Ele vem de momentoFiscal(), no fuso do emitente.',
      400,
    );
  }

  const base =
    pad(input.ufCode, 2)
    + aamm
    + cnpj
    + pad(input.model, 2)
    + pad(input.serie, 3)
    + pad(input.number, 9)
    + pad(input.emissionType, 1)
    + pad(input.numericCode, 8);

  if (base.length !== 43) {
    throw new ApiError('CORE_FISCAL_KEY_INVALID', 'Falha ao montar a chave de acesso.', 500);
  }
  return base + accessKeyCheckDigit(base);
}

/** Confere uma chave recebida de fora — o DV é a única validação local possível. */
export function isValidAccessKey(key: string): boolean {
  const limpa = digits(key);
  if (limpa.length !== 44) return false;
  return accessKeyCheckDigit(limpa.slice(0, 43)) === limpa[43];
}

/**
 * Código numérico do documento (cNF).
 *
 * Aleatório de 8 dígitos. Não pode ser igual ao número da nota — a regra
 * existe para que a chave não seja adivinhável a partir da numeração
 * sequencial.
 */
export function randomNumericCode(number: number): string {
  for (;;) {
    const code = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    if (Number(code) !== number) return code;
  }
}

/**
 * Reserva o próximo número da série.
 *
 * `UPDATE ... RETURNING` numa transação: a leitura e a escrita são o MESMO
 * comando, então não há janela entre "qual é o próximo" e "marque como usado".
 * Ler e depois gravar deixaria dois PDVs simultâneos levarem o mesmo número —
 * e número repetido é rejeição na SEFAZ com a venda já feita.
 *
 * O número sai daqui QUEIMADO. Se a emissão falhar depois, ele não volta: o
 * caminho legal é inutilizar a faixa.
 */
export function reserveNextNumber(input: {
  companyId: string;
  model: string;
  serie: number;
}): number {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();

    db.prepare(
      `INSERT INTO core_fiscal_series (id, company_id, model, serie, next_number, active, created_at)
       VALUES (?, ?, ?, ?, 1, 1, ?)
       ON CONFLICT (company_id, model, serie) DO NOTHING`,
    ).run(randomUUID(), input.companyId, input.model, input.serie, new Date().toISOString());

    const row = db
      .prepare(
        `UPDATE core_fiscal_series
            SET next_number = next_number + 1
          WHERE company_id = ? AND model = ? AND serie = ?
      RETURNING next_number - 1 AS reserved`,
      )
      .get(input.companyId, input.model, input.serie) as { reserved: number } | undefined;

    if (!row) {
      throw new ApiError('CORE_FISCAL_SERIE_NOT_FOUND', 'Série fiscal não encontrada.', 500);
    }
    return Number(row.reserved);
  });
}

/**
 * A SÉRIE QUE ESTA OPERAÇÃO USA PARA ESTE MODELO.
 *
 * Os dois criadores de documento faziam `const serie = input.serie ?? 1`, e
 * nenhum chamador passava série. A operação cadastrava a série 5 na tela, o
 * checklist ficava verde porque EXISTE série, e a nota saía na série 1 — uma
 * numeração que o contador não conhece e que ninguém declarou.
 *
 * Com mais de uma série ativa a escolha é de quem chama: adivinhar aqui seria
 * repetir o mesmo erro por outra porta. Sem série ativa, recusa — e a recusa
 * diz onde resolver, porque essa é a única saída possível.
 */
export function resolveSerie(
  companyId: string,
  model: string,
  pedida: number | undefined,
  /**
   * O ambiente em que a nota vai sair. Obrigatório, e não opcional com
   * padrão: um padrão aqui escolheria em silêncio a numeração de um ambiente
   * para a nota do outro — exatamente o defeito que a série com ambiente fecha.
   */
  environment: FiscalEnvironment,
): number {
  const series = seriesDoAmbiente(companyId, model, environment);
  const ambiente = rotuloDoAmbienteDaSerie(environment);

  if (pedida !== undefined) {
    if (!series.some((s) => s.serie === pedida)) {
      const deOutroAmbiente = getSeries(companyId, model).find(
        (s) => s.serie === pedida && s.active && s.environment !== null && s.environment !== environment,
      );
      throw new ApiError(
        'CORE_FISCAL_SERIE_NAO_CONFIGURADA',
        deOutroAmbiente
          ? `A série ${pedida} do modelo ${model} é reservada para `
            + `${rotuloDoAmbienteDaSerie(deOutroAmbiente.environment!)}, e esta operação emite em `
            + `${ambiente}. Use uma série de ${ambiente} (Fiscal › Configuração › Numeração das notas).`
          : `A série ${pedida} não está cadastrada e ativa para o modelo ${model} desta operação `
            + `(ambiente: ${ambiente}). Cadastre em Fiscal › Configuração › Numeração das notas.`,
        400,
      );
    }
    return pedida;
  }

  if (series.length === 0) {
    throw new ApiError(
      'CORE_FISCAL_SERIE_NAO_CONFIGURADA',
      `Nenhuma série ativa para o modelo ${model} nesta operação (ambiente: ${ambiente}). `
        + 'Cadastre em Fiscal › Configuração › Numeração das notas antes de emitir.',
      400,
    );
  }

  if (series.length > 1) {
    throw new ApiError(
      'CORE_FISCAL_SERIE_AMBIGUA',
      `Esta operação tem ${series.length} séries ativas para o modelo ${model} `
        + `(${series.map((s) => s.serie).join(', ')}). Informe qual usar na emissão.`,
      400,
    );
  }

  return series[0].serie;
}

export function rotuloDoAmbienteDaSerie(environment: FiscalEnvironment): string {
  return environment === 'production' ? 'produção' : 'homologação';
}

/*
  A SÉRIE TEM AMBIENTE (auditoria P0 da Preço Justo).

  A chave única do documento é (empresa, modelo, série, número) — sem o
  ambiente. Uma série só, servindo aos dois, fazia cada nota de TESTE da
  homologação gastar um número que a produção nunca mais poderia usar: o
  contador define "NFC-e série 1, nº inicial 1", a loja testa dez cupons na
  homologação, e o primeiro cupom de verdade sai com o nº 11 — com a faixa de
  1 a 10 nunca emitida em produção, esperando inutilização.

  A coluna `environment` diz a que ambiente a série serve. NULO é o legado:
  serve aos dois, como sempre serviu — quem nunca marcou nada continua
  emitindo exatamente como antes. Uma série marcada nunca é usada no outro
  ambiente, e as marcadas ganham das legadas quando as duas existem.
*/
export function seriesDoAmbiente(
  companyId: string,
  model: string,
  environment: FiscalEnvironment,
): SerieFiscal[] {
  const ativas = getSeries(companyId, model).filter((s) => s.active);
  const marcadas = ativas.filter((s) => s.environment === environment);
  return marcadas.length > 0 ? marcadas : ativas.filter((s) => s.environment === null);
}

export interface SerieFiscal {
  serie: number;
  nextNumber: number;
  active: boolean;
  /** A que ambiente a série serve; `null` = aos dois (legado). */
  environment: FiscalEnvironment | null;
  /**
   * Quantos documentos já usaram números desta série, por ambiente. É o que
   * mostra, antes da virada, se a homologação andou gastando a numeração que
   * a produção vai usar.
   */
  usadas: { homologation: number; production: number };
}

/** Situação atual da série, para a tela de configuração. */
export function getSeries(companyId: string, model: string): SerieFiscal[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT s.serie, s.next_number, s.active, s.environment,
              (SELECT COUNT(*) FROM core_fiscal_documents d
                WHERE d.company_id = s.company_id AND d.model = s.model AND d.serie = s.serie
                  AND d.environment = 'homologation') AS usadas_homologacao,
              (SELECT COUNT(*) FROM core_fiscal_documents d
                WHERE d.company_id = s.company_id AND d.model = s.model AND d.serie = s.serie
                  AND d.environment = 'production') AS usadas_producao
         FROM core_fiscal_series s
        WHERE s.company_id = ? AND s.model = ?
        ORDER BY s.serie`,
    )
    .all(companyId, model) as unknown as {
    serie: number;
    next_number: number;
    active: number;
    environment: string | null;
    usadas_homologacao: number;
    usadas_producao: number;
  }[];
  return rows.map((r) => ({
    serie: Number(r.serie),
    nextNumber: Number(r.next_number),
    active: r.active === 1,
    environment:
      r.environment === 'production' || r.environment === 'homologation' ? r.environment : null,
    usadas: {
      homologation: Number(r.usadas_homologacao ?? 0),
      production: Number(r.usadas_producao ?? 0),
    },
  }));
}

/**
 * Define a numeração inicial de uma série.
 *
 * Só PARA FRENTE. Recuar o contador faria a próxima emissão repetir um número
 * já enviado à SEFAZ — que rejeita por duplicidade, com a venda já registrada.
 */
export function setSeriesNextNumber(input: {
  companyId: string;
  model: string;
  serie: number;
  nextNumber: number;
  /**
   * A que ambiente a série serve. Ausente = não mexe no que está gravado;
   * `null` = serve aos dois (o legado).
   */
  environment?: FiscalEnvironment | null;
}): void {
  ensureCoreSchema();

  if (
    input.environment !== undefined
    && input.environment !== null
    && input.environment !== 'homologation'
    && input.environment !== 'production'
  ) {
    throw new ApiError(
      'CORE_FISCAL_ENVIRONMENT_INVALID',
      `Ambiente "${String(input.environment)}" não existe para a série. Os valores são `
        + '"homologation", "production" ou vazio (a série serve aos dois ambientes).',
      400,
    );
  }

  /*
    Os três campos são conferidos ANTES de abrir a transação, porque a partir
    da rodada 33 eles vêm de uma tela — e campo de tela é texto: vazio vira 0,
    letra vira NaN. NaN atravessava `Number.isInteger`? Não; mas nada o
    barrava aqui, e ele seguia até o bind do INSERT, onde o SQLite respondia
    "NOT NULL constraint failed: core_fiscal_series.serie". O efeito era 500
    cru numa tela de configuração: quem digitou errado lia "erro inesperado".

    A faixa 0–999 não é escolha nossa: é o tamanho do campo `serie` no layout
    da NF-e. Aceitar -1 gravava uma série que nenhuma emissão poderia usar, e
    o checklist continuava dizendo que faltava série — sem dizer por quê.
  */
  if (input.model !== MODEL_NFE && input.model !== MODEL_NFCE) {
    throw new ApiError(
      'CORE_FISCAL_MODEL_INVALID',
      `Modelo fiscal inválido: "${input.model}". Este núcleo emite ${MODEL_NFE} (NF-e) e ${MODEL_NFCE} (NFC-e).`,
      400,
    );
  }
  if (!Number.isInteger(input.serie) || input.serie < 0 || input.serie > 999) {
    throw new ApiError(
      'CORE_FISCAL_SERIE_INVALID',
      'A série é um número inteiro de 0 a 999 — é o tamanho do campo no layout da NF-e.',
      400,
    );
  }
  if (!Number.isInteger(input.nextNumber) || input.nextNumber < 1) {
    throw new ApiError('CORE_FISCAL_NUMBER_INVALID', 'A numeração começa em 1.', 400);
  }

  withTransaction(() => {
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_fiscal_series (id, company_id, model, serie, next_number, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (company_id, model, serie) DO NOTHING`,
    ).run(
      randomUUID(),
      input.companyId,
      input.model,
      input.serie,
      input.nextNumber,
      new Date().toISOString(),
    );

    const atual = db
      .prepare(
        'SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = ? AND serie = ?',
      )
      .get(input.companyId, input.model, input.serie) as { next_number: number };

    if (input.nextNumber < Number(atual.next_number)) {
      throw new ApiError(
        'CORE_FISCAL_NUMBER_REGRESSION',
        `A numeração não pode retroceder: a série já está em ${atual.next_number}. `
          + 'Repetir um número já enviado é rejeição por duplicidade.',
        409,
      );
    }

    db.prepare(
      'UPDATE core_fiscal_series SET next_number = ? WHERE company_id = ? AND model = ? AND serie = ?',
    ).run(input.nextNumber, input.companyId, input.model, input.serie);

    if (input.environment !== undefined) {
      /*
        Reservar para HOMOLOGAÇÃO uma série que já tem nota de PRODUÇÃO é
        recusado: os próximos testes gastariam números de uma sequência que o
        fisco já conhece desta loja, e a produção seguiria com buracos que só a
        inutilização fecha. Para testar, outra série.
      */
      if (input.environment === 'homologation') {
        const producao = db
          .prepare(
            `SELECT COUNT(*) AS n FROM core_fiscal_documents
              WHERE company_id = ? AND model = ? AND serie = ? AND environment = 'production'`,
          )
          .get(input.companyId, input.model, input.serie) as { n: number };
        if (Number(producao.n) > 0) {
          throw new ApiError(
            'CORE_FISCAL_SERIE_JA_USADA_EM_PRODUCAO',
            `A série ${input.serie} do modelo ${input.model} já tem ${producao.n} nota(s) de `
              + 'produção e não pode passar a servir à homologação. Cadastre outra série para os testes.',
            409,
          );
        }
      }
      db.prepare(
        'UPDATE core_fiscal_series SET environment = ? WHERE company_id = ? AND model = ? AND serie = ?',
      ).run(input.environment, input.companyId, input.model, input.serie);
    }
  });
}
