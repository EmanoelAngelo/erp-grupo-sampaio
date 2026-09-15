/**
 * A EMPRESA DONA DAS PLAQUINHAS — a única do grupo (P0 das plaquinhas).
 *
 * Plaquinha com QR e número existe SÓ na PJ Motors: nem Preço Justo, nem
 * Oficina, nem Gringa, Me Mimei ou Conceito — nem a operação que nascer
 * amanhã pela tela de Empresas.
 *
 * Este módulo não importa NADA de propósito. Quem precisa da constante são a
 * migração (`ensureOfficialTagCompanies`), o pool (`empresaUsaPlaquinha`) e a
 * tela de Empresas — e a migração roda antes de qualquer serviço estar pronto:
 * pendurar a constante num serviço com dependências abriria um ciclo de
 * importação na subida do servidor.
 *
 * É o SLUG, e não o id, pelo mesmo motivo de `ensureOfficialWorkshops`: o id
 * muda a cada banco semeado; o slug atravessa migração, semeadura e
 * restauração. A tela lê a MESMA regra em `src/lib/acesso/plaquinhaDaEmpresa.ts`.
 */
export const EMPRESA_DAS_PLAQUINHAS = 'pj-motors';

/** O slug é o da PJ Motors? Espaço e caixa não fazem outra empresa virar ela. */
export function ehEmpresaDasPlaquinhas(slug: string | null | undefined): boolean {
  return String(slug ?? '').trim().toLowerCase() === EMPRESA_DAS_PLAQUINHAS;
}
