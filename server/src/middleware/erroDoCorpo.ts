/**
 * ============================================================================
 * O ERRO DO PARSER DO CORPO É ERRO DE QUEM MANDOU (GAP-PRD-157)
 * ============================================================================
 *
 * `express.json` roda ANTES de qualquer rota. Quando o corpo não é JSON, passa
 * do teto ou vem num charset que ele não lê, ele não devolve nada: lança um
 * erro do pacote `http-errors` com `type` e `status` — e esse erro ia parar no
 * ramo genérico do tratador do app, que só conhecia `ApiError`:
 *
 *   - resposta 500 "Erro interno.", e a tela dizendo que o SERVIDOR falhou;
 *   - `unhandled_error` com pilha no log, a cada requisição quebrada — o mesmo
 *     registro de um defeito de verdade, afogando os defeitos de verdade;
 *   - nenhuma linha em `api_request_logs`, onde toda outra recusa aparece.
 *
 * Esta função traduz ESSES erros — e só esses — para `ApiError`, e o tratador
 * do app segue o caminho de sempre (envelope, `requestId`, registro).
 *
 * ## Por que pelo `type`, e não por `instanceof SyntaxError`
 *
 * `SyntaxError` também é o que um `JSON.parse` no meio de um serviço lança
 * quando lê do banco um documento corrompido. ISSO é defeito nosso e tem de
 * continuar sendo 500 com pilha. O `type` só existe no erro que o body-parser
 * monta — é a assinatura de "veio da requisição".
 *
 * ## O que não vai para o cliente
 *
 * A frase do parser ("Expected double-quoted property name in JSON at position
 * 13") é detalhe de implementação do Node. A resposta diz o que quem mandou
 * pode corrigir; a posição não ajuda a tela e não é da conta de ninguém.
 */
import { ApiError } from '../utils/errors.js';

type ErroDoBodyParser = {
  type: string;
  status?: number;
  statusCode?: number;
  expose?: boolean;
  /** Presente em `entity.too.large`: o teto, em bytes. */
  limit?: number;
};

function ehErroDoBodyParser(err: unknown): err is ErroDoBodyParser {
  return (
    typeof err === 'object'
    && err !== null
    && typeof (err as { type?: unknown }).type === 'string'
    && typeof ((err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode) === 'number'
  );
}

/** "1 MB", "8 MB", "512 KB" — o teto no formato em que alguém o ajusta. */
function tetoLegivel(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace('.', ',')} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * O erro do parser como `ApiError`, ou `null` quando não é erro do parser do
 * corpo — e aí o tratador segue para o ramo de 500, que é onde defeito mora.
 */
export function erroDoCorpoDaRequisicao(err: unknown): ApiError | null {
  if (!ehErroDoBodyParser(err)) return null;
  const status = err.status ?? err.statusCode ?? 500;
  // 5xx do parser (ex.: `stream.encoding.set`) é defeito de montagem do
  // servidor, não de quem mandou: não se traduz.
  if (status < 400 || status >= 500) return null;

  switch (err.type) {
    case 'entity.parse.failed':
    case 'request.size.invalid':
      return new ApiError(
        'API_INVALID_PAYLOAD',
        'O corpo da requisição não é um JSON válido. Confira o que foi enviado — '
          + 'se a tela estiver desatualizada, recarregue a página.',
        400,
      );
    case 'entity.too.large': {
      const teto = tetoLegivel(err.limit);
      return new ApiError(
        'API_PAYLOAD_TOO_LARGE',
        teto
          ? `O corpo da requisição passa do limite de ${teto} desta rota.`
          : 'O corpo da requisição passa do limite desta rota.',
        413,
        teto ? { limite: teto } : undefined,
      );
    }
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new ApiError(
        'API_UNSUPPORTED_MEDIA_TYPE',
        'O corpo precisa ir como JSON em UTF-8, sem compressão desconhecida.',
        415,
      );
    case 'request.aborted':
      return new ApiError(
        'API_REQUEST_ABORTED',
        'A requisição foi interrompida antes de o corpo chegar inteiro.',
        400,
      );
    default:
      // Outro 4xx do parser que o pacote venha a criar: continua sendo erro de
      // quem mandou, com o status que o próprio parser escolheu.
      return new ApiError('API_INVALID_REQUEST', 'O corpo da requisição foi recusado.', status);
  }
}
