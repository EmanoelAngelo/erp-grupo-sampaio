/**
 * ============================================================================
 * A VOLTA A PARTIR DO BUCKET, SEM PROGRAMAR (GAP-PRD-012)
 * ============================================================================
 *
 * O bucket recebia o banco todo dia e as fotos quando mudavam — e nenhum
 * comando trazia nada de volta. As funções existiam, provadas por teste
 * (`baixarBackupRemoto`, `baixarPacoteDeUploads`, `restaurarUploadsEm`), mas
 * sem porta de entrada: no dia do disco morto, o banco voltaria por download
 * manual no painel do provedor e as fotos só com código novo.
 *
 * Este módulo é a porta, e os comandos em `scripts/` são só a casca dele:
 *
 *   listar-bucket         o que existe lá: cópias do banco e conjuntos de fotos
 *   baixar-backup         traz UMA cópia do banco para um caminho novo, conferida
 *   restaurar-uploads     traz UM conjunto de fotos para uma pasta, conferido
 *   restaurar-do-bucket   o roteiro do disco morto: o banco e as fotos mais
 *                         novos numa pasta nova, e as duas linhas do .env
 *
 * As regras são as do backup local:
 *
 *   - NUNCA por cima: destino que existe é recusado (o banco) ou conferido
 *     arquivo a arquivo (as fotos: igual pula, diferente recusa);
 *   - o que chega é conferido ANTES de valer: o `.db` precisa passar no
 *     `integrity_check` (senão é apagado), cada foto precisa bater com o
 *     sha256 do manifesto;
 *   - os dois formatos de fotos voltam: o conjunto por objetos (versão 2,
 *     o de hoje) e o pacote `.json.gz` (versão 1, o que já está no bucket).
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { verificarBackup } from '../../db/backup.js';
import {
  PASTAS_DE_UPLOAD,
  PREFIXO_DE_UPLOADS,
  abrirPacote,
  restaurarUploadsEm,
  type ManifestoDeUploads,
} from '../../db/backupUploads.js';
import { baixarObjeto, listarObjetos, type Falha, type ObjetoNoBucket, type OpcoesDoBucket } from './bucket.js';
import { PREFIXO_DOS_OBJETOS, restaurarConjuntoPorObjetos, type ManifestoPorObjetos } from './uploadsIncrementais.js';

export interface InventarioDoBucket {
  /** Cópias do banco (raiz do bucket), da mais nova para a mais velha. */
  bancos: ObjetoNoBucket[];
  /** Manifestos de fotos (`uploads/manifesto-*.json`), do mais novo para o mais velho. */
  manifestos: ObjetoNoBucket[];
  /** Pacotes antigos (`uploads/uploads-*.json.gz`, versão 1). */
  pacotes: ObjetoNoBucket[];
}

const maisNovoPrimeiro = (a: ObjetoNoBucket, b: ObjetoNoBucket): number => b.nome.localeCompare(a.nome);

export async function listarBucket(opts: OpcoesDoBucket = {}): Promise<({ ok: true } & InventarioDoBucket) | Falha> {
  const raiz = await listarObjetos('', opts);
  if (!raiz.ok) return raiz;
  const fotos = await listarObjetos(PREFIXO_DE_UPLOADS, opts);
  if (!fotos.ok) return fotos;
  const arquivos = fotos.itens.filter((i) => !i.pasta);
  return {
    ok: true,
    bancos: raiz.itens.filter((i) => !i.pasta && i.nome.endsWith('.db')).sort(maisNovoPrimeiro),
    manifestos: arquivos.filter((i) => /^manifesto-.+\.json$/.test(i.nome)).sort(maisNovoPrimeiro),
    pacotes: arquivos.filter((i) => /^uploads-.+\.json\.gz$/.test(i.nome)).sort(maisNovoPrimeiro),
  };
}

/** Um nome de objeto vindo de quem digita: sem barra, sem `..`, sem caminho. */
function nomeSimples(nome: string): string | null {
  const limpo = nome.trim().replace(/^\/+/, '');
  if (!limpo || limpo.includes('..') || /[\\]/.test(limpo)) return null;
  return limpo;
}

// ------------------------------------------------------------------ o banco

export interface BancoTrazido {
  ok: true;
  nome: string;
  bytes: number;
  tabelas: number;
  destino: string;
}

/**
 * Traz UMA cópia do banco para `destino`, que NÃO pode existir.
 *
 * O download vai para um arquivo ao lado (`.baixando`) e só vira `destino`
 * depois de passar no `integrity_check`. Cópia que não abre é apagada — um
 * `.db` quebrado com o nome certo é a pior coisa que se pode deixar para
 * quem vai subir o servidor em cima dele.
 */
export async function baixarBancoDoBucket(
  pedido: string,
  destino: string,
  opts: OpcoesDoBucket = {},
): Promise<BancoTrazido | Falha> {
  const alvo = resolve(destino);
  if (existsSync(alvo)) {
    return {
      ok: false,
      motivo: `O destino já existe (${alvo}). Restaurar por cima de um banco corrompe os dois; escolha um caminho livre.`,
    };
  }

  let nome: string | null;
  if (pedido === '--ultimo' || pedido === 'ultimo') {
    const lista = await listarObjetos('', opts);
    if (!lista.ok) return lista;
    const bancos = lista.itens.filter((i) => !i.pasta && i.nome.endsWith('.db')).sort(maisNovoPrimeiro);
    if (bancos.length === 0) return { ok: false, motivo: 'O bucket não tem nenhuma cópia do banco.' };
    nome = bancos[0].nome;
  } else {
    nome = nomeSimples(pedido);
    if (!nome || nome.includes('/') || !nome.endsWith('.db')) {
      return { ok: false, motivo: `Nome inválido: ${pedido}. Use o nome de um .db da raiz do bucket (veja listar-bucket).` };
    }
  }

  const baixado = await baixarObjeto(nome, opts);
  if (!baixado.ok) return baixado;

  mkdirSync(dirname(alvo), { recursive: true });
  const provisorio = `${alvo}.baixando`;
  writeFileSync(provisorio, baixado.conteudo);
  const veredito = verificarBackup(provisorio);
  if (!veredito.ok) {
    rmSync(provisorio, { force: true });
    return { ok: false, motivo: `A cópia ${nome} veio do bucket mas NÃO abre como banco: ${veredito.motivo}. Nada foi gravado.` };
  }
  renameSync(provisorio, alvo);
  return { ok: true, nome, bytes: baixado.conteudo.length, tabelas: veredito.tabelas ?? 0, destino: alvo };
}

// ------------------------------------------------------------------ as fotos

export interface FotosTrazidas {
  ok: true;
  formato: 1 | 2;
  origem: string;
  arquivos: number;
  bytes: number;
  jaEstavam: number;
  destino: string;
}

/** Recusa escrever por cima: arquivo do destino com outro conteúdo interrompe tudo antes do primeiro byte. */
async function conferirDestinoDoPacote(destino: string, arquivos: ManifestoDeUploads['arquivos']): Promise<string | null> {
  const raiz = resolve(destino);
  for (const a of arquivos) {
    const alvo = resolve(raiz, ...String(a.caminho).split('/'));
    if (!alvo.startsWith(raiz + sep)) return `Caminho fora do destino no pacote: ${a.caminho}`;
    if (!existsSync(alvo)) continue;
    const atual = createHash('sha256').update(await readFile(alvo)).digest('hex');
    if (atual !== a.sha256) return `${a.caminho} já existe no destino com outro conteúdo. Nada é escrito por cima.`;
  }
  return null;
}

/**
 * Traz UM conjunto de fotos para `destino` — a pasta que vai ser o
 * `DEVORA_UPLOADS_DIR` (os arquivos voltam em `lojas/`, `produtos/` e `os/`).
 *
 * `pedido`: `--ultimo`, um manifesto (`manifesto-<carimbo>.json`, de qualquer
 * versão) ou um pacote antigo (`uploads-<carimbo>.json.gz`).
 */
export async function restaurarFotosDoBucket(
  pedido: string,
  destino: string,
  opts: OpcoesDoBucket = {},
): Promise<FotosTrazidas | Falha> {
  let nome: string | null;
  if (pedido === '--ultimo' || pedido === 'ultimo') {
    const inv = await listarBucket(opts);
    if (!inv.ok) return inv;
    nome = inv.manifestos[0]?.nome ?? inv.pacotes[0]?.nome ?? null;
    if (!nome) return { ok: false, motivo: 'O bucket não tem nenhum conjunto de fotos.' };
  } else {
    nome = nomeSimples(pedido.replace(new RegExp(`^${PREFIXO_DE_UPLOADS}/`), ''));
    if (!nome || nome.includes('/')) return { ok: false, motivo: `Nome inválido: ${pedido}. Veja os nomes com listar-bucket.` };
  }

  try {
    // Pacote antigo, pedido pelo nome do pacote.
    if (nome.endsWith('.json.gz')) return await restaurarPacote(nome, destino, opts);

    const m = await baixarObjeto(`${PREFIXO_DE_UPLOADS}/${nome}`, opts);
    if (!m.ok) return m;
    let manifesto: { versao?: number };
    try {
      manifesto = JSON.parse(m.conteudo.toString('utf8')) as { versao?: number };
    } catch {
      return { ok: false, motivo: `${nome} não é um manifesto válido (JSON quebrado).` };
    }

    if (manifesto.versao === 1) {
      // O pacote da versão 1 tem o mesmo carimbo do manifesto.
      return await restaurarPacote(nome.replace(/^manifesto-/, 'uploads-').replace(/\.json$/, '.json.gz'), destino, opts);
    }
    if (manifesto.versao !== 2) return { ok: false, motivo: `${nome}: versão de manifesto desconhecida (${String(manifesto.versao)}).` };

    const volta = await restaurarConjuntoPorObjetos(manifesto as ManifestoPorObjetos, destino, async (sha) => {
      const o = await baixarObjeto(`${PREFIXO_DOS_OBJETOS}/${sha}`, opts);
      if (!o.ok) throw new Error(o.motivo);
      return o.conteudo;
    });
    return { ok: true, formato: 2, origem: nome, ...volta };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : 'Falha ao restaurar as fotos.' };
  }
}

async function restaurarPacote(nome: string, destino: string, opts: OpcoesDoBucket): Promise<FotosTrazidas | Falha> {
  const p = await baixarObjeto(`${PREFIXO_DE_UPLOADS}/${nome}`, opts);
  if (!p.ok) return p;
  const pacote = abrirPacote(p.conteudo);
  const folhas = new Set(PASTAS_DE_UPLOAD.map((x) => x.folha));
  const fora = pacote.manifesto.arquivos.find((a) => !folhas.has(String(a.caminho).split('/')[0]));
  if (fora) return { ok: false, motivo: `Caminho fora das pastas de upload no pacote: ${fora.caminho}` };
  const recusa = await conferirDestinoDoPacote(destino, pacote.manifesto.arquivos);
  if (recusa) return { ok: false, motivo: recusa };
  const r = restaurarUploadsEm(destino, pacote);
  return { ok: true, formato: 1, origem: nome, arquivos: r.arquivos, bytes: r.bytes, jaEstavam: 0, destino: r.destino };
}

// ------------------------------------------------------------ o disco morto

export interface VoltaCompleta {
  ok: true;
  pasta: string;
  banco: BancoTrazido;
  fotos: FotosTrazidas | null;
  /** Por que não há fotos (bucket sem conjunto), quando for o caso. */
  semFotos: string | null;
  /** As linhas do `.env` que fazem a API subir em cima do que voltou. */
  linhasDoEnv: string[];
}

/**
 * O roteiro do disco morto: numa pasta NOVA (vazia ou inexistente), o banco
 * (`grupo-sampaio.db`) e as fotos (`uploads/`) — os mais novos, ou os pedidos.
 */
export async function restaurarTudoDoBucket(
  pasta: string,
  escolha: { banco?: string; fotos?: string } = {},
  opts: OpcoesDoBucket = {},
): Promise<VoltaCompleta | Falha> {
  const raiz = resolve(pasta);
  if (existsSync(raiz) && readdirSync(raiz).length > 0) {
    return { ok: false, motivo: `A pasta ${raiz} não está vazia. A volta vai para uma pasta NOVA — nunca por cima da instalação.` };
  }
  mkdirSync(raiz, { recursive: true });

  const banco = await baixarBancoDoBucket(escolha.banco ?? '--ultimo', join(raiz, 'grupo-sampaio.db'), opts);
  if (!banco.ok) return banco;

  const uploads = join(raiz, 'uploads');
  const inv = await listarBucket(opts);
  if (!inv.ok) return inv;
  let fotos: FotosTrazidas | null = null;
  let semFotos: string | null = null;
  if (escolha.fotos || inv.manifestos.length + inv.pacotes.length > 0) {
    const r = await restaurarFotosDoBucket(escolha.fotos ?? '--ultimo', uploads, opts);
    if (!r.ok) return { ok: false, motivo: `O banco voltou (${banco.destino}), mas as fotos não: ${r.motivo}` };
    fotos = r;
  } else {
    semFotos = 'O bucket não tem conjunto de fotos: ou não havia foto nenhuma, ou a cópia das fotos nunca rodou.';
    mkdirSync(uploads, { recursive: true });
  }

  const barra = (c: string) => c.split('\\').join('/');
  return {
    ok: true,
    pasta: raiz,
    banco,
    fotos,
    semFotos,
    linhasDoEnv: [`DEVORA_DATABASE_PATH=${barra(banco.destino)}`, `DEVORA_UPLOADS_DIR=${barra(uploads)}`],
  };
}
