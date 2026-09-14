/**
 * Varredura de segredos — `npm run secret:scan`.
 *
 * Varre O QUE O GIT RASTREIA, não o filesystem. A diferença importa: o `.env`
 * real desta máquina TEM segredos — é a casa deles, e está no .gitignore. O
 * antecessor deste comando varria o disco inteiro e reprovaria toda máquina
 * corretamente configurada; a pergunta certa é "o que pode VAZAR pelo
 * repositório?", e a resposta é a lista do `git ls-files` (que já inclui o
 * que está em stage).
 *
 * Exclusões conscientes:
 *   - testes (server/tests, __tests__): fixtures carregam tokens de mentira;
 *   - *.example: declaram a CHAVE de propósito, com placeholder no lugar do
 *     valor — o boot recusa produção com qualquer valor publicado aqui (a
 *     regra do acesso sem senha, abaixo, lê os exemplos mesmo assim);
 *   - este próprio arquivo, que precisa escrever os padrões que procura.
 *
 * Sai com código 1 ao primeiro conjunto de achados — feito para o CI e para a
 * varredura antes de todo commit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIAVEIS_DO_ACESSO_SEM_SENHA } from '../config/acessoSemSenhaAposentado.js';
import { ehPontoDeEntrada } from '../utils/pontoDeEntrada.js';

const RAIZ = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

interface Padrao {
  nome: string;
  re: RegExp;
  /** Só vale para caminhos que casam aqui. */
  so?: RegExp;
  /** Vale também para os `*.example` (que as outras regras pulam). */
  lerExemplos?: boolean;
  /** Não vale para caminhos que casam aqui. */
  exceto?: RegExp;
  /** Quais arquivos a regra abre, no lugar de `EXTENSOES`. */
  arquivos?: RegExp;
}

/*
  OS ARQUIVOS QUE LEVAM CONFIGURAÇÃO ATÉ A LOJA.

  `EXTENSOES` (abaixo) é a lista dos segredos: código, JSON, Markdown, YAML,
  exemplo e o `Dockerfile` exato. Para a regra do acesso sem senha ela é curta
  demais — ficavam de fora justamente os arquivos que sobem o serviço: a unit
  do systemd, o instalador do Windows, script de shell e de cmd, variante de
  Dockerfile, e o `.env.production`/`.env.staging`, que o `.gitignore` não
  ignora e é o nome natural de quem copia o `.env.production.example`.
*/
const ARQUIVOS_DE_CONFIGURACAO =
  /\.(ts|tsx|js|mjs|cjs|json|env|md|example|ya?ml|service|ps1|psm1|sh|bash|bat|cmd|conf|ini|toml|txt|html)$|(^|\/)(Dockerfile[^/]*|\.env[^/]*|Caddyfile[^/]*)$/;

const PADROES: Padrao[] = [
  { nome: 'Asaas API key', re: /\$aact_[A-Za-z0-9_]+/ },
  { nome: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { nome: 'chave privada PEM', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { nome: 'JWT/segredo longo', re: /eyJ[A-Za-z0-9_-]{60,}/ },
  /*
    `[REDACTED...]` NÃO É VALOR. O relatório de auditoria cita a linha do
    compose com o segredo já trocado pelo marcador — é exatamente o jeito
    certo de documentar um vazamento, e contá-lo como vazamento deixava esta
    varredura vermelha para sempre no CI.
  */
  { nome: 'DEVORA_JWT_SECRET com valor', re: /DEVORA_JWT_SECRET\s*=\s*(?!\[REDACTED)[^\s#]+/ },
  { nome: 'DEVORA_ENCRYPTION_KEY com valor', re: /DEVORA_ENCRYPTION_KEY\s*=\s*(?!\[REDACTED)[^\s#]+/ },
  // A senha do administrador inicial é de uma vez só e mora no .env da máquina.
  { nome: 'DEVORA_BOOTSTRAP_ADMIN_PASSWORD com valor', re: /DEVORA_BOOTSTRAP_ADMIN_PASSWORD\s*=\s*(?!\[REDACTED)[^\s#]+/ },
  // A dos logins padrão também: de uma vez só, no .env da máquina, nunca no repositório.
  { nome: 'DEVORA_BOOTSTRAP_LOGINS_PASSWORD com valor', re: /DEVORA_BOOTSTRAP_LOGINS_PASSWORD\s*=\s*(?!\[REDACTED)[^\s#]+/ },
  /*
    O COMPOSE ESCREVE `CHAVE: valor`, NÃO `CHAVE=valor` (GAP-PRD-060).

    Os dois `docker-compose*.yml` traziam o segredo de homologação e o de
    desenvolvimento escritos — e esta varredura nem abria `.yml`. A forma certa
    no compose é `${VAR:?mensagem}`, que pede o valor ao host; qualquer outra
    coisa depois dos dois-pontos é valor publicado. A regra vale só para YAML:
    em TypeScript `DEVORA_JWT_SECRET: z.string()` é a declaração do schema.
  */
  {
    nome: 'segredo com valor no compose',
    re: /^[ \t]*-?[ \t]*DEVORA_(JWT_SECRET|ENCRYPTION_KEY|BOOTSTRAP_ADMIN_PASSWORD)[ \t]*[:=][ \t]*['"]?(?!\$\{)[^\s#'"]+/m,
    so: /\.ya?ml$/,
  },
  /*
    O ACESSO SEM SENHA LIGADO NUM ARQUIVO DO REPOSITÓRIO.

    O acesso sem senha saiu do sistema e as variáveis que o ligavam ficaram
    aposentadas (`config/acessoSemSenhaAposentado.ts`): em produção a API
    recusa subir com qualquer uma ligada. Um exemplo de `.env`, um compose ou
    um Dockerfile que as escreva ligadas é o caminho para alguém copiar a
    linha para a loja — por isso esta regra lê também os `*.example`, que é
    de onde se copia. Fica de fora o registro histórico da auditoria
    (`docs/audits/`), que cita a linha ligada para contar o que achou.

    Qualquer grafia de "ligada" conta (`true`, `TRUE`, `1`, `sim`...), e as
    duas formas: `CHAVE=valor` (`.env`, Dockerfile, shell) e `CHAVE: valor`
    (compose, objeto de script).
  */
  {
    nome: 'acesso sem senha ligado (variável aposentada)',
    re: new RegExp(
      `\\b(?:${VARIAVEIS_DO_ACESSO_SEM_SENHA.join('|')})\\b['"]?[ \\t]*[:= \\t][ \\t]*['"]?(?:true|1|yes|sim|on)\\b`,
      'i',
    ),
    lerExemplos: true,
    exceto: /^docs\/audits\//,
    arquivos: ARQUIVOS_DE_CONFIGURACAO,
  },
];

const EXTENSOES = /\.(ts|tsx|js|mjs|cjs|json|env|md|example|ya?ml)$|(^|\/)Dockerfile$/;

function ehTeste(caminho: string): boolean {
  return caminho.startsWith('server/tests/') || caminho.includes('__tests__');
}

function ehExemplo(caminho: string): boolean {
  return caminho.endsWith('.example') || caminho.includes('.env.example');
}

function foraDeTodas(caminho: string): boolean {
  return ehTeste(caminho) || caminho.endsWith('varredura-de-segredos.ts') || caminho.endsWith('package-lock.json');
}

/** A regra vale para este caminho? */
function valePara(padrao: Padrao, caminho: string): boolean {
  if (!(padrao.arquivos ?? EXTENSOES).test(caminho) || foraDeTodas(caminho)) return false;
  if (ehExemplo(caminho) && !padrao.lerExemplos) return false;
  if (padrao.so && !padrao.so.test(caminho)) return false;
  if (padrao.exceto && padrao.exceto.test(caminho)) return false;
  return true;
}

/** Os nomes das regras que o arquivo viola — vazio quando está limpo. */
export function achadosNoArquivo(caminho: string, texto: string): string[] {
  const rel = caminho.split('\\').join('/');
  return PADROES.filter((p) => valePara(p, rel) && p.re.test(texto)).map((p) => p.nome);
}

/** Varre o que o git rastreia em `raiz`: quantos arquivos conferiu e o que achou. */
export function varrerRastreados(raiz: string = RAIZ): { conferidos: number; achados: string[] } {
  const rastreados = execFileSync('git', ['ls-files', '-z'], { cwd: raiz, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.length > 0 && PADROES.some((p) => valePara(p, f)));

  const achados: string[] = [];
  for (const arquivo of rastreados) {
    let texto: string;
    try {
      texto = readFileSync(resolve(raiz, arquivo), 'utf8');
    } catch {
      continue;
    }
    const [primeiro] = achadosNoArquivo(arquivo, texto);
    if (primeiro) achados.push(`${primeiro}: ${arquivo}`);
  }
  return { conferidos: rastreados.length, achados };
}

function main(): number {
  const { conferidos, achados } = varrerRastreados();
  for (const achado of achados) console.warn(`POSSÍVEL SEGREDO (${achado.replace(/: ([^:]+)$/, '): $1')}`);
  if (achados.length > 0) {
    console.error(`Varredura de segredos: ${achados.length} arquivo(s) suspeito(s). NÃO commite antes de limpar.`);
    return 1;
  }
  console.log(`Varredura de segredos: limpa (${conferidos} arquivos rastreados conferidos).`);
  return 0;
}

if (ehPontoDeEntrada(import.meta.url)) process.exit(main());
