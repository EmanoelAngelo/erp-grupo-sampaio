/**
 * O CATÁLOGO DECORADO DA VITRINE, GUARDADO ENQUANTO NADA MUDOU (GAP-PRD-071).
 *
 * A vitrine é pública e sem sessão, e montar o catálogo de uma loja custa
 * proporcional ao catálogo inteiro: ler todos os produtos publicados, aplicar
 * promoção vigente, agregar grade e saldo. `node:sqlite` é síncrono, no MESMO
 * processo que atende o PDV — cada visita à home refazia esse trabalho, e o
 * teto de 300 requisições por minuto por IP bastava para um único robô ocupar
 * dezenas de segundos de CPU por minuto.
 *
 * ============================================================================
 * QUANDO O GUARDADO DEIXA DE VALER
 * ============================================================================
 *
 * A versão tem três partes, e qualquer mudança em uma delas refaz o catálogo:
 *
 *   1. `total_changes()` — o contador do SQLite de linhas inseridas, alteradas
 *      ou apagadas por esta conexão desde que ela abriu. QUALQUER gravação
 *      conta: produto, estoque, reserva, promoção, foto, configuração da loja.
 *      Não existe escritor que alguém esqueça de avisar — o que era o risco de
 *      uma invalidação "por evento".
 *   2. `schema_version` — muda com qualquer DDL (tabela recriada, coluna
 *      nova). DDL não entra no contador acima.
 *   3. O minuto corrente — promoção com horário começa e termina em minuto
 *      cheio; virar o minuto é o que a faz entrar e sair na hora.
 *
 * O preço disso é refazer demais, nunca de menos: uma venda no balcão refaz o
 * catálogo da próxima visita mesmo sem tocar produto publicado. É o lado
 * certo — o saldo da vitrine nunca fica velho — e uma rajada de visitas SEM
 * gravação no meio custa uma consulta de conferência por visita.
 *
 * Gravação feita por OUTRO processo no mesmo arquivo não aparece no contador
 * desta conexão; o minuto limita essa defasagem a 60 segundos. O checkout
 * confere preço e saldo no servidor de qualquer jeito.
 *
 * O guardado é por conexão (WeakMap): trocar de banco — o que os testes fazem
 * — nunca reaproveita catálogo de outro arquivo.
 */
import type { DatabaseSync } from 'node:sqlite';
import { getConnection } from '../../db/sqlite.js';

interface Guardado {
  versao: string;
  valor: unknown;
}

/** Uma chave por loja, mais a do grupo inteiro: poucas, mas com teto. */
const MAXIMO_DE_CHAVES = 32;

const porConexao = new WeakMap<DatabaseSync, Map<string, Guardado>>();

function versaoDoBanco(db: DatabaseSync): string {
  const linha = db
    .prepare(
      'SELECT total_changes() AS mudancas, (SELECT schema_version FROM pragma_schema_version) AS esquema',
    )
    .get() as { mudancas: number; esquema: number };
  const minuto = new Date().toISOString().slice(0, 16);
  return `${linha.mudancas}|${linha.esquema}|${minuto}`;
}

/**
 * Devolve o valor guardado para `chave` se o banco não mudou desde que ele foi
 * montado; senão monta de novo com `montar` e guarda.
 *
 * `montar` só pode LER. O valor devolvido é compartilhado entre requisições:
 * quem o recebe copia antes de mexer.
 */
export function lembrarDaVitrine<T>(chave: string, montar: () => T): T {
  const db = getConnection();
  let mapa = porConexao.get(db);
  if (!mapa) {
    mapa = new Map();
    porConexao.set(db, mapa);
  }

  const versao = versaoDoBanco(db);
  const achado = mapa.get(chave);
  if (achado && achado.versao === versao) return achado.valor as T;

  const valor = montar();
  mapa.delete(chave);
  if (mapa.size >= MAXIMO_DE_CHAVES) {
    const maisAntiga = mapa.keys().next().value;
    if (maisAntiga !== undefined) mapa.delete(maisAntiga);
  }
  mapa.set(chave, { versao, valor });
  return valor;
}
