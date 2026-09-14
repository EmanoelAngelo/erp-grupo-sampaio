/**
 * ============================================================================
 * AS VARIÁVEIS APOSENTADAS DO ACESSO SEM SENHA — o único lugar que as nomeia
 * ============================================================================
 *
 * O sistema já teve dois caminhos que emitiam sessão sem senha, e os dois
 * saíram por inteiro:
 *
 *   - o acesso por card, ligado por `GRUPO_SAMPAIO_QUICK_LOGIN` e desligado em
 *     produção POR PADRÃO — padrão não é garantia;
 *   - o atalho de desenvolvimento, ligado por `DEVORA_DEV_QUICK_LOGIN` no
 *     servidor e `VITE_DEV_QUICK_LOGIN` no build da tela. Listava os usuários
 *     ativos de todas as empresas e emitia sessão só com o id, pulando a troca
 *     obrigatória de senha. A trava dele valia só com o ambiente DECLARADO — e
 *     `DEVORA_API_ENV` é `development` por padrão. A loja estava nesse buraco.
 *
 * Não há rota, cliente nem tela que as leia para ligar coisa alguma: a porta
 * não existe. O que sobra é o `.env` antigo, que ainda pode trazer a linha.
 * Por isso elas continuam nomeadas AQUI, e só aqui (a varredura
 * `acesso-sem-senha-nao-volta.test.ts` cobra isso):
 *
 *   - o boot (`loadEnv`) RECUSA SUBIR com qualquer uma LIGADA num processo de
 *     produção — `DEVORA_API_ENV` production/staging ou `NODE_ENV=production`.
 *     Ela não abre nada, mas ligada num ambiente de produção prova que ninguém
 *     revisou aquele arquivo, e a mensagem diz qual linha apagar;
 *   - fora de produção, sobe IGNORANDO e avisa no log que a variável é
 *     aposentada e não tem efeito — o dono que a ligou para "entrar rápido"
 *     precisa saber que ela não faz mais nada;
 *   - a conferência da implantação mostra "Variável aposentada presente"
 *     (BLOQUEIA ligada, ATENÇÃO escrita com outro valor);
 *   - o `secret:scan` recusa arquivo rastreado que as escreva ligadas.
 */
import { logWarn } from '../utils/errors.js';

export const VARIAVEIS_DO_ACESSO_SEM_SENHA = [
  'DEVORA_DEV_QUICK_LOGIN',
  'VITE_DEV_QUICK_LOGIN',
  'GRUPO_SAMPAIO_QUICK_LOGIN',
] as const;

export type VariavelDoAcessoSemSenha = (typeof VARIAVEIS_DO_ACESSO_SEM_SENHA)[number];

/** O que cada uma ligava — para a lista das variáveis sem efeito e para o aviso. */
export const O_QUE_LIGAVA: Record<VariavelDoAcessoSemSenha, string> = {
  DEVORA_DEV_QUICK_LOGIN: 'ligava o atalho de desenvolvimento que entrava sem senha; o atalho foi removido',
  VITE_DEV_QUICK_LOGIN: 'fazia a tela de login oferecer o atalho sem senha; a tela não tem mais o atalho',
  GRUPO_SAMPAIO_QUICK_LOGIN: 'ligava o acesso por card sem senha; removido',
};

/**
 * "Ligada" não depende da grafia: quem escreveu `TRUE`, `1` ou `sim` quis ligar,
 * e é essa intenção que a trava recusa em produção.
 */
const VALORES_LIGADOS = new Set(['true', '1', 'yes', 'sim', 'on']);

export function valorLigado(valor: string | undefined): boolean {
  return VALORES_LIGADOS.has(primeiraPalavra(valor));
}

/*
  O COMENTÁRIO NA MESMA LINHA NÃO DESLIGA A TRAVA.

  O leitor do `.env` desta casa (`lerArquivoDotEnv`, em `env.ts`) não corta o
  comentário depois do valor: `CHAVE=true   # para entrar rapido` chega ao
  processo como `true   # para entrar rapido`. Quem escreveu isso quis ligar
  (e o `secret:scan` já acha essa linha no repositório). O valor que conta é o
  que vem antes do primeiro espaço ou `#`, sem as aspas em volta.
*/
function primeiraPalavra(valor: string | undefined): string {
  const [palavra = ''] = (valor ?? '').trim().split(/[\s#]/, 1);
  return palavra.replace(/^['"]|['"]$/g, '').toLowerCase();
}

export interface VariavelAposentadaNoAmbiente {
  nome: VariavelDoAcessoSemSenha;
  ligada: boolean;
}

/** As que estão no ambiente com algum valor (vazio conta como ausente). */
export function variaveisAposentadasNoAmbiente(
  env: Record<string, string | undefined>,
): VariavelAposentadaNoAmbiente[] {
  return VARIAVEIS_DO_ACESSO_SEM_SENHA
    .filter((nome) => (env[nome] ?? '').trim() !== '')
    .map((nome) => ({ nome, ligada: valorLigado(env[nome]) }));
}

/**
 * A trava do boot. `producao` é o nome pelo qual o processo é de produção
 * (`production`, `staging`, `NODE_ENV=production`) ou `null`.
 *
 * Produção com alguma LIGADA: lança — a subida para. Fora disso devolve as
 * presentes, para o boot avisar.
 */
export function travaDoBoot(
  env: Record<string, string | undefined>,
  producao: string | null,
): VariavelAposentadaNoAmbiente[] {
  const presentes = variaveisAposentadasNoAmbiente(env);
  const ligadas = presentes.filter((v) => v.ligada).map((v) => v.nome);
  if (producao && ligadas.length > 0) {
    const plural = ligadas.length > 1;
    throw new Error(
      `${ligadas.join(' e ')} ${plural ? 'estão ligadas' : 'está ligada'} em ${producao}. `
        + 'O acesso sem senha foi removido do sistema e nada mais lê essa variável — mas ligada num '
        + 'processo de produção ela mostra um .env que ninguém revisou, e a API não sobe assim. '
        + `Apague ${plural ? 'as linhas' : 'a linha'} ${ligadas.join(', ')} do .env (ou do ambiente do serviço) `
        + 'e suba de novo.',
    );
  }
  return presentes;
}

/** O aviso de fora de produção (e de produção com a linha escrita desligada). */
export function avisarVariaveisAposentadas(presentes: VariavelAposentadaNoAmbiente[]): void {
  if (presentes.length === 0) return;
  const nomes = presentes.map((v) => v.nome).join(', ');
  logWarn(`VARIAVEL_APOSENTADA_SEM_EFEITO: ${nomes}`, {
    ligada: presentes.filter((v) => v.ligada).map((v) => v.nome).join(', ') || 'nenhuma',
    efeito:
      'nenhum: o acesso sem senha foi removido e a porta não existe. Em produção e homologação a API '
      + 'recusa subir com ela ligada. Apague a linha do .env.',
  });
}
