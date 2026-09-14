/**
 * O EXTRATO DO BANCO, LINHA A LINHA.
 *
 * ============================================================================
 * POR QUE ISTO SAIU DE DENTRO DA TELA
 * ============================================================================
 *
 * A tela de conciliação tinha o próprio leitor de valor:
 *
 *     valorTexto.replace(/\./g, '').replace(',', '.')
 *
 * com um comentário logo acima prometendo aceitar `1.234,56` **e** `1234.56`,
 * "os dois formatos que aparecem em extrato brasileiro".
 *
 * A promessa era falsa na segunda metade. Apagar TODO ponto transforma
 * `1234.56` em `123456`, e a vírgula que viria depois não existe: a linha entra
 * como **R$ 123.456,00**. Extrato exportado em formato americano — o que sai de
 * quase todo internet banking com opção em inglês, e de toda planilha
 * configurada em `en-US` — importava a conta inteira multiplicada por cem, sem
 * um único erro na tela.
 *
 * O leitor certo já existia em `format.ts` (`parseReaisToCents`), com a regra
 * do grupo de três resolvendo a ambiguidade do ponto, e com teste próprio. A
 * tela tinha uma segunda cópia porque precisava de VALOR COM SINAL — débito é
 * negativo no extrato — e a cópia nasceu perdendo o resto.
 *
 * Aqui o sinal é separado antes e reaplicado depois. Um leitor de dinheiro só.
 */
import { parseReaisToCents } from './format';

export interface LinhaDoExtrato {
  /** Instante ISO, para a coluna `occurred_at`. */
  occurredAt: string;
  description: string;
  /** Negativo em débito, positivo em crédito. */
  amountCents: number;
  /**
   * A identidade que o BANCO deu ao lançamento (o FITID do OFX).
   *
   * É o que sustenta reimportar o mesmo arquivo sem duplicar: o servidor
   * ignora linha com `externalId` já conhecido. CSV colado não tem essa
   * identidade — e por isso a reimportação de CSV assume o risco de repetir.
   */
  externalId?: string | null;
}

export interface LeituraDoExtrato {
  linhas: LinhaDoExtrato[];
  /** Quantas linhas o arquivo tinha e não foi possível entender. */
  erros: number;
}

/**
 * Dinheiro COM SINAL, para extrato.
 *
 * `parseReaisToCents` recusa negativo de propósito — no formulário de venda,
 * valor negativo pagaria o cliente para comprar. No extrato o negativo é o
 * débito, e é metade do arquivo.
 */
export function centavosComSinal(texto: string): number | null {
  const bruto = texto.trim();
  // Parênteses são a notação contábil de negativo, e alguns bancos a usam.
  const entreParenteses = /^\((.*)\)$/.exec(bruto);
  const semParenteses = entreParenteses ? `-${entreParenteses[1]}` : bruto;

  const negativo = semParenteses.startsWith('-');
  const magnitude = parseReaisToCents(semParenteses.replace(/^[+-]/, ''));
  if (magnitude === null) return null;
  return negativo ? -magnitude : magnitude;
}

/**
 * A data do extrato, que vem em DD/MM/AAAA ou em AAAA-MM-DD.
 *
 * Devolve o dia de calendário, sem inventar hora: o extrato não tem hora, e a
 * coluna `occurred_at` guarda dia. Converter para instante aqui faria a linha
 * de 31/08 aparecer em 30/08 para quem lê de outro fuso.
 */
function diaDoExtrato(texto: string): string | null {
  const bruto = texto.trim();
  const comBarra = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(bruto);
  if (comBarra) return `${comBarra[3]}-${comBarra[2]}-${comBarra[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(bruto)) return bruto;
  return null;
}

/** Lê o texto colado na tela: `data;descrição;valor`, um por linha. */
export function parseExtratoCsv(texto: string): LeituraDoExtrato {
  const linhas: LinhaDoExtrato[] = [];
  let erros = 0;

  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha) continue;

    /*
      PONTO E VÍRGULA PRIMEIRO, VÍRGULA SÓ SE SOBRAR.

      Separar por vírgula em toda linha quebra o número brasileiro:
      `01/08/2026;Pagamento;1.234,56` viraria quatro campos e o valor lido
      seria "1.234". O arquivo americano — `2026-08-01,Payment,1234.56` — não
      tem vírgula no número, então a segunda tentativa só é aceita quando dá
      exatamente três campos.
    */
    let partes = linha.split(/[;\t]/).map((p) => p.trim());
    if (partes.length < 3) {
      const porVirgula = linha.split(',').map((p) => p.trim());
      if (porVirgula.length === 3) partes = porVirgula;
    }
    if (partes.length < 3) {
      erros += 1;
      continue;
    }

    const [data, descricao, valorTexto] = partes;
    const dia = diaDoExtrato(data);
    const valor = centavosComSinal(valorTexto);

    // Valor zero não é movimento: é ruído do arquivo, e o servidor já o
    // descarta. Contá-lo como erro assustaria quem importa sem motivo.
    if (dia === null || valor === null) {
      erros += 1;
      continue;
    }

    linhas.push({
      occurredAt: dia,
      description: descricao || 'Sem descrição',
      amountCents: valor,
    });
  }

  return { linhas, erros };
}
