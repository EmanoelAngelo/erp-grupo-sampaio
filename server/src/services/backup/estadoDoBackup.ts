/**
 * ============================================================================
 * O ESTADO DO BACKUP, SEM SQL NEM LOG (GAP-PRD-011, GAP-PRD-068)
 * ============================================================================
 *
 * `GET /system/backup/status` respondia `{ lastBackup: null, status:
 * 'documented' }` cravado — com backup na pasta ou sem. A permissão
 * `system-backup.view` guardava um dado falso, e nenhuma tela perguntava.
 * A cópia remota podia falhar por meses sem ninguém saber: o histórico do
 * projeto registra 118 eventos parados por 12 dias com o log dizendo "sem
 * credencial".
 *
 * Esta é a resposta de verdade, item por item, com três estados:
 *
 *   PRONTO    conferido e em dia;
 *   PENDENTE  falta configurar, ou ainda não houve a primeira vez;
 *   FALHOU    a última tentativa falhou, ou a última cópia boa é velha demais.
 *
 * O que ela lê: a pasta de backup (o que existe de fato), o registro das
 * execuções (`core_backup_execucoes` — o que aconteceu e por quê), a
 * configuração da cópia remota (só se existe, nunca o valor), a lembrança do
 * último conjunto de fotos enviado e a última conferência do bucket.
 *
 * Nada aqui toca a rede: a conferência do bucket é um gesto separado
 * (`conferirBucket`), porque ler o bucket custa uma chamada ao provedor e a
 * tela de estado é aberta a qualquer hora.
 */
import { basename } from 'node:path';
import {
  backupDirectory,
  backupNoMesmoDiscoDoBanco,
  listarBackups,
  ultimoDiario,
} from '../../db/backup.js';
import { remoteBackupConfig, remoteBackupConfigured } from '../../db/backupRemoto.js';
import { resolveDatabasePath } from '../../db/sqlite.js';
import { isDisposableDatabase } from '../../db/safety.js';
import { horaDoDiario, proximaExecucaoDoDiario } from './agendaDoBackup.js';
import { baixarObjeto, listarObjetos, type OpcoesDoBucket } from './bucket.js';
import {
  falhasDesde,
  gravarMetaJson,
  lerMetaJson,
  listarExecucoes,
  ultimaCopiaLocalOk,
  ultimaExecucao,
  ultimaSincroniaDeUploadsOk,
  ultimaTentativaDeUploads,
  ultimaTentativaRemota,
  ultimoEnvioRemotoOk,
  type ExecucaoDoBackup,
} from './registroDoBackup.js';
import {
  META_ULTIMO_CONJUNTO,
  PREFIXO_DOS_OBJETOS,
  digitalDoDestino,
  resumoDoIndice,
  type UltimoConjuntoEnviado,
} from './uploadsIncrementais.js';

export type EstadoDoItem = 'PRONTO' | 'PENDENTE' | 'FALHOU';

export interface ItemDoBackup {
  id: 'copia_local' | 'outro_disco' | 'copia_remota' | 'fotos' | 'bucket_conferido';
  titulo: string;
  estado: EstadoDoItem;
  detalhe: string;
  /** O instante do fato que o item mostra (a última cópia, o último envio...). */
  quando: string | null;
  comoResolver?: string;
}

export interface ConferenciaDoBucket {
  conferidoEm: string;
  ok: boolean;
  motivo: string | null;
  bancos: number;
  ultimoBanco: { nome: string; bytes: number; criadoEm: string | null } | null;
  /** O último `.db` que o diário diz ter enviado está lá, com o tamanho certo? `null` = nada a conferir. */
  ultimoEnvioPresente: boolean | null;
  manifesto: string | null;
  fotosNoManifesto: number | null;
  objetosFaltando: number | null;
}

export interface EstadoDoBackup {
  conferidoEm: string;
  geral: EstadoDoItem;
  itens: ItemDoBackup[];
  local: {
    pasta: string;
    mesmoDiscoDoBanco: boolean;
    bancoDescartavel: boolean;
    quantidade: number;
    bytes: number;
    ultimo: { arquivo: string; bytes: number; criadoEm: string; motivo: string } | null;
  };
  remoto: { configurado: boolean; bucket: string | null };
  fotos: { arquivos: number; bytes: number; ultimoConjunto: Omit<UltimoConjuntoEnviado, 'destino' | 'digital'> | null };
  bucket: ConferenciaDoBucket | null;
  agenda: { hora: number; proxima: string };
  execucoes: ExecucaoDoBackup[];
  /** Execuções com alguma etapa que falhou nos últimos 30 dias. */
  falhas: ExecucaoDoBackup[];
}

export const META_CONFERENCIA_DO_BUCKET = 'backup_bucket_conferido';

/** Uma cópia diária com mais que isto está atrasada: o diário é de 24 h, com folga. */
const ATRASO_MS = 26 * 60 * 60 * 1000;
/** Uma conferência do bucket mais velha que isto já não diz nada sobre hoje. */
const CONFERENCIA_VELHA_MS = 7 * 24 * 60 * 60 * 1000;

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function horas(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)} dias` : `${h} h`;
}

const COMO_CONFIGURAR_REMOTO =
  'Preencha DEVORA_SUPABASE_URL e DEVORA_SUPABASE_SERVICE_KEY (e, se quiser, DEVORA_SUPABASE_BUCKET) no .env '
  + 'do servidor e reinicie a API. A chave fica só no .env — nunca na tela.';

function itemCopiaLocal(agora: number, descartavel: boolean, hora: number): ItemDoBackup {
  const titulo = 'Cópia diária do banco';
  if (descartavel) {
    return {
      id: 'copia_local',
      titulo,
      estado: 'PENDENTE',
      quando: null,
      detalhe: 'Este servidor usa um banco marcado como descartável (teste): o diário não copia nada.',
      comoResolver: 'Em produção, DEVORA_DATABASE_PATH aponta para o banco real e TEST_DATABASE_PATH não existe.',
    };
  }
  const diario = ultimoDiario();
  const ultima = ultimaExecucao();
  const ultimaOk = ultimaCopiaLocalOk();
  const falhouPorUltimo = ultima && ultima.local.estado === 'falhou' && (!ultimaOk || ultima.iniciadoEm > ultimaOk.iniciadoEm);
  if (falhouPorUltimo) {
    return {
      id: 'copia_local',
      titulo,
      estado: 'FALHOU',
      quando: ultima.iniciadoEm,
      detalhe: `A última cópia falhou: ${ultima.local.detalhe ?? 'sem motivo registrado'}.`,
      comoResolver: `Confira espaço livre e permissão de escrita na pasta ${backupDirectory()}.`,
    };
  }
  if (!diario) {
    return {
      id: 'copia_local',
      titulo,
      estado: ultima ? 'FALHOU' : 'PENDENTE',
      quando: null,
      detalhe: ultima
        ? 'O diário já rodou, mas não há nenhuma cópia diária na pasta — alguém apagou, ou a pasta mudou.'
        : `Ainda não houve cópia diária. Ela roda ao subir a API e todo dia às ${String(hora).padStart(2, '0')}:00.`,
      comoResolver: ultima ? `Confira a pasta ${backupDirectory()} e o DEVORA_BACKUP_DIR do .env.` : undefined,
    };
  }
  const idade = agora - new Date(diario.createdAt).getTime();
  if (idade > ATRASO_MS) {
    return {
      id: 'copia_local',
      titulo,
      estado: 'FALHOU',
      quando: diario.createdAt,
      detalhe: `A última cópia diária tem ${horas(idade)}: o diário parou de rodar.`,
      comoResolver: 'A API esteve desligada, ou o diário não está sendo agendado. Reinicie a API: ao subir, ela copia na hora.',
    };
  }
  return {
    id: 'copia_local',
    titulo,
    estado: 'PRONTO',
    quando: diario.createdAt,
    detalhe: `${diario.file} (${mb(diario.bytes)}).`,
  };
}

function itemOutroDisco(mesmoDisco: boolean): ItemDoBackup {
  const pasta = backupDirectory();
  return mesmoDisco
    ? {
        id: 'outro_disco',
        titulo: 'Backup em outro disco',
        estado: 'PENDENTE',
        quando: null,
        detalhe: `A pasta ${pasta} está no MESMO disco do banco. Se o disco morrer, morrem os dois — sobra só a cópia remota.`,
        comoResolver:
          'Aponte DEVORA_BACKUP_DIR para outro disco, pen drive ou volume (ex.: DEVORA_BACKUP_DIR=E:/backups-grupo-sampaio) '
          + 'no .env e reinicie a API. Uma pasta sincronizada no mesmo disco continua aparecendo aqui como mesmo disco.',
      }
    : {
        id: 'outro_disco',
        titulo: 'Backup em outro disco',
        estado: 'PRONTO',
        quando: null,
        detalhe:
          `A pasta ${pasta} fica em outro volume que o banco. Se for uma partição do mesmo HD físico, `
          + 'quem protege de um disco morto é a cópia remota.',
      };
}

function itemCopiaRemota(agora: number, configurado: boolean): ItemDoBackup {
  const titulo = 'Cópia fora deste computador (bucket)';
  if (!configurado) {
    return {
      id: 'copia_remota',
      titulo,
      estado: 'PENDENTE',
      quando: null,
      detalhe: 'A cópia remota não está configurada: o banco de ontem só existe neste computador.',
      comoResolver: COMO_CONFIGURAR_REMOTO,
    };
  }
  const ok = ultimoEnvioRemotoOk();
  const tentativa = ultimaTentativaRemota();
  if (tentativa && tentativa.remoto.estado === 'falhou' && (!ok || tentativa.iniciadoEm > ok.iniciadoEm)) {
    return {
      id: 'copia_remota',
      titulo,
      estado: 'FALHOU',
      quando: tentativa.iniciadoEm,
      detalhe: `O último envio ao bucket falhou: ${tentativa.remoto.detalhe ?? 'sem motivo registrado'}.`
        + (ok ? ` O último que subiu foi em ${ok.iniciadoEm}.` : ' Nenhum envio subiu até hoje.'),
      comoResolver: 'HTTP 401/403: a chave do .env não vale mais (troque no painel do provedor e no .env). '
        + 'Falha de rede: confira a internet do servidor. Depois, reinicie a API ou espere o próximo diário.',
    };
  }
  if (!ok) {
    return {
      id: 'copia_remota',
      titulo,
      estado: 'PENDENTE',
      quando: null,
      detalhe: 'Configurada, mas nenhum envio aconteceu ainda. O primeiro sobe no próximo diário.',
    };
  }
  const idade = agora - new Date(ok.iniciadoEm).getTime();
  if (idade > ATRASO_MS) {
    return {
      id: 'copia_remota',
      titulo,
      estado: 'FALHOU',
      quando: ok.iniciadoEm,
      detalhe: `O último envio que subiu tem ${horas(idade)}.`,
      comoResolver: 'O diário não está rodando ou não está chegando ao envio. Veja a cópia diária acima.',
    };
  }
  return {
    id: 'copia_remota',
    titulo,
    estado: 'PRONTO',
    quando: ok.iniciadoEm,
    detalhe: `${ok.remoto.objeto ?? 'objeto'} subiu.`,
  };
}

function itemFotos(agora: number, configurado: boolean, conjunto: UltimoConjuntoEnviado | null): ItemDoBackup {
  const titulo = 'Fotos e logos (uploads)';
  if (!configurado) {
    return {
      id: 'fotos',
      titulo,
      estado: 'PENDENTE',
      quando: null,
      detalhe: 'Sem cópia remota configurada, as fotos de produto, loja e OS não têm cópia nenhuma — o backup local copia só o banco.',
      comoResolver: COMO_CONFIGURAR_REMOTO,
    };
  }
  const ok = ultimaSincroniaDeUploadsOk();
  const tentativa = ultimaTentativaDeUploads();
  if (tentativa && tentativa.uploads.estado === 'falhou' && (!ok || tentativa.iniciadoEm > ok.iniciadoEm)) {
    return {
      id: 'fotos',
      titulo,
      estado: 'FALHOU',
      quando: tentativa.iniciadoEm,
      detalhe: `O último envio das fotos falhou: ${tentativa.uploads.detalhe ?? 'sem motivo registrado'}`,
      comoResolver: 'O que já subiu fica guardado; o próximo diário manda só o que faltou.',
    };
  }
  if (!ok) {
    return {
      id: 'fotos',
      titulo,
      estado: 'PENDENTE',
      quando: null,
      detalhe: 'Nenhum envio das fotos aconteceu ainda. O primeiro sobe no próximo diário.',
    };
  }
  const idade = agora - new Date(ok.iniciadoEm).getTime();
  if (idade > ATRASO_MS) {
    return {
      id: 'fotos',
      titulo,
      estado: 'FALHOU',
      quando: ok.iniciadoEm,
      detalhe: `A última conferência das fotos tem ${horas(idade)}.`,
      comoResolver: 'O diário não está rodando. Veja a cópia diária acima.',
    };
  }
  return {
    id: 'fotos',
    titulo,
    estado: 'PRONTO',
    quando: conjunto?.enviadoEm ?? ok.iniciadoEm,
    detalhe:
      ok.uploads.estado === 'vazio'
        ? 'Nenhuma foto nas pastas de upload ainda.'
        : conjunto
          ? `${conjunto.arquivos} arquivo(s), ${mb(conjunto.bytes)}, no bucket (${conjunto.manifesto}).`
          : 'Conferidas no último diário.',
  };
}

function itemBucketConferido(agora: number, conferencia: ConferenciaDoBucket | null): ItemDoBackup {
  const titulo = 'Bucket conferido';
  if (!conferencia) {
    return {
      id: 'bucket_conferido',
      titulo,
      estado: 'PENDENTE',
      quando: null,
      detalhe: 'Ninguém conferiu ainda se as cópias estão mesmo lá. "Enviou" não é "está lá".',
      comoResolver: 'Clique em "Conferir o bucket agora".',
    };
  }
  if (!conferencia.ok) {
    return {
      id: 'bucket_conferido',
      titulo,
      estado: 'FALHOU',
      quando: conferencia.conferidoEm,
      detalhe: `A última conferência achou problema: ${conferencia.motivo ?? 'sem motivo'}.`,
      comoResolver: 'Confira a chave e o bucket no .env; o próximo diário reenvia o que falta nas fotos.',
    };
  }
  const idade = agora - new Date(conferencia.conferidoEm).getTime();
  return {
    id: 'bucket_conferido',
    titulo,
    estado: idade > CONFERENCIA_VELHA_MS ? 'PENDENTE' : 'PRONTO',
    quando: conferencia.conferidoEm,
    detalhe:
      `${conferencia.bancos} cópia(s) do banco no bucket`
      + (conferencia.ultimoBanco ? `, a mais nova ${conferencia.ultimoBanco.nome}` : '')
      + (conferencia.fotosNoManifesto !== null ? `; ${conferencia.fotosNoManifesto} foto(s) no último conjunto, nenhuma faltando` : '')
      + (idade > CONFERENCIA_VELHA_MS ? ` — mas a conferência tem ${horas(idade)}.` : '.'),
    comoResolver: idade > CONFERENCIA_VELHA_MS ? 'Clique em "Conferir o bucket agora".' : undefined,
  };
}

export function estadoDoBackup(agora: Date = new Date()): EstadoDoBackup {
  const t = agora.getTime();
  const config = remoteBackupConfig();
  const configurado = remoteBackupConfigured(config);
  const banco = resolveDatabasePath();
  const descartavel = banco === ':memory:' || isDisposableDatabase(banco);
  const mesmoDisco = backupNoMesmoDiscoDoBanco();
  const hora = horaDoDiario();
  const backups = listarBackups();
  const conjunto = lerMetaJson<UltimoConjuntoEnviado>(META_ULTIMO_CONJUNTO);
  const conjuntoDesteDestino = conjunto && configurado && conjunto.destino === digitalDoDestino(config) ? conjunto : null;
  const conferencia = configurado ? lerMetaJson<ConferenciaDoBucket>(META_CONFERENCIA_DO_BUCKET) : null;

  const itens: ItemDoBackup[] = [
    itemCopiaLocal(t, descartavel, hora),
    itemOutroDisco(mesmoDisco),
    itemCopiaRemota(t, configurado),
    itemFotos(t, configurado, conjuntoDesteDestino),
  ];
  if (configurado) itens.push(itemBucketConferido(t, conferencia));

  const geral: EstadoDoItem = itens.some((i) => i.estado === 'FALHOU')
    ? 'FALHOU'
    : itens.some((i) => i.estado === 'PENDENTE')
      ? 'PENDENTE'
      : 'PRONTO';

  const ultimo = backups[0] ?? null;
  const indice = resumoDoIndice();
  return {
    conferidoEm: agora.toISOString(),
    geral,
    itens,
    local: {
      pasta: backupDirectory(),
      mesmoDiscoDoBanco: mesmoDisco,
      bancoDescartavel: descartavel,
      quantidade: backups.length,
      bytes: backups.reduce((s, b) => s + b.bytes, 0),
      ultimo: ultimo ? { arquivo: basename(ultimo.path), bytes: ultimo.bytes, criadoEm: ultimo.createdAt, motivo: ultimo.motivo } : null,
    },
    remoto: { configurado, bucket: configurado ? config.bucket : null },
    fotos: {
      arquivos: indice.arquivos,
      bytes: indice.bytes,
      ultimoConjunto: conjuntoDesteDestino
        ? {
            manifesto: conjuntoDesteDestino.manifesto,
            enviadoEm: conjuntoDesteDestino.enviadoEm,
            arquivos: conjuntoDesteDestino.arquivos,
            bytes: conjuntoDesteDestino.bytes,
          }
        : null,
    },
    bucket: conferencia,
    agenda: { hora, proxima: proximaExecucaoDoDiario(agora, hora).toISOString() },
    execucoes: listarExecucoes(10),
    falhas: falhasRecentes(agora),
  };
}

/** Falhas dos últimos 30 dias — o que a tela lista em "o que deu errado". */
export function falhasRecentes(agora: Date = new Date()): ExecucaoDoBackup[] {
  return falhasDesde(new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
}

// ------------------------------------------------------------ conferência

/**
 * Lê o bucket e confere o que o diário diz ter enviado.
 *
 *   - o último `.db` enviado com sucesso está lá, com o mesmo tamanho?
 *   - todas as fotos do último conjunto têm o objeto correspondente?
 *
 * Grava o resultado (é o que o item "Bucket conferido" mostra) e o devolve.
 * Nunca lança; falha de rede vira `ok: false` com o motivo.
 */
export async function conferirBucket(opts: OpcoesDoBucket = {}): Promise<ConferenciaDoBucket> {
  const config = opts.config ?? remoteBackupConfig();
  const conferidoEm = new Date().toISOString();
  const base: ConferenciaDoBucket = {
    conferidoEm,
    ok: false,
    motivo: null,
    bancos: 0,
    ultimoBanco: null,
    ultimoEnvioPresente: null,
    manifesto: null,
    fotosNoManifesto: null,
    objetosFaltando: null,
  };
  if (!remoteBackupConfigured(config)) {
    return { ...base, motivo: 'Cópia remota não configurada.' };
  }
  const o = { ...opts, config };
  const problemas: string[] = [];

  const raiz = await listarObjetos('', o);
  if (!raiz.ok) {
    const r = { ...base, motivo: raiz.motivo };
    gravarMetaJson(META_CONFERENCIA_DO_BUCKET, r);
    return r;
  }
  const bancos = raiz.itens.filter((i) => !i.pasta && i.nome.endsWith('.db')).sort((a, b) => b.nome.localeCompare(a.nome));
  const resultado: ConferenciaDoBucket = {
    ...base,
    bancos: bancos.length,
    ultimoBanco: bancos[0] ? { nome: bancos[0].nome, bytes: bancos[0].bytes, criadoEm: bancos[0].criadoEm } : null,
  };
  if (bancos.length === 0) problemas.push('nenhuma cópia do banco no bucket');

  const enviado = ultimoEnvioRemotoOk();
  if (enviado?.remoto.objeto) {
    const nome = enviado.remoto.objeto.startsWith(`${config.bucket}/`)
      ? enviado.remoto.objeto.slice(config.bucket.length + 1)
      : enviado.remoto.objeto;
    const achado = bancos.find((b) => b.nome === nome);
    resultado.ultimoEnvioPresente = Boolean(achado && (enviado.local.bytes === null || achado.bytes === enviado.local.bytes));
    if (!achado) problemas.push(`o último envio (${nome}) não está no bucket`);
    else if (!resultado.ultimoEnvioPresente) problemas.push(`o último envio (${nome}) está lá com outro tamanho`);
  }

  const conjunto = lerMetaJson<UltimoConjuntoEnviado>(META_ULTIMO_CONJUNTO);
  if (conjunto && conjunto.destino === digitalDoDestino(config)) {
    resultado.manifesto = conjunto.manifesto;
    const m = await baixarObjeto(conjunto.manifesto, o);
    if (!m.ok) {
      problemas.push(`o manifesto das fotos não abriu: ${m.motivo}`);
    } else {
      try {
        const manifesto = JSON.parse(m.conteudo.toString('utf8')) as { arquivos?: Array<{ sha256: string }> };
        const shas = new Set((manifesto.arquivos ?? []).map((a) => a.sha256));
        resultado.fotosNoManifesto = manifesto.arquivos?.length ?? 0;
        const objetos = await listarObjetos(PREFIXO_DOS_OBJETOS, o);
        if (!objetos.ok) {
          problemas.push(`não consegui listar as fotos: ${objetos.motivo}`);
        } else {
          const presentes = new Set(objetos.itens.filter((i) => !i.pasta).map((i) => i.nome));
          resultado.objetosFaltando = [...shas].filter((s) => !presentes.has(s)).length;
          if (resultado.objetosFaltando > 0) problemas.push(`${resultado.objetosFaltando} foto(s) do último conjunto não estão no bucket`);
        }
      } catch {
        problemas.push('o manifesto das fotos não é um JSON válido');
      }
    }
  }

  resultado.ok = problemas.length === 0;
  resultado.motivo = problemas.length ? problemas.join('; ') : null;
  gravarMetaJson(META_CONFERENCIA_DO_BUCKET, resultado);
  return resultado;
}
