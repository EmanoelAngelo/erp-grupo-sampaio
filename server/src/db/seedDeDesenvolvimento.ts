/**
 * ============================================================================
 * O SEED DE DESENVOLVIMENTO — as doze contas de demonstração, só na bancada
 * ============================================================================
 *
 *     npm run db:seed:dev --prefix server
 *
 * CARLOSGERENTE (gestor nas seis), um `<slug>.pdv` por operação, quatro
 * mecânicos da Oficina de Mobilidade e JOAOCELULAR (Oficina de Celulares). São
 * as contas com que se desenvolve e se testa à mão — e que a instalação da
 * loja NÃO deve ter. Saíram do `db:seed`, que agora é o bootstrap de produção
 * (as seis empresas e o administrador inicial, `db/bootstrap.ts`).
 *
 * ## As travas, conferidas antes de abrir o banco
 *
 *   - RECUSA produção e homologação, pelos dois nomes (`DEVORA_API_ENV`
 *     production/staging, ou `NODE_ENV=production`);
 *   - RECUSA o banco operacional: o caminho de `db/safety.ts` e, como a stack
 *     descartável (`scripts/stack-descartavel.mjs`, `validarBanco`), qualquer
 *     arquivo chamado `grupo-sampaio.db`, de qualquer árvore. Para semear,
 *     aponte `DEVORA_DATABASE_PATH` para outro arquivo.
 *
 * ## As senhas
 *
 * Nenhuma escrita no código. `GRUPO_SAMPAIO_MANAGEMENT_PASSWORD` (gestão) e
 * `GRUPO_SAMPAIO_OPERATION_PASSWORD` (PDV e oficina) vêm de quem chama; sem
 * elas, cada conta ganha a SUA senha, devolvida uma única vez. Toda conta
 * nasce provisória (troca no primeiro acesso), e o que já existe não é tocado
 * — conta, senha, nome, perfil, empresa (GAP-PRD-040).
 *
 * O administrador não é daqui: é do bootstrap, que o cria com
 * `DEVORA_BOOTSTRAP_ADMIN_PASSWORD`.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { ensureDotEnvLoaded } from '../config/env.js';
import { ensureCoreSchema } from './schema.js';
import { getConnection, resolveDatabasePath } from './sqlite.js';
import { isOperationalDatabase } from './safety.js';
import { findUserByLogin } from '../services/auth/IdentityService.js';
import { hashPassword } from '../services/auth/PasswordService.js';
import { assertPassword } from '../services/core/TeamService.js';
import { EMPRESAS_DO_GRUPO, garantirEstruturaDoGrupo, inserirContaProvisoria, vincularSeAusente } from './bootstrap.js';

const GESTOR_DE_DEMONSTRACAO = 'CARLOSGERENTE';
const MECANICOS = ['ROBERTOMECANICO', 'MARCOSMECANICO', 'PAULOMECANICO', 'LUCASMECANICO'] as const;
/** Técnicos da oficina de celulares, que fica dentro do Preço Justo. */
const TECNICOS_DE_CELULAR = ['JOAOCELULAR'] as const;

export const CONTAS_DE_DEMONSTRACAO: readonly string[] = [
  GESTOR_DE_DEMONSTRACAO,
  ...EMPRESAS_DO_GRUPO.map((e) => `${e.slug}.pdv`),
  ...MECANICOS,
  ...TECNICOS_DE_CELULAR,
];

export class SeedDeDesenvolvimentoRecusado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'SeedDeDesenvolvimentoRecusado';
  }
}

/** O nome do banco operacional, em qualquer árvore — a régua de `validarBanco`. */
function temONomeDoBancoOperacional(caminho: string): boolean {
  const normal = caminho.replace(/\\/g, '/').toLowerCase();
  return normal.split('/').pop() === 'grupo-sampaio.db' || normal.endsWith('/server/data/grupo-sampaio.db');
}

/**
 * Os nomes com que o sistema abre o MESMO arquivo — a régua olha todos.
 *
 * O Windows descarta ponto e espaço no fim de cada trecho do caminho
 * ("grupo-sampaio.db." e "grupo-sampaio.db " abrem "grupo-sampaio.db") e
 * aceita o nome curto 8.3 ("GRUPO-~1.DB"). Olhando só o texto, um espaço
 * sobrando em DEVORA_DATABASE_PATH passava pela régua e semeava o banco
 * operacional — onde, na instalação da loja em `development`, a trava do
 * ambiente não segura. O caminho real (quando o arquivo existe) desfaz o nome
 * curto e os atalhos.
 */
function nomesDoMesmoArquivo(caminho: string): string[] {
  const nomes = [caminho];
  if (process.platform === 'win32') {
    nomes.push(
      caminho
        .split(/([\\/])/)
        .map((trecho) => (/^[. ]*$/.test(trecho) ? trecho : trecho.replace(/[. ]+$/, '')))
        .join(''),
    );
  }
  try {
    nomes.push(realpathSync.native(caminho));
  } catch {
    // Arquivo que ainda não existe não tem caminho real: os nomes acima bastam.
  }
  return nomes;
}

/**
 * Pode semear aqui? Lança `SeedDeDesenvolvimentoRecusado` se não. Olha o
 * ambiente e o CAMINHO — não abre arquivo nenhum.
 */
export function conferirQuePodeSemearDesenvolvimento(caminho?: string): void {
  ensureDotEnvLoaded();
  const apiEnv = (process.env.DEVORA_API_ENV ?? '').trim() || 'development';
  if (apiEnv === 'production' || apiEnv === 'staging' || (process.env.NODE_ENV ?? '').trim() === 'production') {
    const nome = apiEnv === 'production' || apiEnv === 'staging' ? `DEVORA_API_ENV=${apiEnv}` : 'NODE_ENV=production';
    throw new SeedDeDesenvolvimentoRecusado(
      `O seed de desenvolvimento cria contas de DEMONSTRAÇÃO e não roda em produção nem em homologação (${nome}). `
        + 'Lá, o único que roda é o bootstrap: npm run db:bootstrap --prefix server (o mesmo db:seed).',
    );
  }
  const alvo = caminho ?? resolveDatabasePath();
  if (
    alvo !== ':memory:'
    && nomesDoMesmoArquivo(alvo).some((nome) => isOperationalDatabase(nome) || temONomeDoBancoOperacional(nome))
  ) {
    throw new SeedDeDesenvolvimentoRecusado(
      `Banco recusado: ${alvo} é o banco operacional (ou tem o nome dele). O seed de desenvolvimento só semeia `
        + 'um banco de bancada: aponte DEVORA_DATABASE_PATH para outro arquivo (ex.: server/data/desenvolvimento.db).',
    );
  }
}

/** Sem 0/O, 1/l/I: a senha é lida numa folha e digitada num caixa. */
const ALFABETO_DA_SENHA = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const TAMANHO_DA_SENHA_GERADA = 14;

function gerarSenhaProvisoria(): string {
  let senha = '';
  for (let i = 0; i < TAMANHO_DA_SENHA_GERADA; i += 1) {
    senha += ALFABETO_DA_SENHA[randomInt(ALFABETO_DA_SENHA.length)];
  }
  return senha;
}

type Familia = 'gestao' | 'operacao';

/** Variável vazia (`GRUPO_SAMPAIO_…=` no .env) é ausência, não senha vazia. */
function informada(valor: string | undefined): string | undefined {
  return valor && valor.trim() ? valor : undefined;
}

export interface ResultadoDoSeedDeDesenvolvimento {
  /** Contas que o seed conhece (12) — criadas agora ou já existentes. */
  contas: number;
  contasCriadas: string[];
  contasPreservadas: string[];
  modoDeSenha: 'variaveis' | 'individual' | 'misto' | 'nenhuma';
  /** As senhas GERADAS, uma por conta criada — só nesta resposta. */
  senhasGeradas: { login: string; senha: string }[];
}

export async function semearDesenvolvimento(): Promise<ResultadoDoSeedDeDesenvolvimento> {
  // Primeiro as travas — antes de qualquer conexão com o banco.
  conferirQuePodeSemearDesenvolvimento();

  const informadas: Record<Familia, string | undefined> = {
    gestao: informada(process.env.GRUPO_SAMPAIO_MANAGEMENT_PASSWORD),
    operacao: informada(process.env.GRUPO_SAMPAIO_OPERATION_PASSWORD),
  };
  for (const senha of Object.values(informadas)) {
    if (senha === undefined) continue;
    try {
      assertPassword(senha);
    } catch (err) {
      throw new Error(`Senha informada ao seed de desenvolvimento recusada: ${(err as Error).message}`, { cause: err });
    }
  }

  const modos = new Set<ResultadoDoSeedDeDesenvolvimento['modoDeSenha']>();
  const senhasGeradas: ResultadoDoSeedDeDesenvolvimento['senhasGeradas'] = [];
  const senhaDaNova = (familia: Familia, login: string): string => {
    const daVariavel = informadas[familia];
    if (daVariavel !== undefined) {
      modos.add('variaveis');
      return daVariavel;
    }
    modos.add('individual');
    const senha = gerarSenhaProvisoria();
    senhasGeradas.push({ login, senha });
    return senha;
  };

  ensureCoreSchema();
  garantirEstruturaDoGrupo();
  const db = getConnection();
  const companyIds = new Map<string, string>();
  for (const empresa of EMPRESAS_DO_GRUPO) {
    const linha = db.prepare('SELECT id FROM core_companies WHERE slug = ?').get(empresa.slug) as { id: string };
    companyIds.set(empresa.slug, linha.id);
  }
  const empresa = (slug: string): string => companyIds.get(slug)!;

  const contasCriadas: string[] = [];
  const contasPreservadas: string[] = [];

  /**
   * Cria a conta se ela não existe. Devolve se os vínculos devem ser
   * semeados: conta criada agora, ou conta que existe sem vínculo nenhum.
   */
  const conta = async (login: string, displayName: string, familia: Familia): Promise<{ id: string; vincular: boolean }> => {
    const existente = findUserByLogin(login);
    if (existente) {
      contasPreservadas.push(existente.login);
      const vinculos = db
        .prepare('SELECT COUNT(*) AS n FROM core_user_companies WHERE user_id = ?')
        .get(existente.id) as { n: number };
      return { id: existente.id, vincular: vinculos.n === 0 };
    }
    const id = inserirContaProvisoria(login, displayName, await hashPassword(senhaDaNova(familia, login)));
    contasCriadas.push(login);
    return { id, vincular: true };
  };

  // Gestor: acesso de gestão às seis operações.
  const gestor = await conta(GESTOR_DE_DEMONSTRACAO, 'Carlos Gerente', 'gestao');
  if (gestor.vincular) {
    for (const e of EMPRESAS_DO_GRUPO) vincularSeAusente(gestor.id, empresa(e.slug), 'gestor', e.slug === 'preco-justo');
  }

  // Um operador de PDV por operação, restrito à própria empresa.
  for (const e of EMPRESAS_DO_GRUPO) {
    const perfil = e.kind === 'workshop' ? 'operador_caixa_oficina' : 'operador_caixa_loja';
    const pdv = await conta(`${e.slug}.pdv`, `PDV ${e.tradeName}`, 'operacao');
    if (pdv.vincular) vincularSeAusente(pdv.id, empresa(e.slug), perfil, true);
  }

  const bancada = (slug: string): string => {
    const row = db.prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as { id: string } | undefined;
    if (!row) throw new Error(`Oficina não encontrada no seed de desenvolvimento: ${slug}`);
    return row.id;
  };
  const vincularABancada = (userId: string, workshopId: string): void => {
    db.prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'mecanico', ?)
       ON CONFLICT (workshop_id, user_id) DO NOTHING`,
    ).run(randomUUID(), workshopId, userId, new Date().toISOString());
  };

  // Mecânicos de mobilidade: pertencem à Oficina e SOMENTE à oficina de motos.
  const mobilidade = bancada('oficina-mobilidade');
  for (const login of MECANICOS) {
    const mecanico = await conta(login, login.replace('MECANICO', ' (Mecânico)'), 'operacao');
    if (mecanico.vincular) {
      vincularSeAusente(mecanico.id, empresa('oficina'), 'mecanico', true);
      vincularABancada(mecanico.id, mobilidade);
    }
  }

  // Técnico de celulares: pertence ao Preço Justo e só enxerga a oficina de celulares.
  const celulares = bancada('oficina-celulares');
  for (const login of TECNICOS_DE_CELULAR) {
    const tecnico = await conta(login, login.replace('CELULAR', ' (Técnico)'), 'operacao');
    if (tecnico.vincular) {
      vincularSeAusente(tecnico.id, empresa('preco-justo'), 'mecanico', true);
      vincularABancada(tecnico.id, celulares);
    }
  }

  return {
    contas: CONTAS_DE_DEMONSTRACAO.length,
    contasCriadas,
    contasPreservadas,
    modoDeSenha: modos.size > 1 ? 'misto' : ([...modos][0] ?? 'nenhuma'),
    senhasGeradas,
  };
}

/** O que o comando imprime: cada senha gerada UMA vez, ao lado do login dela. */
export function relatorioDoSeedDeDesenvolvimento(r: ResultadoDoSeedDeDesenvolvimento): string[] {
  const linhas = [
    `Seed de desenvolvimento: ${r.contasCriadas.length} conta(s) de demonstração criada(s), `
      + `${r.contasPreservadas.length} já existente(s).`,
  ];
  if (r.contasPreservadas.length > 0) {
    linhas.push(`Contas que já existiam NÃO foram alteradas (senha, nome, perfil): ${r.contasPreservadas.join(', ')}.`);
  }
  if (r.contasCriadas.length === 0) return linhas;
  linhas.push('As contas criadas nascem com senha PROVISÓRIA: cada uma troca no primeiro acesso.');
  if (r.senhasGeradas.length > 0) {
    linhas.push('Senhas geradas — uma por conta. Não ficam gravadas em lugar nenhum e não serão mostradas de novo.');
    for (const { login, senha } of r.senhasGeradas) linhas.push(`  ${login.padEnd(18)} ${senha}`);
  }
  if (r.modoDeSenha === 'variaveis' || r.modoDeSenha === 'misto') {
    linhas.push('Gestão (CARLOSGERENTE): GRUPO_SAMPAIO_MANAGEMENT_PASSWORD, quando informada.');
    linhas.push('Operação (PDVs, mecânicos): GRUPO_SAMPAIO_OPERATION_PASSWORD, quando informada.');
  }
  return linhas;
}
