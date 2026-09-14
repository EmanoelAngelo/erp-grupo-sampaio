/**
 * ============================================================================
 * O BUCKET, POR CAMINHO — listar, ler e gravar um objeto qualquer
 * ============================================================================
 *
 * `db/backupRemoto.ts` conversa com a RAIZ do bucket (onde mora o `.db`), e
 * `db/backupUploads.ts` com o pacote antigo de fotos. O envio incremental das
 * fotos (GAP-PRD-058) e a volta a partir do bucket (GAP-PRD-012) precisam de
 * qualquer caminho — `uploads/objetos/<sha256>`, `uploads/manifesto-*.json` —
 * e de listar além da primeira página. É o que este módulo faz, com a mesma
 * configuração (`remoteBackupConfig`) e as mesmas regras:
 *
 *   - a chave só existe no cabeçalho da requisição; nenhum retorno, motivo ou
 *     exceção a carrega;
 *   - sem configuração, recusa com motivo e NÃO toca a rede;
 *   - HTTP de recusa vira motivo legível, com o status;
 *   - nunca pede `x-upsert`: objeto que já existe no bucket não é
 *     sobrescrito — o chamador decide o que a colisão significa.
 */
import {
  remoteBackupConfig,
  remoteBackupConfigured,
  type RemoteBackupConfig,
} from '../../db/backupRemoto.js';

export interface OpcoesDoBucket {
  fetchImpl?: typeof fetch;
  config?: RemoteBackupConfig;
}

export interface ObjetoNoBucket {
  /** Nome relativo ao prefixo listado. */
  nome: string;
  bytes: number;
  criadoEm: string | null;
  /** O Supabase devolve as "pastas" de um prefixo como itens sem id. */
  pasta: boolean;
}

export type Falha = { ok: false; motivo: string; status?: number };

const NAO_CONFIGURADA =
  'Cópia remota não configurada — defina DEVORA_SUPABASE_URL, DEVORA_SUPABASE_SERVICE_KEY e (opcional) '
  + 'DEVORA_SUPABASE_BUCKET no ambiente.';

function preparar(opts: OpcoesDoBucket): { config: RemoteBackupConfig; fetchImpl: typeof fetch } | null {
  const config = opts.config ?? remoteBackupConfig();
  if (!remoteBackupConfigured(config)) return null;
  return { config, fetchImpl: opts.fetchImpl ?? fetch };
}

function cabecalhos(config: RemoteBackupConfig, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${config.serviceKey}`,
    // As chaves novas (sb_secret_...) autenticam pelo apikey; as antigas pelo Bearer.
    apikey: config.serviceKey,
    ...extra,
  };
}

/** `uploads/objetos/abc` → cada segmento codificado, as barras preservadas. */
function codificar(caminho: string): string {
  return caminho
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function urlDoObjeto(config: RemoteBackupConfig, caminho: string): string {
  return `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${codificar(caminho)}`;
}

function motivoDe(err: unknown, padrao: string): string {
  return err instanceof Error ? err.message : padrao;
}

/** O nome do bucket configurado (não é segredo; a URL e a chave não saem daqui). */
export function nomeDoBucket(opts: OpcoesDoBucket = {}): string {
  return (opts.config ?? remoteBackupConfig()).bucket;
}

/**
 * Tudo o que existe sob um prefixo, página a página.
 *
 * A listagem do Supabase devolve no máximo `limit` itens por chamada. Uma
 * listagem de uma página só mostraria os cem mais novos e esconderia o resto
 * — exatamente o que não se quer quando a pergunta é "o objeto está lá?".
 */
export async function listarObjetos(
  prefixo: string,
  opts: OpcoesDoBucket & { porPagina?: number; maximo?: number } = {},
): Promise<{ ok: true; itens: ObjetoNoBucket[] } | Falha> {
  const p = preparar(opts);
  if (!p) return { ok: false, motivo: NAO_CONFIGURADA };
  const porPagina = opts.porPagina ?? 1000;
  const maximo = opts.maximo ?? 50_000;
  const itens: ObjetoNoBucket[] = [];
  try {
    /*
      Anda pelo tamanho da página QUE VEIO, e só para na página vazia: se o
      provedor devolver menos do que o pedido por ter um teto próprio, parar
      em "veio menos que o limite" esconderia o resto em silêncio.
    */
    for (let offset = 0; offset < maximo; ) {
      const resposta = await p.fetchImpl(
        `${p.config.url}/storage/v1/object/list/${encodeURIComponent(p.config.bucket)}`,
        {
          method: 'POST',
          headers: cabecalhos(p.config, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            prefix: prefixo,
            limit: porPagina,
            offset,
            sortBy: { column: 'name', order: 'asc' },
          }),
        },
      );
      if (!resposta.ok) {
        return { ok: false, motivo: `O bucket recusou a listagem (HTTP ${resposta.status}).`, status: resposta.status };
      }
      const pagina = (await resposta.json()) as Array<{
        name: string;
        id?: string | null;
        created_at?: string | null;
        metadata?: { size?: number } | null;
      }>;
      if (!Array.isArray(pagina)) return { ok: false, motivo: 'O bucket respondeu num formato inesperado.' };
      for (const o of pagina) {
        itens.push({
          nome: o.name,
          bytes: Number(o.metadata?.size ?? 0),
          criadoEm: o.created_at ?? null,
          pasta: o.id === null || o.id === undefined ? !o.metadata : false,
        });
      }
      if (pagina.length === 0) break;
      offset += pagina.length;
    }
    return { ok: true, itens };
  } catch (err) {
    return { ok: false, motivo: motivoDe(err, 'Falha ao listar o bucket.') };
  }
}

/** Traz um objeto para a memória. O chamador decide onde (e se) escreve. */
export async function baixarObjeto(
  caminho: string,
  opts: OpcoesDoBucket = {},
): Promise<{ ok: true; conteudo: Buffer } | Falha> {
  const p = preparar(opts);
  if (!p) return { ok: false, motivo: NAO_CONFIGURADA };
  try {
    const resposta = await p.fetchImpl(urlDoObjeto(p.config, caminho), { headers: cabecalhos(p.config) });
    if (!resposta.ok) {
      return {
        ok: false,
        motivo:
          resposta.status === 404 || resposta.status === 400
            ? `O objeto ${caminho} não está no bucket (HTTP ${resposta.status}).`
            : `O bucket recusou a leitura de ${caminho} (HTTP ${resposta.status}).`,
        status: resposta.status,
      };
    }
    return { ok: true, conteudo: Buffer.from(await resposta.arrayBuffer()) };
  } catch (err) {
    return { ok: false, motivo: motivoDe(err, `Falha ao baixar ${caminho}.`) };
  }
}

/**
 * O Supabase responde "já existe" de dois jeitos, conforme a versão do
 * storage: HTTP 409, ou HTTP 400 com `Duplicate`/`already exists` no corpo.
 */
async function ehDuplicata(resposta: Response): Promise<boolean> {
  if (resposta.status === 409) return true;
  if (resposta.status !== 400) return false;
  try {
    return /duplicate|already exists/i.test(await resposta.text());
  } catch {
    return false;
  }
}

/**
 * Grava um objeto SEM sobrescrever. `jaExistia: true` quando o bucket disse
 * que o nome já estava tomado — para objeto endereçado pelo sha256 isso é
 * "o conteúdo já está lá"; para qualquer outro, o chamador trata como erro.
 */
export async function enviarObjeto(
  caminho: string,
  corpo: Buffer | string,
  tipo: string,
  opts: OpcoesDoBucket = {},
): Promise<{ ok: true; jaExistia: boolean } | Falha> {
  const p = preparar(opts);
  if (!p) return { ok: false, motivo: NAO_CONFIGURADA };
  try {
    const resposta = await p.fetchImpl(urlDoObjeto(p.config, caminho), {
      method: 'POST',
      headers: cabecalhos(p.config, { 'Content-Type': tipo }),
      body: typeof corpo === 'string' ? corpo : (new Uint8Array(corpo).buffer as ArrayBuffer),
    });
    if (resposta.ok) return { ok: true, jaExistia: false };
    if (await ehDuplicata(resposta)) return { ok: true, jaExistia: true };
    return { ok: false, motivo: `O bucket recusou o envio de ${caminho} (HTTP ${resposta.status}).`, status: resposta.status };
  } catch (err) {
    return { ok: false, motivo: motivoDe(err, `Falha ao enviar ${caminho}.`) };
  }
}
