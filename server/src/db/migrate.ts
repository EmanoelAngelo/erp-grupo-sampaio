import { ensureSchema, getSchemaVersion, setSchemaVersion } from './database.js';
import { ehPontoDeEntrada } from '../utils/pontoDeEntrada.js';

/**
 * O último degrau da camada de DOCUMENTOS. Ela parou aqui e não anda mais: o
 * que muda com o código é o NÚCLEO (`CORE_TARGET_VERSION`, em
 * `core-migrations.ts`). Exportado para quem mostra a versão rotular os dois
 * números sem confundir um com o outro (GAP-PRD-057).
 */
export const ALVO_DA_CAMADA_DE_DOCUMENTOS = 19;

/*
  A CAMADA DE DOCUMENTOS SOBE LENDO UM NÚMERO, NÃO O BANCO (GAP-PRD-148).

  Esta função começava com `loadDb()`: lia TODAS as coleções, cada linha
  passando por `JSON.parse`, a cada boot — para descobrir que o banco já
  estava em 19 e não fazer nada. E cada degrau pendente chamava `persistDb`,
  que APAGA e REINSERE todas as coleções numa transação, para gravar
  exatamente o mesmo conteúdo. Com `api_request_logs` (30 dias) e
  `api_sessions` crescendo, a subida ficava mais lenta a cada semana.

  Os dezoito degraus (2 a 19) faziam uma coisa só: garantir que certas
  coleções existissem como lista vazia no objeto em memória. A coleção é uma
  TABELA desde a troca do JSON pelo SQLite, e quem a cria é `ensureSchema`
  (`CREATE TABLE IF NOT EXISTS` para cada nome de `TABLE_NAMES`). Os degraus 4,
  9 e 10 já tinham saído na rodada 36; o 19 já era um carimbo sem corpo. O
  que sobrava de cada um era o carimbo da versão — e é só isso que resta.

  Um banco parado em qualquer degrau (inclusive sem versão nenhuma) chega a 19
  sem que uma linha seja lida ou reescrita. `loadDb`/`persistDb` continuam
  existindo para os testes que as usam, e nenhum caminho de boot as chama.
*/
export function runMigrations(): void {
  ensureSchema();
  if (getSchemaVersion() >= ALVO_DA_CAMADA_DE_DOCUMENTOS) return;
  setSchemaVersion(ALVO_DA_CAMADA_DE_DOCUMENTOS);
}

/*
  O COMANDO `npm run db:migrate` (GAP-PRD-056) — e `node server/dist/db/migrate.js`
  no servidor.

  A guarda montava a URL à mão (`file://` + argv[1]). No Windows o caminho
  vira `file:///C:/...` (três barras) e o espaço de "Grupo Sampaio" vira `%20`:
  a comparação nunca batia, e o comando saía em silêncio, sem migrar e sem
  dizer nada. Quem seguia o checklist achava que tinha migrado.

  E ele agora faz o que o boot faz — documentos, NÚCLEO e os fatos estruturais
  do grupo —, pela mesma função (`prepararBanco`). Antes só cobria a camada de
  documentos (alvo 19): não havia jeito de levar o núcleo à versão da build sem
  subir o servidor.

  Import dinâmico e sem `await` no topo: `migracaoCompleta` importa este
  arquivo, e esperar por ela aqui dentro travaria o ciclo de módulos.
*/
if (ehPontoDeEntrada(import.meta.url)) {
  void import('./migracaoCompleta.js').then(({ migrarPelaLinhaDeComando }) => {
    process.exitCode = migrarPelaLinhaDeComando();
  });
}
