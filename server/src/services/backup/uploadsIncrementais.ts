/**
 * ============================================================================
 * AS FOTOS VÃO PARA O BUCKET UMA A UMA (GAP-PRD-058)
 * ============================================================================
 *
 * O pacote de uploads (`db/backupUploads.ts`) juntava TODAS as fotos num JSON
 * com o conteúdo em base64, comprimia e mandava de uma vez — tudo na memória e
 * tudo síncrono, na thread da API, na hora do diário:
 *
 *   - acima de 200 MB (o teto escrito no código) a cópia remota das fotos
 *     parava, com uma linha de log e mais nada;
 *   - antes disso, todo dia o processo lia e hasheava o catálogo inteiro e
 *     empacotava tudo, e o balcão esperava.
 *
 * O desenho agora é o de um armazenamento por conteúdo:
 *
 *   - cada arquivo sobe como `uploads/objetos/<sha256>` — o nome É o
 *     conteúdo. Arquivo que já subiu não sobe de novo; dois arquivos iguais
 *     são um objeto só; e não há teto, porque nada passa inteiro pela memória
 *     (uma foto por vez, e foto tem no máximo alguns MB);
 *   - um MANIFESTO por conjunto (`uploads/manifesto-<carimbo>.json`, versão 2)
 *     diz qual caminho tem qual sha256. É ele que a restauração lê;
 *   - a digital de cada arquivo fica guardada em `core_backup_uploads` junto
 *     com tamanho e data de modificação: arquivo que não mudou não é relido;
 *   - o que já está no bucket fica em `core_backup_objetos_remotos`, por
 *     destino (URL + bucket): trocar de bucket reenvia tudo;
 *   - tudo é assíncrono (`fs/promises` e stream para o hash): entre um
 *     arquivo e outro, a API atende quem estiver no balcão.
 *
 * A ORDEM continua a do pacote: os objetos antes, o manifesto por último. Se
 * o envio parar no meio, sobram objetos sem manifesto (inofensivo: o próximo
 * diário os reaproveita) — nunca um manifesto prometendo o que não subiu.
 *
 * O formato antigo (versão 1, pacote `.json.gz`) continua sendo LIDO pela
 * restauração (`restauracaoDoBucket.ts`): os pacotes que já estão no bucket
 * não viram lixo.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  PASTAS_DE_UPLOAD,
  PREFIXO_DE_UPLOADS,
  digitalDoConjunto,
  type ArquivoDeUpload,
} from '../../db/backupUploads.js';
import { remoteBackupConfig, remoteBackupConfigured, type RemoteBackupConfig } from '../../db/backupRemoto.js';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { enviarObjeto, type OpcoesDoBucket } from './bucket.js';
import { gravarMetaJson, lerMetaJson } from './registroDoBackup.js';

/** Onde moram os objetos, dentro do bucket. */
export const PREFIXO_DOS_OBJETOS = `${PREFIXO_DE_UPLOADS}/objetos`;

export interface ManifestoPorObjetos {
  versao: 2;
  formato: 'objetos';
  criadoEm: string;
  totalArquivos: number;
  totalBytes: number;
  arquivos: ArquivoDeUpload[];
}

/** O último conjunto que chegou inteiro ao bucket. Guardado em `core_meta`. */
export interface UltimoConjuntoEnviado {
  destino: string;
  digital: string;
  manifesto: string;
  enviadoEm: string;
  arquivos: number;
  bytes: number;
}

export const META_ULTIMO_CONJUNTO = 'uploads_backup_objetos';

// ------------------------------------------------------------------ inventário

interface Visto {
  caminho: string;
  completo: string;
  bytes: number;
  modificadoEm: string;
}

async function varrer(dir: string, folha: string, achados: Visto[]): Promise<void> {
  let entradas;
  try {
    entradas = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entrada of entradas) {
    const completo = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      await varrer(completo, `${folha}/${entrada.name}`, achados);
    } else if (entrada.isFile()) {
      const st = await stat(completo);
      achados.push({
        caminho: `${folha}/${entrada.name}`,
        completo,
        bytes: st.size,
        modificadoEm: st.mtime.toISOString(),
      });
    }
  }
}

/** sha256 de um arquivo por stream: o arquivo nunca passa inteiro pela memória. */
export function hashDoArquivo(caminho: string): Promise<string> {
  return new Promise((aceitar, recusar) => {
    const hash = createHash('sha256');
    createReadStream(caminho)
      .on('data', (pedaco) => hash.update(pedaco))
      .on('error', recusar)
      .on('end', () => aceitar(hash.digest('hex')));
  });
}

/** Onde, no disco, mora o arquivo de um caminho do manifesto (`lojas/x.png`). */
export function caminhoLocalDoUpload(caminhoRelativo: string): string | null {
  const folha = caminhoRelativo.split('/')[0];
  const pasta = PASTAS_DE_UPLOAD.find((p) => p.folha === folha);
  if (!pasta) return null;
  return join(pasta.dir(), ...caminhoRelativo.slice(folha.length + 1).split('/'));
}

/**
 * O que existe nas pastas declaradas, agora — com o sha256 de cada arquivo.
 *
 * Só relê o arquivo cujo tamanho ou data de modificação mudou desde a última
 * varredura; o resto reaproveita a digital guardada. Arquivo que sumiu sai do
 * índice.
 */
export async function inventariarUploads(agora = new Date()): Promise<ManifestoPorObjetos> {
  const vistos: Visto[] = [];
  for (const { folha, dir } of PASTAS_DE_UPLOAD) await varrer(dir(), folha, vistos);
  vistos.sort((a, b) => a.caminho.localeCompare(b.caminho));

  ensureCoreSchema();
  const db = getConnection();
  const guardados = new Map(
    (
      db.prepare('SELECT caminho, bytes, modificado_em, sha256 FROM core_backup_uploads').all() as unknown as Array<{
        caminho: string;
        bytes: number;
        modificado_em: string;
        sha256: string;
      }>
    ).map((l) => [l.caminho, l]),
  );
  const gravar = db.prepare(
    `INSERT INTO core_backup_uploads (caminho, bytes, modificado_em, sha256, visto_em) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(caminho) DO UPDATE SET bytes = excluded.bytes, modificado_em = excluded.modificado_em,
       sha256 = excluded.sha256, visto_em = excluded.visto_em`,
  );

  const arquivos: ArquivoDeUpload[] = [];
  const carimbo = agora.toISOString();
  for (const v of vistos) {
    const g = guardados.get(v.caminho);
    let sha = g && g.bytes === v.bytes && g.modificado_em === v.modificadoEm ? g.sha256 : null;
    if (!sha) {
      try {
        sha = await hashDoArquivo(v.completo);
      } catch (err) {
        // Sumiu entre a listagem e a leitura: fica fora deste conjunto.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      gravar.run(v.caminho, v.bytes, v.modificadoEm, sha, carimbo);
    }
    arquivos.push({ caminho: v.caminho, bytes: v.bytes, sha256: sha, modificadoEm: v.modificadoEm });
  }

  const presentes = new Set(arquivos.map((a) => a.caminho));
  const apagar = db.prepare('DELETE FROM core_backup_uploads WHERE caminho = ?');
  for (const caminho of guardados.keys()) if (!presentes.has(caminho)) apagar.run(caminho);

  return {
    versao: 2,
    formato: 'objetos',
    criadoEm: carimbo,
    totalArquivos: arquivos.length,
    totalBytes: arquivos.reduce((s, a) => s + a.bytes, 0),
    arquivos,
  };
}

/** Quanto o índice conhece, sem tocar no disco. É o que a tela de estado mostra. */
export function resumoDoIndice(): { arquivos: number; bytes: number } {
  ensureCoreSchema();
  const l = getConnection()
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM core_backup_uploads')
    .get() as { n: number; b: number };
  return { arquivos: Number(l.n), bytes: Number(l.b) };
}

// ------------------------------------------------------------------ envio

/** A digital do destino: muda com a URL ou o bucket, e nunca carrega a chave. */
export function digitalDoDestino(config: RemoteBackupConfig): string {
  return createHash('sha256').update(`${config.url}|${config.bucket}`).digest('hex').slice(0, 24);
}

export type EstadoDaSincronia = 'enviado' | 'sem_mudanca' | 'vazio' | 'falhou' | 'nao_configurado';

export interface SincroniaDeUploads {
  estado: EstadoDaSincronia;
  /** Arquivos do conjunto atual. */
  arquivos: number;
  bytes: number;
  /** Objetos que subiram NESTA execução (o resto já estava lá). */
  enviados: number;
  bytesEnviados: number;
  /** Nome do manifesto no bucket (`uploads/manifesto-...json`), quando subiu. */
  manifesto: string | null;
  detalhe: string;
}

function jaEnviados(destino: string): Set<string> {
  ensureCoreSchema();
  return new Set(
    (
      getConnection()
        .prepare('SELECT sha256 FROM core_backup_objetos_remotos WHERE destino = ?')
        .all(destino) as unknown as Array<{ sha256: string }>
    ).map((l) => l.sha256),
  );
}

function marcarEnviado(destino: string, sha256: string, bytes: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_backup_objetos_remotos (destino, sha256, bytes, enviado_em) VALUES (?, ?, ?, ?)
       ON CONFLICT(destino, sha256) DO NOTHING`,
    )
    .run(destino, sha256, bytes, new Date().toISOString());
}

/**
 * Leva ao bucket o que ainda não está lá e, se o conjunto mudou, um manifesto
 * novo. Nunca lança: falha vira `estado: 'falhou'` com o motivo.
 */
export async function sincronizarUploads(opts: OpcoesDoBucket = {}): Promise<SincroniaDeUploads> {
  const config = opts.config ?? remoteBackupConfig();
  const base = { arquivos: 0, bytes: 0, enviados: 0, bytesEnviados: 0, manifesto: null };
  if (!remoteBackupConfigured(config)) {
    return { ...base, estado: 'nao_configurado', detalhe: 'Cópia remota não configurada.' };
  }

  try {
    const manifesto = await inventariarUploads();
    const tamanho = { arquivos: manifesto.totalArquivos, bytes: manifesto.totalBytes };
    if (manifesto.totalArquivos === 0) {
      return { ...base, ...tamanho, estado: 'vazio', detalhe: 'Nenhum arquivo nas pastas de upload.' };
    }

    const destino = digitalDoDestino(config);
    const digital = digitalDoConjunto(manifesto);
    const ultimo = lerMetaJson<UltimoConjuntoEnviado>(META_ULTIMO_CONJUNTO);
    if (ultimo && ultimo.destino === destino && ultimo.digital === digital) {
      return {
        ...base,
        ...tamanho,
        manifesto: ultimo.manifesto,
        estado: 'sem_mudanca',
        detalhe: 'Nada mudou desde o último conjunto enviado.',
      };
    }

    // Os objetos que faltam, um por conteúdo.
    const noBucket = jaEnviados(destino);
    const faltam = new Map<string, ArquivoDeUpload>();
    for (const a of manifesto.arquivos) if (!noBucket.has(a.sha256) && !faltam.has(a.sha256)) faltam.set(a.sha256, a);

    let enviados = 0;
    let bytesEnviados = 0;
    const falhas: string[] = [];
    for (const [sha, arquivo] of faltam) {
      const local = caminhoLocalDoUpload(arquivo.caminho);
      if (!local) {
        falhas.push(`${arquivo.caminho}: pasta não declarada`);
        continue;
      }
      let conteudo: Buffer;
      try {
        conteudo = await readFile(local);
      } catch (err) {
        falhas.push(`${arquivo.caminho}: ${(err as Error).message}`);
        continue;
      }
      if (createHash('sha256').update(conteudo).digest('hex') !== sha) {
        // Mudou depois da varredura. O próximo diário leva a versão nova.
        falhas.push(`${arquivo.caminho}: o arquivo mudou durante a cópia`);
        continue;
      }
      const r = await enviarObjeto(`${PREFIXO_DOS_OBJETOS}/${sha}`, conteudo, 'application/octet-stream', {
        ...opts,
        config,
      });
      if (!r.ok) {
        falhas.push(r.motivo);
        continue;
      }
      marcarEnviado(destino, sha, conteudo.length);
      if (!r.jaExistia) {
        enviados += 1;
        bytesEnviados += conteudo.length;
      }
    }

    if (falhas.length > 0) {
      return {
        ...base,
        ...tamanho,
        enviados,
        bytesEnviados,
        estado: 'falhou',
        detalhe:
          `${falhas.length} de ${faltam.size} arquivo(s) não subiram; o manifesto deste conjunto não foi enviado. `
          + `Primeiro motivo: ${falhas[0]}`,
      };
    }

    const nome = `${PREFIXO_DE_UPLOADS}/manifesto-${manifesto.criadoEm.replace(/[:.]/g, '-')}.json`;
    const r = await enviarObjeto(nome, JSON.stringify(manifesto, null, 2), 'application/json', { ...opts, config });
    if (!r.ok || r.jaExistia) {
      return {
        ...base,
        ...tamanho,
        enviados,
        bytesEnviados,
        estado: 'falhou',
        detalhe: r.ok ? `Já existe um manifesto com este nome no bucket: ${nome}` : r.motivo,
      };
    }

    /*
      A digital só é gravada DEPOIS do manifesto confirmado. Gravá-la antes
      faria uma falha de rede parecer sucesso para sempre: o próximo diário
      veria a digital igual e pularia o conjunto que nunca chegou inteiro.
    */
    gravarMetaJson(META_ULTIMO_CONJUNTO, {
      destino,
      digital,
      manifesto: nome,
      enviadoEm: new Date().toISOString(),
      arquivos: manifesto.totalArquivos,
      bytes: manifesto.totalBytes,
    } satisfies UltimoConjuntoEnviado);

    return {
      ...base,
      ...tamanho,
      enviados,
      bytesEnviados,
      manifesto: nome,
      estado: 'enviado',
      detalhe: `${enviados} arquivo(s) novo(s) enviado(s); ${manifesto.totalArquivos - enviados} já estavam no bucket.`,
    };
  } catch (err) {
    return { ...base, estado: 'falhou', detalhe: err instanceof Error ? err.message : 'Falha ao copiar as fotos.' };
  }
}

// ------------------------------------------------------------------ volta

export interface VoltaDasFotos {
  arquivos: number;
  bytes: number;
  /** Já estavam no destino com o mesmo conteúdo — uma restauração interrompida pode ser retomada. */
  jaEstavam: number;
  destino: string;
}

/**
 * Escreve um conjunto versão 2 num destino, baixando cada objeto por
 * `baixar(sha256)`.
 *
 *   - caminho fora do destino, ou fora das pastas declaradas: recusa (o
 *     manifesto vem de um bucket, e `..` seria escrita em qualquer lugar);
 *   - objeto que não bate com o sha256 do manifesto: recusa;
 *   - arquivo que já existe no destino com OUTRO conteúdo: recusa — nunca por
 *     cima; com o mesmo conteúdo, pula (retomar uma volta interrompida).
 */
export async function restaurarConjuntoPorObjetos(
  manifesto: ManifestoPorObjetos,
  destino: string,
  baixar: (sha256: string) => Promise<Buffer>,
): Promise<VoltaDasFotos> {
  if (manifesto?.versao !== 2 || !Array.isArray(manifesto.arquivos)) {
    throw new Error('Manifesto de fotos em formato desconhecido (esperado versão 2).');
  }
  const raiz = resolve(destino);
  const folhas = new Set(PASTAS_DE_UPLOAD.map((p) => p.folha));

  // Confere TODOS os caminhos antes de escrever o primeiro byte.
  const alvos = manifesto.arquivos.map((a) => {
    const alvo = resolve(raiz, ...String(a.caminho).split('/'));
    if (!folhas.has(String(a.caminho).split('/')[0]) || !alvo.startsWith(raiz + sep)) {
      throw new Error(`Caminho fora do destino no manifesto: ${a.caminho}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(a.sha256))) {
      throw new Error(`sha256 inválido no manifesto para ${a.caminho}.`);
    }
    return { ...a, alvo };
  });

  let arquivos = 0;
  let bytes = 0;
  let jaEstavam = 0;
  for (const a of alvos) {
    let existente: Buffer | null = null;
    try {
      existente = await readFile(a.alvo);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (existente) {
      if (createHash('sha256').update(existente).digest('hex') === a.sha256) {
        jaEstavam += 1;
        continue;
      }
      throw new Error(`${a.caminho} já existe no destino com outro conteúdo. Nada é escrito por cima.`);
    }

    const conteudo = await baixar(a.sha256);
    if (createHash('sha256').update(conteudo).digest('hex') !== a.sha256) {
      throw new Error(
        `${a.caminho} não bate com o sha256 do manifesto: o objeto do bucket está corrompido ou foi alterado.`,
      );
    }
    await mkdir(dirname(a.alvo), { recursive: true });
    await writeFile(a.alvo, conteudo);
    arquivos += 1;
    bytes += conteudo.length;
  }
  return { arquivos, bytes, jaEstavam, destino: raiz };
}
