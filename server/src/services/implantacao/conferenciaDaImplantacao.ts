/**
 * ============================================================================
 * A CONFERÊNCIA DA IMPLANTAÇÃO — o roteiro de segunda-feira, item por item
 * ============================================================================
 *
 * GAP-PRD-013: a publicação (telas, HTTPS, supervisor, dados em disco
 * persistente) estava "inteiramente delegada ao dono, sem exemplo". GAP-PRD-151:
 * nesta máquina o `.env` ligava o atalho sem senha (hoje removido) e não
 * declarava `DEVORA_API_ENV` — 184 entradas sem senha contra o banco do dono. GAP-PRD-153:
 * variáveis que nada lê, preenchidas por quem acha que configurou algo.
 *
 * Esta função olha a configuração e responde, para cada ponto da publicação,
 * um de quatro estados:
 *
 *   OK        conferido e certo;
 *   INFO      escolha legítima que não dá para conferir daqui (quem serve as
 *             telas quando não é a API, onde fica o banco fora de produção);
 *   ATENCAO   funciona, mas não é o que produção deve ser;
 *   BLOQUEIA  não vá ao ar assim — ou o servidor nem subiria.
 *
 * Roda em dois lugares, com o mesmo código:
 *
 *   - `scripts/conferir-implantacao` ANTES de subir (sai com 1 se algo
 *     bloqueia; o instalador do serviço o roda e para);
 *   - `GET /api/v1/system/implantacao` com a API no ar, que sabe o que o
 *     comando não sabe: se a página chegou por HTTPS, se há proxy na frente e
 *     se há um supervisor para levantar a API quando ela cair.
 *
 * NUNCA devolve valor de segredo. Diz QUAL variável está fraca, ausente ou
 * sem efeito — pelo nome.
 */
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chaveFraca, ensureDotEnvLoaded } from '../../config/env.js';
import {
  O_QUE_LIGAVA,
  VARIAVEIS_DO_ACESSO_SEM_SENHA,
  variaveisAposentadasNoAmbiente,
} from '../../config/acessoSemSenhaAposentado.js';
import {
  VARIAVEL_DA_SENHA_INICIAL,
  ambienteDeProducao,
  recusaDaSenhaInicial,
  situacaoDoAdministrador,
  type SituacaoDoAdministrador,
} from '../../db/administradorInicial.js';
import { getConnection, repoRoot, resolveDatabasePath } from '../../db/sqlite.js';
import {
  comMilhar,
  contarMunicipios,
  emitentesForaDaTabela,
  type EmitenteForaDaTabela,
} from '../core/MunicipiosIbge.js';

export type EstadoDoItem = 'OK' | 'INFO' | 'ATENCAO' | 'BLOQUEIA';

export interface ItemDaConferencia {
  id: string;
  titulo: string;
  estado: EstadoDoItem;
  detalhe: string;
  comoResolver?: string;
}

export interface ConferenciaDaImplantacao {
  conferidoEm: string;
  /** Nada bloqueia. ATENÇÃO não impede — é o que falta para ficar redondo. */
  pronto: boolean;
  resumo: Record<EstadoDoItem, number>;
  itens: ItemDaConferencia[];
}

export type QuemLevanta = 'supervisor' | 'systemd' | 'container' | null;

export interface ContextoDaConferencia {
  env: Record<string, string | undefined>;
  /** Raiz da instalação (onde está `out/`, `server/`, `.env`). */
  raiz: string;
  existe: (caminho: string) => boolean;
  emContainer: boolean;
  /**
   * Os nomes de uma pasta (só o nome, sem ler conteúdo). Opcional: sem ele a
   * conferência não procura sobra do sistema anterior (GAP-PRD-154).
   */
  listar?: (pasta: string) => string[];
  /**
   * Quantos municípios do IBGE há na tabela (IBGE-MUNICIPIOS); `null` = não
   * deu para contar (o banco ainda não existe). Opcional: sem ele o item diz
   * que não dá para saber daqui.
   */
  municipiosDoIbge?: () => number | null;
  /**
   * Os emitentes cujo município a tabela desmente (R3-IBGE); `null` = nada a
   * conferir (tabela vazia, nenhum emitente com código, banco que não abriu).
   * Opcional: sem ele o item não aparece.
   */
  emitentesForaDaTabela?: () => { conferidos: number; fora: EmitenteForaDaTabela[] } | null;
  /**
   * Quem administra o grupo e se o login `admin` está ocupado (bootstrap);
   * `null` = o banco ainda não existe (ou não abriu). Opcional: sem ele o item
   * "Administrador inicial" não aparece.
   */
  administradorInicial?: () => SituacaoDoAdministrador | null;
  /** Presente quando a conferência roda DENTRO da API; ausente no comando. */
  processo?: {
    supervisionado: QuemLevanta;
    protocolo: string;
    encaminhadoComo?: string | null;
  } | null;
}

/** As pastas que a imagem Docker declara como VOLUME (ver Dockerfile). */
const VOLUMES_DA_IMAGEM = ['/app/server/data', '/app/backups'];

/**
 * Variáveis que NADA no servidor lê. Preenchê-las não liga nada — e quem
 * preenche acha que ligou. Credencial de transportadora, CSC e chave do Asaas
 * entram pela tela (Central de Integrações, Fiscal), que guarda no cofre.
 */
export const VARIAVEIS_SEM_EFEITO: Array<[string, string]> = [
  ['DEVORA_PUBLIC_BASE_URL', 'nunca teve leitor; o QR da plaquinha usa GRUPO_SAMPAIO_PUBLIC_URL'],
  ['DEVORA_SESSION_BRIDGE_TOKEN', 'removida: o login exige senha sempre'],
  ['DEVORA_STORAGE_PATH', 'sem leitor; as fotos usam DEVORA_UPLOADS_DIR'],
  ['DEVORA_METRICS_ENABLED', 'sem leitor'],
  ['DEVORA_SENTRY_DSN', 'sem leitor'],
  ['SUPABASE_URL', 'nome antigo; vale DEVORA_SUPABASE_URL'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'nome antigo; vale DEVORA_SUPABASE_SERVICE_KEY'],
  ['NFCE_TEST_CSC_ID', 'só a suíte de homologação lê; o CSC de verdade entra em Fiscal'],
  ['NFCE_TEST_CSC_TOKEN', 'só a suíte de homologação lê; o CSC de verdade entra em Fiscal'],
  ['LOGISTICS_MELHOR_ENVIO_TOKEN', 'só a suíte lê; a credencial entra pela Central de Integrações'],
  ['LOGISTICS_JADLOG_TOKEN', 'nada lê; a credencial entra pela Central de Integrações'],
  ['LOGISTICS_CORREIOS_USERNAME', 'nada lê; a credencial entra pela Central de Integrações'],
  ['LOGISTICS_CORREIOS_PASSWORD', 'nada lê; a credencial entra pela Central de Integrações'],
  ['ASAAS_SANDBOX_TESTS', 'só a suíte lê'],
  // As do acesso sem senha têm item próprio ("Variável aposentada presente"),
  // porque ligadas em produção a API nem sobe; aqui entram para a varredura
  // `nome-aposentado-nao-volta` cobrar que nenhum código as leia.
  ...VARIAVEIS_DO_ACESSO_SEM_SENHA.map((nome): [string, string] => [nome, `aposentada: ${O_QUE_LIGAVA[nome]}`]),
];

// As do acesso sem senha têm item próprio ("Variável aposentada presente"); não repetem aqui.
const DO_ACESSO_SEM_SENHA = new Set<string>(VARIAVEIS_DO_ACESSO_SEM_SENHA);

/**
 * Lidas SÓ pelo seed de desenvolvimento (`db:seed:dev`), que recusa produção e
 * homologação. Até esta versão o exemplo de produção mandava preenchê-las para
 * o `db:seed`; lá elas não fazem mais nada — o `db:seed` é o bootstrap, e a
 * única senha que ele usa é a do administrador inicial.
 */
const SO_DA_BANCADA: Array<[string, string]> = [
  ['GRUPO_SAMPAIO_MANAGEMENT_PASSWORD', 'só o seed de desenvolvimento lê; o db:seed de produção cria apenas o admin, com DEVORA_BOOTSTRAP_ADMIN_PASSWORD'],
  ['GRUPO_SAMPAIO_OPERATION_PASSWORD', 'só o seed de desenvolvimento lê; as contas de PDV e oficina nascem pela tela Usuários e equipe'],
];

const NIVEIS_DE_LOG = ['debug', 'info', 'warn', 'error'];

function limpo(v: string | undefined): string {
  return (v ?? '').trim();
}

/** A letra do disco de um caminho do Windows (`C`), ou `null` fora dele. */
function letraDoDisco(caminho: string): string | null {
  const m = /^([A-Za-z]):[\\/]/.exec(caminho);
  return m ? m[1].toUpperCase() : null;
}

function dentroDe(caminho: string, pasta: string): boolean {
  const p = posix.normalize(caminho.split('\\').join('/'));
  const base = posix.normalize(pasta).replace(/\/+$/, '');
  return p === base || p.startsWith(`${base}/`);
}

function ehLocal(origem: string): boolean {
  try {
    const { hostname } = new URL(origem);
    return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(hostname);
  } catch {
    return false;
  }
}

export function conferirImplantacao(ctx: ContextoDaConferencia): ConferenciaDaImplantacao {
  const env = ctx.env;
  const itens: ItemDaConferencia[] = [];
  const ambiente = limpo(env.DEVORA_API_ENV) || 'development';
  const producao = ambiente === 'production';
  const servirFrontend = limpo(env.DEVORA_SERVIR_FRONTEND) === 'true';
  const confiancaNoProxy = Number.parseInt(limpo(env.DEVORA_TRUST_PROXY) || '0', 10) || 0;
  const origens = limpo(env.DEVORA_FRONTEND_ORIGIN || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const todasHttps = origens.length > 0 && origens.every((o) => o.startsWith('https://'));

  // ── Ambiente ────────────────────────────────────────────────────────────
  if (producao) {
    itens.push({ id: 'ambiente', titulo: 'Ambiente', estado: 'OK', detalhe: 'DEVORA_API_ENV=production.' });
  } else if (ambiente === 'staging') {
    itens.push({
      id: 'ambiente',
      titulo: 'Ambiente',
      estado: 'ATENCAO',
      detalhe:
        'Homologação (DEVORA_API_ENV=staging): as travas de produção valem, as integrações não '
        + 'vão para produção. O atalho do .env no Asaas (chave de sandbox e token de webhook) '
        + 'CONTINUA valendo — só `production` o fecha.',
      comoResolver: 'Para ir ao ar de verdade, DEVORA_API_ENV=production.',
    });
  } else {
    /*
      O QUE ESTE ITEM NÃO DIZIA. "Integrações se comportam como bancada" é
      verdade e é vago demais para quem vai abrir a loja. As duas consequências
      com nome: fora de produção, `asaasEnvFallbackAllowed()` deixa a chave de
      sandbox e o token de webhook do `.env` valerem COMO SE fossem da operação
      (a tela do Asaas mostra "configurada" com a dica de uma chave que não é
      dela, e a homologação pode ser aprovada contra essa conta), e
      `mockProviderBlocked()` aceita o provedor de teste da maquininha, que
      aprova cartão sem dinheiro trocar de mãos.
    */
    itens.push({
      id: 'ambiente',
      titulo: 'Ambiente',
      estado: 'BLOQUEIA',
      detalhe:
        `A API está em ${ambiente}${limpo(env.DEVORA_API_ENV) ? '' : ' (DEVORA_API_ENV ausente — o padrão é development)'}. `
        + 'Integrações, base fiscal e log se comportam como bancada: a chave de sandbox e o token '
        + 'de webhook do .env valem como credencial da operação no Asaas, e o provedor de TESTE '
        + 'da maquininha é aceito (ele aprova cartão sem dinheiro trocar de mãos).',
      comoResolver:
        'Declare DEVORA_API_ENV=production (e NODE_ENV=production) no .env do servidor e '
        + 'reinicie a API.',
    });
  }

  itens.push(
    limpo(env.NODE_ENV) === 'production'
      ? { id: 'node_env', titulo: 'NODE_ENV', estado: 'OK', detalhe: 'NODE_ENV=production.' }
      : {
          id: 'node_env',
          titulo: 'NODE_ENV',
          estado: producao ? 'ATENCAO' : 'INFO',
          detalhe: `NODE_ENV=${limpo(env.NODE_ENV) || '(ausente)'}.`,
          comoResolver:
            'Declare também NODE_ENV=production: as travas valem pelos dois nomes, e bibliotecas '
            + 'de terceiros só se comportam como produção por ele.',
        },
  );

  // ── Variável aposentada do acesso sem senha (GAP-PRD-151) ───────────────
  // O acesso sem senha saiu do sistema: nenhuma destas liga nada. Ligada, a
  // API recusa subir em produção e homologação — BLOQUEIA em qualquer
  // ambiente, porque é a linha que alguém ligou para "entrar sem senha" e
  // precisa sair antes da publicação. Escrita com outro valor: ATENÇÃO — não
  // liga nada, mas quem lê o .env acha que existe uma porta.
  const aposentadas = variaveisAposentadasNoAmbiente(env);
  const ligadas = aposentadas.filter((v) => v.ligada).map((v) => v.nome);
  const escritas = aposentadas.filter((v) => !v.ligada).map((v) => v.nome);
  const tirar = `Apague ${aposentadas.length > 1 ? 'as linhas' : 'a linha'} ${aposentadas.map((v) => v.nome).join(', ')} `
    + 'do .env (ou do ambiente do serviço) e reinicie.';
  if (ligadas.length > 0) {
    itens.push({
      id: 'variavel_aposentada',
      titulo: 'Variável aposentada presente',
      estado: 'BLOQUEIA',
      detalhe:
        `${ligadas.join(', ')} ${ligadas.length > 1 ? 'ligadas' : 'ligada'}: o acesso sem senha foi removido e `
        + 'nada lê a variável, mas em produção e homologação a API recusa subir com ela ligada.'
        + (escritas.length > 0 ? ` Também no ambiente, sem efeito: ${escritas.join(', ')}.` : ''),
      comoResolver: tirar,
    });
  } else if (escritas.length > 0) {
    itens.push({
      id: 'variavel_aposentada',
      titulo: 'Variável aposentada presente',
      estado: 'ATENCAO',
      detalhe:
        `${escritas.join(', ')} no ambiente: o acesso sem senha foi removido e ela não liga nada — mas quem `
        + 'lê o .env conclui que existe uma porta sem senha para ligar.',
      comoResolver: tirar,
    });
  } else {
    itens.push({ id: 'variavel_aposentada', titulo: 'Variável aposentada presente', estado: 'OK', detalhe: 'Nenhuma.' });
  }

  // ── Chaves ──────────────────────────────────────────────────────────────
  const fracas = [
    chaveFraca(env.DEVORA_JWT_SECRET, 16) ? 'DEVORA_JWT_SECRET' : null,
    chaveFraca(env.DEVORA_ENCRYPTION_KEY, 24) ? 'DEVORA_ENCRYPTION_KEY' : null,
  ].filter((x): x is string => x !== null);
  itens.push(
    fracas.length === 0
      ? { id: 'chaves', titulo: 'Chaves do servidor', estado: 'OK', detalhe: 'As duas são próprias e longas.' }
      : {
          id: 'chaves',
          titulo: 'Chaves do servidor',
          estado: producao || ambiente === 'staging' ? 'BLOQUEIA' : 'ATENCAO',
          detalhe:
            `${fracas.join(' e ')}: ausente, curta, sem entropia ou igual a um valor escrito no repositório. `
            + 'Em produção e homologação a API recusa subir.',
          comoResolver:
            'Gere na própria máquina: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))". '
            + 'Trocar a DEVORA_ENCRYPTION_KEY de uma instalação que já selou segredos exige o script de rotação.',
        },
  );

  // ── Administrador inicial (bootstrap) ───────────────────────────────────
  if (ctx.administradorInicial) {
    itens.push(itemDoAdministradorInicial(ctx.administradorInicial(), env));
  }

  // ── Origem das telas (CORS) ─────────────────────────────────────────────
  const soLocal = origens.every(ehLocal);
  if (soLocal && !servirFrontend) {
    itens.push({
      id: 'origem_do_frontend',
      titulo: 'Origem das telas (CORS)',
      estado: producao ? 'BLOQUEIA' : 'INFO',
      detalhe: `DEVORA_FRONTEND_ORIGIN só tem endereços desta máquina (${origens.join(', ')}). Em produção o CORS é estrito: um navegador de fora não carrega tela nenhuma.`,
      comoResolver: 'Preencha DEVORA_FRONTEND_ORIGIN com o endereço real (https://erp.seudominio.com.br), ou faça a API servir as telas (DEVORA_SERVIR_FRONTEND=true).',
    });
  } else {
    itens.push({
      id: 'origem_do_frontend',
      titulo: 'Origem das telas (CORS)',
      estado: 'OK',
      detalhe: servirFrontend && soLocal
        ? 'A API serve as telas na própria origem; o CORS não entra no caminho.'
        : `Origens aceitas: ${origens.join(', ')}.`,
    });
  }

  // ── HTTPS ───────────────────────────────────────────────────────────────
  const proc = ctx.processo;
  if (proc) {
    if (proc.protocolo === 'https') {
      itens.push({ id: 'https', titulo: 'HTTPS', estado: 'OK', detalhe: 'Esta página chegou por HTTPS.' });
    } else if (limpo(proc.encaminhadoComo ?? '') === 'https') {
      itens.push({
        id: 'https',
        titulo: 'HTTPS',
        estado: 'ATENCAO',
        detalhe: 'O proxy da frente fala HTTPS, mas a API não confia nele e acha que a conexão é HTTP.',
        comoResolver: 'Declare DEVORA_TRUST_PROXY=1 (um proxy na frente) e reinicie a API.',
      });
    } else {
      itens.push({
        id: 'https',
        titulo: 'HTTPS',
        estado: 'ATENCAO',
        detalhe: 'Esta página chegou por HTTP: senha e token trafegam abertos na rede.',
        comoResolver: 'Termine o HTTPS num proxy na frente da API — o Caddy de deploy/caddy/Caddyfile.example tira o certificado sozinho.',
      });
    }
  } else {
    itens.push(
      todasHttps
        ? { id: 'https', titulo: 'HTTPS', estado: 'OK', detalhe: 'As origens das telas são https://.' }
        : {
            id: 'https',
            titulo: 'HTTPS',
            estado: producao ? 'ATENCAO' : 'INFO',
            detalhe: `Nenhuma origem https:// em DEVORA_FRONTEND_ORIGIN (${origens.join(', ')}).`,
            comoResolver: 'Termine o HTTPS num proxy na frente da API — ver deploy/caddy/Caddyfile.example.',
          },
    );
  }

  // ── Proxy confiável ─────────────────────────────────────────────────────
  const haProxy = Boolean(limpo(proc?.encaminhadoComo ?? '')) || (!proc && todasHttps);
  itens.push(
    haProxy && confiancaNoProxy === 0
      ? {
          id: 'proxy',
          titulo: 'Proxy na frente',
          estado: 'ATENCAO',
          detalhe: proc
            ? 'Há um proxy na frente (X-Forwarded-Proto chegou) e DEVORA_TRUST_PROXY=0: o limite de taxa e o controle de força bruta contam todos os clientes como um só.'
            : 'As origens são https:// — há um proxy na frente — e DEVORA_TRUST_PROXY=0.',
          comoResolver: 'Declare DEVORA_TRUST_PROXY=1 (o número de proxies confiáveis na frente).',
        }
      : {
          id: 'proxy',
          titulo: 'Proxy na frente',
          estado: 'OK',
          detalhe: confiancaNoProxy > 0 ? `DEVORA_TRUST_PROXY=${confiancaNoProxy}.` : 'Servido direto (DEVORA_TRUST_PROXY=0).',
        },
  );

  // ── Quem serve as telas ─────────────────────────────────────────────────
  if (servirFrontend) {
    const pasta = limpo(env.DEVORA_FRONTEND_DIR)
      ? (isAbsolute(limpo(env.DEVORA_FRONTEND_DIR)) ? limpo(env.DEVORA_FRONTEND_DIR) : resolve(ctx.raiz, limpo(env.DEVORA_FRONTEND_DIR)))
      : resolve(ctx.raiz, 'out');
    const indice = join(pasta, 'index.html');
    itens.push(
      ctx.existe(indice)
        ? { id: 'frontend', titulo: 'Telas', estado: 'OK', detalhe: `A API serve as telas de ${pasta}, com fallback de SPA.` }
        : {
            id: 'frontend',
            titulo: 'Telas',
            estado: 'BLOQUEIA',
            detalhe: `DEVORA_SERVIR_FRONTEND=true e não existe ${indice}: a API recusa subir.`,
            comoResolver: 'Rode `npm run build:frontend` com VITE_API_BASE_URL=/ (mesma origem).',
          },
    );
  } else {
    itens.push({
      id: 'frontend',
      titulo: 'Telas',
      estado: 'INFO',
      detalhe:
        'A API não serve as telas: o host da frente (nginx/Caddy com try_files, ou CDN) serve o out/ com '
        + 'fallback de SPA e encaminha /api/v1 e /uploads para a API.',
      comoResolver: 'Exemplos prontos em deploy/nginx e deploy/caddy — ou DEVORA_SERVIR_FRONTEND=true.',
    });
  }

  // ── Dados: banco, fotos, backup ─────────────────────────────────────────
  const bancoBruto = limpo(env.DEVORA_DATABASE_PATH) || './server/data/grupo-sampaio.db';
  const bancoTroca = bancoBruto.replace(/\.json$/i, '.db');
  const banco = isAbsolute(bancoTroca) || /^[A-Za-z]:[\\/]/.test(bancoTroca) ? bancoTroca : resolve(ctx.raiz, bancoTroca);
  if (ctx.emContainer && !dentroDe(banco, VOLUMES_DA_IMAGEM[0])) {
    itens.push({
      id: 'banco',
      titulo: 'Banco',
      estado: 'BLOQUEIA',
      detalhe: `O banco está em ${banco}, fora do volume ${VOLUMES_DA_IMAGEM[0]}: some ao recriar o container.`,
      comoResolver: `DEVORA_DATABASE_PATH=${VOLUMES_DA_IMAGEM[0]}/grupo-sampaio.db (é o padrão da imagem).`,
    });
  } else if (!limpo(env.DEVORA_DATABASE_PATH)) {
    itens.push({
      id: 'banco',
      titulo: 'Banco',
      estado: producao ? 'ATENCAO' : 'INFO',
      detalhe: `Caminho padrão, dentro da pasta do sistema: ${banco}.`,
      comoResolver: 'Aponte DEVORA_DATABASE_PATH para o disco definitivo (caminho absoluto).',
    });
  } else {
    itens.push({ id: 'banco', titulo: 'Banco', estado: 'OK', detalhe: banco });
  }

  const fotos = limpo(env.DEVORA_UPLOADS_DIR) || join(ctx.raiz, 'data', 'uploads');
  if (ctx.emContainer && !dentroDe(fotos, VOLUMES_DA_IMAGEM[0])) {
    itens.push({
      id: 'fotos',
      titulo: 'Fotos enviadas',
      estado: 'BLOQUEIA',
      detalhe: `As fotos de produto, de loja e de OS vão para ${fotos.split('\\').join('/')}, fora do volume: somem ao recriar o container, e o banco continua apontando para elas.`,
      comoResolver: `DEVORA_UPLOADS_DIR=${VOLUMES_DA_IMAGEM[0]}/uploads (é o padrão da imagem).`,
    });
  } else {
    itens.push({
      id: 'fotos',
      titulo: 'Fotos enviadas',
      estado: limpo(env.DEVORA_UPLOADS_DIR) ? 'OK' : 'INFO',
      detalhe: `${fotos}${ctx.existe(fotos) ? '' : ' (a pasta nasce no primeiro envio)'}.`,
      comoResolver: limpo(env.DEVORA_UPLOADS_DIR)
        ? undefined
        : 'Caminho histórico. Mudar DEVORA_UPLOADS_DIR depois exige MOVER os arquivos junto.',
    });
  }

  const backup = limpo(env.DEVORA_BACKUP_DIR);
  if (!backup) {
    itens.push({
      id: 'backup',
      titulo: 'Destino do backup',
      estado: producao ? 'ATENCAO' : 'INFO',
      detalhe: 'DEVORA_BACKUP_DIR vazio: o backup diário fica na pasta vizinha do banco. Disco morre, morrem os dois.',
      comoResolver: 'Aponte DEVORA_BACKUP_DIR para outro disco, pen drive ou pasta sincronizada.',
    });
  } else if (ctx.emContainer && !VOLUMES_DA_IMAGEM.some((v) => dentroDe(backup, v))) {
    itens.push({
      id: 'backup',
      titulo: 'Destino do backup',
      estado: 'ATENCAO',
      detalhe: `${backup} está fora dos volumes da imagem: some ao recriar o container.`,
      comoResolver: 'DEVORA_BACKUP_DIR=/app/backups (volume próprio, é o padrão da imagem).',
    });
  } else if (letraDoDisco(backup) && letraDoDisco(backup) === letraDoDisco(banco)) {
    /*
      PREENCHIDA NÃO É SEPARADA (GAP-PRD-068). `DEVORA_BACKUP_DIR=C:/backups`
      com o banco em `C:/...` passava como OK — e é o mesmo disco. A tela
      Configurações › Backup confere pelo volume de verdade com a API no ar;
      aqui, antes de subir, a letra já basta para não dizer OK.
    */
    itens.push({
      id: 'backup',
      titulo: 'Destino do backup',
      estado: producao ? 'ATENCAO' : 'INFO',
      detalhe: `${backup} está no mesmo disco (${letraDoDisco(backup)}:) que o banco. Disco morre, morrem os dois.`,
      comoResolver: 'Aponte DEVORA_BACKUP_DIR para outro disco, pen drive ou volume.',
    });
  } else {
    itens.push({ id: 'backup', titulo: 'Destino do backup', estado: 'OK', detalhe: backup });
  }

  // ── Quem levanta a API ──────────────────────────────────────────────────
  if (!proc) {
    itens.push({
      id: 'supervisor',
      titulo: 'Quem levanta a API se ela cair',
      estado: 'INFO',
      detalhe: 'Não dá para saber daqui. Com a API no ar, a tela Configurações › Implantação diz.',
      comoResolver: 'Windows: deploy/windows/instalar-servico.ps1. Linux: deploy/linux. Docker: restart do compose.',
    });
  } else if (proc.supervisionado) {
    const quem = { supervisor: 'o supervisor do sistema (tarefa do Windows)', systemd: 'o systemd', container: 'o Docker (restart do compose)' }[proc.supervisionado];
    itens.push({ id: 'supervisor', titulo: 'Quem levanta a API se ela cair', estado: 'OK', detalhe: `Sob ${quem}.` });
  } else {
    itens.push({
      id: 'supervisor',
      titulo: 'Quem levanta a API se ela cair',
      estado: producao ? 'ATENCAO' : 'INFO',
      detalhe: 'Ninguém: a API foi aberta à mão. Uma queda para as seis empresas até alguém subir de novo.',
      comoResolver: 'Windows: rode deploy/windows/instalar-servico.ps1 como administrador. Linux: deploy/linux/grupo-sampaio-api.service.',
    });
  }

  // ── Registro (log) ──────────────────────────────────────────────────────
  const nivel = limpo(env.LOG_LEVEL) || 'info';
  const ondeFicaOLog = proc?.supervisionado === 'supervisor'
    ? ` Arquivos por dia em ${limpo(env.DEVORA_LOG_DIR) || join(ctx.raiz, 'server', 'data', 'logs')}.`
    : '';
  if (!NIVEIS_DE_LOG.includes(nivel)) {
    itens.push({
      id: 'registro',
      titulo: 'Registro (log)',
      estado: 'BLOQUEIA',
      detalhe: `LOG_LEVEL=${nivel} não existe: a API recusa subir.`,
      comoResolver: `Use um de: ${NIVEIS_DE_LOG.join(', ')}.`,
    });
  } else if (nivel === 'debug' && producao) {
    itens.push({
      id: 'registro',
      titulo: 'Registro (log)',
      estado: 'ATENCAO',
      detalhe: `LOG_LEVEL=debug em produção: o log cresce rápido.${ondeFicaOLog}`,
      comoResolver: 'LOG_LEVEL=info.',
    });
  } else {
    itens.push({ id: 'registro', titulo: 'Registro (log)', estado: 'OK', detalhe: `LOG_LEVEL=${nivel}.${ondeFicaOLog}` });
  }

  // ── Sobras do sistema anterior na pasta da instalação (GAP-PRD-154) ─────
  if (ctx.listar) {
    const achados = sobrasDoLegado(ctx.raiz, ctx.listar);
    itens.push(
      achados.length === 0
        ? { id: 'artefatos_legados', titulo: 'Sobras do sistema anterior', estado: 'OK', detalhe: 'Nenhuma.' }
        : {
            id: 'artefatos_legados',
            titulo: 'Sobras do sistema anterior',
            estado: 'ATENCAO',
            detalhe: achados.map((a) => `${a.caminho} (${a.porque})`).join('; ') + '.',
            comoResolver:
              'Cópia de .env carrega os mesmos segredos do .env: guarde-a no cofre de senhas, fora da pasta '
              + 'da instalação (que é copiada, compartilhada e vai para backup), e apague a daqui. O banco '
              + '.json e os backups .json são do sistema anterior: nenhum comando os lê nem restaura — '
              + 'confira que não há nada que falte e apague.',
          },
    );
  }

  // ── Variáveis sem efeito (GAP-PRD-153) ──────────────────────────────────
  const semEfeitoAqui = producao || ambiente === 'staging' ? [...VARIAVEIS_SEM_EFEITO, ...SO_DA_BANCADA] : VARIAVEIS_SEM_EFEITO;
  const presentes = semEfeitoAqui.filter(
    ([nome]) => !DO_ACESSO_SEM_SENHA.has(nome) && limpo(env[nome]) !== '',
  );
  itens.push(
    presentes.length === 0
      ? { id: 'variaveis_sem_efeito', titulo: 'Variáveis sem efeito', estado: 'OK', detalhe: 'Nenhuma.' }
      : {
          id: 'variaveis_sem_efeito',
          titulo: 'Variáveis sem efeito',
          estado: 'ATENCAO',
          detalhe: presentes.map(([nome, porque]) => `${nome} (${porque})`).join('; ') + '.',
          comoResolver:
            'Tire do .env: preenchê-las não liga nada. Credenciais de transportadora, CSC e Asaas entram '
            + 'pela tela (Central de Integrações e Fiscal), que as guarda no cofre.',
        },
  );

  // ── Tabela de municípios do IBGE (IBGE-MUNICIPIOS) ──────────────────────
  // Não bloqueia: vazia, o cliente digita o código como sempre digitou. Mas
  // é o que tira da compra a pergunta "qual é o código IBGE da sua cidade?".
  const municipios = ctx.municipiosDoIbge ? ctx.municipiosDoIbge() : null;
  const comoCarregarMunicipios =
    'Rode uma vez, no servidor: node server/dist/scripts/carregar-municipios-ibge.js --baixar (busca a lista '
    + 'oficial em servicodados.ibge.gov.br). Servidor sem internet: baixe '
    + 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios noutra máquina e rode com '
    + '--arquivo <municipios.json>. Na bancada: npm run ibge:municipios -- --baixar.';
  if (municipios !== null && municipios > 0) {
    itens.push({
      id: 'municipios_ibge',
      titulo: 'Tabela de municípios do IBGE',
      estado: 'OK',
      detalhe:
        `Pronta: ${comMilhar(municipios)} municípios carregados. O endereço da loja e o cadastro fiscal `
        + 'escolhem a cidade pelo nome e o código IBGE vem junto; o servidor confere que ele existe e é da UF.',
    });
  } else if (municipios === 0) {
    itens.push({
      id: 'municipios_ibge',
      titulo: 'Tabela de municípios do IBGE',
      estado: 'ATENCAO',
      detalhe:
        'Pendente: a tabela está vazia. Até ela ser carregada, o cliente da loja e o cadastro fiscal digitam o '
        + 'código IBGE do município à mão (só o formato é conferido) — e o cliente não sabe o que é isso.',
      comoResolver: comoCarregarMunicipios,
    });
  } else {
    itens.push({
      id: 'municipios_ibge',
      titulo: 'Tabela de municípios do IBGE',
      estado: 'INFO',
      detalhe: 'Não dá para contar daqui: o banco ainda não existe (ou não abriu). Confira de novo depois da primeira subida.',
      comoResolver: comoCarregarMunicipios,
    });
  }

  // ── O município do emitente na tabela (R3-IBGE) ─────────────────────────
  // Só aparece com a tabela carregada e algum emitente com código. ATENÇÃO, e
  // não BLOQUEIA: o conserto é pela tela (Fiscal › Emitente), com a API no ar
  // — travar a subida deixaria o dono sem a tela que corrige. E a nota já não
  // sai com o código errado: o checklist fiscal barra a montagem antes de
  // numerar.
  const emitentes = ctx.emitentesForaDaTabela ? ctx.emitentesForaDaTabela() : null;
  if (emitentes && emitentes.fora.length === 0) {
    itens.push({
      id: 'municipio_do_emitente',
      titulo: 'Município do emitente na tabela do IBGE',
      estado: 'OK',
      detalhe:
        emitentes.conferidos === 1
          ? 'O código IBGE do emitente confere com a tabela oficial: existe, é da UF e é da cidade do cadastro.'
          : `O código IBGE dos ${emitentes.conferidos} emitentes confere com a tabela oficial: existe, é da UF `
            + 'e é da cidade do cadastro.',
    });
  } else if (emitentes) {
    itens.push({
      id: 'municipio_do_emitente',
      titulo: 'Município do emitente na tabela do IBGE',
      estado: 'ATENCAO',
      detalhe:
        `${emitentes.fora.map((e) => `${e.empresa}: ${e.motivo}`).join('; ')}. Até ser corrigido, o checklist `
        + 'fiscal barra a NF-e, a NFC-e e a NFS-e dessa operação antes de numerar — com esse código, a SEFAZ '
        + 'recusaria cada nota (ou a aceitaria com o município errado).',
      comoResolver:
        'Em Fiscal › Emitente da operação, escolha a UF e o município na lista (o código IBGE vem junto) e '
        + 'salve. É pela tela, com a API no ar — por isso este item não impede a subida.',
    });
  }

  const resumo: Record<EstadoDoItem, number> = { OK: 0, INFO: 0, ATENCAO: 0, BLOQUEIA: 0 };
  for (const i of itens) resumo[i.estado] += 1;
  return { conferidoEm: new Date().toISOString(), pronto: resumo.BLOQUEIA === 0, resumo, itens };
}

/**
 * O ADMINISTRADOR INICIAL (bootstrap de produção, `db/bootstrap.ts`).
 *
 * BLOQUEIA quando ninguém vai conseguir administrar: ninguém administra o
 * grupo e a variável não está definida (ou a subida a recusaria), ou o login
 * `admin` está ocupado por quem não administra — o bootstrap nunca cria um
 * segundo 'admin' nem mexe em conta existente. A variável é lida só para
 * saber se está definida e se passaria na régua: o valor nunca entra no texto.
 */
function itemDoAdministradorInicial(
  situacao: SituacaoDoAdministrador | null,
  env: Record<string, string | undefined>,
): ItemDaConferencia {
  const base = { id: 'administrador_inicial', titulo: 'Administrador inicial' };
  const variavel = VARIAVEL_DA_SENHA_INICIAL;
  const valor = env[variavel] ?? '';
  const definida = valor.trim() !== '';
  const comoCriar =
    `Defina ${variavel} no .env do servidor (ao menos 8 caracteres, própria desta instalação) e suba a API — ou, `
    + 'com ela parada, rode npm run db:bootstrap --prefix server (no servidor: node server/dist/db/bootstrap-cli.js). '
    + "Entre como 'admin', troque a senha no primeiro acesso (a troca é obrigatória) e depois apague a variável do .env.";

  if (situacao && situacao.administradoresDoGrupo > 0) {
    const quantos =
      situacao.administradoresDoGrupo === 1
        ? 'Uma conta administra o grupo (administrador em todas as empresas ativas)'
        : `${situacao.administradoresDoGrupo} contas administram o grupo (administrador em todas as empresas ativas)`;
    return definida
      ? {
          ...base,
          estado: 'ATENCAO',
          detalhe:
            `${quantos}, e ${variavel} continua no ambiente sem efeito: ela nunca altera conta existente, `
            + 'mas é uma senha guardada em texto.',
          comoResolver:
            `Depois que o 'admin' trocou a senha no primeiro acesso, apague ${variavel} do .env (e do ambiente `
            + 'do serviço) e reinicie a API.',
        }
      : { ...base, estado: 'OK', detalhe: `${quantos}.` };
  }

  if (situacao?.loginOcupado) {
    const login = situacao.loginOcupado;
    return {
      ...base,
      estado: 'BLOQUEIA',
      detalhe:
        `Nenhuma conta ativa administra o grupo, e o login '${login}' já existe: o bootstrap não cria 'admin' `
        + 'ao lado dele nem altera conta existente — ninguém consegue administrar.',
      comoResolver:
        `Com uma conta que ainda administre, em Pessoas › Usuários e equipe, reative '${login}' e dê a ela o perfil `
        + `de administrador em todas as empresas. Sem nenhuma conta assim, '${login}' precisa ser renomeada no banco `
        + `(API parada, backup antes) para o bootstrap criar 'admin' com ${variavel}.`,
    };
  }

  if (definida) {
    const recusa = recusaDaSenhaInicial(valor, ambienteDeProducao(env));
    if (recusa) {
      return { ...base, estado: 'BLOQUEIA', detalhe: `${recusa} A subida recusa e não cria a conta.`, comoResolver: comoCriar };
    }
    return {
      ...base,
      estado: 'INFO',
      detalhe:
        situacao === null
          ? `O banco ainda não existe: a primeira subida cria as seis empresas e a conta 'admin' com a senha de ${variavel}, provisória.`
          : `Ninguém administra o grupo ainda: a próxima subida (ou npm run db:bootstrap --prefix server) cria a conta 'admin' com a senha de ${variavel}, provisória.`,
      comoResolver: `Entre como 'admin', troque a senha no primeiro acesso e apague ${variavel} do .env.`,
    };
  }

  return {
    ...base,
    estado: 'BLOQUEIA',
    detalhe:
      situacao === null
        ? `O banco ainda não existe e ${variavel} não está definida: a primeira subida não cria conta nenhuma, e ninguém entra.`
        : `Nenhuma conta administra o grupo e ${variavel} não está definida: ninguém entra para administrar.`,
    comoResolver: comoCriar,
  };
}

/**
 * O que sobrou do sistema anterior na pasta da instalação, pelo NOME — nunca
 * se abre o arquivo (uma cópia de `.env` tem segredo, e o nome basta).
 *
 *   - `.env.bak*` / `.env.backup*` na raiz e em `server/`: cópia do `.env`
 *     feita antes de mexer nele, com as mesmas chaves;
 *   - `server/data/*.json`: o banco JSON do projeto anterior — o servidor
 *     abre o `.db` (um `DEVORA_DATABASE_PATH` terminado em .json é trocado);
 *   - `server/backups/*.json`: snapshots JSON do projeto anterior, num
 *     formato que nenhum comando restaura.
 */
export function sobrasDoLegado(
  raiz: string,
  listar: (pasta: string) => string[],
): Array<{ caminho: string; porque: string }> {
  const achados: Array<{ caminho: string; porque: string }> = [];
  const copiaDeEnv = /^\.env\.(bak|backup)([-_.].*)?$/i;
  for (const [sub, prefixo] of [['', ''], ['server', 'server/']] as const) {
    for (const nome of listar(sub ? join(raiz, sub) : raiz)) {
      if (copiaDeEnv.test(nome)) achados.push({ caminho: `${prefixo}${nome}`, porque: 'cópia do .env, com segredos' });
    }
  }
  for (const nome of listar(join(raiz, 'server', 'data'))) {
    if (/\.json$/i.test(nome)) achados.push({ caminho: `server/data/${nome}`, porque: 'banco JSON do sistema anterior' });
  }
  const antigos = listar(join(raiz, 'server', 'backups')).filter((n) => /\.json$/i.test(n));
  if (antigos.length > 0) {
    achados.push({
      caminho: 'server/backups',
      porque: `${antigos.length} backup(s) JSON do sistema anterior, que nenhum comando restaura`,
    });
  }
  return achados;
}

/** Quem levanta este processo se ele cair? Pelo que o ambiente denuncia. */
export function quemLevantaEsteProcesso(env: NodeJS.ProcessEnv, emContainer: boolean): QuemLevanta {
  if (env.DEVORA_SUPERVISIONADO === '1') return 'supervisor';
  if (env.INVOCATION_ID) return 'systemd';
  if (emContainer) return 'container';
  return null;
}

/** Com a API no ar: a tabela existe (o boot a cria). */
function municipiosNaApi(): number | null {
  try {
    return contarMunicipios(getConnection());
  } catch {
    return null;
  }
}

/**
 * Antes de subir: o arquivo do banco, se existe, aberto só para leitura. Um
 * banco que ainda não recebeu a tabela conta 0 (pendente); sem banco, `null`.
 */
function municipiosNoArquivoDoBanco(): number | null {
  const caminho = resolveDatabasePath();
  if (caminho === ':memory:' || !existsSync(caminho)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(caminho, { readOnly: true });
    return contarMunicipios(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Com a API no ar: os emitentes pela conexão dela (R3-IBGE). */
function emitentesNaApi(): { conferidos: number; fora: EmitenteForaDaTabela[] } | null {
  try {
    return emitentesForaDaTabela(getConnection());
  } catch {
    return null;
  }
}

/** Antes de subir: o arquivo do banco, se existe, aberto só para leitura. */
function emitentesNoArquivoDoBanco(): { conferidos: number; fora: EmitenteForaDaTabela[] } | null {
  const caminho = resolveDatabasePath();
  if (caminho === ':memory:' || !existsSync(caminho)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(caminho, { readOnly: true });
    return emitentesForaDaTabela(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Com a API no ar: quem administra, pela conexão dela (bootstrap). */
function administradorNaApi(): SituacaoDoAdministrador | null {
  try {
    return situacaoDoAdministrador(getConnection());
  } catch {
    return null;
  }
}

/** Antes de subir: o arquivo do banco, se existe, aberto só para leitura. */
function administradorNoArquivoDoBanco(): SituacaoDoAdministrador | null {
  const caminho = resolveDatabasePath();
  if (caminho === ':memory:' || !existsSync(caminho)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(caminho, { readOnly: true });
    return situacaoDoAdministrador(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function estaEmContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * O contexto real: o ambiente deste processo (com o `.env` já lido), a raiz
 * da instalação e o disco. `requisicao` vem da rota; o comando não tem.
 */
export function contextoDoProcesso(
  requisicao?: { protocolo: string; encaminhadoComo?: string | null },
): ContextoDaConferencia {
  ensureDotEnvLoaded();
  const emContainer = estaEmContainer();
  return {
    env: process.env,
    raiz: repoRoot(),
    existe: existsSync,
    listar: (pasta) => {
      try {
        return readdirSync(pasta);
      } catch {
        return [];
      }
    },
    emContainer,
    // Na API, a conexão dela; no comando (antes de subir), o arquivo do banco
    // aberto SÓ PARA LEITURA — a conferência nunca cria nem migra banco.
    municipiosDoIbge: requisicao ? municipiosNaApi : municipiosNoArquivoDoBanco,
    emitentesForaDaTabela: requisicao ? emitentesNaApi : emitentesNoArquivoDoBanco,
    administradorInicial: requisicao ? administradorNaApi : administradorNoArquivoDoBanco,
    processo: requisicao
      ? { supervisionado: quemLevantaEsteProcesso(process.env, emContainer), ...requisicao }
      : null,
  };
}
