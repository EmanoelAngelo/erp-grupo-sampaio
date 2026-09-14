/**
 * Proteção do banco operacional contra operação destrutiva.
 *
 * POR QUE ISTO EXISTE
 *
 * `resetDbForTests()` apaga TODAS as tabelas. Dentro da suíte é inofensivo —
 * `tests/setup.ts` aponta o banco para um arquivo temporário. Fora dela, a
 * mesma função apaga o banco que o caminho configurado indicar, e o padrão é
 * o banco OPERACIONAL.
 *
 * Não é hipótese. Um script avulso de depuração, rodado com `tsx` na raiz do
 * repositório, chamou essa função e zerou a base real: produtos, empresas,
 * usuários e vendas foram embora de uma vez. NA ÉPOCA, só voltaram porque o
 * arquivo estava versionado no git. ISSO NÃO É MAIS VERDADE: o banco saiu do
 * git de propósito (dado de cliente não pertence a repositório), e o que o
 * traz de volta hoje é o backup diário de `db/backup.ts` — restaurado com
 * `npm run db:restore`. Uma função capaz de zerar a base não pode depender de
 * quem chama lembrar de configurar o ambiente, e a rede de salvação tem que
 * ser a que existe, não a que existiu.
 *
 * DEFESA EM PROFUNDIDADE — as duas barreiras são independentes
 *
 * 1. POSITIVA: o banco precisa estar MARCADO como descartável. Marca válida é
 *    `:memory:` ou o caminho exato anunciado em `TEST_DATABASE_PATH`. Nenhuma
 *    heurística de nome de arquivo: um banco chamado `producao-teste.db` não
 *    vira descartável por causa da palavra "teste".
 *
 * 2. NEGATIVA: mesmo marcado, o caminho do banco operacional é recusado. Se
 *    alguém apontar `TEST_DATABASE_PATH` para a base real — por engano ou por
 *    copiar um comando —, a barreira positiva passaria e esta segura.
 *
 * `NODE_ENV=test` NÃO basta e não é aceito sozinho: é uma variável que
 * qualquer ferramenta define, e ela não diz NADA sobre qual arquivo será
 * apagado. A pergunta certa nunca é "estou em teste?", é "qual banco eu estou
 * prestes a destruir?".
 */
import { isAbsolute, resolve } from 'node:path';
import { resolveDatabasePath, repoRoot } from './sqlite.js';

/** Caminho do banco operacional — o que nunca pode ser destruído. */
export const OPERATIONAL_DATABASE_PATH = './server/data/grupo-sampaio.db';

function normalizar(caminho: string): string {
  if (caminho === ':memory:') return ':memory:';
  const absoluto = isAbsolute(caminho) ? caminho : resolve(repoRoot(), caminho);
  // Windows entrega o mesmo arquivo com barras e maiúsculas diferentes; sem
  // normalizar, a comparação de caminhos passaria por acidente.
  return absoluto.replace(/\\/g, '/').toLowerCase();
}

/** É o banco operacional? Comparação por caminho real, não por nome. */
export function isOperationalDatabase(caminho = resolveDatabasePath()): boolean {
  return normalizar(caminho) === normalizar(OPERATIONAL_DATABASE_PATH);
}

/**
 * O banco está marcado como descartável?
 *
 * Só duas marcas valem, e as duas são explícitas. Banco em memória morre com o
 * processo; `TEST_DATABASE_PATH` é anunciado por quem criou o arquivo
 * temporário, e precisa bater com o caminho que será realmente usado.
 */
export function isDisposableDatabase(caminho = resolveDatabasePath()): boolean {
  if (caminho === ':memory:') return true;
  const anunciado = process.env.TEST_DATABASE_PATH?.trim();
  if (!anunciado) return false;
  return normalizar(anunciado) === normalizar(caminho);
}

export class OperationalDatabaseProtected extends Error {
  constructor(operacao: string, caminho: string, motivo: string) {
    super(
      `"${operacao}" é destrutiva e foi recusada. Banco alvo: "${caminho}". ${motivo} `
        + 'Para operar sobre um banco descartável, crie um arquivo temporário e anuncie o '
        + 'MESMO caminho em TEST_DATABASE_PATH e DEVORA_DATABASE_PATH.',
    );
    this.name = 'OperationalDatabaseProtected';
  }
}

/**
 * Porteiro de toda operação destrutiva.
 *
 * Chamado ANTES de qualquer DELETE, DROP ou TRUNCATE. Falha fechado: na
 * dúvida, recusa.
 */
export function assertDestructiveAllowed(operacao: string): void {
  const caminho = resolveDatabasePath();

  // Barreira negativa primeiro: é a que não admite exceção nenhuma.
  if (isOperationalDatabase(caminho)) {
    throw new OperationalDatabaseProtected(
      operacao,
      caminho,
      'Este é o BANCO OPERACIONAL do Grupo Sampaio, com produtos, vendas e fiscal reais.',
    );
  }

  if (!isDisposableDatabase(caminho)) {
    throw new OperationalDatabaseProtected(
      operacao,
      caminho,
      'O banco não está marcado como descartável (TEST_DATABASE_PATH não corresponde a ele).',
    );
  }
}
