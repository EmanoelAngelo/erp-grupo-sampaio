/**
 * O EXTRATO EM ARQUIVO — OFX de verdade, e o CSV que já existia (GAP-V27).
 *
 * ============================================================================
 * POR QUE ISTO NASCEU
 * ============================================================================
 *
 * Conciliar exigia abrir o internet banking, exportar CSV, ajustar as colunas
 * para `data;descrição;valor` e COLAR num textarea. Três passos manuais antes
 * do primeiro clique útil — e o banco operacional mostra o resultado disso:
 * zero extratos importados em produção.
 *
 * O OFX é o formato que todo internet banking brasileiro exporta e que quase
 * nenhum deles deixa de exportar: é o arquivo do "Money/Quicken" que está no
 * mesmo menu do CSV. Ele traz DUAS coisas que o CSV colado nunca traz:
 *
 *   FITID   a identidade que o BANCO deu ao lançamento. É ela que faz
 *           reimportar o mesmo arquivo ser seguro — o dedupe do servidor por
 *           `external_id` já estava pronto e não tinha quem o alimentasse.
 *   SINAL   o valor já vem com sinal, sem depender de o usuário ter escolhido
 *           a coluna certa na exportação.
 *
 * ============================================================================
 * POR QUE O PARSE MORA NO NAVEGADOR
 * ============================================================================
 *
 * Pela mesma razão já escrita em `extratoCsv`: o formato varia por banco e é o
 * usuário quem sabe qual arquivo baixou. O servidor recebe LINHAS
 * ESTRUTURADAS e não tenta adivinhar layout — a rota `POST /bank/statements`
 * continua exatamente como estava, e o dedupe do outro lado também.
 *
 * ============================================================================
 * O QUE ESTE LEITOR NÃO FAZ, E ISSO É DECISÃO
 * ============================================================================
 *
 * Não valida a estrutura completa do OFX (cabeçalho, versão, conta, moeda) e
 * não lê `CREDITCARDMSGSRSV1` (fatura de cartão) nem `INVSTMTMSGSRSV1`
 * (investimento). O que ele lê são os blocos `<STMTTRN>` — a lista de
 * lançamentos —, que é a única coisa que a conciliação consome. Um validador
 * de OFX completo recusaria arquivos que funcionam perfeitamente para o que a
 * tela precisa; um leitor que só pega o que usa aceita o arquivo do banco que
 * escreve OFX torto, que é a maioria.
 *
 * Também NÃO inventa hora: `DTPOSTED` vem como `AAAAMMDDHHMMSS[-3:BRT]` e daqui
 * sai só o dia de calendário. Converter para instante faria o lançamento de
 * 31/08 aparecer em 30/08 para quem lê de outro fuso — a mesma armadilha que
 * já mordeu duas vezes nesta casa.
 */
import { centavosComSinal, parseExtratoCsv, type LeituraDoExtrato } from './extratoCsv';

/** Formato reconhecido no arquivo que a pessoa escolheu. */
export type FormatoDoExtrato = 'ofx' | 'csv';

export interface LeituraDeArquivo extends LeituraDoExtrato {
  formato: FormatoDoExtrato;
}

/**
 * Um campo SGML do OFX: `<TAG>valor` até o próximo `<` ou fim de linha.
 *
 * O OFX 1.x (SGML) não fecha as tags de folha — `<TRNAMT>150.00` sem
 * `</TRNAMT>`. O OFX 2.x (XML) fecha. Ler "até o próximo `<`" atende os dois:
 * no XML o `</TRNAMT>` é justamente o próximo `<`.
 */
function campo(bloco: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(bloco);
  const valor = m?.[1]?.trim();
  return valor ? valor : null;
}

/**
 * O DIA do lançamento, a partir de `DTPOSTED`.
 *
 * `20260831` e `20260831120000[-3:BRT]` dão o MESMO dia — os oito primeiros
 * dígitos são a data, e o resto é hora e fuso que esta coluna não guarda.
 */
function diaDoOfx(texto: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(texto.trim());
  if (!m) return null;
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Parece OFX? Basta a marca do formato — não é validação, é roteamento. */
export function pareceOfx(texto: string): boolean {
  return /<STMTTRN>/i.test(texto) || /OFXHEADER|<OFX>/i.test(texto);
}

/**
 * Lê os lançamentos de um arquivo OFX.
 *
 * Cada `<STMTTRN>` sem data ou sem valor legível conta como erro e NÃO entra:
 * a tela mostra quantos ficaram de fora, porque importar 40 de 42 linhas em
 * silêncio é a forma mais cara de conciliar — a diferença aparece no fim do
 * mês como divergência sem causa.
 */
export function parseExtratoOfx(texto: string): LeituraDoExtrato {
  const linhas: LeituraDoExtrato['linhas'] = [];
  let erros = 0;

  const blocos = texto.match(/<STMTTRN>[\s\S]*?(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi) ?? [];

  for (const bloco of blocos) {
    const data = campo(bloco, 'DTPOSTED');
    const valor = campo(bloco, 'TRNAMT');
    const dia = data ? diaDoOfx(data) : null;
    const centavos = valor ? centavosComSinal(valor) : null;

    if (dia === null || centavos === null) {
      erros += 1;
      continue;
    }

    /*
      A DESCRIÇÃO PREFERE `MEMO`.

      `NAME` costuma trazer o nome curto do favorecido e `MEMO` a frase inteira
      ("PIX RECEBIDO 12/08 FULANO"). Quando só existe um dos dois, usa-se o que
      existe; quando não existe nenhum, o tipo (`TRNTYPE`) ainda diz mais do que
      "Sem descrição".
    */
    const descricao =
      campo(bloco, 'MEMO')
      ?? campo(bloco, 'NAME')
      ?? campo(bloco, 'TRNTYPE')
      ?? 'Sem descrição';

    linhas.push({
      occurredAt: dia,
      description: descricao,
      amountCents: centavos,
      // A identidade do banco. Sem ela o dedupe do servidor não tem por onde
      // pegar, e reimportar o arquivo do mês duplicaria o mês inteiro.
      externalId: campo(bloco, 'FITID'),
    });
  }

  return { linhas, erros };
}

/**
 * O leitor do arquivo escolhido: descobre o formato e delega.
 *
 * A escolha é pelo CONTEÚDO, não pela extensão. Banco que entrega OFX com nome
 * `.txt` existe, e arquivo renomeado à mão também — decidir pela extensão faria
 * o leitor certo ser recusado por causa de três letras.
 */
/**
 * O TEXTO DO ARQUIVO ESCOLHIDO.
 *
 * `Blob.text()` seria uma linha, e é justamente o que não se pode usar aqui:
 * ele não existe em todo lugar (o jsdom da suíte não o implementa), e um
 * caminho que só funciona no navegador é um caminho que nenhum teste percorre
 * — que é como um botão de importar chega quebrado em produção. `FileReader`
 * está em qualquer navegador que o balcão vá usar e também no teste.
 */
export function lerTextoDoArquivo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(leitor.error ?? new Error('Falha ao ler o arquivo.'));
    leitor.onload = () => resolve(String(leitor.result ?? ''));
    leitor.readAsText(file);
  });
}

export function lerArquivoDeExtrato(texto: string): LeituraDeArquivo {
  if (pareceOfx(texto)) {
    return { ...parseExtratoOfx(texto), formato: 'ofx' };
  }
  return { ...parseExtratoCsv(texto), formato: 'csv' };
}
