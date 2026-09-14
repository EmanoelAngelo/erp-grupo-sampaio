/**
 * ============================================================================
 * ROTAÇÃO DA CHAVE DO COFRE — tudo ou nada
 * ============================================================================
 *
 * Os segredos deste sistema são selados com uma chave derivada de
 * `DEVORA_ENCRYPTION_KEY`. Trocar essa chave sem reescrever o que ela selou
 * torna os segredos ILEGÍVEIS — e não há segunda cópia: o `.pfx` do
 * certificado, as chaves do Asaas e a senha da caixa de e-mail existem
 * exatamente uma vez, cifrados, dentro do banco.
 *
 * Isto não é hipótese. Os cinco segredos da Preço Justo estavam selados com a
 * chave PADRÃO de desenvolvimento, e produção recusa subir com ela: publicar
 * exigia trocar a chave, e trocar a chave sem esta ferramenta significaria
 * perder os cinco.
 *
 * ## A ordem, e por que ela é essa
 *
 *   1. ABRIR TODOS com a chave antiga, em memória, ANTES de escrever qualquer
 *      coisa. Um segredo que não abre aborta a rotação inteira enquanto o
 *      banco ainda está intacto — descobrir isso no meio da escrita seria
 *      descobrir tarde;
 *   2. CÓPIA do banco. Só depois de saber que a rotação é possível: copiar
 *      antes de saber gastaria disco por nada, e o passo 1 é barato;
 *   3. RESSELAR os cinco numa transação só;
 *   4. CONFERIR relendo com a chave NOVA, ainda dentro da transação. Qualquer
 *      falha lança, e o rollback devolve os cinco ao que eram.
 *
 * ## O que ela nunca faz
 *
 * Não imprime segredo, não o devolve, não o escreve em log nem em relatório. O
 * texto claro existe entre o passo 1 e o passo 3, em memória, e some. O
 * relatório carrega id, tipo e situação — nada mais.
 *
 * Não altera o conteúdo: o que sai é o mesmo que entrou, com selo diferente.
 *
 * ## Idempotência
 *
 * Rodar de novo com as duas chaves depois de uma rotação bem-sucedida encontra
 * tudo já aberto pela NOVA e nada pela antiga: devolve `nada-a-fazer` sem
 * tocar no banco. Rodar com as chaves trocadas por engano encontra segredos que
 * a "antiga" não abre e aborta no passo 1.
 */
import { snapshotDatabase } from './backup.js';
import { marcarCofreRotacionado } from './secretsReadiness.js';
import { ehValorPublicado } from '../config/env.js';
import { withTransaction } from './sqlite.js';
import {
  cifradoDe,
  inventariarSegredos,
  lugarDe,
  resselarNoLugar,
  type SegredoNoCofre,
} from './secretsInventory.js';
import { decryptWithKey, encryptWithKey } from '../services/fiscal/FiscalSecretVault.js';

/** O que aconteceu com UM segredo. Nunca o valor dele. */
export interface LinhaDoRelatorio {
  tipo: string;
  store: string;
  rowId: string;
  companyId: string | null;
  ambiente: string | null;
  situacao:
    | 'resselado'
    | 'ja-na-chave-nova'
    | 'nao-abre-com-a-antiga'
    | 'nao-sobrevive-a-nova'
    | 'sem-conteudo';
}

export interface ResultadoDaRotacao {
  /** `true` quando nada foi escrito — ensaio, ou nada a fazer. */
  ensaio: boolean;
  /** Caminho da cópia tirada antes de escrever, quando houve escrita. */
  copia: string | null;
  encontrados: number;
  /**
   * Quantos a chave ANTIGA conseguiu abrir. Metade da pergunta.
   */
  abremComAAntiga: number;
  /**
   * Quantos foram cifrados com a NOVA e reabertos com ela, EM MEMÓRIA,
   * conferindo que o texto voltou idêntico. A outra metade.
   *
   * Esta conta existe para ser lida no ENSAIO. Sem ela o operador para o
   * servidor, tira a cópia e abre a janela de manutenção para só então
   * descobrir, na conferência pós-escrita, o que dava para saber antes.
   */
  resselaveisComANova: number;
  resselados: number;
  jaNaChaveNova: number;
  /** Impediram a rotação: abriram com nenhuma das duas chaves. */
  impedimentos: LinhaDoRelatorio[];
  linhas: LinhaDoRelatorio[];
  /** `true` quando a conferência pós-rotação passou em todos. */
  conferido: boolean;
}

function descrever(s: SegredoNoCofre, situacao: LinhaDoRelatorio['situacao']): LinhaDoRelatorio {
  return {
    tipo: s.detalhe && s.detalhe !== s.tipo ? `${s.tipo}/${s.detalhe}` : s.tipo,
    store: s.store,
    rowId: s.rowId,
    companyId: s.companyId,
    ambiente: s.ambiente,
    situacao,
  };
}

/**
 * Roda a rotação.
 *
 * As duas chaves chegam por parâmetro porque quem as lê é o script
 * administrativo, do AMBIENTE — nunca de argumento de linha de comando, que
 * fica no histórico do shell e na lista de processos.
 */
export function rotacionarChaveDoCofre(input: {
  chaveAntiga: string;
  chaveNova: string;
  /** Só relata; não escreve nada. */
  ensaio: boolean;
}): ResultadoDaRotacao {
  if (!input.chaveAntiga || !input.chaveNova) {
    throw new Error('A rotação precisa das duas chaves.');
  }
  if (input.chaveAntiga === input.chaveNova) {
    throw new Error('A chave nova é igual à antiga: não há rotação a fazer.');
  }

  const segredos = inventariarSegredos(input.chaveAntiga);
  const linhas: LinhaDoRelatorio[] = [];
  const impedimentos: LinhaDoRelatorio[] = [];

  /*
    PASSO 1 — abrir todos, antes de escrever nada.

    O texto claro fica aqui, indexado pela linha, e é usado no passo 3. Não
    sai desta função.
  */
  const claros = new Map<string, string>();
  let abremComAAntiga = 0;
  let resselaveisComANova = 0;

  for (const s of segredos) {
    const cifrado = cifradoDe(s);
    if (!cifrado) {
      linhas.push(descrever(s, 'sem-conteudo'));
      continue;
    }

    if (s.decryptableWithCurrentKey) {
      // Abre com a ANTIGA: é o caso normal, e é o que será resselado.
      let claro: string;
      try {
        claro = decryptWithKey(cifrado, input.chaveAntiga);
      } catch {
        impedimentos.push(descrever(s, 'nao-abre-com-a-antiga'));
        continue;
      }
      abremComAAntiga += 1;

      /*
        A VOLTA, em memória: cifra com a nova, reabre o que cifrou, compara
        com o texto que saiu da antiga.

        Comparar é o ponto. Só cifrar provaria que a função devolve uma
        string; só cifrar e decifrar provaria que ela devolve alguma coisa.
        O que interessa é que o valor volte IGUAL — é isso que a rotação
        promete, e é o que o operador precisa saber antes de parar o
        servidor.

        Nada aqui toca o banco. O texto claro nasce no passo 1, é usado no
        passo 3 e some com a função.
      */
      try {
        if (decryptWithKey(encryptWithKey(claro, input.chaveNova), input.chaveNova) !== claro) {
          throw new Error('o texto reaberto com a chave nova não é o mesmo que saiu da antiga');
        }
      } catch {
        impedimentos.push(descrever(s, 'nao-sobrevive-a-nova'));
        continue;
      }
      resselaveisComANova += 1;

      claros.set(`${s.store}:${s.rowId}:${s.tipo}`, claro);
      linhas.push(descrever(s, 'resselado'));
      continue;
    }

    /*
      Não abre com a antiga. Ou já está na nova — rotação repetida, e aí não há
      o que fazer —, ou está selado com uma terceira chave, e aí NADA pode ser
      escrito: reescrever os outros deixaria o banco com dois selos.
    */
    let abreComANova: boolean;
    try {
      decryptWithKey(cifrado, input.chaveNova);
      abreComANova = true;
    } catch {
      abreComANova = false;
    }

    if (abreComANova) linhas.push(descrever(s, 'ja-na-chave-nova'));
    else impedimentos.push(descrever(s, 'nao-abre-com-a-antiga'));
  }

  const paraResselar = linhas.filter((l) => l.situacao === 'resselado');
  const jaNaChaveNova = linhas.filter((l) => l.situacao === 'ja-na-chave-nova').length;

  const base: ResultadoDaRotacao = {
    ensaio: true,
    copia: null,
    encontrados: segredos.length,
    abremComAAntiga,
    resselaveisComANova,
    resselados: 0,
    jaNaChaveNova,
    impedimentos,
    linhas,
    conferido: false,
  };

  // Um impedimento aborta ANTES de qualquer escrita.
  if (impedimentos.length > 0) return base;
  if (input.ensaio) return { ...base, resselados: paraResselar.length };
  if (paraResselar.length === 0) return base;

  /*
    PASSO 2 — a cópia. Só agora, porque só agora se sabe que a rotação é
    possível. `snapshotDatabase` se declara pulada em banco descartável, e é
    isso que faz a suíte não gastar disco.
  */
  const copia = snapshotDatabase('pre-rotacao-de-chave');

  /*
    PASSO 3 e 4 — resselar e conferir, na MESMA transação.

    A conferência dentro dela é o que dá o tudo-ou-nada: um segredo que não
    reabra com a chave nova lança, e o rollback devolve os cinco.
  */
  withTransaction(() => {
    for (const l of paraResselar) {
      const chaveDoMapa = `${l.store}:${l.rowId}:${l.tipo.split('/')[0]}`;
      const claro = claros.get(chaveDoMapa);
      if (claro === undefined) {
        throw new Error(`Texto de ${l.tipo} sumiu entre a leitura e a escrita.`);
      }
      const lugar = lugarDe({
        tipo: l.tipo.split('/')[0],
        store: l.store,
      } as SegredoNoCofre);
      if (!lugar) throw new Error(`Lugar de ${l.tipo} não encontrado.`);
      resselarNoLugar(lugar, l.rowId, claro, input.chaveNova);
    }

    // Conferência: todos têm de abrir com a NOVA, e é o banco que responde.
    const depois = inventariarSegredos(input.chaveNova);
    const naoAbrem = depois.filter((s) => !s.decryptableWithCurrentKey);
    if (naoAbrem.length > 0) {
      throw new Error(
        `${naoAbrem.length} segredo(s) não abriram com a chave nova depois de resselados. `
          + 'Nada foi alterado.',
      );
    }
  });

  /*
    A DÍVIDA QUE O RESSELO NÃO PAGA.

    Se a chave antiga era um valor PUBLICADO — a padrão de desenvolvimento,
    um `change-me` de arquivo de exemplo —, então tudo o que ela selou viveu
    legível para quem tivesse uma cópia do banco e o repositório. E cópias
    saem: backup remoto, backup local, o `.db` que alguém copiou para
    olhar.

    Resselar fecha a porta a partir de agora. Não desfaz o que já foi
    exposto. Para o `.pfx` isso é tolerável — ele é inútil sem a senha, que
    nunca esteve no banco. Para uma chave de API não é: ela É a credencial, e
    só o portal que a emitiu pode invalidá-la.

    A marca fica gravada para que o diagnóstico do dono saiba cobrar essa
    troca. Ela se apaga sozinha, por credencial, quando ele colar a nova.

    Rotação entre duas chaves próprias não grava nada: não há dívida.
  */
  if (ehValorPublicado(input.chaveAntiga)) {
    marcarCofreRotacionado(new Date().toISOString());
  }

  return {
    ...base,
    ensaio: false,
    copia: copia.skipped ? null : copia.path,
    resselados: paraResselar.length,
    conferido: true,
  };
}
