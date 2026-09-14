/**
 * ============================================================================
 * RETENÇÃO DO BUCKET — o que fica, o que sai, e por quê
 * ============================================================================
 *
 * A poda local existe desde a rodada 35: trinta dias, mínimo sete. A remota
 * nunca existiu. O módulo sabia enviar, listar e baixar; nada apagava.
 *
 * Medido em 27/08/2026: 530 objetos, 2,7 GB, num armazenamento pago, subindo a
 * cada boot do servidor — porque o diário rodava a cada subida, defeito
 * consertado na mesma rodada.
 *
 * ============================================================================
 * A POLÍTICA
 * ============================================================================
 *
 * Avô-pai-filho, que é o desenho clássico, com os prazos vindos do que este
 * sistema guarda:
 *
 *   DIÁRIOS   14 dias — "quebrei alguma coisa esta semana e não percebi".
 *                       Duas semanas cobre o intervalo entre um defeito entrar
 *                       e alguém notar no relatório.
 *
 *   SEMANAIS   8 semanas — dois meses. É o horizonte em que se descobre que um
 *                       lançamento vinha errado desde antes.
 *
 *   MENSAIS   12 meses — o ano fiscal. Nota emitida é guardada por anos, e o
 *                       banco é o que sabe o que foi emitido.
 *
 *   MÍNIMO     7 — por mais velhos que sejam, nunca ficar abaixo disto.
 *
 * Nenhum número é fixo: todos vêm do ambiente, com estes padrões. Um valor
 * absurdo — `0`, texto — cai no padrão em vez de virar "apague tudo".
 *
 * ============================================================================
 * O QUE ELA NUNCA APAGA SOZINHA
 * ============================================================================
 *
 * Os backups anteriores à rotação da chave carregam os segredos selados pela
 * chave publicada. São passivo — e são o ÚNICO caminho de volta se algo na
 * rotação tiver escapado. Apagá-los antes de existir backup novo validado troca
 * um problema de exposição por um de perda.
 *
 * Por isso o legado só entra no plano quando quem chamou disser explicitamente
 * que pode; e mesmo então, o mais recente de CADA selo é preservado.
 *
 * Este módulo não apaga nada. Ele devolve uma lista.
 */
import { classificarBackup, type SeloDoBackup } from './backupClassification.js';

export interface PoliticaDeRetencao {
  /** Guarda TODOS os dos últimos N dias. */
  diarios: number;
  /** Depois disso, um por semana, por N semanas. */
  semanais: number;
  /** Depois disso, um por mês, por N meses. */
  mensais: number;
  /** Nunca deixar menos que isto, por mais velhos que sejam. */
  minimo: number;
}

const PADRAO: PoliticaDeRetencao = { diarios: 14, semanais: 8, mensais: 12, minimo: 7 };

function numeroDoAmbiente(nome: string, padrao: number): number {
  const bruto = process.env[nome];
  if (!bruto) return padrao;
  const n = Number.parseInt(bruto, 10);
  /*
    Um `0` digitado por engano numa variável de ambiente não pode virar "apague
    tudo". Valor inválido ou não-positivo cai no padrão, que é conservador.
  */
  if (!Number.isFinite(n) || n <= 0) return padrao;
  return n;
}

export function politicaDeRetencao(): PoliticaDeRetencao {
  return {
    diarios: numeroDoAmbiente('DEVORA_BACKUP_RETENCAO_DIARIOS', PADRAO.diarios),
    semanais: numeroDoAmbiente('DEVORA_BACKUP_RETENCAO_SEMANAIS', PADRAO.semanais),
    mensais: numeroDoAmbiente('DEVORA_BACKUP_RETENCAO_MENSAIS', PADRAO.mensais),
    minimo: numeroDoAmbiente('DEVORA_BACKUP_RETENCAO_MINIMO', PADRAO.minimo),
  };
}

export interface ObjetoDeBackup {
  nome: string;
  criadoEm: string;
  bytes: number;
}

export interface ObjetoPlanejado extends ObjetoDeBackup {
  selo: SeloDoBackup;
  /** Em que balde ele caiu: `dia-2026-08-27`, `semana-2026-W34`, `mes-2026-08`. */
  balde: string;
  /** Por que fica, ou por que sai. Sempre preenchido. */
  motivo: string;
}

export interface PlanoDeExpurgo {
  politica: PoliticaDeRetencao;
  manter: ObjetoPlanejado[];
  apagar: ObjetoPlanejado[];
  /** Quantos legados ficaram de fora do expurgo por falta de autorização. */
  legadosPreservados: number;
  bytesQueSairiam: number;
}

const DIA = 24 * 60 * 60 * 1000;

/** O balde a que uma data pertence, dada a idade. */
function baldeDe(quando: Date, idadeMs: number, p: PoliticaDeRetencao): string {
  if (idadeMs <= p.diarios * DIA) {
    return `dia-${quando.toISOString().slice(0, 10)}`;
  }
  if (idadeMs <= (p.diarios + p.semanais * 7) * DIA) {
    // Semana ISO aproximada pelo número do dia do ano — o que importa é agrupar
    // sete dias consecutivos no mesmo balde, não a numeração oficial.
    const inicioDoAno = Date.UTC(quando.getUTCFullYear(), 0, 1);
    const semana = Math.floor((quando.getTime() - inicioDoAno) / (7 * DIA));
    return `semana-${quando.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
  }
  return `mes-${quando.toISOString().slice(0, 7)}`;
}

/**
 * Monta o plano. NÃO apaga nada.
 *
 * A regra, por balde: fica o MAIS RECENTE de cada um; os outros são candidatos.
 * Nos baldes de dia isso preserva todos, porque cada dia tem o seu.
 */
export function planejarExpurgo(
  objetos: ObjetoDeBackup[],
  opts: {
    agora: Date;
    rotacionadoEm: string | null;
    permitirExpurgoDeLegados?: boolean;
    politica?: PoliticaDeRetencao;
  },
): PlanoDeExpurgo {
  const p = opts.politica ?? politicaDeRetencao();
  const agora = opts.agora.getTime();

  const ordenados = [...objetos].sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));

  const comBalde: ObjetoPlanejado[] = ordenados.map((o) => {
    const quando = new Date(o.criadoEm);
    const idade = agora - quando.getTime();
    return {
      ...o,
      selo: classificarBackup(o.criadoEm, opts.rotacionadoEm),
      balde: baldeDe(quando, idade, p),
      motivo: '',
    };
  });

  const manter: ObjetoPlanejado[] = [];
  const apagar: ObjetoPlanejado[] = [];
  const baldesVistos = new Set<string>();
  /** O mais recente de cada selo nunca sai — é o caminho de volta daquele selo. */
  const selosVistos = new Set<SeloDoBackup>();

  for (const o of comBalde) {
    const idade = agora - new Date(o.criadoEm).getTime();
    const foraDoHorizonte = idade > (p.diarios + p.semanais * 7 + p.mensais * 30) * DIA;

    if (!selosVistos.has(o.selo)) {
      selosVistos.add(o.selo);
      baldesVistos.add(o.balde);
      manter.push({ ...o, motivo: `o mais recente com selo ${o.selo}` });
      continue;
    }

    if (!baldesVistos.has(o.balde) && !foraDoHorizonte) {
      baldesVistos.add(o.balde);
      manter.push({ ...o, motivo: `o mais recente do balde ${o.balde}` });
      continue;
    }

    const motivo = foraDoHorizonte
      ? `mais velho que o horizonte da política (${p.diarios}d + ${p.semanais}sem + ${p.mensais}m)`
      : `já existe um mais recente no balde ${o.balde}`;
    apagar.push({ ...o, motivo });
  }

  /*
    O MÍNIMO, aplicado por último.

    Ele vale para o conjunto todo, e devolve os mais RECENTES da lista de
    apagar — que são os mais úteis num desastre.
  */
  while (manter.length < p.minimo && apagar.length > 0) {
    const devolvido = apagar.shift() as ObjetoPlanejado;
    manter.push({ ...devolvido, motivo: `devolvido: a retenção mínima é ${p.minimo}` });
  }

  /*
    E o legado só sai com autorização. Sem ela, volta para `manter` com o
    motivo dito — não some do relatório.
  */
  let legadosPreservados = 0;
  if (!opts.permitirExpurgoDeLegados) {
    for (let i = apagar.length - 1; i >= 0; i -= 1) {
      if (apagar[i].selo !== 'LEGACY_ENCRYPTION_KEY') continue;
      const [preservado] = apagar.splice(i, 1);
      manter.push({
        ...preservado,
        motivo:
          'selado pela chave anterior à rotação: só sai com autorização explícita, '
          + 'e depois de existir backup novo validado',
      });
      legadosPreservados += 1;
    }
  }

  manter.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  apagar.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));

  return {
    politica: p,
    manter,
    apagar,
    legadosPreservados,
    bytesQueSairiam: apagar.reduce((s, o) => s + (o.bytes || 0), 0),
  };
}
