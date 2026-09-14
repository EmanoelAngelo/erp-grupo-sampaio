/**
 * ============================================================================
 * O REGISTRO EM ARQUIVO — um por dia da loja, com carimbo e retenção
 * ============================================================================
 *
 * A API escreve o log estruturado na saída padrão (`logInfo`/`logError`, uma
 * linha JSON por evento). Sob o Docker ou o systemd isso basta: eles guardam a
 * saída com a hora. Como tarefa agendada do Windows — o caso da loja — não há
 * terminal nem diário: a saída ia para lugar nenhum, e o "o que aconteceu de
 * madrugada?" não tinha resposta.
 *
 * O supervisor (`scripts/supervisionar-api`) passa a saída da API por aqui:
 *
 *   - um arquivo por DIA DA LOJA (`api-2026-09-10.log`), não por dia UTC — o
 *     que aconteceu às 23h de São Paulo fica no arquivo daquele dia;
 *   - cada linha ganha o carimbo ISO na frente (o JSON da API não tem hora);
 *   - linha que chega partida em dois pedaços de saída é gravada inteira;
 *   - na virada do dia, arquivos `api-*.log` mais velhos que a retenção saem.
 *     Só os que seguem o nome — nada mais na pasta é tocado.
 *
 * Falhar ao gravar NUNCA derruba quem escreve: o registro é o espectador da
 * API, não parte dela. A primeira falha é dita uma vez no stderr.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { diaDaLoja, somarDias } from '../core/CalendarioOperacional.js';

export const RETENCAO_DE_LOG_PADRAO_DIAS = 30;

export interface OpcoesDoRegistro {
  pasta: string;
  /** Quantos dias de arquivo ficam, contando hoje. Mínimo 1. */
  retencaoDias?: number;
  prefixo?: string;
  agora?: () => Date;
}

export interface RegistroDiario {
  /** Recebe texto cru (pedaços de saída); grava as linhas completas. */
  escrever(texto: string): void;
  /** Grava o resto que ficou sem quebra de linha. */
  descarregar(): void;
  arquivoDoDia(): string;
}

/** Lê a retenção de um texto de ambiente; inválido cai no padrão. */
export function retencaoDoAmbiente(bruto: string | undefined): number {
  const n = Number.parseInt(String(bruto ?? ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : RETENCAO_DE_LOG_PADRAO_DIAS;
}

export function criarRegistroDiario(opcoes: OpcoesDoRegistro): RegistroDiario {
  const prefixo = opcoes.prefixo ?? 'api';
  const retencao = Math.max(1, Math.floor(opcoes.retencaoDias ?? RETENCAO_DE_LOG_PADRAO_DIAS));
  const agora = opcoes.agora ?? (() => new Date());
  const nomeDoDia = new RegExp(`^${prefixo}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
  let pendente = '';
  let diaAberto: string | null = null;
  let jaAvisou = false;

  const arquivo = (dia: string) => join(opcoes.pasta, `${prefixo}-${dia}.log`);

  const podar = (hoje: string): void => {
    const limite = somarDias(hoje, -retencao);
    for (const nome of readdirSync(opcoes.pasta)) {
      const m = nome.match(nomeDoDia);
      if (m && m[1] <= limite) rmSync(join(opcoes.pasta, nome), { force: true });
    }
  };

  const gravar = (linhas: string[]): void => {
    if (linhas.length === 0) return;
    const instante = agora();
    const dia = diaDaLoja(instante);
    try {
      if (dia !== diaAberto) {
        mkdirSync(opcoes.pasta, { recursive: true });
        podar(dia);
        diaAberto = dia;
      }
      const carimbo = instante.toISOString();
      appendFileSync(arquivo(dia), linhas.map((l) => `${carimbo} ${l}\n`).join(''));
    } catch (erro) {
      if (!jaAvisou) {
        jaAvisou = true;
        const motivo = erro instanceof Error ? erro.message : String(erro);
        process.stderr.write(`registro em arquivo indisponível em ${opcoes.pasta}: ${motivo}\n`);
      }
    }
  };

  return {
    escrever(texto: string): void {
      pendente += texto;
      const partes = pendente.split(/\r?\n/);
      pendente = partes.pop() ?? '';
      gravar(partes.filter((l) => l.length > 0));
    },
    descarregar(): void {
      if (!pendente) return;
      const resto = pendente;
      pendente = '';
      gravar([resto]);
    },
    arquivoDoDia(): string {
      return arquivo(diaDaLoja(agora()));
    },
  };
}
