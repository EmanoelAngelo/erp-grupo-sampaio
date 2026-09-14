/**
 * O ACESSO GRANULAR do lado da tela (escopo reduzido da entrega).
 *
 * Quem entra com um dos perfis de hoje continua com o guarda por ambiente e
 * perfil de sempre (`environments.ts`): nada muda para eles. Quem teve o acesso
 * PERSONALIZADO na tela de Usuários — um modelo que não é perfil de hoje
 * (Somente PDV, PDV + Painel, Estoque…) ou um vínculo com capabilities dadas ou
 * tiradas — passa a ter menu, guarda e casa decididos pelas CAPABILITIES que o
 * servidor devolve em `access`. A tela só reflete: quem autoriza é o servidor.
 */
import { matchPath } from 'react-router-dom';
import type { StoredSession } from '@/lib/api/client';
import { AMBIENTE_POR_PERFIL, homeOf } from '@/router/environments';
import { CAPABILITY_DA_TELA } from './capabilityDaTela.gen';

/** A sessão é decidida por capability (acesso personalizado)? */
export function acessoPersonalizado(sessao: StoredSession | null | undefined): boolean {
  if (!sessao?.access) return false;
  return sessao.access.modelo.personalizado || !(sessao.user.profileCode in AMBIENTE_POR_PERFIL);
}

/**
 * Para onde a pessoa vai ao entrar: a casa que o servidor calculou para o
 * acesso personalizado (a primeira tela liberada, ou `/sem-acesso`); para os
 * perfis de hoje, a casa de sempre.
 */
export function casaDaSessao(sessao: StoredSession): string {
  return acessoPersonalizado(sessao) ? sessao.access!.casa : homeOf(sessao.user.profileCode);
}

/** O conjunto passa na expressão (`cap`, `qualquer(a, b)`, `todas(a, b)`)? Vazio nunca passa. */
export function passaNoTexto(capabilities: ReadonlySet<string> | readonly string[], texto: string): boolean {
  const caps = capabilities instanceof Set ? capabilities : new Set(capabilities);
  const t = texto.trim();
  const composta = /^(qualquer|todas)\((.*)\)$/s.exec(t);
  if (!composta) return caps.has(t);
  const partes = composta[2]!.split(',').map((x) => x.trim()).filter(Boolean);
  if (partes.length === 0) return false;
  return composta[1] === 'qualquer' ? partes.some((p) => caps.has(p)) : partes.every((p) => caps.has(p));
}

// As telas da tabela, da mais específica (mais segmentos, menos parâmetros) para a menos.
const TELAS = Object.keys(CAPABILITY_DA_TELA).sort((a, b) => {
  const segA = a.split('/').length;
  const segB = b.split('/').length;
  if (segA !== segB) return segB - segA;
  return (a.match(/:/g)?.length ?? 0) - (b.match(/:/g)?.length ?? 0);
});

/** A expressão de capability da tela deste caminho, ou `null` se a tela não está na tabela. */
export function expressaoDaTela(caminho: string): string | null {
  const limpo = caminho.split('?')[0]!.replace(/\/+$/, '') || '/';
  for (const tela of TELAS) {
    if (matchPath({ path: tela, end: true }, limpo)) return CAPABILITY_DA_TELA[tela]!;
  }
  return null;
}

/** A tela deste caminho abre para este acesso? Tela fora da tabela: `null` (quem decide é o ambiente). */
export function telaAbre(capabilities: readonly string[], caminho: string): boolean | null {
  const expr = expressaoDaTela(caminho);
  return expr === null ? null : passaNoTexto(capabilities, expr);
}

/** As capabilities de "gestão" (qualquer tela de /sistema) — decide se o shell de gestão abre. */
export function temAlgumaTelaDeGestao(capabilities: readonly string[]): boolean {
  return Object.entries(CAPABILITY_DA_TELA).some(
    ([tela, expr]) => tela.startsWith('/sistema') && passaNoTexto(capabilities, expr),
  );
}
