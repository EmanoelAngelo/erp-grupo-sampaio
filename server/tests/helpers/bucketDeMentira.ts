/**
 * Um bucket do Supabase Storage de mentira, em memória.
 *
 * Responde às quatro rotas que o backup usa — gravar, ler, listar e apagar —
 * com as regras que importam para o backup:
 *
 *   - sem a chave certa no cabeçalho, 401;
 *   - gravar num nome que já existe SEM `x-upsert` é 409 (`Duplicate`);
 *   - a listagem é por prefixo, com `limit`/`offset`, e devolve as "pastas"
 *     do prefixo como itens sem `id` e sem `metadata`, como o Supabase.
 *
 * Serve de duas formas: `fetchImpl` (para chamar as funções direto) e
 * `ouvir()` (um servidor HTTP de verdade em 127.0.0.1, porta escolhida pelo
 * sistema, para os comandos rodados como processo filho). Nenhuma das duas
 * sai da máquina.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Chamada {
  metodo: string;
  caminho: string;
  cabecalhos: Record<string, string>;
}

interface Objeto {
  conteudo: Buffer;
  criadoEm: string;
}

export interface BucketDeMentira {
  bucket: string;
  chave: string;
  objetos: Map<string, Objeto>;
  chamadas: Chamada[];
  /** Faz a próxima gravação cujo caminho casar com o padrão responder `status`. */
  falharGravacao(padrao: RegExp, status?: number): void;
  fetchImpl: typeof fetch;
  ouvir(): Promise<{ url: string; fechar: () => Promise<void> }>;
}

export function criarBucketDeMentira(opts: { bucket?: string; chave?: string } = {}): BucketDeMentira {
  const bucket = opts.bucket ?? 'backups';
  const chave = opts.chave ?? 'sb_secret_de_mentira_que_nao_pode_vazar';
  const objetos = new Map<string, Objeto>();
  const chamadas: Chamada[] = [];
  const falhas: Array<{ padrao: RegExp; status: number }> = [];

  function responder(
    metodo: string,
    urlCompleta: string,
    cabecalhos: Record<string, string>,
    corpo: Buffer,
  ): { status: number; corpo: Buffer | string; tipo: string } {
    const url = new URL(urlCompleta);
    const caminho = decodeURIComponent(url.pathname);
    chamadas.push({ metodo, caminho, cabecalhos });
    const auth = cabecalhos.authorization ?? cabecalhos.Authorization;
    if (auth !== `Bearer ${chave}`) return { status: 401, corpo: '{"error":"unauthorized"}', tipo: 'application/json' };

    const lista = `/storage/v1/object/list/${bucket}`;
    if (metodo === 'POST' && caminho === lista) {
      const pedido = JSON.parse(corpo.toString('utf8') || '{}') as { prefix?: string; limit?: number; offset?: number };
      const prefixo = (pedido.prefix ?? '').replace(/\/+$/, '');
      const base = prefixo ? `${prefixo}/` : '';
      const nomes = new Map<string, { pasta: boolean; objeto?: Objeto }>();
      for (const [nome, objeto] of objetos) {
        if (!nome.startsWith(base)) continue;
        const resto = nome.slice(base.length);
        const barra = resto.indexOf('/');
        if (barra >= 0) nomes.set(resto.slice(0, barra), { pasta: true });
        else nomes.set(resto, { pasta: false, objeto });
      }
      const ordenados = [...nomes.entries()].sort(([a], [b]) => a.localeCompare(b));
      const inicio = pedido.offset ?? 0;
      const pagina = ordenados.slice(inicio, inicio + (pedido.limit ?? 100)).map(([nome, v]) =>
        v.pasta
          ? { name: nome, id: null, created_at: null, metadata: null }
          : {
              name: nome,
              id: `id-${nome}`,
              created_at: v.objeto!.criadoEm,
              metadata: { size: v.objeto!.conteudo.length },
            },
      );
      return { status: 200, corpo: JSON.stringify(pagina), tipo: 'application/json' };
    }

    const prefixoDoObjeto = `/storage/v1/object/${bucket}/`;
    if (!caminho.startsWith(prefixoDoObjeto)) return { status: 404, corpo: '{"error":"not found"}', tipo: 'application/json' };
    const nome = caminho.slice(prefixoDoObjeto.length);

    if (metodo === 'GET') {
      const o = objetos.get(nome);
      if (!o) return { status: 400, corpo: '{"statusCode":"404","error":"not_found","message":"Object not found"}', tipo: 'application/json' };
      return { status: 200, corpo: o.conteudo, tipo: 'application/octet-stream' };
    }
    if (metodo === 'POST') {
      const falha = falhas.findIndex((f) => f.padrao.test(nome));
      if (falha >= 0) {
        const [{ status }] = falhas.splice(falha, 1);
        return { status, corpo: '{"error":"falha encenada"}', tipo: 'application/json' };
      }
      const upsert = (cabecalhos['x-upsert'] ?? '') === 'true';
      if (objetos.has(nome) && !upsert) {
        return { status: 409, corpo: '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}', tipo: 'application/json' };
      }
      objetos.set(nome, { conteudo: corpo, criadoEm: new Date().toISOString() });
      return { status: 200, corpo: JSON.stringify({ Key: `${bucket}/${nome}` }), tipo: 'application/json' };
    }
    if (metodo === 'DELETE') {
      objetos.delete(nome);
      return { status: 200, corpo: '{}', tipo: 'application/json' };
    }
    return { status: 405, corpo: '{}', tipo: 'application/json' };
  }

  function minusculas(h: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!h) return out;
    if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
    else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
  }

  async function corpoDe(body: BodyInit | null | undefined): Promise<Buffer> {
    if (body == null) return Buffer.alloc(0);
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return Buffer.from(await new Response(body).arrayBuffer());
  }

  const fetchImpl = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const r = responder((init?.method ?? 'GET').toUpperCase(), url, minusculas(init?.headers), await corpoDe(init?.body));
    return new Response(typeof r.corpo === 'string' ? r.corpo : new Uint8Array(r.corpo), {
      status: r.status,
      headers: { 'Content-Type': r.tipo },
    });
  }) as unknown as typeof fetch;

  async function ouvir(): Promise<{ url: string; fechar: () => Promise<void> }> {
    const servidor: Server = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (p: Buffer) => partes.push(p));
      req.on('end', () => {
        const cab: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') cab[k.toLowerCase()] = v;
        const r = responder(req.method ?? 'GET', `http://127.0.0.1${req.url ?? '/'}`, cab, Buffer.concat(partes));
        res.writeHead(r.status, { 'Content-Type': r.tipo });
        res.end(r.corpo);
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', () => ok()));
    const { port } = servidor.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      fechar: () => new Promise<void>((ok) => servidor.close(() => ok())),
    };
  }

  return {
    bucket,
    chave,
    objetos,
    chamadas,
    falharGravacao: (padrao, status = 500) => falhas.push({ padrao, status }),
    fetchImpl,
    ouvir,
  };
}
