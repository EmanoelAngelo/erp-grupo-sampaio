/**
 * ============================================================================
 * LIMPAR A DEMONSTRAÇÃO — `npm run db:limpar-demonstracao --prefix server`
 * ============================================================================
 *
 * O comando da entrega: tira do banco da instalação o que a demonstração
 * deixou (produtos, contas do seed, vendas, caixas, OS, pedidos, artefatos de
 * teste, a maquininha mock) e deixa a configuração do dono exatamente como
 * está. O roteiro inteiro está em docs/DEPLOY.md, "Preparar a entrega: limpar
 * a demonstração".
 *
 *     # 1. SIMULAÇÃO (padrão) — só lê; termina com a impressão digital
 *     npm run db:limpar-demonstracao --prefix server
 *
 *     # 2. APLICAÇÃO — com a API PARADA, e com a impressão da simulação
 *     npm run db:limpar-demonstracao --prefix server -- --aplicar <impressão>
 *
 * Opções:
 *   --banco <arquivo>                     outro arquivo em vez do banco da instalação
 *   --incluir-clientes                    tira também os clientes citados pela demonstração
 *   --incluir-fornecedor                  tira também o fornecedor da nota de teste
 *   --reiniciar-sequencias-de-etiqueta    recomeça também código de barras e plaquinha
 *
 * As flags de dúvida entram na impressão: aplique com as MESMAS da simulação.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpcoesDaLimpeza } from '../db/limpezaDaDemonstracao.js';
import { closeConnection } from '../db/sqlite.js';
import {
  aplicarLimpezaDaDemonstracao,
  simularLimpezaDaDemonstracao,
  type ResultadoDoComando,
} from '../services/implantacao/LimpezaDaDemonstracao.js';
import { ehPontoDeEntrada } from '../utils/pontoDeEntrada.js';

interface Argumentos {
  aplicar: string | null;
  banco: string | null;
  opcoes: OpcoesDaLimpeza;
}

function lerArgumentos(args: string[]): Argumentos | string {
  const r: Argumentos = { aplicar: null, banco: null, opcoes: {} };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--aplicar' || a === '--banco') {
      const valor = args[i + 1];
      if (!valor || valor.startsWith('--')) return `${a} precisa de um valor.`;
      if (a === '--aplicar') r.aplicar = valor.trim().toLowerCase();
      else r.banco = valor;
      i += 1;
    } else if (a === '--incluir-clientes') r.opcoes.incluirClientes = true;
    else if (a === '--incluir-fornecedor') r.opcoes.incluirFornecedor = true;
    else if (a === '--reiniciar-sequencias-de-etiqueta') r.opcoes.reiniciarSequenciasDeEtiqueta = true;
    else return `Argumento desconhecido: ${a}. Nada foi feito.`;
  }
  return r;
}

function imprimir(r: ResultadoDoComando): void {
  for (const l of r.linhas) console.log(l);
  for (const l of r.recusa) console.error(l);
}

/** Devolve o código de saída (0 = simulado, aplicado ou nada a fazer; 1 = recusado ou falhou). */
export function limparPelaLinhaDeComando(args: string[]): number {
  const lidos = lerArgumentos(args);
  if (typeof lidos === 'string') {
    console.error(lidos);
    return 1;
  }
  if (lidos.banco) {
    const arquivo = resolve(lidos.banco);
    if (!existsSync(arquivo)) {
      console.error(`--banco: o arquivo não existe: ${arquivo}`);
      return 1;
    }
    process.env.DEVORA_DATABASE_PATH = arquivo;
  }
  try {
    const r = lidos.aplicar
      ? aplicarLimpezaDaDemonstracao(lidos.aplicar, lidos.opcoes)
      : simularLimpezaDaDemonstracao(lidos.opcoes, Boolean(lidos.banco));
    imprimir(r);
    return r.codigo;
  } catch (err) {
    console.error(`A limpeza falhou: ${(err as Error).message}. Se a transação começou, ela voltou atrás.`);
    return 1;
  } finally {
    closeConnection();
  }
}

if (ehPontoDeEntrada(import.meta.url)) {
  process.exitCode = limparPelaLinhaDeComando(process.argv.slice(2));
}
