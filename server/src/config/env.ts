import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { avisarVariaveisAposentadas, travaDoBoot } from './acessoSemSenhaAposentado.js';

/*
  A SUÍTE NÃO PODE DEPENDER DO `.env` DA MÁQUINA.

  Estes arquivos são lidos por `process.cwd()` e `../`, o que em teste
  alcança o `.env` de quem está desenvolvendo. Enquanto aquele arquivo
  estava incompleto ninguém percebeu — o caso "chave ausente em produção é
  recusada" passava porque a chave realmente não existia ali.

  No dia em que a chave foi gerada de verdade, o caso ficou vermelho sem
  que uma linha de código de produção mudasse: `loadDotEnvFiles` preenchia
  o que o teste tinha acabado de apagar. Um teste que muda de cor conforme
  a máquina não está testando o sistema.
*/
function arquivosDotEnv(): string[] {
  return [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')];
}

/** Os pares chave=valor de UM arquivo `.env`, na ordem em que aparecem. */
function lerArquivoDotEnv(filePath: string): Array<[string, string]> {
  const pares: Array<[string, string]> = [];
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    pares.push([key, value]);
  }
  return pares;
}

/**
 * O que o `.env` escreveu em `process.env` — chave e VALOR — e não o ambiente
 * do sistema. É a diferença que `lerVariaveisAoVivo` precisa para saber quem
 * manda em cada chave (ver lá). O valor entra junto porque quem reescreve
 * `process.env` depois (um supervisor, um teste) passa a mandar: a chave só
 * "é do arquivo" enquanto o processo ainda guarda o que o arquivo pôs lá.
 */
const valoresVindosDoArquivo = new Map<string, string>();

function loadDotEnvFiles(): void {
  if (process.env.DEVORA_IGNORE_DOTENV === 'true') return;
  for (const filePath of arquivosDotEnv()) {
    if (!existsSync(filePath)) continue;
    for (const [key, value] of lerArquivoDotEnv(filePath)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        valoresVindosDoArquivo.set(key, value);
      }
    }
  }
}

/**
 * Carrega os arquivos .env em `process.env` sem validar nem cachear o
 * ambiente inteiro. Usado pela camada SQLite, que só precisa do caminho do
 * banco — chamar `loadEnv()` ali congelaria o ambiente cedo demais.
 */
export function ensureDotEnvLoaded(): void {
  loadDotEnvFiles();
}

/**
 * ============================================================================
 * LER O `.env` AO VIVO — para as credenciais que o dono cola com o servidor no ar
 * ============================================================================
 *
 * ## O DEFEITO (GAP-PRD-065)
 *
 * `loadEnv()` memoriza na primeira leitura, e `loadDotEnvFiles` só escreve
 * chave AUSENTE. Os arquivos de exemplo trazem `EMAIL_SMTP_PASSWORD=` e
 * `DEVORA_SUPABASE_URL=` vazias — então a chave nasce presente e vazia, e
 * preencher o arquivo depois não muda nada até o próximo boot. O dono cola a
 * senha de aplicativo do SMTP, a tela continua dizendo "falta
 * EMAIL_SMTP_PASSWORD", e a leitura natural é "o sistema está quebrado" —
 * enquanto a recuperação de senha do cliente espera na fila.
 *
 * ## O QUE ESTA FUNÇÃO FAZ
 *
 * Relê os arquivos a CADA chamada e devolve o valor de hoje das chaves
 * pedidas, com a mesma precedência do boot:
 *
 *   - chave que veio do AMBIENTE DO SISTEMA (estava em `process.env` antes do
 *     `.env` ser lido) continua mandando — é o que o boot já fazia, e quem a
 *     pôs lá (systemd, docker, painel da hospedagem) espera que ela vença;
 *   - chave que veio do ARQUIVO, ou que ainda não existe, é lida do arquivo
 *     AGORA — preencheu, vale; apagou a linha, deixou de valer.
 *
 * ## O QUE ELA NÃO FAZ, de propósito
 *
 * Não escreve em `process.env`. Um refresh global mudaria no meio do dia
 * qualquer variável que alguém lê direto — e `getConnection` relê
 * `DEVORA_DATABASE_PATH` a cada chamada: editar o caminho do banco no `.env`
 * trocaria de banco com o servidor atendendo. Por isso a leitura ao vivo é
 * POR CHAVE, pedida por quem sabe que aquela chave pode mudar sem reinício
 * (hoje: `EMAIL_*` e a credencial da central).
 *
 * Com `DEVORA_IGNORE_DOTENV=true` (a suíte de testes) o arquivo não existe
 * para ninguém, e o valor é o de `process.env`.
 */
export function lerVariaveisAoVivo<K extends string>(
  chaves: readonly K[],
): Record<K, string | undefined> {
  const saida = {} as Record<K, string | undefined>;
  if (process.env.DEVORA_IGNORE_DOTENV === 'true') {
    for (const chave of chaves) saida[chave] = process.env[chave];
    return saida;
  }
  // Primeiro arquivo que declara a chave vence — a mesma ordem do boot.
  const doArquivo = new Map<string, string>();
  for (const filePath of arquivosDotEnv()) {
    if (!existsSync(filePath)) continue;
    for (const [key, value] of lerArquivoDotEnv(filePath)) {
      if (!doArquivo.has(key)) doArquivo.set(key, value);
    }
  }
  for (const chave of chaves) {
    const noProcesso = process.env[chave];
    const veioDoArquivo = valoresVindosDoArquivo.get(chave) === noProcesso;
    const doSistema = noProcesso !== undefined && !veioDoArquivo;
    saida[chave] = doSistema ? noProcesso : doArquivo.get(chave);
  }
  return saida;
}

const envSchema = z.object({
  DEVORA_API_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  DEVORA_API_PORT: z.coerce.number().default(8787),
  /*
    DEVORA_PUBLIC_BASE_URL SAIU DAQUI (GAP-PRD-153). Estava declarada, validada
    e nos três exemplos, e nada a lia — o QR da plaquinha usa
    GRUPO_SAMPAIO_PUBLIC_URL. Um `.env` antigo que ainda a traga não quebra
    nada (o schema ignora chave desconhecida), e a conferência da implantação
    a aponta como "variável sem efeito".
  */
  DEVORA_FRONTEND_ORIGIN: z.string().default('http://localhost:3000,http://localhost:5173'),
  /**
   * A API SERVE AS TELAS? (GAP-PRD-013)
   *
   * `true`: a API entrega o `out/` do `vite build`, com fallback de SPA — um
   * processo só, e o proxy HTTPS da frente encaminha tudo para ele. É o
   * desenho da imagem Docker e do serviço de referência em `deploy/`.
   *
   * `false` (padrão, o comportamento de antes): outro host serve o frontend
   * (nginx com `try_files`, CDN) e roteia `/api/v1` e `/uploads` para cá.
   *
   * Ligada sem `out/index.html` a API RECUSA subir: servir 404 para todo
   * mundo seria pior do que não subir e dizer o que falta.
   */
  DEVORA_SERVIR_FRONTEND: z.enum(['true', 'false']).default('false'),
  /** Onde está o build do frontend. Vazio = `<raiz>/out`. Relativo = à raiz. */
  DEVORA_FRONTEND_DIR: z.string().optional().default(''),
  // O mesmo padrão de `sqlite.ts` (GAP-PRD-154): o nome antigo `devora-api.json`
  // virava `devora-api.db`, um banco diferente do que o servidor abre sem a variável.
  DEVORA_DATABASE_PATH: z.string().default('./server/data/grupo-sampaio.db'),
  /**
   * ONDE O BACKUP MORA — e precisa ser OUTRO disco.
   *
   * Até a rodada 35 o backup ia para `server/data/backups`: a mesma pasta do
   * banco, no mesmo disco. Disco morre, morrem os dois — não é backup, é
   * cópia. O padrão continua sendo essa pasta para o servidor subir sem
   * configuração, mas o diário avisa no log, toda vez, enquanto o destino for
   * o mesmo disco do banco. A variável é o jeito de apontar para um pen drive,
   * um segundo HD ou uma pasta sincronizada com a nuvem.
   */
  DEVORA_BACKUP_DIR: z.string().optional().default(''),
  /**
   * A HORA DO DIÁRIO, pelo relógio da loja (GAP-PRD-058). Vazio = 3 (03:00).
   * A cópia do banco e o envio das fotos rodam a essa hora; a cópia ao subir
   * só acontece se não houver diário de menos de 20 h.
   */
  DEVORA_BACKUP_HORA: z
    .string()
    .trim()
    .regex(/^(|[01]?\d|2[0-3])$/, 'DEVORA_BACKUP_HORA é uma hora de 0 a 23 (vazio = 3).')
    .optional()
    .default(''),
  // Cópia REMOTA do backup (Supabase Storage). A chave é segredo do dono:
  // mora só aqui — nunca no chat, no banco ou no log.
  DEVORA_SUPABASE_URL: z.string().optional().default(''),
  DEVORA_SUPABASE_SERVICE_KEY: z.string().optional().default(''),
  DEVORA_SUPABASE_BUCKET: z.string().optional().default(''),
  /**
   * ENDEREÇO PÚBLICO DA LOJA — o que o QR da plaquinha carrega.
   *
   * Estava sendo lido por `PrintRenderer.publicBaseUrl()` e não existia em
   * arquivo de ambiente nenhum do repositório. Variável sem declaração é
   * variável que ninguém sabe que precisa preencher: quem instala o sistema lê
   * o `.env.example`, e o que não está lá não é configurado.
   *
   * Não é uma URL qualquer. A plaquinha é impressa uma vez e fica COLADA no
   * equipamento por anos; o QR errado só é descoberto quando um cliente aponta
   * o celular, e aí a etiqueta já está no aparelho. Por isso não sai do host da
   * requisição — o IP da máquina que imprimiu morre na primeira troca de rede.
   *
   * VAZIO É VÁLIDO e é o padrão: `publicBaseUrl()` cai no endereço institucional
   * de reserva, e a tela de etiquetas avisa que não está configurado antes de
   * imprimir. O que NÃO é válido é um valor sem `http://` ou `https://` — o
   * `.replace(/\/+$/, '')` do leitor limparia a barra final e montaria
   * "loja.com.br/equipamento/xxx", que o celular abre como caminho relativo e
   * não vai a lugar nenhum. Esse erro de digitação derruba a subida de
   * propósito: melhor não subir do que imprimir cem plaquinhas mortas.
   */
  GRUPO_SAMPAIO_PUBLIC_URL: z
    .string()
    .optional()
    .default('')
    .refine(
      (valor) => valor.trim() === '' || /^https?:\/\/.+/.test(valor.trim()),
      'GRUPO_SAMPAIO_PUBLIC_URL precisa começar com http:// ou https:// — o QR da '
        + 'plaquinha é montado a partir dela e um endereço sem esquema não abre no celular.',
    ),
  DEVORA_JWT_SECRET: z.string().min(8),
  DEVORA_ENCRYPTION_KEY: z.string().min(16),
  /**
   * A SENHA DO ADMINISTRADOR INICIAL — segredo, opcional, de uma vez só.
   *
   * O bootstrap de produção (`db/bootstrap.ts`, na subida e em `db:bootstrap`)
   * cria a conta `admin` com ela, provisória, quando o banco ainda não tem quem
   * administre o grupo. Com administrador de pé ela não faz nada — nunca altera
   * conta existente —, e a conferência da implantação pede para apagá-la.
   * Nunca vai para log, auditoria nem resposta de API.
   */
  DEVORA_BOOTSTRAP_ADMIN_PASSWORD: z.string().optional().default(''),
  /**
   * A SENHA PROVISÓRIA DOS LOGINS PADRÃO — segredo, opcional, de uma vez só.
   *
   * O bootstrap cria com ela as 14 contas padrão do grupo (`db/loginsPadrao.ts`)
   * que ainda não existirem, cada uma com troca obrigatória no primeiro acesso.
   * Conta que existe nunca é tocada. Sem ela, nenhuma nasce.
   */
  DEVORA_BOOTSTRAP_LOGINS_PASSWORD: z.string().optional().default(''),
  /*
    DEVORA_SESSION_BRIDGE_TOKEN foi REMOVIDA daqui.

    Ela prometia login sem senha mediante um token de ambiente, e o texto do
    OpenAPI descrevia isso como comportamento de produção. Nenhuma rota a
    lia: `POST /auth/login` exige senha sempre, verifica com Argon2id, tem
    bloqueio por tentativa e confere o vínculo com a empresa.

    Uma variável declarada e nunca lida é pior que ausente: alguém a preenche
    achando que fez alguma coisa. Pior ainda com esse nome — quem a lesse
    numa lista de configuração concluiria que existe uma porta lateral.
  */
  /*
    A chave do atalho de desenvolvimento sem senha também saiu daqui, junto
    com a porta que ela ligava. O nome dela e das outras duas que um dia
    ligaram caminho sem senha mora em `config/acessoSemSenhaAposentado.ts`:
    o boot recusa subir em produção com qualquer uma ligada e avisa fora dela.
  */
  /**
   * QUANTOS PROXIES ESTÃO NA FRENTE DESTE SERVIDOR.
   *
   * O limite de taxa e o controle de força bruta do login contam por
   * `req.ip`. Atrás de um proxy reverso — que é como este ERP vai ser
   * publicado —, `req.ip` é o IP DO PROXY: as seis operações, todos os
   * caixas e todo visitante da vitrine dividem o MESMO balde. Um robô na
   * vitrine derruba a venda do balcão com 429.
   *
   * Ligar `trust proxy` resolve isso e abre outro buraco, e por isso o valor
   * é do dono e não um padrão: com ele ligado, o Express passa a acreditar no
   * `X-Forwarded-For` — e um cabeçalho é a coisa mais barata de forjar. Quem
   * mandar um IP diferente a cada tentativa some do controle de força bruta.
   *
   * O número é a quantidade de saltos CONFIÁVEIS: o Express descarta os N
   * últimos endereços da cadeia e confia no anterior. Um proxy só (o caso
   * normal) é 1. Zero é o padrão, e é o certo para quem serve direto.
   */
  DEVORA_TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * E-mail transacional.
   *
   * `false` é o padrão e significa: as mensagens são MONTADAS e ENFILEIRADAS,
   * mas nada sai. Assim o sistema fica pronto para a credencial sem nunca ter
   * mandado e-mail em nome do cliente durante o desenvolvimento — e a fila
   * mostra exatamente o que sairia.
   */
  EMAIL_ENABLED: z.enum(['true', 'false']).default('false'),
  EMAIL_FROM: z.string().optional().default(''),
  EMAIL_SMTP_HOST: z.string().optional().default(''),
  EMAIL_SMTP_PORT: z.coerce.number().default(587),
  EMAIL_SMTP_USER: z.string().optional().default(''),
  EMAIL_SMTP_PASSWORD: z.string().optional().default(''),

  ASAAS_ENABLED: z.enum(['true', 'false']).default('false'),
  ASAAS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  ASAAS_API_KEY: z.string().optional().default(''),
  ASAAS_BASE_URL: z.string().default('https://sandbox.asaas.com/api/v3'),
  ASAAS_WEBHOOK_AUTH_TOKEN: z.string().optional().default(''),
  ASAAS_WEBHOOK_PUBLIC_URL: z.string().optional().default(''),
  ASAAS_TIMEOUT_MS: z.coerce.number().default(30_000),
  ASAAS_MAX_RETRIES: z.coerce.number().default(3),
  // Minutos entre as passadas automáticas que PERGUNTAM ao Asaas pelo status
  // das cobranças em aberto (GAP-PRD-016). 0 desliga a passada automática; o
  // botão da conciliação continua funcionando.
  ASAAS_SYNC_INTERVAL_MINUTES: z.coerce.number().min(0).default(30),
  ASAAS_PRODUCTION_ENABLED: z.enum(['true', 'false']).default('false'),
  ASAAS_PRODUCTION_API_KEY: z.string().optional().default(''),
  ASAAS_PRODUCTION_BASE_URL: z.string().default('https://api.asaas.com/api/v3'),
  NFE_PRODUCTION_ENABLED: z.enum(['true', 'false']).default('false'),
  NFE_HOMOLOGATION_TESTS: z.enum(['true', 'false']).default('false'),
  // NFE_SEFAZ_UF e NFE_SEFAZ_HOMOLOGATION_STATUS_URL saíram (GAP-PRD-075): só o
  // módulo legado de NF-e as lia. A UF da emissão é a do cadastro fiscal da
  // operação, e o endereço da SEFAZ sai da UF — nunca de variável.
  NFCE_PRODUCTION_ENABLED: z.enum(['true', 'false']).default('false'),
  NFCE_HOMOLOGATION_TESTS: z.enum(['true', 'false']).default('false'),
  LOGISTICS_EXTERNAL_ENABLED: z.enum(['true', 'false']).default('false'),
  LOGISTICS_PRODUCTION_ENABLED: z.enum(['true', 'false']).default('false'),
  /*
    LOGISTICS_HOMOLOGATION_TESTS saiu daqui (GAP-PRD-126): era uma variável de
    TESTE decidindo se o checkout chamava a transportadora. Quem decide agora é
    o ambiente da credencial guardada pela tela (sandbox × produção). A suíte
    ainda lê a variável direto de `process.env`, nos casos que exigem token
    real — é o único lugar onde ela significa alguma coisa.
  */
  LOGISTICS_MELHOR_ENVIO_SANDBOX_URL: z.string().default('https://sandbox.melhorenvio.com.br'),
  LOGISTICS_MELHOR_ENVIO_PRODUCTION_URL: z.string().default('https://melhorenvio.com.br'),
  // A agenda que consulta o rastreio dos envios a caminho (GAP-PRD-119), em
  // minutos. 0 desliga a agenda; o botão "Atualizar rastreio" continua.
  LOGISTICS_TRACKING_SYNC_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
  PAYMENT_TERMINAL_ENABLED: z.enum(['true', 'false']).default('true'),
  PAYMENT_TERMINAL_PRODUCTION_ENABLED: z.enum(['true', 'false']).default('false'),
  PAYMENT_TERMINAL_HOMOLOGATION_TESTS: z.enum(['true', 'false']).default('false'),
  ECOMMERCE_ENABLED: z.enum(['true', 'false']).default('true'),
  ECOMMERCE_PRODUCTION_ENABLED: z.enum(['true', 'false']).default('false'),
  ECOMMERCE_HOMOLOGATION_TESTS: z.enum(['true', 'false']).default('false'),
  ECOMMERCE_STOREFRONT_PUBLIC_BASE_URL: z.string().optional().default(''),
  ECOMMERCE_ADMIN_PUBLIC_URL: z.string().optional().default(''),
  ECOMMERCE_STOREFRONT_CNAME_TARGET: z.string().optional().default(''),
  ECOMMERCE_STOREFRONT_A_RECORD: z.string().optional().default(''),
  ECOMMERCE_DNS_TXT_HOST: z.string().default('_devora-verify'),
  ECOMMERCE_DNS_AUTO_VALIDATE: z.enum(['true', 'false']).default('false'),
  ECOMMERCE_STOREFRONT_ORIGINS: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppEnv = z.infer<typeof envSchema> & {
  asaasEnabled: boolean;
  asaasProductionEnabled: boolean;
  nfeProductionEnabled: boolean;
  nfeHomologationTests: boolean;
  nfceProductionEnabled: boolean;
  nfceHomologationTests: boolean;
  logisticsExternalEnabled: boolean;
  logisticsProductionEnabled: boolean;
  paymentTerminalEnabled: boolean;
  paymentTerminalProductionEnabled: boolean;
  paymentTerminalHomologationTests: boolean;
  ecommerceEnabled: boolean;
  ecommerceProductionEnabled: boolean;
  ecommerceHomologationTests: boolean;
  ecommerceStorefrontPublicBaseUrl: string;
  ecommerceAdminPublicUrl: string;
  ecommerceStorefrontCnameTarget: string;
  ecommerceStorefrontARecord: string;
  ecommerceDnsTxtHost: string;
  ecommerceDnsAutoValidate: boolean;
  ecommerceStorefrontOrigins: string;
};

let cached: AppEnv | null = null;

/*
  ============================================================================
  VALORES QUE ESTÃO ESCRITOS NESTE REPOSITÓRIO
  ============================================================================

  Nenhum destes é segredo, e é esse o problema: estão nos arquivos de
  exemplo, com o comprimento que a régua exigia e diferentes da padrão de
  desenvolvimento. Todos passavam.

      .env.example          change-me-in-production          (23 caracteres)
                            change-me-32-chars-minimum-key!! (32 caracteres)
      .env.staging.example  change-me-staging-jwt-secret     (27 caracteres)
                            change-me-staging-32-chars-key!! (32 caracteres)

  O caminho para isso chegar em produção é o mais banal que existe: copiar
  o exemplo, preencher o que se entende, subir. Quem esquecesse essas duas
  linhas ganharia um cofre que qualquer leitor do repositório abre e um
  `DEVORA_JWT_SECRET` com que qualquer um assina o próprio token de
  administrador.

  O "change-me" no valor é recado para gente. O guarda não lê recados.

  `producao-recusa-a-chave-de-desenvolvimento.test.ts` LÊ os arquivos de
  exemplo e cobra que cada valor preenchido ali apareça aqui — a lista não
  envelhece em silêncio.

  OS COMPOSE TAMBÉM PUBLICARAM (GAP-PRD-060). Até o lote D1 os dois
  `docker-compose*.yml` traziam os segredos escritos — e homologação é onde o
  `.pfx` real é carregado. Os arquivos agora pedem os valores ao host; os
  antigos ficam aqui porque o histórico do git não esquece:

      docker-compose.staging.yml  staging-docker-jwt-secret      (25 caracteres)
                                  staging-docker-encryption-key  (29 caracteres)
      docker-compose.yml          dev-docker-jwt-secret          (21 caracteres)
                                  dev-docker-encryption-key-32   (28 caracteres)
*/
const VALORES_PUBLICADOS = new Set([
  'dev-local-jwt-secret',
  'dev-local-encryption-key-32',
  'change-me-in-production',
  'change-me-32-chars-minimum-key!!',
  'change-me-staging-jwt-secret',
  'change-me-staging-32-chars-key!!',
  'staging-docker-jwt-secret',
  'staging-docker-encryption-key',
  'dev-docker-jwt-secret',
  'dev-docker-encryption-key-32',
]);

/**
 * Comprimento não é força.
 *
 * `'a'.repeat(40)` passa em qualquer régua de tamanho e não tem entropia
 * nenhuma. Não é ataque teórico: é o que sai quando alguém precisa subir o
 * servidor agora e resolve arrumar depois. Oito caracteres distintos é um
 * piso baixo de propósito — recusa o preenchimento de teclado sem recusar
 * uma frase-senha escolhida por gente.
 */
/**
 * O valor está escrito neste repositório?
 *
 * Exportado porque a rotação precisa da mesma resposta: rotacionar A PARTIR
 * de um valor publicado deixa uma dívida que resselar não paga — a credencial
 * viveu legível para quem tivesse uma cópia do banco e o repositório.
 */
export function ehValorPublicado(valor: string): boolean {
  return VALORES_PUBLICADOS.has(valor);
}

/**
 * A mesma régua do boot, exportada para a conferência da implantação
 * (`services/implantacao/conferenciaDaImplantacao.ts`) dizer ANTES de subir o
 * que o boot recusaria — pelo nome da variável, nunca pelo valor.
 */
export function chaveFraca(valor: string | undefined, minimo: number): boolean {
  if (!valor) return true;
  if (VALORES_PUBLICADOS.has(valor)) return true;
  if (valor.length < minimo) return true;
  if (new Set(valor).size < 8) return true;
  return false;
}

export function loadEnv(): AppEnv {
  if (cached) return cached;
  loadDotEnvFiles();
  const apiEnv = process.env.DEVORA_API_ENV ?? 'development';
  const jwtSecret = process.env.DEVORA_JWT_SECRET ?? 'dev-local-jwt-secret';
  const encryptionKey = process.env.DEVORA_ENCRYPTION_KEY ?? 'dev-local-encryption-key-32';
  const weakJwt = chaveFraca(process.env.DEVORA_JWT_SECRET, 16);
  const weakEncryption = chaveFraca(process.env.DEVORA_ENCRYPTION_KEY, 24);

  /*
    PRODUÇÃO É PRODUÇÃO PELOS DOIS NOMES — a mesma régua das variáveis
    aposentadas do acesso sem senha, logo abaixo.

    A trava olhava só `DEVORA_API_ENV`, cujo padrão é `development`. Quem
    subisse `NODE_ENV=production node dist/index.js` sem declarar a outra
    variável passava direto — com a chave PADRÃO do cofre.

    E essa chave não é um detalhe de configuração: ela sela o .pfx do
    certificado, as chaves do Asaas e a senha da caixa de e-mail, e está
    ESCRITA neste repositório. Uma cópia do banco somada a um clone abriria
    os cinco. Produção com ela é produção sem cofre nenhum.

    A mensagem nomeia QUAL das duas está fraca: "use chaves fortes" manda
    conferir as duas quando o problema é uma.
  */
  /*
    HOMOLOGAÇÃO SEGUE A MESMA RÉGUA.

    Homologação é o ensaio de produção: é nela que se descobre que "só
    faltava tirar aquilo". A chave do
    cofre ficava de fora, e homologação é exatamente onde o `.pfx` de
    verdade é carregado para transmitir à SEFAZ. Um cofre com chave
    publicada guardando o certificado real não fica menos aberto por o
    ambiente se chamar homologação.
  */
  const pareceProducaoPeloNome =
    apiEnv === 'production'
    || apiEnv === 'staging'
    || process.env.NODE_ENV === 'production';
  if (pareceProducaoPeloNome && (weakJwt || weakEncryption)) {
    const fracas = [
      weakJwt ? 'DEVORA_JWT_SECRET' : null,
      weakEncryption ? 'DEVORA_ENCRYPTION_KEY' : null,
    ].filter(Boolean);
    throw new Error(
      `Produção exige ${fracas.join(' e ')} com valor próprio e longo: `
        + 'ausente ou igual ao padrão local não serve. '
        + 'A chave de cifra sela o certificado e as credenciais: trocá-la depois '
        + 'exige rotacionar o que ela já selou.',
    );
  }

  /*
    O ACESSO SEM SENHA NÃO EXISTE — e a linha antiga no `.env` não passa calada.

    As rotas, o cliente e o painel do atalho sem senha saíram do sistema; a
    porta não existe em ambiente nenhum, e isso não depende de ninguém
    declarar ambiente. O que sobra é a variável esquecida num `.env` antigo.

    Com produção declarada por QUALQUER dos dois nomes (`DEVORA_API_ENV`
    production/staging, ou `NODE_ENV=production` — a variável que hospedagem,
    container e gerenciador de processo definem sozinhos), uma delas ligada
    faz a subida PARAR, dizendo qual linha apagar. Fora de produção a subida
    segue ignorando a variável, com aviso no log. Ver
    `config/acessoSemSenhaAposentado.ts`.

    O caminho contrário continua não valendo: `NODE_ENV=production` não
    transforma `DEVORA_API_ENV` em produção. Aqui ele decide UMA coisa, e para
    o lado seguro.
  */
  const producaoPeloNome =
    apiEnv === 'production' || apiEnv === 'staging'
      ? apiEnv
      : process.env.NODE_ENV === 'production'
        ? 'NODE_ENV=production'
        : null;
  avisarVariaveisAposentadas(travaDoBoot(process.env, producaoPeloNome));

  const withDefaults = {
    DEVORA_JWT_SECRET: jwtSecret,
    DEVORA_ENCRYPTION_KEY: encryptionKey,
    ...process.env,
  };
  const parsed = envSchema.parse(withDefaults);
  cached = {
    ...parsed,
    asaasEnabled: parsed.ASAAS_ENABLED === 'true',
    asaasProductionEnabled: parsed.ASAAS_PRODUCTION_ENABLED === 'true',
    nfeProductionEnabled: parsed.NFE_PRODUCTION_ENABLED === 'true',
    nfeHomologationTests: parsed.NFE_HOMOLOGATION_TESTS === 'true',
    nfceProductionEnabled: parsed.NFCE_PRODUCTION_ENABLED === 'true',
    nfceHomologationTests: parsed.NFCE_HOMOLOGATION_TESTS === 'true',
    logisticsExternalEnabled: parsed.LOGISTICS_EXTERNAL_ENABLED === 'true',
    logisticsProductionEnabled: parsed.LOGISTICS_PRODUCTION_ENABLED === 'true',
    paymentTerminalEnabled: parsed.PAYMENT_TERMINAL_ENABLED === 'true',
    paymentTerminalProductionEnabled: parsed.PAYMENT_TERMINAL_PRODUCTION_ENABLED === 'true',
    paymentTerminalHomologationTests: parsed.PAYMENT_TERMINAL_HOMOLOGATION_TESTS === 'true',
    ecommerceEnabled: parsed.ECOMMERCE_ENABLED === 'true',
    ecommerceProductionEnabled: parsed.ECOMMERCE_PRODUCTION_ENABLED === 'true',
    ecommerceHomologationTests: parsed.ECOMMERCE_HOMOLOGATION_TESTS === 'true',
    ecommerceStorefrontPublicBaseUrl: parsed.ECOMMERCE_STOREFRONT_PUBLIC_BASE_URL,
    ecommerceAdminPublicUrl: parsed.ECOMMERCE_ADMIN_PUBLIC_URL,
    ecommerceStorefrontCnameTarget: parsed.ECOMMERCE_STOREFRONT_CNAME_TARGET,
    ecommerceStorefrontARecord: parsed.ECOMMERCE_STOREFRONT_A_RECORD,
    ecommerceDnsTxtHost: parsed.ECOMMERCE_DNS_TXT_HOST,
    ecommerceDnsAutoValidate: parsed.ECOMMERCE_DNS_AUTO_VALIDATE === 'true',
    ecommerceStorefrontOrigins: parsed.ECOMMERCE_STOREFRONT_ORIGINS,
  };
  return cached;
}

export function resetEnvCacheForTests(): void {
  cached = null;
}
