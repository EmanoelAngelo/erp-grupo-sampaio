/**
 * Setup global dos testes.
 *
 * Cada worker do Vitest recebe seu próprio arquivo SQLite. Sem isso, os
 * arquivos de teste rodando em paralelo compartilhariam o mesmo banco e
 * colidiriam nas constraints reais (UNIQUE de login, numeração de venda etc.).
 *
 * Deliberadamente NÃO define nenhuma outra variável de ambiente: cada teste
 * controla o próprio `DEVORA_API_ENV` e seus segredos, e sobrescrevê-los aqui
 * mudaria o comportamento que eles pretendem verificar.
 *
 * Há DUAS exceções. Uma está logo abaixo; a outra, no fim do arquivo.
 */

/*
  ============================================================================
  A SUÍTE NÃO LÊ O `.env` DA MÁQUINA
  ============================================================================

  `loadDotEnvFiles()` procura `.env` em `process.cwd()` e um nível acima — o que,
  rodando a suíte de dentro de `server/`, alcança o `.env` de quem está
  desenvolvendo. O valor já em `process.env` ganha, então o efeito é silencioso:
  variável que o teste NÃO definiu vem do arquivo da máquina.

  Isso não é hipótese. Dois casos simulavam chave ausente em produção
  apagando `DEVORA_ENCRYPTION_KEY` e cobrando que o servidor recusasse subir.
  Passavam — porque a chave realmente não existia naquele `.env`. No dia em que
  ela foi gerada de verdade, os dois ficaram vermelhos sem uma linha de código
  de produção ter mudado: o carregador repunha o que o teste tinha acabado de
  apagar.

  Um teste que muda de cor conforme a máquina não está testando o sistema. E o
  risco não para nos dois casos: o `.env` desta bancada traz
  `ASAAS_PRODUCTION_ENABLED=true` e as credenciais do Supabase. Qualquer teste
  que leia essas variáveis sem declará-las estava lendo produção.

  A partir daqui, o que o teste não declarar não existe.
*/
process.env.DEVORA_IGNORE_DOTENV = 'true';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeConnection } from '../src/db/sqlite.js';

/**
 * A pasta desta execução, criada por `tests/global-setup.ts` no processo
 * principal e herdada por este worker pelo ambiente.
 *
 * O fallback para `tmpdir()` existe para quem importar este arquivo fora do
 * Vitest (um script solto, um depurador): ali não há `globalSetup`, e uma pasta
 * direto no temporário continua sendo um banco descartável válido — ela só
 * perde a garantia de ser apagada no fim, e cai na varredura de resíduo da
 * próxima execução.
 */
const raizDaExecucao = process.env.GS_ERP_TEST_TMP_ROOT ?? tmpdir();

const workerId = process.env.VITEST_WORKER_ID ?? '0';
const dir = mkdtempSync(join(raizDaExecucao, `gs-erp-test-${workerId}-`));

/**
 * E A LIMPEZA DA PASTA DESTA EXECUÇÃO — com a conexão FECHADA primeiro, que é
 * a linha inteira do conserto.
 *
 * O que estava aqui era só o `rmSync`, e o comentário dizia que ele "resolve o
 * caso normal", com o Windows segurando o arquivo como exceção. Medido: depois
 * de UMA execução completa sobravam 155 pastas com 935 MB — uma por arquivo de
 * teste, ou seja, o `rmSync` falhava em 100% dos casos. A exceção era a regra.
 *
 * O motivo é direto: o processo está morrendo com o SQLite ABERTO, e o Windows
 * não apaga arquivo que tem handle aberto. `closeConnection()` solta o handle
 * (e leva junto o `-wal` e o `-shm`), e aí a remoção funciona.
 *
 * `process.on('exit')` só aceita trabalho síncrono — `closeConnection` e
 * `rmSync` são os dois síncronos, que é por isso que o conserto cabe aqui.
 *
 * A falha continua engolida, e agora com a rede de segurança certa embaixo: o
 * `teardown` de `tests/global-setup.ts` apaga a raiz inteira depois que TODOS
 * os workers morreram, quando não existe mais handle nenhum para segurar nada.
 */
process.on('exit', () => {
  try {
    closeConnection();
  } catch {
    // Conexão já fechada, ou nunca aberta (arquivo de teste que não toca o
    // banco). O `rmSync` abaixo é o que interessa.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // O teardown do globalSetup apaga a raiz inteira depois desta linha.
  }
});

const testDbPath = join(dir, 'test.db');

process.env.DEVORA_DATABASE_PATH = testDbPath;

/**
 * Marca o banco como DESCARTÁVEL.
 *
 * As funções destrutivas (`resetDbForTests`) só operam sobre um banco cujo
 * caminho tenha sido anunciado aqui — ver `src/db/safety.ts`. Sem esta linha, a
 * suíte inteira falha em vez de apagar o que não devia, que é exatamente o
 * comportamento desejado: falhar fechado.
 */
process.env.TEST_DATABASE_PATH = testDbPath;

/**
 * E OS ARQUIVOS TAMBÉM VÃO PARA A PASTA DESTE WORKER.
 *
 * O banco desta suíte é descartável desde sempre. Os arquivos enviados não
 * eram: iam para as pastas de upload REAIS e ficavam lá, órfãos, porque o
 * banco que os conhecia era jogado fora no fim.
 *
 * `WorkshopPhotoService` já tinha percebido e criado `DEVORA_UPLOADS_DIR`, mas
 * só um arquivo de teste a definia — para si. As outras duas pastas nem
 * olhavam a variável.
 *
 * Resultado medido em 27/08/2026, antes desta linha existir: 458 arquivos em
 * `data/uploads/lojas`, todos com exatamente 70 bytes (o PNG de 1x1 dos
 * testes) e nenhuma referência no banco.
 */
process.env.DEVORA_UPLOADS_DIR = join(dir, 'uploads');

/**
 * E O BACKUP TAMBÉM (frente DEP/D2).
 *
 * A cópia do banco deixou de pular todo caminho que não seja
 * `server/data/grupo-sampaio.db`: pula só o banco DECLARADO descartável. Os
 * poucos testes que apontam `DEVORA_DATABASE_PATH` para um arquivo próprio sem
 * anunciá-lo em `TEST_DATABASE_PATH` (a deriva de esquema, que migra um banco
 * antigo) passam a ter cópia antes da migração — e ela cai aqui, na pasta do
 * worker, nunca na pasta de backups do repositório.
 */
process.env.DEVORA_BACKUP_DIR = join(dir, 'backups');

/**
 * As variáveis aposentadas do acesso sem senha não vêm do shell.
 *
 * O `.env` já não entra (DEVORA_IGNORE_DOTENV, acima), mas o ambiente de quem
 * roda a suíte pode trazer uma delas ligada — e aí todo teste que simula
 * produção estouraria na trava do boot, que recusa subir com elas ligadas. Os
 * testes que cobram essa trava ligam a variável no próprio cenário.
 */
for (const nome of ['DEVORA_DEV_QUICK_LOGIN', 'VITE_DEV_QUICK_LOGIN', 'GRUPO_SAMPAIO_QUICK_LOGIN']) {
  delete process.env[nome];
}

/*
  ============================================================================
  A SUÍTE DO SERVIDOR NÃO FALA COM A INSTALAÇÃO DA LOJA
  ============================================================================

  Os testes sobem o app em processo (supertest) e dublam os provedores
  externos. Nada aqui tem motivo para chamar a API ou o Vite que rodam nesta
  máquina — e, na máquina da loja, `localhost:8787` é a API de produção, que
  grava cada requisição no banco operacional (GAP-PRD-135). Um `fetch` para
  essas portas vira erro imediato, com a origem no texto.
*/
const PORTAS_DA_INSTALACAO = new Set(['8787', '3000']);
const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
const fetchOriginal = globalThis.fetch;
if (typeof fetchOriginal === 'function') {
  globalThis.fetch = (async (entrada: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const texto = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : (entrada as Request).url;
    let alvo: URL | null;
    try { alvo = new URL(texto); } catch { alvo = null; }
    if (alvo && HOSTS_LOCAIS.has(alvo.hostname) && PORTAS_DA_INSTALACAO.has(alvo.port)) {
      throw new TypeError(`Suíte do servidor recusou chamar ${alvo.origin}: esta porta é da instalação da loja, não de teste.`);
    }
    return fetchOriginal(entrada, init);
  }) as typeof fetch;
}
