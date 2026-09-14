/**
 * ============================================================================
 * OS ARQUIVOS TAMBÉM PRECISAM VOLTAR
 * ============================================================================
 *
 * O backup copiava o `.db` e só ele. As imagens enviadas pelo usuário — logo e
 * capa de cada loja, foto de produto, foto de OS — não entravam em cópia
 * nenhuma, local ou remota. E não estão no git, corretamente: são dado, não
 * código.
 *
 * Quer dizer que, se o disco morresse, o banco voltaria do bucket com todos os
 * links de imagem apontando para arquivos que não existem mais em lugar
 * nenhum. O sistema voltaria parecendo inteiro, com a vitrine sem foto.
 *
 * ============================================================================
 * O DESENHO, E POR QUE ELE É ESSE
 * ============================================================================
 *
 * ## Fora do SQLite
 *
 * A tentação é guardar a imagem como BLOB e deixar o backup do banco resolver.
 * Não: o `.db` é copiado inteiro toda vez, e é ele que precisa ser pequeno o
 * bastante para caber numa janela de manutenção. Imagem dentro do banco faz o
 * arquivo que protege a operação crescer com o catálogo.
 *
 * ## Um pacote, e um manifesto SEPARADO
 *
 * O manifesto sobe como objeto próprio para poder ser lido sem baixar o pacote:
 * é ele que responde "o que tem lá dentro e quanto pesa" para quem está
 * decidindo se restaura. Baixar 300 MB para descobrir que não era o backup
 * certo é o tipo de coisa que se faz uma vez.
 *
 * ## sha256 por arquivo
 *
 * É o que transforma "baixou" em "voltou igual". Sem ele, um pacote truncado no
 * caminho restaura em silêncio e o defeito aparece na tela do cliente, semanas
 * depois, como "a foto sumiu".
 *
 * ## Prefixo próprio no bucket
 *
 * Os uploads vão para `uploads/`; o banco continua onde sempre esteve, na raiz
 * do bucket. Mover os 529 objetos de banco que já existem para um prefixo novo
 * seria reescrever o histórico de backup para ganhar simetria — e o caminho de
 * restauração é a última coisa que se mexe por estética.
 *
 * ## Sem `x-upsert`
 *
 * O envio do banco usa `x-upsert: true` e sobrevive porque o nome carrega
 * carimbo de tempo. Aqui a colisão é ERRO: um pacote sobrescrito em silêncio é
 * um backup a menos, e ninguém fica sabendo.
 *
 * ============================================================================
 * O PACOTE VIROU FORMATO DE LEITURA (GAP-PRD-058)
 * ============================================================================
 *
 * O pacote passava inteiro pela memória, em base64, síncrono na thread da API
 * — e parava de vez acima de 200 MB. O diário agora manda as fotos UMA A UMA,
 * endereçadas pelo sha256 (`services/backup/uploadsIncrementais.ts`, manifesto
 * versão 2). Este módulo continua dono da lista de pastas, do manifesto e da
 * digital do conjunto, e de ABRIR e RESTAURAR os pacotes versão 1 que já estão
 * no bucket (`restauracaoDoBucket.ts` os lê). `montarPacote` fica para gerar
 * um pacote avulso e para os testes do formato; nenhum diário o chama.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { uploadsDir } from '../services/core/ProductImageService.js';
import { storeUploadsDir } from '../services/core/StorefrontSettingsService.js';
import { photosDir } from '../services/core/WorkshopPhotoService.js';
import { remoteBackupConfig, remoteBackupConfigured, type RemoteBackupConfig } from './backupRemoto.js';

/**
 * O pacote inteiro passa pela memória, e em base64 — que custa um terço a mais.
 * Um limite dito é melhor que um processo morto sem explicação no meio da
 * janela de manutenção. Acima disto, a saída é dividir por pasta ou passar a
 * sincronizar arquivo a arquivo; o número existe para forçar essa conversa.
 */
export const LIMITE_DO_PACOTE_BYTES = 200 * 1024 * 1024;

/** O prefixo dos uploads dentro do bucket. O banco fica na raiz, como sempre. */
export const PREFIXO_DE_UPLOADS = 'uploads';

/**
 * TODA pasta onde o servidor grava arquivo enviado por gente.
 *
 * A varredura é por pasta DECLARADA, nunca vasculhando o disco. É o que impede
 * cache, build e `node_modules` de virarem backup — e é a mesma forma da lista
 * de lugares do cofre: o que não está declarado não é protegido, e é por isso
 * que existe teste cobrando que a lista acompanhe o código.
 */
export const PASTAS_DE_UPLOAD: Array<{ folha: string; dir: () => string }> = [
  { folha: 'lojas', dir: storeUploadsDir },
  { folha: 'produtos', dir: uploadsDir },
  { folha: 'os', dir: photosDir },
];

export interface ArquivoDeUpload {
  /** Relativo, com a pasta de origem: `lojas/abc.png`. */
  caminho: string;
  bytes: number;
  sha256: string;
  modificadoEm: string;
}

export interface ManifestoDeUploads {
  versao: 1;
  criadoEm: string;
  totalArquivos: number;
  totalBytes: number;
  arquivos: ArquivoDeUpload[];
}

export interface PacoteAberto {
  manifesto: ManifestoDeUploads;
  /** Caminho relativo → conteúdo em base64. */
  conteudo: Record<string, string>;
}

function varrer(dir: string, folha: string, achados: ArquivoDeUpload[]): void {
  if (!existsSync(dir)) return;
  for (const nome of readdirSync(dir)) {
    const completo = join(dir, nome);
    const st = statSync(completo);
    if (st.isDirectory()) {
      varrer(completo, `${folha}/${nome}`, achados);
      continue;
    }
    if (!st.isFile()) continue;
    achados.push({
      caminho: `${folha}/${nome}`,
      bytes: st.size,
      sha256: createHash('sha256').update(readFileSync(completo)).digest('hex'),
      modificadoEm: st.mtime.toISOString(),
    });
  }
}

/** O que existe nas pastas declaradas, agora. */
export function coletarUploads(): ArquivoDeUpload[] {
  const achados: ArquivoDeUpload[] = [];
  for (const { folha, dir } of PASTAS_DE_UPLOAD) varrer(dir(), folha, achados);
  return achados.sort((a, b) => a.caminho.localeCompare(b.caminho));
}

export function montarManifesto(): ManifestoDeUploads {
  const arquivos = coletarUploads();
  return {
    versao: 1,
    criadoEm: new Date().toISOString(),
    totalArquivos: arquivos.length,
    totalBytes: arquivos.reduce((s, a) => s + a.bytes, 0),
    arquivos,
  };
}

/** Onde, no disco, mora o arquivo de um caminho do manifesto. */
function caminhoLocalDe(caminhoRelativo: string): string | null {
  const folha = caminhoRelativo.split('/')[0];
  const pasta = PASTAS_DE_UPLOAD.find((p) => p.folha === folha);
  if (!pasta) return null;
  const resto = caminhoRelativo.slice(folha.length + 1);
  return join(pasta.dir(), ...resto.split('/'));
}

export function montarPacote(manifesto: ManifestoDeUploads): Buffer {
  if (manifesto.totalBytes > LIMITE_DO_PACOTE_BYTES) {
    throw new Error(
      `Os uploads somam ${manifesto.totalBytes} bytes e o limite do pacote é `
        + `${LIMITE_DO_PACOTE_BYTES}. Acima disto o pacote inteiro não cabe na memória `
        + 'com folga: divida por pasta ou passe a sincronizar arquivo a arquivo.',
    );
  }

  const conteudo: Record<string, string> = {};
  for (const a of manifesto.arquivos) {
    const local = caminhoLocalDe(a.caminho);
    if (!local || !existsSync(local)) {
      throw new Error(`O arquivo ${a.caminho} sumiu entre o manifesto e o empacotamento.`);
    }
    conteudo[a.caminho] = readFileSync(local).toString('base64');
  }

  return gzipSync(Buffer.from(JSON.stringify({ manifesto, conteudo }), 'utf8'));
}

/**
 * Abre o pacote.
 *
 * `gunzipSync` já recusa conteúdo adulterado — o gzip carrega CRC32. A
 * conferência por arquivo, com o sha256 do manifesto, acontece na restauração:
 * é lá que o byte errado importa.
 */
export function abrirPacote(bytes: Buffer): PacoteAberto {
  const cru = gunzipSync(bytes).toString('utf8');
  const aberto = JSON.parse(cru) as PacoteAberto;
  if (aberto?.manifesto?.versao !== 1) {
    throw new Error('Pacote de uploads em formato desconhecido.');
  }
  return aberto;
}

export interface ResultadoDaRestauracao {
  arquivos: number;
  bytes: number;
  destino: string;
}

/**
 * Escreve o pacote num destino — NUNCA por cima das pastas operacionais sem
 * que quem chamou tenha dito o caminho.
 */
export function restaurarUploadsEm(destino: string, pacote: PacoteAberto): ResultadoDaRestauracao {
  const raiz = resolve(destino);
  let bytes = 0;

  for (const a of pacote.manifesto.arquivos) {
    /*
      O pacote pode vir de um bucket. Um caminho com `..` escreveria FORA do
      destino — e num restore rodado como serviço, isso é escrita em qualquer
      lugar do disco. A checagem é feita no caminho já resolvido, porque é o
      único que não mente.
    */
    const alvo = resolve(raiz, ...a.caminho.split('/'));
    if (alvo !== raiz && !alvo.startsWith(raiz + sep)) {
      throw new Error(`Caminho fora do destino no pacote: ${a.caminho}`);
    }

    const base64 = pacote.conteudo[a.caminho];
    if (base64 === undefined) {
      throw new Error(`O pacote não traz o conteúdo de ${a.caminho}.`);
    }
    const conteudo = Buffer.from(base64, 'base64');

    const hash = createHash('sha256').update(conteudo).digest('hex');
    if (hash !== a.sha256) {
      throw new Error(
        `${a.caminho} não bate com o sha256 do manifesto: o pacote está corrompido `
          + 'ou foi alterado. Nada foi restaurado deste arquivo.',
      );
    }

    mkdirSync(dirname(alvo), { recursive: true });
    writeFileSync(alvo, conteudo);
    bytes += conteudo.length;
  }

  return { arquivos: pacote.manifesto.arquivos.length, bytes, destino: raiz };
}

/**
 * A impressão digital do CONJUNTO de arquivos.
 *
 * Os uploads mudam muito menos que o banco: uma loja troca o logo uma vez por
 * ano. Mandar um pacote idêntico todo dia encheria o bucket de cópias iguais
 * — e o bucket é pago, cresce sozinho e já tem 529 objetos por um defeito
 * parecido no backup do banco.
 *
 * A digital cobre caminho, tamanho e sha256 de cada arquivo. Renomear, trocar
 * conteúdo ou acrescentar um arquivo muda a digital; reordenar a leitura do
 * diretório não muda, porque a lista é ordenada.
 */
export function digitalDoConjunto(manifesto: Pick<ManifestoDeUploads, 'arquivos'>): string {
  const resumo = manifesto.arquivos
    .map((a) => `${a.caminho}:${a.bytes}:${a.sha256}`)
    .join('\n');
  return createHash('sha256').update(resumo).digest('hex');
}

/** Traz um pacote de volta do bucket, sem escrever em lugar nenhum ainda. */
export async function baixarPacoteDeUploads(
  nome: string,
  opts: { fetchImpl?: typeof fetch; config?: RemoteBackupConfig } = {},
): Promise<{ ok: true; pacote: PacoteAberto } | { ok: false; motivo: string }> {
  const config = opts.config ?? remoteBackupConfig();
  if (!remoteBackupConfigured(config)) {
    return { ok: false, motivo: 'Cópia remota não configurada.' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const resposta = await fetchImpl(
      `${config.url}/storage/v1/object/${config.bucket}/${PREFIXO_DE_UPLOADS}/${nome}`,
      { headers: { Authorization: `Bearer ${config.serviceKey}`, apikey: config.serviceKey } },
    );
    if (!resposta.ok) {
      return { ok: false, motivo: `O bucket recusou a leitura (HTTP ${resposta.status}).` };
    }
    return { ok: true, pacote: abrirPacote(Buffer.from(await resposta.arrayBuffer())) };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : 'Falha ao baixar.' };
  }
}

/** Só para o relatório: o caminho relativo de um arquivo, a partir da raiz. */
export function relativoDe(base: string, completo: string): string {
  return relative(base, completo).split(sep).join('/');
}
