/**
 * AS REGRAS DO CADASTRO DA PESSOA — e-mail, nome e senha — num lugar só.
 *
 * Até o lote E3 da remediação cada porta tinha a sua: o registro aceitava
 * qualquer texto com "@" como e-mail, qualquer coisa de 8 caracteres como
 * senha ('12345678' passava) e não pedia nome; o checkout de visitante não
 * olhava o e-mail. Regras repetidas divergem na primeira correção, e a porta
 * mais frouxa passa a ser a porta.
 *
 * Quem usa: o registro manual e o do convite, a troca de senha, a redefinição
 * pelo link do e-mail (CustomerPortalService / CustomerAccountService) e o
 * checkout de visitante (CheckoutIdentityService). GAP-PRD-191 e GAP-PRD-192.
 */
import { ApiError } from '../../utils/errors.js';

// ------------------------------------------------------------------ e-mail

/**
 * E-mail SINTATICAMENTE válido — não prova caixa (isso é o código de 6
 * dígitos), só descarta o que não pode ser endereço.
 *
 * O "contém @" de antes deixava entrar `ana@`, `@x`, `ana@exemplo` e texto com
 * espaço — contas que nunca receberiam o código de confirmação, nem o PIX.
 *
 * A regra é a parte útil da RFC 5321/5322 que um endereço de pessoa usa:
 * parte local com os caracteres permitidos sem aspas, sem ponto no começo, no
 * fim ou dobrado; domínio com pelo menos um ponto, rótulos de letras, dígitos
 * e hífen (nunca nas pontas) e o último rótulo só de letras. Limites de
 * tamanho: 64 na parte local, 254 no total.
 */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const ROTULO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function emailValido(bruto: unknown): boolean {
  const email = String(bruto ?? '').trim();
  if (email.length === 0 || email.length > 254) return false;
  const arroba = email.lastIndexOf('@');
  if (arroba <= 0 || arroba !== email.indexOf('@')) return false;
  const local = email.slice(0, arroba);
  const dominio = email.slice(arroba + 1);
  if (local.length > 64 || !LOCAL.test(local)) return false;
  const rotulos = dominio.split('.');
  if (rotulos.length < 2) return false;
  if (!rotulos.every((r) => ROTULO.test(r))) return false;
  return /^[A-Za-z]{2,}$/.test(rotulos[rotulos.length - 1]);
}

export function normalizarEmail(bruto: unknown): string {
  return String(bruto ?? '').trim().toLowerCase();
}

/** Recusa com a mesma frase em toda porta. */
export function exigirEmailValido(bruto: unknown): string {
  if (!emailValido(bruto)) {
    throw new ApiError(
      'PORTAL_INVALID_EMAIL',
      'Informe um e-mail válido, no formato nome@provedor.com.br.',
      400,
    );
  }
  return normalizarEmail(bruto);
}

// -------------------------------------------------------------------- nome

/** Nome de pessoa: sem branco, sem controle, até 120 caracteres. */
export const NOME_MAX = 120;

export function nomeDaPessoa(bruto: unknown): string | null {
  const nome = String(bruto ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!nome) return null;
  const temControle = [...nome].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (nome.length > NOME_MAX || temControle) return null;
  return nome;
}

// ------------------------------------------------------------------- senha

export const SENHA_MIN = 8;
/**
 * Teto de tamanho: o Argon2id gasta tempo proporcional à entrada, e uma
 * "senha" de um megabyte por requisição é um jeito barato de ocupar o
 * servidor. 128 cabe em qualquer gerenciador de senhas.
 */
export const SENHA_MAX = 128;

/**
 * As senhas que um atacante testa PRIMEIRO.
 *
 * Não é a lista inteira de vazamentos — é o topo dela (as mais usadas no
 * mundo e no Brasil) com 8 caracteres ou mais, que é o que passaria pelo
 * comprimento mínimo. Comparação sem caixa: 'Senha123' é 'senha123'.
 * Sequências e repetições são pegas por regra, não por lista (ver
 * `ehPadraoTrivial`), então '12345678', '87654321' e 'aaaaaaaa' não precisam
 * estar aqui.
 */
const SENHAS_COMUNS = new Set(
  [
    'password', 'password1', 'password12', 'password123', 'password!', 'passw0rd', 'p@ssw0rd',
    'p@ssword', 'senha123', 'senha1234', 'senha12345', 'senha@123', 'senha@2024', 'senha@2025',
    'senha@2026', 'minhasenha', 'minhasenha1', 'minhasenha123', 'suasenha', 'senhasenha',
    'mudar123', 'mudar@123', 'mudarsenha', 'trocar123', 'alterar123', 'qwerty12', 'qwerty123',
    'qwertyui', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'zxcvbnm123', '1q2w3e4r',
    '1q2w3e4r5t', '1qaz2wsx', 'qazwsxedc', 'abc12345', 'abc123456', 'abcd1234', 'a1b2c3d4',
    'iloveyou', 'iloveyou1', 'sunshine', 'sunshine1', 'princess', 'princesa', 'football',
    'baseball', 'superman', 'batman123', 'starwars', 'welcome1', 'welcome123', 'letmein1',
    'trustno1', 'whatever', 'master123', 'dragon123', 'monkey123', 'shadow123', 'michael1',
    'jennifer', 'computer', 'internet', 'corinthians', 'flamengo', 'palmeiras', 'saopaulo',
    'vasco123', 'gremio123', 'santos123', 'cruzeiro', 'botafogo', 'fluminense', 'brasil123',
    'brasil2024', 'brasil2025', 'brasil2026', 'amor1234', 'amorzinho', 'teamo123', 'teamo1234',
    'meuamor1', 'jesus123', 'jesuscristo', 'deusefiel', 'deus1234', 'gabriel1', 'gabriel123',
    'mateus123', 'lucas123', 'rafael123', 'felipe123', 'bruno123', 'daniel123', 'marcos123',
    'maria123', 'mariana1', 'juliana1', 'fernanda', 'camila123', 'amanda123', 'beatriz1',
    'admin123', 'admin1234', 'administrador', 'root1234', 'usuario1', 'usuario123', 'cliente1',
    'cliente123', 'loja1234', 'loja12345', 'compras1', 'grupo123', 'sampaio1', 'sampaio123',
    'gruposampaio', 'devora123', 'teste123', 'teste1234', 'teste@123', 'testando', 'default1',
    'changeme', 'changeme1', 'secret123', 'segredo1', 'segredo123', 'natal123', 'verao123',
    'janeiro1', 'dezembro', 'pokemon1', 'minecraft', 'naruto123', 'google123', 'facebook',
    'instagram', 'whatsapp', 'samsung1', 'iphone12', 'motorola', 'elefante', 'chocolate',
    'morango1', 'flores123', 'familia1', 'familia123', 'felicidade', 'liberdade', 'saudade1',
  ].map((s) => s.toLowerCase()),
);

/** 'aaaaaaaa', '11111111', '12345678', 'abcdefgh', '98765432' e as voltas. */
function ehPadraoTrivial(senha: string): boolean {
  const s = senha.toLowerCase();
  if (new Set(s).size <= 2) return true;
  let sobe = true;
  let desce = true;
  for (let i = 1; i < s.length; i += 1) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1) sobe = false;
    if (d !== -1) desce = false;
  }
  return sobe || desce;
}

/**
 * Por que a senha é recusada — ou `null` se serve.
 *
 * Comprimento (8 a 128), fora da lista das mais usadas, sem padrão trivial e
 * sem o próprio e-mail dentro. NÃO exige maiúscula/símbolo: regra de
 * composição empurra para 'Senha@123', que é das primeiras que se testa
 * (NIST SP 800-63B, 5.1.1.2).
 */
export function motivoDeSenhaFraca(
  senha: unknown,
  contexto: { email?: string | null } = {},
): string | null {
  const s = String(senha ?? '');
  if (s.length < SENHA_MIN) return `A senha precisa de pelo menos ${SENHA_MIN} caracteres.`;
  if (s.length > SENHA_MAX) return `A senha pode ter no máximo ${SENHA_MAX} caracteres.`;
  const minuscula = s.toLowerCase();
  if (SENHAS_COMUNS.has(minuscula) || ehPadraoTrivial(s)) {
    return 'Essa senha está entre as mais usadas e é das primeiras que um invasor tenta. Escolha outra — uma frase curta que só você conheça funciona bem.';
  }
  /*
    O E-MAIL COMO SENHA: 'joao.silva@…' com 'JoaoSilva2026' ou 'joaosilva!'.
    Compara só as LETRAS — a senha que é o e-mail com número ou símbolo em
    volta. Uma senha que apenas CONTÉM um pedaço do e-mail no meio de outras
    palavras não é o mesmo risco, e recusá-la irritaria sem proteger.
  */
  const letras = (t: string) => t.toLowerCase().replace(/[^a-z]/g, '');
  const local = letras(normalizarEmail(contexto.email ?? '').split('@')[0] ?? '');
  if (local.length >= 4 && letras(s) === local) {
    return 'A senha não pode ser o seu e-mail.';
  }
  return null;
}

export function exigirSenhaForte(senha: unknown, contexto: { email?: string | null } = {}): void {
  const motivo = motivoDeSenhaFraca(senha, contexto);
  if (motivo) throw new ApiError('PORTAL_WEAK_PASSWORD', motivo, 400);
}
